import {digest,stableJson} from './investigation-evidence.ts'
/** Match JSONB's stored values, independent of database object-key order. */
export function assetEvidenceFingerprint(artifactType:string,packs:unknown[]) {
 return digest(stableJson(JSON.parse(JSON.stringify({artifactType,packs}))))
}
const number=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)
/** Multiple quote fields from one provider do not constitute independent evidence. */
export function comparisonHasStrongEvidence(entries:any[]) {
 return entries.length>=2 && entries.every(entry=>{
  const p=entry.pack||{},m=p.market_summary||{},l=p.liquidity_state||{}
  if(!number(m.current_price)||m.freshness?.status!=='fresh')return false
  const cex=p.cex_state?.freshness?.status==='fresh'&&[l.cex_bid_depth_usd,l.cex_ask_depth_usd].some(v=>number(v)&&v>0)
  const dex=p.dex_state?.freshness?.status==='fresh'&&number(l.dex_liquidity_usd)&&l.dex_liquidity_usd>0
  return cex||dex
 })
}
/** Missing slices have a negative cache too; honor its bounded expiry. */
export function evidencePackNeedsRefresh(result:any,now=Date.now()) {
 return result?.cached===true && !(Number.isFinite(Date.parse(result.staleAfter))&&Date.parse(result.staleAfter)>now)
}
