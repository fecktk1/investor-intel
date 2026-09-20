import { assertEquals as eq, assert, assertAlmostEquals as near } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  MARKET_REFERENCE_CMC_ID, UNUSUAL_CAPTURE_OPS, UNUSUAL_FEATURE, UNUSUAL_PROVIDER,
  captureUnusualMoves, catalogueTags, hourBucket, preferOneKeyPerAsset, scoreRow, seriesByAsset,
} from './capture-unusual.ts'
import { scoreUnusualMove, type DailyClose } from './unusual-moves.ts'

const NOW = new Date(Date.UTC(2026, 8, 20, 9, 30, 0))
const DAY = 86_400_000

/** A PostgREST-shaped fake supporting the calls this lane makes: select, eq, in,
 * not, gte, order, range, limit and upsert. Each table's rows are filtered by the
 * eq/in/gte filters, sorted by the requested order, and sliced by range. */
// deno-lint-ignore no-explicit-any
function fakeDb(tables: Record<string, any[]>, options: { errors?: Record<string, string>; pageRows?: number } = {}) {
  // deno-lint-ignore no-explicit-any
  const written: { table: string; rows: any[]; onConflict: string }[] = []
  const pageRows = options.pageRows ?? 1_000
  // deno-lint-ignore no-explicit-any
  const db: any = {
    written,
    from(table: string) {
      const eqs: [string, unknown][] = []
      const ins: [string, unknown[]][] = []
      const gtes: [string, unknown][] = []
      const notNull: string[] = []
      const orders: { column: string; ascending: boolean }[] = []
      // deno-lint-ignore no-explicit-any
      const resolve = (from: number, to: number | null) => {
        if (options.errors?.[table]) return Promise.resolve({ data: null, error: { message: options.errors[table] } })
        let out = (tables[table] || []).filter((row) =>
          eqs.every(([k, v]) => row?.[k] === v || String(row?.[k] ?? '') === String(v ?? '')) &&
          ins.every(([k, values]) => values.some((v) => String(row?.[k] ?? '') === String(v ?? ''))) &&
          gtes.every(([k, v]) => String(row?.[k] ?? '') >= String(v ?? '')) &&
          notNull.every((k) => row?.[k] != null))
        for (const order of [...orders].reverse()) {
          out = [...out].sort((a, b) => {
            const av = a?.[order.column], bv = b?.[order.column]
            const cmp = av == null && bv == null ? 0 : av == null ? 1 : bv == null ? -1
              : typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv))
            return order.ascending ? cmp : -cmp
          })
        }
        const start = from, end = to == null ? out.length : Math.min(out.length, to + 1)
        return Promise.resolve({ data: out.slice(start, Math.min(end, start + pageRows)), error: null })
      }
      // deno-lint-ignore no-explicit-any
      const q: any = {
        select: () => q,
        eq: (k: string, v: unknown) => { eqs.push([k, v]); return q },
        in: (k: string, v: unknown[]) => { ins.push([k, v]); return q },
        gte: (k: string, v: unknown) => { gtes.push([k, v]); return q },
        not: (k: string, op: string, _v: unknown) => { if (op === 'is') notNull.push(k); return q },
        // deno-lint-ignore no-explicit-any
        order: (column: string, opts: any = {}) => { orders.push({ column, ascending: opts?.ascending !== false }); return q },
        range: (from: number, to: number) => resolve(from, to),
        limit: (max: number) => resolve(0, max - 1),
        // deno-lint-ignore no-explicit-any
        upsert: (rows: any[], opts: any) => {
          if (options.errors?.[`${table}:write`]) return Promise.resolve({ error: { message: options.errors[`${table}:write`] } })
          written.push({ table, rows, onConflict: String(opts?.onConflict ?? '') })
          return Promise.resolve({ error: null })
        },
      }
      return q
    },
  }
  return db
}

/** `days` consecutive UTC midnights ending on `last`, oldest first. */
const candleTimes = (last: string, days: number) =>
  Array.from({ length: days }, (_, i) => new Date(Date.parse(`${last}T00:00:00Z`) - (days - 1 - i) * DAY).toISOString())

/** Candle rows for one asset built from a list of simple daily returns. */
function candleRows(assetKey: string, provider: string, last: string, returns: number[], volume = 5_000_000) {
  const times = candleTimes(last, returns.length + 1)
  let close = 100
  const rows = [{ asset_key: assetKey, provider, candle_interval: '1d', candle_time: times[0], close, volume }]
  returns.forEach((ret, i) => { close = close * (1 + ret); rows.push({ asset_key: assetKey, provider, candle_interval: '1d', candle_time: times[i + 1], close, volume }) })
  return rows
}

const alternating = (length: number, a = 0.01, b = -0.012) => Array.from({ length }, (_, i) => (i % 2 ? a : b))

function productionShapedDb(extra: Record<string, unknown[]> = {}) {
  const btc = candleRows('bip122:native:BTC', 'binance', '2026-09-19', [...alternating(92), 0.005])
  const alt = candleRows('eip155:43114:native', 'binance', '2026-09-19', [...alternating(92), 0.23])
  const thin = candleRows('cmc:42285', 'coinmarketcap', '2026-09-19', alternating(8))
  return fakeDb({
    market_asset_candles: [...btc, ...alt, ...thin],
    market_asset_candle_backfill: [
      { asset_key: 'bip122:native:BTC', cmc_id: '1', symbol: 'BTC' },
      { asset_key: 'eip155:43114:native', cmc_id: '5805', symbol: 'AVAX' },
      { asset_key: 'cmc:42285', cmc_id: '42285', symbol: 'NEW' },
    ],
    market_assets: [
      { source_provider: 'coinmarketcap', provider_id: '1', symbol: 'BTC', name: 'Bitcoin', market_cap_rank: 1, market_cap: 2.1e12, volume_24h: 2.1e10, categories: ['pow', 'mineable'], as_of: NOW.toISOString() },
      { source_provider: 'coinmarketcap', provider_id: '5805', symbol: 'AVAX', name: 'Avalanche', market_cap_rank: 21, market_cap: 4.2e9, volume_24h: 1.27e9, categories: ['smart-contracts'], as_of: NOW.toISOString() },
      { source_provider: 'coinmarketcap', provider_id: '42285', symbol: 'NEW', name: 'Newly listed', market_cap_rank: 900, market_cap: 3e7, volume_24h: 2e7, categories: [], as_of: NOW.toISOString() },
    ],
    intel_unusual_move_scores: [],
    provider_schedule_policy: [{ provider: UNUSUAL_PROVIDER, feature: UNUSUAL_FEATURE, cadence_seconds: 3600, enabled: true, max_credits: 0 }],
    ...extra,
  })
}

// ─── Registration and invariants ──────────────────────────────────────────────

Deno.test('the op surface exposes exactly the unusual_moves op', () => {
  eq(Object.keys(UNUSUAL_CAPTURE_OPS), ['unusual_moves'])
  eq(UNUSUAL_PROVIDER, 'local')
  eq(MARKET_REFERENCE_CMC_ID, '1')
})

Deno.test('the capture bucket lands on the hour so a retried run overwrites its own row', () => {
  eq(hourBucket(Date.UTC(2026, 8, 20, 9, 59, 59)), '2026-09-20T09:00:00.000Z')
  eq(hourBucket(NOW), '2026-09-20T09:00:00.000Z')
})

// ─── Reducing the archive ─────────────────────────────────────────────────────

Deno.test('the venue beats the aggregate for a day both sources hold', () => {
  const series = seriesByAsset([
    { asset_key: 'a', provider: 'coinmarketcap', candle_time: '2026-09-18T00:00:00Z', close: 101, volume: 5 },
    { asset_key: 'a', provider: 'binance', candle_time: '2026-09-18T00:00:00Z', close: 100, volume: 7 },
    { asset_key: 'a', provider: 'coingecko', candle_time: '2026-09-19T00:00:00Z', close: 110, volume: 9 },
  ])
  eq(series.get('a'), [
    { day: '2026-09-18', close: 100, volume: 7 },
    { day: '2026-09-19', close: 110, volume: 9 },
  ])
})

Deno.test('rows with no close, no price or an unreadable period never enter a series', () => {
  const series = seriesByAsset([
    { asset_key: 'a', provider: 'binance', candle_time: '2026-09-18T00:00:00Z', close: null, volume: 5 },
    { asset_key: 'a', provider: 'binance', candle_time: '2026-09-19T00:00:00Z', close: 0, volume: 5 },
    { asset_key: 'a', provider: 'binance', candle_time: 'nonsense', close: 10, volume: 5 },
    { asset_key: '', provider: 'binance', candle_time: '2026-09-19T00:00:00Z', close: 10, volume: 5 },
    { asset_key: 'a', provider: 'binance', candle_time: '2026-09-20T00:00:00Z', close: 12, volume: null },
  ])
  eq(series.get('a'), [{ day: '2026-09-20', close: 12, volume: null }])
  eq(series.size, 1)
})

Deno.test('two archive keys for one listing collapse to the longer series, deterministically', () => {
  const series = new Map<string, DailyClose[]>([
    ['cmc:1', [{ day: '2026-09-19', close: 1, volume: null }]],
    ['bip122:native:BTC', [{ day: '2026-09-18', close: 1, volume: null }, { day: '2026-09-19', close: 1, volume: null }]],
    ['orphan', []],
  ])
  const kept = preferOneKeyPerAsset([
    { assetKey: 'cmc:1', cmcId: '1', symbol: 'BTC' },
    { assetKey: 'bip122:native:BTC', cmcId: '1', symbol: 'BTC' },
    { assetKey: 'orphan', cmcId: '999', symbol: 'ORP' },
  ], series)
  eq(kept.map((k) => k.assetKey), ['bip122:native:BTC'])
  // A tie on stored days is broken by the key, so the choice never flips run to run.
  const tie = preferOneKeyPerAsset([
    { assetKey: 'zzz', cmcId: '1', symbol: 'X' },
    { assetKey: 'aaa', cmcId: '1', symbol: 'X' },
  ], new Map([['zzz', [{ day: '2026-09-19', close: 1, volume: null }]], ['aaa', [{ day: '2026-09-19', close: 1, volume: null }]]]))
  eq(tie.map((k) => k.assetKey), ['aaa'])
})

Deno.test('catalogue tags survive an array, a json string and a malformed value', () => {
  eq(catalogueTags(['defi', 'stablecoin']), ['defi', 'stablecoin'])
  eq(catalogueTags('["defi","memes"]'), ['defi', 'memes'])
  eq(catalogueTags('not json'), [])
  eq(catalogueTags(null), [])
  eq(catalogueTags({ defi: true }), [])
})

// ─── Row shape ────────────────────────────────────────────────────────────────

Deno.test('a row without a scored day is not written at all', () => {
  const score = scoreUnusualMove({ assetKey: 'a', series: [], liquidityUsd: 1e9, tags: [], symbol: 'A' })
  eq(score.reason, 'no_subject_return')
  eq(scoreRow(score, { assetKey: 'a', cmcId: '1', symbol: 'A', name: 'A' },
    { liquidityUsd: 1e9, marketCap: null, rank: null, asOf: null }, '2026-09-20T09:00:00.000Z'), null)
})

Deno.test('a refused row carries its reason, its sample count and no figures', () => {
  const series = candleRows('a', 'binance', '2026-09-19', alternating(10)).map((r) => ({ day: r.candle_time.slice(0, 10), close: r.close, volume: r.volume }))
  const score = scoreUnusualMove({ assetKey: 'a', series, liquidityUsd: 1e9, tags: [], symbol: 'A' })
  const row = scoreRow(score, { assetKey: 'a', cmcId: '7', symbol: 'A', name: 'Asset' },
    { liquidityUsd: 1e9, marketCap: 1, rank: 5, asOf: null }, '2026-09-20T09:00:00.000Z')!
  eq(row.scored, false)
  eq(row.reason, 'insufficient_history')
  eq(row.sample_days, 9)
  eq(row.required_days, 30)
  eq(row.subject_day, '2026-09-19')
  eq(row.move_pct, null)
  eq(row.lead_window_days, null)
  eq(row.move_percentile, null)
  eq(row.windows, [])
})

// ─── The whole run ────────────────────────────────────────────────────────────

Deno.test('a production-shaped run scores, refuses and writes with zero credits', async () => {
  const db = productionShapedDb()
  const result = await captureUnusualMoves(db, NOW)
  eq(result.job, 'unusual_moves')
  eq(result.credits, 0, 'this lane can never spend a provider credit')
  eq(result.error, undefined)
  eq(result.capturedAt, '2026-09-20T09:00:00.000Z')
  eq(result.subjectDay, '2026-09-19')
  eq(result.assets, 3)
  eq(result.scored, 2)
  eq(result.refused, { insufficient_history: 1 })
  eq(result.rows, 3)
  eq(db.written.length, 1)
  eq(db.written[0].table, 'intel_unusual_move_scores')
  eq(db.written[0].onConflict, 'asset_key,subject_day')

  // deno-lint-ignore no-explicit-any
  const rows: any[] = db.written[0].rows
  const avax = rows.find((r) => r.symbol === 'AVAX')
  eq(avax.scored, true)
  eq(avax.subject_day, '2026-09-19')
  near(avax.move_pct, 23, 1e-9)
  eq(avax.lead_window_days, 90)
  eq(avax.move_percentile, 100)
  eq(avax.move_exceeded, 90)
  eq(avax.is_market_reference, false)
  assert(avax.beta != null && avax.beta_n === 90, 'beta is fitted over the same trailing window and reports its sample')
  assert(avax.residual_pct != null, 'the residual is the part of the day that was this asset alone')
  eq(avax.liquidity_usd, 1.27e9)
  eq(avax.market_cap_rank, 21)
  eq((avax.windows as unknown[]).length, 2, 'both the 30 and the 90 day window ride along')

  // The market reference is scored against its own distribution but has no beta.
  const btc = rows.find((r) => r.symbol === 'BTC')
  eq(btc.is_market_reference, true)
  eq(btc.beta, null)
  eq(btc.residual_pct, null)
  assert(typeof btc.move_percentile === 'number')

  // The newly listed asset has eight days and is refused with its count.
  const thin = rows.find((r) => r.symbol === 'NEW')
  eq(thin.scored, false)
  eq(thin.reason, 'insufficient_history')
  eq(thin.sample_days, 7)
  eq(thin.required_days, 30)
})

Deno.test('the ranking is deterministic and never lists one listing twice', async () => {
  // The same CoinMarketCap listing reached by two archive keys, which is exactly
  // what production carried for Bitcoin, Chainlink and Pepe on 2026-09-20.
  const tables = {
    market_asset_candles: [
      ...candleRows('bip122:native:BTC', 'binance', '2026-09-19', [...alternating(92), 0.005]),
      ...candleRows('eip155:43114:native', 'binance', '2026-09-19', [...alternating(92), 0.23]),
      ...candleRows('cmc:5805', 'coinmarketcap', '2026-09-19', [...alternating(60), 0.19]),
    ],
    market_asset_candle_backfill: [
      { asset_key: 'bip122:native:BTC', cmc_id: '1', symbol: 'BTC' },
      { asset_key: 'eip155:43114:native', cmc_id: '5805', symbol: 'AVAX' },
      { asset_key: 'cmc:5805', cmc_id: '5805', symbol: 'AVAX' },
    ],
    market_assets: [
      { source_provider: 'coinmarketcap', provider_id: '1', symbol: 'BTC', name: 'Bitcoin', market_cap_rank: 1, market_cap: 1, volume_24h: 2.1e10, categories: [], as_of: null },
      { source_provider: 'coinmarketcap', provider_id: '5805', symbol: 'AVAX', name: 'Avalanche', market_cap_rank: 21, market_cap: 1, volume_24h: 1.27e9, categories: [], as_of: null },
    ],
    intel_unusual_move_scores: [],
    provider_schedule_policy: [],
  }
  const db = fakeDb(tables)
  const result = await captureUnusualMoves(db, NOW)
  eq(result.assets, 2, 'two listings, not three keys')
  eq(result.scored, 2)
  // The longer series wins, so Avalanche is scored from the venue key and the
  // shorter aggregate key never produces a second row.
  const keys = (db.written[0].rows as { asset_key: string }[]).map((r) => r.asset_key).sort()
  eq(keys, ['bip122:native:BTC', 'eip155:43114:native'])
})

Deno.test('a peg and a thin book are refused with their own reasons, not dropped', async () => {
  const result = await captureUnusualMoves(fakeDb({
    market_asset_candles: [
      ...candleRows('bip122:native:BTC', 'binance', '2026-09-19', [...alternating(92), 0.005]),
      ...candleRows('eip155:1:usdc', 'binance', '2026-09-19', [...alternating(92, 0.0004, -0.0003), 0.004]),
      ...candleRows('eip155:1:thin', 'binance', '2026-09-19', [...alternating(92), 0.4]),
      ...candleRows('eip155:1:unknown', 'binance', '2026-09-19', [...alternating(92), 0.4]),
    ],
    market_asset_candle_backfill: [
      { asset_key: 'bip122:native:BTC', cmc_id: '1', symbol: 'BTC' },
      { asset_key: 'eip155:1:usdc', cmc_id: '3408', symbol: 'USDC' },
      { asset_key: 'eip155:1:thin', cmc_id: '9001', symbol: 'THIN' },
      { asset_key: 'eip155:1:unknown', cmc_id: '9002', symbol: 'UNK' },
    ],
    market_assets: [
      { source_provider: 'coinmarketcap', provider_id: '1', symbol: 'BTC', name: 'Bitcoin', market_cap_rank: 1, market_cap: 1, volume_24h: 2.1e10, categories: [], as_of: null },
      { source_provider: 'coinmarketcap', provider_id: '3408', symbol: 'USDC', name: 'USDC', market_cap_rank: 6, market_cap: 1, volume_24h: 9.3e9, categories: ['stablecoin', 'usd-stablecoin'], as_of: null },
      { source_provider: 'coinmarketcap', provider_id: '9001', symbol: 'THIN', name: 'Thin', market_cap_rank: 900, market_cap: 1, volume_24h: 4_000, categories: [], as_of: null },
      { source_provider: 'coinmarketcap', provider_id: '9002', symbol: 'UNK', name: 'Unknown', market_cap_rank: null, market_cap: null, volume_24h: null, categories: [], as_of: null },
    ],
    intel_unusual_move_scores: [],
    provider_schedule_policy: [],
  }), NOW)
  eq(result.scored, 1)
  eq(result.refused, { peg_excluded: 1, below_liquidity_floor: 1, liquidity_unknown: 1 })
  eq(result.rows, 4, 'every refusal is stored so the surface can say why')
})

Deno.test('the archive window is paged, so the max_rows ceiling cannot silently truncate it', async () => {
  // 200 assets x 41 days is 8,200 rows, well past a single 1,000-row page.
  const candles: Record<string, unknown>[] = []
  const identities: Record<string, unknown>[] = []
  const catalogue: Record<string, unknown>[] = []
  for (let i = 1; i <= 200; i++) {
    const key = `eip155:1:asset${String(i).padStart(3, '0')}`
    candles.push(...candleRows(key, 'binance', '2026-09-19', alternating(40)))
    identities.push({ asset_key: key, cmc_id: String(1000 + i), symbol: `A${i}` })
    catalogue.push({ source_provider: 'coinmarketcap', provider_id: String(1000 + i), symbol: `A${i}`, name: `Asset ${i}`, market_cap_rank: i, market_cap: 1, volume_24h: 5e6, categories: [], as_of: null })
  }
  const result = await captureUnusualMoves(fakeDb({
    market_asset_candles: candles, market_asset_candle_backfill: identities,
    market_assets: catalogue, intel_unusual_move_scores: [], provider_schedule_policy: [],
  }, { pageRows: 1_000 }), NOW)
  eq(result.archiveRows, 200 * 41)
  eq(result.assets, 200)
  eq(result.scored, 200, 'every asset was read in full, not only the first page')
  eq(result.partial, undefined)
})

// ─── Guards and failures ──────────────────────────────────────────────────────

Deno.test('a disabled policy row skips the lane without reading anything', async () => {
  const result = await captureUnusualMoves(fakeDb({
    provider_schedule_policy: [{ provider: UNUSUAL_PROVIDER, feature: UNUSUAL_FEATURE, enabled: false }],
  }), NOW)
  eq(result, { job: 'unusual_moves', rows: 0, credits: 0, skipped: 'policy_disabled' })
})

Deno.test('a run inside the cadence skips rather than repeating the work', async () => {
  const db = productionShapedDb({
    intel_unusual_move_scores: [{ asset_key: 'a', subject_day: '2026-09-19', captured_at: new Date(NOW.getTime() - 10 * 60_000).toISOString() }],
  })
  const result = await captureUnusualMoves(db, NOW)
  eq(result.skipped, 'within_cadence')
  eq(result.rows, 0)
  eq(db.written.length, 0)
})

Deno.test('an empty archive is a stated skip, never a written row', async () => {
  const result = await captureUnusualMoves(fakeDb({ market_asset_candles: [], provider_schedule_policy: [] }), NOW)
  eq(result.skipped, 'archive_empty')
  eq(result.rows, 0)
})

Deno.test('a failed read is reported as a reason and writes nothing', async () => {
  const failing = fakeDb({ market_asset_candles: [], provider_schedule_policy: [] }, { errors: { market_asset_candles: 'canceling statement due to statement timeout' } })
  const result = await captureUnusualMoves(failing, NOW)
  eq(result.error, 'canceling statement due to statement timeout')
  eq(result.rows, 0)
  eq(failing.written.length, 0)
  // A failed WRITE is reported too, with the rows it managed.
  const writeFail = fakeDb({
    market_asset_candles: candleRows('bip122:native:BTC', 'binance', '2026-09-19', [...alternating(92), 0.005]),
    market_asset_candle_backfill: [{ asset_key: 'bip122:native:BTC', cmc_id: '1', symbol: 'BTC' }],
    market_assets: [{ source_provider: 'coinmarketcap', provider_id: '1', symbol: 'BTC', name: 'Bitcoin', market_cap_rank: 1, market_cap: 1, volume_24h: 2.1e10, categories: [], as_of: null }],
    intel_unusual_move_scores: [], provider_schedule_policy: [],
  }, { errors: { 'intel_unusual_move_scores:write': 'permission denied' } })
  const failed = await captureUnusualMoves(writeFail, NOW)
  eq(failed.error, 'permission denied')
  eq(failed.rows, 0)
})

Deno.test('a catalogue with no matching identity is a stated skip', async () => {
  const result = await captureUnusualMoves(fakeDb({
    market_asset_candles: candleRows('a', 'binance', '2026-09-19', alternating(40)),
    market_asset_candle_backfill: [],
    market_assets: [], intel_unusual_move_scores: [], provider_schedule_policy: [],
  }), NOW)
  eq(result.skipped, 'no_catalogue_identity')
})

Deno.test('the op runner ignores the provider transport it is handed', async () => {
  const db = productionShapedDb()
  const spy = { request: () => { throw new Error('the unusual lane must never call a provider') } }
  const result = await UNUSUAL_CAPTURE_OPS.unusual_moves(
    db,
    () => ({ supabase: db, jobName: 'test', caller: 'test', kind: 'job', maxCalls: 0 }) as never,
    NOW, 'startup', spy as never, {},
  )
  eq(result.credits, 0)
  eq(result.scored, 2)
})

Deno.test('a caller may lower the liquidity floor for a manual run, and it is honoured', async () => {
  const tables = {
    market_asset_candles: [
      ...candleRows('bip122:native:BTC', 'binance', '2026-09-19', [...alternating(92), 0.005]),
      ...candleRows('eip155:1:thin', 'binance', '2026-09-19', [...alternating(92), 0.4]),
    ],
    market_asset_candle_backfill: [
      { asset_key: 'bip122:native:BTC', cmc_id: '1', symbol: 'BTC' },
      { asset_key: 'eip155:1:thin', cmc_id: '9001', symbol: 'THIN' },
    ],
    market_assets: [
      { source_provider: 'coinmarketcap', provider_id: '1', symbol: 'BTC', name: 'Bitcoin', market_cap_rank: 1, market_cap: 1, volume_24h: 2.1e10, categories: [], as_of: null },
      { source_provider: 'coinmarketcap', provider_id: '9001', symbol: 'THIN', name: 'Thin', market_cap_rank: 900, market_cap: 1, volume_24h: 4_000, categories: [], as_of: null },
    ],
    intel_unusual_move_scores: [], provider_schedule_policy: [],
  }
  eq((await captureUnusualMoves(fakeDb(tables), NOW)).scored, 1)
  eq((await captureUnusualMoves(fakeDb(tables), NOW, { liquidityFloorUsd: 1_000 })).scored, 2)
})
