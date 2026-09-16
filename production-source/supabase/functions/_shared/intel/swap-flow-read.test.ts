import {assertEquals as eq,assert} from 'jsr:@std/assert'
import {classifyFlow,flowWallet,netUsd,readSwapFlow,readSwapFlowCaptures,summariseFlow} from './swap-flow-read.ts'
import {SWAP_FLOW_CAPTURE_TABLE,SWAP_FLOW_TABLE} from './swap-flow.ts'

const ADDRESS='0x'+'ab'.repeat(20)
const CHAIN='eip155:8453'
const SUBJECT=`${CHAIN}:${ADDRESS}`
const HOUR_10='2026-09-16T10:00:00.000Z',HOUR_11='2026-09-16T11:00:00.000Z'
const maker=(n:number)=>'0x'+n.toString(16).padStart(40,'0')

const wallet=(n:number,patch:Record<string,unknown>={})=>({chain:CHAIN,contract_address:ADDRESS,captured_at:HOUR_11,
 maker_address:maker(n),acquired_count:1,acquired_usd:100,acquired_qty:5,disposed_count:0,disposed_usd:null,disposed_qty:null,
 unclassified_count:0,unclassified_usd:null,swaps:1,excluded_count:0,
 first_event_at:'2026-09-16T09:00:00.000Z',last_event_at:'2026-09-16T09:30:00.000Z',...patch})

const sweepRow=(patch:Record<string,unknown>={})=>({chain:CHAIN,contract_address:ADDRESS,captured_at:HOUR_11,
 pages:2,swaps_seen:50,swaps_with_maker:48,makers:3,oldest_event_at:'2026-09-16T08:00:00.000Z',
 newest_event_at:'2026-09-16T10:55:00.000Z',exhausted:false,stop_reason:'page_ceiling',credits:2,...patch})

// deno-lint-ignore no-explicit-any
function fakeDb(tables:Record<string,any[]>={},fail:string|null=null) {
 return {
  from(table:string){
   // deno-lint-ignore no-explicit-any
   const filters:[string,string,any][]=[]
   let ordering:{column:string;ascending:boolean}|null=null
   // deno-lint-ignore no-explicit-any
   const rows=()=>(tables[table]||[]).filter((row:any)=>filters.every(([k,op,v])=>
    op==='eq'?String(row?.[k]??'')===String(v??''):op==='gte'?String(row?.[k]??'')>=String(v??''):true))
   // deno-lint-ignore no-explicit-any
   const q:any={
    select:()=>q,
    // deno-lint-ignore no-explicit-any
    eq:(k:string,v:any)=>{filters.push([k,'eq',v]);return q},
    // deno-lint-ignore no-explicit-any
    gte:(k:string,v:any)=>{filters.push([k,'gte',v]);return q},
    order:(column:string,options?:{ascending?:boolean})=>{ordering={column,ascending:options?.ascending!==false};return q},
    limit:(max:number)=>{
     if(fail===table)return Promise.resolve({data:null,error:{message:'read_exploded'}})
     let list=rows()
     if(ordering)list=[...list].sort((a,b)=>String(a?.[ordering!.column]??'').localeCompare(String(b?.[ordering!.column]??''))*(ordering!.ascending?1:-1))
     return Promise.resolve({data:list.slice(0,max),error:null})
    },
   }
   return q
  },
 }
}

const read=(tables:Record<string,unknown[]>,params:Record<string,unknown>={},fail:string|null=null)=>
 readSwapFlow(fakeDb(tables as any,fail),{chain:CHAIN,address:ADDRESS,...params}) as Promise<any>

Deno.test('a net exists only where the provider reported a value, and a measured zero is not an absence',()=>{
 eq(netUsd({acquiredUsd:100,disposedUsd:40}),60)
 eq(netUsd({acquiredUsd:40,disposedUsd:100}),-60)
 eq(netUsd({acquiredUsd:50,disposedUsd:50}),0,'a balanced account has a real net of zero')
 // A side we could read is used even when the other is absent: an account that
 // only acquired has a real net and a missing opposite side of nothing.
 eq(netUsd({acquiredUsd:100,disposedUsd:null}),100)
 eq(netUsd({acquiredUsd:null,disposedUsd:80}),-80)
 // Neither side readable is UNKNOWN, which is not zero.
 eq(netUsd({acquiredUsd:null,disposedUsd:null}),null)
 eq(classifyFlow({acquiredUsd:100,disposedUsd:40}),'accumulating')
 eq(classifyFlow({acquiredUsd:40,disposedUsd:100}),'distributing')
 eq(classifyFlow({acquiredUsd:50,disposedUsd:50}),'balanced')
 eq(classifyFlow({acquiredUsd:null,disposedUsd:null}),'unknown')
})

Deno.test('a stored row becomes an account with counts as counts and money as money',()=>{
 const row=flowWallet(wallet(1,{disposed_usd:40,disposed_count:2,disposed_qty:1}))!
 eq(row.makerAddress,maker(1))
 eq([row.acquiredCount,row.acquiredUsd,row.acquiredQty],[1,100,5])
 eq([row.disposedCount,row.disposedUsd,row.disposedQty],[2,40,1])
 eq(row.netUsd,60)
 eq(row.flow,'accumulating')
 // A count is a count: it exists because a swap was counted. A money figure the
 // provider never reported stays null and is never shown as a zero.
 const sparse=flowWallet(wallet(2,{acquired_usd:null,acquired_qty:null}))!
 eq([sparse.acquiredCount,sparse.acquiredUsd,sparse.acquiredQty],[1,null,null])
 eq(sparse.flow,'unknown')
 // A row naming no account is not an account.
 eq(flowWallet({...wallet(1),maker_address:null}),null)
})

Deno.test('the summary keeps balanced and unknown apart',()=>{
 const wallets=[
  flowWallet(wallet(1,{acquired_usd:100,disposed_usd:40})),
  flowWallet(wallet(2,{acquired_usd:10,disposed_usd:90})),
  flowWallet(wallet(3,{acquired_usd:50,disposed_usd:50})),
  flowWallet(wallet(4,{acquired_usd:null,disposed_usd:null})),
 ]
 const summary=summariseFlow(wallets as any)
 eq(summary.accounts,4)
 eq(summary.accumulating,1)
 eq(summary.distributing,1)
 eq(summary.balanced,1,'an account that moved the same value both ways measured something')
 eq(summary.unknown,1,'an account whose value was never reported measured nothing')
 eq(summary.accumulatedUsd,60)
 eq(summary.distributedUsd,-80)
})

Deno.test('one sweep reads as two cohorts, largest movement first',async()=>{
 const result=await read({
  [SWAP_FLOW_TABLE]:[
   wallet(1,{acquired_usd:100,disposed_usd:40}),
   wallet(2,{acquired_usd:900,disposed_usd:0}),
   wallet(3,{acquired_usd:10,disposed_usd:500}),
  ],
  [SWAP_FLOW_CAPTURE_TABLE]:[sweepRow()],
 })
 eq(result.capturedAt,HOUR_11)
 eq(result.accumulating.map((w:any)=>w.makerAddress),[maker(2),maker(1)],'biggest first, so a cap loses the smallest')
 eq(result.distributing.map((w:any)=>w.makerAddress),[maker(3)])
 eq(result.summary.accounts,3)
 eq(result.sweep.pages,2)
 eq(result.sweep.swapsSeen,50)
 eq(result.sweep.swapsWithMaker,48)
 assert(String(result.scope).includes('not a person'))
 assert(String(result.basis).includes('not advice'))
})

Deno.test('first touch is only complete when the provider ran out of tape',async()=>{
 const wallets=[
  wallet(1,{first_event_at:'2026-09-16T09:00:00.000Z'}),
  wallet(2,{first_event_at:'2026-09-16T07:00:00.000Z'}),
 ]
 // A sweep stopped by OUR ceiling cannot call anything a first touch.
 const bounded=await read({[SWAP_FLOW_TABLE]:wallets,[SWAP_FLOW_CAPTURE_TABLE]:[sweepRow()]})
 eq(bounded.firstTouch.complete,false)
 eq(bounded.firstTouch.reason,'page_ceiling')
 eq(bounded.firstTouch.wallets.map((w:any)=>w.makerAddress),[maker(2),maker(1)],'oldest first')
 // The list is still returned: a qualified answer is not an empty one.
 eq(bounded.firstTouch.wallets.length,2)

 // A sweep that exhausted the provider's tape may.
 const complete=await read({[SWAP_FLOW_TABLE]:wallets,
  [SWAP_FLOW_CAPTURE_TABLE]:[sweepRow({exhausted:true,stop_reason:'provider_exhausted'})]})
 eq(complete.firstTouch.complete,true)
 eq(complete.firstTouch.reason,null)

 // With no coverage row at all no completeness claim can be made either way.
 const uncovered=await read({[SWAP_FLOW_TABLE]:wallets,[SWAP_FLOW_CAPTURE_TABLE]:[]})
 eq(uncovered.firstTouch.complete,false)
 eq(uncovered.firstTouch.reason,'no_sweep_coverage')
})

Deno.test('a contract with no sweep is an empty answer, never an error',async()=>{
 const result=await read({})
 eq(result.reason,'no_capture')
 eq(result.wallets,[])
 eq(result.accumulating,[])
 eq(result.summary,null)
 eq(result.asOf,null)
 eq(result.capturedAt,null)
})

Deno.test('a failed read reports its reason and never invents a row',async()=>{
 const result=await read({[SWAP_FLOW_TABLE]:[wallet(1)],[SWAP_FLOW_CAPTURE_TABLE]:[sweepRow()]},{capturedAt:HOUR_11},SWAP_FLOW_TABLE)
 eq(result.wallets,[])
 eq(result.reason,'read_exploded')
 eq(result.capturedAt,HOUR_11,'the sweep that was asked for is still named')
})

Deno.test('an unverified contract identity is refused before anything is read',async()=>{
 const result=await readSwapFlow(fakeDb(),{chain:'eip155:999999',address:'0x00'}) as any
 eq(result.reason,'unverified_contract_identity')
 eq(result.subject,null)
 eq(result.wallets,[])
})

Deno.test('the sweep list is chronological and names what each sweep covered',async()=>{
 const result=await readSwapFlowCaptures(fakeDb({[SWAP_FLOW_CAPTURE_TABLE]:[
  sweepRow({captured_at:HOUR_11}),
  sweepRow({captured_at:HOUR_10,exhausted:true,stop_reason:'provider_exhausted',pages:1}),
 ]}),{chain:CHAIN,address:ADDRESS}) as any
 eq(result.captures.map((c:any)=>c.capturedAt),[HOUR_10,HOUR_11],'oldest first, so a selector reads left to right')
 eq(result.asOf,HOUR_11)
 eq(result.captures[0].exhausted,true)
 eq(result.captures[1].stopReason,'page_ceiling')
 eq(result.subject,SUBJECT)
 assert(String(result.clock).includes('not a provider observation time'))
})

Deno.test('a specific sweep can be asked for, and an hour is floored to the stored mark',async()=>{
 const tables={[SWAP_FLOW_TABLE]:[wallet(1),wallet(2,{captured_at:HOUR_10})],[SWAP_FLOW_CAPTURE_TABLE]:[sweepRow(),sweepRow({captured_at:HOUR_10})]}
 eq((await read(tables,{capturedAt:'2026-09-16T10:42:00.000Z'})).capturedAt,HOUR_10,'a stamp inside the hour names that hour')
 eq((await read(tables,{capturedAt:HOUR_11})).wallets.length,1)
})
