// Investor Intel public MCP demo: the HTTP and JSON-RPC handler.
//
// verify_jwt IS FALSE FOR THIS FUNCTION, on purpose (supabase/config.toml,
// [functions.intel-mcp-demo]). Anyone may call it with no account and no key,
// which is the point: a person can connect an MCP client to one URL and try the
// read tools. The handler never reads the Authorization header, never resolves a
// user or an org, never calls a provider, never runs AI and never writes a row
// anyone owns. It owns its own protection instead:
//
//   1. Per network address, hashed with the salted rate-limit key (never stored
//      or logged raw): DEMO_LIMITS requests a minute, tool calls a minute, tool
//      calls a UTC day, plus one ceiling on tool calls a day for everyone
//      together. All of them fail CLOSED: an unconfigured or unavailable limiter
//      stops the demo rather than leaving it unmetered.
//   2. A bounded body (16 KiB) and a bounded answer (256 KiB). An answer over the
//      bound drops its duplicate structuredContent first, then is refused in
//      words, never cut mid-JSON.
//   3. The tool allowlist, the read-only database, the tracked-asset gate and the
//      demo marker, in ./demo-tools.ts.
//   4. A demo identity on every log line: the function name, 'public-demo' and a
//      12-character prefix of the salted address hash. No arguments are logged.
//
// The same MCP Streamable HTTP subset as intel-mcp, from the same protocol module:
// stateless, POST only, one JSON response, no session and no server stream.
//
// Kept free of the Supabase client so its tests run without it; ./index.ts wires
// the production dependencies.

import {readBoundedText,RequestBodyError} from '../_shared/intel/bounded-request.ts'
import {
 dispatchRpc,parseRpcRequest,isNotification,rpcSuccess,rpcFailure,errorToolResult,JsonRpcError,RPC,
 LATEST_PROTOCOL_VERSION,type McpDispatch,type McpToolResult,type JsonRpcRequest,
} from '../_shared/intel/mcp-protocol.ts'
import {
 DEMO_SERVER_INFO,DEMO_INSTRUCTIONS,DEMO_RESOURCES,DEMO_PROMPTS,demoToolDefinitions,readDemoResource,getDemoPrompt,
 demoContext,trackedReaders,callDemoTool,demoMarker,DEMO_EXCLUDED,type TrackedReaders,
} from './demo-tools.ts'

// deno-lint-ignore no-explicit-any
type Db=any

export const DEMO_LIMITS={
 /** Every JSON-RPC request, per address. A client may re-handshake each turn. */
 requestsPerMinute:60,
 /** tools/call, per address. */
 toolCallsPerMinute:30,
 /** tools/call, per address, per UTC day (public.intel_mcp_demo_take). */
 toolCallsPerDay:300,
 /** tools/call, every address together, per UTC day. */
 allToolCallsPerDay:10_000,
 maxBodyBytes:16_384,
 maxResponseBytes:262_144,
} as const

export interface DailyVerdict {
 allowed:boolean
 /** 'daily_cap_reached', 'demo_daily_cap_reached' or 'limiter_unavailable'. */
 reason:string|null
 resetsAt:string|null
}

export interface DemoHandlerDeps {
 /** The service-role client. The tools only ever see readOnlyDb(db). */
 db:Db
 /** Salted hash of the caller's address, `ip:<32 hex>:<bucket>`. Throws when the
  * salt is not configured. */
 ipKey(req:Request):Promise<string>
 /** Sliding-window limiter over rate_limit_log. Must fail closed. */
 limit(key:string,limit:number,windowSeconds:number):Promise<{ok:boolean;retryAfter:number}>
 /** Take one tool call from the address's and everyone's UTC-day allowance. */
 daily(caller:string):Promise<DailyVerdict>
 tracked?:TrackedReaders
 now?():number
 log?(line:Record<string,unknown>):void
 /** Outbound requests the guard has refused so far, for the log line. */
 outboundRefused?():number
}

const cors={
 'Access-Control-Allow-Origin':'*',
 'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id',
 'Access-Control-Allow-Methods':'POST, OPTIONS',
 'Access-Control-Max-Age':'86400',
 'Access-Control-Expose-Headers':'mcp-session-id, mcp-protocol-version, retry-after',
}
const jsonHeaders={...cors,'Content-Type':'application/json','Cache-Control':'no-store','MCP-Protocol-Version':LATEST_PROTOCOL_VERSION}
const encoder=new TextEncoder()
const bytes=(text:string)=>encoder.encode(text).byteLength

function respond(text:string,status:number,extra:Record<string,string>={}):Response {
 return new Response(text,{status,headers:{...jsonHeaders,...extra}})
}
function rpcError(status:number,code:number,message:string,id:string|number|undefined,extra:Record<string,string>={}):Response {
 return respond(JSON.stringify(rpcFailure(id,code,message)),status,extra)
}

/** The whole JSON-RPC answer under the byte bound. A tool answer that is too big
 * loses its structuredContent (the same JSON is in its text block), and if that
 * is not enough it is replaced by a refusal that says what to narrow. */
export function fitResponse(id:string|number|undefined,result:Record<string,unknown>,max:number,now:number):{text:string;trimmed:string|null} {
 let text=JSON.stringify(rpcSuccess(id,result))
 if(bytes(text)<=max)return {text,trimmed:null}
 if('structuredContent' in result){
  const {structuredContent:_dropped,...rest}=result
  text=JSON.stringify(rpcSuccess(id,rest))
  if(bytes(text)<=max)return {text,trimmed:'structured_content_dropped'}
 }
 const refusal:McpToolResult=errorToolResult('result_too_large',`This answer is larger than the public demo returns (${max} bytes). Ask for fewer rows, a shorter window or one subject.`,{demo:demoMarker(null,now)})
 return {text:JSON.stringify(rpcSuccess(id,refusal as unknown as Record<string,unknown>)),trimmed:'result_too_large'}
}

const inSeconds=(n:number)=>`${n} second${n===1?'':'s'}`

function secondsUntil(iso:string|null,now:number,fallback:number):number {
 const at=iso?Date.parse(iso):NaN
 return Number.isFinite(at)?Math.max(1,Math.ceil((at-now)/1000)):fallback
}

export async function handleIntelMcpDemo(req:Request,deps:DemoHandlerDeps):Promise<Response> {
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors})
 if(req.method!=='POST'){
  return rpcError(405,RPC.INVALID_REQUEST,`This MCP server is POST only. ${req.method} is not supported: it is stateless and opens no server-initiated stream.`,undefined,{Allow:'POST, OPTIONS'})
 }
 const started=Date.now()
 const now=deps.now?.()??started
 const refusedBefore=deps.outboundRefused?.()??0
 const log=(line:Record<string,unknown>)=>{
  const entry={fn:'intel-mcp-demo',identity:'public-demo',...line,ms:Date.now()-started,outbound_refused:(deps.outboundRefused?.()??0)-refusedBefore}
  if(deps.log)deps.log(entry);else console.log(JSON.stringify(entry))
 }

 // ── The address, hashed, and the request limit, before the body is read ──
 let caller:string
 try{
  const match=/^ip:([0-9a-f]{32}):/.exec(await deps.ipKey(req))
  if(!match)throw new Error('unexpected_key')
  caller=`ip:${match[1]}`
 }catch{
  console.error('[intel-mcp-demo] the rate limiter is not configured; refusing')
  return rpcError(503,RPC.INTERNAL_ERROR,'The demo\'s rate limiter is not configured, so the demo is closed. Nothing was read.',undefined)
 }
 const who=caller.slice(0,15)
 const requests=await deps.limit(`${caller}:mcp-demo:req`,DEMO_LIMITS.requestsPerMinute,60)
 if(!requests.ok){
  const retry=Math.max(1,requests.retryAfter||60)
  log({caller:who,outcome:'refused',reason:'rate_limited'})
  return rpcError(429,RPC.INTERNAL_ERROR,`This demo allows ${DEMO_LIMITS.requestsPerMinute} requests a minute from one address. Retry in ${inSeconds(retry)}.`,undefined,{'Retry-After':String(retry)})
 }

 // ── The body ────────────────────────────────────────────────────────────
 let request:JsonRpcRequest
 let id:string|number|undefined
 try{
  const body=JSON.parse(await readBoundedText(req,DEMO_LIMITS.maxBodyBytes))
  if(body&&typeof body==='object'&&!Array.isArray(body)){
   const raw=(body as Record<string,unknown>).id
   if(typeof raw==='string'||typeof raw==='number')id=raw
  }
  request=parseRpcRequest(body)
 }catch(error){
  if(error instanceof RequestBodyError&&error.status===413){
   log({caller:who,outcome:'refused',reason:'request_too_large'})
   return rpcError(413,RPC.PARSE_ERROR,`A request body may be at most ${DEMO_LIMITS.maxBodyBytes} bytes.`,undefined)
  }
  if(error instanceof JsonRpcError)return rpcError(400,error.code,error.message,id)
  return rpcError(400,RPC.PARSE_ERROR,'The request body was not valid JSON.',undefined)
 }
 id=request.id
 const isToolCall=request.method==='tools/call'
 const tool=isToolCall?(typeof request.params?.name==='string'?request.params.name.slice(0,80):'(none)'):null

 // ── Tool-call limits ────────────────────────────────────────────────────
 if(isToolCall){
  const minute=await deps.limit(`${caller}:mcp-demo:tool`,DEMO_LIMITS.toolCallsPerMinute,60)
  if(!minute.ok){
   const retry=Math.max(1,minute.retryAfter||60)
   log({caller:who,method:request.method,tool,outcome:'refused',reason:'rate_limited'})
   return rpcError(429,RPC.INTERNAL_ERROR,`This demo allows ${DEMO_LIMITS.toolCallsPerMinute} tool calls a minute from one address. Retry in ${inSeconds(retry)}.`,id,{'Retry-After':String(retry)})
  }
  const day=await deps.daily(caller)
  if(!day.allowed){
   if(day.reason==='limiter_unavailable'||!day.reason){
    log({caller:who,method:request.method,tool,outcome:'refused',reason:'limiter_unavailable'})
    return rpcError(503,RPC.INTERNAL_ERROR,'The demo\'s daily allowance could not be read, so nothing ran. Retry when the service is ready.',id)
   }
   const retry=secondsUntil(day.resetsAt,now,3600)
   const everyone=day.reason==='demo_daily_cap_reached'
   log({caller:who,method:request.method,tool,outcome:'refused',reason:day.reason})
   return rpcError(429,RPC.INTERNAL_ERROR,everyone
    ?`The public demo has answered its ${DEMO_LIMITS.allToolCallsPerDay} tool calls for today. It resets at ${day.resetsAt??'midnight UTC'}.`
    :`This demo allows ${DEMO_LIMITS.toolCallsPerDay} tool calls a day from one address. It resets at ${day.resetsAt??'midnight UTC'}.`,
   id,{'Retry-After':String(retry)})
  }
 }

 // A tool the full server has and the demo leaves out is named with the reason,
 // rather than reported as unknown. Nothing is read either way.
 if(isToolCall&&tool&&Object.hasOwn(DEMO_EXCLUDED,tool)){
  log({caller:who,method:request.method,tool,outcome:'refused',reason:'not_in_demo'})
  return rpcError(400,RPC.INVALID_PARAMS,`${tool} is not part of the public demo. ${DEMO_EXCLUDED[tool]} It needs an Investor Intel account (Starter plan or above) and an agent token on the full server. Call tools/list to see what the demo offers.`,id)
 }

 // ── Dispatch ────────────────────────────────────────────────────────────
 const ctx=demoContext(deps.db,now)
 const tracked=deps.tracked??trackedReaders(deps.db,now)
 let outcome='served'
 let reason:string|null=null
 const dispatch:McpDispatch={
  instructions:DEMO_INSTRUCTIONS,
  listTools:demoToolDefinitions,
  listResources:()=>DEMO_RESOURCES,
  readResource:readDemoResource,
  listPrompts:()=>DEMO_PROMPTS,
  getPrompt:getDemoPrompt,
  callTool:async(name,args)=>{
   const call=await callDemoTool(ctx,tracked,name,args)
   outcome=call.outcome;reason=call.reasonCode
   return call.result
  },
 }
 try{
  let result=await dispatchRpc(request,dispatch)
  // The shared protocol names the full server; this one says it is the demo.
  if(request.method==='initialize'&&result)result={...result,serverInfo:DEMO_SERVER_INFO}
  if(isNotification(request)){
   log({caller:who,method:request.method,outcome:'served'})
   return new Response(null,{status:202,headers:cors})
  }
  const fitted=fitResponse(request.id,result??{},DEMO_LIMITS.maxResponseBytes,now)
  log({caller:who,method:request.method,tool,outcome:fitted.trimmed==='result_too_large'?'refused':outcome,reason:fitted.trimmed??reason,bytes:bytes(fitted.text)})
  return respond(fitted.text,200)
 }catch(error){
  if(error instanceof JsonRpcError){
   // Includes a tools/call naming a tool outside the allowlist: the shared
   // dispatcher refuses any name tools/list did not return.
   log({caller:who,method:request.method,tool,outcome:'refused',reason:'protocol_error'})
   return rpcError(400,error.code,error.message,id)
  }
  console.error('[intel-mcp-demo]',error instanceof Error?error.message.slice(0,200):'unavailable')
  log({caller:who,method:request.method,tool,outcome:'failed',reason:'unavailable'})
  return rpcError(503,RPC.INTERNAL_ERROR,'The Investor Intel demo is unavailable right now. Retry when the service is ready.',id)
 }
}
