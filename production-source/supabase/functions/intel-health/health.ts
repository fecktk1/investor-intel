/** Investor Intel health: proves the capture pipeline is alive without spending a
 * provider credit and without showing anything a provider sells.
 *
 * WHAT IT READS. With the service role, and only these columns:
 *   - the newest timestamp of each scheduled capture lane's own table (one
 *     indexed `order by <column> desc limit 1` per lane, the same freshness
 *     column the lane's guard reads before it spends),
 *   - provider_schedule_policy provider, feature, cadence_seconds, enabled,
 *   - the verified_at clock of the coinmarketcap `cmc_account` sentinel row and
 *     the `at` clock of the newest `cmc_account_observation` entry.
 *
 * WHAT IT NEVER READS OR RETURNS. No row contents, no provider payload, no
 * credit balance, limit, usage or reservation, no plan, no reset date, no key or
 * fingerprint, no error text. It makes no provider call and holds no key.
 *
 * Everything that decides the answer is `deriveHealth`, a pure function, so the
 * thresholds are pinned by tests rather than by reading the handler. */

export type LaneState = 'ok' | 'late' | 'stale' | 'never' | 'paused' | 'unknown'
export type OverallStatus = 'ok' | 'degraded' | 'down'

export interface LaneSpec {
  lane: string
  table: string
  /** The column the lane's guard reads. `granularity: 'day'` columns are dates. */
  column: string
  granularity?: 'instant' | 'day'
  policyProvider: string
  policyFeature: string
  /** How often pg_cron actually invokes the lane. A lane can never be fresher
   * than its schedule, whatever its policy cadence says. */
  scheduleSeconds: number
  /** false for a lane that is scheduled but not expected to produce rows today
   * (reported, but it cannot degrade the overall status). */
  required: boolean
  /** Extra PostgREST filter, appended verbatim to the lane read, for a table
   * that more than one lane writes. `intel_meme_stage_snapshots` is written by
   * both the CoinMarketCap `meme_stages` lane and the CoinGecko
   * `launchpad_stages` lane, so without a filter each lane would be reported as
   * fresh whenever the OTHER one wrote — which is precisely the failure this
   * route exists to catch. Filters select no row contents: they narrow which
   * row's freshness column is read, and the answer is still one timestamp. */
  filter?: string
}

const HOUR = 3600, DAY = 86400

/** The capture lanes pg_cron drives today (checked 2026-09-16). Lanes with no
 * cron job (network_stats, rwa_yield, rwa_issuer_*) and the candle and rank
 * backfills (finite by design, silent when done) are deliberately absent. */
export const HEALTH_LANES: LaneSpec[] = [
  { lane: 'regime', table: 'intel_regime_snapshots', column: 'captured_at', policyProvider: 'coinmarketcap', policyFeature: 'regime', scheduleSeconds: HOUR, required: true },
  { lane: 'index_constituents', table: 'intel_index_constituent_snapshots', column: 'captured_at', policyProvider: 'coinmarketcap', policyFeature: 'structure', scheduleSeconds: HOUR, required: true },
  { lane: 'rwa_universe', table: 'intel_rwa_universe_snapshots', column: 'captured_at', policyProvider: 'coinmarketcap', policyFeature: 'rwa', scheduleSeconds: HOUR, required: true },
  { lane: 'attention', table: 'intel_attention_snapshots', column: 'captured_at', policyProvider: 'coinmarketcap', policyFeature: 'attention', scheduleSeconds: HOUR, required: true },
  { lane: 'liquidations', table: 'intel_liquidation_snapshots', column: 'captured_at', policyProvider: 'coinmarketcap', policyFeature: 'structure', scheduleSeconds: 300, required: true },
  { lane: 'categories', table: 'intel_category_snapshots', column: 'captured_at', policyProvider: 'coinmarketcap', policyFeature: 'categories', scheduleSeconds: HOUR, required: true },
  { lane: 'fx', table: 'intel_fx_rates', column: 'captured_at', policyProvider: 'coinmarketcap', policyFeature: 'fx', scheduleSeconds: HOUR, required: true },
  { lane: 'rank_daily', table: 'intel_rank_history', column: 'snapshot_date', granularity: 'day', policyProvider: 'coinmarketcap', policyFeature: 'history', scheduleSeconds: DAY, required: true },
  { lane: 'category_members', table: 'intel_category_members', column: 'snapshot_date', granularity: 'day', policyProvider: 'coinmarketcap', policyFeature: 'category_members', scheduleSeconds: DAY, required: true },
  { lane: 'exchange_reserves', table: 'intel_exchange_reserve_snapshots', column: 'snapshot_date', granularity: 'day', policyProvider: 'coinmarketcap', policyFeature: 'exchange_reserves', scheduleSeconds: DAY, required: true },
  { lane: 'venue_share', table: 'intel_venue_share_snapshots', column: 'snapshot_date', granularity: 'day', policyProvider: 'coinmarketcap', policyFeature: 'venue_share', scheduleSeconds: DAY, required: true },
  { lane: 'new_listings', table: 'intel_new_listing_snapshots', column: 'captured_at', policyProvider: 'coinmarketcap', policyFeature: 'listings', scheduleSeconds: DAY, required: true },
  { lane: 'airdrops', table: 'intel_airdrop_snapshots', column: 'last_seen_at', policyProvider: 'coinmarketcap', policyFeature: 'airdrops', scheduleSeconds: DAY, required: true },
  // RWA lanes, scheduled by 20260916202000_intel_rwa_capture_cron.sql. Yield runs
  // every six hours and writes a row per feed per run, so a gap is a real fault.
  { lane: 'rwa_yield', table: 'intel_rwa_yield_snapshots', column: 'captured_at', policyProvider: 'chainlink', policyFeature: 'rwa_yield', scheduleSeconds: 6 * HOUR, required: true },
  // The two issuer lanes act only on alias assertions in force. Between an
  // assertion lapsing and the next review they correctly write nothing, so they
  // are reported but never degrade the status.
  { lane: 'rwa_issuer_registry', table: 'intel_rwa_issuer_entities', column: 'fetched_at', policyProvider: 'primary-sources', policyFeature: 'rwa_issuer_registry', scheduleSeconds: DAY, required: false },
  { lane: 'rwa_token_concentration', table: 'intel_rwa_token_concentration', column: 'captured_at', policyProvider: 'primary-sources', policyFeature: 'rwa_token_concentration', scheduleSeconds: DAY, required: false },
  // Scheduled hourly but has never produced a row: the endpoint is not entitled
  // on the current account. Shown so a change is visible, never a degradation.
  // FILTERED by source, because the launchpad lane below writes the same table.
  { lane: 'meme_stages', table: 'intel_meme_stage_snapshots', column: 'captured_at', policyProvider: 'coinmarketcap', policyFeature: 'meme_stages', scheduleSeconds: HOUR, required: false, filter: 'source=eq.coinmarketcap' },
  // The CoinGecko launchpad lane, scheduled hourly at :41 by
  // 20260917184100_intel_launchpad_sources.sql. Reported but never required: it
  // is new, its key tier is not yet proven in production, and a source that has
  // not filled yet must not turn the whole route amber.
  { lane: 'launchpad_stages', table: 'intel_meme_stage_snapshots', column: 'captured_at', policyProvider: 'coingecko', policyFeature: 'launchpad_stages', scheduleSeconds: HOUR, required: false, filter: 'source=eq.coingecko' },
]

/** A capture that ran on time can still be up to one cadence old, plus cron
 * jitter and the job's own runtime. One missed run is `late`, not an outage. */
export const SLACK_SECONDS = 600
export const OK_FACTOR = 1.5
export const STALE_FACTOR = 3
/** cmc_account_sync_claim treats an account row as fresh for five minutes and the
 * five-minute liquidation lane keeps it syncing, so three windows is current. */
export const ACCOUNT_SYNC_CURRENT_SECONDS = 900

export interface PolicyRead { provider: string; feature: string; cadence_seconds?: number | null; enabled?: boolean | null }
export interface LaneRead { lane: string; ok: boolean; latestAt: string | null }
export interface AccountRead { ok: boolean; verifiedAt: string | null; observedAt: string | null }
export interface HealthInput {
  now: number
  lanes: LaneRead[]
  policy: { ok: boolean; rows: PolicyRead[] }
  account: AccountRead
  specs?: LaneSpec[]
}

export interface LaneHealth {
  lane: string; state: LaneState; required: boolean
  expectedCadenceSeconds: number; ageSeconds: number | null; latestAt: string | null
}
export interface HealthReport {
  status: OverallStatus
  checkedAt: string
  database: { reachable: boolean }
  lanes: LaneHealth[]
  counts: Record<LaneState, number>
  account: { syncCurrent: boolean; syncAgeSeconds: number | null; lastObservationAgeSeconds: number | null }
  reasons: string[]
}

const parseTime = (value: string | null | undefined): number | null => {
  if (value == null || value === '') return null
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : null
}
const ageOf = (now: number, at: number | null): number | null => at == null ? null : Math.max(0, Math.round((now - at) / 1000))

export function laneState(spec: LaneSpec, read: LaneRead | undefined, policy: PolicyRead | undefined, now: number): LaneHealth {
  const cadence = Number(policy?.cadence_seconds)
  const expected = Math.max(spec.scheduleSeconds, Number.isFinite(cadence) && cadence > 0 ? cadence : 0)
  const base = { lane: spec.lane, required: spec.required, expectedCadenceSeconds: expected }
  const at = parseTime(read?.latestAt)
  const latestAt = at == null ? null : new Date(at).toISOString()
  const ageSeconds = ageOf(now, at)
  if (policy && policy.enabled === false) return { ...base, state: 'paused', ageSeconds, latestAt }
  if (!read || !read.ok) return { ...base, state: 'unknown', ageSeconds: null, latestAt: null }
  if (ageSeconds == null) return { ...base, state: 'never', ageSeconds: null, latestAt: null }
  const state: LaneState = ageSeconds <= expected * OK_FACTOR + SLACK_SECONDS ? 'ok'
    : ageSeconds <= expected * STALE_FACTOR + SLACK_SECONDS ? 'late' : 'stale'
  return { ...base, state, ageSeconds, latestAt }
}

export function deriveHealth(input: HealthInput): HealthReport {
  const specs = input.specs ?? HEALTH_LANES
  const lanes = specs.map((spec) => laneState(
    spec,
    input.lanes.find((read) => read.lane === spec.lane),
    input.policy.ok ? input.policy.rows.find((row) => row.provider === spec.policyProvider && row.feature === spec.policyFeature) : undefined,
    input.now,
  ))
  const counts: Record<LaneState, number> = { ok: 0, late: 0, stale: 0, never: 0, paused: 0, unknown: 0 }
  for (const lane of lanes) counts[lane.state]++

  const syncAge = input.account.ok ? ageOf(input.now, parseTime(input.account.verifiedAt)) : null
  const observationAge = input.account.ok ? ageOf(input.now, parseTime(input.account.observedAt)) : null
  const syncCurrent = syncAge != null && syncAge <= ACCOUNT_SYNC_CURRENT_SECONDS

  // Reachability is a successful read, not a lucky timestamp: an empty table
  // that answered still proves the database is up.
  const reachable = input.policy.ok || input.account.ok || input.lanes.some((read) => read.ok)
  const reasons: string[] = []
  // Down has one cause; every unknown lane under it is a consequence, not news.
  if (!reachable) reasons.push('database_unreachable')
  else {
    for (const lane of lanes) if (lane.required && ['stale', 'never', 'unknown'].includes(lane.state)) reasons.push(`lane_${lane.state}:${lane.lane}`)
    if (!syncCurrent) reasons.push(input.account.ok ? 'account_sync_not_current' : 'account_sync_unknown')
  }

  return {
    status: !reachable ? 'down' : reasons.length ? 'degraded' : 'ok',
    checkedAt: new Date(input.now).toISOString(),
    database: { reachable },
    lanes, counts,
    account: { syncCurrent, syncAgeSeconds: syncAge, lastObservationAgeSeconds: observationAge },
    reasons,
  }
}

// ---------------------------------------------------------------------------
// Reads. Plain PostgREST GETs with the service role so the function has no
// dependency graph beyond this file; each read returns only what it selected.

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>
export interface HealthDeps { supabaseUrl: string; serviceKey: string; fetcher?: Fetcher; now?: () => number; timeoutMs?: number }

async function rest(deps: HealthDeps, path: string): Promise<unknown[] | null> {
  try {
    const response = await (deps.fetcher ?? fetch)(`${deps.supabaseUrl.replace(/\/+$/, '')}/rest/v1/${path}`, {
      method: 'GET',
      headers: { apikey: deps.serviceKey, Authorization: `Bearer ${deps.serviceKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(deps.timeoutMs ?? 4000),
    })
    if (!response.ok) { await response.body?.cancel(); return null }
    const body = await response.json()
    return Array.isArray(body) ? body : null
  } catch { return null }
}

export async function readLane(deps: HealthDeps, spec: LaneSpec): Promise<LaneRead> {
  const filter = spec.filter ? `&${spec.filter}` : ''
  const rows = await rest(deps, `${spec.table}?select=${spec.column}${filter}&order=${spec.column}.desc.nullslast&limit=1`)
  if (!rows) return { lane: spec.lane, ok: false, latestAt: null }
  const value = (rows[0] as Record<string, unknown> | undefined)?.[spec.column]
  return { lane: spec.lane, ok: true, latestAt: value == null ? null : String(value) }
}

export async function readPolicy(deps: HealthDeps): Promise<{ ok: boolean; rows: PolicyRead[] }> {
  const rows = await rest(deps, 'provider_schedule_policy?select=provider,feature,cadence_seconds,enabled&limit=200')
  return rows ? { ok: true, rows: rows as PolicyRead[] } : { ok: false, rows: [] }
}

export async function readAccount(deps: HealthDeps): Promise<AccountRead> {
  const scope = 'provider=eq.coinmarketcap&data_type=in.(cmc_account,cmc_account_observation)'
  // Only the two clocks are selected, by JSON path, so the credit figures stored
  // beside them never leave the database. If the negative array index is not
  // accepted, the observation row's own updated_at is the fallback clock.
  let rows = await rest(deps, `provider_quota_budgets?select=data_type,verified_at:config->>verified_at,observed_at:config->observations->-1->>at&${scope}`)
  let fallback = false
  if (!rows) { rows = await rest(deps, `provider_quota_budgets?select=data_type,verified_at:config->>verified_at,updated_at&${scope}`); fallback = true }
  if (!rows) return { ok: false, verifiedAt: null, observedAt: null }
  const typed = rows as Array<Record<string, unknown>>
  const account = typed.find((row) => row.data_type === 'cmc_account')
  const observation = typed.find((row) => row.data_type === 'cmc_account_observation')
  const text = (value: unknown) => value == null ? null : String(value)
  return { ok: true, verifiedAt: text(account?.verified_at), observedAt: text(fallback ? observation?.updated_at : observation?.observed_at) }
}

export async function collectHealth(deps: HealthDeps, specs: LaneSpec[] = HEALTH_LANES): Promise<HealthReport> {
  const [lanes, policy, account] = await Promise.all([
    Promise.all(specs.map((spec) => readLane(deps, spec))),
    readPolicy(deps),
    readAccount(deps),
  ])
  return deriveHealth({ now: (deps.now ?? Date.now)(), lanes, policy, account, specs })
}

// ---------------------------------------------------------------------------
// HTTP.

export const HEALTH_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Max-Age': '600',
}
export const HEALTH_CACHE_CONTROL = 'public, max-age=60'
/** A public route must not turn traffic into database load: one isolate answers
 * from its last report for this long, matching the advertised cache lifetime. */
export const MEMO_MS = 60_000

export function createHealthHandler(deps: HealthDeps | null) {
  let memo: { at: number; report: HealthReport } | null = null
  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: HEALTH_CORS })
    if (req.method !== 'GET') {
      return new Response(JSON.stringify({ error: 'method_not_allowed' }), { status: 405, headers: { ...HEALTH_CORS, Allow: 'GET, OPTIONS', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
    }
    const now = (deps?.now ?? Date.now)()
    let report: HealthReport
    if (!deps?.supabaseUrl || !deps?.serviceKey) {
      report = deriveHealth({ now, lanes: [], policy: { ok: false, rows: [] }, account: { ok: false, verifiedAt: null, observedAt: null } })
    } else if (memo && now - memo.at < MEMO_MS) {
      report = memo.report
    } else {
      report = await collectHealth(deps)
      memo = { at: now, report }
    }
    return new Response(JSON.stringify(report), {
      status: report.status === 'down' ? 503 : 200,
      headers: { ...HEALTH_CORS, 'Content-Type': 'application/json', 'Cache-Control': HEALTH_CACHE_CONTROL },
    })
  }
}
