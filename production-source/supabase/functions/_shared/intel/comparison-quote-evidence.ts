import { requestCmc, loadCmcOperatingSettings } from '../market-assets/cmc-transport.ts'
import { cmcParams, CMC_CAPABILITIES } from '../market-assets/cmc-capabilities.ts'
import { cmcPolicyEnvironment } from '../market-assets/cmc-operating-settings.ts'
import { normalizeCmcInvestigation } from './investigation-normalize.ts'
import { researchIdentity } from './research-identity.ts'
import type { AssetEvidenceSubject } from './asset-evidence-pack.ts'
const nativeIds:Record<string,string>={bitcoin:'1',ethereum:'1027',solana:'5426',binancecoin:'1839',avalanche:'5805'}
export function comparisonQuoteIds(subjects:AssetEvidenceSubject[]) {
  return [...new Set(subjects.slice(0,4).flatMap(input=>{
    const identity=researchIdentity(input)
    if(identity.tokenAddress)return []
    const id=identity.sourceProvider==='coinmarketcap'?identity.providerId:identity.sourceProvider==='coingecko'?nativeIds[identity.providerId||'']:null
    return id&&/^[1-9][0-9]{0,11}$/.test(id)?[id]:[]
  }))]
}
// Read the governed shared quote cache and register demand before generating.
// Stable per-asset requests reuse catalog/hot groups without basket-specific caches.
export async function prepareComparisonQuoteEvidence(db:any,subjects:AssetEvidenceSubject[],actor:{orgId:string;userId:string},dependencies={request:requestCmc,settings:loadCmcOperatingSettings}) {
  const ids=comparisonQuoteIds(subjects)
  if(!ids.length)return []
  const settings=await dependencies.settings(db),env=cmcPolicyEnvironment(settings,key=>Deno.env.get(key))
  const states:any[]=[]
  for(let offset=0;offset<ids.length;offset+=2){
    const batch=ids.slice(offset,offset+2),results=await Promise.allSettled(batch.map(async id=>{
      const params={id},response=await dependencies.request('quotes',params,{supabase:db,kind:'request',maxCalls:1,waitForFresh:true,caller:'intel-generate-comparison',...actor})
      const fetched=response.provenance.fetchedAt,expiry=response.provenance.expiresAt
      if(response.payload&&fetched&&expiry){
        const normalized=await normalizeCmcInvestigation('quotes',response.payload,cmcParams('quotes',params),fetched,expiry,new Date(Date.parse(fetched)+CMC_CAPABILITIES.quotes.stale*1000).toISOString(),env)
        const rows=normalized.rows.filter(row=>Date.parse(row.retainUntil)>Date.now())
        if(rows.length){const {error}=await db.rpc('intel_record_market_observations',{p_rows:rows});if(error)throw Error('comparison_quote_evidence_unavailable')}
      }
      return {id,state:response.state,reason:response.reason}
    }))
    states.push(...results.map((result,index)=>result.status==='fulfilled'?result.value:{id:batch[index],state:'unavailable',reason:'comparison_quote_evidence_unavailable'}))
  }
  return states
}
