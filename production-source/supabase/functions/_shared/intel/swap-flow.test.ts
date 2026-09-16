import {assertEquals as eq,assert} from 'jsr:@std/assert'
import {captureSwapFlow,foldSwapPage,swapDirection,SWAP_FLOW_CAPTURE_TABLE,SWAP_FLOW_MAX_PAGES,SWAP_FLOW_TABLE} from './swap-flow.ts'
import {cmcDexIdentity} from '../market-assets/cmc-dex.ts'

const ADDRESS='0x'+'ab'.repeat(20)
const QUOTE='0x'+'cd'.repeat(20)
const IDENTITY=cmcDexIdentity(`eip155:8453:${ADDRESS}`)!
const maker=(n:number)=>'0x'+n.toString(16).padStart(40,'0')
const SECOND=1_700_000_000

/** One swap row exactly as /v1/dex/tokens/transactions sends it. `ma` is the
 * maker; the base leg is this contract unless the case says otherwise. */
const swap=(patch:Record<string,unknown>={})=>({tx:'0x'+Math.random().toString(16).slice(2),lgid:1,v:100,tp:'buy',en:'Aerodrome',
 t0a:ADDRESS,t1a:QUOTE,a0:5,a1:1,t0pu:20,t1pu:100,ma:maker(1),ts:SECOND,...patch})

const body=(swaps:Record<string,unknown>[],lastId:string|null=null)=>({data:{swaps,...(lastId?{lastId}:{})}})

// deno-lint-ignore no-explicit-any
function fakeDb(tables:Record<string,any[]>={}) {
 return {
  tables,
  from(table:string){
   // deno-lint-ignore no-explicit-any
   const filters:[string,any][]=[]
   // deno-lint-ignore no-explicit-any
   const q:any={
    select:()=>q,
    // deno-lint-ignore no-explicit-any
    eq:(k:string,v:any)=>{filters.push([k,v]);return q},
    limit:()=>Promise.resolve({data:(tables[table]||[]).filter((row:any)=>filters.every(([k,v])=>String(row?.[k]??'')===String(v??''))),error:null}),
    // deno-lint-ignore no-explicit-any
    upsert:(rows:any[])=>{tables[table]=[...(tables[table]||[]),...rows];return Promise.resolve({data:rows,error:null})},
   }
   return q
  },
 }
}

const ctxFor=(_name:string,maxCalls:number)=>({maxCalls} as any)

/** A transport that answers a scripted list of pages, newest first. */
function fakeRequest(pages:any[]) {
 const calls:Record<string,string>[]=[]
 let index=0
 // deno-lint-ignore no-explicit-any
 const request=((_name:string,params:Record<string,string>)=>{
  calls.push(params)
  const page=pages[index++]
  return Promise.resolve(page===null?{payload:null,reason:'provider_unavailable'}:{payload:page,state:'fresh',reason:null,
   provenance:{fetchedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString()}})
 // deno-lint-ignore no-explicit-any
 }) as any
 return {request,calls}
}

Deno.test('the direction the provider states for this contract leg is preferred over its buy/sell word',()=>{
 // PROBED LIVE 2026-09-16: every row of /v1/dex/tokens/transactions carries
 // `t0pt`/`t1pt`, a direction per leg, observed as "reduce" and "add". The real
 // probed row was tp="sell" with the queried token as the base leg, t0pt="reduce"
 // and t1pt="add": the maker gave up the queried token.
 eq(swapDirection('sell',true,false,'reduce','add'),'disposed')
 // The SUBJECT's own leg decides. Read as the quote leg of that same row, the
 // subject is the one being added to.
 eq(swapDirection('sell',false,true,'reduce','add'),'acquired')
 eq(swapDirection('buy',true,false,'add','reduce'),'acquired')
 eq(swapDirection('buy',false,true,'add','reduce'),'disposed')
 // The stated word OVERRIDES `tp`, so a disagreement is settled by what the
 // provider said about that leg rather than by our reading of its trade word.
 eq(swapDirection('buy',true,false,'reduce','add'),'disposed')
 // Casing and padding are the provider's, not a different classification.
 eq(swapDirection('sell',true,false,' REDUCE ','add'),'disposed')
 // The leg vocabulary is undocumented, so a word we have never seen is NOT read
 // as a direction: it drops to the fallback instead of inventing a side.
 eq(swapDirection('sell',true,false,'rebalance','add'),'disposed','fallback reads tp against the base leg')
 eq(swapDirection('buy',false,true,'add','migrate'),'disposed','fallback inverts for the quote leg')
})

Deno.test('with no stated leg direction the buy/sell fallback reads tp against this contract leg',()=>{
 // FALLBACK ONLY, and an inference: `tp` classifies against the BASE leg, which
 // CoinMarketCap does not publish, so it is labelled as inference everywhere.
 eq(swapDirection('buy',true,false),'acquired')
 eq(swapDirection('sell',true,false),'disposed')
 // This contract is the QUOTE leg: buying the base means paying with, and so
 // giving up, the token being asked about, so the meaning inverts.
 eq(swapDirection('buy',false,true),'disposed')
 eq(swapDirection('sell',false,true),'acquired')
 // Anything neither rule can place takes NO side rather than being forced onto one.
 eq(swapDirection('liquidate',true,false),'unclassified')
 eq(swapDirection('',true,false),'unclassified')
 eq(swapDirection(null,true,false),'unclassified')
 eq(swapDirection('buy',false,false,'add','reduce'),'unclassified','a swap naming neither leg is not a direction')
 // Casing and padding are the provider's, not a different classification.
 eq(swapDirection(' BUY ',true,false),'acquired')
})

Deno.test('one page folds into per-account totals and a swap with no maker joins no cohort',()=>{
 const wallets=new Map()
 const totals={swapsSeen:0,swapsWithMaker:0,duplicates:0,oldestEventAt:null,newestEventAt:null}
 const rows=[
  {value:100,observed:SECOND,metadata:{maker:maker(1),eventType:'buy',baseAddress:ADDRESS,quoteAddress:QUOTE,baseQuantity:5,quoteQuantity:1}},
  {value:40,observed:SECOND+60,metadata:{maker:maker(1),eventType:'sell',baseAddress:ADDRESS,quoteAddress:QUOTE,baseQuantity:2,quoteQuantity:1,excluded:true}},
  // Attributed to nobody: counted in the sweep, member of no account.
  {value:999,observed:SECOND+120,metadata:{maker:null,eventType:'buy',baseAddress:ADDRESS,quoteAddress:QUOTE,baseQuantity:9,quoteQuantity:1}},
 ]
 foldSwapPage(rows as any,IDENTITY,wallets,totals as any)
 eq(totals.swapsSeen,3)
 eq(totals.swapsWithMaker,2,'the unattributed swap is seen but belongs to no account')
 eq(wallets.size,1,'no "unknown account" bucket is invented for it')
 const w=wallets.get(maker(1))!
 eq([w.acquiredCount,w.acquiredUsd,w.acquiredQty],[1,100,5])
 eq([w.disposedCount,w.disposedUsd,w.disposedQty],[1,40,2])
 eq([w.swaps,w.excludedCount],[2,1])
 eq(w.firstEventAt,new Date(SECOND*1000).toISOString())
 eq(w.lastEventAt,new Date((SECOND+60)*1000).toISOString())
 eq(totals.oldestEventAt,new Date(SECOND*1000).toISOString())
 eq(totals.newestEventAt,new Date((SECOND+120)*1000).toISOString())
})

Deno.test('a money figure the provider did not report stays unknown while a zero stays a zero',()=>{
 const wallets=new Map()
 const totals={swapsSeen:0,swapsWithMaker:0,duplicates:0,oldestEventAt:null,newestEventAt:null}
 foldSwapPage([
  {value:null,observed:SECOND,metadata:{maker:maker(2),eventType:'buy',baseAddress:ADDRESS,quoteAddress:QUOTE,baseQuantity:null,quoteQuantity:1}},
  {value:0,observed:SECOND,metadata:{maker:maker(3),eventType:'buy',baseAddress:ADDRESS,quoteAddress:QUOTE,baseQuantity:0,quoteQuantity:1}},
 ] as any,IDENTITY,wallets,totals as any)
 const unknown=wallets.get(maker(2))!,zero=wallets.get(maker(3))!
 eq([unknown.acquiredCount,unknown.acquiredUsd,unknown.acquiredQty],[1,null,null],'unreadable is never repaired into 0')
 eq([zero.acquiredCount,zero.acquiredUsd,zero.acquiredQty],[1,0,0],'a reported zero is a real answer')
})

Deno.test('the fold takes the stated per-leg direction out of the retained metadata',()=>{
 const wallets=new Map()
 const totals={swapsSeen:0,swapsWithMaker:0,duplicates:0,oldestEventAt:null,newestEventAt:null}
 foldSwapPage([
  // `tp` says "buy", but the provider states this contract's own leg was REDUCED.
  // The stated word wins, so this is a disposal.
  {value:50,observed:SECOND,metadata:{maker:maker(4),eventType:'buy',baseAddress:ADDRESS,quoteAddress:QUOTE,
   baseQuantity:3,quoteQuantity:1,baseDirection:'reduce',quoteDirection:'add'}},
 ] as any,IDENTITY,wallets,totals as any)
 const w=wallets.get(maker(4))!
 eq([w.disposedCount,w.disposedUsd,w.disposedQty],[1,50,3])
 eq(w.acquiredCount,0)
})

Deno.test('a swap that appears on two pages is folded once, never counted twice',async()=>{
 // The cursor is not promised to partition the tape. An overlapping page must
 // not inflate an account's accumulation, which is a number a reader would act on.
 const shared=swap({ma:maker(1),tx:'0xshared',lgid:7})
 const {request}=fakeRequest([
  body([shared,swap({ma:maker(1),tx:'0xone',lgid:1})],'c1'),
  body([shared,swap({ma:maker(2),tx:'0xtwo',lgid:2})]),
 ])
 const db=fakeDb()
 const result=await captureSwapFlow(db,IDENTITY,ctxFor,{request},{})
 eq(result.duplicates,1,'the repeat is recognised and reported')
 eq(result.swapsSeen,3,'three DISTINCT swaps across the two pages, not four')
 eq(result.swapsWithMaker,3)
 // deno-lint-ignore no-explicit-any
 const one=db.tables[SWAP_FLOW_TABLE].find((r:any)=>r.maker_address===maker(1))
 eq(one.swaps,2,'the shared swap counts once for this account')
 eq(one.acquired_count,2)
 eq(db.tables[SWAP_FLOW_CAPTURE_TABLE][0].swaps_seen,3,'the coverage row stores the distinct count')
})

Deno.test('the sweep walks the cursor to a bounded ceiling and says why it stopped',async()=>{
 // Four pages offered, each handing back the next cursor; the ceiling is two.
 const pages=[body([swap({ma:maker(1)})],'c1'),body([swap({ma:maker(2)})],'c2'),body([swap({ma:maker(3)})],'c3')]
 const {request,calls}=fakeRequest(pages)
 const db=fakeDb()
 const result=await captureSwapFlow(db,IDENTITY,ctxFor,{request},{maxPages:2})
 eq(result.pages,2)
 eq(calls.length,2,'the ceiling stops the walk, not the provider')
 eq(calls[0].lastId,undefined,'the first page asks for no cursor')
 eq(calls[1].lastId,'c1','the second follows the cursor the first returned')
 eq(result.stopReason,'page_ceiling')
 eq(result.exhausted,false,'a walk stopped by our own ceiling never claims the tape ran out')
 eq(result.credits,2,'one credit a page')
 eq(result.makers,2)
 eq(db.tables[SWAP_FLOW_TABLE].length,2)
 eq(db.tables[SWAP_FLOW_CAPTURE_TABLE][0].exhausted,false)
 eq(db.tables[SWAP_FLOW_CAPTURE_TABLE][0].pages,2)
})

Deno.test('a provider that runs out of tape is the only thing that marks a sweep exhausted',async()=>{
 const {request}=fakeRequest([body([swap({ma:maker(1)})],'c1'),body([swap({ma:maker(2)})])])
 const db=fakeDb()
 const result=await captureSwapFlow(db,IDENTITY,ctxFor,{request},{})
 eq(result.pages,2)
 eq(result.exhausted,true)
 eq(result.stopReason,'provider_exhausted')
 eq(db.tables[SWAP_FLOW_CAPTURE_TABLE][0].exhausted,true)
})

Deno.test('a repeated cursor ends the walk instead of spending the whole ceiling on one page',async()=>{
 const {request,calls}=fakeRequest([body([swap({ma:maker(1)})],'loop'),body([swap({ma:maker(2)})],'loop'),body([swap()],'loop')])
 const result=await captureSwapFlow(fakeDb(),IDENTITY,ctxFor,{request},{})
 eq(result.stopReason,'cursor_repeated')
 eq(calls.length,2)
 eq(result.exhausted,false)
})

Deno.test('a call budget below the page ceiling bounds the sweep and is reported',async()=>{
 const {request,calls}=fakeRequest([body([swap({ma:maker(1)})],'c1'),body([swap({ma:maker(2)})],'c2')])
 const result=await captureSwapFlow(fakeDb(),IDENTITY,(_n,_m)=>({maxCalls:1} as any),{request},{})
 eq(calls.length,1)
 eq(result.stopReason,'call_budget')
 eq(result.credits,1)
 eq(result.exhausted,false)
})

Deno.test('a page the provider could not answer keeps the pages already swept',async()=>{
 const {request}=fakeRequest([body([swap({ma:maker(1)})],'c1'),null])
 const db=fakeDb()
 const result=await captureSwapFlow(db,IDENTITY,ctxFor,{request},{})
 eq(result.pages,1,'the first page is not lost because the second failed')
 eq(result.partial,'provider_unavailable')
 eq(result.exhausted,false)
 eq(db.tables[SWAP_FLOW_TABLE].length,1)
})

Deno.test('the lane refuses below Startup, when disabled, and twice inside one hour',async()=>{
 const {request,calls}=fakeRequest([body([swap()])])
 eq((await captureSwapFlow(fakeDb(),IDENTITY,ctxFor,{request},{plan:'builder'})).skipped,'plan_below_startup')
 eq((await captureSwapFlow(fakeDb(),IDENTITY,ctxFor,{request,policy:[{feature:'swap_flow',enabled:false}]},{})).skipped,'policy_disabled')
 eq(calls.length,0,'none of these spends a call to discover the answer')

 // A sweep already recorded for this hour is a skip, not a second set of credits.
 const now=Date.parse('2026-09-16T10:30:00Z')
 const hour='2026-09-16T10:00:00.000Z'
 const db=fakeDb({[SWAP_FLOW_CAPTURE_TABLE]:[{chain:IDENTITY.chain,contract_address:IDENTITY.address,captured_at:hour}]})
 const again=await captureSwapFlow(db,IDENTITY,ctxFor,{request},{now})
 eq(again.skipped,'within_cadence')
 eq(again.credits,0)
 eq(calls.length,0)
})

Deno.test('the swept swaps reach the shared evidence path exactly once per page',async()=>{
 const {request}=fakeRequest([body([swap({ma:maker(1)})],'c1'),body([swap({ma:maker(2)})])])
 const recorded:string[]=[]
 await captureSwapFlow(fakeDb(),IDENTITY,ctxFor,{request,record:(capability)=>{recorded.push(capability)}},{})
 eq(recorded,['dexSwaps','dexSwaps'])
})

Deno.test('a sweep of a tape the provider answers empty is an answer, not a failure',async()=>{
 const {request}=fakeRequest([body([])])
 const result=await captureSwapFlow(fakeDb(),IDENTITY,ctxFor,{request},{})
 eq(result.stopReason,'no_reported_swaps')
 eq(result.makers,0)
 eq(result.wallets,[])
 eq(result.error,undefined,'an empty tape is not an error')
})

Deno.test('the lane never walks further than its published ceiling',()=>{
 eq(SWAP_FLOW_MAX_PAGES,8)
})
