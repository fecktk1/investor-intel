// Source receipts for figures that did not come through one CoinMarketCap call.
//
// `CmcReceipt` (market-assets/cmc-transport.ts) describes ONE transport read and
// its field list is pinned by the recorded evidence artefact, so it is never
// widened here. A market surface also shows figures read from stored copies: the
// capture tables, the market catalogue, a shared Birdeye chart cache, a DEX pool
// snapshot. `SourceReceipt` is the superset the app's receipt drawer renders for
// those. Every CmcReceipt is also a valid SourceReceipt once `provider` and
// `freshness` are derived, so a surface can show both kinds in one drawer.
//
// NOTHING HERE CALLS A PROVIDER. A receipt for a stored figure describes the
// stored capture: when it was captured, from which endpoint, what the capture
// run recorded about its own calls, and its age against the cadence it is
// refreshed on. Reading one is a database read that costs no credit, so it is
// safe on a free surface.
//
// WHAT IS EXPOSED. provider_call_logs is service-role only and also records
// member-initiated calls. Only rows written by the scheduled capture callers
// (`intel-capture-*`, which carry no org or user) are read, and only the
// endpoint path (already redacted by logProviderCall), the cache status, the
// HTTP status, the credit count, the call count and the time. Request ids,
// error messages and every org or user column stay behind.

import {ageFreshness,type FigureFreshness} from './market-figure-scope.ts'

export type ReceiptOrigin='live'|'cache'|'negative-cache'|'capture'|'stored'
export type CaptureCallOrigin='live'|'cache'|'negative-cache'|'error'
export interface SourceReceipt {
 capability:string; endpoint:string|null; parameters:Record<string,string>
 httpStatus:number|null; creditCount:number|null; elapsedMs:number|null
 origin:ReceiptOrigin; keyMode:'keyed'|'keyless'|null
 cacheAgeSeconds:number|null; ttlSeconds:number|null; staleUntil:string|null
 fetchedAt:string|null; reservation:string|null
 provider:string; freshness:FigureFreshness
 /** Stored figures only: when the stored row was written, and the cadence the
  *  store is refreshed on. `ttlSeconds` stays the transport's own refresh limit. */
 capturedAt?:string|null; cadenceSeconds?:number|null
 /** Capture runs only: what the capture run's own call was, how many calls the
  *  run made to this endpoint, and when the newest of them happened. */
 captureCall?:CaptureCallOrigin|null; callCount?:number|null; calledAt?:string|null
}

const finiteOrNull=(v:unknown):number|null=>{if(v==null||v==='')return null;const n=Number(v);return Number.isFinite(n)?n:null}
const iso=(v:unknown):string|null=>{if(v==null||v==='')return null;const t=Date.parse(String(v));return Number.isFinite(t)?new Date(t).toISOString():null}

/** A stored capture counts as inside its cadence up to one and a half cadences:
 * cron fires on wall-clock minutes and a run may be skipped once within its
 * grace, so exactly one cadence would call every normal capture overdue. */
export const CAPTURE_CADENCE_GRACE=1.5

/** The freshness a receipt states, derived from its own fields so a receipt
 * built before this field existed (every CmcReceipt) still answers. */
export function receiptFreshness(receipt:any,now=Date.now()):FigureFreshness {
 if(!receipt||typeof receipt!=='object')return 'unavailable'
 if(['fresh','cached','stale','unavailable'].includes(receipt.freshness))return receipt.freshness
 if(receipt.origin==='negative-cache')return 'unavailable'
 if(receipt.origin==='live'){const s=finiteOrNull(receipt.httpStatus);return receipt.fetchedAt&&s!=null&&s>=200&&s<300?'fresh':'unavailable'}
 const fetched=Date.parse(String(receipt.capturedAt||receipt.fetchedAt||''))
 if(!Number.isFinite(fetched))return 'unavailable'
 const stale=Date.parse(String(receipt.staleUntil||''))
 const limit=finiteOrNull(receipt.ttlSeconds)??(finiteOrNull(receipt.cadenceSeconds)!=null?Number(receipt.cadenceSeconds)*CAPTURE_CADENCE_GRACE:null)
 const age=finiteOrNull(receipt.cacheAgeSeconds)??Math.max(0,(now-fetched)/1000)
 if(limit!=null)return age<=limit?'cached':'stale'
 if(Number.isFinite(stale))return stale>now?'cached':'stale'
 return 'cached'
}

/** A CmcReceipt as a SourceReceipt. The CMC fields pass through untouched. */
export function fromCmcReceipt(receipt:any,now=Date.now()):SourceReceipt|null {
 if(!receipt||typeof receipt!=='object')return null
 return {...receipt,provider:'coinmarketcap',freshness:receiptFreshness(receipt,now)}
}

export interface StoredReceiptInput {
 provider:string; capability:string; endpoint?:string|null; parameters?:Record<string,string>
 origin?:'stored'|'capture'|'cache'|'live'; keyMode?:'keyed'|'keyless'|null
 fetchedAt?:unknown; capturedAt?:unknown; refreshSeconds?:number|null
 httpStatus?:unknown; creditCount?:unknown; state?:string|null
}
/** A receipt for a figure read from a stored or shared copy. `state` is the
 * source's own reported state where it has one ('unavailable' wins over age). */
export function storedReceipt(input:StoredReceiptInput,now=Date.now()):SourceReceipt {
 const fetchedAt=iso(input.fetchedAt),capturedAt=iso(input.capturedAt)??fetchedAt
 const origin=input.origin??'stored',cadence=finiteOrNull(input.refreshSeconds)
 const clock=capturedAt??fetchedAt,age=clock?Math.max(0,Math.round((now-Date.parse(clock))/1000)):null
 let freshness:FigureFreshness
 if(input.state==='unavailable'||!clock)freshness='unavailable'
 else if(origin==='live')freshness='fresh'
 else if(input.state==='stale')freshness='stale'
 else freshness=ageFreshness(clock,cadence==null?null:(origin==='cache'?cadence:cadence*CAPTURE_CADENCE_GRACE),now)??'cached'
 return {capability:input.capability,endpoint:input.endpoint??null,parameters:input.parameters??{},
  httpStatus:finiteOrNull(input.httpStatus),creditCount:finiteOrNull(input.creditCount),elapsedMs:null,
  origin,keyMode:input.keyMode??null,cacheAgeSeconds:age,ttlSeconds:origin==='cache'?cadence:null,staleUntil:null,
  fetchedAt,reservation:null,provider:input.provider,freshness,capturedAt,cadenceSeconds:origin==='cache'?null:cadence}
}

// ─── Capture run receipts ─────────────────────────────────────────────────────

export interface CaptureLane {
 /** The `caller` values the capture jobs log under (ctxFor(name) → intel-capture-<name>). */
 callers:string[]
 /** provider_schedule_policy feature whose cadence refreshes this lane. */
 feature:string
 /** The table and clock column the capture job's own cadence guard reads. */
 table:string; column:string; filters?:[string,string][]
 provider:string; keyMode:'keyed'|'keyless'
 /** The cron schedule, where it is slower than the policy's minimum spacing.
  *  The index lane shares the 300-second `structure` policy row with the
  *  five-minute liquidation lane but only runs in the hourly batch. */
 scheduleSeconds?:number
}
const cmcLane=(callers:string[],feature:string,table:string,column:string,filters?:[string,string][]):CaptureLane=>({callers,feature,table,column,filters,provider:'coinmarketcap',keyMode:'keyed'})
/** Mirrors the cadence guards in capture-jobs.ts, capture-categories.ts,
 * capture-listings.ts, capture-meme.ts and capture-venues.ts. The fallback
 * cadences are those modules' own documented defaults. */
export const CAPTURE_RECEIPT_LANES:Record<string,CaptureLane>={
 regime:cmcLane(['intel-capture-regime'],'regime','intel_regime_snapshots','captured_at'),
 network_stats:cmcLane(['intel-capture-network-stats'],'network_stats','intel_network_stats_snapshots','captured_at'),
 rank:cmcLane(['intel-capture-rank-daily','intel-capture-rank-backfill'],'history','intel_rank_history','created_at'),
 rwa:cmcLane(['intel-capture-rwa'],'rwa','intel_rwa_universe_snapshots','captured_at'),
 index:{...cmcLane(['intel-capture-index'],'structure','intel_index_constituent_snapshots','captured_at'),scheduleSeconds:3600},
 liquidations:cmcLane(['intel-capture-liquidations'],'structure','intel_liquidation_snapshots','captured_at'),
 attention:cmcLane(['intel-capture-attention'],'attention','intel_attention_snapshots','captured_at'),
 exchange_reserves:cmcLane(['intel-capture-exchange-map','intel-capture-exchange-listings','intel-capture-exchange-assets'],'exchange_reserves','intel_exchange_reserve_snapshots','created_at'),
 venue_share:cmcLane(['intel-capture-venue-share'],'venue_share','intel_venue_share_snapshots','created_at'),
 categories:cmcLane(['intel-capture-categories','intel-capture-category-members'],'categories','intel_category_snapshots','captured_at'),
 airdrops:cmcLane(['intel-capture-airdrops'],'airdrops','intel_airdrop_snapshots','last_seen_at'),
 new_listings:cmcLane(['intel-capture-new-listings'],'listings','intel_new_listing_snapshots','captured_at'),
 meme_stages:cmcLane(['intel-capture-meme-stages'],'meme_stages','intel_meme_stage_snapshots','captured_at'),
 rwa_depth:cmcLane(['intel-capture-rwa-depth'],'rwa_depth','intel_rwa_depth_snapshots','captured_at'),
}
const FALLBACK_CADENCE:Record<string,number>={regime:3600,structure:300,rwa:3600,attention:3600,history:86400,airdrops:86400,categories:3600,network_stats:3600,listings:86400,meme_stages:3600,rwa_depth:86400,exchange_reserves:86400,venue_share:86400}
/** Calls within this window before a caller's newest call belong to one run. */
export const CAPTURE_RUN_WINDOW_MS=15*60_000
const MAX_LANES=8,LOG_LIMIT=400,MAX_LOOKBACK_MS=3*86_400_000

const CACHE_STATUS:Record<string,CaptureCallOrigin>={live:'live',miss:'live',hit:'cache',db_hit:'cache',negative_hit:'negative-cache',error:'error'}

/** Collapse one lane's newest capture run into one receipt per endpoint. Pure,
 * so the grouping is testable without a database. */
export function captureRunReceipts(lane:string,spec:CaptureLane,logs:any[],capturedAt:string|null,cadenceSeconds:number|null,now=Date.now()):SourceReceipt[] {
 const rows=(Array.isArray(logs)?logs:[]).filter(r=>r&&spec.callers.includes(String(r.caller))&&Number.isFinite(Date.parse(r.ts)))
 const newestByCaller=new Map<string,number>()
 for(const r of rows){const at=Date.parse(r.ts);if(at>(newestByCaller.get(r.caller)??-Infinity))newestByCaller.set(r.caller,at)}
 const run=rows.filter(r=>Date.parse(r.ts)>=(newestByCaller.get(r.caller)!-CAPTURE_RUN_WINDOW_MS))
 const byEndpoint=new Map<string,any[]>()
 for(const r of run){const key=`${r.caller}|${String(r.endpoint||'')}`;byEndpoint.set(key,[...(byEndpoint.get(key)||[]),r])}
 return [...byEndpoint.values()].map(calls=>{
  calls.sort((a,b)=>Date.parse(b.ts)-Date.parse(a.ts))
  const newest=calls[0],credits=calls.map(c=>finiteOrNull(c.credits_or_cu)).filter((v):v is number=>v!=null)
  const receipt=storedReceipt({provider:spec.provider,capability:lane,endpoint:newest.endpoint?String(newest.endpoint).slice(0,200):null,origin:'capture',keyMode:spec.keyMode,
   fetchedAt:newest.ts,capturedAt:capturedAt??newest.ts,refreshSeconds:cadenceSeconds,httpStatus:newest.status_code,
   // A cache hit reports no charge of its own. Only reported charges are summed,
   // and a run with none reports null rather than a zero nobody measured.
   creditCount:credits.length?credits.reduce((s,v)=>s+v,0):null},now)
  return {...receipt,captureCall:CACHE_STATUS[String(newest.cache_status)]??null,callCount:calls.length,calledAt:iso(newest.ts)}
 }).sort((a,b)=>String(a.endpoint).localeCompare(String(b.endpoint)))
}

async function newestCapture(db:any,spec:CaptureLane):Promise<string|null> {
 try{
  let q=db.from(spec.table).select(spec.column)
  for(const [k,v] of spec.filters||[])q=q.eq(k,v)
  const {data,error}=await q.order(spec.column,{ascending:false}).limit(1)
  if(error)return null
  const row=Array.isArray(data)?data[0]:data
  return iso(row?.[spec.column])
 }catch{return null}
}

/** `intel-capture` read view `capture_receipts`: the newest capture run for up to
 * eight named lanes. Unknown lane names are refused in the reason, never read. */
export async function readCaptureReceipts(db:any,params:{lanes?:unknown}={},now:Date|number=Date.now()) {
 const at=now instanceof Date?now.getTime():now
 const requested=(Array.isArray(params.lanes)?params.lanes:String(params.lanes??'').split(',')).map(v=>String(v).trim()).filter(Boolean)
 const lanes=[...new Set(requested)].filter(l=>Object.hasOwn(CAPTURE_RECEIPT_LANES,l)).slice(0,MAX_LANES)
 const unknown=requested.filter(l=>!Object.hasOwn(CAPTURE_RECEIPT_LANES,l))
 if(!lanes.length)return {view:'capture_receipts',lanes:[],asOf:null,coverage:{from:null,to:null,count:0},reason:unknown.length?'unsupported_lane':'no_lane_selected'}
 let policy:any[]=[],policyError=false
 try{const {data,error}=await db.from('provider_schedule_policy').select('provider,feature,cadence_seconds').eq('provider','coinmarketcap').limit(100);if(error)policyError=true;else policy=data||[]}catch{policyError=true}
 const cadenceOf=(feature:string)=>{const n=finiteOrNull(policy.find(r=>r?.feature===feature)?.cadence_seconds);return n!=null&&n>0?n:(FALLBACK_CADENCE[feature]??3600)}
 const out=await Promise.all(lanes.map(async lane=>{
  const spec=CAPTURE_RECEIPT_LANES[lane],cadence=Math.max(cadenceOf(spec.feature),spec.scheduleSeconds??0)
  const since=new Date(at-Math.min(MAX_LOOKBACK_MS,Math.max(2*3600_000,cadence*2000+CAPTURE_RUN_WINDOW_MS))).toISOString()
  const [capturedAt,logs]=await Promise.all([newestCapture(db,spec),(async()=>{
   try{
    const {data,error}=await db.from('provider_call_logs').select('caller,endpoint,cache_status,status_code,credits_or_cu,ts')
     .eq('provider',spec.provider).in('caller',spec.callers).gte('ts',since).order('ts',{ascending:false}).limit(LOG_LIMIT)
    return error?{rows:[],error:true}:{rows:Array.isArray(data)?data:[],error:false}
   }catch{return {rows:[],error:true}}
  })()])
  const receipts=captureRunReceipts(lane,spec,logs.rows,capturedAt,cadence,at)
  return {lane,provider:spec.provider,capturedAt,cadenceSeconds:cadence,freshness:capturedAt?(ageFreshness(capturedAt,cadence*CAPTURE_CADENCE_GRACE,at)??'cached'):'unavailable',
   receipts,reason:logs.error?'call_log_unavailable':receipts.length?null:'no_recent_capture_calls'}
 }))
 const stamps=out.map(l=>l.capturedAt).filter((v):v is string=>!!v).sort()
 return {view:'capture_receipts',lanes:out,asOf:stamps.at(-1)??null,coverage:{from:stamps[0]??null,to:stamps.at(-1)??null,count:out.reduce((s,l)=>s+l.receipts.length,0)},
  reason:policyError?'policy_unavailable':unknown.length?'unsupported_lane':null}
}
