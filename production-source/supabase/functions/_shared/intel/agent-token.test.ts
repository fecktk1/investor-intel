import {assertEquals as eq,assertRejects,assertThrows} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {authenticateAgentToken,mintAgentToken,validScopes,requireScope,AgentAuthError,type AgentContext} from './agent-token.ts'
import {agentReadService,agentManagementService} from './agent-service.ts'

const orgId='00000000-0000-4000-8000-000000000001'
const otherOrg='00000000-0000-4000-8000-0000000000ff'
const userId='10000000-0000-4000-8000-000000000001'
const tokenId='20000000-0000-4000-8000-000000000001'
const layoutId='30000000-0000-4000-8000-000000000001'

// Records every call and answers per table / per rpc, so a test can assert what
// the service actually filtered on rather than only what it returned.
function dbMock(handlers:Record<string,{data?:unknown;error?:unknown;count?:number}>) {
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

const liveToken=(over:Record<string,unknown>={})=>({
 id:tokenId,user_id:userId,org_id:orgId,name:'Laptop agent',
 scopes:['read:charts','read:portfolio'],
 expires_at:new Date(Date.now()+86400000).toISOString(),revoked_at:null,revoked_reason:null,...over,
})
const request=(token:string)=>new Request('https://fn.test/intel-agent-api',{method:'POST',headers:{Authorization:`Bearer ${token}`}})
const context=(over:Partial<AgentContext>={}):AgentContext=>({
 tokenId,userId,orgId,tokenName:'Laptop agent',scopes:['read:charts'],role:'owner',
 actor:{human_user_id:userId,org_id:orgId,role:'owner',token_id:tokenId,source:'agent_token',request_id:''},...over,
})

Deno.test('a token is bound to the organization pinned on its row, never to one the request names',async()=>{
 const minted=await mintAgentToken()
 const db=dbMock({intel_agent_tokens:{data:liveToken()},org_members:{data:{role:'owner'}},'rpc:can_access_intel':{data:true}})
 const ctx=await authenticateAgentToken(db,request(minted.plaintext))
 eq(ctx.orgId,orgId)

 // The read filters on the pinned org even though the body asks for another.
 const readDb=dbMock({intel_chart_layouts:{data:[]}})
 await agentReadService(readDb,ctx,{operation:'read_charts',orgId:otherOrg,userId:'spoofed'})
 eq(readDb.calls.some(c=>c[0]==='eq'&&c[1]==='org_id'&&c[2]===orgId),true)
 eq(readDb.calls.some(c=>c[0]==='eq'&&c[1]==='user_id'&&c[2]===userId),true)
 eq(readDb.calls.some(c=>c.includes(otherOrg)||c.includes('spoofed')),false)
})

Deno.test('a revoked token fails closed, and says it was revoked rather than returning an empty read',async()=>{
 const minted=await mintAgentToken()
 const db=dbMock({intel_agent_tokens:{data:liveToken({revoked_at:new Date().toISOString(),revoked_reason:'laptop lost'})}})
 const error=await assertRejects(()=>authenticateAgentToken(db,request(minted.plaintext)),AgentAuthError) as AgentAuthError
 eq(error.code,'token_revoked')
 eq(error.status,401)
 // Revocation is decided before any entitlement lookup happens.
 eq(db.calls.some(c=>c[0]==='rpc'&&c[1]==='can_access_intel'),false)
})

Deno.test('an expired token fails closed even though its row is otherwise intact',async()=>{
 const minted=await mintAgentToken()
 const db=dbMock({intel_agent_tokens:{data:liveToken({expires_at:new Date(Date.now()-1000).toISOString()})}})
 const error=await assertRejects(()=>authenticateAgentToken(db,request(minted.plaintext)),AgentAuthError) as AgentAuthError
 eq(error.code,'token_expired')
 eq(error.status,401)
})

Deno.test('a valid token is refused once its member leaves the workspace or the workspace loses Intel',async()=>{
 const minted=await mintAgentToken()
 for(const [handlers,code] of [
  [{intel_agent_tokens:{data:liveToken()},org_members:{data:null},'rpc:can_access_intel':{data:true}},'membership_revoked'],
  [{intel_agent_tokens:{data:liveToken()},org_members:{data:{role:'owner'}},'rpc:can_access_intel':{data:false}},'entitlement_lost'],
 ] as const){
  const error=await assertRejects(()=>authenticateAgentToken(dbMock(handlers as any),request(minted.plaintext)),AgentAuthError) as AgentAuthError
  eq(error.code,code)
  eq(error.status,403)
 }
})

Deno.test('a token store outage is reported as unavailable rather than as an invalid token',async()=>{
 const minted=await mintAgentToken()
 const db=dbMock({intel_agent_tokens:{data:null,error:{message:'connection reset'}}})
 const error=await assertRejects(()=>authenticateAgentToken(db,request(minted.plaintext)),AgentAuthError) as AgentAuthError
 eq(error.code,'token_store_unavailable')
 eq(error.status,503)
})

Deno.test('a malformed bearer is refused before any database work happens',async()=>{
 for(const bearer of ['','not-a-token','tcfagt_short','Bearer tcfagt_x']){
  const db=dbMock({})
  await assertRejects(()=>authenticateAgentToken(db,request(bearer)),AgentAuthError)
  eq(db.calls.length,0)
 }
})

Deno.test('a read-scoped token cannot propose a write, and is refused before the target is read',async()=>{
 const db=dbMock({intel_chart_layouts:{data:{id:layoutId,asset:'native:bitcoin',title:'BTC',revision:2}}})
 const error=await assertRejects(()=>agentReadService(db,context({scopes:['read:charts']}),{
  operation:'propose_write',tool:'intel_annotate_chart',layoutId,
  drawing:{id:layoutId,tool:'text',anchors:[{t:1788998400000,price:100}],text:'note'},
 }),AgentAuthError) as AgentAuthError
 eq(error.code,'scope_missing')
 eq(error.status,403)
 // No read happened, so the refusal cannot be used to learn which ids exist.
 eq(db.calls.length,0)
})

Deno.test('a read-scoped token cannot execute a write even when a plan id is handed to it',async()=>{
 const db=dbMock({'rpc:intel_agent_execution_gate':{data:{allowed:false,reason_code:'scope_missing',reason:'This token does not carry write:charts.'}}})
 const error=await assertRejects(()=>agentReadService(db,context({scopes:['read:charts']}),{operation:'execute_write',planId:layoutId}),AgentAuthError) as AgentAuthError
 eq(error.code,'scope_missing')
 eq(error.status,403)
})

Deno.test('the scope vocabulary refuses unknown scopes, duplicates, and a write without its read',()=>{
 for(const scopes of [[],['read:everything'],['read:charts','read:charts'],['write:charts'],['write:alerts','read:charts'],'read:charts',[1]]){
  assertThrows(()=>validScopes(scopes as unknown),AgentAuthError)
 }
 eq(validScopes(['read:charts','write:charts']),['read:charts','write:charts'])
 eq(validScopes(['read:portfolio']),['read:portfolio'])
})

Deno.test('a missing scope names the scope that was missing instead of refusing anonymously',()=>{
 const error=assertThrows(()=>requireScope(context({scopes:['read:charts']}),'read:portfolio'),AgentAuthError) as AgentAuthError
 eq(error.code,'scope_missing')
 eq(error.message.includes('read:portfolio'),true)
})

Deno.test('the agent surface refuses every management operation, so a token cannot widen itself',async()=>{
 for(const operation of ['token_create','token_list','token_revoke','plan_approve']){
  const error=await assertRejects(()=>agentReadService(dbMock({}),context({scopes:['read:charts','write:charts']}),{operation}),AgentAuthError) as AgentAuthError
  // agentReadService knows nothing of these operations at all.
  eq(error.code,'invalid_operation')
 }
})

Deno.test('minting a token returns the plaintext once and stores only a hash and a six-character hint',async()=>{
 const minted=await mintAgentToken()
 eq(minted.plaintext.startsWith('tcfagt_'),true)
 eq(/^[0-9a-f]{64}$/.test(minted.hash),true)
 eq(minted.hint,minted.plaintext.slice(-6))
 eq(minted.hash.includes(minted.plaintext),false)

 const db=dbMock({intel_agent_tokens:{data:{id:tokenId,name:'Laptop agent',org_id:orgId,token_hint:'abc123',scopes:['read:charts'],expires_at:'2027-01-01T00:00:00Z',revoked_at:null,revoked_reason:null,last_used_at:null,created_at:'2026-09-16T00:00:00Z'},count:0}})
 const created=await agentManagementService(db,{orgId,userId},{operation:'token_create',name:'Laptop agent',scopes:['read:charts']}) as Record<string,unknown>
 eq(typeof created.token,'string')
 eq(created.shown_once,true)
 eq('token_hash' in created,false)
 // The org written is the session's org, never anything the body supplied.
 const insert=db.calls.find(c=>c[0]==='insert')
 eq(insert[1].org_id,orgId)
 eq(insert[1].user_id,userId)
 eq(/^[0-9a-f]{64}$/.test(insert[1].token_hash),true)
})

Deno.test('a listed token never carries its hash and a revoked one reports the revocation as the state asked for',async()=>{
 const row={id:tokenId,name:'Laptop agent',org_id:orgId,token_hint:'abc123',scopes:['read:charts'],expires_at:'2027-01-01T00:00:00Z',revoked_at:null,revoked_reason:null,last_used_at:null,created_at:'2026-09-16T00:00:00Z',token_hash:'f'.repeat(64)}
 const listed=await agentManagementService(dbMock({intel_agent_tokens:{data:[row]}}),{orgId,userId},{operation:'token_list'}) as any
 eq('token_hash' in listed.tokens[0],false)
 eq(listed.tokens[0].token_hint,'abc123')

 const already=await agentManagementService(dbMock({intel_agent_tokens:{data:null}}),{orgId,userId},{operation:'token_revoke',id:tokenId}) as any
 eq(already,{revoked:true,already:true})
})
