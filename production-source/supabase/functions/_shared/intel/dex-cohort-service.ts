import {requestCmc} from '../market-assets/cmc-transport.ts'
import {cmcParams,cmcRows,CMC_CAPABILITIES,cmcUsable} from '../market-assets/cmc-capabilities.ts'
import {cmcDexRowIdentity,cmcDexInteger,isDexDiscovery,validateCmcDexResponse,CMC_DEX_NETWORKS} from '../market-assets/cmc-dex.ts'
import {cmcPolicyEnvironment,loadCmcOperatingSettings} from '../market-assets/cmc-operating-settings.ts'
import {cmcHistoryPolicy} from './investigation-normalize.ts'
import {marketSourceReference} from './market-source-reference.ts'
import {digest,stableJson,finite} from './investigation-evidence.ts'

const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)
async function read(query:any){const {data,error}=await query;if(error)throw Error('dex_cohort_storage_unavailable');return data}
const labels:Record<string,string>={dexTrending:'Trending contracts',dexNew:'New contracts',dexMeme:'Meme discovery',dexGainers:'Gainers and losers'}
/** The verified platform a cohort is ABOUT. `platformIds` is a request field on
 * every discovery capability, /v1/dex/meme/list included (see the registry entry
 * for why it is sent there again since 2026-09-17), so the pin comes from the
 * params the capability was asked with. A caller-supplied pin is still accepted
 * for a request that carries none, and it is applied to the answer only — for a
 * meme board the pin never decides identity, each row's own `pid` does. */
export function dexCohortPin(capability:string,params:Record<string,string>,pinnedPlatformId?:unknown):number{
 const pin=cmcDexInteger(params.platformIds??pinnedPlatformId)
 if(pin==null||!CMC_DEX_NETWORKS.some(n=>n.platformId===pin))throw Error('invalid_dex_cohort_platform')
 return pin
}
/**
 * Members of one discovery response, for ONE verified platform.
 *
 * CORRECTED 2026-09-15 for dexMeme. A leaderboard answer was pinned in the
 * request, so a row naming another platform is a MALFORMED answer and still
 * fails closed. A meme board was not pinned: it legitimately spans every chain
 * the provider indexes, so a row on another platform (or on a chain we do not
 * verify) is simply not ours — it is dropped and COUNTED, never repaired into an
 * identity and never attributed to the pinned chain. An empty result for the
 * pinned platform is likewise an honest empty, reported by the caller; only a
 * leaderboard, whose emptiness would mean the provider ignored its own filter,
 * still throws.
 */
export function dexCohortMembers(capability:string,payload:any,params:Record<string,string>,capturedAt:string,fetchedAt:string,pinnedPlatformId?:unknown){
 if(!isDexDiscovery(capability)||!validateCmcDexResponse(capability,payload,params))throw Error('invalid_dex_cohort_source')
 const pin=dexCohortPin(capability,params,pinnedPlatformId)
 const members=new Map<string,any>()
 let dropped=0
 for(const row of cmcRows(capability,payload,params).rows){
  const identity=cmcDexRowIdentity(row.canonicalKey,pin)
  if(!identity){
   if(capability!=='dexMeme')throw Error('invalid_dex_cohort_identity')
   dropped+=1;continue
  }
  const observed=row.quote?.last_updated,validTime=Number.isFinite(Date.parse(observed))&&Date.parse(observed)<=Date.parse(fetchedAt)
  const price=finite(row.p),cap=finite(row.mcap)
  const member={subject:identity.subject,name:String(row.name||row.symbol||identity.subject).slice(0,160),symbol:typeof row.symbol==='string'?row.symbol.slice(0,40):null,
   joinedAt:capturedAt,initialPrice:validTime&&price!=null&&price>=0?price:null,initialObservedAt:validTime?observed:null,
   // The discovery source does not give market-cap's own clock; never use it
   // as a dated weighting basis merely because price supplies a timestamp.
   initialMarketCapUsd:null,reportedMarketCapUsd:cap!=null&&cap>=0?cap:null,
   stages:row.discoveryStage?[row.discoveryStage]:[]}
  const previous=members.get(identity.subject)
  if(previous){
   if(previous.initialPrice!==member.initialPrice||previous.initialObservedAt!==member.initialObservedAt)throw Error('dex_cohort_conflicting_duplicate')
   previous.stages=[...new Set([...previous.stages,...member.stages])]
  }else members.set(identity.subject,member)
 }
 if(members.size>75||(!members.size&&capability!=='dexMeme'))throw Error('dex_cohort_empty_or_oversized')
 return {members:[...members.values()],dropped}
}
/** Capture exactly the response the user reviewed. This path never refreshes
 * a provider, invents a discovery date, or accepts browser-supplied members. */
export async function dexCohortService(db:any,input:any,actor:{userId:string;orgId:string},now=Date.now(),request=requestCmc){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['operation','cohortId','capability','parameters','payloadHash','retrievedAt','at'].includes(k)))throw Error('invalid_dex_cohort_request')
 const operation=input.operation??'read'
 if(!['capture','read'].includes(operation))throw Error('invalid_dex_cohort_request')
 if(operation==='read'&&(!uuid(input.cohortId)||['capability','parameters','payloadHash','retrievedAt'].some(k=>input[k]!=null)))throw Error('invalid_dex_cohort_request')
 const at=input.at==null?now:Number(input.at)
 if(!Number.isFinite(at)||at<0||at>now||operation==='capture'&&input.at!=null)throw Error('invalid_dex_cohort_time')
 let params:Record<string,string>={},key='',pin=0
 if(operation==='capture'){
  if(input.cohortId!=null||!isDexDiscovery(input.capability)||typeof input.payloadHash!=='string'||!/^[a-f0-9]{64}$/.test(input.payloadHash)||typeof input.retrievedAt!=='string'||!Number.isFinite(Date.parse(input.retrievedAt))||Date.parse(input.retrievedAt)>now)throw Error('invalid_dex_cohort_request')
  // `platformIds` travels with the request on every discovery capability, meme
  // boards included, so the cohort key and the cached snapshot it must match are
  // built from the same params the transport asked with. Two platforms reviewed
  // from the same board keep two cohorts rather than colliding on one.
  const requested={...(input.parameters||{})}
  params=cmcParams(input.capability,requested)
  pin=dexCohortPin(input.capability,params)
  key=`dex:${input.capability}:${await digest(stableJson({params:{...params,platformIds:String(pin)},payloadHash:input.payloadHash,retrievedAt:input.retrievedAt}))}`
 }
 const settings=await loadCmcOperatingSettings(db),env=cmcPolicyEnvironment(settings,key=>Deno.env.get(key),now)
 const policy=cmcHistoryPolicy(now,new Date(now).toISOString(),env)
 if(!policy.historical||Date.parse(policy.retainUntil)<=now)return {state:'unsupported',reason:'Retained discovery cohorts are unavailable under the current source policy.',cohort:null,quotes:null}
 let q=db.from('intel_market_cohorts').select('*').eq('kind','dex_discovery').gt('retain_until',new Date(now).toISOString())
 let cohort=await read((operation==='read'?q.eq('id',input.cohortId):q.eq('cohort_key',key)).maybeSingle())
 if(!cohort&&operation==='capture'){
  const source=await request(input.capability,params,{supabase:db,kind:'render',maxCalls:0,caller:'intel-dex-cohort-capture',...actor})
  // This read is deliberately cache-only (maxCalls 0), so the snapshot answering
  // from inside its TTL is the normal success here, not a reason to refuse.
  if(!cmcUsable(source.state)||!source.payload) return {state:source.state,reason:source.reason||'Refresh the discovery source before capturing its original membership.',cohort:null,quotes:null}
  const reference=await marketSourceReference(input.capability,params,source.payload,source.provenance)
  if(reference.payloadHash!==input.payloadHash||reference.retrievedAt!==input.retrievedAt)throw Error('dex_cohort_source_changed')
  const capturedAt=new Date(now).toISOString()
  const {members,dropped}=dexCohortMembers(input.capability,source.payload,params,capturedAt,reference.retrievedAt,pin)
  // An empty board for the pinned platform is an ANSWER, reported as one. It is
  // not a 503 and not a stored cohort of nothing; `droppedRows` says whether the
  // board was empty outright or only empty of this platform.
  if(!members.length)return {state:'empty',reason:'provider_reported_empty',cohort:null,quotes:null,droppedRows:dropped}
  const retention=cmcHistoryPolicy(Date.parse(reference.retrievedAt),source.provenance.expiresAt!,env)
  if(Date.parse(retention.retainUntil)<=now)throw Error('dex_cohort_source_expired')
  const network=CMC_DEX_NETWORKS.find(n=>n.platformId===pin)!
  await read(db.from('intel_market_cohorts').upsert({cohort_key:key,kind:'dex_discovery',name:`${labels[input.capability]} · ${network.label}`,provider:'coinmarketcap',source_ref:CMC_CAPABILITIES[input.capability].path,
   source_reference:reference,created_at:capturedAt,retain_until:retention.retainUntil,members},{onConflict:'cohort_key',ignoreDuplicates:true}))
  cohort=await read(db.from('intel_market_cohorts').select('*').eq('cohort_key',key).gt('retain_until',new Date(now).toISOString()).single())
 }
 if(!cohort)throw Error('dex_cohort_unavailable')
 if(Date.parse(cohort.created_at)>at)return {state:'not_yet_recorded',reason:'This cohort was first recorded after the selected knowledge time.',cohort,quotes:{state:'not_yet_recorded',rows:[]}}
 const rows=await read(db.rpc('intel_dex_cohort_quotes',{p_cohort:cohort.id,p_at:new Date(at).toISOString()}))
 return {state:'fresh',cohort,quotes:{state:'retained',rows:rows||[],reason:'Retained exact-contract prices only. Opening a cohort does not refresh its constituents.'}}
}
