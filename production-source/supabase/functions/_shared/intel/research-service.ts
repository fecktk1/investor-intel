import { CMC_CAPABILITIES, cmcParams, cmcRows, planAllows } from '../market-assets/cmc-capabilities.ts'
import { requestCmc, cmcPlan,loadCmcOperatingSettings } from '../market-assets/cmc-transport.ts'
import { OrgAuthzError, requireOrgMember } from '../org-authz.ts'
import { aggregateExchangeDisclosure,exchangeDisclosureReference } from './exchange-disclosure.ts'
import {marketSourceReference} from './market-source-reference.ts'
import {capabilityScope} from './market-figure-scope.ts'
import {normalizeCmcInvestigation} from './investigation-normalize.ts'
import {retainMarketSourceVersions} from './market-source-versions.ts'
import {cmcPolicyEnvironment} from '../market-assets/cmc-operating-settings.ts'
import {connectedDemandEnabled,selectedCmcReadPolicy} from '../market-assets/cmc-demand-policy.ts'

/** Existing product access decision includes paid/trial and FORGE holder grants. */
export async function requireIntelAccess(req:Request,createClient:any,db:any,orgId:string|null) {
  const actor=await requireOrgMember(req,createClient,db,orgId)
  const {data,error}=await db.rpc('can_access_intel',{p_user:actor.userId,p_org:actor.orgId})
  if(error) throw new OrgAuthzError('Access verification unavailable.',503)
  if(data!==true) throw new OrgAuthzError('Investor Intel access required.',403)
  return actor
}

export function researchParams(capability:string,input:unknown) {
  if(input!=null && (typeof input!=='object'||Array.isArray(input))) throw new Error('invalid_parameters')
  const params=cmcParams(capability,(input||{}) as Record<string,unknown>)
  if(Number(params.limit||0)>100 || Number(params.count||0)>100) throw new Error('maximum_rows_100')
  for(const key of ['id','crypto_id','rwa_id','exchange_id','slug','rwa_slug','exchange_slug','symbol']) if((params[key]?.split(',').length||0)>20) throw new Error('maximum_identifiers_20')
  return params
}

export async function researchSnapshot(db:any,capability:string,params:Record<string,string>,userId:string|null,orgId?:string,page:{start:number;limit:number;assetId?:string}={start:1,limit:25},cacheOnly=false) {
  if(capability==='catalog') {const plan=cmcPlan(Date.now(),await loadCmcOperatingSettings(db));return {version:1,capability,state:'fresh',data:{rows:Object.entries(CMC_CAPABILITIES).map(([id,c])=>({id,endpoint:c.path,minimumPlan:c.tier,available:planAllows(plan,c.tier),ttlSeconds:c.ttl})),total:Object.keys(CMC_CAPABILITIES).length,hasMore:false},reason:null}}
  const settings=await loadCmcOperatingSettings(db),connected=connectedDemandEnabled(settings,key=>{try{return Deno.env.get(key)}catch{return undefined}})
  const result=await requestCmc(capability,params,{supabase:db,kind:cacheOnly?'render':'request',selectedDemand:cacheOnly,maxCalls:cacheOnly?0:1,waitForFresh:!cacheOnly,caller:cacheOnly?'intel-research-visible-cache':'intel-research',requestId:userId,orgId,userId})
  // Repair the metadata-only relationship index from the same cached response;
  // no extra provider call and no private book data enter this shared record.
  if(capability==='rwaQuotes'&&result.payload&&result.provenance.fetchedAt&&result.provenance.expiresAt){
    const policy=cmcPolicyEnvironment(await loadCmcOperatingSettings(db),key=>Deno.env.get(key))
    const normalized=await normalizeCmcInvestigation(capability,result.payload,params,result.provenance.fetchedAt,result.provenance.expiresAt,new Date(Date.parse(result.provenance.fetchedAt)+CMC_CAPABILITIES[capability].stale*1000).toISOString(),policy)
    await retainMarketSourceVersions(db,normalized.sourceRows)
  }
  return {version:1,capability,state:result.state,refreshPolicy:selectedCmcReadPolicy([capability],{...params,...(page.start>1?{start:page.start}:{})},cmcPlan(Date.now(),settings),connected),data:result.payload?(capability==='exchangeAssets'?{...aggregateExchangeDisclosure(result.payload,params.id,page.start,page.limit,page.assetId),sourceReference:await exchangeDisclosureReference(result.payload,params.id,result.provenance,page.assetId)}:cmcRows(capability,result.payload)):{rows:[],total:null,hasMore:false},provenance:result.provenance,reason:result.reason,
   // The call receipt rides in the body because provider_call_logs and the
   // response cache are service-role only and a reader can never query them.
   receipt:result.receipt,scope:capabilityScope(CMC_CAPABILITIES[capability]?.feature),
   // Any capability can produce a source reference now. A dex read keeps the
   // existing strict behaviour because the cohort capture verifies its payloadHash
   // against this exact object; a newly covered capability must never fail a whole
   // research read just to add one, so its reference is best effort.
   sourceReference:!result.payload?null:capability.startsWith('dex')?await marketSourceReference(capability,params,result.payload,result.provenance)
    :await marketSourceReference(capability,params,result.payload,result.provenance).catch(()=>null)}
}
