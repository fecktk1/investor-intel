// The two surfaces, kept apart.
//
// A member's SESSION mints, lists and revokes tokens, and approves a proposed
// write. An agent TOKEN reads, proposes and executes. Neither can reach the
// other's operations, and that separation is the reason scopes mean anything: a
// token that could mint a token could grant itself every scope, and every
// refusal elsewhere would be decoration.
//
// Reads never forward a database row. Everything goes through the closed
// projections in ./agent-projection.ts.

import {
 AgentAuthError,mintAgentToken,requireScope,validScopes,AGENT_SCOPES,READ_FAMILIES,WRITE_TOOLS,
 type AgentContext,type AgentScope,
} from './agent-token.ts'
import {validateAgentPlan} from './agent-plan.ts'
import {executeAgentPlan} from './agent-write.ts'
import {isUuid,chartAsset} from './chart-workspace-contract.ts'
import {
 projectPortfolio,projectHoldings,projectTheses,projectAlerts,projectAlertEvents,
 projectCharts,projectChartDetail,projectWatchlists,projectWatchlistItems,
 projectEvidence,projectReceipts,projectPlan,projectPlans,projectToken,projectTokens,
} from './agent-projection.ts'

// deno-lint-ignore no-explicit-any
type Db=any

/** Session only. Named here so the handler can refuse a token before routing. */
export const MANAGEMENT_OPERATIONS=['token_create','token_list','token_revoke','plan_list','plan_approve','plan_reject'] as const
/** Agent token only. */
export const AGENT_OPERATIONS=['whoami','read_portfolio','read_theses','read_alerts','read_charts','read_chart','read_watchlists','read_evidence','propose_write','execute_write','plan_status'] as const

/** At most this many live tokens per member per workspace. A member who needs
 * more has almost certainly stopped revoking the ones they no longer use. */
export const MAX_LIVE_TOKENS=10
const PAGE_SIZE=20
const HOUR=3600000

const page=(value:unknown):number=>{
 const n=value??0
 if(!Number.isInteger(n)||(n as number)<0||(n as number)>100)throw new AgentAuthError(400,'invalid_page','That page is out of range.')
 return n as number
}
const paged=async(query:any,project:(rows:any[])=>unknown[],key:string,current:number)=>{
 const {data,error}=await query.range(current*PAGE_SIZE,current*PAGE_SIZE+PAGE_SIZE)
 if(error)throw new AgentAuthError(503,'agent_read_unavailable','That read is unavailable. Retry when the service is ready.')
 const rows=data??[]
 return {[key]:project(rows.slice(0,PAGE_SIZE)),hasMore:rows.length>PAGE_SIZE,page:current}
}
const one=async(query:any,missing:string)=>{
 const {data,error}=await query
 if(error)throw new AgentAuthError(503,'agent_read_unavailable','That read is unavailable. Retry when the service is ready.')
 if(!data)throw new AgentAuthError(404,missing,'That record does not exist in this workspace.')
 return data
}

// ── Management: a member's own session ──────────────────────────────────────

export async function agentManagementService(db:Db,actor:{orgId:string;userId:string},body:any):Promise<unknown> {
 const operation=String(body?.operation||'')
 const owned=(table:string)=>db.from(table).select('*').eq('org_id',actor.orgId).eq('user_id',actor.userId)

 if(operation==='token_create'){
  const name=body.name
  if(typeof name!=='string'||!name.trim()||name.length>80)throw new AgentAuthError(400,'invalid_token_name','Give the token a name of at most 80 characters.')
  const scopes=validScopes(body.scopes)
  const days=body.expiresInDays??90
  if(!Number.isInteger(days)||days<1||days>365)throw new AgentAuthError(400,'invalid_expiry','A token lasts between one and 365 days.')

  const {count,error:countError}=await db.from('intel_agent_tokens').select('id',{count:'exact',head:true})
   .eq('org_id',actor.orgId).eq('user_id',actor.userId).is('revoked_at',null).gt('expires_at',new Date().toISOString())
  if(countError)throw new AgentAuthError(503,'token_store_unavailable','The token store is unavailable. Retry when the service is ready.')
  if((count??0)>=MAX_LIVE_TOKENS)throw new AgentAuthError(409,'token_limit',`You already have ${MAX_LIVE_TOKENS} live tokens. Revoke one you no longer use before creating another.`)

  const minted=await mintAgentToken()
  const {data,error}=await db.from('intel_agent_tokens').insert({
   user_id:actor.userId,
   // Pinned from the session that was already proven to be a member of this
   // org. Never from the request body, and never from get_my_org_id().
   org_id:actor.orgId,
   name:name.trim(),token_hash:minted.hash,token_hint:minted.hint,scopes,
   expires_at:new Date(Date.now()+days*24*HOUR).toISOString(),
  }).select('*').maybeSingle()
  if(error||!data)throw new AgentAuthError(503,'token_store_unavailable',`The token could not be created${error?`: ${error.message}`:''}.`)
  // The only time the plaintext is ever returned. It is not stored and cannot
  // be shown again.
  return {token:minted.plaintext,shown_once:true,...projectToken(data)}
 }

 if(operation==='token_list'){
  const {data,error}=await db.from('intel_agent_tokens').select('*').eq('org_id',actor.orgId).eq('user_id',actor.userId).order('created_at',{ascending:false}).limit(50)
  if(error)throw new AgentAuthError(503,'token_store_unavailable','The token store is unavailable. Retry when the service is ready.')
  return {tokens:projectTokens(data??[]),scopes:[...AGENT_SCOPES]}
 }

 if(operation==='token_revoke'){
  if(!isUuid(body.id))throw new AgentAuthError(400,'invalid_token_id','That is not a token id.')
  const reason=body.reason??null
  if(reason!==null&&(typeof reason!=='string'||reason.length>200))throw new AgentAuthError(400,'invalid_reason','A revocation reason is at most 200 characters.')
  const {data,error}=await db.from('intel_agent_tokens')
   .update({revoked_at:new Date().toISOString(),revoked_reason:reason??'Revoked by the account owner'})
   .eq('id',body.id).eq('org_id',actor.orgId).eq('user_id',actor.userId).is('revoked_at',null).select('*').maybeSingle()
  if(error)throw new AgentAuthError(503,'token_store_unavailable','The token store is unavailable. Retry when the service is ready.')
  // Already revoked and never existed are the same answer to the caller, and
  // both are the state they asked for.
  if(!data)return {revoked:true,already:true}
  return {revoked:true,already:false,...projectToken(data)}
 }

 if(operation==='plan_list'){
  const status=body.status??null
  if(status!==null&&!['proposed','approved','executed','failed','rejected','expired'].includes(status))throw new AgentAuthError(400,'invalid_status','That is not a proposal status.')
  let query=owned('intel_agent_plans').order('created_at',{ascending:false})
  if(status)query=query.eq('status',status)
  return await paged(query,projectPlans,'plans',page(body.page))
 }

 if(operation==='plan_approve'||operation==='plan_reject'){
  if(!isUuid(body.planId))throw new AgentAuthError(400,'invalid_plan_id','That is not a proposal id.')
  const plan=await one(db.from('intel_agent_plans').select('*').eq('id',body.planId).eq('org_id',actor.orgId).eq('user_id',actor.userId).maybeSingle(),'plan_not_found')
  if(plan.status!=='proposed'){
   throw new AgentAuthError(409,`plan_${plan.status}`,`This proposal is ${plan.status}, so it cannot be ${operation==='plan_approve'?'approved':'rejected'} now.`)
  }
  if(Date.parse(plan.expires_at)<Date.now())throw new AgentAuthError(410,'plan_expired','This proposal expired. Ask the agent to propose it again.')

  if(operation==='plan_reject'){
   const {error}=await db.from('intel_agent_plans').update({status:'rejected',failure_reason:(body.reason??'Rejected by the account owner').slice(0,300)}).eq('id',plan.id)
   if(error)throw new AgentAuthError(503,'agent_plan_unavailable','The proposal could not be updated. Retry when the service is ready.')
   return {planId:plan.id,status:'rejected'}
  }

  const note=body.note??null
  if(note!==null&&(typeof note!=='string'||note.length>500))throw new AgentAuthError(400,'invalid_note','An approval note is at most 500 characters.')
  // The approval signs the hash AS STORED. Nothing the approver sends can
  // change what is being approved.
  const {data:approval,error}=await db.from('intel_agent_approvals').insert({
   org_id:plan.org_id,plan_id:plan.id,plan_hash:plan.plan_hash,approved_by:actor.userId,note,
   expires_at:new Date(Date.now()+24*HOUR).toISOString(),
  }).select('id,plan_hash,expires_at').maybeSingle()
  if(error||!approval){
   // The partial unique index makes a second approval for the same plan a
   // no-op rather than a second signature.
   if(error?.message?.includes('duplicate key'))return {planId:plan.id,status:'approved',already:true}
   throw new AgentAuthError(503,'agent_approval_unavailable',`The approval could not be recorded${error?`: ${error.message}`:''}.`)
  }
  const {error:statusError}=await db.from('intel_agent_plans').update({status:'approved'}).eq('id',plan.id)
  if(statusError)throw new AgentAuthError(503,'agent_plan_unavailable','The approval was recorded but the proposal could not be marked approved.')
  return {planId:plan.id,status:'approved',planHash:approval.plan_hash,expiresAt:approval.expires_at}
 }

 throw new AgentAuthError(400,'invalid_operation','That is not an operation this surface offers.')
}

// ── Agent: an inbound token ─────────────────────────────────────────────────

export async function agentReadService(db:Db,context:AgentContext,body:any):Promise<unknown> {
 const operation=String(body?.operation||'')
 const scoped=(table:string,columns='*')=>db.from(table).select(columns).eq('org_id',context.orgId).eq('user_id',context.userId)

 if(operation==='whoami'){
  // Deliberately says what this token CANNOT do as well as what it can, so an
  // agent reports a missing scope rather than looping on a refusal.
  return {
   token_id:context.tokenId,token_name:context.tokenName,org_id:context.orgId,
   scopes:context.scopes,
   missing_scopes:AGENT_SCOPES.filter(scope=>!context.scopes.includes(scope)),
   writes_require_approval:true,
   actor:context.actor,
  }
 }

 if(operation==='read_portfolio'){
  requireScope(context,READ_FAMILIES.portfolio)
  const {data:portfolios,error}=await scoped('investor_portfolios').order('is_default',{ascending:false}).order('created_at',{ascending:true}).limit(10)
  if(error)throw new AgentAuthError(503,'agent_read_unavailable','That read is unavailable. Retry when the service is ready.')
  const rows=portfolios??[]
  const selected=body.portfolioId?rows.find((p:any)=>p.id===body.portfolioId):rows[0]
  if(body.portfolioId&&!selected)throw new AgentAuthError(404,'portfolio_not_found','That portfolio does not exist in this workspace.')
  let holdings:unknown[]=[]
  if(selected){
   const {data,error:holdingError}=await db.from('investor_portfolio_holdings').select('*')
    .eq('org_id',context.orgId).eq('user_id',context.userId).eq('portfolio_id',selected.id)
    .order('current_value',{ascending:false,nullsFirst:false}).limit(200)
   if(holdingError)throw new AgentAuthError(503,'agent_read_unavailable','That read is unavailable. Retry when the service is ready.')
   holdings=projectHoldings(data??[])
  }
  return {portfolios:rows.map(projectPortfolio),selected:selected?projectPortfolio(selected):null,holdings}
 }

 if(operation==='read_theses'){
  requireScope(context,READ_FAMILIES.thesis)
  return await paged(scoped('intel_theses').order('updated_at',{ascending:false}).order('id',{ascending:false}),projectTheses,'theses',page(body.page))
 }

 if(operation==='read_alerts'){
  requireScope(context,READ_FAMILIES.alerts)
  const result=await paged(scoped('intel_alert_rules').order('created_at',{ascending:false}).order('id',{ascending:false}),projectAlerts,'alerts',page(body.page))
  if(body.includeEvents!==true)return result
  const {data,error}=await db.from('intel_alert_events').select('id,rule_id,fired_at,read_at,payload')
   .eq('org_id',context.orgId).order('fired_at',{ascending:false}).limit(PAGE_SIZE)
  if(error)throw new AgentAuthError(503,'agent_read_unavailable','That read is unavailable. Retry when the service is ready.')
  return {...result,events:projectAlertEvents(data??[])}
 }

 if(operation==='read_charts'){
  requireScope(context,READ_FAMILIES.charts)
  let query=scoped('intel_chart_layouts','id,asset,title,revision,created_at,updated_at').order('updated_at',{ascending:false}).order('id',{ascending:false})
  if(body.asset)query=query.eq('asset',chartAsset(body.asset))
  return await paged(query,projectCharts,'charts',page(body.page))
 }

 if(operation==='read_chart'){
  requireScope(context,READ_FAMILIES.charts)
  if(!isUuid(body.id))throw new AgentAuthError(400,'invalid_chart_id','That is not a saved layout id.')
  const row=await one(scoped('intel_chart_layouts','id,asset,title,revision,state,created_at,updated_at').eq('id',body.id).maybeSingle(),'chart_layout_not_found')
  return {chart:projectChartDetail(row)}
 }

 if(operation==='read_watchlists'){
  requireScope(context,READ_FAMILIES.watchlists)
  const {data:lists,error}=await scoped('watchlists').order('sort_order',{ascending:true}).order('created_at',{ascending:true}).limit(50)
  if(error)throw new AgentAuthError(503,'agent_read_unavailable','That read is unavailable. Retry when the service is ready.')
  const ids=(lists??[]).map((row:any)=>row.id)
  let items:unknown[]=[]
  if(ids.length){
   const {data,error:itemError}=await db.from('watchlist_items').select('id,watchlist_id,item_type,label,notes,sort_order,created_at')
    .eq('org_id',context.orgId).in('watchlist_id',ids).order('sort_order',{ascending:true}).limit(500)
   if(itemError)throw new AgentAuthError(503,'agent_read_unavailable','That read is unavailable. Retry when the service is ready.')
   items=projectWatchlistItems(data??[])
  }
  return {watchlists:projectWatchlists(lists??[]),items}
 }

 if(operation==='read_evidence'){
  requireScope(context,READ_FAMILIES.evidence)
  if(body.receipts===true){
   // Investigation receipts live on saved_research, private to their owner.
   const query=scoped('saved_research','id,title,created_at,investigation_receipt').not('investigation_receipt','is',null).order('created_at',{ascending:false}).order('id',{ascending:false})
   return await paged(query,projectReceipts,'receipts',page(body.page))
  }
  if(!isUuid(body.thesisId))throw new AgentAuthError(400,'invalid_thesis_id','Name the thesis whose evidence you want, or ask for receipts.')
  await one(scoped('intel_theses','id').eq('id',body.thesisId).maybeSingle(),'thesis_not_found')
  const query=scoped('intel_thesis_evidence').eq('thesis_id',body.thesisId).order('event_at',{ascending:false}).order('id',{ascending:false})
  return await paged(query,projectEvidence,'evidence',page(body.page))
 }

 // ── Writes: propose, then wait for a person ───────────────────────────────

 if(operation==='propose_write'){
  // The scope is checked FIRST, before the proposal is validated and before the
  // target is read. Validating first would let a read-only token learn which
  // layout and thesis ids exist by reading the difference between "that record
  // does not exist" and "this token cannot write", which is a membership oracle
  // built out of two honest error messages.
  const tool=String(body?.tool||'')
  if(!Object.hasOwn(WRITE_TOOLS,tool))throw new AgentAuthError(400,'unknown_tool',`${tool} is not a write this system offers.`)
  requireScope(context,WRITE_TOOLS[tool as keyof typeof WRITE_TOOLS] as AgentScope)
  const draft=await validateAgentPlan(db,context,body)
  const expiresAt=new Date(Date.now()+24*HOUR).toISOString()
  const {data,error}=await db.from('intel_agent_plans').insert({
   org_id:context.orgId,user_id:context.userId,token_id:context.tokenId,
   tool_key:draft.toolKey,target:draft.target,payload:draft.payload,plan_hash:draft.planHash,
   risk_level:draft.riskLevel,actor:context.actor,summary:draft.summary,expires_at:expiresAt,
  }).select('*').maybeSingle()
  if(error||!data){
   // A retry of an identical proposal finds the live one rather than stacking a
   // second approval request for the same write.
   if(error?.message?.includes('duplicate key')||error?.code==='23505'){
    const {data:existing}=await db.from('intel_agent_plans').select('*').eq('token_id',context.tokenId).eq('plan_hash',draft.planHash).in('status',['proposed','approved']).maybeSingle()
    if(existing)return {proposal:projectPlan(existing),already:true,next_step:existing.status==='approved'?'Approved. Call execute_write with this proposal id.':'Waiting for the account owner to approve this in Investor Intel settings.'}
   }
   throw new AgentAuthError(503,'agent_plan_unavailable',`The proposal could not be recorded${error?`: ${error.message}`:''}.`)
  }
  return {proposal:projectPlan(data),already:false,next_step:'Waiting for the account owner to approve this in Investor Intel settings.'}
 }

 if(operation==='plan_status'){
  if(!isUuid(body.planId))throw new AgentAuthError(400,'invalid_plan_id','That is not a proposal id.')
  const row=await one(db.from('intel_agent_plans').select('*').eq('id',body.planId).eq('token_id',context.tokenId).maybeSingle(),'plan_not_found')
  return {proposal:projectPlan(row)}
 }

 if(operation==='execute_write'){
  return await executeAgentPlan(db,context,body.planId)
 }

 throw new AgentAuthError(400,'invalid_operation','That is not an operation this surface offers.')
}
