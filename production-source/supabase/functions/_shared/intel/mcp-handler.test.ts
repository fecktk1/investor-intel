// The HTTP surface of intel-mcp: the door, not the rooms.
//
// Everything here is about what a client gets before any tool runs. Auth refusal,
// the challenge header, the method table, the body bound, and the two budgets.
// These matter disproportionately because a client that cannot get through the
// door reports the whole server as broken, whatever the tools do.
//
// The Supabase client is stubbed by intercepting globalThis.fetch: createClient
// builds its URLs from SUPABASE_URL, and every call it makes is a fetch, so one
// interception is enough to run the real handler with no database.

import {assert,assertEquals} from 'https://deno.land/std@0.224.0/assert/mod.ts'

Deno.env.set('SUPABASE_URL','https://stub.invalid')
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY','service-role-stub')
// The limiter fails CLOSED without a salt, so a salt has to exist for any of
// these to get past the budget. That is asserted directly further down.
Deno.env.set('RATE_LIMIT_SALT','test-salt')

const {handleIntelMcp,SUPPORTED_PROTOCOL_VERSIONS}=await import('../../intel-mcp/index.ts')
const {AGENT_TOKEN_PREFIX}=await import('./agent-token.ts')

const TOKEN=`${AGENT_TOKEN_PREFIX}${'a'.repeat(43)}`
const TOKEN_ID='11111111-1111-4111-8111-111111111111'

interface Stub {
 /** Rows returned per table, keyed by the table name in the PostgREST path. */
 tables?:Record<string,unknown[]>
 rpc?:Record<string,unknown>
 /** Tables whose read must fail, to exercise the fail-closed paths. */
 broken?:string[]
}

let stub:Stub={}
const realFetch=globalThis.fetch

function installFetch() {
 globalThis.fetch=((input:string|URL|Request,init?:RequestInit)=>{
  const url=typeof input==='string'?input:input instanceof URL?input.href:input.url
  const json=(body:unknown,status=200)=>Promise.resolve(new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}}))
  const rpc=/\/rest\/v1\/rpc\/([a-z_]+)/.exec(url)
  if(rpc){
   const name=rpc[1]
   if(Object.hasOwn(stub.rpc??{},name))return json(stub.rpc![name])
   return json(null)
  }
  const table=/\/rest\/v1\/([a-z_]+)/.exec(url)
  if(table){
   const name=table[1]
   if(stub.broken?.includes(name))return json({message:`relation ${name} is unavailable`,code:'57014'},500)
   // A PATCH or a POST is a write; the handler only ever needs it to succeed.
   const method=(init?.method??'GET').toUpperCase()
   if(method!=='GET')return json(stub.tables?.[name]??[])
   return json(stub.tables?.[name]??[])
  }
  return json({},404)
 }) as typeof fetch
}

function restoreFetch() {
 globalThis.fetch=realFetch
}

/** A live token, a member, entitlement, an open surface and a budget with room. */
function healthy():Stub {
 return {
  rpc:{
   can_access_intel:true,
   intel_surface_allowed:true,
   intel_effective_tier:'starter',
   intel_limit_for:2000,
   rate_limit_check_and_increment:[{allowed:true,count_in_window:1,retry_after:0}],
   intel_mcp_quota_take:{allowed:true,used:1,limit:2000,resets_at:'2026-09-21T00:00:00.000Z'},
  },
  tables:{
   intel_agent_tokens:[{id:TOKEN_ID,user_id:'user-1',org_id:'org-1',name:'Laptop agent',scopes:['read:watchlists'],expires_at:'2027-01-01T00:00:00.000Z',revoked_at:null,revoked_reason:null}],
   org_members:[{role:'owner'}],
   intel_surface_tiers:[{surface:'agent_access',min_tier:'starter'},{surface:'capture_views',min_tier:'free'}],
   intel_mcp_daily_usage:[{calls:1,usage_date:'2026-09-20'}],
   intel_mcp_call_audit:[],
   market_assets:[],
   intel_regime_snapshots:[],
  },
 }
}

function post(body:unknown,headers:Record<string,string>={}) {
 return new Request('https://stub.invalid/functions/v1/intel-mcp',{
  method:'POST',
  headers:{'Content-Type':'application/json','Authorization':`Bearer ${TOKEN}`,...headers},
  body:typeof body==='string'?body:JSON.stringify(body),
 })
}

async function run(body:unknown,headers:Record<string,string>={},fixture:Stub=healthy()) {
 stub=fixture
 installFetch()
 try{
  const response=await handleIntelMcp(post(body,headers))
  const text=await response.text()
  return {response,body:text?JSON.parse(text):null}
 }finally{
  restoreFetch()
 }
}

// ── The method table ────────────────────────────────────────────────────────

Deno.test('OPTIONS is a CORS preflight that allows what an MCP client actually sends',async()=>{
 const response=await handleIntelMcp(new Request('https://stub.invalid/functions/v1/intel-mcp',{method:'OPTIONS'}))
 assertEquals(response.status,200)
 const allowed=(response.headers.get('Access-Control-Allow-Headers')??'').toLowerCase()
 // An MCP client sends these three beyond the usual set. A preflight that omits
 // them fails in a browser-hosted client for no visible reason.
 for(const header of ['authorization','content-type','accept','mcp-session-id','mcp-protocol-version']){
  assert(allowed.includes(header),`the preflight must allow ${header}`)
 }
 assert((response.headers.get('Access-Control-Allow-Methods')??'').includes('POST'))
})

Deno.test('GET and DELETE are 405 with Allow, not an idle stream',async()=>{
 for(const method of ['GET','DELETE','PUT','PATCH']){
  const response=await handleIntelMcp(new Request('https://stub.invalid/functions/v1/intel-mcp',{method}))
  assertEquals(response.status,405,`${method} must be refused`)
  // The Allow header is what stops a client retrying, and the message says WHY
  // there is no stream rather than leaving it to be inferred.
  assertEquals(response.headers.get('Allow'),'POST, OPTIONS')
  const body=await response.json()
  assertEquals(body.jsonrpc,'2.0')
  assert(String(body.error.message).includes('stateless'))
 }
})

// ── Authentication ──────────────────────────────────────────────────────────

Deno.test('a missing bearer is 401 with a WWW-Authenticate that says what to send',async()=>{
 stub=healthy();installFetch()
 try{
  const response=await handleIntelMcp(new Request('https://stub.invalid/functions/v1/intel-mcp',{
   method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize'}),
  }))
  assertEquals(response.status,401)
  const challenge=response.headers.get('WWW-Authenticate')??''
  assert(challenge.startsWith('Bearer '),'the challenge must name the scheme')
  assert(challenge.includes('tcfagt_'),'and the credential shape, so a client is not left guessing')
  const body=await response.json()
  // Even a 401 is JSON-RPC shaped, or a client reports "malformed response"
  // instead of "you need a token", and the person never learns what to do.
  assertEquals(body.jsonrpc,'2.0')
  assertEquals(body.id,1,'the refusal must correlate with the request that caused it')
  assert(String(body.error.message).includes('Settings'),'and say where to get one')
 }finally{restoreFetch()}
})

Deno.test('a Supabase session JWT is refused by name rather than as an invalid token',async()=>{
 const {response,body}=await run({jsonrpc:'2.0',id:1,method:'initialize'},{Authorization:'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.x'})
 assertEquals(response.status,401)
 assert(response.headers.get('WWW-Authenticate'))
 // Almost always a misconfigured client, so the message says which credential is
 // wanted and where minting actually happens.
 assert(String(body.error.message).includes('tcfagt_'))
 assert(String(body.error.message).includes('not a Supabase session key'))
})

Deno.test('a token that is not in the store, revoked or expired is refused with its own code',async()=>{
 const cases:Array<[string,Stub,string]>=[
  ['unknown',{...healthy(),tables:{...healthy().tables,intel_agent_tokens:[]}},'token_invalid'],
  ['revoked',{...healthy(),tables:{...healthy().tables,intel_agent_tokens:[{...(healthy().tables!.intel_agent_tokens as Record<string,unknown>[])[0],revoked_at:'2026-09-01T00:00:00.000Z',revoked_reason:'Laptop lost'}]}},'token_revoked'],
  ['expired',{...healthy(),tables:{...healthy().tables,intel_agent_tokens:[{...(healthy().tables!.intel_agent_tokens as Record<string,unknown>[])[0],expires_at:'2026-01-01T00:00:00.000Z'}]}},'token_expired'],
 ]
 for(const [label,fixture,code] of cases){
  const {response,body}=await run({jsonrpc:'2.0',id:1,method:'tools/list'},{},fixture)
  assertEquals(response.status,401,`${label} must be 401`)
  assert(String(body.error.message).startsWith(code),`${label} must report ${code}, said ${body.error.message}`)
 }
 // A revoked token's reason reaches the caller, so a person knows why.
 const {body}=await run({jsonrpc:'2.0',id:1,method:'tools/list'},{},cases[1][1])
 assert(String(body.error.message).includes('Laptop lost'))
})

Deno.test('a token is not an entitlement: membership and access are re-checked every request',async()=>{
 const noMember={...healthy(),tables:{...healthy().tables,org_members:[]}}
 const gone=await run({jsonrpc:'2.0',id:1,method:'tools/list'},{},noMember)
 assertEquals(gone.response.status,403)
 assert(String(gone.body.error.message).startsWith('membership_revoked'))

 const lapsed={...healthy(),rpc:{...healthy().rpc,can_access_intel:false}}
 const stopped=await run({jsonrpc:'2.0',id:1,method:'tools/list'},{},lapsed)
 assertEquals(stopped.response.status,403)
 assert(String(stopped.body.error.message).startsWith('entitlement_lost'))
})

Deno.test('a workspace whose plan no longer includes agent access is refused at the door',async()=>{
 const locked={...healthy(),rpc:{...healthy().rpc,intel_surface_allowed:false}}
 const {response,body}=await run({jsonrpc:'2.0',id:1,method:'tools/list'},{},locked)
 assertEquals(response.status,403)
 assert(String(body.error.message).includes('Starter'),'the plan that opens it must be named')
 assert(String(body.error.message).includes('Nothing was read'))
 // No tool list leaks out of a refused handshake.
 assertEquals(body.result,undefined)
})

// ── A successful handshake ──────────────────────────────────────────────────

Deno.test('a live token gets a handshake, a tool list, and a pong',async()=>{
 const handshake=await run({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'claude-code',version:'1'}}})
 assertEquals(handshake.response.status,200)
 assertEquals(handshake.body.id,1)
 assertEquals(handshake.body.result.protocolVersion,'2025-06-18')
 assert(handshake.body.result.instructions.includes('whoami'))
 // The negotiated version is on the header too, which is where the spec tells a
 // client to look on subsequent requests.
 assert(handshake.response.headers.get('MCP-Protocol-Version'))
 assertEquals(handshake.response.headers.get('Cache-Control'),'private, no-store')

 for(const version of SUPPORTED_PROTOCOL_VERSIONS){
  const negotiated=await run({jsonrpc:'2.0',id:2,method:'initialize',params:{protocolVersion:version}})
  assertEquals(negotiated.body.result.protocolVersion,version)
 }

 const list=await run({jsonrpc:'2.0',id:3,method:'tools/list'})
 assert(Array.isArray(list.body.result.tools))
 assert(list.body.result.tools.length>=15,`expected the full catalogue, saw ${list.body.result.tools.length}`)
 for(const tool of list.body.result.tools){
  assert(typeof tool.name==='string'&&tool.name.length>0)
  assert(typeof tool.description==='string'&&tool.description.length>20)
  assertEquals(tool.inputSchema.type,'object')
  assertEquals(tool.inputSchema.additionalProperties,false)
 }

 const pong=await run({jsonrpc:'2.0',id:4,method:'ping'})
 assertEquals(pong.body.result,{})

 const resources=await run({jsonrpc:'2.0',id:5,method:'resources/list'})
 assert(Array.isArray(resources.body.result.resources))
 const prompts=await run({jsonrpc:'2.0',id:6,method:'prompts/list'})
 assert(Array.isArray(prompts.body.result.prompts))
})

Deno.test('a notification gets 202 and an empty body, never a result',async()=>{
 const {response}=await run({jsonrpc:'2.0',method:'notifications/initialized'})
 assertEquals(response.status,202)
 assertEquals(await response.text(),'')
})

Deno.test('an ignored session header does not break the request',async()=>{
 // We never issue one, but clients send it anyway. Refusing would break a client
 // over a header that cannot change the answer of a stateless server.
 const {response,body}=await run({jsonrpc:'2.0',id:1,method:'ping'},{'Mcp-Session-Id':'whatever','MCP-Protocol-Version':'2025-03-26'})
 assertEquals(response.status,200)
 assertEquals(body.result,{})
})

// ── Malformed input ─────────────────────────────────────────────────────────

Deno.test('a body that is not one JSON-RPC 2.0 request is refused in JSON-RPC shape',async()=>{
 const broken=await run('{not json')
 assertEquals(broken.response.status,400)
 assertEquals(broken.body.error.code,-32700)

 // A batch is refused rather than half-answered.
 const batch=await run([{jsonrpc:'2.0',id:1,method:'ping'}])
 assertEquals(batch.response.status,400)
 assert(String(batch.body.error.message).includes('batch'))

 const wrongVersion=await run({jsonrpc:'1.0',id:1,method:'ping'})
 assertEquals(wrongVersion.response.status,400)
 assertEquals(wrongVersion.body.error.code,-32600)

 const unknownMethod=await run({jsonrpc:'2.0',id:1,method:'resources/subscribe'})
 assertEquals(unknownMethod.body.error.code,-32601)
})

Deno.test('an oversize body is 413 before it is parsed',async()=>{
 const huge=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'search_assets',arguments:{query:'x'.repeat(200000)}}})
 const {response,body}=await run(huge)
 assertEquals(response.status,413)
 assert(String(body.error.message).includes('at most'))
})

// ── The budgets, both fail closed ───────────────────────────────────────────

Deno.test('the minute limiter refuses with 429 and a Retry-After',async()=>{
 const limited={...healthy(),rpc:{...healthy().rpc,rate_limit_check_and_increment:[{allowed:false,count_in_window:241,retry_after:37}]}}
 const {response,body}=await run({jsonrpc:'2.0',id:1,method:'tools/list'},{},limited)
 assertEquals(response.status,429)
 assertEquals(response.headers.get('Retry-After'),'60')
 assert(String(body.error.message).startsWith('rate_limited'))
 assert(String(body.error.message).includes('37'),'the wait must be told to the caller')
})

Deno.test('the daily quota refuses a tool call and names when it resets',async()=>{
 const spent={...healthy(),rpc:{...healthy().rpc,intel_mcp_quota_take:{allowed:false,used:2001,limit:2000,resets_at:'2026-09-21T00:00:00.000Z'}}}
 const {response,body}=await run({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'whoami',arguments:{}}},{},spent)
 assertEquals(response.status,429)
 assert(String(body.error.message).startsWith('daily_quota_reached'))
 assert(String(body.error.message).includes('2026-09-21'),'the reset time must be named')
 assert(String(body.error.message).includes('higher plan'))
 // A handshake is NOT charged against the day, because some clients re-handshake
 // every turn and that is not the member's doing.
 const handshake=await run({jsonrpc:'2.0',id:2,method:'initialize'},{},spent)
 assertEquals(handshake.response.status,200)
 const list=await run({jsonrpc:'2.0',id:3,method:'tools/list'},{},spent)
 assertEquals(list.response.status,200)
})

Deno.test('a missing RATE_LIMIT_SALT closes the surface rather than letting traffic through',async()=>{
 const salt=Deno.env.get('RATE_LIMIT_SALT')
 Deno.env.delete('RATE_LIMIT_SALT')
 try{
  const {response,body}=await run({jsonrpc:'2.0',id:1,method:'tools/list'})
  // FAIL CLOSED. This surface reads a member's book and can propose writes
  // against it, so an unconfigured limiter stops it rather than degrading it. The
  // cost is honest: with the secret unset in production, the server is down.
  assertEquals(response.status,503)
  assert(String(body.error.message).startsWith('limiter_unavailable'))
  assert(String(body.error.message).includes('RATE_LIMIT_SALT'))
 }finally{
  if(salt)Deno.env.set('RATE_LIMIT_SALT',salt)
 }
})

Deno.test('an unreadable quota counter refuses rather than allowing an unmetered call',async()=>{
 const blind={...healthy(),rpc:{...healthy().rpc}}
 delete (blind.rpc as Record<string,unknown>).intel_mcp_quota_take
 const {response,body}=await run({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'whoami',arguments:{}}},{},blind)
 // The RPC answers null, which is not a verdict, so it is treated as a refusal.
 assertEquals(response.status,429)
 assert(String(body.error.message).startsWith('daily_quota_reached'))
})

// ── A tool call end to end ──────────────────────────────────────────────────

Deno.test('a tool call returns a tool result, and a refused one is a result not a fault',async()=>{
 const served=await run({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'whoami',arguments:{}}})
 assertEquals(served.response.status,200)
 const content=served.body.result.content
 assert(Array.isArray(content)&&content[0].type==='text')
 const payload=JSON.parse(content[0].text)
 assertEquals(payload.tool,'whoami')
 assertEquals(payload.data.scopes,['read:watchlists'])

 // A tool the token has no scope for comes back 200 with isError, NOT as a
 // transport fault: a model reads the reason and tells the member what to change,
 // where a transport fault would just be retried.
 const refused=await run({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'alert_create',arguments:{asset:'market:coinmarketcap:1',direction:'above',threshold_usd:1,title:'t'}}})
 assertEquals(refused.response.status,200)
 assertEquals(refused.body.result.isError,true)
 const reason=JSON.parse(refused.body.result.content[0].text)
 assertEquals(reason.error,'scope_missing')
 assertEquals(reason.scope_required,'write:alerts')

 // An unknown tool IS a protocol fault: there was no tool to fail.
 const unknown=await run({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'rm_rf',arguments:{}}})
 assertEquals(unknown.response.status,400)
 assertEquals(unknown.body.error.code,-32602)
})
