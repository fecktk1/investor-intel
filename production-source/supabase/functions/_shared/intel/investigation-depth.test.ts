import {assertEquals as eq,assertRejects,assert} from 'jsr:@std/assert'
import {normalizeInvestigationDepth,readInvestigationDepth} from './investigation-depth.ts'
import {makeResearchReceipt,verifyReceipt} from './investigation-evidence.ts'
import {thesisStress} from './investigation-calculations.ts'
import {investigationRange} from './investigation-service.ts'
const now=Date.parse('2026-09-11T12:00:00Z'),iso=(n:number)=>new Date(n).toISOString(),subject='market:coinmarketcap:1'
const asset={source_provider:'coinmarketcap',provider_id:'1',normalized_symbol:'BTC'},ticker={provider:'coinbase',provider_symbol:'BTC-USD',quote_asset:'USD'}
const book={...ticker,as_of:iso(now-1000),updated_at:iso(now-500),bid_price:100,ask_price:101,bid_qty:0,ask_qty:2}
const normalize=(books=[book],tickers=[ticker],a=asset,verified=true)=>normalizeInvestigationDepth(a,verified,books,tickers,now)
Deno.test('depth stress uses the exact venue and side, preserving a zero and immutable bounded references',async()=>{
 const data=await normalize(),sell=data.observations.find(o=>o.metadata?.side==='sell')!
 assert(/^depth:[a-f0-9]{64}$/.test(sell.id));eq(sell.value,0);eq(sell.subject,subject);eq(sell.recordedAt,book.updated_at)
 eq(data.rows.map(o=>o.retainUntil),[iso(now+59000),iso(now+59000)])
 const rule={id:'r',metric:'depth_notional',comparator:'lte',threshold:0,unit:'USD',time_window:'current',source_metric:'depth:coinbase:BTC-USD:sell'}
 eq(thesisStress([rule],data.observations,subject,{},now)[0].currentlyMet,true)
 eq(thesisStress([{...rule,source_metric:'depth:coinbase:BTC-USD:buy'}],data.observations,subject,{},now)[0].currentlyMet,false)
 eq(thesisStress([rule],data.observations,'market:coinmarketcap:1027',{},now)[0].current,null)
 eq(thesisStress([rule],data.observations,subject,{},now+60000)[0].current,null)
 const receipt=await makeResearchReceipt({subject,lens:'stress',question:'Original words',cursor:now,observations:data.observations},now)
 eq(receipt.observations,[]);eq(receipt.observationRefs.length,2);eq((await verifyReceipt(receipt)).replay,'references_only')
 eq(investigationRange({cursor:{time:book.as_of,id:sell.id}},now).cursor?.id,sell.id)
 eq(await normalize(),data);assert((await normalize([{...book,bid_qty:1}])).observations.find(o=>o.metadata?.side==='sell')?.id!==sell.id)
})
Deno.test('depth cannot invent knowledge, freshness, USD coverage, identity or full book levels',async()=>{
 for(const patch of [{updated_at:''},{updated_at:iso(now+1)},{as_of:iso(now-60000)},{as_of:iso(now+1)},{bid_qty:null,ask_qty:null},{ask_price:99}])eq((await normalize([{...book,...patch}] as any)).observations,[])
 eq((await normalize([book],[{...ticker,quote_asset:'USDT'}])).observations,[])
 eq((await normalize([book],[ticker],asset,false)).observations,[])
 eq((await normalize(Array(20).fill(book))).observations.length,16)
})
function database(fail:string|null=null,selectedAsset=asset){const calls:any[]=[];return {calls,from(table:string){calls.push({table,filters:[],limit:null});const c=calls.at(-1),q:any={select:()=>q,eq:(...args:any[])=>{c.filters.push(args);return q},order:()=>q,limit:(n:number)=>{c.limit=n;return q},maybeSingle:()=>q,then:(resolve:any)=>resolve({error:fail===table?{message:'private error'}:null,data:table==='market_assets'?selectedAsset:table==='exchange_asset_mappings'?null:table==='exchange_latest_orderbook'?[book]:[ticker]})};return q}}}
Deno.test('cache-only depth reads have verified identity and hard row limits',async()=>{
 const db=database();eq((await readInvestigationDepth(db,'1',now)).observations.length,2)
 eq(db.calls.length,4);eq(db.calls.slice(2).map(c=>c.limit),[8,8]);eq(db.calls[0].filters,[['source_provider','coinmarketcap'],['provider_id','1']])
 const wrong=database(null,{...asset,provider_id:'999'});eq((await readInvestigationDepth(wrong,'999',now)).observations,[]);eq(wrong.calls.length,2)
 await assertRejects(()=>readInvestigationDepth(db,'BTC',now),Error,'invalid_depth_identity')
})
Deno.test('any failed depth read is a failure, not an empty successful result',async()=>{
 for(const table of ['market_assets','exchange_asset_mappings','exchange_latest_orderbook','exchange_latest_tickers'])await assertRejects(()=>readInvestigationDepth(database(table),'1',now),Error,'investigation_depth_unavailable')
})
