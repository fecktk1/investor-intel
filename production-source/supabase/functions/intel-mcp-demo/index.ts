// Investor Intel public MCP demo: a read-only MCP server anyone can connect to
// with no account. Wiring only; the handler and its protections are in
// ./handler.ts, the tool allowlist and the guards in ./demo-tools.ts.
//
// The authenticated server is ../intel-mcp and is not touched by this function.

import {createClient} from 'npm:@supabase/supabase-js@2'
import {checkAndIncrement,hashedIpKey} from '../_shared/rate-limit.ts'
import {handleIntelMcpDemo,DEMO_LIMITS,type DemoHandlerDeps,type DailyVerdict} from './handler.ts'
import {installOutboundGuard,type OutboundGuard} from './demo-tools.ts'

function productionDeps(guard:OutboundGuard&{fetch:typeof fetch}):DemoHandlerDeps {
 const url=Deno.env.get('SUPABASE_URL')!
 // The client is given the guarded fetch explicitly, so even the database client
 // can reach nothing but its own REST path.
 const db=createClient(url,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{
  auth:{persistSession:false,autoRefreshToken:false},
  global:{fetch:guard.fetch},
 })
 return {
  db,
  ipKey:(req)=>hashedIpKey(req,'mcp-demo'),
  // Fail closed: a limiter that cannot be read stops the demo.
  limit:(key,limit,windowSeconds)=>checkAndIncrement(db,key,limit,windowSeconds,{failClosed:true}),
  async daily(caller):Promise<DailyVerdict>{
   const {data,error}=await db.rpc('intel_mcp_demo_take',{p_caller_key:caller,p_limit:DEMO_LIMITS.toolCallsPerDay,p_global_limit:DEMO_LIMITS.allToolCallsPerDay})
   if(error){
    console.error('[intel-mcp-demo] daily allowance unavailable:',error.message)
    return {allowed:false,reason:'limiter_unavailable',resetsAt:null}
   }
   const verdict=(data??{}) as {allowed?:unknown;reason_code?:unknown;resets_at?:unknown}
   return {
    allowed:verdict.allowed===true,
    reason:typeof verdict.reason_code==='string'?verdict.reason_code:null,
    resetsAt:typeof verdict.resets_at==='string'?verdict.resets_at:null,
   }
  },
  outboundRefused:()=>guard.refused(),
 }
}

if(import.meta.main){
 // Installed before anything else runs: from here on the only outbound request
 // this isolate can make is to the project's own PostgREST path.
 const guard=installOutboundGuard(`${new URL(Deno.env.get('SUPABASE_URL')!).origin}/rest/v1/`)
 let deps:DemoHandlerDeps|null=null
 Deno.serve((req)=>handleIntelMcpDemo(req,deps??=productionDeps(guard)))
}
