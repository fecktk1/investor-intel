import {requestCmc} from '../market-assets/cmc-transport.ts'
import {cmcParams,cmcRows,CMC_CAPABILITIES} from '../market-assets/cmc-capabilities.ts'
import {cmcDexIdentity,isDexDiscovery,validateCmcDexResponse,CMC_DEX_NETWORKS} from '../market-assets/cmc-dex.ts'
import {cmcPolicyEnvironment,loadCmcOperatingSettings} from '../market-assets/cmc-operating-settings.ts'
import {cmcHistoryPolicy} from './investigation-normalize.ts'
import {marketSourceReference} from './market-source-reference.ts'
import {digest,stableJson,finite} from './investigation-evidence.ts'

const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)
async function read(query:any){const {data,error}=await query;if(error)throw Error('dex_cohort_storage_unavailable');return data}
const labels:Record<string,string>={dexTrending:'Trending contracts',dexNew:'New contracts',dexMeme:'Meme discovery',dexGainers:'Gainers and losers'}
export function dexCohortMembers(capability:string,payload:any,params:Record<string,string>,capturedAt:string,fetchedAt:string){
 if(!isDexDiscovery(capability)||!validateCmcDexResponse(capability,payload,params))throw Error('invalid_dex_cohort_source')
 const members=new Map<string,any>()
 for(const row of cmcRows(capability,payload).rows){
  const identity=cmcDexIdentity(row.canonicalKey)
  if(!identity||String(identity.platformId)!==params.platformIds)throw Error('invalid_dex_cohort_identity')
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
 if(!members.size||members.size>75)throw Error('dex_cohort_empty_or_oversized')
 return [...members.values()]
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
 let params:Record<string,string>={},key=''
 if(operation==='capture'){
  if(input.cohortId!=null||!isDexDiscovery(input.capability)||typeof input.payloadHash!=='string'||!/^[a-f0-9]{64}$/.test(input.payloadHash)||typeof input.retrievedAt!=='string'||!Number.isFinite(Date.parse(input.retrievedAt))||Date.parse(input.retrievedAt)>now)throw Error('invalid_dex_cohort_request')
  params=cmcParams(input.capability,input.parameters||{})
  key=`dex:${input.capability}:${await digest(stableJson({params,payloadHash:input.payloadHash,retrievedAt:input.retrievedAt}))}`
 }
 const settings=await loadCmcOperatingSettings(db),env=cmcPolicyEnvironment(settings,key=>Deno.env.get(key),now)
 const policy=cmcHistoryPolicy(now,new Date(now).toISOString(),env)
 if(!policy.historical||Date.parse(policy.retainUntil)<=now)return {state:'unsupported',reason:'Retained discovery cohorts are unavailable under the current source policy.',cohort:null,quotes:null}
 let q=db.from('intel_market_cohorts').select('*').eq('kind','dex_discovery').gt('retain_until',new Date(now).toISOString())
 let cohort=await read((operation==='read'?q.eq('id',input.cohortId):q.eq('cohort_key',key)).maybeSingle())
 if(!cohort&&operation==='capture'){
  const source=await request(input.capability,params,{supabase:db,kind:'render',maxCalls:0,caller:'intel-dex-cohort-capture',...actor})
  if(source.state!=='fresh'||!source.payload) return {state:source.state,reason:source.reason||'Refresh the discovery source before capturing its original membership.',cohort:null,quotes:null}
  const reference=await marketSourceReference(input.capability,params,source.payload,source.provenance)
  if(reference.payloadHash!==input.payloadHash||reference.retrievedAt!==input.retrievedAt)throw Error('dex_cohort_source_changed')
  const capturedAt=new Date(now).toISOString(),members=dexCohortMembers(input.capability,source.payload,params,capturedAt,reference.retrievedAt)
  const retention=cmcHistoryPolicy(Date.parse(reference.retrievedAt),source.provenance.expiresAt!,env)
  if(Date.parse(retention.retainUntil)<=now)throw Error('dex_cohort_source_expired')
  const network=CMC_DEX_NETWORKS.find(n=>String(n.platformId)===params.platformIds)!
  await read(db.from('intel_market_cohorts').upsert({cohort_key:key,kind:'dex_discovery',name:`${labels[input.capability]} · ${network.label}`,provider:'coinmarketcap',source_ref:CMC_CAPABILITIES[input.capability].path,
   source_reference:reference,created_at:capturedAt,retain_until:retention.retainUntil,members},{onConflict:'cohort_key',ignoreDuplicates:true}))
  cohort=await read(db.from('intel_market_cohorts').select('*').eq('cohort_key',key).gt('retain_until',new Date(now).toISOString()).single())
 }
 if(!cohort)throw Error('dex_cohort_unavailable')
 if(Date.parse(cohort.created_at)>at)return {state:'not_yet_recorded',reason:'This cohort was first recorded after the selected knowledge time.',cohort,quotes:{state:'not_yet_recorded',rows:[]}}
 const rows=await read(db.rpc('intel_dex_cohort_quotes',{p_cohort:cohort.id,p_at:new Date(at).toISOString()}))
 return {state:'fresh',cohort,quotes:{state:'retained',rows:rows||[],reason:'Retained exact-contract prices only. Opening a cohort does not refresh its constituents.'}}
}
