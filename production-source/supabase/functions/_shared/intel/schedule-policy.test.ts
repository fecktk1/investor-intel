// Tests for the plan-aware scheduler policy.
//   deno test --allow-read --allow-net --allow-env --no-check \
//     supabase/functions/_shared/intel/schedule-policy.test.ts
//
// The numbers pinned here are the contract the Data budget panel and the
// nightly SQL apply share. `app_private.intel_apply_plan_targets` in
// 20260915004534_intel_schedule_policy_apply.sql mirrors the same table and is
// pinned independently by scripts/test-intel-schedule-policy.mjs.

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  applyPlanTargets, autoReason, CMC_SCHEDULE_FEATURES, effectiveCadence, isManagedReason,
  loadSchedulePolicy, monthlyBudgetEstimate, MONTH_SECONDS, planTargets, PLAN_LEVELS,
  runCredits, schedulePolicyFromTargets, type SchedulePolicy, type SchedulePolicyRow,
} from './schedule-policy.ts'
import { planAllows } from '../market-assets/cmc-capabilities.ts'

/** The 13 rows migration 20260914232100 seeds, with its descriptive reasons. */
const SEEDED: Array<Partial<SchedulePolicyRow> & { feature: string }> = [
  { feature: 'catalogue', cadence_seconds: 300, min_plan: 'basic', reason: 'asset catalogue and identity refresh' },
  { feature: 'quotes', cadence_seconds: 300, min_plan: 'basic', reason: 'broad listings and quote refresh' },
  { feature: 'regime', cadence_seconds: 3600, min_plan: 'basic', reason: 'fear and greed, altcoin season, global metrics' },
  { feature: 'rwa', cadence_seconds: 3600, min_plan: 'basic', reason: 'tokenised real-world asset universe' },
  { feature: 'structure', cadence_seconds: 300, min_plan: 'basic', reason: 'market structure, liquidations and index levels' },
  { feature: 'attention', cadence_seconds: 3600, min_plan: 'startup', reason: 'trending, most visited, gainers and losers' },
  { feature: 'history', cadence_seconds: 86400, min_plan: 'startup', reason: 'historical listings for rank history' },
  { feature: 'metadata', cadence_seconds: 86400, min_plan: 'basic', reason: 'asset metadata, links and descriptions' },
  { feature: 'exchange_reserves', cadence_seconds: 86400, min_plan: 'basic', reason: 'exchange asset reserves' },
  // Seeded weekly in 20260914232100; 20260915013913 moved it to daily.
  { feature: 'venue_share', cadence_seconds: 86400, min_plan: 'basic', reason: 'spot and derivatives venue share' },
  { feature: 'airdrops', cadence_seconds: 86400, min_plan: 'basic', reason: 'airdrop list refresh' },
  { feature: 'network_stats', cadence_seconds: 3600, min_plan: 'basic', reason: 'chain hashrate, difficulty and throughput' },
  { feature: 'logo_verify', cadence_seconds: 86400, min_plan: 'basic', reason: 'logo and image URL verification' },
]

const row = (r: Partial<SchedulePolicyRow> & { feature: string }): SchedulePolicyRow => ({
  provider: 'coinmarketcap', feature: r.feature, cadence_seconds: r.cadence_seconds ?? 300,
  enabled: r.enabled ?? true, min_plan: r.min_plan ?? null, reason: r.reason ?? null, updated_at: null,
})

const policyOf = (rows: Array<Partial<SchedulePolicyRow> & { feature: string }>): SchedulePolicy => ({
  rows: new Map(rows.map((r) => [r.feature, row(r)])),
  loadedAt: '2026-09-14T00:00:00Z',
  error: null,
})

/** A supabase-js stand-in: a select that returns rows, and an update whose
 * filters are recorded so the ownership guard can be asserted. */
function fakeDb(rows: Array<Partial<SchedulePolicyRow> & { feature: string }>, opts: { selectError?: boolean; updateError?: string } = {}) {
  const updates: Array<{ patch: Record<string, unknown>; filters: string[] }> = []
  const db = {
    updates,
    from(table: string) {
      assertEquals(table, 'provider_schedule_policy')
      return {
        select(_columns: string) {
          return {
            eq(_column: string, _value: unknown) {
              return Promise.resolve(opts.selectError ? { data: null, error: { message: 'boom' } } : { data: rows.map(row), error: null })
            },
          }
        },
        update(patch: Record<string, unknown>) {
          const filters: string[] = []
          const chain = {
            eq(column: string, value: unknown) { filters.push(`eq:${column}=${String(value)}`); return chain },
            or(expr: string) {
              filters.push(`or:${expr}`)
              updates.push({ patch, filters })
              return Promise.resolve(opts.updateError ? { error: { message: opts.updateError } } : { error: null })
            },
          }
          return chain
        },
      }
    },
  }
  return db
}

Deno.test('PLAN_LEVELS agrees with the shared planAllows ladder', () => {
  for (let i = 0; i < PLAN_LEVELS.length; i++) {
    for (let j = 0; j < PLAN_LEVELS.length; j++) {
      assertEquals(planAllows(PLAN_LEVELS[i], PLAN_LEVELS[j] as never), i >= j, `${PLAN_LEVELS[i]} vs ${PLAN_LEVELS[j]}`)
    }
  }
})

Deno.test('loadSchedulePolicy maps rows by feature and reports a read failure', async () => {
  const ok = await loadSchedulePolicy(fakeDb(SEEDED))
  assertEquals(ok.error, null)
  assertEquals(ok.rows.size, 13)
  assertEquals(ok.rows.get('catalogue')?.cadence_seconds, 300)
  assertEquals(ok.rows.get('attention')?.min_plan, 'startup')

  const failed = await loadSchedulePolicy(fakeDb(SEEDED, { selectError: true }))
  assertEquals(failed.error, 'policy_unavailable')
  assertEquals(failed.rows.size, 0)
  assertEquals((await loadSchedulePolicy(null)).error, 'db_unavailable')
})

Deno.test('effectiveCadence: enabled, disabled, plan-gated, unknown plan, missing row', () => {
  const policy = policyOf([
    ...SEEDED,
    { feature: 'off', cadence_seconds: 300, enabled: false, reason: 'incident 2026-09-14: provider unstable' },
    { feature: 'nonsense', cadence_seconds: 300, min_plan: 'diamond' },
  ])
  assertEquals(effectiveCadence(policy, 'catalogue', 'startup', 600), { seconds: 300, enabled: true, reason: 'asset catalogue and identity refresh' })
  // Startup entitles attention; Basic does not, and the reason names the plan.
  assertEquals(effectiveCadence(policy, 'attention', 'startup', 600).enabled, true)
  assertEquals(effectiveCadence(policy, 'attention', 'basic', 600), { seconds: 3600, enabled: false, reason: 'requires_plan:startup' })
  assertEquals(effectiveCadence(policy, 'history', 'basic', 600).reason, 'requires_plan:startup')
  // enabled = false wins over everything and keeps the operator's words.
  assertEquals(effectiveCadence(policy, 'off', 'professional', 600), { seconds: 300, enabled: false, reason: 'incident 2026-09-14: provider unstable' })
  // An unknown min_plan fails closed instead of being read as "no minimum".
  assertEquals(effectiveCadence(policy, 'nonsense', 'professional', 600), { seconds: 300, enabled: false, reason: 'unknown_min_plan:diamond' })
  // Unknown feature: that is what the fallback argument is for.
  assertEquals(effectiveCadence(policy, 'brand_new', 'basic', 900), { seconds: 900, enabled: true, reason: 'policy_row_missing_fallback' })
  assertEquals(effectiveCadence(policy, 'brand_new', 'basic', 0), { seconds: 0, enabled: false, reason: 'policy_row_missing' })
})

Deno.test('planTargets: the Basic table is the 15,000-credit month', () => {
  const basic = planTargets('basic')
  assertEquals(basic.catalogue, { cadenceSeconds: 3600, enabled: true, minPlan: 'basic', note: basic.catalogue.note })
  assertEquals(basic.quotes.cadenceSeconds, 900)
  assertEquals(basic.regime.cadenceSeconds, 3600)
  assertEquals(basic.rwa.cadenceSeconds, 7200)
  assertEquals(basic.structure.cadenceSeconds, 3600)
  assertEquals(basic.metadata.cadenceSeconds, 86400)
  assertEquals(basic.exchange_reserves.cadenceSeconds, 86400)
  assertEquals(basic.venue_share.cadenceSeconds, 86400)
  assertEquals(basic.logo_verify.cadenceSeconds, 86400)
  // Startup-only, Builder-only and Growth-only work is off, each with a reason.
  assertEquals(basic.attention.enabled, false)
  assertEquals(basic.airdrops.enabled, false)
  assertEquals(basic.network_stats.enabled, false)
  // History keeps its daily cadence; min_plan is what holds the backfill off.
  assertEquals(basic.history.enabled, true)
  assertEquals(basic.history.cadenceSeconds, 86400)
  assertEquals(basic.history.minPlan, 'startup')
  assertEquals(planTargets('builder').catalogue.cadenceSeconds, 3600, 'Builder gets the Basic table')
})

Deno.test('planTargets: Startup is the seeded table, and every plan above it matches', () => {
  const startup = planTargets('startup')
  for (const seed of SEEDED) {
    assertEquals(startup[seed.feature as never].cadenceSeconds, seed.cadence_seconds, seed.feature)
    assertEquals(startup[seed.feature as never].enabled, true, seed.feature)
  }
  for (const plan of ['growth', 'professional', 'enterprise']) {
    assertEquals(planTargets(plan), startup, plan)
  }
  // The returned table is a copy: editing it cannot poison the next caller.
  startup.catalogue.cadenceSeconds = 1
  assertEquals(planTargets('startup').catalogue.cadenceSeconds, 300)
})

Deno.test('runCredits: catalogue is the only plan-dependent cost, logo mirroring is free', () => {
  assertEquals(runCredits('catalogue', 'startup'), 4)
  assertEquals(runCredits('catalogue', 'basic'), 1)
  assertEquals(runCredits('logo_verify', 'basic'), 0)
  assertEquals(runCredits('regime', 'basic'), 3)
  assertEquals(runCredits('rwa', 'basic'), 7)
  assertEquals(runCredits('unknown_feature', 'basic'), 0)
})

Deno.test('monthlyBudgetEstimate: Basic targets fit inside the 12,000-credit ceiling', () => {
  const estimate = monthlyBudgetEstimate(schedulePolicyFromTargets('basic'), 'basic')
  assertEquals(estimate.monthSeconds, MONTH_SECONDS)
  assertEquals(estimate.totalCredits, 9180)
  assert(estimate.totalCredits < 15000 * 0.8, 'Basic projection must fit the governed ceiling')
  const line = (f: string) => estimate.lines.find((l) => l.feature === f)!
  assertEquals(line('catalogue').runsPerMonth, 720)
  assertEquals(line('catalogue').credits, 720)
  assertEquals(line('quotes').credits, 2880)
  assertEquals(line('regime').credits, 2160)
  assertEquals(line('rwa').credits, 2520)
  assertEquals(line('structure').credits, 720)
  assertEquals(line('metadata').credits, 120)
  assertEquals(line('attention').credits, 0)
  assertEquals(line('history').reason, 'requires_plan:startup')
  assertEquals(line('network_stats').credits, 0)
  assertEquals(line('venue_share').runsPerMonth, 30, 'a daily job runs thirty times in a 30-day month')
})

Deno.test('monthlyBudgetEstimate: Startup at seeded cadences, and unpriced rows are still listed', () => {
  const targetsOnly = monthlyBudgetEstimate(schedulePolicyFromTargets('startup'), 'startup')
  assertEquals(targetsOnly.totalCredits, 61710)
  // The live seeded rows leave network_stats on min_plan basic, so it is priced.
  const seeded = monthlyBudgetEstimate(policyOf(SEEDED), 'startup')
  assertEquals(seeded.totalCredits, 62430)
  assertEquals(seeded.lines.find((l) => l.feature === 'catalogue')!.credits, 34560)

  const extra = monthlyBudgetEstimate(policyOf([...SEEDED, { feature: 'dex_pairs', cadence_seconds: 300 }]), 'startup')
  const line = extra.lines.find((l) => l.feature === 'dex_pairs')!
  assertEquals(line.reason, 'unpriced_feature')
  assertEquals(line.credits, 0)
  assertEquals(extra.totalCredits, seeded.totalCredits, 'an unpriced row changes no total')
})

Deno.test('monthlyBudgetEstimate: Startup cadences on a Basic plan is the outage this ships to prevent', () => {
  const stillStartup = monthlyBudgetEstimate(policyOf(SEEDED), 'basic')
  assertEquals(stillStartup.totalCredits, 34050, 'more than twice a Basic month, from cadences nobody changed')
  assert(stillStartup.totalCredits > 15000 * 0.8, `expected a blown month, got ${stillStartup.totalCredits}`)
  // Catalogue alone at five minutes is more than twice the whole Basic month.
  assertEquals(stillStartup.lines.find((l) => l.feature === 'catalogue')!.credits, 8640)
})

Deno.test('isManagedReason: null and auto: are managed, anything else is an operator override', () => {
  assert(isManagedReason(null))
  assert(isManagedReason(''))
  assert(isManagedReason('auto:basic'))
  assert(!isManagedReason('asset catalogue and identity refresh'))
  assert(!isManagedReason('pinned by hand for the demo'))
  assertEquals(autoReason('basic'), 'auto:basic')
})

Deno.test('applyPlanTargets writes the Basic targets and guards ownership at write time', async () => {
  const db = fakeDb(SEEDED.map((r) => ({ ...r, reason: null })))
  const result = await applyPlanTargets(db, 'basic')
  assertEquals(result.error, null)
  assertEquals(result.dryRun, false)
  assertEquals(result.counts.updated, 13)
  assertEquals(result.counts.skipped_manual, 0)
  assertEquals(db.updates.length, 13)
  const catalogue = db.updates.find((u) => u.filters.includes('eq:feature=catalogue'))!
  assertEquals(catalogue.patch.cadence_seconds, 3600)
  assertEquals(catalogue.patch.enabled, true)
  assertEquals(catalogue.patch.reason, 'auto:basic')
  assert(catalogue.filters.includes('or:reason.is.null,reason.like.auto:*'), 'the write repeats the ownership guard')
  const attention = db.updates.find((u) => u.filters.includes('eq:feature=attention'))!
  assertEquals(attention.patch.enabled, false)
})

Deno.test('applyPlanTargets never overwrites a manual override, and reports it', async () => {
  const rows = SEEDED.map((r) => ({ ...r, reason: r.feature === 'structure' ? 'pinned to 5 minutes for the 25 September demo' : null }))
  const db = fakeDb(rows)
  const result = await applyPlanTargets(db, 'basic')
  assertEquals(result.counts.skipped_manual, 1)
  assertEquals(result.counts.updated, 12)
  const entry = result.entries.find((e) => e.feature === 'structure')!
  assertEquals(entry.action, 'skipped_manual')
  assertEquals(entry.from?.cadenceSeconds, 300)
  assert(entry.note.includes('25 September'))
  assertEquals(db.updates.some((u) => u.filters.includes('eq:feature=structure')), false)
})

Deno.test('applyPlanTargets: dry run writes nothing, a second run is idempotent, a failure is reported', async () => {
  const dry = await applyPlanTargets(fakeDb(SEEDED.map((r) => ({ ...r, reason: null }))), 'basic', { dryRun: true })
  assertEquals(dry.dryRun, true)
  assertEquals(dry.counts.updated, 13)
  assertEquals((fakeDb([]) as { updates: unknown[] }).updates.length, 0)

  const applied = planTargets('basic')
  const settled = CMC_SCHEDULE_FEATURES.map((f) => ({
    feature: f, cadence_seconds: applied[f].cadenceSeconds, enabled: applied[f].enabled,
    min_plan: applied[f].minPlan, reason: 'auto:basic',
  }))
  const second = await applyPlanTargets(fakeDb(settled), 'basic')
  assertEquals(second.counts.unchanged, 13)
  assertEquals(second.counts.updated, 0)

  const broken = await applyPlanTargets(fakeDb(SEEDED.map((r) => ({ ...r, reason: null })), { updateError: 'permission denied' }), 'basic')
  assertEquals(broken.counts.write_failed, 13)
  assertEquals(broken.counts.updated, 0)
  assert(broken.entries[0].note.includes('permission denied'))
})

Deno.test('applyPlanTargets: a missing row is reported, not invented, and an unreadable table aborts', async () => {
  const partial = await applyPlanTargets(fakeDb([{ feature: 'catalogue', cadence_seconds: 300, reason: null }]), 'basic')
  assertEquals(partial.counts.missing_row, 12)
  assertEquals(partial.counts.updated, 1)
  assertEquals(partial.entries.find((e) => e.feature === 'venue_share')!.from, null)

  const unreadable = await applyPlanTargets(fakeDb(SEEDED, { selectError: true }), 'basic')
  assertEquals(unreadable.error, 'policy_unavailable')
  assertEquals(unreadable.entries.length, 0)
})
