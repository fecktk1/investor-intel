import { createClient } from 'npm:@supabase/supabase-js@2'
import { requireIntelAccess } from '../_shared/intel/research-service.ts'
import { investigationService } from '../_shared/intel/investigation-service.ts'
import { orgAuthzErrorResponse } from '../_shared/org-authz.ts'
import { requireIntelSurface, surfaceLockedResponse } from '../_shared/intel/intel-surface-access.ts'
import {readBoundedJson,RequestBodyError} from '../_shared/intel/bounded-request.ts'
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS'}
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,'Content-Type':'application/json','Cache-Control':'private, no-store'}})
const expectedFailures:Record<string,number>={receipt_deleted:410,scenario_conditions_changed_refresh_thesis:409,scenario_asset_mismatch:400,scenario_thesis_unavailable:404,scenario_rule_limit:400,duplicate_scenario_rule:400,cohort_unavailable:404}
export async function handleInvestigation(req:Request) {
  if(req.method==='OPTIONS')return new Response('ok',{headers:cors})
  if(req.method!=='POST')return json({error:'method_not_allowed'},405)
  try {
    const body=await readBoundedJson(req,100000)
    const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const actor=await requireIntelAccess(req,createClient,db,typeof body.orgId==='string'?body.orgId:null)
    if(!actor.userId||!actor.orgId)return json({error:'signed_in_investor_required'},403)
    // Connected research runs the on-demand provider path for this member.
    await requireIntelSurface(db,actor,'investigation')
    return json(await investigationService(db,{userId:actor.userId,orgId:actor.orgId},body))
  }catch(e){if(e instanceof RequestBodyError)return json({error:e.message},e.status);const code=e instanceof Error?e.message:'',expected=Object.hasOwn(expectedFailures,code)?expectedFailures[code]:null;return surfaceLockedResponse(e,cors)||orgAuthzErrorResponse(e,cors)||json({error:expected||/^(invalid_|unsupported_asset_identity)/.test(code)?code:'investigation_unavailable'},expected??(/^(invalid_|unsupported_asset_identity)/.test(code)?400:503))}
}
if(import.meta.main)Deno.serve(handleInvestigation)
