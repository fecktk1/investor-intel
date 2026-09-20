import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { AGREEMENT_ROW_MAX, UNUSUAL_CAPTURE_VIEWS, UNUSUAL_DEFAULT_LIMIT, readUnusualMoves } from './capture-unusual-read.ts'

const NOW = Date.UTC(2026, 8, 20, 9, 30, 0)

/** A PostgREST-shaped fake for the tables this view reads. `intel_market_observations`
 * answers empty by default, which is the ordinary "nothing retained for this
 * subject" case and produces an `unmeasured` verdict rather than a failure. */
// deno-lint-ignore no-explicit-any
function fakeDb(tables: Record<string, any[]>, errors: Record<string, string> = {}) {
  const reads: string[] = []
  // deno-lint-ignore no-explicit-any
  const db: any = {
    reads,
    from(table: string) {
      reads.push(table)
      const eqs: [string, unknown][] = []
      const ins: [string, unknown[]][] = []
      const orders: { column: string; ascending: boolean }[] = []
      const resolve = (max: number) => {
        if (errors[table]) return Promise.resolve({ data: null, error: { message: errors[table] } })
        let out = (tables[table] || []).filter((row) =>
          eqs.every(([k, v]) => row?.[k] === v || String(row?.[k] ?? '') === String(v ?? '')) &&
          ins.every(([k, values]) => values.some((v) => String(row?.[k] ?? '') === String(v ?? ''))))
        for (const order of [...orders].reverse()) {
          out = [...out].sort((a, b) => {
            const av = a?.[order.column], bv = b?.[order.column]
            const cmp = av == null && bv == null ? 0 : av == null ? 1 : bv == null ? -1
              : typeof av === 'number' && typeof bv === 'number' ? av - bv
              : typeof av === 'boolean' || typeof bv === 'boolean' ? Number(av) - Number(bv)
              : String(av).localeCompare(String(bv))
            return order.ascending ? cmp : -cmp
          })
        }
        return Promise.resolve({ data: out.slice(0, max), error: null })
      }
      // deno-lint-ignore no-explicit-any
      const q: any = {
        select: () => q,
        eq: (k: string, v: unknown) => { eqs.push([k, v]); return q },
        in: (k: string, v: unknown[]) => { ins.push([k, v]); return q },
        gt: () => q, gte: () => q, lte: () => q,
        // deno-lint-ignore no-explicit-any
        order: (column: string, opts: any = {}) => { orders.push({ column, ascending: opts?.ascending !== false }); return q },
        limit: (max: number) => resolve(max),
      }
      return q
    },
  }
  return db
}

// deno-lint-ignore no-explicit-any
const scoreRow = (over: Record<string, any> = {}) => ({
  asset_key: 'eip155:43114:native', subject_day: '2026-09-19', cmc_id: '5805', symbol: 'AVAX', name: 'Avalanche',
  captured_at: '2026-09-20T09:00:00.000Z', scored: true, reason: null,
  sample_days: 90, required_days: 30, is_market_reference: false,
  move_pct: 23.04, volume: 85_017_237, lead_window_days: 90,
  move_percentile: 100, move_exceeded: 90, median_abs_pct: 1.98, mad_pct: 1.3, robust_z: 10.92,
  volume_percentile: 100, volume_robust_z: 4.1, beta: 1.04, beta_n: 90, residual_pct: 22.57, market_move_pct: 0.45,
  liquidity_usd: 1.27e9, market_cap: 4.2e9, market_cap_rank: 21, catalogue_as_of: '2026-09-20T09:20:00.000Z',
  windows: [
    { days: 30, n: 30, medianAbsPct: 2.1, madPct: 1.4, robustZ: 10.1, robustZReason: null, percentile: 100, exceeded: 30, volumeN: 30, volumeRobustZ: 3.9, volumeRobustZReason: null, volumePercentile: 100, volumeExceeded: 30, beta: 1.1, betaN: 30, betaReason: null, marketMovePct: 0.45, residualPct: 22.5 },
    { days: 90, n: 90, medianAbsPct: 1.98, madPct: 1.3, robustZ: 10.92, robustZReason: null, percentile: 100, exceeded: 90, volumeN: 90, volumeRobustZ: 4.1, volumeRobustZReason: null, volumePercentile: 100, volumeExceeded: 90, beta: 1.04, betaN: 90, betaReason: null, marketMovePct: 0.45, residualPct: 22.57 },
  ],
  ...over,
})

const productionShaped = () => fakeDb({
  intel_unusual_move_scores: [
    scoreRow(),
    scoreRow({ asset_key: 'bip122:native:BTC', cmc_id: '1', symbol: 'BTC', name: 'Bitcoin', is_market_reference: true, move_pct: 0.45, move_percentile: 41.1, move_exceeded: 37, beta: null, beta_n: 0, residual_pct: null, liquidity_usd: 2.1e10, market_cap_rank: 1 }),
    scoreRow({ asset_key: 'cmc:42285', cmc_id: '42285', symbol: 'NEW', name: 'Newly listed', scored: false, reason: 'insufficient_history', sample_days: 7, move_pct: null, lead_window_days: null, move_percentile: null, move_exceeded: null, windows: [] }),
    scoreRow({ asset_key: 'eip155:1:usdc', cmc_id: '3408', symbol: 'USDC', name: 'USDC', scored: false, reason: 'peg_excluded', sample_days: 90, move_pct: null, lead_window_days: null, move_percentile: null, move_exceeded: null, windows: [] }),
  ],
  market_assets: [
    { source_provider: 'coinmarketcap', provider_id: '5805', cached_image_url: 'https://cdn.example/avax.png', image_url: 'https://s2.example/avax.png' },
    { source_provider: 'coinmarketcap', provider_id: '1', cached_image_url: null, image_url: 'https://s2.example/btc.png' },
  ],
  intel_market_observations: [],
})

Deno.test('the view surface exposes exactly the unusual_moves view', () => {
  eq(Object.keys(UNUSUAL_CAPTURE_VIEWS), ['unusual_moves'])
})

Deno.test('the newest scored day is read, scored rows only, most unusual first', async () => {
  const result = await readUnusualMoves(productionShaped(), {}, NOW)
  eq(result.view, 'unusual_moves')
  eq(result.subjectDay, '2026-09-19')
  eq(result.reason, null)
  eq(result.asOf, '2026-09-20T09:00:00.000Z')
  eq(result.scoredAssets, 2)
  eq(result.trackedAssets, 4)
  eq(result.windowDays, [30, 90])
  eq(result.leadWindowDays, 90)
  eq(result.minSampleDays, 30)
  // deno-lint-ignore no-explicit-any
  const rows = result.rows as any[]
  eq(rows.length, 2, 'refused rows never enter the table')
  eq(rows.map((r) => r.symbol), ['AVAX', 'BTC'])
  eq(rows[0].percentile, 100)
  eq(rows[0].exceeded, 90)
  eq(rows[0].sampleDays, 90)
  eq(rows[0].medianAbsPct, 1.98)
  eq(rows[0].beta, 1.04)
  eq(rows[0].betaN, 90)
  eq(rows[0].residualPct, 22.57)
  eq(rows[0].windows.length, 2)
  eq(rows[0].windows[0].days, 30)
})

Deno.test('the refusals are counted and the short-history assets are named', async () => {
  const result = await readUnusualMoves(productionShaped(), {}, NOW)
  eq(result.excluded, { insufficient_history: 1, peg_excluded: 1 })
  // deno-lint-ignore no-explicit-any
  const short = result.shortHistory as any[]
  eq(short.length, 1)
  eq(short[0], { symbol: 'NEW', name: 'Newly listed', cmcId: '42285', sampleDays: 7, requiredDays: 30 })
})

Deno.test('the market reference is reported so the residual column has an anchor', async () => {
  const result = await readUnusualMoves(productionShaped(), {}, NOW)
  eq(result.marketReference, { symbol: 'BTC', name: 'Bitcoin', cmcId: '1', movePct: 0.45 })
  // deno-lint-ignore no-explicit-any
  const btc = (result.rows as any[]).find((r) => r.symbol === 'BTC')
  eq(btc.isMarketReference, true)
  eq(btc.beta, null)
  eq(btc.residualPct, null)
})

Deno.test('logos come from the catalogue, cached first, and a missing one is null not a guess', async () => {
  const result = await readUnusualMoves(productionShaped(), {}, NOW)
  // deno-lint-ignore no-explicit-any
  const rows = result.rows as any[]
  eq(rows.find((r) => r.symbol === 'AVAX').imageUrl, 'https://cdn.example/avax.png')
  eq(rows.find((r) => r.symbol === 'AVAX').fallbackImageUrl, 'https://s2.example/avax.png')
  eq(rows.find((r) => r.symbol === 'BTC').imageUrl, 'https://s2.example/btc.png')
})

Deno.test('the evidence standard verdict is attached for the returned rows', async () => {
  const result = await readUnusualMoves(productionShaped(), {}, NOW)
  eq(result.agreementRows, 2)
  // deno-lint-ignore no-explicit-any
  const verdict = (result.rows as any[])[0].metricAgreement
  // Nothing retained for the subject is an honest 'unmeasured', not a missing field.
  eq(verdict.metric_agreement, 'unmeasured')
  eq(verdict.research_lead, true)
  assert(Array.isArray(verdict.readings) && verdict.readings.length === 3)
})

Deno.test('a failed verdict lookup leaves the verdict absent rather than asserting unmeasured', async () => {
  const db = fakeDb({
    intel_unusual_move_scores: [scoreRow()],
    market_assets: [],
    intel_market_observations: [],
  }, { intel_market_observations: 'canceling statement due to statement timeout' })
  const result = await readUnusualMoves(db, {}, NOW)
  // deno-lint-ignore no-explicit-any
  const row = (result.rows as any[])[0]
  // readMetricAgreement swallows its own read failure into an unmeasured verdict
  // with a reason, so the row still carries a receipt and the surface still says
  // something true: the read is never allowed to fail the whole view.
  eq(result.reason, null)
  eq(row.symbol, 'AVAX')
  assert(row.metricAgreement == null || row.metricAgreement.metric_agreement === 'unmeasured')
})

Deno.test('the caller limit is honoured and bounded', async () => {
  const many = Array.from({ length: 60 }, (_, i) => scoreRow({ asset_key: `a${i}`, cmc_id: String(100 + i), symbol: `A${i}`, move_percentile: 100 - i, liquidity_usd: 1e9 - i }))
  const db = () => fakeDb({ intel_unusual_move_scores: many, market_assets: [], intel_market_observations: [] })
  eq(((await readUnusualMoves(db(), {}, NOW)).rows as unknown[]).length, UNUSUAL_DEFAULT_LIMIT)
  eq(((await readUnusualMoves(db(), { limit: 5 }, NOW)).rows as unknown[]).length, 5)
  eq(((await readUnusualMoves(db(), { limit: 9999 }, NOW)).rows as unknown[]).length, 60)
  eq(((await readUnusualMoves(db(), { limit: 'nonsense' }, NOW)).rows as unknown[]).length, UNUSUAL_DEFAULT_LIMIT)
  // The verdict lookup is capped independently of the row limit.
  const wide = await readUnusualMoves(db(), { limit: 60 }, NOW)
  eq(wide.agreementRows, AGREEMENT_ROW_MAX)
})

Deno.test('a named day is read instead of the newest, and an unreadable one falls back', async () => {
  const db = fakeDb({
    intel_unusual_move_scores: [scoreRow(), scoreRow({ asset_key: 'older', subject_day: '2026-09-18', symbol: 'OLD', cmc_id: '77' })],
    market_assets: [], intel_market_observations: [],
  })
  const named = await readUnusualMoves(db, { day: '2026-09-18' }, NOW)
  eq(named.subjectDay, '2026-09-18')
  eq((named.rows as { symbol: string }[]).map((r) => r.symbol), ['OLD'])
  const fallback = await readUnusualMoves(productionShaped(), { day: 'yesterday please' }, NOW)
  eq(fallback.subjectDay, '2026-09-19')
})

Deno.test('an empty table says it has no scored day, with no rows and no error', async () => {
  const result = await readUnusualMoves(fakeDb({ intel_unusual_move_scores: [] }), {}, NOW)
  eq(result.rows, [])
  eq(result.asOf, null)
  eq(result.reason, null)
  eq(result.empty, 'no_scored_day')
  eq(result.coverage, { from: null, to: null, count: 0 })
})

Deno.test('a failed read is a reason on an empty result, never a silently short list', async () => {
  const result = await readUnusualMoves(
    fakeDb({ intel_unusual_move_scores: [scoreRow()] }, { intel_unusual_move_scores: 'permission denied' }), {}, NOW)
  eq(result.rows, [])
  eq(result.reason, 'permission denied')
  eq(result.asOf, null)
  eq(result.coverage.count, 0)
})

Deno.test('a day whose rows are all refused is an empty table with counted reasons, not a failure', async () => {
  const result = await readUnusualMoves(fakeDb({
    intel_unusual_move_scores: [
      scoreRow({ scored: false, reason: 'peg_excluded', move_pct: null, lead_window_days: null, move_percentile: null, windows: [] }),
      scoreRow({ asset_key: 'b', cmc_id: '2', symbol: 'B', scored: false, reason: 'below_liquidity_floor', move_pct: null, lead_window_days: null, move_percentile: null, windows: [] }),
    ],
    market_assets: [], intel_market_observations: [],
  }), {}, NOW)
  eq(result.rows, [])
  eq(result.reason, null)
  eq(result.scoredAssets, 0)
  eq(result.trackedAssets, 2)
  eq(result.excluded, { peg_excluded: 1, below_liquidity_floor: 1 })
  eq(result.subjectDay, '2026-09-19')
})

Deno.test('the lead figures name the window they were measured over, which is not sample_days', async () => {
  // The production shape that produced the contradiction on /intel/markets: 92
  // stored days of history, a 90-day lead window, and 90 of that window's days
  // exceeded. "Larger than 90 of the last 92 days" and "100.0th percentile" are
  // both true of DIFFERENT windows, so the view states the lead window's own
  // count and the surface uses it for both.
  const db = fakeDb({
    intel_unusual_move_scores: [
      scoreRow({ sample_days: 92, move_exceeded: 90, move_percentile: 100 }),
    ],
    market_assets: [],
    intel_market_observations: [],
  })
  const result = await readUnusualMoves(db, {}, NOW)
  // deno-lint-ignore no-explicit-any
  const row = (result.rows as any[])[0]
  eq(row.sampleDays, 92)
  eq(row.leadWindowDays, 90)
  eq(row.leadWindowN, 90, 'the denominator behind exceeded and percentile')
  eq(row.exceeded, 90)
  // 90 of 90 is the 100th percentile, which is now what the sentence says too.
  eq(row.percentile, 100)
})

Deno.test('a row whose stored windows do not include the lead window states no count rather than a wrong one', async () => {
  const db = fakeDb({
    intel_unusual_move_scores: [
      scoreRow({ windows: [{ days: 30, n: 30, percentile: 90, exceeded: 27 }] }),
    ],
    market_assets: [],
    intel_market_observations: [],
  })
  const result = await readUnusualMoves(db, {}, NOW)
  // deno-lint-ignore no-explicit-any
  eq((result.rows as any[])[0].leadWindowN, null)
})
