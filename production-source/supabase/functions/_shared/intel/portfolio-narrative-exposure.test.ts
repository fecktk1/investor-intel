import {assertEquals as eq,assert} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {portfolioNarrativeTargets,projectPortfolioNarrativeExposure,readPortfolioNarrativeExposure} from './portfolio-narrative-exposure.ts'
const now=Date.parse('2026-09-12T13:00:00Z'),at='2026-09-12T12:00:00Z'
const holding=(extra:any={})=>({canonicalAssetKey:'market:coinmarketcap:1',symbol:'BTC',value:50,quantity:1,priceStatus:'priced',observedAt:at,...extra})
const member=(extra:any={})=>({id:'m1',narrative_id:'n1',asset_provider:'coinmarketcap',asset_provider_id:'1',membership_source:'recorded CMC membership',updated_at:at,...extra})
const tax=(extra:any={})=>({id:'n1',slug:'payments',name:'Payments',parent_category:'Finance',status:'active',updated_at:at,...extra})
const project=(holdings:any[],members:any[]=[],taxonomy:any[]=[],evidence:any[]=[],total:number|null=100)=>projectPortfolioNarrativeExposure(portfolioNarrativeTargets(holdings,evidence),members,taxonomy,total,now)

Deno.test('overlapping narratives do not double-count sectors or unique portfolio coverage',()=>{
 const h=[holding()],m=[member(),member({id:'m2',narrative_id:'n2'}),member()],t=[tax(),tax({id:'n2',slug:'store-of-value',name:'Store of value'})]
 const result=project(h,m,t)
 eq(result.narratives.length,2);eq(result.narratives.map(g=>g.portfolioAllocationPct),[50,50]);eq(result.sectors[0].pricedSubtotalUsd,50);eq(result.uniquePricedSubtotalUsd,50)
 eq(result.positions[0].memberships.length,2);eq(result.positions[0].memberships[0].effectiveAt,null)
 assert(result.method.includes('must not be added'));eq(result.positions[0].memberships[0].membershipRecordedAt,at)
})
Deno.test('zero, unpriced and stale positions keep separate value and allocation semantics',()=>{
 let result=project([holding({value:0,quantity:0})],[member()],[tax()])
 eq(result.sectors[0].valueUsd,0);eq(result.sectors[0].portfolioAllocationPct,0)
 result=project([holding({value:null,priceStatus:'unpriced'})],[member()],[tax()],[],null)
 eq(result.sectors[0].valueUsd,null);eq(result.sectors[0].portfolioAllocationPct,null);eq(result.sectors[0].unpriced,1)
 result=project([holding({priceStatus:'stale'})],[member()],[tax()])
 eq(result.sectors[0].stalePositions,1);eq(result.positions[0].positionObservedAt,at)
 eq(project([holding({value:0})],[member()],[tax()],[],0).sectors[0].portfolioAllocationPct,null)
})
Deno.test('ticker and unverified or foreign identity links cannot classify a holding',()=>{
 const h=holding({canonicalAssetKey:'eip155:1:0x'+'2'.repeat(40),symbol:'BTC'})
 eq(project([h],[member()],[tax()]).positionsClassified,0)
 for(const identity of [{state:'ambiguous',requested:h.canonicalAssetKey,marketSubject:'market:coinmarketcap:1'},{state:'verified',requested:'wrong',marketSubject:'market:coinmarketcap:1'}])eq(project([h],[member()],[tax()],[{canonicalAssetKey:h.canonicalAssetKey,connected_identity:identity}]).positionsClassified,0)
 const result=project([h],[member()],[tax()],[{canonicalAssetKey:h.canonicalAssetKey,connected_identity:{state:'verified',requested:h.canonicalAssetKey,marketSubject:'market:coinmarketcap:1'}}])
 eq(result.positionsClassified,1);eq(result.positions[0].canonicalAssetKey,h.canonicalAssetKey)
})
Deno.test('future, undated and inactive memberships are unclassified, never reconstructed',()=>{
 for(const m of [member({updated_at:null}),member({updated_at:'2027-01-01T00:00:00Z'})])eq(project([holding()],[m],[tax()]).positionsClassified,0)
 for(const t of [tax({status:'retired'}),tax({updated_at:null}),tax({updated_at:'2027-01-01T00:00:00Z'})])eq(project([holding()],[member()],[t]).positionsClassified,0)
})

Deno.test('reviewed issuer and native aliases reach original provider membership without ticker joins or double counting',()=>{
 const usdc='eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
 const cg=member({asset_provider:'coingecko',asset_provider_id:'usd-coin'})
 const result=project([holding({canonicalAssetKey:usdc,value:75})],[cg,member({id:'cmc-copy',asset_provider_id:'3408'})],[tax()])
 eq(result.positionsClassified,1);eq(result.uniquePricedSubtotalUsd,75);eq(result.positions[0].memberships.length,2)
 eq(result.positions[0].memberships[0].provider,'coingecko');eq(result.positions[0].canonicalAssetKey,usdc)
 eq(project([holding({canonicalAssetKey:'eip155:8453:0x'+'1'.repeat(40),symbol:'USDC'})],[cg],[tax()]).positionsClassified,0)
 eq(project([holding({canonicalAssetKey:'eip155:8453:native'})],[member({asset_provider:'coingecko',asset_provider_id:'ethereum'})],[tax()]).positionsClassified,1)
})

function dbFor(options:any={}) {
 const calls:any[]=[]
 const db={from(table:string){const call:any={table};calls.push(call);const q:any={select(v:any){call.select=v;return q},eq(k:any,v:any){call[k]=v;return q},in(k:any,v:any){call[k]=v;return q},lte(k:any,v:any){call[k]=v;return q},order(){return q},limit(n:number){call.limit=n;return Promise.resolve(options.fail===table?{data:null,error:{message:'private database failure'}}:{data:table==='narrative_assets'?(options.members||[member()]).filter((m:any)=>m.asset_provider===call.asset_provider&&call.asset_provider_id.includes(m.asset_provider_id)):[tax()],error:null})}};return q}}
 return {db,calls}
}
Deno.test('membership queries are bounded by provider and id, never private holdings fields',async()=>{
 const {db,calls}=dbFor(),result=await readPortfolioNarrativeExposure(db,[holding({notes:'private words',portfolioId:'private portfolio'})],[],100,now)
 eq(result.status,'available');eq(calls.length,3);eq(calls[0].asset_provider,'coinmarketcap');eq(calls[0].asset_provider_id,['1']);eq(calls[0].limit,501)
 assert(!JSON.stringify(calls).includes('private'));assert(!JSON.stringify(result).includes('private'))
})
Deno.test('failed and oversized reads stay errors and duplicate position books are rejected',async()=>{
 for(const fail of ['narrative_assets','narrative_taxonomy']){const {db}=dbFor({fail});const result=await readPortfolioNarrativeExposure(db,[holding()],[],100,now);eq(result.status,'error');eq(result.uniquePricedSubtotalUsd,null);assert(!JSON.stringify(result).includes('private database failure'))}
 const {db}=dbFor({members:Array.from({length:501},(_,i)=>member({id:String(i)}))})
 eq((await readPortfolioNarrativeExposure(db,[holding()],[],100,now)).status,'error')
 eq((await readPortfolioNarrativeExposure(db,[holding(),holding()],[],100,now)).reason,'portfolio_narrative_position_limit')
 eq((await readPortfolioNarrativeExposure(db,[holding({canonicalAssetKey:'unknown'})],[],100,now)).status,'partial')
})
