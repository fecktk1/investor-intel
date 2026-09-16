// Propose, then confirm. The fingerprint an approval is bound to.
//
// The algorithm is the realty layer's planHash (_shared/realty/agents/risk.ts),
// reused rather than reinvented because it has one property worth keeping: it
// hashes exactly the things that change what happens, and nothing cosmetic. A
// reworded summary must not invalidate an approval a person already gave, or
// they learn to approve twice and stop reading. A changed target, payload, tool
// or risk level must invalidate it.
//
// The realty TABLES are not reused: realty_agent_plans has foreign keys to
// realty_teams, so it cannot be pointed at an Intel org. The design is what
// carries over.
//
// Every payload here is validated by the SAME contract the human editor uses —
// chartAlertConfig, validateDrawing — so an agent cannot write a shape a person
// could not have written through the app.

import {chartAlertConfig} from './chart-alert-service.ts'
import {validateDrawing,isUuid} from './chart-workspace-contract.ts'
import {AgentAuthError,WRITE_TOOLS,type AgentWriteTool,type AgentContext} from './agent-token.ts'

/** Risk, on the realty scale. 1 is internal and reversible, 2 changes how
 * something operates: an alert can fire and reach the member, so it is a 2. */
export const AGENT_TOOL_RISK:Record<AgentWriteTool,number>={intel_create_alert:2,intel_annotate_chart:1,intel_append_thesis_evidence:1}

/** Sorted keys and collapsed whitespace, so formatting is not a change. */
function stable(value:unknown):unknown {
 if(Array.isArray(value))return value.map(stable)
 if(value&&typeof value==='object'){
  const out:Record<string,unknown>={}
  for(const key of Object.keys(value as Record<string,unknown>).sort())out[key]=stable((value as Record<string,unknown>)[key])
  return out
 }
 if(typeof value==='string')return value.replace(/\s+/g,' ').trim()
 return value
}

/**
 * The hash an approval signs.
 *
 * Deliberately INCLUDES the tool key and the risk level, so a proposal that
 * quietly becomes a different write — an annotation that turns into an alert —
 * produces a different hash and loses its approval. Deliberately EXCLUDES the
 * summary, which is display text.
 */
export async function agentPlanHash(input:{toolKey:string;target:Record<string,unknown>;payload:Record<string,unknown>;riskLevel:number}):Promise<string> {
 const material={t:input.toolKey,r:input.riskLevel,g:stable(input.target),p:stable(input.payload)}
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(material)))
 return Array.from(new Uint8Array(digest)).map(byte=>byte.toString(16).padStart(2,'0')).join('')
}

export interface AgentPlanDraft {
 toolKey:AgentWriteTool
 target:Record<string,unknown>
 payload:Record<string,unknown>
 riskLevel:number
 summary:string
 planHash:string
}

const text=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)

/**
 * Validate a proposed write and reduce it to the exact rows it would touch.
 *
 * Nothing here trusts the agent's own account of what it is doing. The target
 * is re-read from the database to confirm it exists and belongs to this token's
 * pinned org and member, and the payload goes through the human editor's
 * validator. A proposal that fails either is refused now, never stored, and
 * never becomes something a person can approve by accident.
 */
export async function validateAgentPlan(db:any,context:AgentContext,body:any):Promise<AgentPlanDraft> {
 const toolKey=body?.tool as AgentWriteTool
 if(!toolKey||!Object.hasOwn(WRITE_TOOLS,toolKey))throw new AgentAuthError(400,'unknown_tool',`${String(toolKey)} is not a write this system offers.`)
 const riskLevel=AGENT_TOOL_RISK[toolKey]
 const owned=(table:string,id:string)=>db.from(table).select('id').eq('id',id).eq('org_id',context.orgId).eq('user_id',context.userId).maybeSingle()
 const readOne=async(query:any,missing:string)=>{
  const {data,error}=await query
  if(error)throw new AgentAuthError(503,'agent_target_unavailable','Could not read the target of this proposal. Retry when the service is ready.')
  // "No such row" and "not yours" are the same answer, so a token cannot be used
  // to probe which ids exist in other members' books.
  if(!data)throw new AgentAuthError(404,missing,'That record does not exist in this workspace.')
  return data
 }

 if(toolKey==='intel_create_alert'){
  // The member's own alert contract, unchanged. An agent-proposed alert is a
  // DRAFT unless the proposal says otherwise, and whether it is active is part
  // of the hash, so a draft cannot be flipped live after approval.
  const config=chartAlertConfig(body.config)
  const active=body.active===true
  const cooldownMinutes=body.cooldownMinutes??60
  if(!Number.isInteger(cooldownMinutes)||cooldownMinutes<15||cooldownMinutes>10080)throw new AgentAuthError(400,'invalid_cooldown','Cooldown must be between 15 minutes and one week.')
  return {
   toolKey,riskLevel,
   target:{asset:config.asset},
   payload:{config,active,cooldownMinutes},
   summary:`Create a ${active?'live':'draft'} alert on ${config.asset} when the price goes ${config.direction} ${config.threshold_usd}`.slice(0,500),
   planHash:await agentPlanHash({toolKey,riskLevel,target:{asset:config.asset},payload:{config,active,cooldownMinutes}}),
  }
 }

 if(toolKey==='intel_annotate_chart'){
  if(!isUuid(body.layoutId))throw new AgentAuthError(400,'invalid_chart_id','That is not a saved layout id.')
  const layout=await readOne(db.from('intel_chart_layouts').select('id,asset,title,revision').eq('id',body.layoutId).eq('org_id',context.orgId).eq('user_id',context.userId).maybeSingle(),'chart_layout_not_found')
  // One drawing, through the same validator the chart editor uses. The layout
  // itself is re-validated at execution time, after the drawing is appended.
  const drawing=validateDrawing(body.drawing)
  const target={layoutId:layout.id,asset:layout.asset}
  const payload={drawing}
  return {
   toolKey,riskLevel,target,payload,
   summary:`Add a ${drawing.tool} annotation to the saved layout "${String(layout.title).slice(0,80)}"`.slice(0,500),
   planHash:await agentPlanHash({toolKey,riskLevel,target,payload}),
  }
 }

 // intel_append_thesis_evidence
 if(!isUuid(body.thesisId))throw new AgentAuthError(400,'invalid_thesis_id','That is not a thesis id.')
 const thesis=await readOne(owned('intel_theses',body.thesisId),'thesis_not_found')
 const title=body.title,summary=body.summary??'',url=body.url??null
 if(!text(title,200)||!title.trim())throw new AgentAuthError(400,'invalid_evidence_text','Evidence needs a title of at most 200 characters.')
 if(!text(summary,4000))throw new AgentAuthError(400,'invalid_evidence_text','An evidence summary is at most 4000 characters.')
 if(url!==null&&(!text(url,2000)||!/^https:\/\//.test(url)))throw new AgentAuthError(400,'invalid_evidence_url','An evidence link must be an https URL.')
 const eventType=body.eventType??'news'
 if(!text(eventType,40)||!/^[a-z_]{1,40}$/.test(eventType))throw new AgentAuthError(400,'invalid_evidence_type','That is not an event type.')
 const eventAt=body.eventAt??null
 if(eventAt!==null&&(!text(eventAt,40)||!Number.isFinite(Date.parse(eventAt))))throw new AgentAuthError(400,'invalid_evidence_time','That is not a timestamp.')
 // The engine owns `impact`. An agent contributes an observation, not a verdict
 // on the member's own thesis, so impact is left for the monitor to classify.
 const target={thesisId:thesis.id}
 const payload={title:title.trim(),summary,url,eventType,eventAt}
 return {
  toolKey,riskLevel,target,payload,
  summary:`Append evidence "${title.trim().slice(0,80)}" to this thesis`.slice(0,500),
  planHash:await agentPlanHash({toolKey,riskLevel,target,payload}),
 }
}
