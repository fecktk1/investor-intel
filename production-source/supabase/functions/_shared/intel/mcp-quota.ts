// Per-token budgets, and a row for every call.
//
// TWO LIMITERS, ON PURPOSE.
//
// The minute window reuses rate_limit_check_and_increment, which is the right
// tool for it: one advisory lock per key, a count over a short window, and an
// opportunistic sweep.
//
// The DAY window cannot use it. 093_rate_limit_log.sql sweeps `bucket_at < now()
// - interval '1 hour'` on roughly one call in two hundred, so a count over a
// 86400-second window silently loses every row older than an hour. A daily cap
// built on it would read as "23 calls today" forever and cap nothing. That is why
// this module carries its own dated counter (intel_mcp_daily_usage) with its own
// RPC, rather than passing 86400 to a limiter whose storage is swept hourly.
//
// FAIL CLOSED, both of them. This surface reads a member's book and can propose
// writes against it, so an unconfigured or unavailable limiter returns 503 rather
// than letting traffic through unmetered. intel-agent-api made the same call for
// the same reason and the cost is the same and worth naming: with RATE_LIMIT_SALT
// unset in production, this surface stops rather than degrades.
//
// THE AUDIT ROW IS NOT THE LIMITER. It is written after the tool has run, carries
// the outcome and the duration, and never holds arguments: a tool argument can be
// a contract address or a note a member typed, and neither belongs in a log that
// outlives the request. What is recorded is the tool name, whether it was served
// or refused, why, how long it took and how big the answer was.

import {hashedEntityKey} from '../rate-limit.ts'
import {AgentAuthError} from './agent-token.ts'

// deno-lint-ignore no-explicit-any
type Db=any

/** Per minute, per token. The protocol bucket is wide because a client may call
 * initialize, tools/list and ping on every conversation turn; the tool bucket is
 * the one that matters and is the brief's 60. */
export const MINUTE_LIMITS={protocol:240,tool:60} as const
export type QuotaBucket=keyof typeof MINUTE_LIMITS

/** The tier limit key. Absent from intel_plan_limits means "no ceiling", which is
 * how intel_limit_for already reports elite, so a missing row is a deliberate
 * unlimited rather than a default of zero. */
export const DAILY_LIMIT_KEY='agent_mcp_calls_per_day'
/** Used when the limit table cannot be read at all. Deliberately the brief's
 * number rather than unlimited: an unreadable limit must not be a wide one. */
export const DAILY_LIMIT_FALLBACK=2000

export interface DailyBudget {
 limit:number|null
 used:number
 remaining:number|null
 resets_at:string
 /** Present when the ceiling is the fallback rather than the tier's own row. */
 reason?:string
}

export async function enforceMinuteLimit(db:Db,tokenId:string,bucket:QuotaBucket):Promise<void> {
 let key:string
 try{
  key=await hashedEntityKey('intel_mcp',tokenId,bucket)
 }catch{
  throw new AgentAuthError(503,'limiter_unavailable','Rate limiting is not configured, so this surface is closed. Set RATE_LIMIT_SALT.')
 }
 const {data,error}=await db.rpc('rate_limit_check_and_increment',{p_key:key,p_limit:MINUTE_LIMITS[bucket],p_window_seconds:60})
 if(error)throw new AgentAuthError(503,'limiter_unavailable','Rate limiting is unavailable, so nothing ran. Retry when the service is ready.')
 const row=Array.isArray(data)?data[0]:data
 if(!row?.allowed){
  throw new AgentAuthError(429,'rate_limited',`This token has made ${MINUTE_LIMITS[bucket]} ${bucket==='tool'?'tool calls':'requests'} in the last minute, which is its ceiling. Retry in ${row?.retry_after??60} seconds.`)
 }
}

/** The tier's daily ceiling, or null for no ceiling. */
export async function dailyLimit(db:Db,orgId:string):Promise<{limit:number|null;reason?:string}> {
 const {data,error}=await db.rpc('intel_limit_for',{p_org:orgId,p_key:DAILY_LIMIT_KEY})
 if(error)return {limit:DAILY_LIMIT_FALLBACK,reason:'The plan limit could not be read, so the default daily ceiling is in force.'}
 if(data===null||data===undefined)return {limit:null}
 const limit=Number(data)
 if(!Number.isFinite(limit)||limit<0)return {limit:DAILY_LIMIT_FALLBACK,reason:'The plan limit was not a usable number, so the default daily ceiling is in force.'}
 return {limit:Math.floor(limit)}
}

/**
 * Take one call from today's allowance.
 *
 * The count is incremented BEFORE the tool runs, so a tool that throws still
 * costs its call. The alternative — charging only for successes — lets a loop of
 * failing calls run without limit, which is the shape of the abuse a daily cap is
 * for.
 */
export async function takeDailyCall(db:Db,tokenId:string,orgId:string):Promise<DailyBudget> {
 const {limit,reason}=await dailyLimit(db,orgId)
 const {data,error}=await db.rpc('intel_mcp_quota_take',{p_token_id:tokenId,p_limit:limit})
 if(error)throw new AgentAuthError(503,'quota_unavailable','The daily call budget could not be read, so nothing ran. Retry when the service is ready.')
 const verdict=data as {allowed?:boolean;used?:number;resets_at?:string}|null
 const used=Number(verdict?.used??0)
 const resets_at=String(verdict?.resets_at??new Date(Date.now()+86400000).toISOString())
 const budget:DailyBudget={limit,used,remaining:limit===null?null:Math.max(0,limit-used),resets_at,...(reason?{reason}:{})}
 if(verdict?.allowed!==true){
  throw new AgentAuthError(429,'daily_quota_reached',`This token has used all ${limit} of its calls for today. The allowance resets at ${resets_at}. A higher plan carries a larger allowance.`)
 }
 return budget
}

/** Read today's usage without spending a call. What credit_budget reports. */
export async function readDailyBudget(db:Db,tokenId:string,orgId:string):Promise<DailyBudget> {
 const {limit,reason}=await dailyLimit(db,orgId)
 const {data}=await db.from('intel_mcp_daily_usage').select('calls,usage_date')
  .eq('token_id',tokenId).eq('usage_date',new Date().toISOString().slice(0,10)).maybeSingle()
 const used=Number((data as {calls?:unknown}|null)?.calls??0)
 // Midnight UTC, which is the day boundary the counter's usage_date uses.
 const tomorrow=new Date();tomorrow.setUTCHours(0,0,0,0);tomorrow.setUTCDate(tomorrow.getUTCDate()+1)
 return {limit,used,remaining:limit===null?null:Math.max(0,limit-used),resets_at:tomorrow.toISOString(),...(reason?{reason}:{})}
}

export interface AuditRow {
 tokenId:string
 orgId:string
 userId:string
 tool:string
 outcome:'served'|'refused'|'failed'
 /** A short machine code on a refusal. Never a message a member typed. */
 reasonCode?:string|null
 durationMs:number
 resultBytes:number
 /** True when the refusal was the tier gate rather than a scope or a bound. */
 tierLocked?:boolean
}

/**
 * One row per call, written after the fact, never allowed to fail the request.
 *
 * NO ARGUMENTS ARE RECORDED. Not truncated, not hashed, not "just the keys": a
 * tool argument can be a wallet address, a note or a thesis title, and the
 * question this table answers ("what did this token do, how often, and was it
 * refused") never needs it. The propose/approve pipeline already stores the full
 * payload of anything that would change data, with its own hash and its own
 * approval trail, which is where an argument legitimately lives.
 */
export async function auditCall(db:Db,row:AuditRow):Promise<void> {
 try{
  const {error}=await db.from('intel_mcp_call_audit').insert({
   token_id:row.tokenId,org_id:row.orgId,user_id:row.userId,tool:row.tool.slice(0,80),
   outcome:row.outcome,reason_code:row.reasonCode?String(row.reasonCode).slice(0,60):null,
   duration_ms:Math.max(0,Math.round(row.durationMs)),result_bytes:Math.max(0,Math.round(row.resultBytes)),
   tier_locked:row.tierLocked===true,
  })
  if(error)console.error('[intel-mcp] audit not recorded:',error.message)
 }catch(error){
  console.error('[intel-mcp] audit not recorded:',error instanceof Error?error.message:'unknown')
 }
}
