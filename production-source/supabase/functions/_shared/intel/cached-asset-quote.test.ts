import {assertEquals as eq} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {readCachedAssetQuote} from './cached-asset-quote.ts'
const now=Date.parse('2026-09-11T12:00:00Z'),iso=(n:number)=>new Date(n).toISOString(),subject='market:coinmarketcap:42019'
const observation=(patch:any={})=>({id:'original',subject,metric:'price',value:0.003,unit:'USD',provider:'coinmarketcap',sourceRef:'coinmarketcap:/v3/cryptocurrency/quotes/latest:{"id":"42019"}',observedAt:iso(now-2000),recordedAt:iso(now-1000),expiresAt:iso(now+30000),aiAllowed:true,...patch})
function db(values:any[]){const calls:any[]=[];return {calls,from:(table:string)=>{calls.push(['from',table]);const q:any={};for(const method of ['select','eq','like','or','gte','lte','gt','order'])q[method]=(...args:any[])=>{calls.push([method,...args]);return q};q.limit=(n:number)=>{calls.push(['limit',n]);return Promise.resolve({data:values.map(observation=>({observation}))})};return q}}}
Deno.test('off-catalogue assets use bounded retained quotes with exact identity and original clocks',async()=>{
 const database=db([observation(),observation({id:'cap',metric:'market_cap',value:0}),observation({id:'change',metric:'price_change',unit:'%',periodSeconds:86400,value:-5})])
 const r=await readCachedAssetQuote(database,{canonicalKey:subject,symbol:'SAME'},now)
 eq(r.fields.price.value,0.003);eq(r.fields.market_cap.value,0);eq(r.fields.change_86400.value,-5)
 eq(r.freshness.recorded_at,iso(now-1000));eq(r.freshness.stale_after,iso(now+30000))
 eq(database.calls.includes(['provider']),false);eq(database.calls.find(c=>c[0]==='limit'),['limit',96]);eq(database.calls.find(c=>c[0]==='eq'&&c[1]==='subject'),['eq','subject',subject])
})
Deno.test('future, expired, denied, wrong-asset, wrong-unit and stream rows cannot enter an AI evidence pack',async()=>{
 for(const patch of [{subject:'market:coinmarketcap:1'},{recordedAt:iso(now+1)},{observedAt:iso(now+1)},{expiresAt:iso(now)},{aiAllowed:false},{unit:'BTC'},{sourceRef:'coinmarketcap:market@crypto_latest_price'}]){
  const r=await readCachedAssetQuote(db([observation(patch)]),{canonicalKey:subject},now);eq(r.observations.length,0)
 }
})
Deno.test('unsupported contract identity does not query by ticker or borrow a native quote',async()=>{
 for(const canonicalKey of ['eip155:8453:0x'+'a'.repeat(40),'eip155:8453/erc20:0x'+'a'.repeat(40),'eip155:999999/erc20:0x'+'a'.repeat(40),'solana:mainnet/spl:So11111111111111111111111111111111111111112']) {
 for(const hint of [{},{sourceProvider:'coingecko',providerId:'ethereum'},{sourceProvider:'coinmarketcap',providerId:'1027'}]){
  const database=db([observation()]);const r=await readCachedAssetQuote(database,{canonicalKey,symbol:'ETH',...hint},now)
  eq(database.calls.length,0);eq(r.observations.length,0)
 }
 }
})
Deno.test('a permitted listings quote fills an expired focused quote without extending either expiry',async()=>{
 const listing=observation({id:'listing',sourceRef:'coinmarketcap:/v3/cryptocurrency/listings/latest:{"limit":"250"}',observedAt:iso(now-60000),expiresAt:iso(now+120000),value:0})
 const r=await readCachedAssetQuote(db([observation({expiresAt:iso(now-1)}),listing]),{canonicalKey:subject},now)
 eq(r.fields.price.id,'listing');eq(r.fields.price.value,0);eq(r.freshness.as_of,listing.observedAt);eq(r.freshness.stale_after,listing.expiresAt)
 eq((await readCachedAssetQuote(db([listing]),{canonicalKey:subject},now+120000)).observations.length,0)
})
