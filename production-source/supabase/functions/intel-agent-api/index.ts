// Bring your own agent: the one door into Investor Intel for software a member
// chose themselves.
//
// The gateway cannot help here. An inbound agent token is not a Supabase JWT, so
// verify_jwt is off and this handler is solely responsible for authorization. It
// does three things before any work happens:
//
//   1. Decides which surface the caller is on, from the Authorization bearer.
//      An agent token is refused on every management operation, so a token can
//      never mint or widen a token — including its own.
//   2. Verifies the caller. A token is checked against its stored hash and then
//      against LIVE membership and can_access_intel; a session goes through
//      requireIntelAccess exactly as every other Intel function does.
//   3. Rate-limits per token, per minute, per operation class.
//
// RATE LIMITER: FAIL CLOSED. _shared/rate-limit.ts throws when RATE_LIMIT_SALT
// is unset, and its own guidance is that callers should fail open so a missing
// secret cannot lock legitimate users out of a public flow. This is not a public
// flow. It is a bearer-token surface that can create alerts and annotate a
// member's charts, and an unsalted limiter here would mean unbounded automated
// write attempts against a member's book. So a missing salt returns 503
// limiter_unavailable, matching what the extension's enforceRateLimit does for
// the same reason. The cost of that choice is honest and worth naming: if
// RATE_LIMIT_SALT is ever unset in production, this whole surface stops rather
// than degrades.

import {createClient} from 'npm:@supabase/supabase-js@2'
import {requireIntelAccess} from '../_shared/intel/research-service.ts'
import {orgAuthzErrorResponse} from '../_shared/org-authz.ts'
import {readBoundedJson,RequestBodyError} from '../_shared/intel/bounded-request.ts'
import {AgentAuthError,authenticateAgentToken,isAgentTokenRequest} from '../_shared/intel/agent-token.ts'
import {agentManagementService,agentReadService,AGENT_OPERATIONS,MANAGEMENT_OPERATIONS} from '../_shared/intel/agent-service.ts'
import {hashedEntityKey,hashedIpKey} from '../_shared/rate-limit.ts'

const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS'}
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,'Content-Type':'application/json','Cache-Control':'private, no-store'}})

// Per minute. Reads are generous because an agent reasoning about a book makes
// several; writes are not, because each one costs a person an approval.
const LIMITS:Record<string,number>={read:120,propose:20,write:20,management:30}

function bucketFor(operation:string):string {
 if(operation==='execute_write')return 'write'
 if(operation==='propose_write')return 'propose'
 return 'read'
}

async function enforceLimit(db:any,prefix:string,entityId:string,bucket:string):Promise<void> {
 let key:string
 try{
  key=await hashedEntityKey(prefix,entityId,bucket)
 }catch{
  // No salt, no limiter, no service. See the note at the top of this file.
  throw new AgentAuthError(503,'limiter_unavailable','Rate limiting is not configured, so this surface is closed. Set RATE_LIMIT_SALT.')
 }
 const {data,error}=await db.rpc('rate_limit_check_and_increment',{p_key:key,p_limit:LIMITS[bucket]??20,p_window_seconds:60})
 if(error)throw new AgentAuthError(503,'limiter_unavailable','Rate limiting is unavailable, so nothing ran. Retry when the service is ready.')
 const row=Array.isArray(data)?data[0]:data
 if(!row?.allowed)throw new AgentAuthError(429,'rate_limited',`Too many ${bucket} calls in one minute. Retry in ${row?.retry_after??60} seconds.`)
}

export async function handleAgentApi(req:Request):Promise<Response> {
 if(req.method==='OPTIONS')return new Response('ok',{headers:cors})
 if(req.method!=='POST')return json({error:'method_not_allowed'},405)
 try{
  const body=await readBoundedJson(req,300000)
  const operation=String(body.operation||'')
  const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const requestId=crypto.randomUUID()

  if(isAgentTokenRequest(req)){
   // The split that makes scopes mean something. A token that could reach
   // token_create could grant itself every scope there is.
   if((MANAGEMENT_OPERATIONS as readonly string[]).includes(operation)){
    throw new AgentAuthError(403,'agent_token_forbidden','An agent token cannot create, list or revoke tokens, and cannot approve its own writes. Sign in to Investor Intel to do that.')
   }
   if(!(AGENT_OPERATIONS as readonly string[]).includes(operation)){
    throw new AgentAuthError(400,'invalid_operation','That is not an operation this surface offers.')
   }
   let ipHash:string|undefined
   try{ipHash=(await hashedIpKey(req,'agent')).slice(0,64)}catch{ipHash=undefined}
   const context=await authenticateAgentToken(db,req,{requestId,ipHash})
   await enforceLimit(db,'intel_agent',context.tokenId,bucketFor(operation))
   return json(await agentReadService(db,context,body))
  }

  // The member's own session. Reads and writes are not offered here: they are
  // what a token is for, and answering them from a session would quietly create
  // a second, unscoped path to the same data.
  if(!(MANAGEMENT_OPERATIONS as readonly string[]).includes(operation)){
   throw new AgentAuthError(403,'session_forbidden','This operation is for an agent token. A signed-in member manages tokens and approves writes here.')
  }
  const actor=await requireIntelAccess(req,createClient,db,typeof body.orgId==='string'?body.orgId:null)
  if(!actor.userId||!actor.orgId)return json({error:'signed_in_investor_required'},403)
  await enforceLimit(db,'user',actor.userId,'management')
  return json(await agentManagementService(db,{orgId:actor.orgId,userId:actor.userId},body))
 }catch(error){
  if(error instanceof RequestBodyError)return json({error:error.message},error.status)
  if(error instanceof AgentAuthError)return json({error:error.code,message:error.message},error.status)
  const authz=orgAuthzErrorResponse(error,cors)
  if(authz)return authz
  // A failure is a named reason, never an empty success.
  const message=error instanceof Error?error.message:'agent_api_unavailable'
  if(/^(invalid_|chart_|thesis_|duplicate_|drawing_)/.test(message))return json({error:message},400)
  console.error('[intel-agent-api]',message)
  return json({error:'agent_api_unavailable',message:'Investor Intel is unavailable for agents right now. Retry when the service is ready.'},503)
 }
}

if(import.meta.main)Deno.serve(handleAgentApi)
