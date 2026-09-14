import {finite} from './investigation-evidence.ts'
/** Exposure scenario, NOT historical portfolio performance: today's recorded
 * position weights applied to an exactly aligned past market-price interval.
 * Actual time-weighted returns require complete flows and dated holdings. */
export function portfolioBenchmarkExposure(holdings:any[],evidence:any[],totalValue:number|null,index:'100'|'20'){
 const included:any[]=[],excluded:any[]=[]
 for(const h of holdings){
  const state=evidence.find(e=>e.canonicalAssetKey===h.canonicalAssetKey)?.benchmark_state,comparison=state?.comparisons?.find((c:any)=>c.index===index),value=finite(h.value)
  const rows=comparison?.rows?.filter((r:any)=>r.asset&&r.benchmark&&finite(r.asset.value)!=null&&finite(r.benchmark.value)!=null)||[]
  if(value==null||value<0||rows.length<2){excluded.push({canonicalAssetKey:h.canonicalAssetKey,reason:state?.status==='error'?'source_read_failed':value==null?'unpriced_position':'insufficient_matching_history'});continue}
  included.push({holding:h,value,rows})
 }
 const common=included.length?included[0].rows.map((r:any)=>r.t).filter((t:number)=>included.every(p=>p.rows.some((r:any)=>r.t===t))).sort((a:number,b:number)=>a-b):[]
 const from=common[0]??null,to=common.at(-1)??null,rows:any[]=[]
 if(common.length>=2)for(const p of included){
  const before=p.rows.find((r:any)=>r.t===from),after=p.rows.find((r:any)=>r.t===to)
  if(Number(before.asset.value)<=0||Number(before.benchmark.value)<=0){excluded.push({canonicalAssetKey:p.holding.canonicalAssetKey,reason:'zero_baseline'});continue}
  const movePercent=(Number(after.asset.value)/Number(before.asset.value)-1)*100,indexMovePercent=(Number(after.benchmark.value)/Number(before.benchmark.value)-1)*100
  if(!Number.isFinite(movePercent)||!Number.isFinite(indexMovePercent)||!Number.isFinite(p.value*movePercent/100)){excluded.push({canonicalAssetKey:p.holding.canonicalAssetKey,reason:'invalid_numeric_range'});continue}
  rows.push({canonicalAssetKey:p.holding.canonicalAssetKey,name:p.holding.name||p.holding.symbol,positionValueUsd:p.value,positionPriceStatus:p.holding.priceStatus,positionObservedAt:p.holding.observedAt??null,
   weightPercent:totalValue!=null&&totalValue>0?p.value/totalValue*100:null,movePercent,indexMovePercent,hypotheticalMoveUsd:p.value*movePercent/100,
   observations:[before.asset,after.asset,before.benchmark,after.benchmark]})
 }
 const pricedSubtotal=rows.reduce((n,r)=>n+r.positionValueUsd,0)
 return {method:'current-exposure-aligned-history-1',index,label:`CMC ${index}`,status:common.length<2||!rows.length?'insufficient_matching_times':excluded.length?'partial':'available',from,to,rows,excluded,
  coveredValueUsd:pricedSubtotal,coveredPortfolioPercent:totalValue!=null&&totalValue>0?pricedSubtotal/totalValue*100:null,
  hypotheticalMoveUsd:rows.length?rows.reduce((n,r)=>n+r.hypotheticalMoveUsd,0):null,
  note:'Scenario using recorded current position values and one identical past price interval for every included asset. It is not past portfolio performance or P&L: transfers, changing holdings, fees and trading are not modeled. Omitted/unpriced positions are not zero. Figures cover only the included research positions.'}
}
