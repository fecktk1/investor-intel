import {assertEquals as eq} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {rwaPortfolioExposure} from './rwa-portfolio-exposure.ts'
const now=Date.parse('2026-09-12T04:00:00Z'),key='eip155:1:0x'+'a'.repeat(40),market='market:coinmarketcap:4705'
const holding={canonicalAssetKey:key,name:'PAX Gold',quantity:2,value:0,priceStatus:'fresh',observedAt:new Date(now-1000).toISOString()}
const version={id:'original-rwa',subject:market,family:'rwa_relationship',fetchedAt:new Date(now-2000).toISOString(),recordedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+1000).toISOString(),document:{cryptoId:'4705',rwaId:'1',issuerId:'pax',issuerName:'Paxos',underlyingName:'Gold'}}
const evidence={canonicalAssetKey:key,connected_identity:{marketSubject:market},rwa_state:{status:'available',versions:[version]}}
Deno.test('RWA exposure uses the selected book value, zero, clocks and original relationship version',()=>{
 const r=rwaPortfolioExposure([holding],[evidence],100,now);eq(r.rows.length,1);eq(r.rows[0].valueUsd,0);eq(r.rows[0].portfolioAllocationPct,0);eq(r.rows[0].quantity,2);eq(r.rows[0].relationshipVersion,version);eq(r.groups[0].pricedSubtotalUsd,0);eq(r.rows[0].positionObservedAt,holding.observedAt)
})
Deno.test('unpriced, failed, unmapped, future, ambiguous and wrong-identity joins remain distinct',()=>{
 const r=rwaPortfolioExposure([{...holding,value:null}],[evidence],null,now);eq(r.rows[0].valueUsd,null);eq(r.rows[0].portfolioAllocationPct,null);eq(r.groups[0].unpriced,1)
 const failure=rwaPortfolioExposure([holding],[{...evidence,rwa_state:{status:'error'}}],100,now);eq(failure.status,'partial');eq(failure.failed,[key]);eq(failure.rows.length,0)
 const wrong=rwaPortfolioExposure([holding],[{...evidence,connected_identity:{marketSubject:'market:coinmarketcap:1'}}],100,now);eq(wrong.rows.length,0);eq(wrong.unmapped,[key])
 const future=rwaPortfolioExposure([holding],[{...evidence,rwa_state:{versions:[{...version,recordedAt:new Date(now+1000).toISOString()}]}}],100,now);eq(future.rows.length,0)
 const conflict=rwaPortfolioExposure([holding],[{...evidence,rwa_state:{versions:[version,{...version,document:{...version.document,issuerId:'other'}}]}}],100,now);eq(conflict.ambiguous,[key]);eq(conflict.rows.length,0)
})
Deno.test('stale relationships are labelled, total zero has no allocation denominator and distinct tokens never sum quantities',()=>{
 const r=rwaPortfolioExposure([holding,{...holding,canonicalAssetKey:'other',quantity:100,value:20}],[{...evidence,rwa_state:{versions:[{...version,expiresAt:new Date(now-1).toISOString()}]}},{...evidence,canonicalAssetKey:'other'}],0,now)
 eq(r.rows[0].relationshipStatus,'stale');eq(r.rows[0].portfolioAllocationPct,null);eq(r.groups[0].positions,2);eq(r.groups[0].pricedSubtotalUsd,20);eq('quantity' in r.groups[0],false)
})
Deno.test('issuer retirement annotations preserve authorized balances and valuation instead of clearing the position',()=>{
 const key='eip155:137:0xa7e22972a19dd924afeedf3db28033b146801081',at=Date.parse('2026-09-12T06:00:00Z')
 const original={...holding,canonicalAssetKey:key,quantity:5,value:0},sources={...evidence,canonicalAssetKey:key}
 const r=rwaPortfolioExposure([original],[sources],100,at)
 eq(r.rows[0].quantity,5);eq(r.rows[0].valueUsd,0);eq(r.rows[0].representationReview.network,'Polygon');eq(r.rows[0].relationshipVersion,version)
 eq(original.value,0);eq(original.quantity,5)
})
