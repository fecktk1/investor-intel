import {representationReview} from './representation-review.ts'
import { researchCmcId, type AssetEvidenceSubject } from './research-identity.ts'
import { readParticipation, participationRecord, participationContract } from './participation-read.ts'
import { currentFragility } from './fragility-history.ts'
import { instant, type Observation } from './investigation-evidence.ts'
import { canonicalAssetKey } from '../investor-portfolio/canonical.ts'
import {readCmcContractEvidence} from './cmc-contract-evidence.ts'
import {readConnectedAssetIdentity} from './connected-asset-identity.ts'
import {readAdoptionAttention} from './adoption-attention.ts'
import {readMarketSourceVersions,securityVersionChanges} from './market-source-versions.ts'
import {cmcDexIdentity} from '../market-assets/cmc-dex.ts'
import {readAssetBenchmarkEvidence} from './asset-benchmark-evidence.ts'

const METRICS = ['open_interest', 'liquidations_1h', 'liquidations_4h', 'liquidations_24h']
// These are bounded reads of the SAME recorded facts used by the investigations.
// No provider transport, demand activation, wallet sync or symbol joins here.
export async function readAssetSpecialistEvidence(db: any, input: AssetEvidenceSubject, now: number,verified?:{linked:any;identityError:boolean}) {
  let linked:any=verified?.linked||null,identityError=verified?.identityError||false
  if(!verified)try {linked=await readConnectedAssetIdentity(db,input.canonicalKey||'',input.chain&&input.tokenAddress?canonicalAssetKey(input.chain,input.tokenAddress):null)}catch {identityError=true}
  const cmc = linked?.cmcId||researchCmcId(input), subject = cmc ? `market:coinmarketcap:${cmc}` : null
  const holderSubject = participationContract(input.canonicalKey || '') ? input.canonicalKey!
    : linked?.contractSubject||null
  const contract = participationContract(holderSubject || '')
  const [derivatives, holders, contractEvidence, rwa, security, benchmark] = await Promise.all([
    (async () => {
      const base = { subject, evaluated_at:new Date(now).toISOString(), observations: [] as Observation[], fragility: null as any, has_more: false,
        coverage: 'Only recorded covered contracts and liquidation windows. Funding units and intervals remain provider-qualified; no whole-market total is implied.' }
      if (!subject) return { ...base, status: identityError?'error':'unsupported', reason: identityError?'The verified CMC identity could not be read.':'No verified CMC identity for this asset.' }
      try {
        const { data, error } = await db.from('intel_market_observations').select('observation')
          .eq('subject', subject).in('metric', METRICS)
          .gte('observed_at', new Date(now - 7 * 86400000).toISOString()).lte('observed_at', new Date(now).toISOString())
          .gt('retain_until', new Date(now).toISOString()).order('observed_at', { ascending: false }).order('id', { ascending: false }).limit(201)
        if (error || !Array.isArray(data)) throw new Error('specialist_read_failed')
        const permitted = data.slice(0, 200).map((r: any) => r.observation as Observation).filter((o: Observation) =>
          o?.subject === subject && METRICS.includes(o.metric) && o.aiAllowed === true &&
          instant(o.observedAt) != null && instant(o.observedAt)! <= now && instant(o.recordedAt) != null && instant(o.recordedAt)! <= now)
        return { ...base, status: permitted.length ? 'available' : 'missing', observations: permitted,
          fragility: currentFragility(permitted, subject, now), has_more: data.length > 200,
          reason: permitted.length ? null : 'No retained derivatives observations permitted for research in this window.' }
      } catch { return { ...base, status: 'error', reason: 'Retained derivatives evidence could not be read.' } }
    })(),
    (async () => {
      const base = { records: [] as any[], note: 'Holder records describe a reported account population or sample, not beneficial owners. Computation time is separate from original observation time.' }
      if (!contract) return { ...base, status: 'unsupported', reason: 'Holder distribution requires an exact supported token contract.' }
      try {
        const rows = await readParticipation(db, holderSubject!, now)
        const records = rows.slice(0, 5).map((row: any) => {
          const record = participationRecord(row, holderSubject!)
          return { ...record, computed_at: record.observedAt, observedAt: null }
        })
        return { ...base, records, status: records.length ? 'available' : 'missing', reason: records.length ? null : 'No retained exact-contract holder record.' }
      } catch { return { ...base, status: 'error', reason: 'Exact-contract holder evidence could not be read.' } }
    })(),
    readCmcContractEvidence(db,holderSubject||'',now),
    subject?readMarketSourceVersions(db,subject,'rwa_relationship',now,'research',5):Promise.resolve(null),
    cmcDexIdentity(holderSubject)?.subject?readMarketSourceVersions(db,cmcDexIdentity(holderSubject)!.subject,'security',now,'research',10):Promise.resolve(null),
    readAssetBenchmarkEvidence(db,subject,now),
  ])
  const attentionComparison=contractEvidence.status==='restricted'||!contractEvidence.subject?null:await readAdoptionAttention(db,contractEvidence.observations,contractEvidence.subject,subject,now)
  return { derivatives, holders, rwa, benchmark, representation:representationReview(input.canonicalKey,now)||representationReview(holderSubject,now), security:security?{...security,comparison:securityVersionChanges(security.versions)}:null,contractEvidence:{...contractEvidence,attention_comparison:attentionComparison},identity:linked,identityError }
}
