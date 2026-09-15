// Investor Intel — the plan-aware scheduler policy.
//
// `public.provider_schedule_policy` is the one place that says how often a
// provider feature may be pulled and which plan it needs. This module is the
// only reader/writer of that table outside SQL: it turns a row plus the
// currently effective CoinMarketCap plan into an effective cadence, carries the
// per-plan target cadence tables, applies those targets to the table, and
// projects a month of credits from the cadences that are actually in force.
//
// Why it exists: on 2026-09-30 23:59 UTC the hackathon Startup profile expires
// and `cmcPlan()` starts returning the baseline plan (Basic: 15,000 credits a
// month). Nothing else in the stack notices — the crons keep their Startup
// cadences and the account would burn its month in the first week. The nightly
// apply re-reads the profile, selects the plan's target cadences and writes
// them, so 1 October is a cadence change rather than an outage.
//
// Two rules the whole design rests on:
//   1. A manual override is never overwritten. A row whose `reason` does not
//      start with `auto:` (and is not null) belongs to an operator; the
//      scheduler reports it and leaves it alone.
//   2. A feature the plan does not entitle is skipped with a truthful reason
//      ("requires_plan:startup"), never attempted and never silently dropped.
//
// The target tables below are mirrored in
// `supabase/migrations/20260915004534_intel_schedule_policy_apply.sql`
// (`app_private.intel_apply_plan_targets`), which is what pg_cron runs nightly.
// Change one and you must change the other; both are pinned by their own tests.

import { planAllows } from '../market-assets/cmc-capabilities.ts'

export const SCHEDULE_PROVIDER = 'coinmarketcap'

/** A 30-day month, the same basis the CMC credit ceiling is quoted on. */
export const MONTH_SECONDS = 30 * 86_400

/** Rows the scheduler owns. Anything else in the table is reported, never priced. */
export const CMC_SCHEDULE_FEATURES = [
  'catalogue', 'quotes', 'regime', 'rwa', 'structure', 'attention', 'history',
  'metadata', 'exchange_reserves', 'venue_share', 'airdrops', 'network_stats', 'logo_verify',
] as const
export type ScheduleFeature = typeof CMC_SCHEDULE_FEATURES[number]

/** The plan ladder `planAllows` compares on. Used here only to reject an unknown
 * `min_plan`: `planAllows` would read an unknown minimum as index -1 and allow
 * everything, which is exactly the wrong way for a gate to fail. */
export const PLAN_LEVELS = ['basic', 'builder', 'startup', 'growth', 'professional', 'enterprise'] as const

/** Several schedule features spend from one CMC feature reservation bucket
 * (`cmc_feature_credit:<bucket>`), so a panel must not add their usage twice. */
export const SCHEDULE_FEATURE_CREDIT_BUCKET: Record<string, string | null> = {
  catalogue: 'market', quotes: 'market', regime: 'regime', rwa: 'rwa',
  structure: 'structure', attention: 'attention', history: 'history',
  metadata: 'metadata', exchange_reserves: 'structure', venue_share: 'structure',
  airdrops: 'attention', network_stats: 'regime', logo_verify: null,
}

export interface SchedulePolicyRow {
  provider: string
  feature: string
  cadence_seconds: number
  enabled: boolean
  min_plan: string | null
  reason: string | null
  updated_at?: string | null
}

export interface SchedulePolicy {
  rows: Map<string, SchedulePolicyRow>
  loadedAt: string
  /** Null when the table was read. A read failure is reported, never treated as "no policy". */
  error: string | null
}

export const AUTO_REASON_PREFIX = 'auto:'

/** A row the scheduler may rewrite: no reason at all, or one it wrote itself. */
export function isManagedReason(reason: string | null | undefined): boolean {
  if (reason == null) return true
  const trimmed = String(reason).trim()
  return trimmed === '' || trimmed.startsWith(AUTO_REASON_PREFIX)
}

export function autoReason(plan: string): string {
  return `${AUTO_REASON_PREFIX}${plan}`
}

const POLICY_COLUMNS = 'provider, feature, cadence_seconds, enabled, min_plan, reason, updated_at'

/** Read every schedule row for one provider. A read failure yields an empty map
 * with `error` set, so callers fall back to their own default rather than
 * mistaking an unreadable table for "everything is disabled". */
export async function loadSchedulePolicy(db: any, provider: string = SCHEDULE_PROVIDER): Promise<SchedulePolicy> {
  const loadedAt = new Date().toISOString()
  const rows = new Map<string, SchedulePolicyRow>()
  if (!db?.from) return { rows, loadedAt, error: 'db_unavailable' }
  try {
    const { data, error } = await db.from('provider_schedule_policy').select(POLICY_COLUMNS).eq('provider', provider)
    if (error) return { rows, loadedAt, error: 'policy_unavailable' }
    for (const raw of (data ?? []) as SchedulePolicyRow[]) {
      if (!raw || typeof raw.feature !== 'string' || raw.feature === '') continue
      const cadence = Number(raw.cadence_seconds)
      rows.set(raw.feature, {
        provider: raw.provider ?? provider,
        feature: raw.feature,
        cadence_seconds: Number.isFinite(cadence) && cadence > 0 ? cadence : 0,
        enabled: raw.enabled !== false,
        min_plan: raw.min_plan ?? null,
        reason: raw.reason ?? null,
        updated_at: raw.updated_at ?? null,
      })
    }
    return { rows, loadedAt, error: null }
  } catch {
    return { rows, loadedAt, error: 'policy_unavailable' }
  }
}

export interface EffectiveCadence {
  seconds: number
  enabled: boolean
  reason: string
}

/** The cadence a worker should actually use for one feature on one plan.
 *
 * Disabled when the row says `enabled = false`, or when the row's `min_plan` is
 * above `plan` (or is a plan name we do not know). An unknown feature falls back
 * to `fallbackSeconds` — that is what the argument is for — and says so; a
 * fallback that is not a positive number leaves the feature off. */
export function effectiveCadence(
  policy: SchedulePolicy | null | undefined,
  feature: string,
  plan: string,
  fallbackSeconds: number,
): EffectiveCadence {
  const fallback = Number(fallbackSeconds)
  const usableFallback = Number.isFinite(fallback) && fallback > 0 ? fallback : 0
  const row = policy?.rows?.get(feature)
  if (!row) {
    return usableFallback > 0
      ? { seconds: usableFallback, enabled: true, reason: 'policy_row_missing_fallback' }
      : { seconds: 0, enabled: false, reason: 'policy_row_missing' }
  }
  const seconds = row.cadence_seconds > 0 ? row.cadence_seconds : usableFallback
  if (seconds <= 0) return { seconds: 0, enabled: false, reason: 'cadence_unset' }
  if (!row.enabled) return { seconds, enabled: false, reason: row.reason?.trim() || 'feature_disabled' }
  if (row.min_plan) {
    const minimum = String(row.min_plan)
    if (!(PLAN_LEVELS as readonly string[]).includes(minimum)) {
      return { seconds, enabled: false, reason: `unknown_min_plan:${minimum}` }
    }
    if (!planAllows(plan, minimum as any)) return { seconds, enabled: false, reason: `requires_plan:${minimum}` }
  }
  return { seconds, enabled: true, reason: row.reason?.trim() || 'scheduled' }
}

export interface PlanTarget {
  cadenceSeconds: number
  enabled: boolean
  minPlan: string | null
  note: string
}

/** Startup: the seeded cadences, everything on. */
const STARTUP_TARGETS: Record<ScheduleFeature, PlanTarget> = {
  catalogue: { cadenceSeconds: 300, enabled: true, minPlan: 'basic', note: 'four listings pages every five minutes' },
  quotes: { cadenceSeconds: 300, enabled: true, minPlan: 'basic', note: 'quotes for the in-use set every five minutes' },
  regime: { cadenceSeconds: 3600, enabled: true, minPlan: 'basic', note: 'fear and greed, altcoin season, global metrics' },
  rwa: { cadenceSeconds: 3600, enabled: true, minPlan: 'basic', note: 'tokenised real-world asset universe, hourly' },
  structure: { cadenceSeconds: 300, enabled: true, minPlan: 'basic', note: 'liquidations every five minutes' },
  attention: { cadenceSeconds: 3600, enabled: true, minPlan: 'startup', note: 'trending, most visited, gainers and losers' },
  history: { cadenceSeconds: 86400, enabled: true, minPlan: 'startup', note: 'historical listings for rank history' },
  metadata: { cadenceSeconds: 86400, enabled: true, minPlan: 'basic', note: 'asset metadata, links and descriptions' },
  exchange_reserves: { cadenceSeconds: 86400, enabled: true, minPlan: 'basic', note: 'exchange asset reserves, daily' },
  venue_share: { cadenceSeconds: 604800, enabled: true, minPlan: 'basic', note: 'spot and derivatives venue share, weekly' },
  airdrops: { cadenceSeconds: 86400, enabled: true, minPlan: 'builder', note: 'airdrop list, daily' },
  network_stats: { cadenceSeconds: 3600, enabled: true, minPlan: 'growth', note: 'chain hashrate, difficulty and throughput' },
  logo_verify: { cadenceSeconds: 86400, enabled: true, minPlan: 'basic', note: 'logo mirroring, no provider credits' },
}

/** Basic: the 15,000-credit month. Startup-only work is switched off with a
 * reason instead of being attempted and failing at the provider. */
const BASIC_TARGETS: Record<ScheduleFeature, PlanTarget> = {
  catalogue: { cadenceSeconds: 3600, enabled: true, minPlan: 'basic', note: 'catalogue hourly' },
  quotes: { cadenceSeconds: 900, enabled: true, minPlan: 'basic', note: 'quotes for the in-use set every fifteen minutes' },
  regime: { cadenceSeconds: 3600, enabled: true, minPlan: 'basic', note: 'regime hourly' },
  rwa: { cadenceSeconds: 7200, enabled: true, minPlan: 'basic', note: 'RWA universe every two hours' },
  structure: { cadenceSeconds: 3600, enabled: true, minPlan: 'basic', note: 'liquidations hourly' },
  attention: { cadenceSeconds: 3600, enabled: false, minPlan: 'startup', note: 'trending and gainers are a Startup endpoint' },
  // Cadence stays daily so re-entitlement needs no cadence edit; `min_plan`
  // startup is what keeps the backfill beyond one year off on Basic.
  history: { cadenceSeconds: 86400, enabled: true, minPlan: 'startup', note: 'backfill beyond one year is Startup-only; min_plan gates it' },
  metadata: { cadenceSeconds: 86400, enabled: true, minPlan: 'basic', note: 'metadata daily' },
  exchange_reserves: { cadenceSeconds: 86400, enabled: true, minPlan: 'basic', note: 'exchange asset reserves, daily' },
  venue_share: { cadenceSeconds: 604800, enabled: true, minPlan: 'basic', note: 'spot and derivatives venue share, weekly' },
  airdrops: { cadenceSeconds: 86400, enabled: false, minPlan: 'builder', note: 'airdrops need the Builder plan' },
  network_stats: { cadenceSeconds: 3600, enabled: false, minPlan: 'growth', note: 'blockchain statistics need the Growth plan' },
  logo_verify: { cadenceSeconds: 86400, enabled: true, minPlan: 'basic', note: 'logo mirroring, no provider credits' },
}

/** The target cadence table for a plan. Startup and above get the Startup
 * table; Basic and Builder get the Basic table. */
export function planTargets(plan: string): Record<ScheduleFeature, PlanTarget> {
  const table = planAllows(plan, 'startup') ? STARTUP_TARGETS : BASIC_TARGETS
  // A fresh copy: callers must not be able to edit the shared table.
  const out = {} as Record<ScheduleFeature, PlanTarget>
  for (const feature of CMC_SCHEDULE_FEATURES) out[feature] = { ...table[feature] }
  return out
}

/** Credits one run of a feature costs. Fixed by the CMC capability registry:
 * a listings page is 1 credit per 250 rows, quotes 1 per 250 ids, the regime
 * capture is three endpoints, the RWA capture seven, liquidations one,
 * `listings/historical` 1 per 100 rows, `info` 1 per 250 ids. Logo mirroring
 * spends no provider credits at all. */
export function runCredits(feature: string, plan: string): number {
  switch (feature) {
    // Four listings pages on Startup (the top 1,000); one page on Basic, where
    // only the top 250 is refreshed.
    case 'catalogue': return planAllows(plan, 'startup') ? 4 : 1
    case 'quotes': return 1            // the in-use set is ~150 ids, one 250-id page
    case 'regime': return 3            // fear and greed + altcoin season + global metrics
    case 'rwa': return 7               // six asset types plus the whole universe
    case 'structure': return 1         // liquidations quotes
    case 'attention': return 3         // trending, most visited, gainers and losers
    case 'history': return 10          // listings/historical, 1,000 rows at 1 per 100
    case 'metadata': return 4          // info for 1,000 ids at 1 per 250
    case 'exchange_reserves': return 1
    case 'venue_share': return 1
    case 'airdrops': return 1
    case 'network_stats': return 1
    case 'logo_verify': return 0
    default: return 0
  }
}

export interface BudgetLine {
  feature: string
  cadenceSeconds: number
  enabled: boolean
  reason: string
  runsPerMonth: number
  creditsPerRun: number
  credits: number
  creditBucket: string | null
}

export interface BudgetEstimate {
  plan: string
  monthSeconds: number
  totalCredits: number
  lines: BudgetLine[]
}

/** Projected credits for a 30-day month at the cadences currently in force.
 * Features the plan does not entitle, or that are switched off, contribute
 * nothing and say why. A row in the table that this module does not price is
 * still listed, at zero, marked `unpriced_feature` — never silently dropped. */
export function monthlyBudgetEstimate(policy: SchedulePolicy | null | undefined, plan: string): BudgetEstimate {
  const targets = planTargets(plan)
  const lines: BudgetLine[] = []
  let totalCredits = 0

  const priced = new Set<string>(CMC_SCHEDULE_FEATURES)
  const features: string[] = [...CMC_SCHEDULE_FEATURES]
  for (const feature of policy?.rows?.keys() ?? []) if (!priced.has(feature)) features.push(feature)

  for (const feature of features) {
    const fallback = priced.has(feature) ? targets[feature as ScheduleFeature].cadenceSeconds : 0
    const cadence = effectiveCadence(policy, feature, plan, fallback)
    const creditsPerRun = priced.has(feature) ? runCredits(feature, plan) : 0
    const runsPerMonth = cadence.enabled && cadence.seconds > 0 ? Math.floor(MONTH_SECONDS / cadence.seconds) : 0
    const credits = runsPerMonth * creditsPerRun
    totalCredits += credits
    lines.push({
      feature,
      cadenceSeconds: cadence.seconds,
      enabled: cadence.enabled,
      reason: priced.has(feature) ? cadence.reason : 'unpriced_feature',
      runsPerMonth,
      creditsPerRun,
      credits,
      creditBucket: SCHEDULE_FEATURE_CREDIT_BUCKET[feature] ?? null,
    })
  }
  return { plan, monthSeconds: MONTH_SECONDS, totalCredits, lines }
}

/** A policy made of a plan's targets, so a projection can be shown for a plan
 * that is not the one currently in force (the "what 1 October costs" number). */
export function schedulePolicyFromTargets(plan: string, provider: string = SCHEDULE_PROVIDER): SchedulePolicy {
  const targets = planTargets(plan)
  const rows = new Map<string, SchedulePolicyRow>()
  for (const feature of CMC_SCHEDULE_FEATURES) {
    const target = targets[feature]
    rows.set(feature, {
      provider,
      feature,
      cadence_seconds: target.cadenceSeconds,
      enabled: target.enabled,
      min_plan: target.minPlan,
      reason: autoReason(plan),
      updated_at: null,
    })
  }
  return { rows, loadedAt: new Date().toISOString(), error: null }
}

export type PlanApplyAction = 'updated' | 'unchanged' | 'skipped_manual' | 'missing_row' | 'write_failed'

export interface PlanApplyEntry {
  feature: string
  action: PlanApplyAction
  from: { cadenceSeconds: number; enabled: boolean; reason: string | null } | null
  to: { cadenceSeconds: number; enabled: boolean; reason: string }
  minPlan: string | null
  note: string
}

export interface PlanApplyResult {
  plan: string
  dryRun: boolean
  appliedAt: string
  counts: Record<PlanApplyAction, number>
  entries: PlanApplyEntry[]
  error: string | null
}

/** Write a plan's target cadences onto `provider_schedule_policy`.
 *
 * Only managed rows are touched (`reason` null or starting with `auto:`); the
 * write repeats that guard as a filter so a manual edit landing between the read
 * and the write still wins. Rows the seed never created are reported, not
 * inserted: creating schedule rows belongs to the migration that owns them. */
export async function applyPlanTargets(
  db: any,
  plan: string,
  options: { dryRun?: boolean; provider?: string } = {},
): Promise<PlanApplyResult> {
  const dryRun = options.dryRun === true
  const provider = options.provider ?? SCHEDULE_PROVIDER
  const appliedAt = new Date().toISOString()
  const counts: Record<PlanApplyAction, number> = { updated: 0, unchanged: 0, skipped_manual: 0, missing_row: 0, write_failed: 0 }
  const entries: PlanApplyEntry[] = []

  const policy = await loadSchedulePolicy(db, provider)
  if (policy.error) {
    return { plan, dryRun, appliedAt, counts, entries, error: policy.error }
  }

  const targets = planTargets(plan)
  const reason = autoReason(plan)

  for (const feature of CMC_SCHEDULE_FEATURES) {
    const target = targets[feature]
    const to = { cadenceSeconds: target.cadenceSeconds, enabled: target.enabled, reason }
    const row = policy.rows.get(feature)
    if (!row) {
      counts.missing_row++
      entries.push({ feature, action: 'missing_row', from: null, to, minPlan: target.minPlan, note: 'no policy row; the seed migration owns creation' })
      continue
    }
    const from = { cadenceSeconds: row.cadence_seconds, enabled: row.enabled, reason: row.reason }
    if (!isManagedReason(row.reason)) {
      counts.skipped_manual++
      entries.push({ feature, action: 'skipped_manual', from, to, minPlan: target.minPlan, note: `manual override kept: ${row.reason}` })
      continue
    }
    const needsWrite = row.cadence_seconds !== target.cadenceSeconds || row.enabled !== target.enabled || row.reason !== reason
    if (!needsWrite) {
      counts.unchanged++
      entries.push({ feature, action: 'unchanged', from, to, minPlan: target.minPlan, note: target.note })
      continue
    }
    if (dryRun) {
      counts.updated++
      entries.push({ feature, action: 'updated', from, to, minPlan: target.minPlan, note: target.note })
      continue
    }
    let failure: string | null = null
    try {
      const { error } = await db.from('provider_schedule_policy')
        .update({ cadence_seconds: target.cadenceSeconds, enabled: target.enabled, reason, updated_at: appliedAt })
        .eq('provider', provider)
        .eq('feature', feature)
        // Re-check ownership at write time: a manual edit that landed after the
        // read must not be overwritten by a stale decision.
        .or(`reason.is.null,reason.like.${AUTO_REASON_PREFIX}*`)
      if (error) failure = String(error.message ?? 'update_failed').slice(0, 120)
    } catch (e) {
      failure = String((e as Error)?.message ?? 'update_failed').slice(0, 120)
    }
    if (failure) {
      counts.write_failed++
      entries.push({ feature, action: 'write_failed', from, to, minPlan: target.minPlan, note: failure })
    } else {
      counts.updated++
      entries.push({ feature, action: 'updated', from, to, minPlan: target.minPlan, note: target.note })
    }
  }

  return { plan, dryRun, appliedAt, counts, entries, error: null }
}
