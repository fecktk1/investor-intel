// Investor Intel: maker swap-flow capture (the DEX swap tape, per account).
//
// Same contract as `holder-tags.ts`, `capture-jobs.ts` and `capture-listings.ts`:
// one function per lane, bounded by an explicit call ceiling, never throwing (a
// failure becomes `{error}` on the result), and injecting the transport as
// `deps.request` so the module tests without a network or a database.
//
// WHAT ONE CAPTURE DOES, for ONE contract on one of the four verified CMC DEX
// chains (ethereum, base, arbitrum, solana):
//   walks `/v1/dex/tokens/transactions` (`dexSwaps`) from newest to oldest,
//   following the provider's own `lastId` cursor, at 25 rows and 1 credit a
//   page, up to SWAP_FLOW_MAX_PAGES pages. It then aggregates the swaps it read
//   BY MAKER ACCOUNT and writes one row per account plus one row describing what
//   the walk actually covered.
//
// WHY THE CURSOR IS WALKED HERE AND NOWHERE ELSE. The `swaps` view of the
// contract workspace asks for one page of 25 and advances `lastId` only when a
// reader presses "Next activity". Twenty-five swaps is a fine tape and a useless
// cohort: a single account may not appear twice in it. A cohort needs a bounded
// SWEEP, so this lane owns the cursor, its page ceiling and its credit stop, and
// the read view states how far the sweep actually got.
//
// UPPER BOUND for one capture: SWAP_FLOW_MAX_PAGES credits (8). The shared
// transport serves a still-fresh cached page for 0 credits, so the billed total
// is never higher. The walk stops early, and says why, on any of: the provider
// returning no cursor (the tape is exhausted), a cursor it has already followed
// (a provider loop), an unreadable page, the call budget, or the page ceiling.
//
// THE CLOCK. Two different clocks live here and are never mixed. `captured_at`
// is the hour WE swept, floored to the hour, exactly as in `holder-tags.ts`, and
// it is what makes a retried or double-clicked refresh inside one hour land on
// the same primary key instead of inventing a second sweep. `first_event_at` /
// `last_event_at` / `oldest_event_at` / `newest_event_at` are the PROVIDER's own
// swap timestamps. Unlike the holder endpoints, the swap tape does publish a
// clock per row, so these date the swaps, not the sweep.
//
// PRIVACY. A maker is a public on-chain ACCOUNT, never a person. This lane keeps
// ONE account per swap and nothing else that identifies anybody: the provider's
// `f` (sender) and `pa` (pool) are deliberately not read, because keeping a
// second account beside the maker is the first step of relating accounts to each
// other, which this codebase does not do. Nothing here is enriched with an ENS
// name, an exchange label, a social handle or a cluster, there is no column in
// which such a thing could be stored, and no label anywhere in this lane names
// or describes a human being. See `holder-tags.ts` and `cmc-capabilities.ts` for
// the same rules stated for the holder surfaces.
//
// The small helpers (num/text, upsert, callBudget) are copied from
// `holder-tags.ts` rather than exported from it: the capture lanes deliberately
// keep their own copies while several are being added concurrently.

import {planAllows,estimateCmcCredits,cmcParams} from '../market-assets/cmc-capabilities.ts'
import {cmcDexParams,cmcDexSameAddress,isCmcDexCursor,type CmcDexIdentity} from '../market-assets/cmc-dex.ts'
import type {MarketAssetsContext} from '../market-assets/types.ts'
import {CAPTURE_PROVIDER,hourBucket,iso} from './capture-jobs.ts'
import type {CaptureRequest,SchedulePolicyRow} from './capture-jobs.ts'
import {dexEvidenceRows} from './cmc-dex-evidence.ts'

/** Rows per `dexSwaps` page. The registry's own default (cmc-dex.ts builds
 * `limit:'25'` for this capability). Asking for a different page here would
 * make the lane's credit arithmetic disagree with the transport's. */
export const SWAP_FLOW_PAGE=25
/** Pages one sweep may walk. 8 pages x 25 rows = at most 200 swaps for at most
 * 8 credits, against the same 1,000/month `structure` feature cap the holder-tag
 * and new-listing lanes bill. A ceiling stated in advance is the whole point:
 * the provider publishes no total, so an unbounded walk has no known cost. */
export const SWAP_FLOW_MAX_PAGES=8
/** The `provider_schedule_policy` feature this lane answers to. There is NO cron
 * job: capture is on demand from the contract workspace. The policy row exists
 * only so an operator can switch the lane off. */
export const SWAP_FLOW_FEATURE='swap_flow'
export const SWAP_FLOW_TABLE='intel_swap_flow_snapshots'
export const SWAP_FLOW_CAPTURE_TABLE='intel_swap_flow_captures'
/** Written rows per statement, matching the other capture lanes. */
const MAX_UPSERT_ROWS=500

export interface SwapFlowWallet {
 makerAddress:string
 acquiredCount:number; acquiredUsd:number|null; acquiredQty:number|null
 disposedCount:number; disposedUsd:number|null; disposedQty:number|null
 unclassifiedCount:number; unclassifiedUsd:number|null
 swaps:number; excludedCount:number
 firstEventAt:string|null; lastEventAt:string|null
}
export interface SwapFlowCapture {
 capturedAt:string
 wallets:SwapFlowWallet[]
 pages:number; swapsSeen:number; swapsWithMaker:number; makers:number
 /** Swaps this sweep read more than once because two pages overlapped. They are
  * folded ONCE and reported here rather than inflating an account's totals. */
 duplicates:number
 oldestEventAt:string|null; newestEventAt:string|null
 exhausted:boolean
 credits:number; calls?:number
 skipped?:string; partial?:string; stopReason?:string; error?:string
}
export interface SwapFlowDeps {
 request:CaptureRequest
 policy?:SchedulePolicyRow[]
 /** Optional evidence sink. Called once per SUCCESSFUL page so the caller can
  * run the shared `normalizeCmcInvestigation` path and retain the swap
  * observations this sweep read: the same rows the `swaps` view already
  * retains, on exactly the same path, never a second private copy. */
 // deno-lint-ignore no-explicit-any
 record?:(capability:string,params:Record<string,string>,response:any)=>Promise<void>|void
}
export interface SwapFlowOptions {
 maxPages?:number
 now?:Date|number
 /** When present the lane refuses below Startup instead of spending a call to
  * find out. When absent the caller has already gated (the research view does). */
 plan?:string|null
}

const num=(v:unknown):number|null=>{if(v==null||v==='')return null;const n=Number(v);return Number.isFinite(n)?n:null}
const text=(v:unknown,max=200):string|null=>{const s=v==null?'':String(v).trim();return s?s.slice(0,max):null}
const reason=(v:unknown,fallback:string):string=>text(v,60)||fallback
/** Sum that keeps "unknown" distinct from "zero". A running total stays null
 * until a readable figure arrives; a readable zero makes it a real zero. */
const addUsd=(total:number|null,value:number|null):number|null=>value==null?total:(total??0)+value

// deno-lint-ignore no-explicit-any
async function upsert(db:any,table:string,rows:Record<string,unknown>[],onConflict:string):Promise<{rows:number;error?:string}> {
 if(!rows.length)return {rows:0}
 let written=0
 for(let start=0;start<rows.length;start+=MAX_UPSERT_ROWS){
  const chunk=rows.slice(start,start+MAX_UPSERT_ROWS)
  try {
   const {error}=await db.from(table).upsert(chunk,{onConflict})
   if(error)return {rows:written,error:String(error.message||error).slice(0,200)}
   written+=chunk.length
  }catch(e){return {rows:written,error:((e as Error)?.message||'write_failed').slice(0,200)}}
 }
 return {rows:written}
}

/** How many provider calls this context permits. A context with no explicit
 * budget still runs the lane's own ceiling; it never runs unbounded. */
const callBudget=(ctx:MarketAssetsContext,ceiling:number):number=>{
 const budget=Number(ctx?.maxCalls)
 return Math.max(0,Math.min(ceiling,Number.isFinite(budget)&&budget>=0?Math.trunc(budget):ceiling))
}

/** The lane is enabled unless an operator disabled its policy row. A missing row
 * means enabled: this lane has no cron schedule to run away with. */
function lanePolicy(deps:SwapFlowDeps):{enabled:boolean} {
 const row=(deps.policy||[]).find(r=>r?.feature===SWAP_FLOW_FEATURE&&(r.provider??CAPTURE_PROVIDER)===CAPTURE_PROVIDER)
 return {enabled:row?row.enabled!==false:true}
}

/** Is there already a sweep for this contract in this hour? A capture is
 * idempotent within its hour, so a second refresh inside the same hour is a skip
 * and not a second set of credits. A FAILED read never blocks the capture: the
 * write is an upsert keyed on the hour, so the worst case is a rewrite of rows
 * that are already there. */
// deno-lint-ignore no-explicit-any
async function capturedThisHour(db:any,chain:string,address:string,capturedAt:string):Promise<boolean> {
 try {
  const {data,error}=await db.from(SWAP_FLOW_CAPTURE_TABLE).select('captured_at')
   .eq('chain',chain).eq('contract_address',address).eq('captured_at',capturedAt).limit(1)
  if(error)return false
  return Array.isArray(data)?data.length>0:!!data
 }catch{return false}
}

/** Which way THIS contract's token moved through the maker's side of one swap.
 *
 * PREFERRED: THE PROVIDER'S OWN PER-LEG WORD. Probed live on 2026-09-16 against
 * /v1/dex/tokens/transactions, every row carries `t0pt` and `t1pt`, a direction
 * for each leg, observed as "reduce" and "add". On the probed row the queried
 * token was the base leg, `tp` was "sell", `t0pt` was "reduce" and `t1pt` was
 * "add": the maker gave up the queried token and received the other. So "reduce"
 * on the subject's OWN leg is `disposed` and "add" is `acquired`, and the
 * direction is READ from the provider rather than deduced.
 *
 * FALLBACK, used only when the provider states nothing for the subject's leg:
 * the older reading of `tp`. `tp` classifies the trade against the BASE leg, so a
 * subject that is the base leg takes the word as it stands and a subject that is
 * the QUOTE leg inverts it, because buying the base means paying with, and so
 * giving up, the token being asked about. THAT INVERSION IS AN INTERPRETATION:
 * CoinMarketCap does not publish which leg `tp` is relative to. The 2026-09-16
 * probe showed the two agreeing on that row, which is supporting evidence and
 * not a guarantee, so the fallback stays labelled as inference wherever it shows.
 *
 * The leg vocabulary is undocumented, so a word that is neither "add" nor
 * "reduce" is NOT read as a direction: it drops to the fallback, and if that
 * cannot place the swap either it becomes `unclassified`. An unclassified swap is
 * still counted and its value still reported; it simply takes no side.
 *
 * `acquired` and `disposed` describe the movement of the token, not an intent, a
 * strategy or a person's decision. */
export function swapDirection(eventType:unknown,subjectIsBase:boolean,subjectIsQuote:boolean,
 baseDirection?:unknown,quoteDirection?:unknown):'acquired'|'disposed'|'unclassified' {
 const leg=(value:unknown):'acquired'|'disposed'|null=>{
  const word=typeof value==='string'?value.trim().toLowerCase():''
  return word==='add'?'acquired':word==='reduce'?'disposed':null
 }
 // The subject's OWN leg only. The opposite leg moves the other token and says
 // nothing about how this contract's token moved.
 const stated=subjectIsBase?leg(baseDirection):subjectIsQuote?leg(quoteDirection):null
 if(stated)return stated
 const side=typeof eventType==='string'?eventType.trim().toLowerCase():''
 if(side!=='buy'&&side!=='sell')return 'unclassified'
 if(subjectIsBase)return side==='buy'?'acquired':'disposed'
 if(subjectIsQuote)return side==='buy'?'disposed':'acquired'
 return 'unclassified'
}

/** Aggregate the swaps of ONE page into the running per-account totals.
 *
 * Input rows are whatever `dexEvidenceRows('dexSwaps', …)` retained, so the
 * cohort can only ever be built out of legs this repository actually keeps:
 * there is no second, wider read of the response hiding in this lane.
 *
 * A swap the provider attributed to NO maker is counted in `swapsSeen` and dated
 * like any other, but belongs to no account and enters no cohort. It is never
 * bundled into an "unknown wallet" bucket: that would be one invented account
 * standing in for many real ones. */
export function foldSwapPage(
 rows:{value:unknown;observed:unknown;metadata:Record<string,unknown>}[],
 identity:CmcDexIdentity,
 wallets:Map<string,SwapFlowWallet>,
 totals:{swapsSeen:number;swapsWithMaker:number;duplicates:number;oldestEventAt:string|null;newestEventAt:string|null},
 seen:Set<string>=new Set<string>(),
):void {
 for(const row of rows){
  const meta=row.metadata||{}
  // ONE SWAP IS ONE SWAP, across every page of the sweep. The provider's cursor
  // is not promised to partition the tape, and two overlapping pages would
  // otherwise count the same swap twice in an account's totals. An inflated
  // accumulation count is exactly the kind of number a reader would act on, so a
  // swap already folded is skipped and counted as a duplicate instead.
  // Retained OBSERVATIONS never had this problem: their universe key is already
  // the transaction plus the log index, so the store collapses a repeat by itself.
  const tx=text(meta.transaction,200),logIndex=meta.logIndex==null?null:String(meta.logIndex)
  const key=tx&&logIndex?`${tx}:${logIndex}`:null
  if(key){
   if(seen.has(key)){totals.duplicates+=1;continue}
   seen.add(key)
  }
  const at=iso(row.observed)
  totals.swapsSeen+=1
  if(at){
   if(!totals.oldestEventAt||at<totals.oldestEventAt)totals.oldestEventAt=at
   if(!totals.newestEventAt||at>totals.newestEventAt)totals.newestEventAt=at
  }
  const maker=text(meta.maker,200)
  if(!maker)continue
  totals.swapsWithMaker+=1
  const subjectIsBase=cmcDexSameAddress(meta.baseAddress,identity.address,identity.platform)
  const subjectIsQuote=cmcDexSameAddress(meta.quoteAddress,identity.address,identity.platform)
  const direction=swapDirection(meta.eventType,subjectIsBase,subjectIsQuote,meta.baseDirection,meta.quoteDirection)
  // The quantity of THIS contract's token, taken from whichever leg is this
  // contract. A leg we could not read is null, never zero.
  const qty=subjectIsBase?num(meta.baseQuantity):subjectIsQuote?num(meta.quoteQuantity):null
  const usd=num(row.value)
  const wallet=wallets.get(maker)??{makerAddress:maker,
   acquiredCount:0,acquiredUsd:null,acquiredQty:null,
   disposedCount:0,disposedUsd:null,disposedQty:null,
   unclassifiedCount:0,unclassifiedUsd:null,
   swaps:0,excludedCount:0,firstEventAt:null,lastEventAt:null}
  wallet.swaps+=1
  if(meta.excluded===true)wallet.excludedCount+=1
  if(direction==='acquired'){wallet.acquiredCount+=1;wallet.acquiredUsd=addUsd(wallet.acquiredUsd,usd);wallet.acquiredQty=addUsd(wallet.acquiredQty,qty)}
  else if(direction==='disposed'){wallet.disposedCount+=1;wallet.disposedUsd=addUsd(wallet.disposedUsd,usd);wallet.disposedQty=addUsd(wallet.disposedQty,qty)}
  else {wallet.unclassifiedCount+=1;wallet.unclassifiedUsd=addUsd(wallet.unclassifiedUsd,usd)}
  if(at){
   if(!wallet.firstEventAt||at<wallet.firstEventAt)wallet.firstEventAt=at
   if(!wallet.lastEventAt||at>wallet.lastEventAt)wallet.lastEventAt=at
  }
  wallets.set(maker,wallet)
 }
}

/** Sweep the swap tape and store it per maker account.
 *
 * Returns what the sweep DID, never a promise about what is true on chain:
 * `pages` is how far the cursor was walked, `exhausted` whether the provider ran
 * out of tape before the ceiling did, and `stopReason` why the walk ended. Those
 * three are what make the read view's "first touch" honest, because a first
 * appearance inside a sweep that stopped at its ceiling is NOT a token's first
 * ever swap and must never be presented as one. */
export async function captureSwapFlow(
 // deno-lint-ignore no-explicit-any
 admin:any,
 identity:CmcDexIdentity,
 ctxFor:(name:string,maxCalls:number)=>MarketAssetsContext,
 deps:SwapFlowDeps,
 options:SwapFlowOptions={},
):Promise<SwapFlowCapture> {
 const capturedAt=hourBucket(options.now??Date.now())
 const ceiling=Math.max(1,Math.min(SWAP_FLOW_MAX_PAGES,Math.trunc(Number(options.maxPages))||SWAP_FLOW_MAX_PAGES))
 const empty=(extra:Partial<SwapFlowCapture>):SwapFlowCapture=>({capturedAt,wallets:[],pages:0,swapsSeen:0,swapsWithMaker:0,makers:0,duplicates:0,
  oldestEventAt:null,newestEventAt:null,exhausted:false,credits:0,...extra})
 let credits=0
 try {
  if(!identity)return empty({error:'missing_identifier'})
  if(typeof options.plan==='string'&&!planAllows(options.plan,'startup'))return empty({skipped:'plan_below_startup'})
  if(!lanePolicy(deps).enabled)return empty({skipped:'policy_disabled'})
  if(await capturedThisHour(admin,identity.chain,identity.address,capturedAt))return empty({skipped:'within_cadence'})

  const ctx=ctxFor('swap-flow',ceiling)
  const budget=callBudget(ctx,ceiling)
  if(budget<1)return empty({skipped:'call_budget'})

  const wallets=new Map<string,SwapFlowWallet>()
  const totals={swapsSeen:0,swapsWithMaker:0,duplicates:0,oldestEventAt:null as string|null,newestEventAt:null as string|null}
  // Cursors already followed. A provider that hands back a cursor we have
  // already walked would otherwise spend the whole ceiling re-reading one page.
  const seenCursors=new Set<string>()
  // Swaps already folded, by transaction and log index, for the WHOLE sweep and
  // not merely within one page.
  const seenSwaps=new Set<string>()
  let cursor:string|null=null,pages=0,calls=0,exhausted=false,stopReason:string|null=null,partial:string|null=null

  while(pages<ceiling){
   if(calls+1>budget){stopReason='call_budget';break}
   const params=cmcParams('dexSwaps',cmcDexParams('dexSwaps',identity,cursor?{lastId:cursor}:{}))
   calls+=1
   credits+=estimateCmcCredits('dexSwaps',params)
   const page=await deps.request('dexSwaps',params,ctx).catch(()=>null)
   if(!page?.payload){stopReason=reason(page?.reason,'provider_unavailable');partial=partial||stopReason;break}
   // ONE parser. `dexEvidenceRows` validates the response against the request
   // and returns exactly the legs this repository retains, so the cohort cannot
   // be built from a field the evidence path does not keep.
   const rows=dexEvidenceRows('dexSwaps',page.payload,params)
   // The evidence path runs per successful page, on the shared route.
   try {await deps.record?.('dexSwaps',params,page)}catch{/* evidence never loses a sweep */}
   if(!rows.length&&!pages){stopReason='no_reported_swaps';break}
   pages+=1
   foldSwapPage(rows,identity,wallets,totals,seenSwaps)
   const next=page.payload?.data?.lastId
   const nextCursor=isCmcDexCursor(next)?next:null
   if(!nextCursor){exhausted=true;stopReason=stopReason||'provider_exhausted';break}
   if(seenCursors.has(nextCursor)){stopReason='cursor_repeated';break}
   seenCursors.add(nextCursor)
   cursor=nextCursor
  }
  if(!stopReason&&pages>=ceiling)stopReason='page_ceiling'

  const list=[...wallets.values()]
  const walletWrites=list.map(w=>({chain:identity.chain,contract_address:identity.address,captured_at:capturedAt,
   maker_address:w.makerAddress,
   acquired_count:w.acquiredCount,acquired_usd:w.acquiredUsd,acquired_qty:w.acquiredQty,
   disposed_count:w.disposedCount,disposed_usd:w.disposedUsd,disposed_qty:w.disposedQty,
   unclassified_count:w.unclassifiedCount,unclassified_usd:w.unclassifiedUsd,
   swaps:w.swaps,excluded_count:w.excludedCount,
   first_event_at:w.firstEventAt,last_event_at:w.lastEventAt}))
  const captureWrite={chain:identity.chain,contract_address:identity.address,captured_at:capturedAt,
   pages,swaps_seen:totals.swapsSeen,swaps_with_maker:totals.swapsWithMaker,makers:list.length,
   oldest_event_at:totals.oldestEventAt,newest_event_at:totals.newestEventAt,
   exhausted,stop_reason:stopReason,credits}

  // The per-account rows go first and the coverage row second, so the coverage
  // row, which is what `within_cadence` reads and what the read view trusts to
  // describe the sweep, is never present for a sweep whose accounts are not.
  const written=await upsert(admin,SWAP_FLOW_TABLE,walletWrites,'chain,contract_address,captured_at,maker_address')
  const coverage=written.error?{rows:0}:await upsert(admin,SWAP_FLOW_CAPTURE_TABLE,[captureWrite],'chain,contract_address,captured_at')
  return {
   capturedAt,wallets:list,pages,swapsSeen:totals.swapsSeen,swapsWithMaker:totals.swapsWithMaker,makers:list.length,duplicates:totals.duplicates,
   oldestEventAt:totals.oldestEventAt,newestEventAt:totals.newestEventAt,exhausted,credits,calls,
   ...(stopReason?{stopReason}:{}),
   ...(partial?{partial}:{}),
   ...(written.error||coverage.error?{error:(written.error||coverage.error) as string}:{}),
  }
 }catch(e){
  return empty({credits,error:((e as Error)?.message||'swap_flow_capture_failed').slice(0,200)})
 }
}
