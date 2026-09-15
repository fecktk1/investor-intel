// Tests for the Data budget response contract. Run:
//   deno test --allow-read --allow-net --allow-env --no-check \
//     supabase/functions/intel-data-budget/index.test.ts
//
// index.ts is a Deno.serve listener plus two exported functions; the listener is
// four lines of auth copied from market-asset-logo-verify, so what is proved
// here is the shape and the honesty of the payload: every part that could not be
// read says so in `degraded` instead of rendering as a zero, and `apply` defaults
// to a dry run.

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { applyDataBudget, readDataBudget } from './index.ts'
import { planTargets, CMC_SCHEDULE_FEATURES } from '../_shared/intel/schedule-policy.ts'

const NOW = new Date('2026-10-01T09:00:00Z')

const PROFILE = {
  CMC_ACCESS_PROFILE: 'hackathon',
  CMC_VERIFIED_HACKATHON_PLAN: 'startup',
  CMC_VERIFIED_BASELINE_PLAN: 'basic',
  CMC_HACKATHON_EXPIRES_AT: '2026-09-30T23:59:00Z',
}

const basic = planTargets('basic')
const POLICY_ROWS = CMC_SCHEDULE_FEATURES.map((feature) => ({
  provider: 'coinmarketcap', feature,
  cadence_seconds: basic[feature].cadenceSeconds,
  enabled: basic[feature].enabled,
  min_plan: basic[feature].minPlan,
  reason: 'auto:basic',
  updated_at: '2026-10-01T00:15:02Z',
}))

const SNAPSHOT = {
  generatedAt: '2026-10-01T09:00:00Z', callDays: 7, demandDays: 30,
  jobs: [
    { jobname: 'market-assets-refresh-broad', schedule: '12 * * * *', active: true, lastRun: { status: 'succeeded', start: '2026-10-01T08:12:00Z', end: '2026-10-01T08:12:31Z' } },
    { jobname: 'intel-capture-hourly', schedule: '7 * * * *', active: true, lastRun: null },
  ],
  cacheReuse: [{ endpoint: '/v3/cryptocurrency/listings/latest', calls: 900, live: 168, hits: 732, misses: 0, credits: 672 }],
  demandDaily: [{ day: '2026-09-30', assets: 41, demands: 96 }],
}

interface State { table: string; op: 'select' | 'update'; select: string; options: Record<string, unknown>; patch: Record<string, unknown> | null; steps: Array<[string, unknown, unknown]>; filters: Record<string, unknown> }

/** A supabase-js stand-in. `resolve` sees the whole accumulated query, so a test
 * can answer differently for the account row and the credits row on the same
 * table, and `writes` records everything the apply path sent. */
function makeDb(resolve: (s: State, single: boolean) => unknown, rpcs: Record<string, unknown> = {}) {
  const writes: State[] = []
  const rpcCalls: Array<{ name: string; args: unknown }> = []
  const build = (init: Partial<State>): any => {
    const state: State = { table: '', op: 'select', select: '', options: {}, patch: null, steps: [], filters: {}, ...init } as State
    const b: any = {
      eq(c: string, v: unknown) { state.filters[c] = v; state.steps.push(['eq', c, v]); return b },
      like(c: string, v: unknown) { state.filters[c] = v; state.steps.push(['like', c, v]); return b },
      order(c: string, o: unknown) { state.steps.push(['order', c, o]); return b },
      limit(n: number) { state.steps.push(['limit', n, null]); return b },
      or(expr: string) { state.steps.push(['or', expr, null]); if (state.op === 'update') writes.push(state); return b },
      maybeSingle() { return Promise.resolve(resolve(state, true)) },
      then(ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) { return Promise.resolve(resolve(state, false)).then(ok, bad) },
    }
    return b
  }
  return {
    writes, rpcCalls,
    from(table: string) {
      return {
        select(select: string, options: Record<string, unknown> = {}) { return build({ table, op: 'select', select, options }) },
        update(patch: Record<string, unknown>) { return build({ table, op: 'update', patch }) },
      }
    },
    rpc(name: string, args: unknown) {
      rpcCalls.push({ name, args })
      const value = rpcs[name]
      return Promise.resolve(value instanceof Error ? { data: null, error: { message: value.message } } : { data: value ?? null, error: null })
    },
  }
}

/** The healthy project: profile, account, credits, feature buckets, the Basic
 * policy, the snapshot RPC and ten populated capture tables. */
function healthyDb(overrides: { policyError?: boolean; snapshotError?: boolean } = {}) {
  return makeDb((s) => {
    if (s.table === 'provider_quota_budgets') {
      if (s.filters.data_type === 'cmc_operating_profile') return { data: { config: PROFILE }, error: null }
      if (s.filters.data_type === 'cmc_account') {
        return { data: { config: { credit_limit: 15000, rate_limit: 50, reset_at: '2026-10-22T00:00:00Z', verified_at: '2026-10-01T08:00:00Z', fingerprint: 'abc123' } }, error: null }
      }
      if (s.filters.data_type === 'cmc_credits') {
        return { data: { period_start: '2026-09-22T00:00:00Z', period_end: '2026-10-22T00:00:00Z', credits_used: 4210.5, credits_reserved: 12, hard_cap: 12000 }, error: null }
      }
      if (String(s.filters.data_type ?? '').startsWith('cmc_feature_credit')) {
        return { data: [
          { data_type: 'cmc_feature_credit:market', credits_used: 2600 },
          { data_type: 'cmc_feature_credit:regime', credits_used: 900 },
        ], error: null }
      }
      return { data: null, error: null }
    }
    if (s.table === 'provider_schedule_policy') {
      return overrides.policyError ? { data: null, error: { message: 'boom' } } : { data: POLICY_ROWS, error: null }
    }
    // Capture tables: a head count, then the newest row.
    if (s.options.head === true) return { data: null, count: 12345, error: null }
    return { data: { captured_at: '2026-10-01T08:00:00Z', snapshot_date: '2026-09-30', last_seen_at: '2026-10-01T03:00:00Z' }, error: null }
  }, { intel_data_budget_snapshot: overrides.snapshotError ? new Error('rpc down') : SNAPSHOT })
}

Deno.test('read: the plan is the verified profile, and 1 October is Basic', async () => {
  const body = await readDataBudget(healthyDb(), NOW)
  assertEquals(body.ok, true)
  assertEquals(body.plan, {
    effective: 'basic', profile: 'hackathon', expiresAt: '2026-09-30T23:59:00Z',
    baseline: 'basic', hackathon: 'startup', expired: true,
  })
  assertEquals(body.generatedAt, NOW.toISOString())
})

Deno.test('read: the account facts are reported and the key fingerprint never leaves the row', async () => {
  const body = await readDataBudget(healthyDb(), NOW) as Record<string, any>
  assertEquals(body.account, { creditLimit: 15000, rateLimit: 50, resetAt: '2026-10-22T00:00:00Z', verifiedAt: '2026-10-01T08:00:00Z' })
  assert(!JSON.stringify(body).includes('abc123'), 'the API key fingerprint must not be in the payload')
})

Deno.test('read: the month projects the Basic cadences against the governed ceiling', async () => {
  const body = await readDataBudget(healthyDb(), NOW) as Record<string, any>
  assertEquals(body.month.used, 4210.5)
  assertEquals(body.month.reserved, 12)
  // The ceiling is whatever cmc_request_reserve enforces, which resolves the
  // plan at wall-clock time; this test asks for an October `now` while the suite
  // runs in September, so the two disagree and the payload says which plan the
  // ceiling belongs to rather than hiding the difference.
  assertEquals(body.month.ceiling, body.month.ceilingPlan === 'basic' ? 12000 : 360000)
  assert(['basic', 'startup'].includes(body.month.ceilingPlan))
  assertEquals(body.month.projectedAtCurrentCadence, 9154)
  assertEquals(body.month.periodStart, '2026-09-22T00:00:00Z')
  assert(body.month.projectedAtCurrentCadence < 15000 * 0.8, 'the Basic schedule must fit a Basic month')
  assertEquals(body.projection, { startup: 61684, basic: 9154 })
})

Deno.test('read: every feature carries its cadence, plan gate, reason and credit bucket', async () => {
  const body = await readDataBudget(healthyDb(), NOW) as Record<string, any>
  assertEquals(body.features.length, 13)
  for (const f of body.features) {
    for (const key of ['feature', 'cadenceSeconds', 'enabled', 'minPlan', 'allowedOnPlan', 'reason', 'usedThisMonth']) {
      assert(key in f, `features[] must carry ${key}`)
    }
  }
  const byName = (n: string) => body.features.find((f: any) => f.feature === n)
  assertEquals(byName('catalogue').cadenceSeconds, 3600)
  assertEquals(byName('catalogue').creditsPerRun, 1)
  assertEquals(byName('catalogue').runsPerMonth, 720)
  assertEquals(byName('catalogue').usedThisMonth, 2600)
  assertEquals(byName('quotes').creditBucket, 'market')
  assertEquals(byName('quotes').usedThisMonth, 2600, 'catalogue and quotes share one reservation bucket')
  // Startup-only, Builder-only and Growth-only work is off with a truthful reason.
  assertEquals(byName('attention').enabled, false)
  assertEquals(byName('history').allowedOnPlan, false)
  assertEquals(byName('history').reason, 'requires_plan:startup')
  assertEquals(byName('airdrops').enabled, false)
  assertEquals(byName('network_stats').enabled, false)
  assertEquals(byName('logo_verify').creditsPerRun, 0)
})

Deno.test('read: jobs, cache reuse, demand and the ten capture tables come through unchanged', async () => {
  const db = healthyDb()
  const body = await readDataBudget(db, NOW) as Record<string, any>
  assertEquals(body.jobs, SNAPSHOT.jobs)
  assertEquals(body.cacheReuse, SNAPSHOT.cacheReuse)
  assertEquals(body.demandDaily, SNAPSHOT.demandDaily)
  assertEquals(db.rpcCalls[0].name, 'intel_data_budget_snapshot')
  assertEquals(db.rpcCalls[0].args, { p_call_days: 7, p_demand_days: 30, p_top: 15, p_provider: 'coinmarketcap' })
  assertEquals(body.capture.length, 10)
  assertEquals(body.capture[0], { table: 'intel_regime_snapshots', rows: 12345, newest: '2026-10-01T08:00:00Z', newestColumn: 'captured_at' })
  assertEquals(body.capture.find((c: any) => c.table === 'intel_airdrop_snapshots').newest, '2026-10-01T03:00:00Z')
  assertEquals(body.degraded, [])
})

Deno.test('read: a part that cannot be read says so instead of rendering as a zero', async () => {
  const body = await readDataBudget(healthyDb({ policyError: true, snapshotError: true }), NOW) as Record<string, any>
  assertEquals(body.ok, true, 'the panel still renders what it does have')
  const parts = body.degraded.map((d: any) => `${d.part}:${d.reason}`)
  assert(parts.includes('features:policy_unavailable'), parts.join(','))
  assert(parts.includes('snapshot:snapshot_unavailable'), parts.join(','))
  assertEquals(body.jobs, [])
  assertEquals(body.cacheReuse, [])
  // With no policy every feature falls back to its plan target and says why.
  assertEquals(body.features.length, 13)
  assertEquals(body.features.find((f: any) => f.feature === 'catalogue').reason, 'policy_row_missing_fallback')
})

Deno.test('apply: a bare { op: apply } is a dry run — it writes no row and moves no job', async () => {
  const db = healthyDb()
  const result = await applyDataBudget(db, { dryRun: true, now: NOW })
  assertEquals(result.ok, true)
  assertEquals(result.plan, 'basic')
  assertEquals(result.dryRun, true)
  assertEquals(db.writes.length, 0, 'a dry run writes no policy row')
  assertEquals(db.rpcCalls.at(-1), { name: 'intel_apply_schedule_cadences', args: { p_dry_run: true } })
  assertEquals(result.policy.counts.unchanged, 13, 'the policy is already on the Basic targets')
})

Deno.test('apply: a real run writes the plan targets and asks SQL to move the jobs', async () => {
  // The policy is still on the Startup cadences: this is the 1 October flip.
  const startup = planTargets('startup')
  const db = makeDb((s) => {
    if (s.table === 'provider_quota_budgets' && s.filters.data_type === 'cmc_operating_profile') return { data: { config: PROFILE }, error: null }
    if (s.table === 'provider_schedule_policy') {
      return { data: CMC_SCHEDULE_FEATURES.map((f) => ({ provider: 'coinmarketcap', feature: f, cadence_seconds: startup[f].cadenceSeconds, enabled: startup[f].enabled, min_plan: startup[f].minPlan, reason: null })), error: null }
    }
    return { data: null, error: null }
  }, { intel_apply_schedule_cadences: { dryRun: false, jobs: [{ feature: 'catalogue', jobname: 'market-assets-refresh-broad', action: 'altered', schedule: '12 * * * *' }] } })

  const result = await applyDataBudget(db, { dryRun: false, now: NOW })
  assertEquals(result.ok, true)
  assertEquals(result.policy.counts.updated, 13)
  assertEquals(db.writes.length, 13)
  const catalogue = db.writes.find((w) => w.filters.feature === 'catalogue')!
  assertEquals(catalogue.patch!.cadence_seconds, 3600)
  assertEquals(catalogue.patch!.reason, 'auto:basic')
  assert(catalogue.steps.some(([kind, expr]) => kind === 'or' && String(expr).includes('auto:*')), 'the write repeats the manual-override guard')
  assertEquals((result.cron as any).jobs[0].action, 'altered')
  assertEquals(db.rpcCalls.at(-1), { name: 'intel_apply_schedule_cadences', args: { p_dry_run: false } })
})

Deno.test('apply: a failed cron step is reported, never reported as success', async () => {
  const db = healthyDb()
  ;(db as any).rpc = (name: string, args: unknown) => {
    ;(db as any).rpcCalls.push({ name, args })
    return Promise.resolve({ data: null, error: { message: 'permission denied for function intel_apply_schedule_cadences' } })
  }
  const result = await applyDataBudget(db, { dryRun: true, now: NOW })
  assertEquals(result.ok, false)
  assertEquals(result.cron, null)
  assert(String(result.cronError).includes('permission denied'))
})
