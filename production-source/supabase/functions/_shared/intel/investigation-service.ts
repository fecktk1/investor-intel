import {globalCohortPrices} from './global-cohort-prices.ts'
import {cmcPolicyEnvironment,cmcLiveActivation} from '../market-assets/cmc-operating-settings.ts'
import {captureStressScenario} from './stress-scenario-service.ts'
import {readInvestigationDepth} from './investigation-depth.ts'
import {recordIssuerReviews} from './rwa-issuer-evidence.ts'
import {readParticipation} from './participation-read.ts'
import {cmcDexIdentity,cmcDexParams} from '../market-assets/cmc-dex.ts'
import { requestCmc } from '../market-assets/cmc-transport.ts'
import { cmcPlan,loadCmcOperatingSettings } from '../market-assets/cmc-transport.ts'
import { planAllows } from '../market-assets/cmc-capabilities.ts'
import { cmcRows, cmcParams, CMC_CAPABILITIES } from '../market-assets/cmc-capabilities.ts'
import { cmcHistoryPolicy, cmcSubject, normalizeCmcInvestigation } from './investigation-normalize.ts'
import { finite, instant, makeResearchReceipt, type Observation } from './investigation-evidence.ts'
import { researchCmcId } from './research-identity.ts'
import {readConnectedAssetIdentity} from './connected-asset-identity.ts'
import {readAdoptionAttention} from './adoption-attention.ts'
import {retainMarketSourceVersions} from './market-source-versions.ts'
import {makeBenchmarkReceipt} from './benchmark-receipt.ts'
import {benchmarkRequestPlan} from './benchmark-comparison.ts'
import {dexCohortService} from './dex-cohort-service.ts'
import {liveFocusSubject,liveContractSubject,liveObservationSubject,liveTapeKind,LIVE_TAPE_METRICS} from '../market-assets/cmc-live-focus.ts'

export const INVESTIGATION_LENSES=['replay','ownership','fragility','attention','delta','stress','sector','coverage','sessions','counterargument','live','cohort','receipt','participation','liquidity','benchmark'] as const
export function investigationIdentity(value:unknown) {
  if(typeof value!=='string'||value.length>240)throw new Error('invalid_asset_identity')
  const rwa=/^rwa:coinmarketcap:([1-9][0-9]{0,11})$/.exec(value)
  const id=researchCmcId({canonicalKey:value})
  if(!id&&!rwa&&!/^(?:eip155:[1-9][0-9]*(?:\/(?:erc20:0x[a-fA-F0-9]{40}|native:[a-z0-9]+)|:0x[a-fA-F0-9]{40})|solana:(?:mainnet\/spl:)?[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(value))throw new Error('unsupported_asset_identity')
  return {requested:value,subject:id?cmcSubject(id)!:value,cryptoId:id,rwaId:rwa?.[1]??null}
}
export function investigationRange(input:any,now=Date.now()) {
  const to=input.to==null?now:instant(input.to),from=input.from==null?now-30*86400000:instant(input.from)
  if(to==null||from==null||from<0||to>now+1000||from>to||to-from>90*86400000)throw new Error('invalid_time_window')
  const limit=input.limit==null?100:Number(input.limit)
  if(!Number.isInteger(limit)||limit<1||limit>500)throw new Error('invalid_page_limit')
  let cursor:null|{time:string;id:string}=null
  if(input.cursor!=null){cursor=input.cursor;if(!cursor||instant(cursor.time)==null||typeof cursor.id!=='string'||!/^(?:cmc|issuer|depth):[a-f0-9]{64}$/.test(cursor.id))throw new Error('invalid_history_cursor');cursor={time:new Date(instant(cursor.time)!).toISOString(),id:cursor.id}}
  return {from,to,limit,cursor}
}
async function result(query:any) { const {data,error}=await query;if(error)throw new Error('investigation_storage_unavailable');return data }
export async function readInvestigationHistory(db:any,subjects:string[],input:any,now=Date.now(),allowCmcHistory=false) {
  const range=investigationRange(input,now)
  if(!subjects.length||subjects.length>100)throw new Error('invalid_history_subjects')
  const metrics=input.metrics
  if(metrics!=null&&(!Array.isArray(metrics)||!metrics.length||metrics.length>2||metrics.some((m:any)=>!['liquidity_event_usd','swap_event_usd'].includes(m))))throw new Error('invalid_history_metrics')
  let q=db.from('intel_market_observations').select('id,observation,observed_at').in('subject',subjects)
    .gte('observed_at',new Date(range.from).toISOString()).lte('observed_at',new Date(range.to).toISOString()).gt('retain_until',new Date(now).toISOString())
    .order('observed_at',{ascending:false}).order('id',{ascending:false}).limit(range.limit+1)
  if(metrics)q=q.in('metric',metrics)
  if(range.cursor)q=q.or(`observed_at.lt.${range.cursor.time},and(observed_at.eq.${range.cursor.time},id.lt.${range.cursor.id})`)
  if(!allowCmcHistory)q=q.neq('provider','coinmarketcap')
  const rows=await result(q)??[],visible=rows.slice(0,range.limit),last=visible.at(-1)
  return {observations:visible.map((row:any)=>row.observation as Observation),hasMore:rows.length>range.limit,
    nextCursor:rows.length>range.limit&&last?{time:last.observed_at,id:last.id}:null,range,subjects}
}
async function snapshot(db:any,name:string,params:Record<string,unknown>,actor:{userId:string;orgId:string}) {
  const response=await requestCmc(name,params,{supabase:db,kind:'request',maxCalls:1,waitForFresh:true,caller:'intel-investigate',...actor})
  const sourceEnv=cmcPolicyEnvironment(await loadCmcOperatingSettings(db),key=>Deno.env.get(key))
  const normalized=response.payload&&response.provenance.fetchedAt&&response.provenance.expiresAt?
    await normalizeCmcInvestigation(name,response.payload,cmcParams(name,params),response.provenance.fetchedAt,response.provenance.expiresAt,new Date(Date.parse(response.provenance.fetchedAt)+CMC_CAPABILITIES[name].stale*1000).toISOString(),sourceEnv):null
  if(normalized)await retainMarketSourceVersions(db,normalized.sourceRows)
  return {capability:name,state:response.state,reason:response.reason,provenance:response.provenance,
    data:response.payload?cmcRows(name,response.payload):{rows:[],total:null,hasMore:false},observations:normalized?.observations??[],retentionRows:normalized?.rows??[]}
}
export async function retainCurrentObservations(db:any,records:any[],now=Date.now()) {
  // Older deployed producers may have written batch-dependent IDs. Repair only
  // missing normalized records from the verified shared snapshot, preserving its
  // actual fetch clock and original retention limit. No provider request is made.
  const rows=[...new Map(records.filter(r=>Date.parse(r.retainUntil)>now).map(r=>[r.id,r])).values()]
  if(!rows.length)return
  if(rows.length>2000)throw new Error('invalid_observation_batch')
  // The RPC inserts absent IDs atomically and never updates retained evidence.
  // Posting the bounded batch avoids an ID-list GET that can exceed URL limits.
  await result(db.rpc('intel_record_market_observations',{p_rows:rows}))
}
const uuid=(value:unknown)=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
export async function readReceiptObservations(db:any,ids:string[],now:number) {
  if(ids.length>500)throw new Error('invalid_receipt_request')
  const unique=[...new Set(ids)],records:any[]=[]
  // Hash IDs are long. Keep each URL below proxy limits; no unbounded table read.
  for(let start=0;start<unique.length;start+=50)records.push(...await result(db.from('intel_market_observations').select('observation').in('id',unique.slice(start,start+50)).gt('retain_until',new Date(now).toISOString()).limit(50)))
  return records
}
/** Both lease grammars, plus the canonical contract key a market page already
 * holds (`eip155:8453:0x…`, `solana:<mint>`) and the CMC identities
 * `investigationIdentity` resolves. Anything else is not a tape subject. */
export function liveTapeSubject(value:unknown) {
  const direct=liveFocusSubject(value)??liveContractSubject(value)
  if(direct)return direct
  try{const identity=investigationIdentity(value);return identity.cryptoId?liveFocusSubject(identity.subject):liveContractSubject(identity.requested)}catch{return null}
}
/** The on-chain tape is a second, separate switch. Until the owner sets it
 * after the worker release gate no contract lease is created, so the released
 * worker's plan keeps holding market identities only. */
export const liveOnchainEnabled=()=>Deno.env.get('CMC_LIVE_ONCHAIN_ENABLED')==='true'
/** One subject's recent public tape plus this org's lease state. The
 * service-role read is scoped to the caller's org, so a lease never discloses
 * another org's viewers; bounded to one hour and 500 rows. */
export async function readLiveTape(db:any,actor:{userId:string;orgId:string},input:any,now:number) {
  const focus=liveTapeSubject(input.subject)
  if(!focus)throw new Error('invalid_live_tape')
  const since=input.since==null?now-300000:instant(input.since)
  if(since==null||since>now+1000||now-since>3600000)throw new Error('invalid_live_tape_since')
  // The lease speaks `contract:…`; the evidence lives under the chain subject
  // the REST DEX rows already use, so one contract has one tape, not two.
  const observationSubject=liveObservationSubject(focus.subject)!
  const rows=await result(db.from('intel_market_observations').select('observation,observed_at,id').eq('subject',observationSubject).eq('provider','coinmarketcap')
    .in('metric',[...LIVE_TAPE_METRICS]).gt('observed_at',new Date(since).toISOString()).gt('retain_until',new Date(now).toISOString())
    .order('observed_at',{ascending:false}).order('id',{ascending:false}).limit(500))??[]
  const leases=await result(db.from('intel_live_focus_demands').select('user_id,expires_at').eq('org_id',actor.orgId).eq('subject',focus.subject)
    .gt('expires_at',new Date(now).toISOString()).limit(100))??[]
  const lease={active:leases.length>0,expiresAt:leases.map((r:any)=>r.expires_at).sort().at(-1)??null,viewers:new Set(leases.map((r:any)=>r.user_id)).size}
  const events=rows.map((row:any)=>{const o=row.observation as Observation
    return {kind:liveTapeKind(o.metric),metric:o.metric,value:o.value,unit:o.unit,observedAt:o.observedAt,metadata:o.metadata??{}}})
  // A quiet contract with a live lease is a quiet market, not a missing lease.
  return {subject:focus.subject,observationSubject,events,asOf:new Date(now).toISOString(),lease,reason:!lease.active&&!events.length?'no_live_lease':null}
}
export async function investigationService(db:any,actor:{userId:string;orgId:string},input:any,now=Date.now()) {
  const operation=input.operation??'load'
  if(operation==='tape')return readLiveTape(db,actor,input,now)
  const identity=investigationIdentity(input.subject),lens=String(input.lens??'replay')
  if(!INVESTIGATION_LENSES.includes(lens as any))throw new Error('invalid_investigation_lens')
  const sourceEnv=cmcPolicyEnvironment(await loadCmcOperatingSettings(db),key=>Deno.env.get(key),now)
  const historyPolicy=cmcHistoryPolicy(now,new Date(now+21600000).toISOString(),sourceEnv)
  if(operation==='live') {
    const contract=identity.cryptoId?null:liveContractSubject(identity.requested)
    const focusSubject=identity.cryptoId?identity.subject:contract?.subject
    if(!focusSubject||typeof input.enabled!=='boolean'||(input.viewId!=null&&!uuid(input.viewId)))throw new Error('invalid_live_focus')
    const settings=await loadCmcOperatingSettings(db)
    const enabled=cmcLiveActivation(settings,key=>Deno.env.get(key))&&planAllows(cmcPlan(now,settings),'startup')&&(!contract||liveOnchainEnabled())
    if(input.enabled&&!enabled)return {state:'polling',reason:'Shared live focus is not enabled for the current operating profile.',observation:null}
    const expiresAt=await result(db.rpc('intel_live_focus_touch',{p_org:actor.orgId,p_user:actor.userId,p_subject:focusSubject,p_enabled:input.enabled,...(input.viewId!=null?{p_view:input.viewId}:{})}))
    if(!input.enabled)return {state:'paused',reason:null,observation:null,expiresAt}
    const query=db.from('intel_market_observations').select('observation').eq('subject',liveObservationSubject(focusSubject)!)
    const latest=await result((contract?query.in('metric',[...LIVE_TAPE_METRICS]):query.eq('metric','price').eq('observation->>sourceRef','coinmarketcap:market@crypto_latest_price'))
      .gt('retain_until',new Date(now).toISOString()).order('observed_at',{ascending:false}).limit(1))
    const observation=latest?.[0]?.observation??null,fresh=observation&&Date.parse(observation.expiresAt)>now
    return {state:!input.enabled?'paused':fresh?'live':'polling',reason:input.enabled&&!fresh?'Waiting for a fresh stream observation; cached polling remains available.':null,observation:fresh?observation:null,expiresAt}
  }
  if(operation==='history'){
    if(input.subjects!=null&&(!Array.isArray(input.subjects)||input.subjects.length>100))throw new Error('invalid_history_subjects')
    const subjects=input.subjects?.map((s:unknown)=>typeof s==='string'&&/^index:coinmarketcap:(100|20)$/.test(s)?s:investigationIdentity(s).subject)??[identity.subject]
    return readInvestigationHistory(db,subjects,input,now,historyPolicy.historical)
  }
  if(operation==='seen') {
    await result(db.from('intel_investigation_visits').upsert({org_id:actor.orgId,user_id:actor.userId,subject:identity.subject,lens,seen_at:new Date(now).toISOString()}))
    return {seenAt:new Date(now).toISOString()}
  }
  if(operation==='receipt') {
    if(lens==='benchmark'&&input.scenario!=null)throw Error('invalid_benchmark_receipt')
    if(!uuid(input.operationId)||!Array.isArray(input.observationIds)||input.observationIds.length>500||input.observationIds.some((id:any)=>typeof id!=='string'||!/^(?:cmc|issuer|depth):[a-f0-9]{64}$/.test(id)))throw new Error('invalid_receipt_request')
    const readSaved=async(id:string)=>{
      const saved=await result(db.from('saved_research').select('investigation_receipt').eq('id',id).eq('org_id',actor.orgId).eq('user_id',actor.userId).eq('private_owner_id',actor.userId).maybeSingle())
      if(!saved?.investigation_receipt)throw new Error('saved_receipt_unavailable')
      return {id,receipt:saved.investigation_receipt}
    }
    const previous=await result(db.from('intel_receipt_operations').select('saved_research_id').eq('org_id',actor.orgId).eq('user_id',actor.userId).eq('operation_id',input.operationId).maybeSingle())
    if(previous){if(!previous.saved_research_id)throw new Error('receipt_deleted');return readSaved(previous.saved_research_id)}
    const records=await readReceiptObservations(db,input.observationIds,now)
    const scenario=input.scenario==null?undefined:await captureStressScenario(db,input.scenario,actor,identity.subject,value=>investigationIdentity(value).subject,now)
    const receiptInput={scenario,subject:identity.subject,lens,question:input.question,decision:input.decision,cursor:Number(input.at??now),observations:records.map((r:any)=>r.observation),gaps:records.length<input.observationIds.length?['Some requested observations have expired or are unavailable.']:[]}
    const benchmarkIdentity=lens==='benchmark'?await readConnectedAssetIdentity(db,identity.requested):null
    if(lens==='benchmark'&&(!benchmarkIdentity?.marketSubject||!['100','20'].includes(input.benchmark)))throw Error('invalid_benchmark_identity')
    const receipt=lens==='benchmark'?await makeBenchmarkReceipt({...receiptInput,marketSubject:benchmarkIdentity!.marketSubject!,benchmark:input.benchmark},now):await makeResearchReceipt(receiptInput,now)
    const id=await result(db.rpc('intel_save_investigation_receipt',{p_org_id:actor.orgId,p_user_id:actor.userId,p_operation_id:input.operationId,p_receipt:receipt}))
    return readSaved(id)
  }
  if(operation==='cohort') {
    if(!['sector','cohort'].includes(lens))throw new Error('invalid_cohort_lens')
    if(!historyPolicy.historical)return {state:'unsupported',reason:'Historical cohort retention is unavailable under the current source policy.',cohort:null}
    if(input.cohortId) {
      if(!uuid(input.cohortId))throw new Error('invalid_cohort_id')
      const cohort=await result(db.from('intel_market_cohorts').select('*').eq('id',input.cohortId).gt('retain_until',new Date(now).toISOString()).maybeSingle())
      if(!cohort)throw new Error('cohort_unavailable')
      if(cohort.kind==='dex_discovery')return dexCohortService(db,{operation:'read',cohortId:cohort.id,...(input.at==null?{}:{at:input.at})},actor,now)
      const quotes=await globalCohortPrices(db,cohort,input.at,now)
      return {cohort,quotes}
    }
    const policy=cmcHistoryPolicy(now,new Date(now+21600000).toISOString(),cmcPolicyEnvironment(await loadCmcOperatingSettings(db),key=>Deno.env.get(key),now))
    if(!policy.historical)return {state:'unsupported',reason:'Historical cohort retention requires verified source permission.',cohort:null}
    const category=String(input.category??'')
    if(lens==='sector'&&!/^[a-f0-9]{24}$/.test(category))throw new Error('invalid_category_id')
    const cap=lens==='sector'?'category':'newListings',params=lens==='sector'?{id:category,start:1,limit:50}:{start:1,limit:50}
    const quotes=await snapshot(db,cap,params,actor)
    if(quotes.state!=='fresh'||!quotes.data.rows.length)return {state:quotes.state,reason:quotes.reason??'Fresh membership is required.',cohort:null}
    const collectedAt=new Date(Math.max(now,Date.now())).toISOString()
    const members=quotes.data.rows.flatMap((r:any)=>{const id=cmcSubject(r.id);return id?[{subject:id,name:r.name,symbol:r.symbol??null,joinedAt:collectedAt,initialPrice:finite(r.quote?.price),initialMarketCapUsd:finite(r.quote?.market_cap),initialObservedAt:r.quote?.last_updated??r.last_updated??null}]:[]})
    const key=`${cap}:${category}:${new Date(now).toISOString().slice(0,10)}`
    await result(db.from('intel_market_cohorts').upsert({cohort_key:key,kind:lens==='sector'?'sector':'new_listings',name:lens==='sector'?`Sector ${category}`:`First observed ${new Date(now).toISOString().slice(0,10)}`,provider:'coinmarketcap',source_ref:CMC_CAPABILITIES[cap].path,retain_until:policy.retainUntil,members},{onConflict:'cohort_key',ignoreDuplicates:true}))
    const cohort=await result(db.from('intel_market_cohorts').select('*').eq('cohort_key',key).single())
    return {state:'fresh',cohort,quotes}
  }
  if(operation!=='load')throw new Error('invalid_investigation_operation')
  const connected=identity.rwaId?null:await readConnectedAssetIdentity(db,identity.requested,input.network)
  if(connected?.cmcId){identity.cryptoId=connected.cmcId;identity.subject=connected.marketSubject!}
  const range=investigationRange(input,now),requests:Promise<any>[]=[]
  if(input.benchmark!=null&&!['100','20'].includes(input.benchmark))throw Error('invalid_benchmark')
  const dex=cmcDexIdentity(connected?.contractSubject||identity.requested)
  if(dex&&['participation','liquidity'].includes(lens)){
    const capability=lens==='participation'?'dexHolderHistory':'dexLiquidityEvents'
    requests.push(snapshot(db,capability,cmcDexParams(capability,dex),actor))
    if(lens==='liquidity')requests.push(snapshot(db,'dexSwaps',cmcDexParams('dexSwaps',dex),actor))
  }
  if(lens==='benchmark'&&identity.cryptoId){
    // UTC-day boundaries share one query across viewers, not a cache key for
    // each browser's current millisecond. Provider query cap is ten daily rows.
    const plan=benchmarkRequestPlan(range.from,range.to)
    requests.push(snapshot(db,input.benchmark==='20'?'cmc20History':'cmc100History',plan,actor),snapshot(db,'history',{id:identity.cryptoId,...plan},actor))
  }else if(lens==='cohort'&&input.cohortId){
    if(!uuid(input.cohortId))throw Error('invalid_cohort_id')
    // Its retained membership and quotes load through the cohort operation.
    // Reopening a saved DEX set must not request an unrelated new-listing feed.
  }else if(['attention','cohort'].includes(lens)) requests.push(snapshot(db,lens==='attention'?'trending':'newListings',{start:1,limit:50},actor))
  else if(lens==='sector') {
    if(input.category&&!/^[a-f0-9]{24}$/.test(String(input.category)))throw new Error('invalid_category_id')
    requests.push(snapshot(db,input.category?'category':'categories',input.category?{id:input.category,start:1,limit:50}:{start:1,limit:50},actor))
  } else if(identity.rwaId)requests.push(snapshot(db,'rwaQuotes',{rwa_id:identity.rwaId},actor))
  else if(identity.cryptoId) {
    requests.push(snapshot(db,'quotes',{id:identity.cryptoId},actor))
    if(lens==='fragility')requests.push(snapshot(db,'derivativePairs',{crypto_id:identity.cryptoId,start:1,limit:50},actor),snapshot(db,'liquidationAssets',{crypto_id:identity.cryptoId,start:1,limit:50},actor))
  }
  const settled=await Promise.allSettled(requests),results=settled.map((r,i)=>r.status==='fulfilled'?r.value:{capability:`source_${i+1}`,state:'unavailable',reason:'This source could not be read or normalized. Other available evidence remains visible.',provenance:null,data:{rows:[],total:null,hasMore:false},observations:[]}),current=results.flatMap(s=>s.observations)
  const snapshots=results.map(({retentionRows:_,...snapshot})=>snapshot)
  const subjects=[...new Set([identity.subject,...(connected?.contractSubject?[connected.contractSubject]:[]),...current.map(o=>o.subject)])].slice(0,100)
  const reads=await Promise.allSettled([
      readInvestigationHistory(db,subjects,{...range,limit:500},now,historyPolicy.historical),
      result(db.from('intel_investigation_visits').select('seen_at').eq('org_id',actor.orgId).eq('user_id',actor.userId).eq('subject',identity.subject).eq('lens',lens).maybeSingle()),
      ['participation','liquidity'].includes(lens)?readParticipation(db,connected?.contractSubject||identity.requested,range.to,range.from):Promise.resolve([]),
      identity.rwaId?recordIssuerReviews(db,snapshots.filter(s=>s.capability==='rwaQuotes').flatMap(s=>s.data.rows),Math.max(now,Date.now())):Promise.resolve([]),
      retainCurrentObservations(db,results.flatMap(s=>s.retentionRows??[]),Math.max(now,Date.now())),
      identity.cryptoId&&['stress','counterargument'].includes(lens)?readInvestigationDepth(db,identity.cryptoId,Math.max(now,Date.now())).then(async depth=>{await retainCurrentObservations(db,depth.rows,Math.max(now,Date.now()));return depth.observations}):Promise.resolve([]),
  ])
  const history=reads[0].status==='fulfilled'?reads[0].value:{observations:[],hasMore:false,nextCursor:null},visit=reads[1].status==='fulfilled'?reads[1].value:null,participation=reads[2].status==='fulfilled'?reads[2].value:[]
  if(reads[3].status==='fulfilled')current.push(...reads[3].value)
  if(reads[5].status==='fulfilled')current.push(...reads[5].value)
  const storageErrors=Object.fromEntries(reads.flatMap((read,i)=>read.status==='rejected'?[[['history','visit','participation','issuer reviews','current evidence references','venue depth'][i],'Temporarily unavailable']]:[]))
  const storageError=Object.keys(storageErrors).length?`Some evidence could not be loaded: ${Object.keys(storageErrors).join(', ')}. Available sources remain visible.`:null
  const attentionComparison=historyPolicy.historical&&dex&&['participation','attention'].includes(lens)?await readAdoptionAttention(db,[...current,...history.observations],dex.subject,identity.cryptoId?cmcSubject(identity.cryptoId):null,Math.max(now,Date.now()),'display'):null
  return {version:1,identity,connected,lens,snapshots,current,history,attentionComparison,seenAt:visit?.seen_at??null,participation,storageError,storageErrors,serverTime:new Date(Math.max(now,Date.now())).toISOString(),
    historyPolicy}
}
