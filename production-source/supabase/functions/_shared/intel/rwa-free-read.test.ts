import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  claimFreeRwaRead, freeRwaCreditEstimate, freeRwaRead, freeRwaReadFresh, researchSurfaceFor,
  RWA_FREE_CAPABILITIES, useFreeRwaLane,
} from './rwa-free-read.ts'
import { INTEL_SURFACES, requireIntelSurface } from './intel-surface-access.ts'
import { researchSurfaceRequired } from '../../intel-research/index.ts'
import { CMC_CAPABILITIES } from '../market-assets/cmc-capabilities.ts'
import { requestCmc } from '../market-assets/cmc-transport.ts'
import type { OrgActor } from '../org-authz.ts'

// The real-world asset workspace on the free tier. Four properties, each
// asserted against the mechanism that holds it rather than against its name:
//
//   1. a free member is admitted to every RWA capability and refused everywhere
//      else in research;
//   2. a free read never stamps connected demand, so it cannot buy the refresh
//      worker a provider call on another clock;
//   3. a spent daily budget answers with the retained row, not an error;
//   4. a member who holds research_on_demand is not routed through any of it.

/** The catalogue as the two migrations seed it, mirrored so the fake can answer
 * the question SQL answers. rwa_research is the one new free row. */
const MIN_TIER: Record<string, string> = {
  market_boards: 'free', market_regime: 'free', capture_views: 'free',
  chart_workstation: 'free', narratives_read: 'free', watchlist: 'free',
  rwa_research: 'free',
  research_on_demand: 'starter', investigation: 'starter', portfolio_valuation: 'starter',
  ai_generation: 'starter', market_history: 'starter', alert_evaluation: 'starter',
  agent_access: 'starter', wallet_watch: 'starter', thesis_journal: 'starter',
  comment_king: 'starter',
}
const RANK: Record<string, number> = { free: 0, starter: 1, pro: 2, elite: 3, trial: 3 }

function tierDb(tier: string) {
  return {
    // deno-lint-ignore no-explicit-any
    rpc(name: string, args: Record<string, unknown>): Promise<any> {
      if (name !== 'intel_surface_allowed') return Promise.resolve({ data: null, error: { message: 'unexpected_rpc' } })
      const min = MIN_TIER[String(args.p_surface)]
      if (min === undefined) return Promise.resolve({ data: false, error: null })
      return Promise.resolve({ data: RANK[tier] >= RANK[min], error: null })
    },
  }
}
const member = (over: Partial<OrgActor> = {}): OrgActor =>
  ({ userId: 'member', orgId: 'org', isSuperAdmin: false, isService: false, ...over })

async function admitted(tier: string, surface: string) {
  try {
    // deno-lint-ignore no-explicit-any
    await requireIntelSurface(tierDb(tier), member(), surface as any)
    return true
  } catch { return false }
}

// ── 1. who is admitted ───────────────────────────────────────────────────────

Deno.test('the six real-world asset capabilities ask for rwa_research and nothing else does', () => {
  assertEquals([...RWA_FREE_CAPABILITIES].sort(), ['issuer', 'issuers', 'rwaInfo', 'rwaList', 'rwaPairs', 'rwaQuotes'])
  for (const capability of RWA_FREE_CAPABILITIES) {
    assertEquals(researchSurfaceFor(capability), 'rwa_research', `${capability} is part of the RWA workspace`)
    assert(CMC_CAPABILITIES[capability], `${capability} must be a registered capability`)
  }
  for (const capability of Object.keys(CMC_CAPABILITIES)) {
    if (RWA_FREE_CAPABILITIES.has(capability)) continue
    assertEquals(researchSurfaceFor(capability), 'research_on_demand', `${capability} keeps the paid surface`)
  }
  // The branched spenders and anything unrecognised also keep the paid surface,
  // so a new capability is gated by default rather than opened by accident.
  for (const capability of ['dexCohort', 'dexContext', 'venueContext', 'exchangeDisclosure', '', 'rwa', 'RWALIST', 'not_a_capability']) {
    assertEquals(researchSurfaceFor(capability), 'research_on_demand', `${capability} is not opened by accident`)
  }
  assert(INTEL_SURFACES.includes('rwa_research'), 'the new surface is in the mirrored catalogue')
})

Deno.test('opening the workspace did not ungate anything: every RWA read still requires a surface', () => {
  // researchSurfaceRequired answers WHETHER a surface is needed; researchSurfaceFor
  // answers WHICH. Only the second changed, and the first must not have moved.
  for (const capability of RWA_FREE_CAPABILITIES) {
    assertEquals(researchSurfaceRequired(capability), true, `${capability} is still gated, on the free surface`)
    assertEquals(researchSurfaceRequired(capability, 'retained'), true, `a retained ${capability} read is still gated`)
  }
})

Deno.test('a free member is admitted to every RWA capability and refused every other research read', async () => {
  for (const capability of RWA_FREE_CAPABILITIES) {
    assertEquals(await admitted('free', researchSurfaceFor(capability)), true, `free opens ${capability}`)
  }
  // The other three workspaces of the same page, and the rest of research.
  for (const capability of ['listings', 'trending', 'derivativeExchanges', 'marketPairs', 'global', 'fearGreed', 'history', 'quotes', 'dexTrending']) {
    assertEquals(await admitted('free', researchSurfaceFor(capability)), false, `free must not open ${capability}`)
  }
})

Deno.test('Starter and above are admitted to both surfaces, exactly as today', async () => {
  for (const tier of ['starter', 'pro', 'elite', 'trial']) {
    assertEquals(await admitted(tier, 'rwa_research'), true, `${tier} opens the RWA workspace`)
    assertEquals(await admitted(tier, 'research_on_demand'), true, `${tier} keeps on demand research`)
  }
})

// ── 2. a free read never stamps connected demand ─────────────────────────────

/** A transport-shaped fake that records every table write it is asked for.
 * Nothing here reaches a network: the read below is capped at maxCalls 0, which
 * returns before the fetch, so only the demand branch is exercised. */
function transportDb() {
  const writes: { table: string; op: string; row?: unknown }[] = []
  const chain = (table: string) => ({
    select() { return this },
    eq() { return this },
    // The operating-profile read and the cache read both end here.
    maybeSingle() { return Promise.resolve({ data: null, error: null }) },
    // deno-lint-ignore no-explicit-any
    upsert(row: any) { writes.push({ table, op: 'upsert', row }); return Promise.resolve({ error: null }) },
    // deno-lint-ignore no-explicit-any
    update(row: any) { writes.push({ table, op: 'update', row }); return chain(table) },
  })
  return {
    writes,
    from(table: string) { return chain(table) },
    rpc() { return Promise.resolve({ data: null, error: null }) },
  }
}

Deno.test('a free real-world-asset read stamps no demand, so the refresh worker never buys it a call', async () => {
  // A key has to be present for the transport to get as far as the demand
  // branch at all. This is a placeholder string, never a real credential.
  const previous = Deno.env.get('COINMARKETCAP_API_KEY')
  Deno.env.set('COINMARKETCAP_API_KEY', 'test-key-not-a-credential')
  try {
    // The paid context, for comparison: kind 'request' with no noDemand flag DOES
    // touch the shared cache row and record demand against the asking member.
    const paid = transportDb()
    await requestCmc('rwaList', { limit: 25, start: 1 }, {
      supabase: paid, kind: 'request', maxCalls: 0, orgId: 'org', userId: 'member',
    })
    const paidCacheWrites = paid.writes.filter((w) => w.table === 'market_data_response_cache')
    assert(paidCacheWrites.length > 0, 'the paid path is the one that records demand')
    assert(
      paidCacheWrites.some((w) => w.op === 'update' && (w.row as Record<string, unknown>)?.demand_user_id === 'member'),
      'the paid path attributes the demand to the asking member',
    )

    // The free lane, both passes. Neither may write the cache row, because
    // writing it is how demanded_at and the demand owner are recorded, and
    // demanded_at is the refresh worker's only input.
    for (const kind of ['render', 'request'] as const) {
      const free = transportDb()
      await requestCmc('rwaList', { limit: 25, start: 1 }, {
        supabase: free, kind, selectedDemand: false, noDemand: true, maxCalls: 0,
        orgId: 'org', userId: 'member',
      })
      assertEquals(
        free.writes.filter((w) => w.table === 'market_data_response_cache'),
        [],
        `the free ${kind} pass must leave no demand behind it`,
      )
    }
  } finally {
    if (previous === undefined) Deno.env.delete('COINMARKETCAP_API_KEY')
    else Deno.env.set('COINMARKETCAP_API_KEY', previous)
  }
})

// ── 3. the daily budget, and what a spent one answers with ───────────────────

Deno.test('every RWA read is estimated at one credit, and an unknown one at the ceiling', () => {
  for (const capability of RWA_FREE_CAPABILITIES) {
    assertEquals(freeRwaCreditEstimate(capability, { limit: '25', start: '1' }), 1, `${capability} is one credit`)
  }
  // A page of 250 is still one credit: these endpoints bill 250 rows per credit.
  assertEquals(freeRwaCreditEstimate('rwaList', { limit: '250', start: '1' }), 1)
  // A capability this file does not know is charged the most the claim accepts,
  // so a mistake refuses rather than quietly undercounting.
  assertEquals(freeRwaCreditEstimate('not_a_capability', {}), 25)
})

Deno.test('the claim refuses on every failure, because an unreadable budget is not an unlimited one', async () => {
  const cases: { reply: unknown; error?: unknown; reason: string }[] = [
    { reply: null, error: { message: 'down' }, reason: 'free_rwa_budget_unavailable' },
    { reply: null, reason: 'free_rwa_budget_unavailable' },
    { reply: 'not an object', reason: 'free_rwa_budget_unavailable' },
    { reply: { allowed: false, reason: 'free_rwa_budget_exhausted', cap: 200, used: 200 }, reason: 'free_rwa_budget_exhausted' },
    { reply: { allowed: false, reason: 'free_rwa_lane_disabled' }, reason: 'free_rwa_lane_disabled' },
    { reply: { allowed: false }, reason: 'free_rwa_budget_exhausted' },
    // 'allowed' has to be exactly true. A truthy string is not a grant.
    { reply: { allowed: 'true' }, reason: 'free_rwa_budget_exhausted' },
  ]
  for (const c of cases) {
    const db = { rpc: () => Promise.resolve({ data: c.reply, error: c.error ?? null }) }
    const claim = await claimFreeRwaRead(db, 'rwaList', { limit: '25' })
    assertEquals(claim.allowed, false, `${JSON.stringify(c.reply)} is not a grant`)
    assertEquals(claim.reason, c.reason)
  }
  // A thrown RPC is the same answer.
  const thrown = await claimFreeRwaRead({ rpc: () => { throw new Error('boom') } }, 'rwaList', {})
  assertEquals(thrown, { allowed: false, reason: 'free_rwa_budget_unavailable', cap: null, used: null })

  const granted = await claimFreeRwaRead(
    { rpc: () => Promise.resolve({ data: { allowed: true, cap: 200, used: 7 }, error: null }) },
    'rwaList', { limit: '25' },
  )
  assertEquals(granted, { allowed: true, reason: null, cap: 200, used: 7 })
})

Deno.test('the claim charges the capability and the estimate it was given', async () => {
  const seen: Record<string, unknown>[] = []
  const db = { rpc: (_name: string, args: Record<string, unknown>) => { seen.push(args); return Promise.resolve({ data: { allowed: true }, error: null }) } }
  await claimFreeRwaRead(db, 'rwaQuotes', { rwa_id: '1' })
  assertEquals(seen, [{ p_capability: 'rwaQuotes', p_credits: 1 }])
})

const retained = { state: 'stale', reason: null, data: { rows: [{ rwa_id: '1' }], total: 1, hasMore: false }, provenance: { fetchedAt: '2026-09-20T09:00:00Z' } }
const nothing = { state: 'unavailable', reason: 'refresh_required', data: { rows: [], total: null, hasMore: false }, provenance: { fetchedAt: null } }
const fresh = { state: 'fresh', reason: null, data: { rows: [{ rwa_id: '1' }], total: 1, hasMore: false }, provenance: { fetchedAt: '2026-09-20T14:00:00Z' } }

Deno.test('a usable shared row answers the read and the budget is never touched', async () => {
  for (const shared of [retained, { ...retained, state: 'cached' }, fresh]) {
    const plans: string[] = []
    let claimed = 0
    const out = await freeRwaRead(
      (plan) => { plans.push(plan); return Promise.resolve(shared) },
      () => { claimed++; return Promise.resolve({ allowed: true, reason: null, cap: 200, used: 1 }) },
    )
    assertEquals(plans, ['shared-cache'], 'the shared cache is asked first and, when it answers, only once')
    assertEquals(claimed, 0, 'a cache hit spends nothing, so it claims nothing')
    assertEquals(out.data.rows.length, 1)
    assertEquals(out.freeShared, { lane: 'rwa_research', served: 'shared-cache' })
    // A free read is never enrolled in the 60 second live-watch loop.
    assertEquals(out.refreshPolicy, { enabled: false, cacheReadSeconds: null, providerRefreshSeconds: null })
  }
})

Deno.test('a cache miss claims the daily budget once, and a grant allows exactly one live pass', async () => {
  const plans: string[] = []
  const out = await freeRwaRead(
    (plan) => { plans.push(plan); return Promise.resolve(plan === 'shared-live' ? fresh : nothing) },
    () => Promise.resolve({ allowed: true, reason: null, cap: 200, used: 1 }),
  )
  assertEquals(plans, ['shared-cache', 'shared-live'])
  assertEquals(out.state, 'fresh')
  assertEquals(out.freeShared, { lane: 'rwa_research', served: 'shared-live', reason: null })
})

Deno.test('a spent budget answers with the retained row and its capture time, never an error', async () => {
  // The cache read is past its TTL but still inside its stale window, so there
  // IS a retained row. The member gets it, with the time it was retrieved.
  const plans: string[] = []
  const out = await freeRwaRead(
    (plan) => { plans.push(plan); return Promise.resolve(plan === 'shared-cache' ? { ...retained, state: 'unavailable', data: { rows: [], total: null, hasMore: false } } : fresh) },
    () => Promise.resolve({ allowed: false, reason: 'free_rwa_budget_exhausted', cap: 200, used: 200 }),
  )
  assertEquals(plans, ['shared-cache'], 'a refused claim never runs the live pass')
  assertEquals(out.freeShared, { lane: 'rwa_research', served: 'retained', reason: 'free_rwa_budget_exhausted' })
  // The retained provenance rides along, so the page can say when it was read.
  assertEquals(out.provenance.fetchedAt, '2026-09-20T09:00:00Z')
})

Deno.test('a record that was never cached is a calm state, not a failure and not an upsell', async () => {
  const out = await freeRwaRead(
    () => Promise.resolve(nothing),
    () => Promise.resolve({ allowed: false, reason: 'free_rwa_budget_exhausted', cap: 200, used: 200 }),
  )
  assertEquals(out.data.rows, [])
  assertEquals(out.freeShared.served, 'retained')
  // Nothing on the body claims a surface is locked, because none is: the
  // member holds rwa_research. The page renders the not-read-yet sentence.
  assertEquals((out as Record<string, unknown>).error, undefined)
})

Deno.test('a capability our own plan cannot serve never spends a slot of the day', async () => {
  // rwaPairs needs CMC Growth and the verified profile is lower, so the
  // transport answers 'unsupported' before it reaches the cache or the
  // reservation. A second pass would return the identical refusal having burnt a
  // credit of the free tier's daily budget, which is spending on a refusal.
  const plans: string[] = []
  let claimed = 0
  const unsupported = { state: 'unsupported', reason: 'insufficient_entitlement', data: { rows: [], total: null, hasMore: false }, provenance: { fetchedAt: null } }
  const out = await freeRwaRead(
    (plan) => { plans.push(plan); return Promise.resolve(unsupported) },
    () => { claimed++; return Promise.resolve({ allowed: true, reason: null, cap: 200, used: 1 }) },
  )
  assertEquals(plans, ['shared-cache'])
  assertEquals(claimed, 0, 'a refusal is not made true by paying for it again')
  assertEquals(out.freeShared, { lane: 'rwa_research', served: 'retained', reason: 'insufficient_entitlement' })
})

Deno.test('a background retained poll may read the shared record but may never spend the day', async () => {
  const plans: string[] = []
  let claimed = 0
  const out = await freeRwaRead(
    (plan) => { plans.push(plan); return Promise.resolve(nothing) },
    () => { claimed++; return Promise.resolve({ allowed: true, reason: null, cap: 200, used: 1 }) },
    false,
  )
  assertEquals(plans, ['shared-cache'])
  assertEquals(claimed, 0, 'a browser refreshing on a timer must not be what spends the budget')
  assertEquals(out.freeShared.reason, 'free_rwa_background_read')
})

// ── 4. Starter is not routed through any of this ──────────────────────────────

Deno.test('only a free member takes the bounded lane', () => {
  for (const capability of RWA_FREE_CAPABILITIES) {
    assertEquals(useFreeRwaLane(capability, false), true, `a member without the paid surface reads ${capability} on the lane`)
    assertEquals(useFreeRwaLane(capability, true), false, `a holder of research_on_demand keeps the existing path for ${capability}`)
  }
  for (const capability of ['listings', 'quotes', 'derivativePairs', 'dexTrending', 'catalog', '']) {
    assertEquals(useFreeRwaLane(capability, false), false, `${capability} is not an RWA read and never joins the lane`)
    assertEquals(useFreeRwaLane(capability, true), false)
  }
})

// ── 5. The public lookup's refresh-aware read (freeRwaReadFresh) ──────────────
//
// Used only by intel-rwa-lookup (and so by the demo). A copy past its window is
// not simply served: a batched copy inside its window answers first, then one
// refresh through the same gates as a miss, and only then the newest old copy,
// still saying why.

const snapAt = (state: string, fetchedAt: string, extra: Record<string, unknown> = {}) =>
  ({ state, reason: null, payload: { data: [] }, data: { rows: [{ rwa_id: 1 }], total: 1, hasMore: false }, provenance: { fetchedAt }, receipt: { origin: state === 'fresh' ? 'live' : 'cache', fetchedAt }, ...extra })
const OLD = '2026-09-24T07:00:00.000Z', NEWER = '2026-09-24T09:20:00.000Z', NOW_ISO = '2026-09-24T10:00:00.000Z'
const grant = (allowed = true, reason: string | null = null) => {
  const log = { n: 0 }
  return { log, claim: () => { log.n++; return Promise.resolve({ allowed, reason: allowed ? null : reason, cap: 200, used: 1 }) } }
}

Deno.test('fresh read: a copy inside its window answers with no alternate, no claim and no call', async () => {
  const plans: string[] = []
  let alt = 0
  const g = grant()
  const out = await freeRwaReadFresh((p) => { plans.push(p); return Promise.resolve(snapAt('cached', NEWER)) }, g.claim, true, { alternate: () => { alt++; return Promise.resolve(null) } })
  assertEquals(plans, ['shared-cache']); assertEquals(alt, 0); assertEquals(g.log.n, 0)
  assertEquals(out.freeShared, { lane: 'rwa_research', served: 'shared-cache' })
})

Deno.test('fresh read: past its window, the batched copy inside its window answers for nothing', async () => {
  const plans: string[] = []
  const g = grant()
  const out = await freeRwaReadFresh((p) => { plans.push(p); return Promise.resolve(snapAt('stale', OLD)) }, g.claim, true,
    { alternate: () => Promise.resolve(snapAt('cached', NEWER, { warmBatch: { size: 57 } })) })
  assertEquals(plans, ['shared-cache']); assertEquals(g.log.n, 0)
  assertEquals(out.provenance.fetchedAt, NEWER); assertEquals(out.warmBatch, { size: 57 })
})

Deno.test('fresh read: past its window with no batched copy, one refresh through the claim', async () => {
  const plans: string[] = []
  const g = grant()
  const out = await freeRwaReadFresh((p) => { plans.push(p); return Promise.resolve(p === 'shared-live' ? snapAt('fresh', NOW_ISO) : snapAt('stale', OLD)) }, g.claim)
  assertEquals(plans, ['shared-cache', 'shared-live']); assertEquals(g.log.n, 1)
  assertEquals(out.state, 'fresh'); assertEquals(out.freeShared.served, 'shared-live')
})

Deno.test('fresh read: a refused claim keeps the NEWEST old copy and says why; nothing is called', async () => {
  const plans: string[] = []
  const g = grant(false, 'free_rwa_ip_hourly_limit')
  const out = await freeRwaReadFresh((p) => { plans.push(p); return Promise.resolve(snapAt('stale', OLD)) }, g.claim, true,
    { alternate: () => Promise.resolve(snapAt('stale', NEWER, { warmBatch: { size: 57 } })) })
  assertEquals(plans, ['shared-cache'])
  assertEquals(out.state, 'stale', 'still stale, and says so')
  assertEquals(out.provenance.fetchedAt, NEWER, 'the newer of the two old copies')
  assertEquals(out.freeShared, { lane: 'rwa_research', served: 'shared-cache', reason: 'free_rwa_ip_hourly_limit' })
})

Deno.test('fresh read: a recorded plan refusal is honoured: no claim, no call, the old copy with that reason', async () => {
  const plans: string[] = []
  const g = grant()
  const out = await freeRwaReadFresh((p) => { plans.push(p); return Promise.resolve(snapAt('stale', OLD)) }, g.claim, true, { liveBlocked: 'insufficient_entitlement' })
  assertEquals(plans, ['shared-cache']); assertEquals(g.log.n, 0)
  assertEquals(out.freeShared.reason, 'insufficient_entitlement')
  // A miss under the same refusal is the lane's unavailable body with the reason, never a call.
  const miss = await freeRwaReadFresh(() => Promise.resolve(nothing), g.claim, true, { liveBlocked: 'insufficient_entitlement' })
  assertEquals(g.log.n, 0); assertEquals(miss.freeShared, { lane: 'rwa_research', served: 'retained', reason: 'insufficient_entitlement' })
})

Deno.test('fresh read: a refresh the provider refuses hands back the old copy with the refusal', async () => {
  const g = grant()
  const out = await freeRwaReadFresh((p) => Promise.resolve(p === 'shared-live' ? { ...snapAt('stale', OLD), reason: 'insufficient_entitlement' } : snapAt('stale', OLD)), g.claim)
  assertEquals(g.log.n, 1)
  assertEquals(out.state, 'stale'); assertEquals(out.freeShared.reason, 'insufficient_entitlement')
})

Deno.test('fresh read: a background poll and an unsupported capability never claim', async () => {
  const g = grant()
  const bg = await freeRwaReadFresh(() => Promise.resolve(snapAt('stale', OLD)), g.claim, false)
  assertEquals(bg.freeShared.reason, 'free_rwa_background_read'); assertEquals(bg.state, 'stale')
  const unsupported = { state: 'unsupported', reason: 'insufficient_entitlement', data: { rows: [] }, provenance: { fetchedAt: null } }
  const un = await freeRwaReadFresh(() => Promise.resolve(unsupported), g.claim)
  assertEquals(un.freeShared.served, 'retained'); assertEquals(g.log.n, 0)
})

Deno.test('fresh read: the paid and free intel-research path (freeRwaRead) is unchanged: a stale copy still answers without a claim', async () => {
  const g = grant()
  const out = await freeRwaRead(() => Promise.resolve(snapAt('stale', OLD)), g.claim)
  assertEquals(g.log.n, 0); assertEquals(out.freeShared, { lane: 'rwa_research', served: 'shared-cache' })
})
