import {requestCmc,cmcPlan,type CmcResult} from '../market-assets/cmc-transport.ts'
import {connectedDemandEnabled,selectedCmcReadPolicy} from '../market-assets/cmc-demand-policy.ts'
import {cmcDexIdentity,cmcDexParams,isCmcDexCursor,CMC_HOLDER_TAGS} from '../market-assets/cmc-dex.ts'
import {cmcParams,CMC_CAPABILITIES,planAllows} from '../market-assets/cmc-capabilities.ts'
import {cmcPolicyEnvironment,loadCmcOperatingSettings} from '../market-assets/cmc-operating-settings.ts'
import {normalizeCmcInvestigation} from './investigation-normalize.ts'
import {marketSourceReference} from './market-source-reference.ts'
import {readMarketSourceVersions,retainMarketSourceVersions,securityVersionChanges} from './market-source-versions.ts'
import {captureHolderTags} from './holder-tags.ts'
import {captureHour,compareHolderTags,readHolderCohort,readHolderTags} from './holder-tags-read.ts'
import {captureSwapFlow,SWAP_FLOW_MAX_PAGES,SWAP_FLOW_PAGE} from './swap-flow.ts'
import {readSwapFlow,readSwapFlowCaptures} from './swap-flow-read.ts'
// `holder_tags` and `maker_flow` do NOT stream their capabilities through the
// loop below: they capture into their own dated tables and the views read those.
// The capabilities are listed so the plan gate and the refresh policy stay
// identical to every other view. The loop skips them explicitly.
//
// `swaps` and `maker_flow` share one capability and are not the same view.
// `swaps` is the tape: one page of 25 events, newest first, paged by a reader
// pressing "Next activity". `maker_flow` is a bounded SWEEP of that same tape,
// grouped by the account the provider attributes each swap to. Neither replaces
// the other, and the tape view keeps its cursor exactly as it was.
const views:Record<string,string[]>={overview:['dexToken','dexHolderCount'],holders:['dexHolderHistory'],security:['dexSecurity'],liquidity:['dexLiquidityEvents'],pools:['dexPools'],swaps:['dexSwaps'],holder_tags:['dexHolderTags','dexHolders'],maker_flow:['dexSwaps']}
const HOUR=3600000
/** One selected contract/view; normal navigation is cache-only. */
export async function readContractResearch(db:any,input:any,actor:{userId:string;orgId:string},request=requestCmc,cacheOnly=false){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['canonicalKey','view','refresh','requestRevision','cursor','capturedAt','compareWith','tag'].includes(k)))throw Error('invalid_contract_research_request')
 const view=input.view??'overview'
 if(!views[view]||(input.refresh!=null&&typeof input.refresh!=='boolean')||(input.cursor!=null&&(!['liquidity','swaps'].includes(view)||!isCmcDexCursor(input.cursor))))throw Error('invalid_contract_research_request')
 // `capturedAt` names the stored capture to render and belongs to BOTH
 // capture-backed views. `compareWith` is the holder-tag slider's second side and
 // belongs to that view alone. A stamp that is not a readable instant is a bad
 // request, never a silent fallback to "the newest", which would answer a
 // different question from the one the caller asked.
 for(const [key,allowed] of [['capturedAt',['holder_tags','maker_flow']],['compareWith',['holder_tags']]] as [string,string[]][])
  if(input[key]!=null&&(!allowed.includes(view)||typeof input[key]!=='string'||!captureHour(input[key])))throw Error('invalid_contract_research_request')
 if(input.tag!=null&&(view!=='holder_tags'||typeof input.tag!=='string'||!CMC_HOLDER_TAGS.includes(input.tag)))throw Error('invalid_contract_research_request')
 const identity=cmcDexIdentity(input.canonicalKey)
 if(!identity)return {schemaVersion:1,canonicalKey:input.canonicalKey,view,state:'unsupported',reason:'CMC DEX coverage has not been verified for this chain and contract identity.',sources:[],observations:[]}
 const settings=await loadCmcOperatingSettings(db),policy=cmcPolicyEnvironment(settings,key=>{try{return Deno.env.get(key)}catch{return undefined}})
 const connected=connectedDemandEnabled(settings,key=>{try{return Deno.env.get(key)}catch{return undefined}})
 const ctx={supabase:db,kind:!cacheOnly&&input.refresh===true?'request' as const:'render' as const,...actor,selectedDemand:connected,maxCalls:cacheOnly?0:views[view].length,waitForFresh:!cacheOnly,caller:cacheOnly?'intel-contract-visible-cache':'intel-contract-research'}
 const sources=[],observations:any[]=[]
 if(view==='holder_tags')return await holderTagResearch(db,identity,input,actor,request,cacheOnly,settings,policy,connected,observations)
 if(view==='maker_flow')return await swapFlowResearch(db,identity,input,actor,request,cacheOnly,settings,policy,connected,observations)
 for(const capability of views[view]){
  const params=cmcParams(capability,{...cmcDexParams(capability,identity),...(input.cursor?{lastId:input.cursor}:{})})
  const response:CmcResult=await request(capability,params,ctx),data=response.payload?.data
  const {fetchedAt,expiresAt}=response.provenance
  if(response.payload&&fetchedAt&&expiresAt){
    const normalized=await normalizeCmcInvestigation(capability,response.payload,params,fetchedAt,expiresAt,new Date(Date.parse(fetchedAt)+CMC_CAPABILITIES[capability].stale*1000).toISOString(),policy)
    await retainMarketSourceVersions(db,normalized.sourceRows)
    if(normalized.rows.length){
      // Repair from the cached source clock, then read the immutable first
      // recording. A repeated fetch must not rewrite "First recorded".
      const retained=await db.rpc('intel_record_market_observations',{p_rows:normalized.rows})
      if(retained.error)throw Error('contract_evidence_storage_unavailable')
      const ids=normalized.observations.map(o=>o.id)
      const saved=await db.from('intel_market_observations').select('id,observation').in('id',ids).gt('retain_until',new Date().toISOString()).limit(ids.length)
      if(saved.error||!Array.isArray(saved.data)||saved.data.length!==ids.length)throw Error('contract_evidence_storage_unavailable')
      observations.push(...saved.data.map((r:any)=>r.observation))
    }
  }
  // Whitelist the product response; no holder wallet-list or creator profiling.
  const rows=!data?[]:capability==='dexToken'?[{name:data.n,symbol:data.sym,price:data.p,priceObservedAt:data.pt,liquidityUsd:data.liqUsd,marketCap:data.mcap}]:
    capability==='dexHolderCount'?[{count:data.count}]:capability==='dexPools'?data.map((r:any)=>({address:r.addr,venue:r.exn,liquidityUsd:r.liqUsd,volume24h:r.v24,token0:{address:r.t0?.addr,symbol:r.t0?.sym},token1:{address:r.t1?.addr,symbol:r.t1?.sym},publishedAt:r.pubAt,observedAt:null})):
    capability==='dexSecurity'?data.map((r:any)=>({exists:r.exist,level:r.securityLevel,items:(r.securityItems||[]).slice(0,50).map((v:any)=>({description:v.des,hit:v.isHit,level:v.riskyLevel,code:v.code}))})):[]
  sources.push({capability,state:response.state,reason:response.reason,provenance:response.provenance,rows,sourceReference:response.payload?await marketSourceReference(capability,params,response.payload,response.provenance):null,nextCursor:['dexLiquidityEvents','dexSwaps'].includes(capability)?data?.lastId||null:null})
 }
 const securityHistory=view==='security'?await readMarketSourceVersions(db,identity.subject,'security',Date.now(),'display'):null
 return {schemaVersion:1,canonicalKey:identity.subject,network:identity.label,view,refreshPolicy:selectedCmcReadPolicy(views[view],input.cursor?{lastId:input.cursor}:{},cmcPlan(Date.now(),settings),connected),securityHistory:securityHistory?{...securityHistory,comparison:securityVersionChanges(securityHistory.versions)}:null,state:sources.every(s=>s.state==='fresh')?'fresh':sources.some(s=>s.state==='fresh'||s.state==='stale')?'partial':'unavailable',sources,observations,
  coverage:`Exact ${identity.label} contract. Holder accounts are not people; CMC risk labels are source observations, not a safety guarantee. Public swap and pool activity never change your holdings.`}
}
/** The retained-evidence sink a capture lane hands its successful responses to.
 *
 * It is the SAME path every rendered view already uses: normalize, retain the
 * source version, record the observations, then read back only what the store
 * actually kept and is still inside its retention window. A lane therefore
 * cannot become a private side door into the evidence table: rows it did not
 * persist are rows the caller never sees, and the retention policy that governs
 * every other observation governs these too.
 *
 * Extracted from `holderTagResearch` unchanged when `maker_flow` needed the
 * identical behaviour; both views pass it the same three arguments. */
// deno-lint-ignore no-explicit-any
function evidenceSink(db:any,policy:(key:string)=>string|undefined,observations:any[]) {
 return async(capability:string,params:Record<string,unknown>,response:CmcResult)=>{
  const {fetchedAt,expiresAt}=response.provenance||({} as any)
  if(!response.payload||!fetchedAt||!expiresAt)return
  const canonical=cmcParams(capability,params)
  const normalized=await normalizeCmcInvestigation(capability,response.payload,canonical,fetchedAt,expiresAt,new Date(Date.parse(fetchedAt)+CMC_CAPABILITIES[capability].stale*1000).toISOString(),policy)
  await retainMarketSourceVersions(db,normalized.sourceRows)
  if(!normalized.rows.length)return
  const retained=await db.rpc('intel_record_market_observations',{p_rows:normalized.rows})
  if(retained.error)throw Error('contract_evidence_storage_unavailable')
  const ids=normalized.observations.map(o=>o.id)
  const saved=await db.from('intel_market_observations').select('id,observation').in('id',ids).gt('retain_until',new Date().toISOString()).limit(ids.length)
  if(saved.error||!Array.isArray(saved.data)||saved.data.length!==ids.length)throw Error('contract_evidence_storage_unavailable')
  observations.push(...saved.data.map((r:any)=>r.observation))
 }
}
/** The `maker_flow` view: the public swap tape, swept and grouped by MAKER.
 *
 * Like `holder_tags` and unlike every rendered view, its provider interaction is
 * a CAPTURE: `captureSwapFlow` walks the provider's own `lastId` cursor and
 * writes per-account rows into `intel_swap_flow_snapshots` plus one coverage row
 * into `intel_swap_flow_captures`, and this view reads those back. The sweep is
 * what makes a cohort possible at all: a single 25-row page of tape may not
 * contain one account twice.
 *
 * `refresh` costs 1 credit per page walked, at most SWAP_FLOW_MAX_PAGES. A
 * second refresh inside the same hour is skipped (`within_cadence`) and costs
 * nothing. The swaps the sweep reads also become retained evidence on the shared
 * path, so this view spends its credits once and the tape view benefits too.
 *
 * The plan gate matches the capability: `dexSwaps` is tier `startup`, so below
 * Startup the view answers `plan_below_startup` without spending a call to
 * discover it, the same shape `holder_tags` uses. */
// deno-lint-ignore no-explicit-any
async function swapFlowResearch(db:any,identity:NonNullable<ReturnType<typeof cmcDexIdentity>>,input:any,actor:{userId:string;orgId:string},
 request:typeof requestCmc,cacheOnly:boolean,settings:any,policy:(key:string)=>string|undefined,connected:boolean,observations:any[]){
 const plan=cmcPlan(Date.now(),settings)
 const base={schemaVersion:1,canonicalKey:identity.subject,network:identity.label,view:'maker_flow',
  refreshPolicy:selectedCmcReadPolicy(views.maker_flow,{},plan,connected),securityHistory:null,sources:[] as any[],observations,
  coverage:`Public swaps for the exact ${identity.label} contract, swept newest first and grouped by the maker account CoinMarketCap attributes each swap to. A maker is a public on-chain account, NOT a person: nothing is resolved to a name, an exchange or an entity, and no account is ever linked to another. One sweep reads at most ${SWAP_FLOW_MAX_PAGES} pages of ${SWAP_FLOW_PAGE} swaps, so a cohort is what that sweep saw and never the token's whole history. Accumulating and distributing describe how the token moved through an account; they are not intent, not skill and not advice.`}
 if(!planAllows(plan,'startup'))return {...base,state:'unsupported',reason:'plan_below_startup',
  message:'Maker swap-flow cohorts need the CoinMarketCap Startup plan. No call was made.',
  swapFlow:null,flowCaptures:null,capture:null}
 let capture=null
 if(!cacheOnly&&input.refresh===true){
  const ctxFor=(name:string,maxCalls:number)=>({supabase:db,kind:'request' as const,...actor,selectedDemand:connected,maxCalls,waitForFresh:true,caller:`intel-contract-${name}`})
  capture=await captureSwapFlow(db,identity,ctxFor,{
   request:(name:string,params?:Record<string,unknown>,ctx?:any)=>request(name,params,ctx),
   // The swaps a sweep reads are the same public events the `swaps` view already
   // retains, so they go down the same evidence path. The per-account totals are
   // NOT evidence about the token: they live in this lane's own table, addresses
   // only, and nowhere else.
   record:evidenceSink(db,policy,observations)},{plan})
 }
 const captures:any=await readSwapFlowCaptures(db,{chain:identity.chain,address:identity.address})
 const selected=typeof input.capturedAt==='string'?captureHour(input.capturedAt):null
 const flow:any=await readSwapFlow(db,{chain:identity.chain,address:identity.address,capturedAt:selected})
 const currentHour=new Date(Math.floor(Date.now()/HOUR)*HOUR).toISOString()
 // State is read off the DATA, not off what the refresh attempted: a sweep that
 // failed after an earlier one succeeded is partial, and a series whose newest
 // sweep predates this hour is stale however it got there.
 const state=!captures.captures.length?'unavailable':capture?.error?'partial':captures.asOf===currentHour?'fresh':'stale'
 return {...base,state,reason:capture?.error??capture?.partial??capture?.skipped??captures.reason??flow.reason??null,
  swapFlow:flow,flowCaptures:captures,capture}
}
/** The `holder_tags` view (CMC plan proposal 20).
 *
 * Unlike every other view here, its provider interaction is a CAPTURE, not a
 * render: `captureHolderTags` writes dated rows into `intel_holder_tag_snapshots`
 * and `intel_holder_cohort_snapshots`, and the view reads those tables back. That
 * is what makes a date slider and a two-date comparison possible at all — neither
 * endpoint publishes a clock or a history, so the series only exists because we
 * kept it.
 *
 * `refresh` costs 1 credit for the tag board plus 1 for each tag whose reported
 * holder count is above zero: at most 9. A second refresh inside the same hour is
 * skipped (`within_cadence`) and costs nothing.
 *
 * The plan gate matches the capability: `dexHolderTags` is tier `startup`, so
 * below Startup the view answers `plan_below_startup` without spending a call to
 * discover it — the same shape `captureNewListings` uses. */
// deno-lint-ignore no-explicit-any
async function holderTagResearch(db:any,identity:NonNullable<ReturnType<typeof cmcDexIdentity>>,input:any,actor:{userId:string;orgId:string},
 request:typeof requestCmc,cacheOnly:boolean,settings:any,policy:(key:string)=>string|undefined,connected:boolean,observations:any[]){
 const plan=cmcPlan(Date.now(),settings)
 const base={schemaVersion:1,canonicalKey:identity.subject,network:identity.label,view:'holder_tags',
  refreshPolicy:selectedCmcReadPolicy(views.holder_tags,{},plan,connected),securityHistory:null,sources:[] as any[],observations,
  coverage:`Provider-classified holder addresses for the exact ${identity.label} contract. Captured on OUR clock: neither tag_count nor holders/list publishes an observation time, so every date here is the hour we asked. Tags are CoinMarketCap's labels for addresses; an address is not a person and nothing is enriched with names, exchanges or clustering. Each cohort is ONE page of at most 50 addresses per tag, not the holder base. A realized gain is the provider's reported figure for that address, not a valuation and not advice.`}
 if(!planAllows(plan,'startup'))return {...base,state:'unsupported',reason:'plan_below_startup',
  message:'Holder tags and cohort PnL need the CoinMarketCap Startup plan. No call was made.',
  holderTags:null,holderCohort:null,comparison:null,capture:null}
 let capture=null
 if(!cacheOnly&&input.refresh===true){
  const ctxFor=(name:string,maxCalls:number)=>({supabase:db,kind:'request' as const,...actor,selectedDemand:connected,maxCalls,waitForFresh:true,caller:`intel-contract-${name}`})
  capture=await captureHolderTags(db,identity,ctxFor,{
   request:(name:string,params?:Record<string,unknown>,ctx?:any)=>request(name,params,ctx),
   // The tag board — and only the tag board — also becomes retained evidence, on
   // exactly the path every other view uses. A wallet page is NOT evidence about
   // the token: it lives in this lane's own table, addresses only, and nowhere else.
   record:evidenceSink(db,policy,observations)},{plan})
 }
 const tags:any=await readHolderTags(db,{chain:identity.chain,address:identity.address})
 const selected=typeof input.capturedAt==='string'?captureHour(input.capturedAt):null
 const cohort=await readHolderCohort(db,{chain:identity.chain,address:identity.address,capturedAt:selected,tag:input.tag??null})
 const find=(stamp:string|null)=>stamp?(tags.captures as any[]).find(c=>c.capturedAt===stamp)??null:null
 // From the compared capture TO the selected one (or the newest). A side the
 // retained window does not hold stays null and the comparison says so.
 const comparison=typeof input.compareWith==='string'?compareHolderTags(find(captureHour(input.compareWith)),find(selected)??tags.latest):null
 const currentHour=new Date(Math.floor(Date.now()/HOUR)*HOUR).toISOString()
 // State is read off the DATA, not off what the refresh attempted: a capture that
 // failed after an earlier one succeeded is partial, and a series whose newest
 // row predates this hour is stale however it got there.
 const state=!tags.captures.length?'unavailable':capture?.error?'partial':tags.asOf===currentHour?'fresh':'stale'
 return {...base,state,reason:capture?.error??capture?.partial??capture?.skipped??tags.reason??null,
  holderTags:tags,holderCohort:cohort,comparison,capture}
}
