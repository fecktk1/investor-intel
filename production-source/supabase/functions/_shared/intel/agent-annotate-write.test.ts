// The annotate-chart write, end to end: propose, gate, hash check, append
// through the chart editor's own validator and revision check, re-read, record
// the verification.

import {assertEquals as eq,assertRejects} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {agentPlanHash,validateAgentPlan} from './agent-plan.ts'
import {executeAgentPlan} from './agent-write.ts'
import {agentReadService} from './agent-service.ts'
import {AgentAuthError,type AgentContext} from './agent-token.ts'
import {validateChartLayout} from './chart-workspace-contract.ts'

const orgId='00000000-0000-4000-8000-000000000001'
const otherOrg='00000000-0000-4000-8000-0000000000ff'
const userId='10000000-0000-4000-8000-000000000001'
const tokenId='20000000-0000-4000-8000-000000000001'
const layoutId='30000000-0000-4000-8000-000000000001'
const planId='40000000-0000-4000-8000-000000000001'
const humanDrawingId='70000000-0000-4000-8000-000000000001'
const agentDrawingId='70000000-0000-4000-8000-000000000002'

/** Records every call. A list handler is answered in order, because the layout
 * is read at execution time and read again to verify. */
function dbMock(handlers:Record<string,{data?:unknown;error?:unknown}|{data?:unknown;error?:unknown}[]>) {
 const calls:any[]=[]
 const served:Record<string,number>={}
 const make=(key:string)=>{
  const answer=()=>{
   const handler=handlers[key]
   if(Array.isArray(handler)){
    const index=served[key]=(served[key]??-1)+1
    return {data:null,error:null,...(handler[Math.min(index,handler.length-1)]??{})}
   }
   return {data:null,error:null,...(handler??{})}
  }
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

const context=(scopes=['read:charts','write:charts']):AgentContext=>({
 tokenId,userId,orgId,tokenName:'Laptop agent',scopes:scopes as any,role:'owner',
 actor:{human_user_id:userId,org_id:orgId,role:'owner',token_id:tokenId,source:'agent_token',request_id:''},
})
const allowed={data:{allowed:true,reason_code:'ok'}}

const humanDrawing={id:humanDrawingId,tool:'horizontal',anchors:[{t:1788998400000,price:65000}],text:'',color:'#DFA647',width:2}
const agentDrawing=(over:Record<string,unknown>={})=>({id:agentDrawingId,tool:'text',anchors:[{t:1789084800000,price:71000}],text:'Breakout above the range',color:'#22C55E',width:2,...over})
const layoutState=(drawings:unknown[]=[humanDrawing])=>({schemaVersion:1,asset:'native:bitcoin',range:{from:1780000000000,to:1790000000000},studies:[],drawings})
const layoutRow=(over:Record<string,unknown>={})=>({id:layoutId,org_id:orgId,user_id:userId,asset:'native:bitcoin',title:'BTC daily',revision:7,state:layoutState(),...over})

/** The plan exactly as the proposal step would store it, with its real hash. */
async function storedPlan(drawing:Record<string,unknown>=agentDrawing(),over:Record<string,unknown>={}) {
 const draft=await validateAgentPlan(dbMock({intel_chart_layouts:{data:layoutRow()}}),context(),{tool:'intel_annotate_chart',layoutId,drawing})
 return {id:planId,org_id:orgId,user_id:userId,token_id:tokenId,tool_key:draft.toolKey,target:draft.target,payload:draft.payload,plan_hash:draft.planHash,risk_level:draft.riskLevel,status:'approved',...over}
}

const rpcCalls=(db:any,name:string)=>db.calls.filter((c:any[])=>c[0]==='rpc'&&c[1]===name)
const verificationInserts=(db:any)=>db.calls.filter((c:any[])=>c[0]==='insert'&&c[1]?.plan_id===planId)
const planUpdates=(db:any)=>db.calls.filter((c:any[])=>c[0]==='update'&&('failure_reason' in (c[1]??{})||'result' in (c[1]??{})||c[1]?.status==='failed'))

Deno.test('annotate chart: the proposal targets the re-read layout and hashes exactly the validated drawing',async()=>{
 const db=dbMock({intel_chart_layouts:{data:layoutRow()}})
 const draft=await validateAgentPlan(db,context(),{tool:'intel_annotate_chart',layoutId,drawing:agentDrawing()})
 eq(draft.toolKey,'intel_annotate_chart')
 eq(draft.riskLevel,1)
 eq(draft.target,{layoutId,asset:'native:bitcoin'})
 eq(draft.payload.drawing,{id:agentDrawingId,tool:'text',anchors:[{t:1789084800000,price:71000}],text:'Breakout above the range',color:'#22C55E',width:2})
 eq(draft.planHash,await agentPlanHash({toolKey:'intel_annotate_chart',target:draft.target,payload:draft.payload,riskLevel:1}))
 eq(draft.summary.includes('BTC daily'),true)
 // A different annotation is a different write and so a different hash.
 const moved=await validateAgentPlan(db,context(),{tool:'intel_annotate_chart',layoutId,drawing:agentDrawing({anchors:[{t:1789084800000,price:72000}]})})
 eq(moved.planHash===draft.planHash,false)
})

Deno.test('annotate chart: an approved write appends the drawing through the editor contract, verifies it, and records the verification',async()=>{
 const plan=await storedPlan()
 const saved=layoutRow({revision:8,state:validateChartLayout(layoutState([humanDrawing,agentDrawing()]))})
 const db=dbMock({
  'rpc:intel_agent_execution_gate':allowed,
  intel_agent_plans:{data:plan},
  intel_chart_layouts:[{data:layoutRow()},{data:saved}],
  'rpc:intel_save_chart_layout':{data:{id:layoutId,revision:8}},
 })
 const result=await executeAgentPlan(db,context(),planId)

 eq(result.status,'executed')
 eq(result.tool,'intel_annotate_chart')
 eq(result.recordId,layoutId)
 eq(result.verification.status,'passed')

 // The gate is asked first, for this plan and this token.
 eq(db.calls.findIndex((c:any[])=>c[0]==='rpc'&&c[1]==='intel_agent_execution_gate')<db.calls.findIndex((c:any[])=>c[0]==='rpc'&&c[1]==='intel_save_chart_layout'),true)
 eq(rpcCalls(db,'intel_agent_execution_gate')[0][2],{p_plan_id:planId,p_token_id:tokenId})

 // One save, through the same RPC and the same revision check the editor uses.
 const saves=rpcCalls(db,'intel_save_chart_layout')
 eq(saves.length,1)
 const args=saves[0][2]
 eq(args.p_org,orgId)
 eq(args.p_user,userId)
 eq(args.p_id,layoutId)
 // The revision is the one read immediately before the save, so a concurrent
 // edit in between is a conflict rather than a silent overwrite.
 eq(args.p_revision,7)
 // The proposal id is the operation id, so a replay is the same operation.
 eq(args.p_operation,planId)
 eq(args.p_title,'BTC daily')
 // The member's own drawing is kept, the agent's is appended, and the whole
 // layout is the validated shape.
 eq(args.p_state.drawings.map((d:any)=>d.id),[humanDrawingId,agentDrawingId])
 eq(args.p_state,validateChartLayout(layoutState([humanDrawing,agentDrawing()])))

 // The layout reads are pinned to the plan's org and member.
 const filters=db.calls.filter((c:any[])=>c[0]==='eq').map((c:any[])=>`${c[1]}=${c[2]}`)
 eq(filters.includes(`org_id=${orgId}`),true)
 eq(filters.includes(`user_id=${userId}`),true)

 // The verification row says what was expected, what was observed, and where.
 const [verification]=verificationInserts(db)
 eq(verification[1],{
  org_id:orgId,plan_id:planId,verification_type:'intel_annotate_chart',
  expected_state:{drawing_present:true},observed_state:{drawing_present:true},
  status:'passed',evidence:{message:'Confirmed by re-reading the annotation.'},
 })
 const executed=db.calls.find((c:any[])=>c[0]==='update'&&c[1]?.status==='executed')
 eq(executed[1].result,{record_id:layoutId,verification:'passed'})
 eq(db.calls.some((c:any[])=>c[0]==='update'&&c[1]?.status==='consumed'),true)
})

Deno.test('annotate chart: a concurrent edit is refused as a revision conflict and nothing is verified as written',async()=>{
 for(const code of ['PT409','40001']){
  const db=dbMock({
   'rpc:intel_agent_execution_gate':allowed,
   intel_agent_plans:{data:await storedPlan()},
   intel_chart_layouts:{data:layoutRow()},
   'rpc:intel_save_chart_layout':{error:{code,message:'chart_revision_conflict'}},
  })
  const error=await assertRejects(()=>executeAgentPlan(db,context(),planId),AgentAuthError) as AgentAuthError
  eq(error.code,'chart_revision_conflict')
  eq(error.status,409)
  // The plan is failed with the reason, so the approval cannot be silently retried.
  eq(db.calls.some((c:any[])=>c[0]==='update'&&c[1]?.status==='failed'&&c[1]?.failure_reason==='chart_revision_conflict'),true)
  eq(verificationInserts(db).some((c:any[])=>c[1].status==='passed'),false)
  // No re-read claims a success after the refused save.
  eq(db.calls.filter((c:any[])=>c[0]==='from'&&c[1]==='intel_chart_layouts').length,1)
 }
})

Deno.test('annotate chart: an invalid drawing is refused at proposal time and never stored',async()=>{
 for(const drawing of [
  agentDrawing({id:'not-a-uuid'}),
  agentDrawing({tool:'laser'}),
  agentDrawing({anchors:[]}),
  agentDrawing({anchors:[{t:1789084800000,price:-1}]}),
  agentDrawing({color:'red'}),
  agentDrawing({width:9}),
  agentDrawing({url:'https://x.com/a/status/1'}),
  'a drawing',
  null,
 ]){
  const db=dbMock({intel_chart_layouts:{data:layoutRow()}})
  const error=await assertRejects(()=>agentReadService(db,context(),{operation:'propose_write',tool:'intel_annotate_chart',layoutId,drawing})) as Error
  // A named refusal the handler turns into a 400, never a stored proposal.
  eq(/^(invalid_|drawing_)/.test(error.message),true,error.message)
  eq(db.calls.some((c:any[])=>c[0]==='insert'),false)
 }
 // An id that is not a layout id is refused before any read.
 const db=dbMock({})
 const error=await assertRejects(()=>agentReadService(db,context(),{operation:'propose_write',tool:'intel_annotate_chart',layoutId:'layout-1',drawing:agentDrawing()}),AgentAuthError) as AgentAuthError
 eq(error.code,'invalid_chart_id')
 eq(db.calls.some((c:any[])=>c[0]==='from'),false)
})

Deno.test('annotate chart: a stored drawing the layout contract rejects is not saved, even with a matching hash',async()=>{
 // Defence in depth. A payload that reached the plans table without passing the
 // drawing validator, with a hash computed over it, still meets the layout
 // validator at execution time.
 const target={layoutId,asset:'native:bitcoin'}
 const payload={drawing:{id:agentDrawingId,tool:'text',anchors:[],text:'x',color:'#22C55E',width:2}}
 const hash=await agentPlanHash({toolKey:'intel_annotate_chart',target,payload,riskLevel:1})
 const db=dbMock({
  'rpc:intel_agent_execution_gate':allowed,
  intel_agent_plans:{data:{id:planId,org_id:orgId,user_id:userId,token_id:tokenId,tool_key:'intel_annotate_chart',target,payload,plan_hash:hash,risk_level:1,status:'approved'}},
  intel_chart_layouts:{data:layoutRow()},
 })
 const error=await assertRejects(()=>executeAgentPlan(db,context(),planId),AgentAuthError) as AgentAuthError
 eq(error.code,'agent_write_failed')
 eq(error.message.includes('invalid_drawing'),true)
 eq(rpcCalls(db,'intel_save_chart_layout').length,0)
 eq(db.calls.some((c:any[])=>c[0]==='update'&&c[1]?.status==='failed'&&c[1]?.failure_reason==='invalid_drawing'),true)
})

Deno.test('annotate chart: an approval signed for a different hash refuses execution before the layout is touched',async()=>{
 const db=dbMock({'rpc:intel_agent_execution_gate':{data:{allowed:false,reason_code:'plan_changed',reason:'The proposal changed after it was approved. It needs approving again.'}}})
 const error=await assertRejects(()=>executeAgentPlan(db,context(),planId),AgentAuthError) as AgentAuthError
 eq(error.code,'plan_changed')
 eq(error.status,409)
 eq(db.calls.some((c:any[])=>c[0]==='from'&&c[1]==='intel_chart_layouts'),false)
 eq(rpcCalls(db,'intel_save_chart_layout').length,0)
})

Deno.test('annotate chart: a stored plan that no longer matches its own hash is refused and recorded as a failed integrity check',async()=>{
 const approved=await storedPlan()
 // The approved hash, over a drawing that was moved afterwards.
 const tampered={...approved,payload:{drawing:{...approved.payload.drawing as Record<string,unknown>,anchors:[{t:1789084800000,price:1}]}}}
 const db=dbMock({'rpc:intel_agent_execution_gate':allowed,intel_agent_plans:{data:tampered},intel_chart_layouts:{data:layoutRow()}})
 const error=await assertRejects(()=>executeAgentPlan(db,context(),planId),AgentAuthError) as AgentAuthError
 eq(error.code,'plan_hash_mismatch')
 eq(error.status,409)
 eq(rpcCalls(db,'intel_save_chart_layout').length,0)
 eq(db.calls.some((c:any[])=>c[0]==='from'&&c[1]==='intel_chart_layouts'),false)
 const [verification]=verificationInserts(db)
 eq(verification[1].verification_type,'plan_integrity')
 eq(verification[1].status,'failed')
 eq(verification[1].expected_state,{plan_hash:approved.plan_hash})
 eq(verification[1].observed_state.plan_hash===approved.plan_hash,false)
 eq(db.calls.some((c:any[])=>c[0]==='update'&&c[1]?.failure_reason==='plan_hash_mismatch'),true)
})

Deno.test('annotate chart: a save that reports success but whose drawing is missing on re-read is a failure',async()=>{
 const db=dbMock({
  'rpc:intel_agent_execution_gate':allowed,
  intel_agent_plans:{data:await storedPlan()},
  // The re-read comes back without the agent's drawing.
  intel_chart_layouts:[{data:layoutRow()},{data:layoutRow({revision:8})}],
  'rpc:intel_save_chart_layout':{data:{id:layoutId,revision:8}},
 })
 const result=await executeAgentPlan(db,context(),planId)
 eq(result.status,'failed')
 eq(result.verification.status,'failed')
 eq(result.verification.expected,{drawing_present:true})
 eq(result.verification.observed,{drawing_present:false})
 const [verification]=verificationInserts(db)
 eq(verification[1].status,'failed')
 eq(verification[1].verification_type,'intel_annotate_chart')
 eq(planUpdates(db).some((c:any[])=>c[1].status==='failed'),true)
})

Deno.test('annotate chart: a layout that re-reads in another workspace is a failure, not a success',async()=>{
 const db=dbMock({
  'rpc:intel_agent_execution_gate':allowed,
  intel_agent_plans:{data:await storedPlan()},
  intel_chart_layouts:[{data:layoutRow()},{data:layoutRow({org_id:otherOrg,state:layoutState([humanDrawing,agentDrawing()])})}],
  'rpc:intel_save_chart_layout':{data:{id:layoutId,revision:8}},
 })
 const result=await executeAgentPlan(db,context(),planId)
 eq(result.status,'failed')
 eq(result.verification.message.includes('different workspace'),true)
})

Deno.test('annotate chart: a layout deleted since the proposal is refused by name and nothing is saved',async()=>{
 const db=dbMock({'rpc:intel_agent_execution_gate':allowed,intel_agent_plans:{data:await storedPlan()},intel_chart_layouts:{data:null}})
 const error=await assertRejects(()=>executeAgentPlan(db,context(),planId),AgentAuthError) as AgentAuthError
 eq(error.code,'chart_layout_not_found')
 eq(error.status,404)
 eq(rpcCalls(db,'intel_save_chart_layout').length,0)
})

Deno.test('annotate chart: a replay of the same annotation writes nothing twice and passes',async()=>{
 const db=dbMock({
  'rpc:intel_agent_execution_gate':allowed,
  intel_agent_plans:{data:await storedPlan()},
  // Stored with its keys in a different order, which is still the same drawing.
  intel_chart_layouts:{data:layoutRow({state:layoutState([humanDrawing,{width:2,color:'#22C55E',text:'Breakout above the range',anchors:[{price:71000,t:1789084800000}],tool:'text',id:agentDrawingId}])})},
 })
 const result=await executeAgentPlan(db,context(),planId)
 eq(result.status,'executed')
 eq(result.verification.status,'passed')
 eq(rpcCalls(db,'intel_save_chart_layout').length,0)
})

Deno.test('annotate chart: a different drawing under the same id is not mistaken for the approved annotation',async()=>{
 // An agent with read:charts can see the member's drawing ids. Proposing an
 // annotation under one of those ids must not let the idempotency shortcut
 // report the approved annotation as present when it is not, and must not
 // replace the member's drawing.
 const db=dbMock({
  'rpc:intel_agent_execution_gate':allowed,
  intel_agent_plans:{data:await storedPlan(agentDrawing({id:humanDrawingId}))},
  intel_chart_layouts:{data:layoutRow()},
 })
 const result=await executeAgentPlan(db,context(),planId)
 eq(result.status,'failed')
 eq(result.verification.status,'failed')
 eq(result.verification.observed,{drawing_id:humanDrawingId,drawing_matches:false})
 eq(rpcCalls(db,'intel_save_chart_layout').length,0)
 const [verification]=verificationInserts(db)
 eq(verification[1].status,'failed')
 eq(db.calls.some((c:any[])=>c[0]==='update'&&c[1]?.status==='failed'),true)
})
