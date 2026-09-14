import {assertEquals} from 'jsr:@std/assert'
import {assetEvidenceFingerprint,comparisonHasStrongEvidence,evidencePackNeedsRefresh} from './comparison-evidence-quality.ts'
import {criticalSlicesForAssetEvidencePack} from './asset-evidence-pack.ts'
Deno.test('evidence fingerprint survives JSONB key order, retaining values, scope and source clocks',async()=>{
 const fresh=[{subject:{symbol:'BTC',canonical_key:'native:bitcoin',optional:undefined},pack:{market_summary:{current_price:0,volume_24h:10,freshness:{as_of:'2026-09-11T14:00:00Z',status:'fresh'}}}}]
 const jsonb=[{pack:{market_summary:{freshness:{status:'fresh',as_of:'2026-09-11T14:00:00Z'},volume_24h:10,current_price:0}},subject:{canonical_key:'native:bitcoin',symbol:'BTC'}}]
 const hash=await assetEvidenceFingerprint('token_comparison',fresh)
 assertEquals(hash,await assetEvidenceFingerprint('token_comparison',jsonb))
 for(const modify of [(p:any)=>p[0].pack.market_summary.current_price=null,(p:any)=>p[0].subject.canonical_key='other',(p:any)=>p[0].pack.market_summary.freshness.as_of='2026-09-11T14:01:00Z']){
  const changed=structuredClone(jsonb);modify(changed);assertEquals(hash===await assetEvidenceFingerprint('token_comparison',changed),false)
 }
})
Deno.test('quote-only or stale baskets do not launch a redundant multi-model debate',()=>{
 const quote={pack:{market_summary:{current_price:0,freshness:{status:'fresh'}}}}
 assertEquals(comparisonHasStrongEvidence([quote,quote]),false)
 const depth={pack:{...quote.pack,cex_state:{freshness:{status:'fresh'}},liquidity_state:{cex_bid_depth_usd:100}}}
 assertEquals(comparisonHasStrongEvidence([depth,depth]),true)
 assertEquals(comparisonHasStrongEvidence([depth,quote]),false)
 assertEquals(comparisonHasStrongEvidence([depth,{pack:{...depth.pack,cex_state:{freshness:{status:'stale'}}}}]),false)
})
Deno.test('missing evidence remains cached until its stated expiry instead of rebuilding each request',()=>{
 const now=Date.parse('2026-09-11T14:00:00Z')
 assertEquals(evidencePackNeedsRefresh({cached:true,staleAfter:'2026-09-11T14:01:00Z'},now),false)
 assertEquals(evidencePackNeedsRefresh({cached:true,staleAfter:'2026-09-11T14:00:00Z'},now),true)
 assertEquals(evidencePackNeedsRefresh({cached:true,staleAfter:'invalid'},now),true)
 assertEquals(evidencePackNeedsRefresh({cached:false},now),false)
})
Deno.test('valid zero prices, caps and spread values are observed data, not missing slices',()=>{
 assertEquals(criticalSlicesForAssetEvidencePack({pack:{market_summary:{current_price:0,market_cap:0,volume_24h:0},liquidity_state:{cex_min_spread_pct:0},data_coverage:{material_gaps:[]}}} as any),[])
})
