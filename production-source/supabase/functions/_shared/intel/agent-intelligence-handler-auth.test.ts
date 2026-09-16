import {assert,assertEquals} from 'jsr:@std/assert@1'
import {handleAgentIntelligence} from '../../agent-intelligence-api/index.ts'

// Reads the gate itself is allowed to make. Anything else appearing before a
// denial would mean intelligence was assembled for an unauthorized caller.
const GATE_TABLES=['org_members','profiles']
const GATE_RPCS=['can_access_intel']
const SERVICE_KEY='fixture-service-key'

// Membership is decided by the org and user the handler actually asked about,
// never by a flag, so a body-supplied org id is tested the way an attacker
// would supply one.
function fixture({members=['verified-user'],allowed=true,valid=true}:{members?:string[];allowed?:boolean;valid?:boolean}={}) {
 let userReads=0
 const tables:string[]=[],rpcs:string[]=[],inserts:{table:string;payload:Record<string,unknown>}[]=[]
 const table=(name:string)=>{
  const q:{[key:string]:unknown;_org:string|null;_user:string|null}={_org:null,_user:null}
  q.select=()=>q
  q.eq=(column:string,value:unknown)=>{if(column==='user_id')q._user=String(value);if(column==='org_id')q._org=String(value);if(column==='id')q._user=String(value);return q}
  for(const method of ['gte','lte','in','order','limit','not','neq','filter','contains','range'])q[method]=()=>q
  q.maybeSingle=()=>{
   if(name==='org_members')return Promise.resolve({data:q._org==='org'&&members.includes(String(q._user))?{org_id:q._org,user_id:q._user}:null,error:null})
   if(name==='profiles')return Promise.resolve({data:{is_super_admin:false},error:null})
   return Promise.resolve({data:null,error:null})
  }
  q.single=q.maybeSingle
  q.insert=(payload:Record<string,unknown>)=>{inserts.push({table:name,payload});return Promise.resolve({data:null,error:null})}
  q.upsert=q.insert
  // deno-lint-ignore no-explicit-any
  q.then=(resolve:any,reject:any)=>Promise.resolve({data:[],count:0,error:null}).then(resolve,reject)
  return q
 }
 const db={
  auth:{getUser:()=>{userReads++;return Promise.resolve({data:{user:valid?{id:'verified-user'}:null},error:null})}},
  from:(name:string)=>{tables.push(name);return table(name)},
  rpc:(name:string)=>{rpcs.push(name);return Promise.resolve({data:name==='can_access_intel'?allowed:null,error:null})},
 }
 return {factory:()=>db,counts:()=>({userReads,tables,rpcs,inserts}),
  // Every read that is not part of the gate itself.
  dataReads:()=>[...tables.filter(t=>!GATE_TABLES.includes(t)),...rpcs.filter(r=>!GATE_RPCS.includes(r)).map(r=>`rpc:${r}`)]}
}

function withEnv(fn:()=>Promise<void>) {
 const keys:Record<string,string|null>={SUPABASE_URL:'https://fixture.test',SUPABASE_ANON_KEY:'fixture-anon',SUPABASE_SERVICE_ROLE_KEY:SERVICE_KEY,
  // Cleared so no retrieval lane can reach a real network or a second service key.
  SERVICE_ROLE_KEY:null,CRON_SECRET:null,OPENAI_API_KEY:null}
 const before=Object.fromEntries(Object.keys(keys).map(k=>[k,Deno.env.get(k)]))
 return (async()=>{
  try{
   for(const[k,v]of Object.entries(keys))if(v===null)Deno.env.delete(k);else Deno.env.set(k,v)
   await fn()
  }finally{for(const[k,v]of Object.entries(before))if(v===undefined)Deno.env.delete(k);else Deno.env.set(k,v)}
 })()
}

const request=(body:Record<string,unknown>={},header='Bearer fixture-user')=>
 new Request('https://fixture.test/agent-intelligence-api',{method:'POST',
  headers:header?{Authorization:header,'Content-Type':'application/json'}:{'Content-Type':'application/json'},
  body:JSON.stringify({agentType:'goose-local',orgId:'org',...body})})

Deno.test('Agent intelligence verifies the user exactly once, then org membership and entitlement before any retrieval',()=>withEnv(async()=>{
 const f=fixture(),r=await handleAgentIntelligence(request(),f.factory)
 assertEquals(r.status,200)
 const body=await r.json()
 assertEquals(body.ok,true);assertEquals(body.surface,'agent');assertEquals(body.blocks,[])
 const {userReads,rpcs,inserts}=f.counts()
 assertEquals(userReads,1)
 // The entitlement check is the FIRST remote procedure the request makes.
 assertEquals(rpcs[0],'can_access_intel')
 assert(rpcs.includes('intelligence_context_blocks'),'retrieval must still run for an authorized member')
 assertEquals(inserts.map(i=>i.table),['agent_intelligence_access_log'])
 assertEquals(inserts[0].payload.org_id,'org');assertEquals(inserts[0].payload.user_id,'verified-user')
 assertEquals(r.headers.get('Cache-Control'),'private, no-store')
}))

for(const [label,make,status] of [
 ['an unverifiable user',()=>({fixture:fixture({valid:false}),body:{}}),401],
 ['an organization the caller does not belong to',()=>({fixture:fixture(),body:{orgId:'someone-elses-org'}}),403],
 ['an expired entitlement',()=>({fixture:fixture({allowed:false}),body:{}}),403],
 ['a caller with no membership anywhere',()=>({fixture:fixture({members:[]}),body:{}}),403],
] as const) Deno.test(`Agent intelligence refuses ${label} before reading intelligence`,()=>withEnv(async()=>{
 const {fixture:f,body}=make()
 const r=await handleAgentIntelligence(request(body),f.factory)
 assertEquals(r.status,status)
 assertEquals(f.dataReads(),[])
 assertEquals(f.counts().inserts,[])
 assert(typeof (await r.json()).error==='string','a denial must name an honest reason')
}))

Deno.test('Agent intelligence refuses a request with no credentials without touching auth',()=>withEnv(async()=>{
 const f=fixture(),r=await handleAgentIntelligence(request({},''),f.factory)
 assertEquals(r.status,401);assertEquals(await r.json(),{error:'unauthorized'})
 assertEquals(f.counts().userReads,0);assertEquals(f.dataReads(),[])
}))

// ── SERVICE mode: acting for an org is allowed, acting for a stranger is not ──
const serviceRequest=(body:Record<string,unknown>={})=>request(body,`Bearer ${SERVICE_KEY}`)

Deno.test('Service mode cannot read an arbitrary organization for an arbitrary user',()=>withEnv(async()=>{
 const f=fixture(),r=await handleAgentIntelligence(serviceRequest({userId:'outsider'}),f.factory)
 assertEquals(r.status,403)
 assertEquals(f.dataReads(),[])
 assertEquals(f.counts().inserts,[])
}))

Deno.test('Service mode cannot reach an organization that holds no entitlement',()=>withEnv(async()=>{
 const f=fixture({allowed:false}),r=await handleAgentIntelligence(serviceRequest({userId:'verified-user'}),f.factory)
 assertEquals(r.status,403);assertEquals(f.dataReads(),[]);assertEquals(f.counts().inserts,[])
}))

Deno.test('Service mode acts for a verified member of the requested organization',()=>withEnv(async()=>{
 const f=fixture({members:['verified-user','service-member']})
 const r=await handleAgentIntelligence(serviceRequest({userId:'service-member'}),f.factory)
 assertEquals(r.status,200)
 const {userReads,inserts}=f.counts()
 // A service credential is its own proof; no user session is verified for it.
 assertEquals(userReads,0)
 assertEquals(inserts[0].payload.user_id,'service-member');assertEquals(inserts[0].payload.org_id,'org')
}))

Deno.test('Service mode keeps its org-scoped call with no user identity',()=>withEnv(async()=>{
 const f=fixture(),r=await handleAgentIntelligence(serviceRequest(),f.factory)
 assertEquals(r.status,200)
 const {userReads,inserts}=f.counts()
 assertEquals(userReads,0)
 assertEquals(inserts[0].payload.user_id,null);assertEquals(inserts[0].payload.org_id,'org')
}))

// ── Shape of the endpoint around the gate ────────────────────────────────────
Deno.test('Agent intelligence still rejects an incomplete request before the gate reads anything',()=>withEnv(async()=>{
 for(const [body,error] of [[{agentType:null},'agentType required'],[{orgId:null},'orgId required']] as const){
  const f=fixture(),r=await handleAgentIntelligence(request(body),f.factory)
  assertEquals(r.status,400);assertEquals(await r.json(),{error})
  assertEquals(f.counts().userReads,0);assertEquals(f.dataReads(),[])
 }
}))

Deno.test('Agent intelligence preflight is bounded and authorizes nothing',()=>withEnv(async()=>{
 const f=fixture()
 const preflight=await handleAgentIntelligence(new Request('https://fixture.test/agent-intelligence-api',{method:'OPTIONS',
  headers:{Origin:'https://thecontentforge.io','Access-Control-Request-Method':'POST'}}),f.factory)
 assertEquals(preflight.status,200);assertEquals(await preflight.text(),'ok')
 assertEquals(preflight.headers.get('Access-Control-Max-Age'),'600')
 assertEquals(preflight.headers.get('Access-Control-Allow-Origin'),'*')
 assertEquals(f.counts().userReads,0);assertEquals(f.dataReads(),[])
}))
