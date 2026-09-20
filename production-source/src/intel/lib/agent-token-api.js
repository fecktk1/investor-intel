// Agent access, from the member's own session.
//
// This is the management half of `intel-agent-api`. A session can mint, list and
// revoke tokens and approve a proposed write; it deliberately cannot read or
// write Intel data through this surface, because that is what a scoped token is
// for and a second unscoped path would make the scopes meaningless.

export const AGENT_READ_SCOPES = ['read:portfolio', 'read:thesis', 'read:alerts', 'read:charts', 'read:watchlists', 'read:evidence']
// write:watchlists and write:research are used by the hosted MCP server and are
// the only two writes that happen without an approval step, because they touch
// objects the approval pipeline never covered and a member undoes either in one
// click. Everything that can notify the member, or change a chart or a thesis,
// still goes through propose and approve.
export const AGENT_WRITE_SCOPES = ['write:alerts', 'write:charts', 'write:thesis', 'write:watchlists', 'write:research']
export const AGENT_SCOPES = [...AGENT_READ_SCOPES, ...AGENT_WRITE_SCOPES]
// A write scope is only offered together with the read scope it needs, because
// a write is not finished until it has been read back and verified. write:research
// pairs with read:evidence, which is already the scope that reads saved_research.
export const READ_SCOPE_FOR_WRITE = { 'write:alerts': 'read:alerts', 'write:charts': 'read:charts', 'write:thesis': 'read:thesis', 'write:watchlists': 'read:watchlists', 'write:research': 'read:evidence' }

/** The hosted MCP endpoint a member points their own agent at.
 *
 * Built from VITE_SUPABASE_URL because Edge Functions are NOT proxied through the
 * site: there is no /api rewrite in public/_redirects and no server.proxy in the
 * Vite config, so the canonical public form is the function URL itself. The token
 * is never part of it; it travels in the Authorization header. */
export function hostedMcpUrl(supabaseUrl = import.meta.env?.VITE_SUPABASE_URL) {
  const base = String(supabaseUrl || '').replace(/\/+$/, '')
  return base ? `${base}/functions/v1/intel-mcp` : ''
}

const messages = {
  token_limit: 'You already have ten live tokens. Revoke one you no longer use before creating another.',
  invalid_scopes: 'Choose at least one scope. A write scope also needs its matching read scope.',
  invalid_token_name: 'Give the token a name of at most 80 characters.',
  invalid_expiry: 'A token lasts between one and 365 days.',
  token_store_unavailable: 'Agent tokens are unavailable. Retry when the service is ready.',
  plan_not_found: 'That request is no longer available.',
  plan_expired: 'That request expired before it was approved. The agent can propose it again.',
  agent_approval_unavailable: 'The approval could not be recorded. Retry when the service is ready.',
  rate_limited: 'Too many changes in one minute. Wait a moment and try again.',
  limiter_unavailable: 'Agent access is closed because rate limiting is not configured.',
  signed_in_investor_required: 'Sign in to an Investor Intel workspace to manage agent access.',
}

export async function requestAgentApi(context, body) {
  if (!context?.supabase || !context.orgId) throw new Error('Sign in to manage agent access.')
  const { data, error } = await context.supabase.functions.invoke('intel-agent-api', { body: { ...body, orgId: context.orgId } })
  if (error) {
    const details = await error.context?.json?.().catch(() => null)
    if (details?.error && messages[details.error]) throw new Error(messages[details.error])
    // The server's own sentence is better than a generic one whenever it sent one.
    if (details?.message) throw new Error(details.message)
    throw new Error('Agent access is unavailable. Retry when the service is ready.')
  }
  if (data?.error) throw new Error(messages[data.error] || data.message || data.error)
  return data
}

export const listAgentTokens = (context) => requestAgentApi(context, { operation: 'token_list' })
/** The only call that ever returns a plaintext token, and it returns it once. */
export const createAgentToken = (context, { name, scopes, expiresInDays }) =>
  requestAgentApi(context, { operation: 'token_create', name, scopes, expiresInDays })
export const revokeAgentToken = (context, id, reason) =>
  requestAgentApi(context, { operation: 'token_revoke', id, reason })
export const listAgentPlans = (context, status = 'proposed') =>
  requestAgentApi(context, { operation: 'plan_list', status })
export const approveAgentPlan = (context, planId, note) =>
  requestAgentApi(context, { operation: 'plan_approve', planId, note })
export const rejectAgentPlan = (context, planId, reason) =>
  requestAgentApi(context, { operation: 'plan_reject', planId, reason })

/** live, revoked or expired, decided here so the list and the tests agree. */
export function tokenState(token, now = Date.now()) {
  if (token?.revoked_at) return 'revoked'
  if (token?.expires_at && Date.parse(token.expires_at) <= now) return 'expired'
  return 'live'
}
