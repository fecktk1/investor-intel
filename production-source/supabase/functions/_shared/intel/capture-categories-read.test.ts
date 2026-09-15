import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  readCategories, readCategoryDisagreement, readAirdrops, readNetworkStats,
  normaliseCategory, airdropLane, samplePoints, CATEGORY_CAPTURE_VIEWS, CATEGORY_VIEWS, NORMALISER_VERSION,
} from './capture-categories-read.ts'

const NOW = new Date(Math.floor((Date.now() - 7 * 86_400_000) / 3_600_000) * 3_600_000)
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()
const dayOf = (d: number) => daysAgo(d).slice(0, 10)

/** Minimal PostgREST-shaped fake; every read chain ends in `.limit()`. */
// deno-lint-ignore no-explicit-any
function fakeDb(tables: Record<string, any[]> = {}, errors: Record<string, string> = {}) {
  const compare = (a: unknown, b: unknown) => {
    const [x, y] = [Number(a), Number(b)]
    return Number.isFinite(x) && Number.isFinite(y) ? x - y : String(a ?? '').localeCompare(String(b ?? ''))
  }
  return {
    from(table: string) {
      // deno-lint-ignore no-explicit-any
      const filters: [string, string, any][] = []
      let ordering: { column: string; ascending: boolean; nullsFirst: boolean } | null = null
      const run = (max: number) => {
        if (errors[table]) return { data: null, error: { message: errors[table] } }
        let rows = [...(tables[table] || [])]
        for (const [key, op, operand] of filters) {
          rows = rows.filter((row) => {
            const v = row?.[key]
            if (op === 'eq') return String(v ?? '') === String(operand ?? '')
            if (op === 'gte') return compare(v, operand) >= 0
            if (op === 'lte') return compare(v, operand) <= 0
            // deno-lint-ignore no-explicit-any
            if (op === 'in') return (operand as any[]).some((o) => String(o) === String(v))
            return true
          })
        }
        if (ordering) {
          const o = ordering
          rows.sort((a, b) => {
            const [x, y] = [a?.[o.column], b?.[o.column]]
            if (x == null && y == null) return 0
            if (x == null) return o.nullsFirst ? -1 : 1
            if (y == null) return o.nullsFirst ? 1 : -1
            return compare(x, y) * (o.ascending ? 1 : -1)
          })
        }
        return { data: rows.slice(0, max), error: null }
      }
      // deno-lint-ignore no-explicit-any
      const q: any = {
        select: () => q,
        // deno-lint-ignore no-explicit-any
        eq: (k: string, v: any) => { filters.push([k, 'eq', v]); return q },
        // deno-lint-ignore no-explicit-any
        gte: (k: string, v: any) => { filters.push([k, 'gte', v]); return q },
        // deno-lint-ignore no-explicit-any
        lte: (k: string, v: any) => { filters.push([k, 'lte', v]); return q },
        // deno-lint-ignore no-explicit-any
        in: (k: string, v: any[]) => { filters.push([k, 'in', v]); return q },
        // deno-lint-ignore no-explicit-any
        order: (column: string, options: any = {}) => {
          ordering = { column, ascending: options?.ascending !== false, nullsFirst: options?.nullsFirst === true }
          return q
        },
        limit: (max: number) => Promise.resolve(run(max)),
      }
      return q
    },
  }
}

// ─── categories ───────────────────────────────────────────────────────────────

const categorySnapshots = () => {
  // deno-lint-ignore no-explicit-any
  const rows: any[] = []
  for (let h = 0; h < 40; h++) {
    for (const [i, id] of ['defi', 'layer-1', 'memes'].entries()) {
      rows.push({
        provider: 'coinmarketcap', category_id: id, captured_at: hoursAgo(h),
        name: id === 'defi' ? 'DeFi' : id === 'layer-1' ? 'Layer 1' : 'Memes', title: `T-${id}`,
        num_tokens: 100 + i, avg_price_change: -2 + i, market_cap: (3 - i) * 1e11 - h * 1e8,
        market_cap_change: 1.5 - i, volume: (3 - i) * 1e9, volume_change: -0.5, observed_at: hoursAgo(h),
      })
    }
  }
  return rows
}

Deno.test('categories read returns the newest board by market cap with a bounded series per category', async () => {
  const result = await readCategories(fakeDb({ intel_category_snapshots: categorySnapshots() }), { days: 7 }, NOW.getTime())
  eq(result.view, 'categories')
  eq(result.days, 7)
  eq(result.top, 30)
  eq(result.asOf, hoursAgo(0))
  // deno-lint-ignore no-explicit-any
  const rows = result.rows as any[]
  eq(rows.map((r) => r.categoryId), ['defi', 'layer-1', 'memes'], 'largest first')
  eq(rows[0].name, 'DeFi')
  eq(rows[0].marketCapChange24hPct, 1.5)
  eq(rows[0].avgPriceChange24hPct, -2)
  eq(rows[0].numTokens, 100)
  // deno-lint-ignore no-explicit-any
  const series = result.series as any[]
  eq(series.length, 3)
  eq(series[0].categoryId, 'defi')
  eq(series[0].points.length, 40, 'one point per hourly capture inside the window')
  eq(series[0].points[0].capturedAt, hoursAgo(39), 'the series is chronological')
  eq(series[0].points.at(-1).capturedAt, hoursAgo(0))
  eq(result.coverage.count, 120)
  eq(result.coverage.truncated, false)
})

Deno.test('categories read clamps days to 1, 7 or 30 and caps the top list', async () => {
  const db = fakeDb({ intel_category_snapshots: categorySnapshots() })
  eq((await readCategories(db, { days: 90 }, NOW.getTime())).days, 30, 'an unsupported window falls back to 30 days')
  eq((await readCategories(db, {}, NOW.getTime())).days, 30)
  eq((await readCategories(db, { days: 1 }, NOW.getTime())).days, 1)
  const oneDay = await readCategories(db, { days: 1, top: 2 }, NOW.getTime())
  eq(oneDay.top, 2)
  // deno-lint-ignore no-explicit-any
  eq((oneDay.rows as any[]).length, 2)
  // deno-lint-ignore no-explicit-any
  eq((oneDay.series as any[])[0].points.length, 25, 'a one-day window is 24 hours of captures plus the boundary')
  eq((await readCategories(db, { top: 999 }, NOW.getTime())).top, 60, 'the top list is capped')
})

Deno.test('categories read samples a long series down to at most 200 points and keeps both ends', async () => {
  // deno-lint-ignore no-explicit-any
  const rows: any[] = []
  for (let h = 0; h < 720; h++) rows.push({ category_id: 'defi', name: 'DeFi', captured_at: hoursAgo(h), market_cap: 1e11 - h })
  const result = await readCategories(fakeDb({ intel_category_snapshots: rows }), { days: 30 }, NOW.getTime())
  // deno-lint-ignore no-explicit-any
  const points = (result.series as any[])[0].points
  eq(points.length, 200)
  eq(points[0].capturedAt, hoursAgo(719))
  eq(points.at(-1).capturedAt, hoursAgo(0))
  eq(samplePoints([1, 2, 3], 200), [1, 2, 3])
})

Deno.test('categories read on an empty table is an empty series, never a fabricated point', async () => {
  const result = await readCategories(fakeDb(), { days: 7 }, NOW.getTime())
  eq(result.rows, [])
  eq(result.series, [])
  eq(result.asOf, null)
  eq(result.coverage, { from: null, to: null, count: 0 })
  eq(result.reason, null)
})

Deno.test('categories read reports a failed read as a reason instead of a short series', async () => {
  const result = await readCategories(fakeDb({}, { intel_category_snapshots: 'permission denied' }), {}, NOW.getTime())
  eq(result.asOf, null)
  eq(result.rows, [])
  eq(result.reason, 'permission denied')
})

// ─── category_disagreement ────────────────────────────────────────────────────

Deno.test('the normaliser folds spelling, punctuation and the alias list onto one key', () => {
  eq(normaliseCategory('DeFi'), 'defi')
  eq(normaliseCategory('Decentralized Finance (DeFi)'), 'defi')
  eq(normaliseCategory('decentralized-finance-defi'), 'defi')
  eq(normaliseCategory('Layer 1'), 'layer1')
  eq(normaliseCategory('layer-1'), 'layer1')
  eq(normaliseCategory('L1'), 'layer1')
  eq(normaliseCategory('Smart Contract Platform'), 'layer1')
  eq(normaliseCategory('Layer 2'), 'layer2')
  eq(normaliseCategory('NFTs'), 'nft')
  eq(normaliseCategory('Non-Fungible Tokens (NFT)'), 'nft')
  eq(normaliseCategory('Meme Token'), 'memes')
  eq(normaliseCategory('AI & Big Data'), 'ai')
  eq(normaliseCategory('Gaming'), 'gaming', 'an unaliased name is just its normalised form')
  eq(normaliseCategory(''), null)
  eq(normaliseCategory(null), null)
  eq(normaliseCategory('  ---  '), null)
})

const members = (categoryId: string, ids: string[]) => ids.map((id, i) => ({ category_id: categoryId, snapshot_date: dayOf(0), provider_id: id, symbol: `S${id}`, cmc_rank: i + 1 }))

Deno.test('category disagreement counts agreement, conflict and unknown separately', async () => {
  const db = fakeDb({
    intel_category_members: [
      ...members('defi', ['1', '2', '3', '4', '5', '6']),
      ...members('memes', ['7', '8', '9', '10', '11']),
      ...members('tiny', ['12', '13']),
      // An older day must not be mixed into the newest membership snapshot.
      { category_id: 'defi', snapshot_date: dayOf(9), provider_id: '99', symbol: 'OLD' },
    ],
    intel_category_snapshots: [
      { category_id: 'defi', name: 'DeFi', captured_at: hoursAgo(0) },
      { category_id: 'memes', name: 'Meme Token', captured_at: hoursAgo(0) },
      { category_id: 'tiny', name: 'Tiny', captured_at: hoursAgo(0) },
    ],
    market_assets: [
      { source_provider: 'coinmarketcap', provider_id: '1', categories: ['Decentralized Finance (DeFi)', 'Yield Farming'] },
      { source_provider: 'coinmarketcap', provider_id: '2', categories: ['defi'] },
      { source_provider: 'coinmarketcap', provider_id: '3', categories: ['Gaming'] },
      { source_provider: 'coinmarketcap', provider_id: '4', categories: [] },                     // a row with no labels is unknown
      { source_provider: 'coinmarketcap', provider_id: '6', categories: ['Layer 1'] },
      // provider 5 has no catalogue row at all — also unknown
      { source_provider: 'coinmarketcap', provider_id: '7', categories: ['Memes'] },
      { source_provider: 'coinmarketcap', provider_id: '8', categories: ['Meme Token'] },
      { source_provider: 'coinmarketcap', provider_id: '9', categories: ['Memes'] },
      { source_provider: 'coinmarketcap', provider_id: '10', categories: ['Memes'] },
      { source_provider: 'coinmarketcap', provider_id: '11', categories: ['Memes'] },
    ],
  })
  const result = await readCategoryDisagreement(db, {}, NOW.getTime())
  eq(result.view, 'category_disagreement')
  eq(result.normaliser, NORMALISER_VERSION)
  eq(result.asOf, dayOf(0))
  eq(result.minMembers, 5)
  // deno-lint-ignore no-explicit-any
  const rows = result.rows as any[]
  eq(rows.length, 2, 'a category below the member floor is not reported')
  eq(rows.map((r) => r.categoryId), ['defi', 'memes'], 'the least agreement first')
  eq(rows[0], { categoryId: 'defi', name: 'DeFi', members: 6, agreeing: 2, disagreeing: 2, unknown: 2, share: 0.5 })
  eq(rows[1], { categoryId: 'memes', name: 'Meme Token', members: 5, agreeing: 5, disagreeing: 0, unknown: 0, share: 1 })
  eq(result.coverage.count, 13, 'every member of the newest snapshot date was read, and only that date')
})

Deno.test('category disagreement never invents agreement when no catalogue row carries a label', async () => {
  const result = await readCategoryDisagreement(fakeDb({
    intel_category_members: members('defi', ['1', '2', '3', '4', '5']),
    intel_category_snapshots: [{ category_id: 'defi', name: 'DeFi', captured_at: hoursAgo(0) }],
    market_assets: [{ source_provider: 'coinmarketcap', provider_id: '1', categories: null }, { source_provider: 'coinmarketcap', provider_id: '2', categories: [] }],
  }), {}, NOW.getTime())
  // deno-lint-ignore no-explicit-any
  const row = (result.rows as any[])[0]
  eq(row.agreeing, 0)
  eq(row.disagreeing, 0)
  eq(row.unknown, 5)
  eq(row.share, null, 'nothing could be compared, so there is no share to report')
})

Deno.test('category disagreement honours a raised member floor and an empty table', async () => {
  const db = fakeDb({
    intel_category_members: members('defi', ['1', '2', '3', '4', '5']),
    intel_category_snapshots: [{ category_id: 'defi', name: 'DeFi', captured_at: hoursAgo(0) }],
    market_assets: [{ source_provider: 'coinmarketcap', provider_id: '1', categories: ['DeFi'] }],
  })
  // deno-lint-ignore no-explicit-any
  eq(((await readCategoryDisagreement(db, { minMembers: 6 }, NOW.getTime())).rows as any[]).length, 0)
  // deno-lint-ignore no-explicit-any
  eq(((await readCategoryDisagreement(db, { minMembers: 5 }, NOW.getTime())).rows as any[]).length, 1)

  const empty = await readCategoryDisagreement(fakeDb(), {}, NOW.getTime())
  eq(empty.rows, [])
  eq(empty.asOf, null)
  eq(empty.normaliser, NORMALISER_VERSION)
  eq(empty.coverage, { from: null, to: null, count: 0 })
})

Deno.test('category disagreement reports a failed catalogue read as a reason', async () => {
  const result = await readCategoryDisagreement(fakeDb({
    intel_category_members: members('defi', ['1', '2', '3', '4', '5']),
    intel_category_snapshots: [{ category_id: 'defi', name: 'DeFi', captured_at: hoursAgo(0) }],
  }, { market_assets: 'catalogue offline' }), {}, NOW.getTime())
  eq(result.reason, 'catalogue offline')
  // deno-lint-ignore no-explicit-any
  eq((result.rows as any[])[0].unknown, 5, 'an unreadable catalogue is unknown, never disagreement')
})

// ─── airdrops ─────────────────────────────────────────────────────────────────

Deno.test('the airdrop lane is read from the reported dates, and from the status only when there are none', () => {
  const now = NOW.getTime()
  eq(airdropLane(now - 86_400_000, now - 3_600_000, 'ONGOING', now), 'past', 'an end date in the past wins over the status')
  eq(airdropLane(now + 86_400_000, now + 2 * 86_400_000, 'ONGOING', now), 'upcoming')
  eq(airdropLane(now - 86_400_000, now + 86_400_000, 'ONGOING', now), 'live')
  eq(airdropLane(now - 86_400_000, null, null, now), 'live')
  eq(airdropLane(null, null, 'UPCOMING', now), 'upcoming')
  eq(airdropLane(null, null, 'ongoing', now), 'live')
  eq(airdropLane(null, null, 'mystery', now), null, 'an unrecognised status is not a guess')
  eq(airdropLane(null, null, null, now), null)
})

const airdrops = () => [
  { airdrop_id: 'a1', project_name: 'Live One', provider_id: '1', symbol: 'BTC', status: 'ONGOING', start_date: daysAgo(3), end_date: daysAgo(-4), total_prize: 5000, winner_count: 100, link: 'https://x.test/a1', last_seen_at: hoursAgo(1) },
  { airdrop_id: 'a2', project_name: 'Soon', provider_id: '1027', symbol: 'ETH', status: 'UPCOMING', start_date: daysAgo(-10), end_date: daysAgo(-20), total_prize: 900, last_seen_at: hoursAgo(2) },
  { airdrop_id: 'a3', project_name: 'Done', provider_id: '2', symbol: 'LTC', status: 'ENDED', start_date: daysAgo(30), end_date: daysAgo(20), last_seen_at: hoursAgo(3) },
  { airdrop_id: 'a4', project_name: 'Ancient', provider_id: '3', symbol: 'XRP', status: 'ENDED', start_date: daysAgo(300), end_date: daysAgo(290), last_seen_at: hoursAgo(4) },
  { airdrop_id: 'a5', project_name: 'Undated', provider_id: '4', symbol: 'SOL', status: 'ONGOING', start_date: null, end_date: null, last_seen_at: hoursAgo(5) },
]

Deno.test('airdrops read lanes every row, orders by start date and marks the ones held', async () => {
  const result = await readAirdrops(fakeDb({ intel_airdrop_snapshots: airdrops() }), { status: 'all', providerIds: ['1027', '4'] }, NOW.getTime())
  eq(result.view, 'airdrops')
  eq(result.status, 'all')
  eq(result.days, 90)
  // deno-lint-ignore no-explicit-any
  const rows = result.rows as any[]
  eq(rows.map((r) => r.airdropId), ['a3', 'a1', 'a2', 'a5'], 'oldest start first, undated last; the 300-day row is outside the window')
  eq(rows.map((r) => r.lane), ['past', 'live', 'upcoming', 'live'])
  eq(rows.find((r) => r.airdropId === 'a2').held, true)
  eq(rows.find((r) => r.airdropId === 'a5').held, true)
  eq(rows.find((r) => r.airdropId === 'a1').held, undefined, 'an asset that is not held carries no flag at all')
  eq(rows[1].projectName, 'Live One')
  eq(rows[1].totalPrize, 5000)
  eq(rows[1].link, 'https://x.test/a1')
  eq(result.lanes, { past: 1, live: 2, upcoming: 1 })
  eq(result.recorded, { total: 5, outsideWindow: 1, newestEndDate: daysAgo(-20) }, 'the whole list is counted so an empty window can still say what was recorded')
  eq(result.asOf, hoursAgo(1))
  eq(result.coverage.count, 5)
})

Deno.test('airdrops read filters to one lane on request and keeps upcoming rows outside the window', async () => {
  const db = fakeDb({ intel_airdrop_snapshots: airdrops() })
  // deno-lint-ignore no-explicit-any
  eq(((await readAirdrops(db, { status: 'ongoing' }, NOW.getTime())).rows as any[]).map((r) => r.airdropId), ['a1', 'a5'])
  // deno-lint-ignore no-explicit-any
  eq(((await readAirdrops(db, { status: 'upcoming' }, NOW.getTime())).rows as any[]).map((r) => r.airdropId), ['a2'])
  const narrow = await readAirdrops(db, { status: 'all', days: 5 }, NOW.getTime())
  // deno-lint-ignore no-explicit-any
  eq((narrow.rows as any[]).map((r) => r.airdropId), ['a1', 'a2', 'a5'], 'a 5-day window drops the finished 30-day row but never an upcoming one')
  eq((await readAirdrops(db, { status: 'sideways' }, NOW.getTime())).status, 'all', 'an unknown status is the whole calendar')
  eq((await readAirdrops(db, { days: 9999 }, NOW.getTime())).days, 365, 'the window is capped')
})

Deno.test('airdrops read on an empty table is an empty calendar with no as-of', async () => {
  const result = await readAirdrops(fakeDb(), {}, NOW.getTime())
  eq(result.rows, [])
  eq(result.lanes, { past: 0, live: 0, upcoming: 0 })
  eq(result.recorded, { total: 0, outsideWindow: 0, newestEndDate: null })
  eq(result.asOf, null)
  eq(result.coverage, { from: null, to: null, count: 0, truncated: false })
  eq(result.reason, null)

  const broken = await readAirdrops(fakeDb({}, { intel_airdrop_snapshots: 'denied' }), {}, NOW.getTime())
  eq(broken.reason, 'denied')
  eq(broken.rows, [])
})

// ─── network_stats ────────────────────────────────────────────────────────────

Deno.test('network stats read keeps the newest row per chain', async () => {
  const result = await readNetworkStats(fakeDb({
    intel_network_stats_snapshots: [
      { source_provider: 'coinmarketcap', provider_id: '1', captured_at: hoursAgo(0), symbol: 'BTC', hashrate_24h: 6.1e20, difficulty: 8.9e13, tps_24h: 6.5, pending_transactions: 1200, total_blocks: 860000, total_transactions: 1.1e9, block_reward_static: 3.125 },
      { source_provider: 'coinmarketcap', provider_id: '1', captured_at: hoursAgo(1), symbol: 'BTC', hashrate_24h: 5.9e20 },
      { source_provider: 'coinmarketcap', provider_id: '1027', captured_at: hoursAgo(0), symbol: 'ETH', hashrate_24h: null, tps_24h: 14.2 },
    ],
  }), {}, NOW.getTime())
  eq(result.view, 'network_stats')
  // deno-lint-ignore no-explicit-any
  const rows = result.rows as any[]
  eq(rows.length, 2)
  eq(rows[0].providerId, '1')
  eq(rows[0].hashrate24h, 6.1e20, 'the newest capture wins')
  eq(rows[0].blockRewardStatic, 3.125)
  eq(rows[1].hashrate24h, null, 'a metric the chain does not publish stays null')
  eq(result.asOf, hoursAgo(0))
  eq(result.coverage.count, 3)
  eq(result.reason, null)
})

Deno.test('network stats read on an empty table says the plan is below Growth, never a flat series', async () => {
  const result = await readNetworkStats(fakeDb(), {}, NOW.getTime())
  eq(result.rows, [])
  eq(result.asOf, null)
  eq(result.reason, 'plan_below_growth')
  eq(result.coverage, { from: null, to: null, count: 0 })

  const broken = await readNetworkStats(fakeDb({}, { intel_network_stats_snapshots: 'denied' }), {}, NOW.getTime())
  eq(broken.reason, 'denied', 'a real read failure is reported as itself, not as the plan')
})

// ─── surface ──────────────────────────────────────────────────────────────────

Deno.test('the read surface exposes exactly the four views and each returns its own shape', async () => {
  eq(Object.keys(CATEGORY_CAPTURE_VIEWS).sort(), ['airdrops', 'categories', 'category_disagreement', 'network_stats'])
  eq([...CATEGORY_VIEWS].sort(), Object.keys(CATEGORY_CAPTURE_VIEWS).sort())
  const db = fakeDb()
  for (const view of CATEGORY_VIEWS) {
    const result = await CATEGORY_CAPTURE_VIEWS[view](db, {}, NOW.getTime())
    eq(result.view, view)
    eq(result.asOf, null)
    assert(result.coverage && typeof result.coverage.count === 'number', `${view} reports coverage`)
  }
})
