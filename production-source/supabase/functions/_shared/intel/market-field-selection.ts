import {selectedFieldEvidence} from './evidence-freshness.ts'
type Candidate=[unknown,unknown,string]
/** Callers first resolve the exact asset. Freshness ranks before source order;
 * asset aggregates precede single-venue fallbacks within the same clock state. */
export function selectMarketField(candidates:Candidate[],now:number,unit:string){
 const rows=candidates.filter(([v])=>v!=null).map(([value,row,table],index)=>{
  const evidence=selectedFieldEvidence(value,row,table,now,unit)
  const rank=evidence.status==='fresh'?0:evidence.status==='stale'?1:2
  const aggregate=['intel_market_observations','market_assets','exchange_latest_market_caps'].includes(table)
  return {evidence:{...evidence,scope:aggregate?'asset_aggregate':table==='dex_pair_snapshots'?'contract_pair':table==='exchange_latest_tickers'?'single_venue':'recorded_price'},rank,sourceRank:aggregate?0:1,index}
 })
 rows.sort((a,b)=>a.rank-b.rank||a.sourceRank-b.sourceRank||a.index-b.index)
 return rows[0]?.evidence??{...selectedFieldEvidence(null,null,'',now,unit),scope:'unavailable'}
}
