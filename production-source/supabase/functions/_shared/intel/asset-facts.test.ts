import { assert, assertEquals } from 'jsr:@std/assert@1'
import { deltas, deployments, listingActivity, listingAge, listingCohorts, median, noticeState, quarterCohort, supplyTrust } from './asset-facts.ts'
import { handleAssetFacts } from '../../intel-asset-facts/index.ts'

const NOW = Date.parse('2026-09-15T00:00:00Z')
const HASH = 'a'.repeat(64)
const day = (back: number) => new Date(NOW - back * 86_400_000).toISOString().slice(0, 10)

const row = (facts: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  source_provider: 'coinmarketcap', provider_id: '1027', symbol: 'ETH', name: 'Ethereum',
  circulating_supply: 120_000_000, total_supply: 120_000_000, max_supply: null, market_cap: 400_000_000_000,
  primary_chain: 'ethereum', platforms: {}, facts_at: '2026-09-14T06:00:00Z',
  facts: { notice: null, noticeHash: null, deployments: [], tagGroups: [], urls: null, factsAt: '2026-09-14T06:00:00Z', ...facts },
  ...extra,
})

// ---------------------------------------------------------------------- supply

Deno.test('supply trust names verified, self-reported, mixed and unknown without substituting one for the other', () => {
  const verified = supplyTrust(row())
  assertEquals(verified.trust, 'verified')
  assertEquals(verified.selfReportedCirculating, null)
  assertEquals(verified.selfReportedDiffersPct, null)
  assertEquals(verified.circulatingShareOfMax, null, 'no maximum supply means no share of it')
  assertEquals(verified.reason, null)

  const mixed = supplyTrust(row({ selfReportedCirculatingSupply: 132_000_000, selfReportedMarketCap: 1 }, { max_supply: 240_000_000 }))
  assertEquals(mixed.trust, 'mixed')
  assertEquals(mixed.circulatingShareOfMax, 0.5)
  assertEquals(Math.round(mixed.selfReportedDiffersPct! * 100) / 100, 10)

  const self = supplyTrust(row({ selfReportedCirculatingSupply: 5_000_000 }, { circulating_supply: null }))
  assertEquals(self.trust, 'self_reported')
  assertEquals(self.circulating, null, 'a self-reported supply is never promoted to the verified one')
  assertEquals(self.selfReportedDiffersPct, null)

  const unknown = supplyTrust(row({}, { circulating_supply: null, market_cap: null }))
  assertEquals(unknown.trust, 'unknown')
  assert(unknown.reason)
})

Deno.test('a valid zero supply stays a zero and is still verified', () => {
  const zero = supplyTrust(row({}, { circulating_supply: 0, max_supply: 100 }))
  assertEquals(zero.circulating, 0)
  assertEquals(zero.trust, 'verified')
  assertEquals(zero.circulatingShareOfMax, 0)
  assertEquals(zero.selfReportedDiffersPct, null, 'a zero verified supply has no percentage to differ by')
})

Deno.test('infinite supply is reported as recorded, never inferred from a missing maximum', () => {
  assertEquals(supplyTrust(row({ infiniteSupply: true })).infiniteSupply, true)
  assertEquals(supplyTrust(row({ infiniteSupply: false })).infiniteSupply, false)
  assertEquals(supplyTrust(row()).infiniteSupply, null)
})

// ------------------------------------------------------------------------- age

Deno.test('listing age reports whole days and the listing quarter', () => {
  const age = listingAge(row({ dateAdded: '2024-08-15T00:00:00Z', dateLaunched: '2024-07-30T00:00:00Z' }), NOW)
  assertEquals(age.ageDays, 761)
  assertEquals(age.cohort, '2024Q3')
  assertEquals(age.dateLaunched, '2024-07-30T00:00:00Z')
  assertEquals(age.reason, null)
})

Deno.test('quarter cohorts follow UTC calendar quarters', () => {
  assertEquals(quarterCohort(Date.parse('2026-01-01T00:00:00Z')), '2026Q1')
  assertEquals(quarterCohort(Date.parse('2026-03-31T23:59:59Z')), '2026Q1')
  assertEquals(quarterCohort(Date.parse('2026-04-01T00:00:00Z')), '2026Q2')
  assertEquals(quarterCohort(Date.parse('2026-12-31T00:00:00Z')), '2026Q4')
})

Deno.test('a missing or future listing date asserts no age and carries a reason', () => {
  const missing = listingAge(row(), NOW)
  assertEquals(missing, { dateAdded: null, dateLaunched: null, ageDays: null, cohort: null, reason: 'No provider listing date is recorded for this asset.' })
  const future = listingAge(row({ dateAdded: '2027-01-02T00:00:00Z' }), NOW)
  assertEquals(future.ageDays, null)
  assertEquals(future.cohort, '2027Q1')
  assert(future.reason)
})

// ----------------------------------------------------------------- deployments

Deno.test('deployments keep every chain and flag only the primary the catalogue names', () => {
  const list = deployments(row({
    deployments: [
      { platformSlug: 'ethereum', platformName: 'Ethereum', chain: 'ethereum', address: '0x' + '1'.repeat(40) },
      { platformSlug: 'binance-coin', platformName: 'BNB Smart Chain (BEP20)', chain: 'bnb', address: '0x' + '2'.repeat(40) },
      { platformSlug: 'some-new-l2', platformName: 'Some New L2', chain: null, address: '0x' + '3'.repeat(40) },
    ],
  }))
  assertEquals(list.length, 3)
  assertEquals(list.map((d) => d.chain), ['ethereum', 'bnb', null])
  assertEquals(list.map((d) => d.primary), [true, false, false], 'primary_chain names exactly one deployment')
  assertEquals(list[2].platformName, 'Some New L2', 'an unmapped platform keeps its reported name with a null chain')
})

Deno.test('an ambiguous primary leaves every deployment unflagged and a single one is primary', () => {
  const ambiguous = deployments(row({
    deployments: [
      { platformSlug: 'a', platformName: 'A', chain: 'solana', address: 'So11111111111111111111111111111111111111112' },
      { platformSlug: 'b', platformName: 'B', chain: 'aptos', address: '0x1' },
    ],
  }, { primary_chain: null, platforms: {} }))
  assertEquals(ambiguous.filter((d) => d.primary).length, 0)
  const single = deployments(row({ deployments: [{ platformSlug: 'x', platformName: 'X', chain: null, address: '0xabc' }] }, { primary_chain: null }))
  assertEquals(single.map((d) => d.primary), [true])
  assertEquals(deployments(row()), [])
  assertEquals(deployments({}), [], 'a row with no facts document is not an error')
})

// ---------------------------------------------------------------------- notice

Deno.test('notice state reports presence, the hash and the metadata clock', () => {
  const none = noticeState(row())
  assertEquals(none, { present: false, hash: null, text: null, factsAt: '2026-09-14T06:00:00Z' })
  const present = noticeState(row({ notice: '  Trading is temporarily suspended.  ', noticeHash: HASH }))
  assertEquals(present.present, true)
  assertEquals(present.text, 'Trading is temporarily suspended.')
  assertEquals(present.hash, HASH)
  assertEquals(noticeState(row({ notice: 'x', noticeHash: 'not-a-hash' })).hash, null, 'a malformed hash is not reported as one')
  assertEquals(noticeState(row({ notice: '   ' })).present, false, 'whitespace is not a notice')
})

// ---------------------------------------------------------------------- deltas

Deno.test('deltas pass the SQL function bounded parameters and map its rows', async () => {
  const calls: unknown[] = []
  const db = { rpc: (name: string, params: unknown) => { calls.push([name, params]); return Promise.resolve({ data: [
    { snapshot_date: '2026-09-13', num_market_pairs: 100, pairs_delta: null, circulating_supply: 10, supply_delta: null, market_cap: 5, rank: 2 },
    { snapshot_date: '2026-09-14', num_market_pairs: 104, pairs_delta: 4, circulating_supply: 10, supply_delta: 0, market_cap: 6, rank: 1 },
  ], error: null }) } }
  const result = await deltas(db, 'coinmarketcap', '1027', 9999)
  assertEquals(calls, [['intel_market_asset_facts_deltas', { p_provider: 'coinmarketcap', p_provider_id: '1027', p_days: 400 }]])
  assertEquals(result.rows.map((r) => r.pairsDelta), [null, 4])
  assertEquals(result.rows[1].supplyDelta, 0, 'an unchanged supply is a zero delta, not a missing one')
  assertEquals(result.unavailable, false)
  assertEquals(result.reason, null)
})

Deno.test('an empty history is a truthful empty result and a failed read says so', async () => {
  const empty = await deltas({ rpc: () => Promise.resolve({ data: [], error: null }) }, 'coinmarketcap', '1', 30)
  assertEquals(empty.rows, [])
  assertEquals(empty.unavailable, false)
  assert(empty.reason)
  const failed = await deltas({ rpc: () => Promise.resolve({ data: null, error: { message: 'down' } }) }, 'coinmarketcap', '1', 30)
  assertEquals(failed.unavailable, true)
  assert(failed.reason)
})

// --------------------------------------------------------------------- medians

Deno.test('median ignores missing values and averages an even count', () => {
  assertEquals(median([3, 1, 2]), 2)
  assertEquals(median([4, null, 2]), 3)
  assertEquals(median([]), null)
  assertEquals(median([null, null]), null)
  assertEquals(median([0, 0]), 0)
})

// --------------------------------------------------------------------- cohorts

function historyDb(assets: unknown[], history: Record<string, unknown>[], failures: Record<string, boolean> = {}) {
  const query = (table: string) => {
    const state: Record<string, string> = {}
    const q: Record<string, unknown> = {}
    const chain = () => q
    for (const method of ['select', 'eq', 'order', 'gte', 'lte', 'not']) {
      q[method] = (a: string, b: string) => { if (method === 'gte' || method === 'lte') state[method] = b; return chain() }
    }
    q.limit = () => {
      if (table === 'market_assets') return Promise.resolve(failures.assets ? { error: { message: 'down' } } : { data: assets, error: null })
      if (failures.history) return Promise.resolve({ error: { message: 'down' } })
      const rows = history.filter((r) => (!state.gte || String(r.snapshot_date) >= state.gte) && (!state.lte || String(r.snapshot_date) <= state.lte))
      return Promise.resolve({ data: rows, error: null })
    }
    return q
  }
  return { from: query, rpc: () => Promise.resolve({ data: [], error: null }) }
}

const cohortAsset = (id: string, added: string, cap: number, extra = {}) => ({ provider_id: id, market_cap: cap, market_cap_rank: Number(id), in_current_catalog: true, facts: { dateAdded: added }, ...extra })

Deno.test('cohorts group the catalogue by listing quarter with a captured 30-day change', async () => {
  const assets = [
    cohortAsset('1', '2024-02-01T00:00:00Z', 100),
    cohortAsset('2', '2024-03-05T00:00:00Z', 300),
    cohortAsset('3', '2026-07-05T00:00:00Z', 50),
    { provider_id: '4', market_cap: 10, market_cap_rank: 4, in_current_catalog: true, facts: {} },
    { provider_id: '9', market_cap: 999, market_cap_rank: 9, in_current_catalog: false, facts: { dateAdded: '2024-02-01T00:00:00Z' } },
  ]
  const history = [
    { provider_id: '1', snapshot_date: day(30), price: 100 }, { provider_id: '1', snapshot_date: day(1), price: 120 },
    { provider_id: '2', snapshot_date: day(29), price: 50 }, { provider_id: '2', snapshot_date: day(0), price: 25 },
    { provider_id: '3', snapshot_date: day(1), price: 7 },
  ]
  const result = await listingCohorts(historyDb(assets, history), 'coinmarketcap', NOW)
  assertEquals(result.assets, 4, 'rows outside the current catalogue are not counted')
  assertEquals(result.cohorts.map((c) => c.cohort), ['2026Q3', '2024Q1', null])
  const q1 = result.cohorts.find((c) => c.cohort === '2024Q1')!
  assertEquals(q1.count, 2)
  assertEquals(q1.assetsWithChange, 2)
  assertEquals(q1.medianChange30dPct, -15, 'median of +20% and -50%')
  assertEquals(q1.medianMarketCap, 200)
  const q3 = result.cohorts.find((c) => c.cohort === '2026Q3')!
  assertEquals(q3.medianChange30dPct, null, 'one captured price is not a 30-day change')
  assertEquals(q3.assetsWithChange, 0)
  assertEquals(result.cohorts.find((c) => c.cohort === null)!.count, 1, 'assets with no listing date get their own bucket')
})

Deno.test('a failed history read keeps the cohort counts and drops only the change', async () => {
  const result = await listingCohorts(historyDb([cohortAsset('1', '2024-02-01T00:00:00Z', 100)], [], { history: true }), 'coinmarketcap', NOW)
  assertEquals(result.cohorts[0].count, 1)
  assertEquals(result.cohorts[0].medianChange30dPct, null)
  assert(result.reason)
  const failed = await listingCohorts(historyDb([], [], { assets: true }), 'coinmarketcap', NOW)
  assertEquals(failed.unavailable, true)
})

// ------------------------------------------------------------ listing activity

Deno.test('listing activity counts assets whose pair count rose or fell against the previous captured day', async () => {
  const history = [
    { provider_id: '1', snapshot_date: day(2), num_market_pairs: 100 },
    { provider_id: '1', snapshot_date: day(1), num_market_pairs: 104 },
    { provider_id: '2', snapshot_date: day(2), num_market_pairs: 50 },
    { provider_id: '2', snapshot_date: day(1), num_market_pairs: 40 },
    { provider_id: '3', snapshot_date: day(2), num_market_pairs: 7 },
    { provider_id: '3', snapshot_date: day(1), num_market_pairs: 7 },
    { provider_id: '4', snapshot_date: day(1), num_market_pairs: 9 },
  ]
  const result = await listingActivity(historyDb([], history), 'coinmarketcap', 90, NOW)
  assertEquals(result.window, 30, 'the window is clamped to 30 days')
  assertEquals(result.days.length, 1)
  assertEquals(result.days[0], { date: day(1), rose: 1, fell: 1, unchanged: 1, assets: 3 })
  assertEquals(result.truncated, false)
  assertEquals(result.unavailable, false)
})

Deno.test('listing activity reports an unreadable or empty history instead of an empty day list', async () => {
  const failed = await listingActivity(historyDb([], [], { history: true }), 'coinmarketcap', 30, NOW)
  assertEquals(failed.unavailable, true)
  assert(failed.reason)
  const empty = await listingActivity(historyDb([], []), 'coinmarketcap', 30, NOW)
  assertEquals(empty.days, [])
  assertEquals(empty.unavailable, false)
  assert(empty.reason)
})

// -------------------------------------------------------------- handler shape

function handlerFixture({ member = true, allowed = true, valid = true, asset = row() as unknown }: Record<string, unknown> = {}) {
  const rpcs: string[] = []
  const db = {
    auth: { getUser: () => Promise.resolve({ data: { user: valid ? { id: 'verified-user' } : null }, error: null }) },
    from: (table: string) => {
      const q: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'order', 'gte', 'lte']) q[m] = () => q
      q.limit = () => Promise.resolve({ data: table === 'market_assets' ? [asset] : [], error: null })
      q.maybeSingle = () => Promise.resolve({ data: table === 'org_members' && member ? { org_id: 'org' } : table === 'market_assets' ? asset : null, error: null })
      return q
    },
    rpc: (name: string) => { rpcs.push(name); return Promise.resolve({ data: name === 'can_access_intel' ? allowed : [], error: null }) },
  }
  return { factory: () => db, rpcs: () => rpcs }
}
const env = async (fn: () => Promise<void>) => {
  const keys = { SUPABASE_URL: 'https://fixture.test', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service' }
  const before = Object.fromEntries(Object.keys(keys).map((k) => [k, Deno.env.get(k)]))
  try { for (const [k, v] of Object.entries(keys)) Deno.env.set(k, v); await fn() }
  finally { for (const [k, v] of Object.entries(before)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v) }
}
const post = (body: unknown, header: string | null = 'Bearer fixture') =>
  new Request('https://fixture.test/intel-asset-facts', { method: 'POST', headers: header ? { Authorization: header, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

Deno.test('asset facts returns supply, age, deployments, notice and deltas for a member', () => env(async () => {
  const f = handlerFixture({ asset: row({ dateAdded: '2024-08-15T00:00:00Z', notice: 'Suspended.', noticeHash: HASH, deployments: [{ platformSlug: 'ethereum', platformName: 'Ethereum', chain: 'ethereum', address: '0x' + '1'.repeat(40) }] }) })
  const res = await handleAssetFacts(post({ orgId: 'org', op: 'asset', sourceProvider: 'coinmarketcap', providerId: '1027' }), f.factory as never)
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(Object.keys(body).sort(), ['age', 'asset', 'attribution', 'deltas', 'deployments', 'factsAt', 'notice', 'supply'])
  assertEquals(body.supply.trust, 'verified')
  assertEquals(body.age.cohort, '2024Q3')
  assertEquals(body.notice.present, true)
  assertEquals(body.deployments[0].primary, true)
  assertEquals(body.factsAt, '2026-09-14T06:00:00Z')
  assert(f.rpcs().includes('intel_market_asset_facts_deltas'))
}))

Deno.test('asset facts rejects unauthenticated, non-member and unentitled callers before any read', () => env(async () => {
  assertEquals((await handleAssetFacts(post({ orgId: 'org' }, null), handlerFixture().factory as never)).status, 401)
  for (const [config, status] of [[{ valid: false }, 401], [{ member: false }, 403], [{ allowed: false }, 403]] as const) {
    const f = handlerFixture(config)
    const res = await handleAssetFacts(post({ orgId: 'org', op: 'asset', providerId: '1027' }), f.factory as never)
    assertEquals(res.status, status)
    assertEquals(f.rpcs().includes('intel_market_asset_facts_deltas'), false)
  }
}))

Deno.test('asset facts validates the operation, provider, identifier and window', () => env(async () => {
  const f = handlerFixture()
  for (const [body, error] of [
    [{ orgId: 'org', op: 'nope' }, 'invalid_op'],
    [{ orgId: 'org', op: 'asset', sourceProvider: 'made-up', providerId: '1' }, 'invalid_provider'],
    [{ orgId: 'org', op: 'asset', providerId: 'drop table' }, 'invalid_provider_id'],
    [{ orgId: 'org', op: 'asset', providerId: '1', days: 0 }, 'invalid_days'],
    [{ orgId: 'org', op: 'asset', providerId: '1', days: 4000 }, 'invalid_days'],
  ] as const) {
    const res = await handleAssetFacts(post(body), f.factory as never)
    assertEquals(res.status, 400)
    assertEquals((await res.json()).error, error)
  }
  const missing = await handleAssetFacts(post({ orgId: 'org', op: 'asset', providerId: '999' }), handlerFixture({ asset: null }).factory as never)
  assertEquals(missing.status, 404)
}))

Deno.test('cohorts and listing activity answer with their own shapes and never call a provider', () => env(async () => {
  const f = handlerFixture()
  const cohorts = await (await handleAssetFacts(post({ orgId: 'org', op: 'cohorts', provider: 'coinmarketcap' }), f.factory as never)).json()
  assertEquals(Object.keys(cohorts).sort(), ['assets', 'cohorts', 'reason', 'unavailable'])
  const activity = await (await handleAssetFacts(post({ orgId: 'org', op: 'listing_activity', days: 7 }), f.factory as never)).json()
  assertEquals(Object.keys(activity).sort(), ['days', 'reason', 'truncated', 'unavailable', 'window'])
  assertEquals(activity.window, 7)
  assertEquals(f.rpcs().filter((r) => r !== 'can_access_intel'), [], 'cohort and activity reads use tables only')
}))

Deno.test('asset facts preflight is bounded and carries no data', () => env(async () => {
  const res = await handleAssetFacts(new Request('https://fixture.test/intel-asset-facts', { method: 'OPTIONS' }), handlerFixture().factory as never)
  assertEquals(res.status, 200)
  assertEquals(await res.text(), 'ok')
  assertEquals(res.headers.get('Access-Control-Max-Age'), '600')
}))
