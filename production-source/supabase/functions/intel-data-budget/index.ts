// Investor Intel — the Data budget endpoint (super admin only).
//
// One read that answers "what is this account actually spending, on what, and
// at what cadence": the verified plan and when its profile expires, the CMC
// account facts, the month's credits against the governed ceiling and against
// the projection from the cadences currently in force, the per-feature schedule
// with its plan gate and reason, the cron jobs with their last run, seven days
// of cache reuse by endpoint, thirty days of asset demand, and the row counts of
// the ten capture tables.
//
// And one write: `{ op: 'apply' }` re-reads the effective plan, writes that
// plan's target cadences onto `provider_schedule_policy` (never over a manual
// override) and moves the pg_cron jobs to match. `dryRun: true` reports both
// diffs and changes nothing. This is the manual twin of the nightly
// `intel-schedule-policy-apply` job, for the hour when someone wants the flip to
// happen now rather than at 00:15 UTC.
//
// Nothing here calls CoinMarketCap. Every number is read from our own ledgers,
// so opening the panel never costs a credit.
//
// Auth: a signed-in super admin. There is deliberately no cron branch — the
// nightly apply runs in pg_cron, in SQL, with no Edge Function in the path.

import { createClient } from 'npm:@supabase/supabase-js@2'
import {
  applyPlanTargets, CMC_SCHEDULE_FEATURES, effectiveCadence, loadSchedulePolicy,
  monthlyBudgetEstimate, planTargets, PLAN_LEVELS, runCredits, schedulePolicyFromTargets,
  SCHEDULE_FEATURE_CREDIT_BUCKET, type SchedulePolicy,
} from '../_shared/intel/schedule-policy.ts'
import { calibrateCadence, calibratedCadenceSeconds, loadAccountObservations } from '../_shared/intel/budget-calibration.ts'
import { cmcPlan, cmcCreditCeiling, loadCmcOperatingSettings } from '../_shared/market-assets/cmc-transport.ts'
import { planAllows } from '../_shared/market-assets/cmc-capabilities.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

/** The ten capture tables and the column that dates the newest row in each. */
const CAPTURE_TABLES: Array<[table: string, newestColumn: string]> = [
  ['intel_regime_snapshots', 'captured_at'],
  ['intel_rank_history', 'snapshot_date'],
  ['intel_rwa_universe_snapshots', 'captured_at'],
  ['intel_index_constituent_snapshots', 'captured_at'],
  ['intel_liquidation_snapshots', 'captured_at'],
  ['intel_exchange_reserve_snapshots', 'snapshot_date'],
  ['intel_venue_share_snapshots', 'snapshot_date'],
  ['intel_attention_snapshots', 'captured_at'],
  ['intel_airdrop_snapshots', 'last_seen_at'],
  ['intel_network_stats_snapshots', 'captured_at'],
]

const DEFAULT_HACKATHON_EXPIRY = '2026-09-30T23:59:00Z'
const num = (v: unknown): number | null => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

interface Degradation { part: string; reason: string }

/** The month's credit row: the newest period, whatever the reset timestamp is. */
async function readCreditRow(admin: any, degraded: Degradation[]) {
  try {
    const { data, error } = await admin.from('provider_quota_budgets')
      .select('period_start, period_end, credits_used, credits_reserved, hard_cap, soft_cap, calls_used')
      .eq('provider', 'coinmarketcap').eq('data_type', 'cmc_credits')
      .order('period_start', { ascending: false }).limit(1).maybeSingle()
    if (error) { degraded.push({ part: 'month', reason: 'credits_unavailable' }); return null }
    return data ?? null
  } catch { degraded.push({ part: 'month', reason: 'credits_unavailable' }); return null }
}

/** Per-CMC-feature reservation spend for the same period. Several schedule
 * features share one bucket, so the panel is told which bucket each one is in
 * rather than being handed a number it would double-count. */
async function readFeatureCredits(admin: any, periodStart: string | null, degraded: Degradation[]) {
  const used = new Map<string, number>()
  if (!periodStart) return used
  try {
    const { data, error } = await admin.from('provider_quota_budgets')
      .select('data_type, credits_used, credits_reserved')
      .eq('provider', 'coinmarketcap').eq('period_start', periodStart)
      .like('data_type', 'cmc_feature_credit:%')
    if (error) { degraded.push({ part: 'features.usedThisMonth', reason: 'feature_credits_unavailable' }); return used }
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const bucket = String(row.data_type ?? '').slice('cmc_feature_credit:'.length)
      if (bucket) used.set(bucket, num(row.credits_used) ?? 0)
    }
  } catch { degraded.push({ part: 'features.usedThisMonth', reason: 'feature_credits_unavailable' }) }
  return used
}

async function readCaptureCounts(admin: any, degraded: Degradation[]) {
  const out: Array<Record<string, unknown>> = []
  for (const [table, newestColumn] of CAPTURE_TABLES) {
    let rows: number | null = null, newest: string | null = null
    try {
      const counted = await admin.from(table).select('*', { count: 'exact', head: true })
      if (counted.error) degraded.push({ part: `capture.${table}`, reason: 'count_unavailable' })
      else rows = num(counted.count)
    } catch { degraded.push({ part: `capture.${table}`, reason: 'count_unavailable' }) }
    try {
      const { data } = await admin.from(table).select(newestColumn)
        .order(newestColumn, { ascending: false, nullsFirst: false }).limit(1).maybeSingle()
      newest = (data as Record<string, unknown> | null)?.[newestColumn] as string ?? null
    } catch { /* the count already said what could be read */ }
    out.push({ table, rows, newest, newestColumn })
  }
  return out
}

/** Everything the Data budget panel renders. No provider call, no credit spent. */
export async function readDataBudget(admin: any, now: Date = new Date()): Promise<Record<string, unknown>> {
  const degraded: Degradation[] = []

  const settings = await loadCmcOperatingSettings(admin)
  const effective = cmcPlan(now.getTime(), settings)
  // cmcCreditCeiling is the number `cmc_request_reserve` actually enforces, and
  // it always resolves the plan at wall-clock time. Report it as the authority
  // and say which plan it was computed for, so a panel asked for a historical
  // `now` shows the mismatch rather than a ceiling that nothing enforces.
  const ceiling = cmcCreditCeiling(settings)
  const ceilingPlan = cmcPlan(Date.now(), settings)

  let account: Record<string, unknown> | null = null
  try {
    const { data, error } = await admin.from('provider_quota_budgets')
      .select('config, updated_at')
      .eq('provider', 'coinmarketcap').eq('data_type', 'cmc_account').maybeSingle()
    if (error) degraded.push({ part: 'account', reason: 'account_unavailable' })
    else {
      const config = (data?.config ?? {}) as Record<string, unknown>
      // The key fingerprint lives in the same row and is never returned.
      account = {
        creditLimit: num(config.credit_limit),
        rateLimit: num(config.rate_limit),
        resetAt: (config.reset_at as string) ?? null,
        verifiedAt: (config.verified_at as string) ?? null,
      }
    }
  } catch { degraded.push({ part: 'account', reason: 'account_unavailable' }) }

  const credits = await readCreditRow(admin, degraded)
  const periodStart = (credits?.period_start as string) ?? null
  const featureCredits = await readFeatureCredits(admin, periodStart, degraded)

  const policy = await loadSchedulePolicy(admin)
  if (policy.error) degraded.push({ part: 'features', reason: policy.error })

  const estimate = monthlyBudgetEstimate(policy, effective)
  const targets = planTargets(effective)

  // What the account is OBSERVED to be spending, from successive readings of
  // the provider's own credits_used, against what the remaining budget can
  // afford between now and the reset. This is a cadence multiplier and nothing
  // else: `cmc_request_reserve` is still the only thing that refuses a call,
  // and a multiplier of 1 means today's reviewed cadences stand. Reading it
  // touches one of our own rows and calls no provider.
  const observed = await loadAccountObservations(admin)
  if (observed.error) degraded.push({ part: 'calibration', reason: observed.error })
  const calibration = calibrateCadence({
    observations: observed.observations, ceiling, now: now.getTime(), error: observed.error,
    previousScale: observed.previousScale,
    // Burn measured before either expiry describes a different account, so the
    // 1 October step is a fresh measurement rather than a panic stretch.
    boundaries: [settings.CMC_SOURCE_POLICY_EXPIRES_AT ?? null, settings.CMC_HACKATHON_EXPIRES_AT ?? DEFAULT_HACKATHON_EXPIRY],
  })
  // Priced through the same estimator, so the calibrated number and the current
  // one are the same arithmetic over two cadence tables and can be compared.
  const calibratedEstimate = monthlyBudgetEstimate({
    ...policy,
    rows: new Map([...policy.rows].map(([feature, row]) =>
      [feature, { ...row, cadence_seconds: calibratedCadenceSeconds(row.cadence_seconds, calibration) ?? row.cadence_seconds }])),
  }, effective)

  const features = estimate.lines.map((line) => {
    const row = policy.rows.get(line.feature)
    const minPlan = row?.min_plan ?? null
    const known = minPlan == null || (PLAN_LEVELS as readonly string[]).includes(minPlan)
    const bucket = SCHEDULE_FEATURE_CREDIT_BUCKET[line.feature] ?? null
    return {
      feature: line.feature,
      cadenceSeconds: line.cadenceSeconds,
      enabled: line.enabled,
      minPlan,
      allowedOnPlan: minPlan == null ? true : known && planAllows(effective, minPlan as never),
      reason: line.reason,
      usedThisMonth: bucket ? featureCredits.get(bucket) ?? 0 : 0,
      creditBucket: bucket,
      creditsPerRun: line.creditsPerRun,
      runsPerMonth: line.runsPerMonth,
      projectedCredits: line.credits,
      targetCadenceSeconds: (targets as Record<string, { cadenceSeconds: number }>)[line.feature]?.cadenceSeconds ?? null,
      managedReason: row?.reason ?? null,
      updatedAt: row?.updated_at ?? null,
    }
  })

  let jobs: unknown[] = [], cacheReuse: unknown[] = [], demandDaily: unknown[] = []
  try {
    const { data, error } = await admin.rpc('intel_data_budget_snapshot', {
      p_call_days: 7, p_demand_days: 30, p_top: 15, p_provider: 'coinmarketcap',
    })
    if (error) degraded.push({ part: 'snapshot', reason: 'snapshot_unavailable' })
    else {
      const snapshot = (data ?? {}) as Record<string, unknown>
      jobs = Array.isArray(snapshot.jobs) ? snapshot.jobs : []
      cacheReuse = Array.isArray(snapshot.cacheReuse) ? snapshot.cacheReuse : []
      demandDaily = Array.isArray(snapshot.demandDaily) ? snapshot.demandDaily : []
    }
  } catch { degraded.push({ part: 'snapshot', reason: 'snapshot_unavailable' }) }

  const capture = await readCaptureCounts(admin, degraded)

  return {
    ok: true,
    generatedAt: now.toISOString(),
    plan: {
      effective,
      profile: settings.CMC_ACCESS_PROFILE ?? null,
      expiresAt: settings.CMC_HACKATHON_EXPIRES_AT ?? DEFAULT_HACKATHON_EXPIRY,
      baseline: settings.CMC_VERIFIED_BASELINE_PLAN ?? 'basic',
      hackathon: settings.CMC_VERIFIED_HACKATHON_PLAN ?? null,
      expired: Date.parse(settings.CMC_HACKATHON_EXPIRES_AT ?? DEFAULT_HACKATHON_EXPIRY) <= now.getTime(),
    },
    account,
    month: {
      used: num(credits?.credits_used) ?? 0,
      reserved: num(credits?.credits_reserved) ?? 0,
      ceiling,
      ceilingPlan,
      hardCap: num(credits?.hard_cap),
      projectedAtCurrentCadence: estimate.totalCredits,
      projectedAtCalibratedCadence: calibratedEstimate.totalCredits,
      periodStart,
      periodEnd: (credits?.period_end as string) ?? null,
      monthSeconds: estimate.monthSeconds,
    },
    // What the same cadence tables would cost on each plan, so the panel can
    // show the 1 October number before 1 October.
    projection: {
      startup: monthlyBudgetEstimate(schedulePolicyFromTargets('startup'), 'startup').totalCredits,
      basic: monthlyBudgetEstimate(schedulePolicyFromTargets('basic'), 'basic').totalCredits,
    },
    calibration,
    features,
    jobs,
    cacheReuse,
    demandDaily,
    capture,
    degraded,
  }
}

/** Write the effective plan's cadences, then move the cron jobs. Both halves
 * report a diff; a dry run performs neither write. */
export async function applyDataBudget(admin: any, options: { dryRun?: boolean; now?: Date } = {}) {
  const dryRun = options.dryRun === true
  const now = options.now ?? new Date()
  const settings = await loadCmcOperatingSettings(admin)
  const plan = cmcPlan(now.getTime(), settings)

  const policyDiff = await applyPlanTargets(admin, plan, { dryRun })

  let cronDiff: unknown = null, cronError: string | null = null
  try {
    const { data, error } = await admin.rpc('intel_apply_schedule_cadences', { p_dry_run: dryRun })
    if (error) cronError = String(error.message ?? 'cron_apply_failed').slice(0, 200)
    else cronDiff = data ?? null
  } catch (e) {
    cronError = String((e as Error)?.message ?? 'cron_apply_failed').slice(0, 200)
  }

  return { ok: cronError == null && policyDiff.error == null, plan, dryRun, appliedAt: now.toISOString(), policy: policyDiff, cron: cronDiff, cronError }
}

export async function handleDataBudgetRequest(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  const startedAt = Date.now()
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'unauthorized' }, 401)
    const u = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
    const { data: { user } } = await u.auth.getUser()
    const { data: prof } = user ? await u.from('profiles').select('is_super_admin').eq('id', user.id).maybeSingle() : { data: null }
    if (!prof?.is_super_admin) return json({ error: 'forbidden' }, 403)

    const admin = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const op = String(body.op ?? 'read')

    if (op === 'read') return json({ ...await readDataBudget(admin), durationMs: Date.now() - startedAt })
    if (op === 'apply') {
      // Default to a dry run: a bare { op: 'apply' } must not move production
      // cadences because a field was left out.
      const dryRun = body.dryRun !== false
      const result = await applyDataBudget(admin, { dryRun })
      return json({ ...result, durationMs: Date.now() - startedAt }, result.ok ? 200 : 500)
    }
    return json({ error: 'invalid_op', allowed: ['read', 'apply'] }, 400)
  } catch (e) {
    return json({ error: (e as Error)?.message || 'intel_data_budget_failed', durationMs: Date.now() - startedAt }, 500)
  }
}

if (import.meta.main) Deno.serve(handleDataBudgetRequest)

export { CAPTURE_TABLES, CMC_SCHEDULE_FEATURES, effectiveCadence, runCredits }
export type { SchedulePolicy }
