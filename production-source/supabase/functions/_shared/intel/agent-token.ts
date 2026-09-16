// Inbound agent tokens: the credential a member hands to software they chose.
//
// The shape follows the extension's device tokens deliberately. Only a SHA-256
// hash is stored, the organization is pinned on the row rather than resolved per
// request, and — the part that matters most — a valid token is re-checked
// against live membership and can_access_intel on EVERY request, exactly as
// requireExtensionDevice does. A token proves who issued it, never that they are
// still entitled to what it asks for.
//
// Scopes are read off the row, not decoded from the token. Narrowing a token's
// scopes takes effect on the very next request rather than at the next expiry.

export const AGENT_TOKEN_PREFIX='tcfagt_'
// A plaintext token is the prefix plus 43 base64url characters of 256-bit
// randomness. The pattern is checked before any database work so a malformed
// bearer costs one regex rather than a query.
export const AGENT_TOKEN_PATTERN=/^tcfagt_[A-Za-z0-9_-]{40,}$/

export const READ_SCOPES=['read:portfolio','read:thesis','read:alerts','read:charts','read:watchlists','read:evidence'] as const
export const WRITE_SCOPES=['write:alerts','write:charts','write:thesis'] as const
export const AGENT_SCOPES=[...READ_SCOPES,...WRITE_SCOPES] as const
export type AgentScope=typeof AGENT_SCOPES[number]

// A write scope is meaningless without the matching read scope, because a write
// is only finished once it has been verified by re-reading the row it claims to
// have written.
export const READ_SCOPE_FOR_WRITE:Record<string,AgentScope>={'write:alerts':'read:alerts','write:charts':'read:charts','write:thesis':'read:thesis'}
// The three guarded writes, and the scope each one costs.
export const WRITE_TOOLS={intel_create_alert:'write:alerts',intel_annotate_chart:'write:charts',intel_append_thesis_evidence:'write:thesis'} as const
export type AgentWriteTool=keyof typeof WRITE_TOOLS
// Which read scope each read family costs.
export const READ_FAMILIES={portfolio:'read:portfolio',thesis:'read:thesis',alerts:'read:alerts',charts:'read:charts',watchlists:'read:watchlists',evidence:'read:evidence'} as const
export type AgentReadFamily=keyof typeof READ_FAMILIES

/** A named refusal with an HTTP status. Never an empty success, never a bare false. */
export class AgentAuthError extends Error {
 constructor(public readonly status:number,public readonly code:string,message?:string){super(message||code);this.name='AgentAuthError'}
}

export async function sha256Hex(value:string):Promise<string> {
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))
 return Array.from(new Uint8Array(digest)).map(byte=>byte.toString(16).padStart(2,'0')).join('')
}

/** The plaintext exists here and in the one response that returns it. Nowhere else. */
export async function mintAgentToken():Promise<{plaintext:string;hash:string;hint:string}> {
 const bytes=crypto.getRandomValues(new Uint8Array(32))
 let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte)
 const plaintext=`${AGENT_TOKEN_PREFIX}${btoa(binary).replaceAll('+','-').replaceAll('/','_').replace(/=+$/g,'')}`
 return {plaintext,hash:await sha256Hex(plaintext),hint:plaintext.slice(-6)}
}

/** True when the Authorization bearer is an agent token rather than a user session JWT.
 *
 * This is the fork that keeps the two surfaces apart. An agent token can never
 * reach the management operations that mint or widen a token, and a session can
 * never reach the agent operations. Both are checked from the same header, so
 * the distinction has to be made once, here, and honoured everywhere. */
export function bearerToken(req:Request):string|null {
 const auth=req.headers.get('Authorization')||req.headers.get('authorization')||''
 return auth.startsWith('Bearer ')?auth.slice(7):null
}
export function isAgentTokenRequest(req:Request):boolean {
 return (bearerToken(req)||'').startsWith(AGENT_TOKEN_PREFIX)
}

export function validScopes(value:unknown):AgentScope[] {
 if(!Array.isArray(value)||!value.length||value.length>AGENT_SCOPES.length)throw new AgentAuthError(400,'invalid_scopes','Choose at least one scope.')
 const scopes=[...new Set(value)]
 if(scopes.length!==value.length)throw new AgentAuthError(400,'invalid_scopes','A scope was listed twice.')
 for(const scope of scopes){
  if(typeof scope!=='string'||!(AGENT_SCOPES as readonly string[]).includes(scope))throw new AgentAuthError(400,'invalid_scopes',`${String(scope)} is not a scope this system knows.`)
 }
 for(const [write,read] of Object.entries(READ_SCOPE_FOR_WRITE)){
  if(scopes.includes(write)&&!scopes.includes(read))throw new AgentAuthError(400,'invalid_scopes',`${write} also needs ${read}, because a write is only finished once it has been read back.`)
 }
 return scopes as AgentScope[]
}

export interface AgentActor {
 human_user_id:string
 org_id:string
 role:string
 token_id:string
 source:'agent_token'
 request_id:string
}

export interface AgentContext {
 tokenId:string
 userId:string
 /** The org PINNED on the token. Never resolved from the request or from
  * get_my_org_id(), which has no ORDER BY and so is arbitrary for a member of
  * more than one organization. */
 orgId:string
 tokenName:string
 scopes:AgentScope[]
 role:string
 actor:AgentActor
}

/**
 * Verify a bearer token and bind the request to its pinned organization.
 *
 * Order is deliberate: cheap format rejection, then the token row, then the
 * things that can have changed since the token was minted. Revocation and
 * expiry come before entitlement so a revoked token never causes an entitlement
 * lookup, and every refusal is a distinct code so an operator can tell "your
 * token is gone" from "your subscription lapsed".
 */
export async function authenticateAgentToken(db:any,req:Request,options:{requestId?:string;ipHash?:string;now?:number}={}):Promise<AgentContext> {
 const token=bearerToken(req)
 if(!token||!AGENT_TOKEN_PATTERN.test(token))throw new AgentAuthError(401,'token_invalid','That is not an agent token.')
 const now=options.now??Date.now()
 const hash=await sha256Hex(token)

 const {data:row,error}=await db.from('intel_agent_tokens')
  .select('id,user_id,org_id,name,scopes,expires_at,revoked_at,revoked_reason')
  .eq('token_hash',hash).maybeSingle()
 // A lookup failure is not the same as a bad token, and must not be reported as one.
 if(error)throw new AgentAuthError(503,'token_store_unavailable','Token verification is unavailable. Retry when the service is ready.')
 if(!row)throw new AgentAuthError(401,'token_invalid','That token is not recognized.')
 if(row.revoked_at)throw new AgentAuthError(401,'token_revoked',row.revoked_reason?`That token was revoked: ${row.revoked_reason}`:'That token was revoked.')
 if(Date.parse(row.expires_at)<=now)throw new AgentAuthError(401,'token_expired','That token expired. Create a new one.')

 // Live membership and live entitlement. The token is evidence of neither.
 const [member,access]=await Promise.all([
  db.from('org_members').select('role').eq('org_id',row.org_id).eq('user_id',row.user_id).maybeSingle(),
  db.rpc('can_access_intel',{p_user:row.user_id,p_org:row.org_id}),
 ])
 if(member.error||access.error)throw new AgentAuthError(503,'access_check_unavailable','Access verification is unavailable. Retry when the service is ready.')
 if(!member.data)throw new AgentAuthError(403,'membership_revoked','The member who created this token is no longer in this workspace.')
 if(access.data!==true)throw new AgentAuthError(403,'entitlement_lost','Investor Intel access is not active for this workspace.')

 const scopes=(Array.isArray(row.scopes)?row.scopes:[]).filter((s:string)=>(AGENT_SCOPES as readonly string[]).includes(s)) as AgentScope[]
 // Last-seen is a convenience for the member's token list, never a gate. A
 // failure to record it must not fail the request that was otherwise allowed.
 try{await db.from('intel_agent_tokens').update({last_used_at:new Date(now).toISOString(),...(options.ipHash?{last_ip_hash:options.ipHash}:{})}).eq('id',row.id)}catch{/* best effort */}

 return {
  tokenId:row.id,userId:row.user_id,orgId:row.org_id,tokenName:row.name,scopes,role:String(member.data.role||'member'),
  actor:{human_user_id:row.user_id,org_id:row.org_id,role:String(member.data.role||'member'),token_id:row.id,source:'agent_token',request_id:options.requestId||''},
 }
}

/** The scope check, as a refusal that says which scope was missing. */
export function requireScope(context:AgentContext,scope:AgentScope):void {
 if(!context.scopes.includes(scope)){
  throw new AgentAuthError(403,'scope_missing',`This token does not carry ${scope}. Create a token with that scope if you meant to allow it.`)
 }
}
