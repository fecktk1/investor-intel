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
/** Capabilities answered entirely from our own store. `catalog` lists what the
 * plan allows, and the other two read rows a scheduled job already wrote, so
 * none of them spends a provider credit for the asking member. */
const STORE_ONLY_RESEARCH=new Set(['catalog','assetIdentity','sourceHistory'])

export async function handleResearch(req:Request) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: {...cors, 'Access-Control-Max-Age': '600'} })
  if(req.method!=='POST')return json({error:'method_not_allowed'},405)
  try {
    if(Number(req.headers.get('content-length')||0)>8192)return json({error:'request_too_large'},413)
    const raw=await req.text();if(raw.length>8192)return json({error:'request_too_large'},413)
    let body:any;try{body=JSON.parse(raw)}catch{return json({error:'invalid_json'},400)}
    const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const actor=await requireIntelAccess(req,createClient,db,typeof body.orgId==='string'?body.orgId:null)
    // NOTE, needs a decision. This broad gate gets the security property right
    // (nothing on-demand is served to a tier that may not have it) but it is
    // WIDER than the cost split intends: it also refuses `catalog`,
    // `assetIdentity`, `sourceHistory` and every `readMode:'retained'` read,
    // all of which are answered from our own store and cost nothing extra per
    // reader. The precise rule is the conditional one below, which is currently
    // unreachable because this line already threw. Removing this line is the
    // intended follow-up; it is left in place deliberately rather than removed
    // unreviewed, because the failure mode of leaving it is a free member
    // seeing a lock they should not see, and the failure mode of removing it
    // wrongly is serving paid work for free.
    await requireIntelSurface(db,actor,'research_on_demand')
    const capability=typeof body.capability==='string'?body.capability:''
    if(capability==='narrativeInputs'){
      if(!actor.userId||!actor.orgId)return json({error:'member_required'},403)
      const userDb=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_ANON_KEY')!,{global:{headers:{Authorization:req.headers.get('authorization')||''}}})
      try{return json(await readNarrativeInput(userDb,db,{userId:actor.userId,orgId:actor.orgId},body.params))}
      catch(e){const code=e instanceof Error?e.message:'';return json({error:code==='invalid_narrative_input_request'?code:'narrative_input_read_failed'},code==='invalid_narrative_input_request'?400:503)}
    }
    if(body.readMode!=null&&body.readMode!=='retained')return json({error:'invalid_read_mode'},400)
    const cacheOnly=body.readMode==='retained'
    // Only the reads that actually reach the provider are gated. A retained
    // read is answered from what we already stored (maxCalls 0, kind render)
    // and the store-only capabilities below never call out at all, so both stay
    // open to a free member: serving them again costs nothing.
    if(!cacheOnly&&!STORE_ONLY_RESEARCH.has(capability))await requireIntelSurface(db,actor,'research_on_demand')
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
