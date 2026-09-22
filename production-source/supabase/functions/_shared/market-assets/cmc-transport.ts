import { logProviderCall } from '../provider-budget.ts'
import type { MarketAssetsContext } from './types.ts'
import { CMC_CAPABILITIES, CMC_DEX_SCHEMA_VALIDATED, CMC_EMPTY_DATA_CAPABILITIES, CMC_FEATURE_CAPS, cmcParams, cmcObservedAt, cmcRequestBody, estimateCmcCredits, planAllows } from './cmc-capabilities.ts'
import { normalizeCmcInvestigation } from '../intel/investigation-normalize.ts'
import {retainMarketSourceVersions} from '../intel/market-source-versions.ts'
import {readBoundedText,RequestBodyError} from '../intel/bounded-request.ts'
import {requestGroupedQuotes,quoteRefreshSeconds} from './cmc-quote-groups.ts'
import {loadCmcOperatingSettings,cmcPolicyEnvironment,type CmcOperatingSettings} from './cmc-operating-settings.ts'
import {validateCmcDexResponse} from './cmc-dex.ts'
import {cmcDemandPolicy,connectedDemandEnabled} from './cmc-demand-policy.ts'
export {loadCmcOperatingSettings} from './cmc-operating-settings.ts'

const BASE='https://pro-api.coinmarketcap.com'
function env(name:string):string|undefined { try { return (globalThis as any).Deno?.env?.get(name) ?? (globalThis as any).process?.env?.[name] } catch { return undefined } }
export const cmcApiKey=()=>env('COINMARKETCAP_API_KEY') || env('CMC_API_KEY')
const setting=(name:keyof CmcOperatingSettings,settings:CmcOperatingSettings={})=>env(name)??settings[name]
const enabled=(settings:CmcOperatingSettings)=>!['0','false','off'].includes((setting('CMC_ENABLED',settings)||'true').toLowerCase())
export function cmcPlan(now=Date.now(),settings:CmcOperatingSettings={}):string {
  const expires=Date.parse(setting('CMC_HACKATHON_EXPIRES_AT',settings)||'2026-09-30T23:59:00Z')
  const promo=setting('CMC_ACCESS_PROFILE',settings)==='hackathon' && Number.isFinite(expires) && now<expires
  // Explicit verified profile, never infer a tier from a key or credit balance.
  return promo ? setting('CMC_VERIFIED_HACKATHON_PLAN',settings)||'basic' : setting('CMC_VERIFIED_BASELINE_PLAN',settings)||'basic'
}
export function cmcCreditCeiling(settings:CmcOperatingSettings={}):number {
  const credits:Record<string,number>={basic:15000,builder:150000,startup:450000,growth:2000000,professional:5000000}
  const profileCap=(credits[cmcPlan(Date.now(),settings)]||15000)*0.8
  const caps=[env('CMC_MONTHLY_CREDIT_CEILING'),settings.CMC_MONTHLY_CREDIT_CEILING].filter(v=>v!=null&&Number.isFinite(Number(v))).map(v=>Math.max(0,Number(v)))
  return Math.min(profileCap,...caps)
}
/** Everything the provider and the shared cache actually reported about ONE read,
 * carried on the response itself. provider_call_logs, provider_quota_budgets and
 * market_data_response_cache are all service-role only, so a receipt that does not
 * ride in the response body cannot be shown to a reader at all.
 *
 * creditCount is the provider's own status.credit_count and is null whenever the
 * response did not report one — including every cache hit, because the cache row
 * does not retain the originating charge. estimateCmcCredits is a FLOOR used to
 * reserve budget, never the amount billed (see cmc-capabilities.ts), so it must
 * never be substituted here. A reported 0 is a real charge of zero and stays 0.
 *
 * keyMode is always 'keyed' today. The field exists so a later keyless lane can
 * set it; no keyless code path is or may become reachable from this product. */
export interface CmcReceipt {
  capability:string; endpoint:string; parameters:Record<string,string>
  httpStatus:number|null; creditCount:number|null; elapsedMs:number|null
  origin:'live'|'cache'|'negative-cache'; keyMode:'keyed'|'keyless'
  cacheAgeSeconds:number|null; ttlSeconds:number|null; staleUntil:string|null
  fetchedAt:string|null; reservation:string|null
}
export interface CmcResult<T=any> {
  // 'fresh' means a live 200 answered THIS read. 'cached' means the shared snapshot
  // answered it from inside its TTL: a success, and a different fact from 'fresh',
  // because no call was made and the figure is exactly as old as its receipt says.
  payload:T|null; state:'fresh'|'cached'|'stale'|'unavailable'|'unsupported'|'refreshing'; reason:string|null
  provenance:{provider:'coinmarketcap';observedAt:string|null;fetchedAt:string|null;expiresAt:string|null;sourceUrl:string}
  receipt:CmcReceipt|null
}
function empty(name:string,reason:string,state:CmcResult['state']='unavailable',receipt:CmcReceipt|null=null):CmcResult {
  return {payload:null,state,reason,receipt,provenance:{provider:'coinmarketcap',observedAt:null,fetchedAt:null,expiresAt:null,sourceUrl:`https://coinmarketcap.com/api/documentation/pro-api-reference/${CMC_CAPABILITIES[name]?.feature==='rwa'?'real-world-assets':'endpoint-overview'}`}}
}
async function hash(value:string):Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(v=>v.toString(16).padStart(2,'0')).join('') }
const inflight=new Map<string,Promise<CmcResult>>()
async function readCache(db:any,key:string,name:string,params:Record<string,string>={},ttlSeconds:number|null=null):Promise<CmcResult|null> {
  try {
    const {data,error}=await db.from('market_data_response_cache').select('response_json,expires_at,stale_until,observed_at,fetched_at,status_code,error_kind,negative_cache').eq('provider','coinmarketcap').eq('cache_key',key).maybeSingle()
    if(error) return empty(name,'cache_unavailable')
    if(!data) return null
    const fetched=Date.parse(data.fetched_at),spec=CMC_CAPABILITIES[name]
    // The cached row carries the ORIGINATING call's HTTP status and its clocks, so
    // a figure served from cache can still say what answered it and how old it is.
    // The originating credit charge is NOT retained here — only provider_call_logs
    // holds it, and that table is service-role only — so a cache hit reports no
    // credit rather than inventing or estimating one. Read at call time so the
    // shorten-only policy update below is reflected.
    const receipt=(origin:'cache'|'negative-cache'):CmcReceipt=>({capability:name,endpoint:spec?.path??'',parameters:params,
      httpStatus:data.status_code==null||!Number.isFinite(Number(data.status_code))?null:Number(data.status_code),creditCount:null,elapsedMs:null,
      origin,keyMode:'keyed',cacheAgeSeconds:Number.isFinite(fetched)?Math.max(0,Math.round((Date.now()-fetched)/1000)):null,
      ttlSeconds:ttlSeconds??spec?.ttl??null,staleUntil:data.stale_until??null,fetchedAt:data.fetched_at||null,reservation:null})
    if(data.negative_cache && Date.parse(data.expires_at)>Date.now()) return empty(name,data.error_kind||'provider_unavailable','unavailable',receipt('negative-cache'))
    // A deployed shorter policy also applies to older cache rows. Shorten only,
    // with compare-and-set guards so a concurrent refresh cannot be overwritten.
    if(data.response_json!=null&&Number.isFinite(fetched)&&spec){
      const previousExpiry=data.expires_at,previousStale=data.stale_until||previousExpiry
      const expires=new Date(Math.min(Date.parse(previousExpiry),fetched+spec.ttl*1000)).toISOString()
      const stale=new Date(Math.min(Date.parse(previousStale),fetched+spec.stale*1000)).toISOString()
      if(Date.parse(expires)<Date.parse(previousExpiry)||Date.parse(stale)<Date.parse(previousStale)){
        const {error:policyError}=await db.from('market_data_response_cache').update({expires_at:expires,stale_until:stale}).eq('provider','coinmarketcap').eq('cache_key',key).eq('fetched_at',data.fetched_at).eq('expires_at',previousExpiry)
        if(policyError)return {...empty(name,'accounting_unavailable'),state:'unavailable'}
        data.expires_at=expires;data.stale_until=stale
      }
    }
    if(data.response_json==null || Date.parse(data.stale_until||data.expires_at)<=Date.now()) return null
    // Inside its TTL this is 'cached', never 'fresh': nothing was asked of the
    // provider on this read, and the receipt states the age that makes that safe.
    return { payload:data.response_json,state:Date.parse(data.expires_at)>Date.now()?'cached':'stale',reason:null,receipt:receipt('cache'),
      provenance:{provider:'coinmarketcap',observedAt:cmcObservedAt(data.response_json,name),fetchedAt:data.fetched_at||null,expiresAt:data.expires_at,sourceUrl:`https://coinmarketcap.com/api/documentation/pro-api-reference/endpoint-overview`} }
  } catch { return empty(name,'cache_unavailable') }
}
async function rpc(db:any,name:string,params:Record<string,unknown>):Promise<any> {
  const {data,error}=await db.rpc(name,params); if(error) throw new Error('accounting_unavailable'); return data
}
async function syncAccount(db:any,key:string,fingerprint:string):Promise<void> {
  const claim=await rpc(db,'cmc_account_sync_claim',{p_fingerprint:fingerprint})
  if(!claim?.allowed) return
  const response=await fetch(`${BASE}/v1/key/info`,{headers:{'X-CMC_PRO_API_KEY':key,Accept:'application/json'},signal:AbortSignal.timeout(6000),redirect:'error'})
  if(!response.ok) throw new Error('account_unavailable')
  const body=await response.json(), plan=body?.data?.plan, usage=body?.data?.usage?.current_month
  if(!plan || !usage || !Number.isFinite(Number(usage.credits_used))) throw new Error('account_unavailable')
  const ok=await rpc(db,'cmc_account_sync',{p_fingerprint:fingerprint,p_limit:Number(plan.credit_limit_monthly),p_used:Number(usage.credits_used),p_reset_at:plan.credit_limit_monthly_reset_timestamp,p_rpm:Number(plan.rate_limit_minute)})
  if(ok!==true) throw new Error('account_unavailable')
  // The sync above keeps only the NEWEST figures, so nothing in the stack can
  // see how fast the balance is falling. One advisory append beside the read
  // that already happened gives the cadence calibrator successive observations
  // to take a delta from (see _shared/intel/budget-calibration.ts). No second
  // provider call, and a failure is swallowed on purpose: an account sync must
  // never fail because a measurement could not be recorded.
  try { await db.rpc('cmc_account_observe',{p_fingerprint:fingerprint,p_limit:Number(plan.credit_limit_monthly),p_used:Number(usage.credits_used),p_reset_at:plan.credit_limit_monthly_reset_timestamp}) } catch { /* cadence stays the reviewed one */ }
}
export async function reserveCmcStream(db:any,maxMessages:number) {
  const settings=await loadCmcOperatingSettings(db)
  if(env('CMC_LIVE_ENABLED')!=='true'||!planAllows(cmcPlan(Date.now(),settings),'startup'))return {allowed:false,reason:'streaming_not_enabled'}
  if(!Number.isInteger(maxMessages)||maxMessages<1||maxMessages>200)return {allowed:false,reason:'invalid_stream_ceiling'}
  const key=cmcApiKey();if(!key)return {allowed:false,reason:'credential_unavailable'}
  const fingerprint=(await hash(key)).slice(0,24)
  await syncAccount(db,key,fingerprint)
  // One shared connection lease across worker replicas. The window is shorter
  // than the existing 30-second lease and uses the same account reservation.
  return rpc(db,'cmc_request_reserve',{p_fingerprint:fingerprint,p_cache_key:`cmc:live-focus:${fingerprint}`,p_endpoint:'wss:/v1',p_feature:'live_focus',
    p_estimated:(maxMessages+5)*0.025,p_cap:cmcCreditCeiling(settings),p_feature_cap:Math.min(10800,cmcCreditCeiling(settings)*0.05)})
}
/** How long a refusal is remembered without asking again.
 *
 * A transient failure is re-asked a minute later. An ENTITLEMENT refusal is not
 * transient: the plan does not include this request, and asking again every hour
 * spends a reservation on an answer already given (the meme lane did exactly that
 * 48 times in two days). The negative cache is keyed by the exact request params,
 * so this backoff holds only the request that was refused: a corrected request
 * hashes to a different key and is tried at the very next run, with no wait. */
const NEGATIVE_TTL_MS=60_000,ENTITLEMENT_TTL_MS=6*3_600_000
function errorKind(status:number,code:unknown):string {
  if(status===401) return 'credential_unavailable'
  if(status===403 || Number(code)===1006) return 'insufficient_entitlement'
  if(status===429) return [1009,1010].includes(Number(code))?'quota_exhausted':'rate_limited'
  if(status===400) return 'provider_request_rejected'
  return 'provider_unavailable'
}

/** The sole CMC transport: fixed host/path, durable cache, distributed lease,
 * reservation before fetch and exact/ conservative reconciliation after fetch.
 * No retries: each later authorized refresh must obtain its own reservation. */
export async function requestCmc<T=any>(name:string,input:Record<string,unknown>={},ctx?:MarketAssetsContext):Promise<CmcResult<T>> {
  if(name==='quotes'&&input.id!=null)return await requestGroupedQuotes(input,ctx,requestCmcExact) as CmcResult<T>
  return requestCmcExact<T>(name,input,ctx)
}
async function requestCmcExact<T=any>(name:string,input:Record<string,unknown>={},ctx?:MarketAssetsContext):Promise<CmcResult<T>> {
  const spec=CMC_CAPABILITIES[name]
  if(!spec) return empty(name,'unsupported_capability','unsupported') as CmcResult<T>
  const params=cmcParams(name,input)
  const settings=await loadCmcOperatingSettings(ctx?.supabase),plan=cmcPlan(Date.now(),settings)
  if(!planAllows(plan,spec.tier)) return empty(name,'insufficient_entitlement','unsupported') as CmcResult<T>
  const key=cmcApiKey(),db=ctx?.supabase
  if(!key) return empty(name,'credential_unavailable') as CmcResult<T>
  if(!db?.rpc) return empty(name,'accounting_unavailable') as CmcResult<T>
  const fingerprint=(await hash(key)).slice(0,24)
  const cacheKey=`cmc:v3:${plan}:${fingerprint}:${name}:${await hash(JSON.stringify(params))}`
  // The effective TTL for this exact request. Hoisted from the refresh closure so
  // a cache hit can report the same ceiling its age is measured against; the hot
  // focus batch refreshes faster than the registry default (see cmc-quote-groups).
  const ttl=name==='quotes'?quoteRefreshSeconds(params):spec.ttl
  const connected=connectedDemandEnabled(settings,env)
  if(ctx?.noDemand!==true && (ctx?.kind==='request'||(connected&&ctx?.selectedDemand===true)) && ctx.orgId && ctx.userId) {
    // Authenticated foreground demand is the worker's only refresh input. A
    // background refresh never extends demand or creates an always-on polling loop.
    //
    // ctx.noDemand opts a read OUT of this branch entirely, so no cache row is
    // created, no demanded_at is written and no demand_org_id/demand_user_id is
    // recorded for it. That is the whole point for the free real-world-asset
    // lane: it may spend from its own capped daily budget on the read in front
    // of it, and it may not leave an instruction that spends again later.
    try {
      await db.from('market_data_response_cache').upsert({provider:'coinmarketcap',cache_key:cacheKey,endpoint:spec.path,expires_at:new Date(0).toISOString()}, {onConflict:'provider,cache_key',ignoreDuplicates:true})
      await db.from('market_data_response_cache').update({capability:name,request_params:params,access_profile:plan,demanded_at:cmcDemandPolicy(name,params,plan,connected)?new Date().toISOString():null,demand_org_id:ctx.orgId,demand_user_id:ctx.userId}).eq('provider','coinmarketcap').eq('cache_key',cacheKey)
    } catch { /* reserve still fails closed if its durable records are unavailable */ }
  }
  const cached=await readCache(db,cacheKey,name,params,ttl)
  if(cached && cached.state!=='stale') {
    await logProviderCall(db,{provider:'coinmarketcap',dataType:spec.feature,endpoint:spec.path,cacheStatus:cached.payload?'hit':'negative_hit',calls:0,caller:ctx?.caller})
    return cached as CmcResult<T>
  }
  if(!enabled(settings) || ctx?.kind==='render' || (ctx?._calls??0)>=(ctx?.maxCalls??4)) return (cached??empty(name,!enabled(settings)?'provider_paused':'refresh_required')) as CmcResult<T>
  const refresh=()=>{
    const existing=inflight.get(cacheKey);if(existing)return existing
    const promise=(async()=>{
      let reservation:string|null=null,actual:number|null=null,status=0,reason:string|null=null
      const started=Date.now()
      // Built at return time so it closes over the reconciled credit_count, the
      // HTTP status and the reservation this call actually used. Never called
      // unless an HTTP request was really issued, so origin:'live' stays true.
      const liveReceipt=(fetchedAt:string|null,staleUntil:string|null):CmcReceipt=>({capability:name,endpoint:spec.path,parameters:params,
        httpStatus:status||null,creditCount:actual,elapsedMs:Date.now()-started,origin:'live',keyMode:'keyed',
        cacheAgeSeconds:fetchedAt?0:null,ttlSeconds:ttl,staleUntil,fetchedAt,reservation})
      try {
        await syncAccount(db,key,fingerprint)
        const configuredCap=cmcCreditCeiling(settings)
        const claim=await rpc(db,'cmc_request_reserve',{p_fingerprint:fingerprint,p_cache_key:cacheKey,p_endpoint:spec.path,p_feature:spec.feature,
          p_estimated:estimateCmcCredits(name,params),p_cap:configuredCap,p_feature_cap:CMC_FEATURE_CAPS[spec.feature]*configuredCap/12000})
        if(!claim?.allowed) {
          if(claim?.reason==='cache_ready') return await readCache(db,cacheKey,name,params,ttl)??empty(name,'refreshing','refreshing')
          // A second Edge isolate can arrive while the first fills this shared
          // snapshot. Wait briefly on the cache, never issue another paid call.
          if(claim?.reason==='refreshing'&&(!cached||ctx?.waitForFresh)){
            for(let attempt=0;attempt<4;attempt++){
              await new Promise(resolve=>setTimeout(resolve,150*(attempt+1)))
              const ready=await readCache(db,cacheKey,name,params,ttl)
              // The other isolate's live call lands in the shared cache, so what
              // this waiter sees is 'cached' — that IS the fresh snapshot arriving.
              if(ready?.state==='cached')return ready
            }
          }
          return cached ? {...cached,reason:claim?.reason||'accounting_unavailable'} : empty(name,claim?.reason||'accounting_unavailable',claim?.reason==='refreshing'?'refreshing':'unavailable')
        }
        reservation=claim.reservation_id
        if(ctx)ctx._calls=(ctx._calls??0)+1
        const query=new URLSearchParams(params)
          // Maps, block statistics and price-conversion either reject convert or
          // carry the caller's own reviewed conversion target; never overwrite it.
          if(!name.startsWith('dex')&&!['map','metadata','exchangeInfo','exchangeAssets','exchangeMap','fiatMap','blockchainStats','priceConversion','categories','rwaMap','rwaInfo','issuers','issuer','fearGreed','fearGreedHistory','altcoinSeason','altcoinSeasonHistory','cmc100','cmc20','cmc100History','cmc20History','content','community'].includes(name)) query.set('convert','USD')
        // Only the reviewed registry can select POST. Canonical scalar params
        // are shared-cache keys; never accept arbitrary URLs or request bodies.
        const post=spec.method==='POST'
        const res=await fetch(`${BASE}${spec.path}${post?'':`?${query}`}`,{method:post?'POST':'GET',headers:{'X-CMC_PRO_API_KEY':key,Accept:'application/json',...(post?{'Content-Type':'application/json'}:{})},
          ...(post?{body:JSON.stringify(cmcRequestBody(name,params))}:{}),signal:AbortSignal.timeout(8000),redirect:'error'})
        status=res.status
        let raw:string
        try{raw=await readBoundedText(res,2_000_000)}catch(error){throw new Error(error instanceof RequestBodyError&&error.status===413?'response_too_large':'malformed_response')}
        // A REFUSAL does not have to be JSON. The provider's documented error
        // envelope is, but a gateway in front of it can answer an HTML or empty
        // body, and parsing that first threw away the HTTP status: every
        // /v1/dex/meme/list 403 since 2026-09-15 13:37 UTC was recorded as
        // `provider_unavailable` instead of `insufficient_entitlement` because
        // the parse failed before `errorKind` was ever reached. The status is the
        // fact here; the body is only evidence, so an unreadable body on a failed
        // response is logged (bounded, public text, the key travels in a header
        // and never appears in a response) and the status decides the reason.
        let body:any=null,unparsed=false
        try{body=JSON.parse(raw)}catch{
          if(res.ok)throw new Error('malformed_response')
          unparsed=true
          console.warn(JSON.stringify({cmc_error_body:{capability:name,endpoint:spec.path,status,sample:raw.slice(0,800)}}))
        }
        actual=body?.status?.credit_count!=null && Number.isFinite(Number(body.status.credit_count)) ? Math.max(0,Number(body.status.credit_count)):null
        if(unparsed || !res.ok || Number(body?.status?.error_code||0)!==0) {
          reason=errorKind(status,body?.status?.error_code)
          // Keep last-good data intact; endpoint failures have a bounded negative
          // TTL only when there is no usable snapshot.
          if(!cached) await db.from('market_data_response_cache').update({response_json:null,negative_cache:true,status_code:status,error_kind:reason,
            expires_at:new Date(Date.now()+(reason==='insufficient_entitlement'?ENTITLEMENT_TTL_MS:NEGATIVE_TTL_MS)).toISOString()}).eq('provider','coinmarketcap').eq('cache_key',cacheKey).eq('refresh_token',reservation)
          // A denial is still a call that was made and may have been charged, so it
          // keeps its own receipt. A retained snapshot keeps the cache receipt that
          // actually describes the figure being returned.
          return cached?{...cached,reason}:empty(name,reason,'unavailable',liveReceipt(null,null))
        }
        // No `data` at all is malformed for every capability EXCEPT the few whose
        // empty answer legitimately carries none (CMC_EMPTY_DATA_CAPABILITIES).
        // Those still go through their own response validator below; the body is
        // cached verbatim, so the stored snapshot says what the provider said.
        if(body?.data==null && !Array.isArray(body) && !CMC_EMPTY_DATA_CAPABILITIES.has(name)) throw new Error('malformed_response')
        // Only the reviewed DEX schemas have an exact-identity validator. A newly
        // registered path without one is not silently declared malformed.
        if(CMC_DEX_SCHEMA_VALIDATED.has(name)&&!validateCmcDexResponse(name,body,params)){
          // A rejection here is the only moment the real provider shape is still in
          // hand: nothing is cached, so the evidence is otherwise lost. Log a bounded
          // sample so the next capture is diagnosable from the function logs. A DEX
          // response body is public market data; the key travels in a request header
          // and never appears here.
          console.warn(JSON.stringify({cmc_malformed:name,sample:JSON.stringify(body).slice(0,800)}))
          throw new Error('malformed_response')
        }
        const fetchedAt=new Date().toISOString(),observedAt=cmcObservedAt(body,name),expiresAt=new Date(Date.now()+ttl*1000).toISOString()
        const staleUntil=new Date(Date.now()+spec.stale*1000).toISOString()
        const {error}=await db.from('market_data_response_cache').update({response_json:body,status_code:200,negative_cache:false,error_kind:null,
          fetched_at:fetchedAt,observed_at:observedAt,expires_at:expiresAt,stale_until:staleUntil,updated_at:fetchedAt,cache_status:'live'})
          .eq('provider','coinmarketcap').eq('cache_key',cacheKey).eq('refresh_token',reservation)
        if(error) throw new Error('cache_unavailable')
        // One shared refresh captures public facts for every viewer. Failure to
        // retain history must be visible to history reads, never fabricate it.
        try {
          const normalized=await normalizeCmcInvestigation(name,body,params,fetchedAt,expiresAt,staleUntil,cmcPolicyEnvironment(settings,env))
          if(normalized.rows.length){const retained=await db.rpc('intel_record_market_observations',{p_rows:normalized.rows});if(retained.error)throw new Error('retention_unavailable')}
          await retainMarketSourceVersions(db,normalized.sourceRows)
        } catch { console.warn('[cmc-history] observation retention unavailable',name) }
        return {payload:body,state:'fresh' as const,reason:null,receipt:liveReceipt(fetchedAt,staleUntil),provenance:{provider:'coinmarketcap' as const,observedAt,fetchedAt,expiresAt,sourceUrl:`https://coinmarketcap.com/api/documentation/pro-api-reference/endpoint-overview`}}
      } catch(err) {
        reason=err instanceof Error && ['accounting_unavailable','account_unavailable','malformed_response','cache_unavailable','response_too_large'].includes(err.message)?err.message:'provider_unavailable'
        // Only once an HTTP status exists did a call actually reach the provider;
        // failing before that (accounting, credentials) is not a 'live' read.
        return cached?{...cached,reason}:empty(name,reason,'unavailable',status?liveReceipt(null,null):null)
      } finally {
        if(reservation) {
          // Reconciliation failure leaves the reservation charged: never release
          // unknown spending merely because a worker died or the DB timed out.
          try { await rpc(db,'cmc_request_reconcile',{p_reservation:reservation,p_actual:actual,p_status:status,p_error_kind:reason}) } catch { /* durable reservation remains */ }
          await logProviderCall(db,{provider:'coinmarketcap',dataType:spec.feature,endpoint:spec.path,calls:1,creditsOrCu:actual,cacheStatus:status===200&&!reason?'live':'error',statusCode:status,latencyMs:Date.now()-started,caller:ctx?.caller,requestId:reservation,suppressionReason:reason})
        }
      }
    })().finally(()=>inflight.delete(cacheKey))
    inflight.set(cacheKey,promise);return promise
  }
  if(cached) {
    if(ctx?.waitForFresh)return await refresh() as CmcResult<T>
    const runtime=(globalThis as any).EdgeRuntime
    if(runtime?.waitUntil)runtime.waitUntil(refresh())
    else return await refresh() as CmcResult<T>
    return cached as CmcResult<T>
  }
  return await refresh() as CmcResult<T>
}

// The worker renews the exact stored cache identity, even when tomorrow's
// universe has different cohort membership. It does not expand groups again.
export const refreshCmcSnapshot=requestCmcExact
