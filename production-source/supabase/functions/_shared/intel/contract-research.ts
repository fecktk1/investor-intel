import {requestCmc,cmcPlan,type CmcResult} from '../market-assets/cmc-transport.ts'
import {connectedDemandEnabled,selectedCmcReadPolicy} from '../market-assets/cmc-demand-policy.ts'
import {cmcDexIdentity,cmcDexParams,isCmcDexCursor} from '../market-assets/cmc-dex.ts'
import {cmcParams,CMC_CAPABILITIES} from '../market-assets/cmc-capabilities.ts'
import {cmcPolicyEnvironment,loadCmcOperatingSettings} from '../market-assets/cmc-operating-settings.ts'
import {normalizeCmcInvestigation} from './investigation-normalize.ts'
import {marketSourceReference} from './market-source-reference.ts'
import {readMarketSourceVersions,retainMarketSourceVersions,securityVersionChanges} from './market-source-versions.ts'
const views:Record<string,string[]>={overview:['dexToken','dexHolderCount'],holders:['dexHolderHistory'],security:['dexSecurity'],liquidity:['dexLiquidityEvents'],pools:['dexPools'],swaps:['dexSwaps']}
/** One selected contract/view; normal navigation is cache-only. */
export async function readContractResearch(db:any,input:any,actor:{userId:string;orgId:string},request=requestCmc,cacheOnly=false){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['canonicalKey','view','refresh','requestRevision','cursor'].includes(k)))throw Error('invalid_contract_research_request')
 const view=input.view??'overview'
 if(!views[view]||(input.refresh!=null&&typeof input.refresh!=='boolean')||(input.cursor!=null&&(!['liquidity','swaps'].includes(view)||!isCmcDexCursor(input.cursor))))throw Error('invalid_contract_research_request')
 const identity=cmcDexIdentity(input.canonicalKey)
 if(!identity)return {schemaVersion:1,canonicalKey:input.canonicalKey,view,state:'unsupported',reason:'CMC DEX coverage has not been verified for this chain and contract identity.',sources:[],observations:[]}
 const settings=await loadCmcOperatingSettings(db),policy=cmcPolicyEnvironment(settings,key=>{try{return Deno.env.get(key)}catch{return undefined}})
 const connected=connectedDemandEnabled(settings,key=>{try{return Deno.env.get(key)}catch{return undefined}})
 const ctx={supabase:db,kind:!cacheOnly&&input.refresh===true?'request' as const:'render' as const,...actor,selectedDemand:connected,maxCalls:cacheOnly?0:views[view].length,waitForFresh:!cacheOnly,caller:cacheOnly?'intel-contract-visible-cache':'intel-contract-research'}
 const sources=[],observations=[]
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
