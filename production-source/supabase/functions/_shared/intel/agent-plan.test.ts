import {assertEquals as eq,assertRejects} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {agentPlanHash,validateAgentPlan,AGENT_TOOL_RISK} from './agent-plan.ts'
import {executeAgentPlan} from './agent-write.ts'
import {AgentAuthError,type AgentContext} from './agent-token.ts'

const orgId='00000000-0000-4000-8000-000000000001'
const userId='10000000-0000-4000-8000-000000000001'
const tokenId='20000000-0000-4000-8000-000000000001'
const planId='40000000-0000-4000-8000-000000000001'
const ruleId='50000000-0000-4000-8000-000000000001'
const thesisId='60000000-0000-4000-8000-000000000001'

function dbMock(handlers:Record<string,{data?:unknown;error?:unknown}>) {
 const calls:any[]=[]
 const make=(key:string)=>{
  const answer=()=>({data:null,error:null,...(handlers[key]??{})})
  const query:any=new Proxy({},{get:(_t,prop)=>prop==='then'
   ?(resolve:any)=>Promise.resolve(answer()).then(resolve)
   :(...args:any[])=>{calls.push([prop,...args]);return query}})
  return query
 }
 return {
  calls,
  from:(name:string)=>{calls.push(['from',name]);return make(name)},
  rpc:(name:string,args:unknown)=>{calls.push(['rpc',name,args]);return make(`rpc:${name}`)},
 }
}

const context=(scopes:string[]):AgentContext=>({
 tokenId,userId,orgId,tokenName:'Laptop agent',scopes:scopes as any,role:'owner',
 actor:{human_user_id:userId,org_id:orgId,role:'owner',token_id:tokenId,source:'agent_token',request_id:''},
})
const alertConfig=()=>({asset:'native:bitcoin',threshold_usd:70000,direction:'above',title:'BTC above 70k',note:'watch'})
const base={toolKey:'intel_create_alert',target:{asset:'native:bitcoin'},payload:{a:1,b:'two'},riskLevel:2}
const storedPlan=(over:Record<string,unknown>={})=>({
 id:planId,org_id:orgId,user_id:userId,token_id:tokenId,tool_key:'intel_create_alert',
 target:{asset:'native:bitcoin'},payload:{config:alertConfig(),active:false,cooldownMinutes:60},
 plan_hash:'a'.repeat(64),risk_level:2,status:'approved',...over,
})
const allowed={data:{allowed:true,reason_code:'ok'}}

Deno.test('the hash covers the tool, the target, the payload and the risk level',async()=>{
 const original=await agentPlanHash(base)
 for(const change of [
  {toolKey:'intel_annotate_chart'},
  {target:{asset:'native:ethereum'}},
  {payload:{a:2,b:'two'}},
  {payload:{a:1,b:'two',c:'smuggled'}},
  {riskLevel:1},
 ]){
  const changed=await agentPlanHash({...base,...change} as any)
  eq(changed===original,false)
 }
 eq(await agentPlanHash(base),original)
})

Deno.test('formatting is not a change, so a reworded proposal does not cost a second approval',async()=>{
 const original=await agentPlanHash(base)
 // Key order and surrounding whitespace do not change what happens.
 eq(await agentPlanHash({...base,payload:{b:'two',a:1}}),original)
 eq(await agentPlanHash({...base,payload:{a:1,b:'  two  '}}),original)
 // A different value does.
 eq(await agentPlanHash({...base,payload:{a:1,b:'twol'}})===original,false)
})

Deno.test('an approval cannot be replayed against a changed plan',async()=>{
 // The plan a person approved.
 const approvedPayload={config:alertConfig(),active:false,cooldownMinutes:60}
 const approvedHash=await agentPlanHash({toolKey:'intel_create_alert',target:{asset:'native:bitcoin'},payload:approvedPayload,riskLevel:2})

 // The same proposal, quietly switched from a draft to a live alert after the
 // approval was given. The hash no longer matches, so the approval is spent on
 // a plan that no longer exists.
 const tamperedHash=await agentPlanHash({toolKey:'intel_create_alert',target:{asset:'native:bitcoin'},payload:{...approvedPayload,active:true},riskLevel:2})
 eq(tamperedHash===approvedHash,false)

 // The database gate is what notices in production. Its verdict is surfaced as
 // a refusal with the reason, never as a silent no-op.
 const gated=dbMock({'rpc:intel_agent_execution_gate':{data:{allowed:false,reason_code:'plan_changed',reason:'The proposal changed after it was approved. It needs approving again.'}}})
 const refusal=await assertRejects(()=>executeAgentPlan(gated,context(['read:alerts','write:alerts']),planId),AgentAuthError) as AgentAuthError
 eq(refusal.code,'plan_changed')
 eq(refusal.status,409)
 // Nothing was written.
 eq(gated.calls.some(c=>c[0]==='rpc'&&c[1]==='intel_save_chart_alert'),false)

 // Defence in depth: even if the gate is passed, the hash is recomputed from
 // the row that is actually stored, and a plan that does not match its own hash
 // does not run.
 const tampered=dbMock({'rpc:intel_agent_execution_gate':allowed,intel_agent_plans:{data:storedPlan({plan_hash:approvedHash,payload:{...approvedPayload,active:true}})}})
 const mismatch=await assertRejects(()=>executeAgentPlan(tampered,context(['read:alerts','write:alerts']),planId),AgentAuthError) as AgentAuthError
 eq(mismatch.code,'plan_hash_mismatch')
 eq(tampered.calls.some(c=>c[0]==='rpc'&&c[1]==='intel_save_chart_alert'),false)
 // The mismatch is recorded as a failed verification rather than discarded.
 const verification=tampered.calls.find(c=>c[0]==='insert'&&c[1]?.verification_type==='plan_integrity')
 eq(verification[1].status,'failed')
 eq(tampered.calls.some(c=>c[0]==='update'&&c[1]?.failure_reason==='plan_hash_mismatch'),true)
})

Deno.test('a proposal is validated by the contract the human editor uses, not by the agent',async()=>{
 const db=dbMock({})
 for(const config of [
  {...alertConfig(),threshold_usd:-1},
  {...alertConfig(),direction:'sideways'},
  {...alertConfig(),asset:'BTC'},
  {...alertConfig(),title:''},
 ]){
  await assertRejects(()=>validateAgentPlan(db,context(['read:alerts','write:alerts']),{tool:'intel_create_alert',config}))
 }
 await assertRejects(()=>validateAgentPlan(db,context(['read:alerts','write:alerts']),{tool:'intel_transfer_funds',config:alertConfig()}),AgentAuthError)
})

Deno.test('an agent-proposed alert is a draft unless the proposal says otherwise, and liveness is part of the hash',async()=>{
 const db=dbMock({})
 const draft=await validateAgentPlan(db,context(['read:alerts','write:alerts']),{tool:'intel_create_alert',config:alertConfig()})
 eq(draft.payload.active,false)
 eq(draft.riskLevel,AGENT_TOOL_RISK.intel_create_alert)
 eq(draft.summary.includes('draft'),true)

 const live=await validateAgentPlan(db,context(['read:alerts','write:alerts']),{tool:'intel_create_alert',config:alertConfig(),active:true})
 eq(live.payload.active,true)
 // Flipping a draft to live is a different write and therefore a different hash.
 eq(live.planHash===draft.planHash,false)
})

Deno.test('a write that reports success but does not land is reported as a failure',async()=>{
 const db=dbMock({
  'rpc:intel_agent_execution_gate':allowed,
  intel_agent_plans:{data:storedPlan({plan_hash:await agentPlanHash({toolKey:'intel_create_alert',target:{asset:'native:bitcoin'},payload:{config:alertConfig(),active:false,cooldownMinutes:60},riskLevel:2})})},
  'rpc:intel_save_chart_alert':{data:{id:ruleId}},
  // The RPC said it saved. The re-read says there is no such row.
  intel_alert_rules:{data:null},
 })
 const result=await executeAgentPlan(db,context(['read:alerts','write:alerts']),planId)
 eq(result.status,'failed')
 eq(result.verification.status,'failed')
 eq(result.verification.message.includes('did not land'),true)
 eq(db.calls.some(c=>c[0]==='update'&&c[1]?.status==='failed'),true)
})

Deno.test('a write that lands in another workspace is a failure, not a success',async()=>{
 const hash=await agentPlanHash({toolKey:'intel_create_alert',target:{asset:'native:bitcoin'},payload:{config:alertConfig(),active:false,cooldownMinutes:60},riskLevel:2})
 const db=dbMock({
  'rpc:intel_agent_execution_gate':allowed,
  intel_agent_plans:{data:storedPlan({plan_hash:hash})},
  'rpc:intel_save_chart_alert':{data:{id:ruleId}},
  intel_alert_rules:{data:{id:ruleId,org_id:'00000000-0000-4000-8000-0000000000ff',user_id:userId,is_active:false,config:alertConfig()}},
 })
 const result=await executeAgentPlan(db,context(['read:alerts','write:alerts']),planId)
 eq(result.status,'failed')
 eq(result.verification.message.includes('different workspace'),true)
})

Deno.test('a verified write reports what it confirmed and spends its approval',async()=>{
 const hash=await agentPlanHash({toolKey:'intel_create_alert',target:{asset:'native:bitcoin'},payload:{config:alertConfig(),active:false,cooldownMinutes:60},riskLevel:2})
 const db=dbMock({
  'rpc:intel_agent_execution_gate':allowed,
  intel_agent_plans:{data:storedPlan({plan_hash:hash})},
  'rpc:intel_save_chart_alert':{data:{id:ruleId}},
  intel_alert_rules:{data:{id:ruleId,org_id:orgId,user_id:userId,is_active:false,config:alertConfig()}},
 })
 const result=await executeAgentPlan(db,context(['read:alerts','write:alerts']),planId)
 eq(result.status,'executed')
 eq(result.verification.status,'passed')
 eq(result.recordId,ruleId)
 // The operation id handed to the idempotent RPC is the proposal id, so a
 // replayed execution is the same operation rather than a second alert.
 const rpc=db.calls.find(c=>c[0]==='rpc'&&c[1]==='intel_save_chart_alert')
 eq(rpc[2].p_operation,planId)
 eq(rpc[2].p_org,orgId)
 eq(rpc[2].p_user,userId)
 eq(db.calls.some(c=>c[0]==='update'&&c[1]?.status==='consumed'),true)
})

Deno.test('thesis evidence is appended as manual evidence, keyed so a replay writes nothing twice',async()=>{
 const payload={title:'Filing published',summary:'The issuer filed.',url:'https://example.test/a',eventType:'news',eventAt:null}
 const hash=await agentPlanHash({toolKey:'intel_append_thesis_evidence',target:{thesisId},payload,riskLevel:1})
 const db=dbMock({
  'rpc:intel_agent_execution_gate':allowed,
  intel_agent_plans:{data:storedPlan({tool_key:'intel_append_thesis_evidence',target:{thesisId},payload,plan_hash:hash,risk_level:1})},
  intel_thesis_evidence:{data:{id:ruleId,org_id:orgId,thesis_id:thesisId,source_table:'manual',source_ref:`agent:${hash.slice(0,48)}`,event_snapshot:{title:payload.title}}},
 })
 const result=await executeAgentPlan(db,context(['read:thesis','write:thesis']),planId)
 eq(result.status,'executed')
 const upsert=db.calls.find(c=>c[0]==='upsert')
 eq(upsert[1][0].source_table,'manual')
 eq(upsert[1][0].source_ref,`agent:${hash.slice(0,48)}`)
 eq(upsert[2].onConflict,'thesis_id,source_table,source_ref')
 // The engine owns the verdict; the agent contributes the observation.
 eq(upsert[1][0].impact,null)
})
