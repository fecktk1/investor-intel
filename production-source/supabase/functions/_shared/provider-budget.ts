// Unified provider budget + telemetry helpers.
//
// Stage B foundation: callers keep their existing per-stack usage logs, while
// also best-effort writing a normalized provider_call_logs row and using the
// provider_budget_bump RPC for cross-cold-start monthly breakers.

// deno-lint-ignore no-explicit-any
const _glob = globalThis as any

function env(name: string): string | undefined {
  try {
    const v = _glob?.Deno?.env?.get?.(name)
    if (v != null) return v
  } catch { /* permission-gated */ }
  try {
    const pv = _glob?.process?.env?.[name]
    return pv != null ? String(pv) : undefined
  } catch { return undefined /* permission-gated */ }
}

export function resolveProviderEnvironment(): string {
  const raw = (env('APP_ENV') || env('SUPABASE_ENV') || env('RAILWAY_ENVIRONMENT') || env('ENVIRONMENT') || env('NODE_ENV') || '').toLowerCase().trim()
  if (!raw) return 'production'
  if (/(prod|production|live)/.test(raw)) return 'production'
  if (/(preview|deploy-preview|pr-)/.test(raw)) return 'preview'
  if (/(stag|test)/.test(raw)) return 'staging'
  if (/(dev|local)/.test(raw)) return 'development'
  return raw
}

export type ProviderCacheStatus =
  | 'hit'
  | 'db_hit'
  | 'miss'
  | 'negative_hit'
  | 'negative'
  | 'disabled'
  | 'budget_exceeded'
  | 'rate_capped'
  | 'banned'
  | 'suppressed'
  | 'live'
  | 'error'

export interface ProviderCallLogRow {
  provider: string
  dataType?: string | null
  endpoint?: string | null
  chain?: string | null
  subjectRef?: string | null
  cacheStatus?: ProviderCacheStatus | string | null
  calls?: number | null
  creditsOrCu?: number | null
  latencyMs?: number | null
  statusCode?: number | null
  suppressionReason?: string | null
  responseSizeBytes?: number | null
  caller?: string | null
  jobName?: string | null
  requestId?: string | null
  orgId?: string | null
  userId?: string | null
  environment?: string | null
  errorMessage?: string | null
  ts?: string | null
}

export function redactProviderEndpoint(endpoint: string | null | undefined): string | null {
  if (endpoint == null) return null
  return String(endpoint)
    .replace(/([?&](?:api[-_]?key|key|token|access_token|apikey)=)[^&\s"']+/gi, '$1[redacted]')
    .replace(/\/(?:sk|pk)_[A-Za-z0-9_-]+/gi, '/[key]')
    .replace(/\/(?:key|token)_[A-Za-z0-9_-]{16,}/gi, '/[key]')
    .replace(/\/v2\/[A-Za-z0-9_-]{16,}/g, '/v2/[key]')
    .replace(/\/v1\/[A-Za-z0-9_-]{16,}/g, '/v1/[key]')
    .replace(/https?:\/\/[^\s"']+/g, (u) => {
      try {
        const parsed = new URL(u)
        return `${parsed.origin}${parsed.pathname}`.replace(/\/[A-Za-z0-9_-]{24,}/g, '/[key]')
      } catch { return u.split('?')[0] }
    })
    .slice(0, 500)
}

function safeNumber(v: unknown, dflt = 0): number {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : dflt
}

export async function logProviderCall(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  row: ProviderCallLogRow,
): Promise<void> {
  try {
    if (!supabase) return
    await supabase.from('provider_call_logs').insert({
      provider: row.provider,
      data_type: row.dataType ?? 'unknown',
      endpoint: redactProviderEndpoint(row.endpoint) ?? 'unknown',
      chain: row.chain ?? null,
      subject_ref: row.subjectRef ? String(row.subjectRef).slice(0, 300) : null,
      cache_status: row.cacheStatus ?? null,
      calls: Math.max(0, Math.trunc(safeNumber(row.calls, 0))),
      credits_or_cu: row.creditsOrCu ?? null,
      latency_ms: row.latencyMs ?? null,
      status_code: row.statusCode ?? null,
      suppression_reason: row.suppressionReason ? redactProviderEndpoint(row.suppressionReason) : null,
      response_size_bytes: row.responseSizeBytes ?? null,
      caller: row.caller ?? row.jobName ?? null,
      job_name: row.jobName ?? null,
      request_id: row.requestId ?? null,
      org_id: row.orgId ?? null,
      user_id: row.userId ?? null,
      environment: row.environment ?? resolveProviderEnvironment(),
      error_message: row.errorMessage ? redactProviderEndpoint(row.errorMessage) : null,
      ts: row.ts ?? new Date().toISOString(),
    })
  } catch { /* table may be absent before migration 276; fail open */ }
}

export interface ProviderBudgetCheckInput {
  provider: string
  dataType?: string | null
  calls?: number
  creditsOrCu?: number
  softCap?: number | null
  hardCap?: number | null
  period?: 'month' | 'day'
  strict?: boolean
  now?: Date
}

export interface ProviderBudgetCheckResult {
  allowed: boolean
  failOpen?: boolean
  softExceeded?: boolean
  hardExceeded?: boolean
  callsUsed?: number | null
  creditsUsed?: number | null
  suppressionReason?: string | null
}

export function monthWindow(now = new Date()): { start: string; end: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0))
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0))
  return { start: start.toISOString(), end: end.toISOString() }
}

export function dayWindow(now = new Date()): { start: string; end: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0))
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0))
  return { start: start.toISOString(), end: end.toISOString() }
}

export async function checkProviderBudget(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  input: ProviderBudgetCheckInput,
): Promise<ProviderBudgetCheckResult> {
  try {
    if (!supabase) return { allowed: !input.strict, failOpen: !input.strict, suppressionReason: input.strict ? 'budget_check_unavailable' : undefined }
    const win = input.period === 'day'
      ? dayWindow(input.now ?? new Date())
      : monthWindow(input.now ?? new Date())
    const { data, error } = await supabase.rpc('provider_budget_bump', {
      p_provider: input.provider,
      p_data_type: input.dataType ?? '',
      p_period_start: win.start,
      p_period_end: win.end,
      p_calls: Math.max(0, Math.trunc(input.calls ?? 1)),
      p_credits: safeNumber(input.creditsOrCu, 0),
      p_soft_cap: input.softCap ?? null,
      p_hard_cap: input.hardCap ?? null,
    })
    if (error) return { allowed: !input.strict, failOpen: !input.strict, suppressionReason: input.strict ? 'budget_check_unavailable' : error.message }
    const payload = Array.isArray(data) ? data[0] : data
    if (input.strict && typeof payload?.allowed !== 'boolean') return { allowed: false, suppressionReason: 'budget_check_unavailable' }
    const allowed = payload?.allowed !== false
    return {
      allowed,
      softExceeded: payload?.soft_exceeded === true,
      hardExceeded: payload?.hard_exceeded === true || !allowed,
      callsUsed: payload?.calls_used ?? null,
      creditsUsed: payload?.credits_used ?? null,
      suppressionReason: allowed ? null : input.period === 'day' ? 'provider_daily_call_cap' : 'provider_monthly_call_cap',
    }
  } catch (err) {
    return { allowed: !input.strict, failOpen: !input.strict, suppressionReason: input.strict ? 'budget_check_unavailable' : (err as Error)?.message ?? 'budget_check_failed' }
  }
}

export const BIRDEYE_ENDPOINT_CU_COST: Record<string, number> = {
  '/defi/price': 3,
  '/defi/multi_price': 3,
  '/defi/token_overview': 25,
  '/defi/v3/token/meta-data/single': 5,
  '/defi/ohlcv': 35,
  '/defi/v3/ohlcv': 35,
  '/defi/v3/token/holder': 40,
  '/defi/token_security': 40,
  '/defi/v3/token/list': 75,
  '/defi/token_trending': 40,
  '/defi/token_new_listing': 30,
  '/defi/v2/tokens/top_traders': 30,
  '/v1/wallet/token_list': 60,
}

export function estimateBirdeyeCu(endpoint: string | null | undefined, tokenCount?: number | null): number {
  const ep = redactProviderEndpoint(endpoint)?.split('?')[0] ?? ''
  const base = BIRDEYE_ENDPOINT_CU_COST[ep] ?? 1
  if (ep === '/defi/multi_price') {
    const n = Math.max(1, Math.min(100, Math.trunc(tokenCount ?? 1)))
    return Math.ceil(Math.pow(n, 0.8) * base)
  }
  return base
}
