import {loadCmcOperatingSettings,cmcPolicyEnvironment} from '../_shared/market-assets/cmc-operating-settings.ts'
import {createClient} from 'npm:@supabase/supabase-js@2'
import {requireIntelAccess} from '../_shared/intel/research-service.ts'
import {requireOrgMember,orgAuthzErrorResponse} from '../_shared/org-authz.ts'
import {chartWorkspaceService} from '../_shared/intel/chart-workspace-service.ts'
import {readBoundedJson,RequestBodyError} from '../_shared/intel/bounded-request.ts'
import {chartSnapshotService} from '../_shared/intel/chart-snapshot-service.ts'
import {chartShareService} from '../_shared/intel/chart-share-service.ts'
import {chartAlertService} from '../_shared/intel/chart-alert-service.ts'
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS'}
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,'Content-Type':'application/json','Cache-Control':'private, no-store'}})
export async function handleChartWorkspace(req:Request) {
 if(req.method==='OPTIONS')return new Response('ok',{headers:cors})
 if(req.method!=='POST')return json({error:'method_not_allowed'},405)
 try{
  const body=await readBoundedJson(req,1500000)
  const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!),orgId=typeof body.orgId==='string'?body.orgId:null
  const actor=['delete','snapshot_delete','share_revoke','navigation_clear'].includes(String(body.operation))?await requireOrgMember(req,createClient,db,orgId):await requireIntelAccess(req,createClient,db,orgId)
  if(!actor.userId||!actor.orgId)return json({error:'signed_in_investor_required'},403)
  if(String(body.operation).startsWith('alert_')){
   const env=['alert_rehearsal','alert_market_rehearsal'].includes(String(body.operation))?cmcPolicyEnvironment(await loadCmcOperatingSettings(db),key=>Deno.env.get(key)):(key:string)=>Deno.env.get(key)
   return json(await chartAlertService(db,{userId:actor.userId,orgId:actor.orgId},body,{env}))
  }
  const sourceEnv=cmcPolicyEnvironment(await loadCmcOperatingSettings(db),key=>Deno.env.get(key))
  if(String(body.operation).startsWith('share_'))return json(await chartShareService(db,{userId:actor.userId,orgId:actor.orgId},body,sourceEnv))
  if(String(body.operation).startsWith('snapshot_'))return json(await chartSnapshotService(db,{userId:actor.userId,orgId:actor.orgId},body,{secret:Deno.env.get('INTEL_CHART_PROOF_SECRET')||Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'',env:sourceEnv}))
  return json(await chartWorkspaceService(db,{userId:actor.userId,orgId:actor.orgId},body))
 }catch(error){
  if(error instanceof RequestBodyError)return json({error:error.message},error.status)
  const message=error instanceof Error?error.message:'chart_workspace_unavailable'
  if(message.startsWith('chart_alert_'))return json({error:message},message.includes('storage')?503:message==='chart_alert_not_found'?404:409)
  if(message.startsWith('chart_share_'))return json({error:message},message.includes('storage')?503:message==='chart_share_unavailable'?404:409)
  if(message.startsWith('chart_capture_')||message.startsWith('chart_snapshot_'))return json({error:message},message.includes('storage')||message.includes('signing')?503:message.endsWith('not_found')?404:409)
  return orgAuthzErrorResponse(error,cors)||json({error:/^(invalid_|duplicate_|period_|macd_|unknown_study|chart_layout_limit|chart_layout_not_found|chart_layout_deleted|chart_revision_conflict)/.test(message)?message:'chart_workspace_unavailable'},['chart_revision_conflict','chart_layout_deleted'].includes(message)?409:message==='chart_layout_not_found'?404:/^(invalid_|duplicate_|period_|macd_|unknown_study|chart_layout_limit)/.test(message)?400:503)
 }
}
if(import.meta.main)Deno.serve(handleChartWorkspace)
