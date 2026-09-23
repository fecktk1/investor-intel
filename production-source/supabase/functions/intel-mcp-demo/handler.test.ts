// The public MCP demo against a stub database: the allowlist, the no-provider
// guarantee, the tracked-asset rule, the limits and the demo marker.
//
// The stub is PostgREST-shaped: `from(table)` returns a chainable builder that
// resolves to the fixture's rows for that table, filtered by eq, in and gte;
// writes and rpc calls are recorded so a test can prove none happened. The
// global fetch is replaced by a recorder for every test that runs a tool, so a
// tool that tried to reach any provider would fail here.

import {assert,assertEquals,assertStringIncludes} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {handleIntelMcpDemo,DEMO_LIMITS,fitResponse,type DemoHandlerDeps,type DailyVerdict} from './handler.ts'
import {
 DEMO_TOOL_NAMES,DEMO_EXCLUDED,DEMO_SURFACES,NOT_TRACKED,callDemoTool,demoContext,readOnlyDb,
 installOutboundGuard,trackedReaders,demoToolDefinitions,DemoReadOnlyError,
} from './demo-tools.ts'
import {MCP_TOOLS} from '../_shared/intel/mcp-tools.ts'
import {MARKET_FIGURE_NAMES} from '../_shared/intel/mcp-readings.ts'

// ── The stub ────────────────────────────────────────────────────────────────

type Row=Record<string,unknown>
interface Fixture {
 tables?:Record<string,Row[]>
 /** Catalogue identities intel_demo_tracked_assets reports as tracked. */
 tracked?:string[]
}

const NOW=Date.parse('2026-09-23T18:00:00.000Z')
const RECENT='2026-09-23T12:00:00.000Z'

function stubDb(fixture:Fixture={}) {
 const reads:Array<{table:string;filters:Array<[string,string,unknown]>}>=[]
 const writes:string[]=[]
 const rpcs:string[]=[]
 const from=(table:string)=>{
  const record={table,filters:[] as Array<[string,string,unknown]>}
  reads.push(record)
  const rows=()=>{
   let out=[...(fixture.tables?.[table]??[])]
   for(const [op,column,value] of record.filters){
    if(op==='eq')out=out.filter(row=>String(row[column]??'')===String(value))
    if(op==='in')out=out.filter(row=>(value as unknown[]).map(String).includes(String(row[column]??'')))
    if(op==='gte')out=out.filter(row=>row[column]!=null&&String(row[column])>=String(value))
   }
   return {data:out,error:null}
  }
  // deno-lint-ignore no-explicit-any
  const chain:any=new Proxy({},{
   get(_target,prop){
    if(prop==='then')return (resolve:(value:unknown)=>unknown,reject?:(e:unknown)=>unknown)=>Promise.resolve(rows()).then(resolve,reject)
    if(prop==='maybeSingle'||prop==='single')return ()=>{const r=rows();return Promise.resolve({data:r.data[0]??null,error:null})}
    if(prop==='insert'||prop==='update'||prop==='upsert'||prop==='delete')return ()=>{writes.push(`${String(prop)}:${table}`);return chain}
    if(prop==='eq'||prop==='in'||prop==='gte')return (column:string,value:unknown)=>{record.filters.push([prop,column,value]);return chain}
    return ()=>chain
   },
  })
  return chain
 }
 const db={
  from,
  rpc:(name:string,args:Record<string,unknown>)=>{
   rpcs.push(name)
   if(name==='intel_demo_tracked_assets'){
    const asked=(args.p_identities as Array<{sourceProvider:string;providerId:string}>)??[]
    const rows=asked.filter(identity=>(fixture.tracked??[]).includes(`${identity.sourceProvider}:${identity.providerId}`))
     .map(identity=>({source_provider:identity.sourceProvider,provider_id:identity.providerId,basis:'catalogue'}))
    return Promise.resolve({data:rows,error:null})
   }
   return Promise.resolve({data:null,error:null})
  },
 }
 return {db,reads,writes,rpcs}
}

// ── The fetch recorder ─────────────────────────────────────────────────────

const realFetch=globalThis.fetch
let outbound:string[]=[]
function recordFetch(){
 outbound=[]
 globalThis.fetch=((input:unknown)=>{outbound.push(String(input instanceof Request?input.url:input));return Promise.reject(new Error('network refused in tests'))}) as typeof fetch
}
function restoreFetch(){globalThis.fetch=realFetch}

// ── The handler, with permissive limits unless a test says otherwise ───────

const HASH='0123456789abcdef0123456789abcdef'

function deps(db:unknown,overrides:Partial<DemoHandlerDeps>={}):DemoHandlerDeps&{lines:Array<Record<string,unknown>>;limitKeys:string[]} {
 const lines:Array<Record<string,unknown>>=[]
 const limitKeys:string[]=[]
 return {
  db,
  ipKey:()=>Promise.resolve(`ip:${HASH}:mcp-demo`),
  limit:(key)=>{limitKeys.push(key);return Promise.resolve({ok:true,retryAfter:0})},
  daily:():Promise<DailyVerdict>=>Promise.resolve({allowed:true,reason:null,resetsAt:'2026-09-24T00:00:00.000Z'}),
  now:()=>NOW,
  log:(line)=>lines.push(line),
  lines,limitKeys,
  ...overrides,
 }
}

let nextId=1
function post(body:unknown,headers:Record<string,string>={}) {
 return new Request('https://demo.test/functions/v1/intel-mcp-demo',{method:'POST',headers:{'content-type':'application/json','x-forwarded-for':'203.0.113.9',...headers},body:typeof body==='string'?body:JSON.stringify(body)})
}
const rpc=(method:string,params:Record<string,unknown>={})=>({jsonrpc:'2.0',id:nextId++,method,params})
const callTool=(name:string,args:Record<string,unknown>={})=>rpc('tools/call',{name,arguments:args})
// deno-lint-ignore no-explicit-any
async function json(res:Response):Promise<any>{return await res.json()}
// deno-lint-ignore no-explicit-any
const payloadOf=(body:any)=>JSON.parse(body.result.content[0].text)

// ── The allowlist ──────────────────────────────────────────────────────────

Deno.test('every tool of the full server is either served by the demo or left out with a reason, never both',()=>{
 const all=MCP_TOOLS.map(tool=>tool.name).sort()
 const decided=[...DEMO_TOOL_NAMES,...Object.keys(DEMO_EXCLUDED)].sort()
 assertEquals(decided,all)
 for(const name of DEMO_TOOL_NAMES)assert(!Object.hasOwn(DEMO_EXCLUDED,name),`${name} is both served and excluded`)
 assertEquals(MCP_TOOLS.length,28)
 assertEquals(DEMO_TOOL_NAMES.length,18)
})

Deno.test('the demo serves only unscoped read tools on free plan surfaces',()=>{
 for(const name of DEMO_TOOL_NAMES){
  const tool=MCP_TOOLS.find(spec=>spec.name===name)!
  assertEquals(tool.scope,undefined,`${name} needs a scope`)
  assert((DEMO_SURFACES as readonly string[]).includes(tool.surface),`${name} sits on ${tool.surface}`)
 }
 // Every write and every member-scoped tool is on the excluded side.
 for(const name of ['watchlist_add','alert_create','write_run','save_research_note','watchlist_read','alerts_list','write_status','whoami','data_budget']){
  assert(Object.hasOwn(DEMO_EXCLUDED,name),`${name} must be excluded`)
 }
})

Deno.test('tools/list names exactly the demo tools, and every one says it is the read-only demo',async()=>{
 const stub=stubDb()
 const res=await handleIntelMcpDemo(post(rpc('tools/list')),deps(stub.db))
 assertEquals(res.status,200)
 const body=await json(res)
 const names=body.result.tools.map((tool:{name:string})=>tool.name)
 assertEquals(names,[...DEMO_TOOL_NAMES])
 for(const tool of body.result.tools)assertStringIncludes(tool.description,'Public demo: read only, stored data only')
 assertEquals(demoToolDefinitions().length,18)
})

Deno.test('a write or member tool called by name is refused before anything is read or written',async()=>{
 recordFetch()
 try{
  for(const name of Object.keys(DEMO_EXCLUDED)){
   const stub=stubDb({tracked:['coinmarketcap:1']})
   const args=name==='watchlist_add'?{item_type:'token',label:'BTC'}
    :name==='save_research_note'?{title:'x',body:'y'}
    :name==='alert_create'?{asset:'market:coinmarketcap:1',direction:'above',threshold_usd:1,title:'x'}
    :name==='rwa_issuer_terms'?{subject:'rwa:coinmarketcap:2',crypto_id:'36992'}
    :{}
   const res=await handleIntelMcpDemo(post(callTool(name,args)),deps(stub.db))
   assertEquals(res.status,400,name)
   const body=await json(res)
   assertEquals(body.error.code,-32602,name)
   assertStringIncludes(body.error.message,'not part of the public demo')
   assertEquals(stub.reads.length,0,`${name} read a table`)
   assertEquals(stub.writes,[],`${name} wrote`)
   assertEquals(stub.rpcs,[],`${name} ran a database function`)
  }
  // An unknown name is refused by the shared dispatcher in the same shape.
  const stub=stubDb()
  const res=await handleIntelMcpDemo(post(callTool('drop_everything')),deps(stub.db))
  assertEquals(res.status,400)
  assertEquals((await json(res)).error.code,-32602)
  assertEquals(stub.reads.length+stub.writes.length+stub.rpcs.length,0)
  assertEquals(outbound,[])
 }finally{restoreFetch()}
})

Deno.test('callDemoTool refuses an excluded tool even when reached directly',async()=>{
 const stub=stubDb()
 const call=await callDemoTool(demoContext(stub.db,NOW),trackedReaders(stub.db,NOW),'watchlist_add',{item_type:'token',label:'BTC'})
 assertEquals(call.outcome,'refused')
 assertEquals(call.reasonCode,'not_in_demo')
 assert(call.result.isError)
 assertEquals(stub.writes,[])
})

// ── No provider, no write, no database function ────────────────────────────

/** Minimal valid arguments for every demo tool, tracked where a tool names one. */
function argumentsFor(name:string):Array<Record<string,unknown>> {
 switch(name){
  case 'search_assets':return [{query:'BTC'}]
  case 'get_asset':return [{provider:'coinmarketcap',provider_id:'1'},{query:'BTC'}]
  case 'market_structure':return MARKET_FIGURE_NAMES.map(figure=>figure==='liquidations'?{figure,provider_ids:['1']}:figure==='attention'?{figure,provider_id:'1'}:{figure})
  case 'rwa_wrapper_premiums':return [{},{subject:'36992'}]
  case 'rwa_liquidity_depth':return [{},{subject:'cmc:36992'}]
  case 'rwa_best_wrapper':return [{rwa_id:'2'},{crypto_id:'36992'}]
  case 'rwa_premium_history':return [{rwa_id:'2'},{rwa_id:'2',crypto_id:'36992'}]
  case 'rwa_exit_capacity':return [{crypto_id:'36992',position_usd:10000}]
  case 'rwa_underlying_registrant':return [{},{subject:'0001045810'}]
  case 'rwa_issuer_legitimacy':return [{}]
  default:return [{}]
 }
}

const TRACKED_FIXTURE:Fixture={
 tracked:['coinmarketcap:1','coinmarketcap:36992'],
 tables:{
  market_assets:[{source_provider:'coinmarketcap',provider_id:'1',symbol:'BTC',normalized_symbol:'BTC',name:'Bitcoin',market_cap:1,market_cap_rank:1,as_of:RECENT,in_current_catalog:true}],
  intel_rwa_wrapper_assets:[{rwa_id:'2',captured_at:RECENT}],
  intel_rwa_underlying_registrants:[{cik:'0001045810',rwa_id:2}],
 },
}

Deno.test('every demo tool answers with no outbound request, no write and no database function beyond the tracked check',async()=>{
 recordFetch()
 try{
  for(const name of DEMO_TOOL_NAMES){
   for(const args of argumentsFor(name)){
    const stub=stubDb(TRACKED_FIXTURE)
    const res=await handleIntelMcpDemo(post(callTool(name,args)),deps(stub.db))
    assertEquals(res.status,200,`${name} ${JSON.stringify(args)}`)
    const body=await json(res)
    const payload=payloadOf(body)
    assertEquals(payload.error,undefined,`${name} ${JSON.stringify(args)} was not served: ${payload.message}`)
    assertEquals(payload.demo?.server,'investor-intel-demo',`${name} carries no demo marker`)
    assertEquals(payload.demo?.read_only,true)
    assertEquals(stub.writes,[],`${name} wrote`)
    for(const called of stub.rpcs)assertEquals(called,'intel_demo_tracked_assets',`${name} ran ${called}`)
   }
  }
  assertEquals(outbound,[],`a demo tool made an outbound request: ${outbound.join(', ')}`)
 }finally{restoreFetch()}
})

Deno.test('the tools see a database that refuses writes and database functions',async()=>{
 const stub=stubDb()
 const db=readOnlyDb(stub.db)
 let threw=false
 try{db.from('watchlist_items').insert({label:'x'})}catch(error){threw=error instanceof DemoReadOnlyError}
 assert(threw,'insert must throw')
 for(const method of ['update','upsert','delete']){
  let refused=false
  try{db.from('saved_research')[method]({})}catch(error){refused=error instanceof DemoReadOnlyError}
  assert(refused,`${method} must throw`)
 }
 const {error}=await db.rpc('intel_mcp_quota_take',{})
 assertEquals(error.code,'demo_read_only')
 let closed=false
 try{db.functions.invoke('intel-mcp')}catch(e){closed=e instanceof DemoReadOnlyError}
 assert(closed,'Edge Function invocation must be closed')
 assertEquals(stub.writes,[])
 assertEquals(stub.rpcs,[])
 // A read chain still works.
 const {data}=await db.from('market_assets').select('symbol').eq('provider_id','1')
 assertEquals(data,[])
})

Deno.test('the demo context has no account: any read of the agent throws',()=>{
 const ctx=demoContext(stubDb().db,NOW)
 let threw=false
 try{void ctx.agent.orgId}catch(error){threw=error instanceof DemoReadOnlyError}
 assert(threw)
 assertEquals(ctx.tier,'demo')
})

Deno.test('the outbound guard lets through only the project REST path',async()=>{
 const seen:string[]=[]
 const before=globalThis.fetch
 globalThis.fetch=((input:unknown)=>{seen.push(String(input));return Promise.resolve(new Response('[]'))}) as typeof fetch
 const lines:string[]=[]
 const guard=installOutboundGuard('https://project.example/rest/v1/',(line)=>lines.push(line))
 try{
  await fetch('https://project.example/rest/v1/market_assets?select=symbol')
  for(const url of [
   'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?id=1',
   'https://api.coingecko.com/api/v3/simple/price',
   'https://project.example/functions/v1/intel-capture',
   'https://project.example.evil.test/rest/v1/x',
  ]){
   let refused=false
   try{await fetch(url)}catch(error){refused=error instanceof DemoReadOnlyError}
   assert(refused,`${url} must be refused`)
  }
  assertEquals(seen,['https://project.example/rest/v1/market_assets?select=symbol'])
  assertEquals(guard.refused(),4)
  assertEquals(lines.length,4)
 }finally{
  guard.restore()
  globalThis.fetch=before
 }
})

// ── Tracked assets only ────────────────────────────────────────────────────

Deno.test('get_asset answers for a tracked asset and says an untracked one is not tracked, without reading it',async()=>{
 recordFetch()
 try{
  const stub=stubDb(TRACKED_FIXTURE)
  const served=payloadOf(await json(await handleIntelMcpDemo(post(callTool('get_asset',{provider:'coinmarketcap',provider_id:'1'})),deps(stub.db))))
  assertEquals(served.data.asset.symbol,'BTC')
  assert(served.data.state!==NOT_TRACKED)

  const other=stubDb(TRACKED_FIXTURE)
  const res=await handleIntelMcpDemo(post(callTool('get_asset',{provider:'coinmarketcap',provider_id:'99999999'})),deps(other.db))
  assertEquals(res.status,200)
  const body=await json(res)
  assertEquals(body.result.isError,undefined,'not tracked is an answer, not an error')
  const payload=payloadOf(body)
  assertEquals(payload.data.state,NOT_TRACKED)
  assertEquals(payload.data.asked,{provider:'coinmarketcap',provider_id:'99999999'})
  assertEquals(other.reads.filter(read=>read.table==='market_assets').length,0,'an untracked id is refused before it is read')
  assertEquals(outbound,[])
 }finally{restoreFetch()}
})

Deno.test('get_asset by query resolves first and refuses when the best match is untracked',async()=>{
 const stub=stubDb({tracked:[],tables:{market_assets:[{source_provider:'coinmarketcap',provider_id:'424242',symbol:'ZZQX',normalized_symbol:'ZZQX',name:'Random',in_current_catalog:true}]}})
 const payload=payloadOf(await json(await handleIntelMcpDemo(post(callTool('get_asset',{query:'ZZQX'})),deps(stub.db))))
 assertEquals(payload.data.state,NOT_TRACKED)
})

Deno.test('search_assets drops every untracked match',async()=>{
 const stub=stubDb({tracked:['coinmarketcap:1'],tables:{market_assets:[
  {source_provider:'coinmarketcap',provider_id:'1',symbol:'BTC',normalized_symbol:'BTC',name:'Bitcoin',market_cap:10,market_cap_rank:1,in_current_catalog:true},
  {source_provider:'coinmarketcap',provider_id:'777',symbol:'BTC',normalized_symbol:'BTC',name:'Bitcoin copy',market_cap:1,market_cap_rank:900,in_current_catalog:true},
 ]}})
 const payload=payloadOf(await json(await handleIntelMcpDemo(post(callTool('search_assets',{query:'BTC',limit:5})),deps(stub.db))))
 assertEquals(payload.data.matches.map((m:{providerId:string})=>m.providerId),['1'])
 assertEquals(payload.data.limit,5)
 assertStringIncludes(payload.note,'does not track')
})

Deno.test('asset-scoped RWA tools answer not_tracked_in_demo for an untracked token or asset',async()=>{
 for(const [name,args] of [
  ['rwa_exit_capacity',{crypto_id:'123456789',position_usd:1000}],
  ['rwa_wrapper_premiums',{subject:'123456789'}],
  ['rwa_liquidity_depth',{subject:'contract:ethereum:0xabc'}],
  ['rwa_best_wrapper',{rwa_id:'999999'}],
  ['rwa_premium_history',{rwa_id:'999999'}],
  ['rwa_underlying_registrant',{subject:'0000000001'}],
  ['market_structure',{figure:'attention',provider_id:'123456789'}],
 ] as Array<[string,Record<string,unknown>]>){
  const stub=stubDb(TRACKED_FIXTURE)
  const body=await json(await handleIntelMcpDemo(post(callTool(name,args)),deps(stub.db)))
  const payload=payloadOf(body)
  assertEquals(payload.data.state,NOT_TRACKED,name)
  assertEquals(body.result.isError,undefined,name)
  assertEquals(payload.demo.server,'investor-intel-demo')
 }
})

// ── Limits ─────────────────────────────────────────────────────────────────

Deno.test('the per-minute tool limit refuses with 429 and a Retry-After, and nothing runs',async()=>{
 const stub=stubDb(TRACKED_FIXTURE)
 const d=deps(stub.db,{limit:(key)=>Promise.resolve(key.endsWith(':tool')?{ok:false,retryAfter:17}:{ok:true,retryAfter:0})})
 const res=await handleIntelMcpDemo(post(callTool('rwa_coverage')),d)
 assertEquals(res.status,429)
 assertEquals(res.headers.get('Retry-After'),'17')
 const body=await json(res)
 assertEquals(body.jsonrpc,'2.0')
 assertStringIncludes(body.error.message,`${DEMO_LIMITS.toolCallsPerMinute} tool calls a minute`)
 assertEquals(stub.reads.length,0)
})

Deno.test('a burst past the per-minute limit is refused, counted by the hashed address only',async()=>{
 const stub=stubDb(TRACKED_FIXTURE)
 const counts=new Map<string,number>()
 const d=deps(stub.db,{limit:(key,limit)=>{const n=(counts.get(key)??0)+1;counts.set(key,n);return Promise.resolve(n>limit?{ok:false,retryAfter:60}:{ok:true,retryAfter:0})}})
 const statuses:number[]=[]
 for(let i=0;i<DEMO_LIMITS.toolCallsPerMinute+3;i++)statuses.push((await handleIntelMcpDemo(post(callTool('market_regime')),d)).status)
 assertEquals(statuses.filter(status=>status===200).length,DEMO_LIMITS.toolCallsPerMinute)
 assertEquals(statuses.slice(-3),[429,429,429])
 for(const key of counts.keys()){
  assert(!key.includes('203.0.113.9'),'a raw address reached the limiter')
  assert(key.startsWith(`ip:${HASH}:mcp-demo:`))
 }
 for(const line of d.lines)assert(!JSON.stringify(line).includes('203.0.113.9'),'a raw address reached the log')
})

Deno.test('the daily allowance refuses with 429 and names when it resets',async()=>{
 const stub=stubDb(TRACKED_FIXTURE)
 const res=await handleIntelMcpDemo(post(callTool('rwa_coverage')),deps(stub.db,{daily:()=>Promise.resolve({allowed:false,reason:'daily_cap_reached',resetsAt:'2026-09-24T00:00:00.000Z'})}))
 assertEquals(res.status,429)
 assertEquals(res.headers.get('Retry-After'),String(6*3600))
 assertStringIncludes((await json(res)).error.message,'2026-09-24T00:00:00.000Z')
 assertEquals(stub.reads.length,0)
})

Deno.test('an unavailable daily counter or an unconfigured salt closes the demo rather than leaving it unmetered',async()=>{
 const stub=stubDb(TRACKED_FIXTURE)
 const unavailable=await handleIntelMcpDemo(post(callTool('rwa_coverage')),deps(stub.db,{daily:()=>Promise.resolve({allowed:false,reason:'limiter_unavailable',resetsAt:null})}))
 assertEquals(unavailable.status,503)
 const noSalt=await handleIntelMcpDemo(post(rpc('initialize')),deps(stub.db,{ipKey:()=>Promise.reject(new Error('RATE_LIMIT_SALT is not configured'))}))
 assertEquals(noSalt.status,503)
 assertEquals(stub.reads.length,0)
})

Deno.test('a handshake is not charged to the daily allowance',async()=>{
 let taken=0
 const stub=stubDb()
 const d=deps(stub.db,{daily:()=>{taken++;return Promise.resolve({allowed:true,reason:null,resetsAt:null})}})
 await handleIntelMcpDemo(post(rpc('initialize',{protocolVersion:'2025-06-18'})),d)
 await handleIntelMcpDemo(post(rpc('tools/list')),d)
 await handleIntelMcpDemo(post(rpc('ping')),d)
 assertEquals(taken,0)
 await handleIntelMcpDemo(post(callTool('rwa_coverage')),d)
 assertEquals(taken,1)
})

Deno.test('an oversize body is 413 before it is parsed',async()=>{
 const stub=stubDb()
 const res=await handleIntelMcpDemo(post(JSON.stringify({jsonrpc:'2.0',id:1,method:'ping',params:{pad:'x'.repeat(DEMO_LIMITS.maxBodyBytes)}})),deps(stub.db))
 assertEquals(res.status,413)
 assertEquals((await json(res)).error.code,-32700)
})

Deno.test('an answer over the byte bound drops structuredContent, then is refused in words',()=>{
 const small={content:[{type:'text',text:'x'.repeat(100)}],structuredContent:{a:'x'.repeat(100)}}
 assertEquals(fitResponse(1,small,3000,NOW).trimmed,null)
 const doubled={content:[{type:'text',text:'x'.repeat(1600)}],structuredContent:{a:'x'.repeat(1600)}}
 const dropped=fitResponse(1,doubled,3000,NOW)
 assertEquals(dropped.trimmed,'structured_content_dropped')
 assert(!dropped.text.includes('structuredContent'))
 const huge={content:[{type:'text',text:'x'.repeat(10000)}]}
 const refused=fitResponse(1,huge,3000,NOW)
 assertEquals(refused.trimmed,'result_too_large')
 assertStringIncludes(refused.text,'result_too_large')
 assert(new TextEncoder().encode(refused.text).byteLength<=3000)
})

// ── The protocol and the marker ────────────────────────────────────────────

Deno.test('initialize names the demo server and its instructions say it is read only',async()=>{
 const res=await handleIntelMcpDemo(post(rpc('initialize',{protocolVersion:'2025-06-18'})),deps(stubDb().db))
 const body=await json(res)
 assertEquals(body.result.serverInfo.name,'investor-intel-demo')
 assertEquals(body.result.protocolVersion,'2025-06-18')
 assertStringIncludes(body.result.instructions,'read-only')
 assertStringIncludes(body.result.instructions,'18 of the 28')
})

Deno.test('a notification gets 202 and an empty body; ping answers',async()=>{
 const res=await handleIntelMcpDemo(post({jsonrpc:'2.0',method:'notifications/initialized'}),deps(stubDb().db))
 assertEquals(res.status,202)
 assertEquals(await res.text(),'')
 const pong=await json(await handleIntelMcpDemo(post(rpc('ping')),deps(stubDb().db)))
 assertEquals(pong.result,{})
})

Deno.test('OPTIONS is a CORS preflight a browser inspector accepts; GET is 405',async()=>{
 const pre=await handleIntelMcpDemo(new Request('https://demo.test/x',{method:'OPTIONS'}),deps(stubDb().db))
 assertEquals(pre.status,204)
 assertEquals(pre.headers.get('Access-Control-Allow-Origin'),'*')
 assertStringIncludes(pre.headers.get('Access-Control-Allow-Headers')??'','mcp-protocol-version')
 const get=await handleIntelMcpDemo(new Request('https://demo.test/x',{method:'GET'}),deps(stubDb().db))
 assertEquals(get.status,405)
 assertEquals(get.headers.get('Allow'),'POST, OPTIONS')
 const ok=await handleIntelMcpDemo(post(rpc('ping')),deps(stubDb().db))
 assertEquals(ok.headers.get('Access-Control-Allow-Origin'),'*')
})

Deno.test('a bearer token changes nothing: the demo never reads Authorization',async()=>{
 const stub=stubDb()
 const res=await handleIntelMcpDemo(post(rpc('tools/list'),{authorization:'Bearer tcfagt_not_a_real_token'}),deps(stub.db))
 assertEquals(res.status,200)
 assertEquals((await json(res)).result.tools.length,18)
})

Deno.test('every tool result carries the demo marker with its as_of, and the log line carries the demo identity',async()=>{
 const stub=stubDb({tables:{intel_regime_snapshots:[{captured_at:RECENT}]}})
 const d=deps(stub.db)
 const payload=payloadOf(await json(await handleIntelMcpDemo(post(callTool('rwa_coverage')),d)))
 assertEquals(payload.demo.server,'investor-intel-demo')
 assertEquals(payload.demo.data,'stored')
 assert('as_of' in payload.demo)
 assertStringIncludes(payload.demo.notice,'Read-only public demo data')
 const line=d.lines.at(-1)!
 assertEquals(line.fn,'intel-mcp-demo')
 assertEquals(line.identity,'public-demo')
 assertEquals(line.tool,'rwa_coverage')
 assertEquals(line.caller,`ip:${HASH.slice(0,12)}`)
 assert(!('arguments' in line))
})

Deno.test('resources and prompts are the demo versions',async()=>{
 const d=deps(stubDb().db)
 const tools=await json(await handleIntelMcpDemo(post(rpc('resources/read',{uri:'investor-intel://tools'})),d))
 const catalogue=JSON.parse(tools.result.contents[0].text)
 assertEquals(catalogue.tools.length,18)
 assertEquals(catalogue.not_in_demo.length,10)
 const prompt=await json(await handleIntelMcpDemo(post(rpc('prompts/get',{name:'rwa_due_diligence',arguments:{subject:'rwa:coinmarketcap:2'}})),d))
 assertStringIncludes(prompt.result.messages[0].content.text,'rwa_issuer_terms is not available')
})
