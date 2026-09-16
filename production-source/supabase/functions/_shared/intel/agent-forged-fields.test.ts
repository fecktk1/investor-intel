// An agent does not get to say what it is touching.
//
// Every write tool derives its target on the server: an alert's target is the
// asset of the validated config, an annotation's target is the layout re-read
// from the database, a thesis append's target is the thesis re-read from the
// database, and an evidence row's source_ref is derived from the approved plan
// hash. These tests send the fields an attacker would forge (target, targetId,
// source_ref, org_id, user_id, token_id, plan_hash, risk_level, status, actor,
// impact, visibility and friends) and assert that each one is either refused
// or has no effect at all: the stored plan carries the server-derived target and
// the hash of the server-derived plan, identical to the same proposal sent
// without the forged fields.

import {assertEquals as eq,assertRejects} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {agentPlanHash,AGENT_TOOL_RISK} from './agent-plan.ts'
import {executeAgentPlan} from './agent-write.ts'
import {chartAlertConfig} from './chart-alert-service.ts'
import {agentManagementService,agentReadService} from './agent-service.ts'
import {AgentAuthError,type AgentContext} from './agent-token.ts'

const orgId='00000000-0000-4000-8000-000000000001'
const otherOrg='00000000-0000-4000-8000-0000000000ff'
const userId='10000000-0000-4000-8000-000000000001'
const otherUser='10000000-0000-4000-8000-0000000000ff'
const tokenId='20000000-0000-4000-8000-000000000001'
const otherToken='20000000-0000-4000-8000-0000000000ff'
const layoutId='30000000-0000-4000-8000-000000000001'
const otherLayout='30000000-0000-4000-8000-0000000000ff'
const planId='40000000-0000-4000-8000-000000000001'
const ruleId='50000000-0000-4000-8000-000000000001'
const otherRule='50000000-0000-4000-8000-0000000000ff'
const thesisId='60000000-0000-4000-8000-000000000001'
const otherThesis='60000000-0000-4000-8000-0000000000ff'
const drawingId='70000000-0000-4000-8000-000000000001'
const forgedHash='f'.repeat(64)
const forgedRef='engine:cmc:1:2026-09-16'

// Every value a forged field carries. None of them may appear in any database
// call the service makes, as a filter, a row, or an RPC argument.
const FORGED_VALUES=[otherOrg,otherUser,otherToken,otherLayout,otherRule,otherThesis,forgedHash,forgedRef,'native:ethereum']

/** Records every call. A handler may be a list, answered in order, for a table
 * that is read more than once in one operation. */
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

const context=(scopes:string[]):AgentContext=>({
 tokenId,userId,orgId,tokenName:'Laptop agent',scopes:scopes as any,role:'owner',
 actor:{human_user_id:userId,org_id:orgId,role:'owner',token_id:tokenId,source:'agent_token',request_id:'req-1'},
})

/** The fields an attacker would add to any proposal body. */
const forgedEnvelope=()=>({
 org_id:otherOrg,orgId:otherOrg,user_id:otherUser,userId:otherUser,token_id:otherToken,tokenId:otherToken,
 plan_hash:forgedHash,planHash:forgedHash,risk_level:0,riskLevel:0,status:'approved',
 summary:'Harmless read-only check',expires_at:'2099-01-01T00:00:00.000Z',expiresAt:'2099-01-01T00:00:00.000Z',
 actor:{human_user_id:otherUser,org_id:otherOrg,token_id:otherToken,source:'session'},
 source_ref:forgedRef,sourceRef:forgedRef,source_table:'cmc',sourceTable:'cmc',
 impact:'confirms',impact_source:'user',visibility:'org',id:otherRule,recordId:otherRule,
})

const alertConfig=()=>({asset:'native:bitcoin',threshold_usd:70000,direction:'above',title:'BTC above 70k',note:'watch'})
// The alert contract canonicalises the asset key, and that canonical key is the target.
const canonicalConfig=()=>chartAlertConfig(alertConfig())
const btc=canonicalConfig().asset
const drawing=()=>({id:drawingId,tool:'text',anchors:[{t:1788998400000,price:100}],text:'Breakout level',color:'#DFA647',width:2})
const layoutRow={id:layoutId,asset:'native:bitcoin',title:'BTC daily',revision:4}
const thesisRow={id:thesisId}

/** Propose through the real service, the way the handler does, and return the
 * row that would have been stored. */
async function propose(scopes:string[],body:Record<string,unknown>,handlers:Record<string,any>) {
 const db=dbMock({...handlers,intel_agent_plans:{data:{id:planId,status:'proposed'}}})
 await agentReadService(db,context(scopes),{operation:'propose_write',...body})
 const insert=db.calls.find(c=>c[0]==='insert')
 return {db,row:insert[1]}
}

const noForgedValueReachedTheDatabase=(calls:any[])=>{
 const serialized=JSON.stringify(calls)
 for(const value of FORGED_VALUES)eq(serialized.includes(value),false,`forged value ${value} reached the database`)
}

const assertStoredPlanIsServerDerived=(row:any,expected:{toolKey:string;target:Record<string,unknown>;payload:Record<string,unknown>;hash:string})=>{
 eq(row.org_id,orgId)
 eq(row.user_id,userId)
 eq(row.token_id,tokenId)
 eq(row.tool_key,expected.toolKey)
 eq(row.target,expected.target)
 eq(row.payload,expected.payload)
 eq(row.plan_hash,expected.hash)
 eq(row.risk_level,AGENT_TOOL_RISK[expected.toolKey as keyof typeof AGENT_TOOL_RISK])
 // The actor is the token's, never the body's.
 eq(row.actor,context([]).actor)
 // A proposal is born proposed. The body cannot pre-approve it.
 eq('status' in row,false)
 eq(row.summary==='Harmless read-only check',false)
}

Deno.test('intel_create_alert: a forged target, org, hash or record id is ignored and the stored plan is server-derived',async()=>{
 const scopes=['read:alerts','write:alerts']
 const clean=await propose(scopes,{tool:'intel_create_alert',config:alertConfig()},{})
 const forged=await propose(scopes,{
  tool:'intel_create_alert',
  ...forgedEnvelope(),
  target:{asset:'native:ethereum',ruleId:otherRule,org_id:otherOrg},targetId:otherRule,ruleId:otherRule,
  // Forged fields inside the config itself are dropped by the member's own
  // alert contract, which rebuilds the config from a closed list.
  config:{...alertConfig(),org_id:otherOrg,user_id:otherUser,id:otherRule,source_ref:forgedRef},
 },{})

 const payload={config:canonicalConfig(),active:false,cooldownMinutes:60}
 const hash=await agentPlanHash({toolKey:'intel_create_alert',target:{asset:btc},payload,riskLevel:2})
 assertStoredPlanIsServerDerived(forged.row,{toolKey:'intel_create_alert',target:{asset:btc},payload,hash})
 eq(forged.row.plan_hash,clean.row.plan_hash)
 eq(Object.keys(forged.row.payload.config).sort(),Object.keys(clean.row.payload.config).sort())
 noForgedValueReachedTheDatabase(forged.db.calls)
})

Deno.test('intel_create_alert: the target is the asset of the validated config, so a forged target cannot redirect the alert',async()=>{
 // The config names bitcoin and the forged target names ethereum. The alert
 // that would be created is on bitcoin, and the approval a person sees and signs
 // says bitcoin.
 const {row}=await propose(['read:alerts','write:alerts'],{tool:'intel_create_alert',config:alertConfig(),target:{asset:'native:ethereum'}},{})
 eq(row.target,{asset:btc})
 eq(row.summary.includes(btc),true)
 eq(row.summary.includes('native:ethereum'),false)
})

Deno.test('intel_annotate_chart: a forged target layout, org or hash is ignored and the target is the re-read layout',async()=>{
 const scopes=['read:charts','write:charts']
 const clean=await propose(scopes,{tool:'intel_annotate_chart',layoutId,drawing:drawing()},{intel_chart_layouts:{data:layoutRow}})
 const forged=await propose(scopes,{
  tool:'intel_annotate_chart',layoutId,
  ...forgedEnvelope(),
  target:{layoutId:otherLayout,asset:'native:ethereum'},targetId:otherLayout,chartId:otherLayout,layout_id:otherLayout,
  drawing:{...drawing(),org_id:otherOrg,layoutId:otherLayout,source_ref:forgedRef},
 },{intel_chart_layouts:{data:layoutRow}})

 const payload={drawing:clean.row.payload.drawing}
 const hash=await agentPlanHash({toolKey:'intel_annotate_chart',target:{layoutId,asset:'native:bitcoin'},payload,riskLevel:1})
 assertStoredPlanIsServerDerived(forged.row,{toolKey:'intel_annotate_chart',target:{layoutId,asset:'native:bitcoin'},payload,hash})
 eq(forged.row.plan_hash,clean.row.plan_hash)
 // The layout read that established the target filtered on the token's org and member.
 const filters=forged.db.calls.filter(c=>c[0]==='eq').map(c=>[c[1],c[2]])
 eq(filters.some(([k,v])=>k==='id'&&v===layoutId),true)
 eq(filters.some(([k,v])=>k==='org_id'&&v===orgId),true)
 eq(filters.some(([k,v])=>k==='user_id'&&v===userId),true)
 noForgedValueReachedTheDatabase(forged.db.calls)
})

Deno.test('intel_annotate_chart: a layout that is not in this workspace is refused whatever target the body claims',async()=>{
 // The re-read finds nothing for the token's org and member. A forged target
 // naming a layout the agent wishes existed does not stand in for that row.
 const db=dbMock({intel_chart_layouts:{data:null}})
 const error=await assertRejects(()=>agentReadService(db,context(['read:charts','write:charts']),{
  operation:'propose_write',tool:'intel_annotate_chart',layoutId,drawing:drawing(),
  target:{layoutId,asset:'native:bitcoin'},org_id:otherOrg,
 }),AgentAuthError) as AgentAuthError
 eq(error.code,'chart_layout_not_found')
 eq(error.status,404)
 eq(db.calls.some(c=>c[0]==='insert'),false)
})

Deno.test('intel_append_thesis_evidence: a forged target thesis, source_ref, impact or visibility is ignored',async()=>{
 const scopes=['read:thesis','write:thesis']
 const evidence={title:'Filing published',summary:'The issuer filed.',url:'https://example.test/a'}
 const clean=await propose(scopes,{tool:'intel_append_thesis_evidence',thesisId,...evidence},{intel_theses:{data:thesisRow}})
 const forged=await propose(scopes,{
  // The envelope goes first so its forged display summary cannot stand in for
  // the evidence summary, which is a real field of this write.
  ...forgedEnvelope(),
  tool:'intel_append_thesis_evidence',thesisId,...evidence,
  target:{thesisId:otherThesis},targetId:otherThesis,thesis_id:otherThesis,
 },{intel_theses:{data:thesisRow}})

 const payload={title:'Filing published',summary:'The issuer filed.',url:'https://example.test/a',eventType:'news',eventAt:null}
 const hash=await agentPlanHash({toolKey:'intel_append_thesis_evidence',target:{thesisId},payload,riskLevel:1})
 assertStoredPlanIsServerDerived(forged.row,{toolKey:'intel_append_thesis_evidence',target:{thesisId},payload,hash})
 eq(forged.row.plan_hash,clean.row.plan_hash)
 // Nothing the body said about provenance or verdict made it into the payload.
 for(const key of ['source_ref','sourceRef','source_table','impact','impact_source','visibility'])eq(key in forged.row.payload,false)
 noForgedValueReachedTheDatabase(forged.db.calls)
})

Deno.test('intel_append_thesis_evidence: the evidence row takes its source_ref from the approved hash even if a stored payload carries one',async()=>{
 // Defence in depth at the execution layer. Suppose a payload carrying provenance
 // fields reached the plans table by some route, with a hash that matches it.
 // The writer still reads only the named evidence fields, so the row it writes
 // is keyed by the plan hash and cannot collide with engine-written evidence.
 const payload={title:'Filing published',summary:'The issuer filed.',url:'https://example.test/a',eventType:'news',eventAt:null,
  source_ref:forgedRef,source_table:'cmc',impact:'confirms',visibility:'org',org_id:otherOrg,thesis_id:otherThesis}
 const hash=await agentPlanHash({toolKey:'intel_append_thesis_evidence',target:{thesisId},payload,riskLevel:1})
 const db=dbMock({
  'rpc:intel_agent_execution_gate':{data:{allowed:true,reason_code:'ok'}},
  intel_agent_plans:{data:{id:planId,org_id:orgId,user_id:userId,token_id:tokenId,tool_key:'intel_append_thesis_evidence',target:{thesisId},payload,plan_hash:hash,risk_level:1,status:'approved'}},
  intel_thesis_evidence:{data:{id:ruleId,org_id:orgId,thesis_id:thesisId,source_table:'manual',source_ref:`agent:${hash.slice(0,48)}`,event_snapshot:{title:payload.title}}},
 })
 const result=await executeAgentPlan(db,context(['read:thesis','write:thesis']),planId)
 eq(result.status,'executed')
 const [row]=db.calls.find(c=>c[0]==='upsert')[1]
 eq(row.source_ref,`agent:${hash.slice(0,48)}`)
 eq(row.source_table,'manual')
 eq(row.impact,null)
 eq(row.visibility,'private')
 eq(row.org_id,orgId)
 eq(row.thesis_id,thesisId)
 eq(JSON.stringify(row).includes(forgedRef),false)
 eq(JSON.stringify(row).includes(otherOrg),false)
 eq(JSON.stringify(row).includes(otherThesis),false)
})

Deno.test('execute_write: forged hashes, orgs and targets in the body are ignored; only the proposal id and the token are used',async()=>{
 const payload={config:alertConfig(),active:false,cooldownMinutes:60}
 const hash=await agentPlanHash({toolKey:'intel_create_alert',target:{asset:'native:bitcoin'},payload,riskLevel:2})
 const db=dbMock({
  'rpc:intel_agent_execution_gate':{data:{allowed:true,reason_code:'ok'}},
  intel_agent_plans:{data:{id:planId,org_id:orgId,user_id:userId,token_id:tokenId,tool_key:'intel_create_alert',target:{asset:'native:bitcoin'},payload,plan_hash:hash,risk_level:2,status:'approved'}},
  'rpc:intel_save_chart_alert':{data:{id:ruleId}},
  intel_alert_rules:{data:{id:ruleId,org_id:orgId,user_id:userId,is_active:false,config:alertConfig()}},
 })
 const result=await agentReadService(db,context(['read:alerts','write:alerts']),{
  operation:'execute_write',planId,...forgedEnvelope(),
  target:{asset:'native:ethereum'},payload:{config:{...alertConfig(),asset:'native:ethereum'},active:true,cooldownMinutes:15},
  tool:'intel_annotate_chart',
 }) as any
 eq(result.status,'executed')
 eq(result.tool,'intel_create_alert')
 const gate=db.calls.find(c=>c[0]==='rpc'&&c[1]==='intel_agent_execution_gate')
 eq(gate[2],{p_plan_id:planId,p_token_id:tokenId})
 const save=db.calls.find(c=>c[0]==='rpc'&&c[1]==='intel_save_chart_alert')
 eq(save[2].p_org,orgId)
 eq(save[2].p_user,userId)
 // An agent cannot aim the write at an existing alert: the id is always null.
 eq(save[2].p_id,null)
 eq(save[2].p_active,false)
 eq(save[2].p_config.asset,'native:bitcoin')
 noForgedValueReachedTheDatabase(db.calls)
})

Deno.test('plan_approve: the approval signs the stored hash and org, never a hash or org the approving request supplies',async()=>{
 const storedHash='a'.repeat(64)
 const db=dbMock({
  intel_agent_plans:{data:{id:planId,org_id:orgId,user_id:userId,token_id:tokenId,plan_hash:storedHash,status:'proposed',expires_at:'2099-01-01T00:00:00.000Z'}},
  intel_agent_approvals:{data:{id:'approval-1',plan_hash:storedHash,expires_at:'2099-01-02T00:00:00.000Z'}},
 })
 const result=await agentManagementService(db,{orgId,userId},{operation:'plan_approve',planId,planHash:forgedHash,plan_hash:forgedHash,org_id:otherOrg,orgId:otherOrg,approved_by:otherUser,target:{asset:'native:ethereum'}}) as any
 eq(result.planHash,storedHash)
 const insert=db.calls.find(c=>c[0]==='insert')
 eq(insert[1].plan_hash,storedHash)
 eq(insert[1].org_id,orgId)
 eq(insert[1].approved_by,userId)
 eq(insert[1].plan_id,planId)
 noForgedValueReachedTheDatabase(db.calls)
})

Deno.test('a retried proposal is matched on the server-derived hash and the token, never on a hash the body supplies',async()=>{
 const payload={config:canonicalConfig(),active:false,cooldownMinutes:60}
 const hash=await agentPlanHash({toolKey:'intel_create_alert',target:{asset:btc},payload,riskLevel:2})
 const db=dbMock({intel_agent_plans:[
  {data:null,error:{message:'duplicate key value violates unique constraint',code:'23505'}},
  {data:{id:planId,status:'proposed',plan_hash:hash,target:{asset:btc}}},
 ]})
 const result=await agentReadService(db,context(['read:alerts','write:alerts']),{operation:'propose_write',tool:'intel_create_alert',config:alertConfig(),...forgedEnvelope()}) as any
 eq(result.already,true)
 const filters=db.calls.filter(c=>c[0]==='eq').map(c=>[c[1],c[2]])
 eq(filters.some(([k,v])=>k==='plan_hash'&&v===hash),true)
 eq(filters.some(([k,v])=>k==='token_id'&&v===tokenId),true)
 noForgedValueReachedTheDatabase(db.calls)
})
