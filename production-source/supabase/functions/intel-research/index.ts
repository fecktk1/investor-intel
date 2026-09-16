import { createClient } from 'npm:@supabase/supabase-js@2'
import { requireIntelAccess, researchParams, researchSnapshot } from '../_shared/intel/research-service.ts'
import { orgAuthzErrorResponse } from '../_shared/org-authz.ts'
import { requireIntelSurface, surfaceLockedResponse } from '../_shared/intel/intel-surface-access.ts'
import {readAssetVenueContext} from '../_shared/intel/asset-venue-service.ts'
import {readContractResearch} from '../_shared/intel/contract-research.ts'
import {readConnectedAssetIdentity} from '../_shared/intel/connected-asset-identity.ts'
import {readSourceHistoryPage} from '../_shared/intel/source-history-service.ts'
import {exchangeDisclosureParams} from '../_shared/intel/exchange-disclosure.ts'
import {dexCohortService} from '../_shared/intel/dex-cohort-service.ts'
import {readNarrativeInput} from '../_shared/intel/narrative-input-replay.ts'
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS'}
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,'Content-Type':'application/json','Cache-Control':'private, no-store'}})
/** The reads answered entirely from our own store, and so the ONLY reads this
 * function serves without the research_on_demand surface. Each was checked
 * against the path it actually takes, not against its name:
 *
 *   catalog          researchSnapshot answers from CMC_CAPABILITIES and the
 *                    operating settings and returns ABOVE requestCmc. It lists
 *                    what a plan allows; it fetches nothing.
 *   assetIdentity    readConnectedAssetIdentity reads market_assets and one
 *                    indexed catalog RPC. It never calls requestCmc.
 *   sourceHistory    readSourceHistoryPage reads retained source versions, and
 *                    states in its own contract that it never activates demand
 *                    or contacts an upstream provider.
 *   narrativeInputs  readNarrativeInput reads the caller's own research
 *                    artifact under their JWT and the retained snapshot that
 *                    artifact names. No provider call on any branch.
 */
const STORE_ONLY_RESEARCH=new Set(['catalog','assetIdentity','sourceHistory','narrativeInputs'])

/**
 * Does this read need the paid research surface?
 *
 * WHY readMode:'retained' IS NOT EXEMPT. A retained read buys nothing at the
 * moment it is served: requestCmc returns the cached row on kind 'render' and
 * maxCalls is 0. But it reaches that return THROUGH the demand branch, which it
 * enters with selectedDemand true, and when connected demand is enabled that
 * branch stamps demanded_at on the shared cache row. Foreground demand is the
 * refresh worker's only input, so the provider call is still made, later and on
 * another clock, and charged to the same shared budget. A retained read of a
 * provider backed capability therefore spends; it just spends asynchronously,
 * which is why it stays behind the gate.
 *
 * The read mode is accepted and then deliberately ignored. It is a parameter so
 * that the rule is stated where it can be tested rather than assumed at the
 * call site, and so that reintroducing the retained exemption has to be a
 * visible edit to this function.
 */
export function researchSurfaceRequired(capability:string,_readMode?:unknown):boolean{
  return !STORE_ONLY_RESEARCH.has(capability)
}

export async function handleResearch(req:Request) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: {...cors, 'Access-Control-Max-Age': '600'} })
  if(req.method!=='POST')return json({error:'method_not_allowed'},405)
  try {
    if(Number(req.headers.get('content-length')||0)>8192)return json({error:'request_too_large'},413)
    const raw=await req.text();if(raw.length>8192)return json({error:'request_too_large'},413)
    let body:any;try{body=JSON.parse(raw)}catch{return json({error:'invalid_json'},400)}
    const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const actor=await requireIntelAccess(req,createClient,db,typeof body.orgId==='string'?body.orgId:null)
    const capability=typeof body.capability==='string'?body.capability:''
    // The surface gate, once, before any branch below can begin work. It admits
    // exactly the four store-only reads named above, which cost nothing extra
    // per reader, and refuses every other read, RETAINED ONES INCLUDED, for a
    // membership that does not carry the surface. The broad gate that used to
    // sit here refused the store-only reads too, which was safe but wrong: a
    // free member was denied data that was already ours and already paid for.
    if(researchSurfaceRequired(capability,body.readMode))await requireIntelSurface(db,actor,'research_on_demand')
    if(capability==='narrativeInputs'){
      if(!actor.userId||!actor.orgId)return json({error:'member_required'},403)
      const userDb=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_ANON_KEY')!,{global:{headers:{Authorization:req.headers.get('authorization')||''}}})
      try{return json(await readNarrativeInput(userDb,db,{userId:actor.userId,orgId:actor.orgId},body.params))}
      catch(e){const code=e instanceof Error?e.message:'';return json({error:code==='invalid_narrative_input_request'?code:'narrative_input_read_failed'},code==='invalid_narrative_input_request'?400:503)}
    }
    if(body.readMode!=null&&body.readMode!=='retained')return json({error:'invalid_read_mode'},400)
    const cacheOnly=body.readMode==='retained'
    if(cacheOnly&&capability==='dexCohort')return json({error:'invalid_read_mode'},400)
    if(capability==='dexCohort'){
      if(!actor.userId||!actor.orgId)return json({error:'member_required'},403)
      try{return json(await dexCohortService(db,body.params,{userId:actor.userId,orgId:actor.orgId}))}catch(e){const message=e instanceof Error?e.message:'';return json({error:message.startsWith('invalid_dex_cohort_')?message:message==='dex_cohort_source_changed'?message:'dex_cohort_unavailable'},message.startsWith('invalid_dex_cohort_')?400:message==='dex_cohort_source_changed'?409:503)}
    }
    if(capability==='sourceHistory'){
      try{return json(await readSourceHistoryPage(db,body.params))}catch(e){const message=e instanceof Error?e.message:'';return json({error:message.startsWith('invalid_source_history_')?message:'source_history_unavailable'},message.startsWith('invalid_source_history_')?400:503)}
    }
    if(capability==='assetIdentity'){
      const p=body.params||{}
      if(Object.keys(p).some(k=>k!=='canonicalKey')||typeof p.canonicalKey!=='string'||p.canonicalKey.length>240||!/^market:coinmarketcap:[1-9][0-9]{0,11}$/.test(p.canonicalKey))return json({error:'invalid_asset_identity'},400)
      return json({schemaVersion:1,identity:await readConnectedAssetIdentity(db,p.canonicalKey)})
    }
    if(capability==='exchangeDisclosure'){
      let p;try{p=exchangeDisclosureParams(body.params)}catch{return json({error:'invalid_disclosure_request'},400)}
      const params=researchParams('exchangeAssets',{id:p.id})
      return json(await researchSnapshot(db,'exchangeAssets',params,actor.userId,actor.orgId,p,cacheOnly))
    }
    if(capability==='venueContext')return json(await readAssetVenueContext(db,body.params,(name,params)=>researchSnapshot(db,name,params,actor.userId,actor.orgId,undefined,cacheOnly)))
    if(capability==='dexContext'){
      if(!actor.userId||!actor.orgId)return json({error:'member_required'},403)
      try{return json(await readContractResearch(db,body.params,{userId:actor.userId,orgId:actor.orgId},undefined,cacheOnly))}catch(e){return json({error:e instanceof Error&&e.message==='invalid_contract_research_request'?e.message:'contract_research_unavailable'},e instanceof Error&&e.message==='invalid_contract_research_request'?400:503)}
    }
    let params:Record<string,string>
    try{params=capability==='catalog'?{}:researchParams(capability,body.params)}catch(e){return json({error:(e as Error).message},400)}
    return json(await researchSnapshot(db,capability,params,actor.userId,actor.orgId,undefined,cacheOnly))
  }catch(e){return surfaceLockedResponse(e,cors)||orgAuthzErrorResponse(e,cors)||json({error:'research_unavailable'},503)}
}
if(import.meta.main)Deno.serve(handleResearch)
