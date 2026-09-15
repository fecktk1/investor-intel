import { assertEquals as eq, assert, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { readContractResearch } from './contract-research.ts'
import { HOLDER_COHORT_TABLE, HOLDER_TAG_TABLE } from './holder-tags.ts'

const CANONICAL = `eip155:8453:0x${'ab'.repeat(20)}`
const ADDRESS = `0x${'ab'.repeat(20)}`
const ACTOR = { userId: 'user-1', orgId: 'org-1' }
const HOUR = 3_600_000
const hour = (ms: number) => new Date(Math.floor(ms / HOUR) * HOUR).toISOString()
const evm = (n: number) => `0x${n.toString(16).padStart(40, '0')}`

/** Startup, with retention and AI processing permitted so the evidence path runs. */
const STARTUP = { CMC_VERIFIED_BASELINE_PLAN: 'startup', CMC_ALLOW_HISTORICAL_RETENTION: 'true', CMC_ALLOW_AI_PROCESSING: 'true' }

// deno-lint-ignore no-explicit-any
function fakeDb(settings: Record<string, string>, tables: Record<string, any[]> = {}) {
  // deno-lint-ignore no-explicit-any
  const rpcs: { name: string; args: any }[] = []
  return {
    rpcs, tables,
    // deno-lint-ignore no-explicit-any
    rpc: (name: string, args: any) => { rpcs.push({ name, args }); return Promise.resolve({ data: null, error: null }) },
    from(table: string) {
      // deno-lint-ignore no-explicit-any
      const filters: [string, string, any][] = []
      let ordering: { column: string; ascending: boolean } | null = null
      // deno-lint-ignore no-explicit-any
      const rows = () => (tables[table] || []).filter((row: any) => filters.every(([k, op, v]) =>
        op === 'eq' ? String(row?.[k] ?? '') === String(v ?? '')
          : op === 'gte' ? String(row?.[k] ?? '') >= String(v ?? '')
          : op === 'gt' ? String(row?.[k] ?? '') > String(v ?? '')
          : op === 'in' ? (v as unknown[]).map(String).includes(String(row?.[k] ?? '')) : true))
      // deno-lint-ignore no-explicit-any
      const q: any = {
        select: () => q,
        // deno-lint-ignore no-explicit-any
        eq: (k: string, v: any) => { filters.push([k, 'eq', v]); return q },
        // deno-lint-ignore no-explicit-any
        gte: (k: string, v: any) => { filters.push([k, 'gte', v]); return q },
        // deno-lint-ignore no-explicit-any
        gt: (k: string, v: any) => { filters.push([k, 'gt', v]); return q },
        // deno-lint-ignore no-explicit-any
        in: (k: string, v: any[]) => { filters.push([k, 'in', v]); return q },
        order: (column: string, options?: { ascending?: boolean }) => { ordering = { column, ascending: options?.ascending !== false }; return q },
        maybeSingle: () => Promise.resolve({ data: table === 'provider_quota_budgets' ? { config: settings } : (rows()[0] ?? null), error: null }),
        limit: (max: number) => {
          let list = rows()
          if (ordering) list = [...list].sort((a, b) => String(a?.[ordering!.column] ?? '').localeCompare(String(b?.[ordering!.column] ?? '')) * (ordering!.ascending ? 1 : -1))
          return Promise.resolve({ data: list.slice(0, max), error: null })
        },
        // deno-lint-ignore no-explicit-any
        upsert: (written: any[]) => { tables[table] = [...(tables[table] || []), ...written]; return Promise.resolve({ data: written, error: null }) },
      }
      return q
    },
  }
}

const board = { data: { holders: [
  { tag: 'tag_dev', hc: 2, tb: 10, hr: 0.5 },
  { tag: 'tag_sniper', hc: 0, tb: 0, hr: 0 },
] } }
const holders = { data: { holders: [
  { walletAddress: evm(1), balance: 100, percent: 1, buyUsd: 50, sellUsd: 10, realizedPnl: 40, fundingSource: 'bridge' },
  { walletAddress: evm(2), balance: 50, percent: 0.5, buyUsd: 10, sellUsd: 50, realizedPnl: -40, fundingSource: 'cex' },
] } }

function fakeRequest() {
  const calls: string[] = []
  // deno-lint-ignore no-explicit-any
  const request = ((name: string) => {
    calls.push(name)
    const now = new Date().toISOString()
    const payload = name === 'dexHolderTags' ? board : name === 'dexHolders' ? holders : null
    return Promise.resolve({ payload, state: payload ? 'fresh' : 'unavailable', reason: null,
      provenance: { fetchedAt: now, expiresAt: new Date(Date.now() + HOUR).toISOString() } })
  // deno-lint-ignore no-explicit-any
  }) as any
  return { request, calls }
}

// deno-lint-ignore no-explicit-any
const read = (db: any, input: Record<string, unknown>, request?: any, cacheOnly = false) =>
  readContractResearch(db, { canonicalKey: CANONICAL, ...input }, ACTOR, request ?? fakeRequest().request, cacheOnly) as Promise<any>

Deno.test('the holder-tag view only accepts its own parameters', async () => {
  const db = fakeDb(STARTUP)
  await assertRejects(() => read(db, { view: 'holder_tags', days: 30 }), Error, 'invalid_contract_research_request')
  await assertRejects(() => read(db, { view: 'overview', capturedAt: hour(Date.now()) }), Error, 'invalid_contract_research_request')
  await assertRejects(() => read(db, { view: 'holder_tags', capturedAt: 'yesterday' }), Error, 'invalid_contract_research_request')
  await assertRejects(() => read(db, { view: 'holder_tags', compareWith: 42 as unknown as string }), Error, 'invalid_contract_research_request')
  await assertRejects(() => read(db, { view: 'holder_tags', tag: 'tag_made_up' }), Error, 'invalid_contract_research_request')
  await assertRejects(() => read(db, { view: 'holder_tags', cursor: 'abc' }), Error, 'invalid_contract_research_request')
})

Deno.test('below Startup the view answers plan_below_startup without a call', async () => {
  const db = fakeDb({})
  const { request, calls } = fakeRequest()
  const result = await read(db, { view: 'holder_tags', refresh: true }, request)
  eq(result.state, 'unsupported')
  eq(result.reason, 'plan_below_startup')
  eq(result.holderTags, null)
  eq(result.capture, null)
  eq(calls.length, 0)
})

Deno.test('a retained read makes no provider call and reports what is stored', async () => {
  const captured = hour(Date.now() - 5 * HOUR)
  const db = fakeDb(STARTUP, {
    [HOLDER_TAG_TABLE]: [{ chain: 'eip155:8453', contract_address: ADDRESS, captured_at: captured, tag: 'tag_dev', holder_count: 2, balance: 10, ratio: 0.5, ratio_unit: 'unknown' }],
    [HOLDER_COHORT_TABLE]: [{ chain: 'eip155:8453', contract_address: ADDRESS, captured_at: captured, tag: 'tag_dev', wallet_address: evm(1), balance: 100, percent: 1, buy_volume_usd: 50, sell_volume_usd: 10, realized_pnl_usd: 40, funding_source: 'bridge', first_seen_at: null, last_seen_at: null }],
  })
  const { request, calls } = fakeRequest()
  const result = await read(db, { view: 'holder_tags' }, request)
  eq(calls.length, 0, 'navigation never spends a credit')
  eq(result.capture, null)
  eq(result.state, 'stale', 'a series whose newest row predates this hour is stale')
  eq(result.canonicalKey, CANONICAL)
  eq(result.holderTags.captures.length, 1)
  eq(result.holderTags.latest.tags[0], { tag: 'tag_dev', holderCount: 2, balance: 10, ratio: 0.5 })
  eq(result.holderCohort.capturedAt, captured)
  eq(result.holderCohort.tags[0].realized.inProfit, 1)
  eq(result.comparison, null)
  assert(result.coverage.includes('captured on OUR clock') || result.coverage.includes('Captured on OUR clock'))
  assert(result.coverage.includes('not a person'))
})

Deno.test('a contract with nothing stored is unavailable, not an error', async () => {
  const { request } = fakeRequest()
  const result = await read(fakeDb(STARTUP), { view: 'holder_tags' }, request)
  eq(result.state, 'unavailable')
  eq(result.holderTags.captures, [])
  eq(result.holderCohort.reason, 'no_capture')
})

Deno.test('a refresh captures the board and one page per populated tag, and retains the evidence', async () => {
  const db = fakeDb(STARTUP)
  const { request, calls } = fakeRequest()
  const result = await read(db, { view: 'holder_tags', refresh: true }, request)
  eq(calls, ['dexHolderTags', 'dexHolders'], 'the zero-count tag costs no call')
  eq(result.capture.credits, 2)
  eq(result.capture.cohortRows, 2)
  eq(result.state, 'fresh')
  eq(result.holderTags.captures.length, 1)
  eq(result.holderTags.latest.tags.map((t: any) => t.tag), ['tag_dev', 'tag_sniper'])
  eq(result.holderCohort.tags[0].tag, 'tag_dev')
  eq(result.holderCohort.tags[0].realized.inProfit, 1)
  eq(result.holderCohort.tags[0].realized.atLoss, 1)
  eq(result.holderCohort.tags[0].realized.histogram.length, 2)

  // The tag board also became retained evidence, stamped with OUR clock and labelled.
  const recorded = db.rpcs.find((r) => r.name === 'intel_record_market_observations')
  assert(recorded, 'holder_tag_count observations were recorded')
  const rows = recorded!.args.p_rows
  eq(rows.length, 2)
  eq([...new Set(rows.map((r: any) => r.metric))], ['holder_tag_count'])
  eq([...new Set(rows.map((r: any) => r.metadata.timeMeaning))], ['capture time, not provider time'])
  eq([...new Set(rows.map((r: any) => r.observedAt))].length, 1, 'one capture, one clock')
  eq(rows[0].observedAt, rows[0].recordedAt, 'the observation clock IS the fetch clock')
  eq(rows[0].unit, 'accounts')
  eq(rows[0].metadata.ratioUnit, 'unknown')
  assert(String(rows[0].metadata.population).includes('not people'))
  assert(rows[0].universe.endsWith(':tag:tag_dev') || rows[1].universe.endsWith(':tag:tag_dev'))

  // A second refresh inside the same hour is a skip, not a second set of credits.
  const again = await read(db, { view: 'holder_tags', refresh: true }, request)
  eq(again.capture.skipped, 'within_cadence')
  eq(again.capture.credits, 0)
  eq(calls.length, 2, 'no further provider call')
})

Deno.test('a cache-only read never captures, even when refresh is asked for', async () => {
  const db = fakeDb(STARTUP)
  const { request, calls } = fakeRequest()
  const result = await read(db, { view: 'holder_tags', refresh: true }, request, true)
  eq(calls.length, 0)
  eq(result.capture, null)
})

Deno.test('two stored captures compare, and a stamp we do not hold is a missing side', async () => {
  const older = hour(Date.now() - 30 * HOUR), newer = hour(Date.now() - HOUR)
  const row = (captured: string, tag: string, count: number, balance: number, ratio: number) =>
    ({ chain: 'eip155:8453', contract_address: ADDRESS, captured_at: captured, tag, holder_count: count, balance, ratio, ratio_unit: 'unknown' })
  const db = fakeDb(STARTUP, { [HOLDER_TAG_TABLE]: [
    row(older, 'tag_dev', 2, 10, 0.5), row(newer, 'tag_dev', 6, 4, 0.2),
  ] })
  const { request } = fakeRequest()
  const result = await read(db, { view: 'holder_tags', capturedAt: newer, compareWith: older }, request)
  eq(result.comparison.from, older)
  eq(result.comparison.to, newer)
  eq(result.comparison.tags[0].holderCountDelta, 4)
  eq(result.comparison.tags[0].balanceDelta, -6)
  eq(result.holderCohort.capturedAt, newer)

  const missing = await read(db, { view: 'holder_tags', compareWith: hour(Date.now() - 500 * HOUR) }, request)
  eq(missing.comparison.from, null)
  eq(missing.comparison.reason, 'one_side_missing')
  eq(missing.comparison.to, newer, 'with no capturedAt the newest capture is the other side')
})

Deno.test('an unverified contract identity is refused before any setting is read', async () => {
  const result = await read(fakeDb(STARTUP), { canonicalKey: 'eip155:999999:0x00', view: 'holder_tags' })
  eq(result.state, 'unsupported')
  eq(result.view, 'holder_tags')
})
