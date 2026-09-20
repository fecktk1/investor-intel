// Investor Intel as a hosted MCP server.
//
// A member mints an agent token in Investor Intel and hands this one URL to
// whatever agent they use. No install, no local process, no Node: Claude Code,
// Claude Desktop, Cursor and anything else that speaks MCP Streamable HTTP
// connect to the same endpoint with the same header.
//
// verify_jwt IS FALSE FOR THIS FUNCTION, and it has to be. An MCP client sends
// `Authorization: Bearer tcfagt_...`, which is an inbound agent token and NOT a
// Supabase JWT, so the gateway cannot verify it and would reject every legitimate
// caller if it tried. That value is set PER FUNCTION at deploy time
// (supabase/config.toml, [functions.intel-mcp]); deploying without it makes the
// server unreachable rather than insecure, which is the right way round but still
// broken. This handler therefore owns the whole of authorization:
//
//   1. A bearer token, or 401 with WWW-Authenticate so a client knows what is
//      wanted rather than guessing at a bare 401.
//   2. authenticateAgentToken: the stored hash, then LIVE membership and LIVE
//      can_access_intel. A token proves who issued it, never that they are still
//      entitled.
//   3. requireIntelSurface(..., 'agent_access'): the plan, re-checked on every
//      request, so a downgrade stops tokens minted while the plan was higher.
//   4. Per-token minute and day budgets, both fail closed.
//   5. Per-tool scope and per-tool surface, inside callMcpTool.
//
// A SESSION CANNOT USE THIS SURFACE. intel-agent-api keeps the management
// operations that mint, list, revoke and approve; nothing here can reach them, so
// a token still cannot widen itself or approve its own write. The split is the
// reason scopes mean anything and it is preserved exactly: this function refuses
// anything that is not an agent token, rather than falling back to a session.
//
// STATELESS. One POST, one JSON response. No session store, no SSE, no
// server-initiated stream, so GET and DELETE are 405 with Allow rather than an
// idle 200 that would leave a client waiting for events that never come.

import {createClient} from 'npm:@supabase/supabase-js@2'
import {orgAuthzErrorResponse} from '../_shared/org-authz.ts'
import {requireIntelSurface,surfaceLockedResponse} from '../_shared/intel/intel-surface-access.ts'
import {readBoundedText,RequestBodyError} from '../_shared/intel/bounded-request.ts'
import {AgentAuthError,authenticateAgentToken,isAgentTokenRequest,bearerToken} from '../_shared/intel/agent-token.ts'
import {hashedIpKey} from '../_shared/rate-limit.ts'
import {
 dispatchRpc,parseRpcRequest,isNotification,rpcSuccess,rpcFailure,JsonRpcError,RPC,
 SUPPORTED_PROTOCOL_VERSIONS,LATEST_PROTOCOL_VERSION,type McpDispatch,
} from '../_shared/intel/mcp-protocol.ts'
import {
 buildToolContext,callMcpTool,toolDefinitions,SERVER_INSTRUCTIONS,MCP_RESOURCES,MCP_PROMPTS,
} from '../_shared/intel/mcp-tools.ts'
import {enforceMinuteLimit,takeDailyCall,auditCall} from '../_shared/intel/mcp-quota.ts'

// A JSON-RPC body is small by nature: the largest thing a client sends is a tool
// argument, and every one of those has a maxLength. 64 KiB is generous for that
// and rejects a body nobody legitimately sends.
const MAX_BODY_BYTES=65536

// `mcp-session-id` and `mcp-protocol-version` are allowed in because clients send
// them, and `last-event-id` because a resumable-stream client will try. They are
// accepted and ignored rather than refused: a header cannot change the answer of
// a stateless server, and refusing one would break a client over nothing.
const cors={
 'Access-Control-Allow-Origin':'*',
 'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id',
 'Access-Control-Allow-Methods':'POST, OPTIONS',
 'Access-Control-Max-Age':'86400',
 'Access-Control-Expose-Headers':'mcp-session-id, mcp-protocol-version, www-authenticate, retry-after',
}

const jsonHeaders={...cors,'Content-Type':'application/json','Cache-Control':'private, no-store','MCP-Protocol-Version':LATEST_PROTOCOL_VERSION}
const json=(body:unknown,status=200,extra:Record<string,string>={})=>
 new Response(JSON.stringify(body),{status,headers:{...jsonHeaders,...extra}})

/** A transport-level refusal, in JSON-RPC shape.
 *
 * Even a 401 carries a JSON-RPC error object, because a client that sent
 * `{"method":"initialize","id":1}` and gets back a bare `{"error":"..."}` reports
 * "malformed response" to the person instead of "you need a token". */
function rpcError(status:number,code:number,message:string,id:string|number|undefined,extra:Record<string,string>={}) {
 return json(rpcFailure(id,code,message),status,extra)
}

/** HTTP statuses that mean "no usable credential", and so want a challenge. */
const CHALLENGE=new Set([401])

function challengeHeader():Record<string,string> {
 return {'WWW-Authenticate':'Bearer realm="Investor Intel MCP", error="invalid_token", error_description="Send an Investor Intel agent token: Authorization: Bearer tcfagt_..."'}
}

export async function handleIntelMcp(req:Request):Promise<Response> {
 if(req.method==='OPTIONS')return new Response('ok',{headers:cors})
 // No server-initiated stream exists, so there is nothing for a GET to open. The
 // Allow header is what tells a client to stop trying rather than hang.
 if(req.method!=='POST'){
  return json(
   {jsonrpc:'2.0',id:null,error:{code:RPC.INVALID_REQUEST,message:`This MCP server is POST only. ${req.method} is not supported: it is stateless and opens no server-initiated stream, so there is no event stream to subscribe to and no session to delete.`}},
   405,{Allow:'POST, OPTIONS'},
  )
 }

 // The id is parsed before authentication so a refusal can be correlated with the
 // request that caused it. Nothing else from the body is trusted or used.
 let id:string|number|undefined
 let body:unknown
 try{
  const text=await readBoundedText(req,MAX_BODY_BYTES)
  body=JSON.parse(text)
  if(body&&typeof body==='object'&&!Array.isArray(body)){
   const raw=(body as Record<string,unknown>).id
   if(typeof raw==='string'||typeof raw==='number')id=raw
  }
 }catch(error){
  if(error instanceof RequestBodyError){
   return rpcError(error.status===413?413:400,RPC.PARSE_ERROR,error.status===413?`A request body may be at most ${MAX_BODY_BYTES} bytes.`:'The request body was not valid JSON.',undefined)
  }
  return rpcError(400,RPC.PARSE_ERROR,'The request body was not valid JSON.',undefined)
 }

 const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
 const started=Date.now()
 let audit:{tokenId:string;orgId:string;userId:string}|null=null
 let toolName='(protocol)'

 try{
  // ── Authorization, before the method is even looked at ───────────────────
  const bearer=bearerToken(req)
  if(!bearer){
   return rpcError(401,RPC.INVALID_REQUEST,'This MCP server needs an Investor Intel agent token. Send Authorization: Bearer tcfagt_... Create one in Investor Intel under Settings, then Your own agent.',id,challengeHeader())
  }
  if(!isAgentTokenRequest(req)){
   // A Supabase session JWT reaching here is almost always a client configured
   // with the wrong credential, so it is named rather than reported as invalid.
   return rpcError(401,RPC.INVALID_REQUEST,'That bearer is not an Investor Intel agent token. An agent token starts with tcfagt_ and is not a Supabase session key. Minting, listing and approving are done by a signed-in member in Investor Intel, not through this server.',id,challengeHeader())
  }

  let ipHash:string|undefined
  try{ipHash=(await hashedIpKey(req,'mcp')).slice(0,64)}catch{ipHash=undefined}
  const requestId=crypto.randomUUID()
  const agent=await authenticateAgentToken(db,req,{requestId,ipHash,now:started})
  // The plan, asked again on every request rather than only at mint time.
  await requireIntelSurface(db,{userId:agent.userId,orgId:agent.orgId,isSuperAdmin:false,isService:false},'agent_access')
  audit={tokenId:agent.tokenId,orgId:agent.orgId,userId:agent.userId}

  const request=parseRpcRequest(body)
  id=request.id
  const isToolCall=request.method==='tools/call'
  if(isToolCall&&typeof request.params?.name==='string')toolName=request.params.name

  // Every request costs a protocol slot; a tool call costs a tool slot and one of
  // today's calls as well. A handshake does not eat the daily allowance, because
  // some clients re-handshake per turn and that is not the member's doing.
  await enforceMinuteLimit(db,agent.tokenId,'protocol')
  if(isToolCall){
   await enforceMinuteLimit(db,agent.tokenId,'tool')
   await takeDailyCall(db,agent.tokenId,agent.orgId)
  }

  const ctx=await buildToolContext(db,agent,started)
  let outcome:'served'|'refused'|'failed'='served'
  let reasonCode:string|null=null
  let tierLocked=false

  const dispatch:McpDispatch={
   instructions:SERVER_INSTRUCTIONS,
   listTools:()=>toolDefinitions(),
   listResources:()=>MCP_RESOURCES,
   listPrompts:()=>MCP_PROMPTS,
   callTool:async(name,args)=>{
    const call=await callMcpTool(ctx,name,args)
    outcome=call.outcome;reasonCode=call.reasonCode;tierLocked=call.tierLocked
    return call.result
   },
  }

  const result=await dispatchRpc(request,dispatch)

  if(isToolCall&&audit){
   const size=result?JSON.stringify(result).length:0
   // Awaited, not fired and forgotten: an Edge Function can be frozen the moment
   // the response is returned, so a floating insert is a row that sometimes does
   // not exist. The insert is one statement and never fails the request.
   await auditCall(db,{...audit,tool:toolName,outcome,reasonCode,tierLocked,durationMs:Date.now()-started,resultBytes:size})
  }

  // A notification gets 202 and an empty body. Returning a JSON-RPC result for
  // something with no id would be a response to a request that was never made.
  if(isNotification(request))return new Response(null,{status:202,headers:cors})
  return json(rpcSuccess(request.id,result??{}))
 }catch(error){
  // A refused tool call is still a call, and the audit row is what makes a
  // refusal countable. Written on the error path too, for exactly that reason.
  if(audit&&toolName!=='(protocol)'){
   const code=error instanceof AgentAuthError?error.code:error instanceof JsonRpcError?'protocol_error':'unavailable'
   await auditCall(db,{...audit,tool:toolName,outcome:'refused',reasonCode:code,tierLocked:false,durationMs:Date.now()-started,resultBytes:0})
  }
  if(error instanceof JsonRpcError)return rpcError(400,error.code,error.message,id)
  const locked=surfaceLockedResponse(error,cors)
  if(locked){
   // The whole surface, not one tool: the workspace's plan no longer includes
   // agent access at all. Said in words, with nothing withheld attached.
   return rpcError(403,RPC.INVALID_REQUEST,'Agent access is not part of this workspace\'s plan, so this token cannot be used. It is part of the Starter plan and above. Nothing was read.',id)
  }
  if(error instanceof AgentAuthError){
   const extra:Record<string,string>={
    ...(CHALLENGE.has(error.status)?challengeHeader():{}),
    ...(error.status===429?{'Retry-After':'60'}:{}),
   }
   return rpcError(error.status,error.status===429?RPC.INTERNAL_ERROR:RPC.INVALID_REQUEST,`${error.code}: ${error.message}`,id,extra)
  }
  const authz=orgAuthzErrorResponse(error,cors)
  if(authz)return authz
  const message=error instanceof Error?error.message:'mcp_unavailable'
  console.error('[intel-mcp]',message)
  return rpcError(503,RPC.INTERNAL_ERROR,'Investor Intel is unavailable for agents right now. Retry when the service is ready.',id)
 }
}

/** Exported for the tests, so the supported set cannot drift from what is
 * advertised without a test noticing. */
export {SUPPORTED_PROTOCOL_VERSIONS}

if(import.meta.main)Deno.serve(handleIntelMcp)
