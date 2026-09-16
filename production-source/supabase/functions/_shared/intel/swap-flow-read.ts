// Investor Intel: read views over the maker swap-flow capture tables.
//
// Same contract as `holder-tags-read.ts`, `capture-venues-read.ts` and
// `capture-listings-read.ts`: pure functions over a PostgREST-shaped `db`, every
// read bounded by an explicit row cap, ordered so that hitting a cap loses the
// least interesting rows, and `coverage` reporting the window actually read with
// `truncated`. An empty table is an empty result with `asOf: null`, never an
// error, and never a fabricated row.
//
// Both tables are service-role only; these reads run inside the `intel-research`
// Edge Function behind an authenticated Intel membership check.
//
// WHAT THE TWO CLOCKS MEAN. `capturedAt` is the hour WE swept the swap tape,
// floored to the hour. The event stamps (`firstEventAt`, `lastEventAt`,
// `oldestEventAt`, `newestEventAt`) are the PROVIDER's own swap timestamps:
// unlike the holder endpoints, the swap tape does date its rows. A sweep time is
// never presented as a swap time, or the other way round.
//
// WHAT A COHORT IS HERE. The accounts that appeared in the pages ONE sweep
// walked, at most `SWAP_FLOW_MAX_PAGES` x 25 swaps of tape. It is not every
// holder, not every trader, and not the token's whole history. `coverage.pages`,
// `coverage.exhausted` and `coverage.stopReason` say exactly how far the sweep
// got, and `firstTouch.complete` is false whenever the sweep stopped for any
// reason other than the provider running out of tape.
//
// WHAT AN ADDRESS IS. A public on-chain ACCOUNT. Nothing here names, describes
// or implies a person, nothing is enriched with ENS, exchange labels, handles or
// clustering, and no two accounts are ever related to each other. "Accumulating"
// and "distributing" describe which way a token moved through an account in the
// captured window; they are not intentions, strategies or advice.

import {cmcDexIdentity} from '../market-assets/cmc-dex.ts'
import {captureHour} from './holder-tags-read.ts'
import {SWAP_FLOW_CAPTURE_TABLE,SWAP_FLOW_MAX_PAGES,SWAP_FLOW_TABLE} from './swap-flow.ts'

/** Windows the capture list accepts, in days. */
export const SWAP_FLOW_DAYS=[7,30,90]
export const SWAP_FLOW_DEFAULT_DAYS=30
/** Sweeps offered in the capture selector, newest kept. */
export const SWAP_FLOW_CAPTURE_MAX=60
/** Accounts read for ONE sweep. A sweep reads at most SWAP_FLOW_MAX_PAGES x 25
 * swaps, so it can never name more accounts than that; the cap is the same
 * number plus headroom, which means a complete sweep is never truncated. */
export const SWAP_FLOW_ROW_CAP=SWAP_FLOW_MAX_PAGES*25+50
/** Accounts listed per cohort side, and in the first-touch list. */
export const SWAP_FLOW_SIDE_MAX=50

export interface FlowCoverage {from:string|null;to:string|null;count:number;truncated?:boolean}

const num=(v:unknown):number|null=>{if(v==null||v==='')return null;const n=Number(v);return Number.isFinite(n)?n:null}
const int=(v:unknown):number=>{const n=num(v);return n==null||n<0?0:Math.trunc(n)}
const str=(v:unknown,max=200):string|null=>{const s=v==null?'':String(v).trim();return s?s.slice(0,max):null}
const at=(now:Date|number):number=>(now instanceof Date?now.getTime():now)
const emptyCoverage=():FlowCoverage=>({from:null,to:null,count:0})

/** Bounded read. A failed read is reported as a reason on an empty result; the
 * caller renders "unavailable", never a silently short list. */
// deno-lint-ignore no-explicit-any
async function readRows(build:()=>any):Promise<{rows:any[];reason:string|null}> {
 try {
  const {data,error}=await build()
  if(error)return {rows:[],reason:String(error.message||error.code||error).slice(0,200)}
  return {rows:Array.isArray(data)?data:data?[data]:[],reason:null}
 }catch(e){return {rows:[],reason:((e as Error)?.message||'read_failed').slice(0,200)}}
}

const WALLET_COLUMNS='chain,contract_address,captured_at,maker_address,acquired_count,acquired_usd,acquired_qty,disposed_count,disposed_usd,disposed_qty,unclassified_count,unclassified_usd,swaps,excluded_count,first_event_at,last_event_at'
const CAPTURE_COLUMNS='chain,contract_address,captured_at,pages,swaps_seen,swaps_with_maker,makers,oldest_event_at,newest_event_at,exhausted,stop_reason,credits'

/** Net USD movement of this contract's token through one account in the swept
 * window.
 *
 * NULL when the provider reported no readable USD figure on either side. That is
 * NOT zero: "we could not read a value" and "the value was nil" are different
 * statements and only one of them is a balance. A side we could read is used
 * even when the other side is absent, because an account that only acquired has
 * a real net and a missing opposite side of nothing. */
export function netUsd(wallet:{acquiredUsd?:unknown;disposedUsd?:unknown}):number|null {
 const acquired=num(wallet?.acquiredUsd),disposed=num(wallet?.disposedUsd)
 if(acquired==null&&disposed==null)return null
 return (acquired??0)-(disposed??0)
}

/** Which way the token moved through one account across the swept window.
 *
 * `balanced` is a measured answer, the account having acquired and disposed of
 * the same USD value, and is kept apart from `unknown`, which is the provider
 * reporting no readable value at all. Neither is ever folded into the other, and
 * neither is a judgement about the account. */
export function classifyFlow(wallet:{acquiredUsd?:unknown;disposedUsd?:unknown}):'accumulating'|'distributing'|'balanced'|'unknown' {
 const net=netUsd(wallet)
 if(net==null)return 'unknown'
 return net>0?'accumulating':net<0?'distributing':'balanced'
}

/** One stored row as the view reports it. Counts are counts and default to zero
 * because a row exists only when a swap was counted; every MONEY figure stays
 * null when the provider did not report one. */
// deno-lint-ignore no-explicit-any
export function flowWallet(row:any):Record<string,unknown>|null {
 const maker=str(row?.maker_address,200)
 if(!maker)return null
 const wallet={makerAddress:maker,
  acquiredCount:int(row?.acquired_count),acquiredUsd:num(row?.acquired_usd),acquiredQty:num(row?.acquired_qty),
  disposedCount:int(row?.disposed_count),disposedUsd:num(row?.disposed_usd),disposedQty:num(row?.disposed_qty),
  unclassifiedCount:int(row?.unclassified_count),unclassifiedUsd:num(row?.unclassified_usd),
  swaps:int(row?.swaps),excludedCount:int(row?.excluded_count),
  firstEventAt:str(row?.first_event_at,60),lastEventAt:str(row?.last_event_at,60)}
 return {...wallet,netUsd:netUsd(wallet),flow:classifyFlow(wallet)}
}

/** Counts and totals per side. `unknownUsd` is the number of accounts whose net
 * could not be computed at all; it is reported beside the sides rather than
 * hidden inside one of them. */
// deno-lint-ignore no-explicit-any
export function summariseFlow(wallets:any[]):Record<string,unknown> {
 const side=(name:string)=>wallets.filter(w=>w?.flow===name)
 const total=(rows:any[])=>rows.reduce((sum:number|null,w:any)=>{const n=num(w?.netUsd);return n==null?sum:(sum??0)+n},null as number|null)
 const accumulating=side('accumulating'),distributing=side('distributing')
 return {
  accounts:wallets.length,
  accumulating:accumulating.length,distributing:distributing.length,
  balanced:side('balanced').length,unknown:side('unknown').length,
  accumulatedUsd:total(accumulating),distributedUsd:total(distributing),
  swaps:wallets.reduce((sum:number,w:any)=>sum+int(w?.swaps),0),
 }
}

const unsupported=(view:string,extra:Record<string,unknown>={})=>({
 view,subject:null,asOf:null,coverage:emptyCoverage(),
 reason:'unverified_contract_identity',...extra,
})

/** The sweeps held for this contract, newest last, for the capture selector. */
export async function readSwapFlowCaptures(
 // deno-lint-ignore no-explicit-any
 db:any,
 params:{chain?:unknown;address?:unknown;days?:unknown}={},
 now:Date|number=Date.now(),
):Promise<Record<string,unknown>> {
 const identity=cmcDexIdentity(`${str(params.chain,60)??''}:${str(params.address,200)??''}`)
 if(!identity)return unsupported('swap_flow_captures',{captures:[]})
 const requested=Math.trunc(Number(params.days))
 const days=SWAP_FLOW_DAYS.includes(requested)?requested:SWAP_FLOW_DEFAULT_DAYS
 const since=new Date(at(now)-days*86_400_000).toISOString()
 const page=await readRows(()=>db.from(SWAP_FLOW_CAPTURE_TABLE).select(CAPTURE_COLUMNS)
  .eq('chain',identity.chain).eq('contract_address',identity.address)
  .gte('captured_at',since).order('captured_at',{ascending:false}).limit(SWAP_FLOW_CAPTURE_MAX))
 const captures=page.rows.map(row=>{
  const capturedAt=captureHour(row?.captured_at)
  return capturedAt?{capturedAt,pages:int(row?.pages),swapsSeen:int(row?.swaps_seen),swapsWithMaker:int(row?.swaps_with_maker),
   makers:int(row?.makers),oldestEventAt:str(row?.oldest_event_at,60),newestEventAt:str(row?.newest_event_at,60),
   exhausted:row?.exhausted===true,stopReason:str(row?.stop_reason,60),credits:int(row?.credits)}:null
 }).filter(Boolean).sort((a:any,b:any)=>a.capturedAt.localeCompare(b.capturedAt))
 const latest=captures.at(-1)??null
 return {view:'swap_flow_captures',subject:identity.subject,network:identity.label,days,captures,latest,
  asOf:(latest as any)?.capturedAt??null,
  coverage:{from:(captures[0] as any)?.capturedAt??null,to:(latest as any)?.capturedAt??null,
   count:page.rows.length,truncated:page.rows.length>=SWAP_FLOW_CAPTURE_MAX},
  clock:'captured_at is the hour we swept the swap tape, not a provider observation time.',
  reason:page.reason}
}

/** One sweep, as accounts and cohorts.
 *
 * With no `capturedAt` the newest sweep is read. A sweep whose coverage row is
 * missing is still readable, since the accounts are what they are, but its
 * `firstTouch` can then make no completeness claim at all. */
export async function readSwapFlow(
 // deno-lint-ignore no-explicit-any
 db:any,
 params:{chain?:unknown;address?:unknown;capturedAt?:unknown}={},
):Promise<Record<string,unknown>> {
 const identity=cmcDexIdentity(`${str(params.chain,60)??''}:${str(params.address,200)??''}`)
 if(!identity)return unsupported('swap_flow',{capturedAt:null,wallets:[],accumulating:[],distributing:[],firstTouch:null,summary:null})

 let capturedAt=captureHour(params.capturedAt)
 let newestReason:string|null=null
 if(!capturedAt){
  const newest=await readRows(()=>db.from(SWAP_FLOW_CAPTURE_TABLE).select('captured_at')
   .eq('chain',identity.chain).eq('contract_address',identity.address)
   .order('captured_at',{ascending:false}).limit(1))
  newestReason=newest.reason
  capturedAt=captureHour(newest.rows[0]?.captured_at)
 }
 // The capture lane writes the per-account rows BEFORE the coverage row, so a
 // sweep interrupted between the two writes leaves real accounts behind with
 // nothing describing the sweep. Those accounts were captured and are still
 // shown: the hour is taken from the account table itself, and `firstTouch`
 // then reports that it holds no coverage to make any completeness claim with.
 // A missing coverage row must never empty a list that was actually captured.
 if(!capturedAt){
  const fallback=await readRows(()=>db.from(SWAP_FLOW_TABLE).select('captured_at')
   .eq('chain',identity.chain).eq('contract_address',identity.address)
   .order('captured_at',{ascending:false}).limit(1))
  newestReason=newestReason??fallback.reason
  capturedAt=captureHour(fallback.rows[0]?.captured_at)
 }
 const base={view:'swap_flow',subject:identity.subject,network:identity.label,capturedAt,
  window:`One sweep of at most ${SWAP_FLOW_MAX_PAGES} pages of 25 swaps, following the provider's own cursor from the newest swap backwards.`,
  basis:"Direction is the direction CoinMarketCap states for the leg that IS this contract, and only where it states none does it fall back to reading its buy/sell word against that leg. It describes how the token moved, not why: it is not intent, not skill and not advice. A swap that fits neither is counted as unclassified rather than forced onto a side.",
  clock:'captured_at is the hour we swept; the event times are the provider’s own swap timestamps.',
  scope:'Reported public swaps; not personal trades. A maker is a public on-chain account, not a person, and no account is linked to any other.'}
 if(!capturedAt)return {...base,wallets:[],accumulating:[],distributing:[],firstTouch:null,summary:null,
  asOf:null,coverage:emptyCoverage(),reason:newestReason??'no_capture'}

 const [page,cover]=await Promise.all([
  readRows(()=>db.from(SWAP_FLOW_TABLE).select(WALLET_COLUMNS)
   .eq('chain',identity.chain).eq('contract_address',identity.address).eq('captured_at',capturedAt)
   .limit(SWAP_FLOW_ROW_CAP)),
  readRows(()=>db.from(SWAP_FLOW_CAPTURE_TABLE).select(CAPTURE_COLUMNS)
   .eq('chain',identity.chain).eq('contract_address',identity.address).eq('captured_at',capturedAt).limit(1)),
 ])
 const wallets=page.rows.map(flowWallet).filter(Boolean) as Record<string,unknown>[]
 const row=cover.rows[0]??null
 const sweep=row?{pages:int(row.pages),swapsSeen:int(row.swaps_seen),swapsWithMaker:int(row.swaps_with_maker),
  makers:int(row.makers),oldestEventAt:str(row.oldest_event_at,60),newestEventAt:str(row.newest_event_at,60),
  exhausted:row.exhausted===true,stopReason:str(row.stop_reason,60),credits:int(row.credits)}:null

 // Biggest movement first on each side, so a cap loses the smallest positions.
 const by=(sign:number)=>wallets.filter(w=>w.flow===(sign>0?'accumulating':'distributing'))
  .sort((a,b)=>Math.abs(Number(b.netUsd))-Math.abs(Number(a.netUsd))).slice(0,SWAP_FLOW_SIDE_MAX)

 // FIRST TOUCH, stated exactly as far as it is true. These are the accounts
 // whose earliest swap inside THIS sweep is the earliest we hold. Only a sweep
 // that ran until the provider had no more tape can call that a token's first
 // touch; every other sweep stopped somewhere of our choosing, so `complete` is
 // false and the caller must say "earliest in what we captured". The list is
 // still returned either way: a qualified answer is not an empty one.
 const dated=wallets.filter(w=>typeof w.firstEventAt==='string')
 const firstTouch={
  complete:sweep?.exhausted===true,
  reason:sweep==null?'no_sweep_coverage':sweep.exhausted?null:(sweep.stopReason??'sweep_bounded'),
  windowStart:sweep?.oldestEventAt??(dated.length?String(dated.reduce((min:any,w:any)=>String(w.firstEventAt)<String(min.firstEventAt)?w:min).firstEventAt):null),
  wallets:[...dated].sort((a,b)=>String(a.firstEventAt).localeCompare(String(b.firstEventAt))).slice(0,SWAP_FLOW_SIDE_MAX),
 }

 return {...base,sweep,wallets,
  accumulating:by(1),distributing:by(-1),
  firstTouch,summary:summariseFlow(wallets),
  asOf:capturedAt,
  coverage:{from:capturedAt,to:capturedAt,count:page.rows.length,truncated:page.rows.length>=SWAP_FLOW_ROW_CAP},
  reason:page.reason??cover.reason}
}
