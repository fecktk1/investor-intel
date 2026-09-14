import {readAssetSpecialistEvidence} from './asset-specialist-evidence.ts'
import {contractEvidencePreview} from './cmc-contract-projection.ts'
import {rwaPortfolioExposure} from './rwa-portfolio-exposure.ts'
import {portfolioBenchmarkExposure} from './portfolio-benchmark-exposure.ts'
import {readPortfolioNarrativeExposure} from './portfolio-narrative-exposure.ts'
/** Called only after portfolio ownership/access checks and an explicit research
 * action. Public reads contain asset identities, never portfolio IDs or notes. */
export async function portfolioMarketEvidence(db:any,holdings:any[],now:number,totalValue:number|null=null){
 const selected=[...new Map(holdings.filter(h=>typeof h.canonicalAssetKey==='string').map(h=>[h.canonicalAssetKey,h])).values()].slice(0,10)
 const rows:any[]=[]
 // Keep DB concurrency independent of portfolio size; no upstream transport.
 for(let start=0;start<selected.length;start+=2)rows.push(...await Promise.all(selected.slice(start,start+2).map(async h=>{
  const s=await readAssetSpecialistEvidence(db,{canonicalKey:h.canonicalAssetKey},now)
  const derivativeRows=contractEvidencePreview(s.derivatives.observations,4)
  return {canonicalAssetKey:h.canonicalAssetKey,symbol:h.symbol,name:h.name,connected_identity:s.identity,
   rwa_state:s.rwa,security_state:s.security,benchmark_state:s.benchmark,representation_state:s.representation,
   derivatives_state:{...s.derivatives,observations:derivativeRows,projection_omitted:s.derivatives.observations.length-derivativeRows.length},
   holder_state:s.holders,cmc_contract_state:{...s.contractEvidence,observations:contractEvidencePreview(s.contractEvidence.observations.filter(o=>o.metric!=='price')),projection_note:'Bounded whole-record projection; current portfolio valuation uses the existing accounting records.'}}
 })))
 const narrativeExposure=await readPortfolioNarrativeExposure(db,holdings,rows,totalValue,now)
 return {rows,narrativeExposure,rwaExposure:rwaPortfolioExposure(holdings,rows,totalValue,now),benchmarkExposure:(['100','20'] as const).map(i=>portfolioBenchmarkExposure(holdings,rows,totalValue,i)),coverage:{included:rows.length,omitted:Math.max(0,holdings.length-selected.length),method:'Up to ten largest included open positions, exact identities, retained evidence only. Original source clocks and citation references remain attached.'}}
}
