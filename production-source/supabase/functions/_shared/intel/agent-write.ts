// The write path: gate, write, then go back and look.
//
// Three writes exist, and each one reuses the contract the human editor already
// uses. Nothing here invents a new way into the database — the RPCs are the same
// ones the app calls, which is also why they are the only ones that can write:
// intel_save_chart_alert and friends are granted to service_role only, and
// app_private.intel_chart_alert_write_guard rejects a non-service writer
// outright.
//
// The order matters and is the same order the realty runtime uses:
//
//   1. The database gate, immediately before the write rather than at proposal
//      time, because the token, the membership, the entitlement and the approval
//      can all have changed since.
//   2. Recompute the hash from the stored plan. Defence in depth against a plan
//      row that was altered by any route the immutability trigger did not cover.
//   3. Do the write, through the existing validated contract.
//   4. Re-read the row and check it says what was asked for.
//   5. Record the verification either way, and report the step by what the
//      verification found rather than by what the write claimed.
//
// A write that returns success and changes nothing is a failure here.

import {AgentAuthError,type AgentContext} from './agent-token.ts'
import {agentPlanHash} from './agent-plan.ts'
import {validateChartLayout,isUuid} from './chart-workspace-contract.ts'

// deno-lint-ignore no-explicit-any
type Db=any

export interface AgentWriteResult {
 planId:string
 tool:string
 status:'executed'|'failed'
 recordId:string|null
 verification:{status:'passed'|'failed'|'inconclusive';message:string;expected:Record<string,unknown>;observed:Record<string,unknown>}
}

/** Statuses the gate returns that are the caller's fault rather than the server's. */
const GATE_STATUS:Record<string,number>={plan_not_found:404,plan_not_yours:403,already_executed:409,plan_expired:410,token_invalid:401,token_revoked:401,token_expired:401,scope_mismatch:403,scope_missing:403,membership_revoked:403,entitlement_lost:403,approval_missing:412,approval_expired:412,plan_changed:409}

async function recordVerification(db:Db,plan:any,result:AgentWriteResult['verification'],type:string):Promise<void> {
 const {error}=await db.from('intel_agent_verifications').insert({
  org_id:plan.org_id,plan_id:plan.id,verification_type:type,
  expected_state:result.expected,observed_state:result.observed,status:result.status,evidence:{message:result.message},
 })
 // A verification that could not be recorded is itself a problem worth seeing,
 // but it must not turn a landed write into a reported failure.
 if(error)console.error('[agent-write] verification not recorded:',error.message)
}

export async function executeAgentPlan(db:Db,context:AgentContext,planId:unknown):Promise<AgentWriteResult> {
 if(!isUuid(planId))throw new AgentAuthError(400,'invalid_plan_id','That is not a proposal id.')

 // 1. The gate.
 const gate=await db.rpc('intel_agent_execution_gate',{p_plan_id:planId,p_token_id:context.tokenId})
 if(gate.error)throw new AgentAuthError(503,'gate_unavailable','Could not evaluate the execution gate, so nothing ran.')
 const verdict=gate.data
 if(!verdict?.allowed){
  const code=String(verdict?.reason_code||'blocked')
  throw new AgentAuthError(GATE_STATUS[code]??403,code,String(verdict?.reason||'This write was refused.'))
 }

 const {data:plan,error:planError}=await db.from('intel_agent_plans').select('*').eq('id',planId).maybeSingle()
 if(planError||!plan)throw new AgentAuthError(503,'agent_plan_unavailable','Could not read the proposal that was just allowed.')

 // 2. The hash, recomputed from what is actually stored.
 const recomputed=await agentPlanHash({toolKey:plan.tool_key,target:plan.target,payload:plan.payload,riskLevel:plan.risk_level})
 if(recomputed!==plan.plan_hash){
  const verification={status:'failed' as const,message:'The stored proposal does not match its own hash, so it was not run.',expected:{plan_hash:plan.plan_hash},observed:{plan_hash:recomputed}}
  await recordVerification(db,plan,verification,'plan_integrity')
  await db.from('intel_agent_plans').update({status:'failed',failure_reason:'plan_hash_mismatch'}).eq('id',plan.id)
  throw new AgentAuthError(409,'plan_hash_mismatch',verification.message)
 }

 // 3, 4, 5.
 try{
  const written=plan.tool_key==='intel_create_alert'?await writeAlert(db,plan)
   :plan.tool_key==='intel_annotate_chart'?await writeAnnotation(db,plan)
   :await writeThesisEvidence(db,plan)
  await recordVerification(db,plan,written.verification,plan.tool_key)
  const landed=written.verification.status==='passed'
  await db.from('intel_agent_plans').update({
   status:landed?'executed':'failed',executed_at:new Date().toISOString(),
   result:{record_id:written.recordId,verification:written.verification.status},
   ...(landed?{}:{failure_reason:written.verification.message.slice(0,300)}),
  }).eq('id',plan.id)
  // The approval is spent whether or not the write verified, so a failed
  // attempt cannot be silently retried against the same yes.
  await db.from('intel_agent_approvals').update({status:'consumed',consumed_at:new Date().toISOString()}).eq('plan_id',plan.id).eq('status','approved')
  return {planId:plan.id,tool:plan.tool_key,status:landed?'executed':'failed',recordId:written.recordId,verification:written.verification}
 }catch(error){
  const message=error instanceof Error?error.message:'agent_write_failed'
  await db.from('intel_agent_plans').update({status:'failed',executed_at:new Date().toISOString(),failure_reason:message.slice(0,300)}).eq('id',plan.id)
  if(error instanceof AgentAuthError)throw error
  throw new AgentAuthError(503,'agent_write_failed',`The write did not complete: ${message}`)
 }
}

/** The proposal id is the operation id, so a replayed execution is the same
 * operation to the idempotent RPC rather than a second alert. */
async function writeAlert(db:Db,plan:any):Promise<{recordId:string|null;verification:AgentWriteResult['verification']}> {
 const {config,active,cooldownMinutes}=plan.payload
 const {data,error}=await db.rpc('intel_save_chart_alert',{p_org:plan.org_id,p_user:plan.user_id,p_id:null,p_revision:0,p_operation:plan.id,p_config:config,p_active:active,p_cooldown:cooldownMinutes})
 if(error)throw new Error(error.message)
 const recordId=data?.id??null
 if(!recordId){
  return {recordId:null,verification:{status:'failed',message:'The alert write returned no id, so there is nothing to check. Treating that as a failure rather than assuming it worked.',expected:{id:'a uuid'},observed:{returned:data??null}}}
 }
 const {data:row,error:readError}=await db.from('intel_alert_rules').select('id,org_id,user_id,is_active,config').eq('id',recordId).maybeSingle()
 if(readError)return {recordId,verification:{status:'inconclusive',message:`Could not re-read the alert: ${readError.message}`,expected:{id:recordId},observed:{}}}
 return {recordId,verification:verifyRow(row,recordId,plan,{is_active:active,threshold:config.threshold_usd,direction:config.direction},{
  is_active:row?.is_active,threshold:row?.config?.threshold_usd,direction:row?.config?.direction,
 },'alert')}
}

/** Appends one drawing to the member's saved layout and saves the whole layout
 * back through the same validator and the same revision check the editor uses,
 * so a concurrent human edit produces a conflict rather than a silent overwrite. */
async function writeAnnotation(db:Db,plan:any):Promise<{recordId:string|null;verification:AgentWriteResult['verification']}> {
 const layoutId=plan.target.layoutId
 const {data:current,error}=await db.from('intel_chart_layouts').select('id,title,state,revision').eq('id',layoutId).eq('org_id',plan.org_id).eq('user_id',plan.user_id).maybeSingle()
 if(error)throw new Error(error.message)
 if(!current)throw new AgentAuthError(404,'chart_layout_not_found','That saved layout no longer exists in this workspace.')
 const drawing=plan.payload.drawing
 if((current.state?.drawings??[]).some((d:any)=>d.id===drawing.id)){
  // The same annotation is already there. That is the idempotency working.
  return {recordId:layoutId,verification:{status:'passed',message:'This annotation was already on the layout. Not adding it twice.',expected:{drawing_id:drawing.id},observed:{drawing_id:drawing.id}}}
 }
 const state=validateChartLayout({...current.state,drawings:[...(current.state?.drawings??[]),drawing]})
 const {error:saveError}=await db.rpc('intel_save_chart_layout',{p_org:plan.org_id,p_user:plan.user_id,p_id:layoutId,p_revision:current.revision,p_operation:plan.id,p_title:current.title,p_state:state})
 if(saveError)throw new Error(saveError.code==='40001'||saveError.code==='PT409'?'chart_revision_conflict':saveError.message)
 const {data:row,error:readError}=await db.from('intel_chart_layouts').select('id,org_id,user_id,state').eq('id',layoutId).maybeSingle()
 if(readError)return {recordId:layoutId,verification:{status:'inconclusive',message:`Could not re-read the layout: ${readError.message}`,expected:{id:layoutId},observed:{}}}
 const present=(row?.state?.drawings??[]).some((d:any)=>d.id===drawing.id)
 return {recordId:layoutId,verification:verifyRow(row,layoutId,plan,{drawing_present:true},{drawing_present:present},'annotation')}
}

/** The only append a member can make by hand. source_table 'manual' is in the
 * CHECK enum, and (thesis_id, source_table, source_ref) is the idempotency key
 * the monitor already upserts on, so a replay writes nothing twice. The
 * source_ref is derived from the approved plan hash rather than supplied, so the
 * agent cannot choose a ref that collides with engine-written evidence. */
async function writeThesisEvidence(db:Db,plan:any):Promise<{recordId:string|null;verification:AgentWriteResult['verification']}> {
 const sourceRef=`agent:${plan.plan_hash.slice(0,48)}`
 const {title,summary,url,eventType,eventAt}=plan.payload
 const row={
  org_id:plan.org_id,user_id:plan.user_id,thesis_id:plan.target.thesisId,visibility:'private',
  source_table:'manual',source_ref:sourceRef,event_type:eventType,event_at:eventAt??new Date().toISOString(),
  // impact is left null on purpose. The engine classifies evidence; an agent
  // contributes the observation, not the verdict on the member's own thesis.
  impact:null,impact_source:'engine',is_baseline:false,
  event_snapshot:{title,summary,url,source:'agent',agent_token_id:plan.token_id,plan_id:plan.id},
 }
 const {error}=await db.from('intel_thesis_evidence').upsert([row],{onConflict:'thesis_id,source_table,source_ref',ignoreDuplicates:true})
 if(error)throw new Error(error.message)
 // The upsert ignores duplicates and so reports no row on a replay. The read
 // below is what establishes whether the evidence is there, which is the only
 // question that matters.
 const {data:stored,error:readError}=await db.from('intel_thesis_evidence').select('id,org_id,thesis_id,source_table,source_ref,event_snapshot')
  .eq('thesis_id',plan.target.thesisId).eq('source_table','manual').eq('source_ref',sourceRef).maybeSingle()
 if(readError)return {recordId:null,verification:{status:'inconclusive',message:`Could not re-read the evidence: ${readError.message}`,expected:{source_ref:sourceRef},observed:{}}}
 return {recordId:stored?.id??null,verification:verifyRow(stored,stored?.id??null,plan,{source_ref:sourceRef,title},{source_ref:stored?.source_ref,title:stored?.event_snapshot?.title},'thesis_evidence')}
}

/** Shared shape of "is it there, is it ours, does it say what we asked for". */
function verifyRow(row:any,recordId:string|null,plan:any,expected:Record<string,unknown>,observed:Record<string,unknown>,kind:string):AgentWriteResult['verification'] {
 if(!row){
  return {status:'failed',message:`The write reported success but no ${kind} row came back on re-read. The write did not land.`,expected:{...expected,id:recordId},observed:{row:null}}
 }
 // Organization, always. A write that succeeded into the wrong tenant is the
 // worst possible success.
 if('org_id' in row&&row.org_id!==plan.org_id){
  return {status:'failed',message:'The row was written into a different workspace.',expected:{org_id:plan.org_id},observed:{org_id:row.org_id}}
 }
 const mismatches=Object.keys(expected).filter(key=>String(observed[key]??'')!==String(expected[key]??''))
 if(mismatches.length){
  return {status:'failed',message:`The ${kind} row exists but ${mismatches.join(', ')} ${mismatches.length===1?'does':'do'} not match what was approved.`,expected,observed}
 }
 return {status:'passed',message:`Confirmed by re-reading the ${kind}.`,expected,observed}
}
