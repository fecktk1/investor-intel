import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  captureRwaWrappers, candidateSeed, rankCandidates, assetRow, tokenRows, lanePolicy,
  RWA_WRAPPER_CAPTURE_OPS, RWA_WRAPPER_CAPTURE_SCHEDULE, RWA_WRAPPER_ASSET_CAP, RWA_WRAPPER_MAX_TYPES,
  RWA_WRAPPER_DEFAULT_TYPES, RWA_WRAPPER_CADENCE_SECONDS, ASSET_TABLE, TOKEN_TABLE, UNIVERSE_TABLE,
} from './capture-rwa-wrappers.ts'
import { wrapperAssetFromQuote, assetListFigures, wrapperSpread, LIQUIDITY_FLOOR_USD } from './rwa-wrapper-spread.ts'
import { cmcRows } from '../market-assets/cmc-capabilities.ts'
import { CATALOGUE_TABLE, readRwaWrappers, premiumPoints, rankAssets } from './capture-rwa-wrappers-read.ts'

// A week in the past keeps every provider timestamp behind the real clock.
const NOW = new Date(Math.floor((Date.now() - 7 * 86_400_000) / 3_600_000) * 3_600_000)
const HOUR = NOW.toISOString()

/** Minimal PostgREST-shaped fake: eq/in filters, order, limit and upsert. Every
 * chain in the lane ends in `.limit()` or `.upsert()`. */
// deno-lint-ignore no-explicit-any
function fakeDb(tables: Record<string, any[]> = {}, writes: Record<string, any[]> = {}, errors: Record<string, string> = {}) {
  const compare = (a: unknown, b: unknown) => {
    const [x, y] = [Number(a), Number(b)]
    return Number.isFinite(x) && Number.isFinite(y) ? x - y : String(a ?? '').localeCompare(String(b ?? ''))
  }
  return {
    upserts: writes,
    from(table: string) {
      // deno-lint-ignore no-explicit-any
      const filters: [string, string, any][] = []
      let ordering: { column: string; ascending: boolean } | null = null
      const run = (max: number | null) => {
        if (errors[table]) return { data: null, error: { message: errors[table] } }
        let rows = [...(tables[table] || [])]
        for (const [key, op, operand] of filters) {
          rows = rows.filter((row) => {
            const v = row?.[key]
            if (op === 'eq') return String(v ?? '') === String(operand ?? '')
            // deno-lint-ignore no-explicit-any
            if (op === 'in') return (operand as any[]).some((o) => String(o) === String(v))
            return true
          })
        }
        if (ordering) rows.sort((a, b) => compare(a?.[ordering!.column], b?.[ordering!.column]) * (ordering!.ascending ? 1 : -1))
        return { data: max == null ? rows : rows.slice(0, max), error: null }
      }
      // deno-lint-ignore no-explicit-any
      const q: any = {
        select: () => q,
        // deno-lint-ignore no-explicit-any
        eq: (k: string, v: any) => { filters.push([k, 'eq', v]); return q },
        // deno-lint-ignore no-explicit-any
        in: (k: string, v: any[]) => { filters.push([k, 'in', v]); return q },
        // deno-lint-ignore no-explicit-any
        order: (column: string, options: any = {}) => { ordering = { column, ascending: options?.ascending !== false }; return q },
        limit: (max: number) => Promise.resolve(run(max)),
        // deno-lint-ignore no-explicit-any
        upsert: (rows: any[]) => { (writes[table] ||= []).push(...rows); return Promise.resolve({ error: null }) },
      }
      return q
    },
  }
}

const ctxFor = (name: string, maxCalls: number) => ({ jobName: 'test', caller: name, kind: 'job' as const, maxCalls })

/** Records every provider call, so the lane's call and credit ceilings are
 * checked rather than assumed. */
// deno-lint-ignore no-explicit-any
function fakeRequest(handler: (name: string, params: Record<string, unknown>) => any) {
  const calls: { name: string; params: Record<string, unknown> }[] = []
  // deno-lint-ignore no-explicit-any
  const request = (name: string, params: Record<string, unknown> = {}, _ctx?: any) => {
    calls.push({ name, params })
    return Promise.resolve(handler(name, params))
  }
  return { request, calls }
}

// ─── Provider fixtures, shaped like the live responses ────────────────────────

const usdQuote = (fields: Record<string, unknown>) => ({ quotes: [{ crypto_id: 2781, symbol: 'USD', last_updated: '2026-09-20T14:25:00.000Z', ...fields }] })

const listRow = (rwaId: number, symbol: string, name: string, assetType: string, cap: number | null, rank: number, hasTokens = true) => ({
  rwa_id: rwaId, name, symbol, slug: symbol.toLowerCase(), asset_type: assetType, rwa_rank: rank, has_tokens: hasTokens,
  last_updated: '2026-09-20T14:00:00.000Z',
  // The list read has its OWN quote clock, twenty-five minutes behind the quotes
  // read. That difference is the point: a reconciliation has to carry both.
  ...usdQuote({ last_updated: '2026-09-20T14:00:00.000Z', average_tokenized_price: 100, tokenized_market_cap: cap, tokenized_volume_24h: 500_000 }),
})

/** The list row as the lane sees it: through `cmcRows`, which folds the USD entry
 * of `quotes[]` onto `row.quote`. Reading the bare fixture would test a shape the
 * production path never hands the parser. */
const listFigures = (row: unknown) => assetListFigures(cmcRows('rwaList', { data: { rwa_assets: [row] } }).rows[0])!

const token = (cryptoId: number, symbol: string, name: string, issuer: string, price: number | null, cap: number | null, volume: number | null) =>
  ({ crypto_id: cryptoId, symbol, name, issuer_id: issuer, issuer_name: `${issuer} Ltd`, price, market_cap: cap, volume_24h: volume })

const GOLD_TOKENS = [
  token(5176, 'XAUT', 'Tether Gold', 'tether', 4369.87655050591, 2721662504.88916, 70850040.1787824),
  token(4705, 'PAXG', 'PAX Gold', 'paxos', 4360.15119254379, 1894482935.53469, 60073206.368403),
  token(34212, 'XAUM', 'Matrixdock Gold', 'matrixdock', 4366.34720490711, 47922088.1839527, 426153.25010507),
  token(20245, 'CGO', 'Comtech Gold', 'comtech', 139.431099492873, 19659785.0284951, 922206.18079095),
]

const quoteRow = (rwaId: number, symbol: string, name: string, assetType: string, cap: number | null, tokens: unknown[]) => ({
  rwa_id: rwaId, name, symbol, asset_type: assetType, rwa_rank: 1, has_tokens: true,
  last_updated: '2026-09-20T14:25:00.000Z',
  ...usdQuote({ average_tokenized_price: 4363.25, tokenized_market_cap: cap, tokenized_volume_24h: 132271000 }),
  tokens,
})

/** A complete provider handler: two list pages, one map, one quotes call. */
function handler(options: { listCap?: number | null; quotesTokens?: unknown[]; failList?: boolean; failQuotes?: boolean } = {}) {
  return (name: string, params: Record<string, unknown>) => {
    if (name === 'rwaList') {
      if (options.failList) return { payload: null, reason: 'rate_limited' }
      const type = String(params.asset_type)
      if (type === 'commodity') return { payload: { data: { rwa_assets: [listRow(1, 'GOLD', 'Gold', 'commodity', options.listCap === undefined ? 4706435873.737661 : options.listCap, 1), listRow(5, 'SILVER', 'Silver', 'commodity', 0, 9)] } } }
      if (type === 'stock') return { payload: { data: { rwa_assets: [listRow(2, 'NVDA', 'Nvidia Corp', 'stock', 134448519.41406974, 2), listRow(9, 'SPCX', 'SpaceX', 'stock', 213245211.5150289, 3, false)] } } }
      return { payload: { data: { rwa_assets: [] } } }
    }
    if (name === 'rwaMap') return { payload: { data: { rwa_assets: [{ rwa_id: 8065, name: 'SK Hynix', symbol: 'SKHY', slug: 'sk-hynix', asset_type: 'stock', rwa_rank: 90, has_tokens: true }] } } }
    if (name === 'rwaQuotes') {
      if (options.failQuotes) return { payload: null, reason: 'provider_unavailable' }
      return { payload: { data: { rwa_assets: options.quotesTokens ? [quoteRow(1, 'GOLD', 'Gold', 'commodity', 4706435873.737661, options.quotesTokens)] : [
        quoteRow(1, 'GOLD', 'Gold', 'commodity', 4706435873.737661, GOLD_TOKENS),
        // A single-wrapper asset: already answered by the RWA universe panel, so
        // it must not pad this table with a structurally absent dispersion.
        quoteRow(2, 'NVDA', 'Nvidia Corp', 'stock', 134448519.41406974, [token(70001, 'NVDAX', 'Nvidia xStock', 'backed', 176.2, 134448519.41406974, 900_000)]),
      ] } } }
    }
    return { payload: null, reason: 'unexpected_capability' }
  }
}

const universeRows = (capturedAt: string) => [
  { asset_type: 'commodity', captured_at: capturedAt, asset_count: 4, total_market_value_usd: 4706435873.737661, top_assets: [{ rwa_id: 1, symbol: 'GOLD', name: 'Gold', value: 4706435873.737661 }, { rwa_id: 5, symbol: 'SILVER', name: 'Silver', value: 0 }] },
  { asset_type: 'stock', captured_at: capturedAt, asset_count: 250, total_market_value_usd: 1331821155.2348022, top_assets: [{ rwa_id: 2, symbol: 'NVDA', name: 'Nvidia Corp', value: 134448519.41406974 }, { rwa_id: 8065, symbol: 'SKHY', name: 'SK Hynix', value: 35588029.87281449 }] },
  { asset_type: 'etf', captured_at: capturedAt, asset_count: 250, total_market_value_usd: 15275.24356881444, top_assets: [] },
  // Three types the provider currently reports nothing for. Paying a credit to
  // be told again that there are none is a credit spent on nothing.
  { asset_type: 'currency', captured_at: capturedAt, asset_count: 0, total_market_value_usd: null, top_assets: [] },
  { asset_type: 'government_security', captured_at: capturedAt, asset_count: 0, total_market_value_usd: null, top_assets: [] },
  { asset_type: 'real_estate', captured_at: capturedAt, asset_count: 0, total_market_value_usd: null, top_assets: [] },
  { asset_type: 'all', captured_at: capturedAt, asset_count: 504, total_market_value_usd: 6038272304.216032, top_assets: [{ rwa_id: 1, symbol: 'GOLD', name: 'Gold', value: 4706435873.737661 }] },
]

// ─── Candidate selection ──────────────────────────────────────────────────────

Deno.test('only asset types the provider currently reports anything for are called', () => {
  const seed = candidateSeed(universeRows(HOUR))
  // Ordered by reported value, and the three empty types are not called at all.
  eq(seed.assetTypes, ['commodity', 'stock', 'etf'])
  assert(!seed.assetTypes.includes('currency'))
  assert(seed.universeIds.includes('1'))
  assert(seed.universeIds.includes('8065'))
  eq(seed.reason, null)
  // Only the newest capture hour seeds the run: an older hour's types would send
  // the lane after a universe that has since changed shape.
  const mixed = candidateSeed([...universeRows('2026-01-01T00:00:00.000Z'), { asset_type: 'real_estate', captured_at: HOUR, asset_count: 3, total_market_value_usd: 5, top_assets: [{ rwa_id: 77 }] }])
  eq(mixed.assetTypes, ['real_estate'])
  eq(mixed.universeIds, ['77'])
  // An empty universe table still produces a set, and says why it is the default.
  const empty = candidateSeed([])
  eq(empty.assetTypes, [...RWA_WRAPPER_DEFAULT_TYPES].slice(0, RWA_WRAPPER_MAX_TYPES))
  eq(empty.reason, 'universe_not_captured')
})

Deno.test('an asset that already showed two or more wrappers stays in the set', () => {
  const figures = new Map([
    ['2', listFigures(listRow(2, 'NVDA', 'Nvidia Corp', 'stock', 134448519.41406974, 2))],
    ['1', listFigures(listRow(1, 'GOLD', 'Gold', 'commodity', 4706435873.737661, 1))],
    ['9', listFigures(listRow(9, 'SPCX', 'SpaceX', 'stock', 213245211.5150289, 3, false))],
  ])
  // Gold is sticky, so it leads even though Nvidia and SpaceX are ranked above it
  // by nothing but list order.
  const ranked = rankCandidates(figures, { sticky: ['1'], universeIds: ['8065'] })
  eq(ranked[0], '1')
  // `has_tokens: false` is honoured: an asset the provider says has no tokens
  // cannot have two wrappers, so it is never paid for.
  assert(!ranked.includes('9'))
  // A universe id with no list row is still a candidate; the map resolves it.
  assert(ranked.includes('8065'))
  // The remainder is ranked by the list endpoint's own tokenised market cap, so
  // SpaceX would have led it had the provider not said it has no tokens.
  eq(ranked.filter((id) => id !== '1')[0], '2')
  // The set is capped, and the cap is one credit's worth.
  const many = new Map([...Array(200)].map((_, i) => [String(i + 1), listFigures(listRow(i + 1, `S${i}`, `Asset ${i}`, 'stock', 1000 - i, i + 1))] as const))
  eq(rankCandidates(many, { sticky: [], universeIds: [] }).length, RWA_WRAPPER_ASSET_CAP)
  eq(rankCandidates(many, { sticky: [], universeIds: [], cap: 5 }).length, 5)
})

// ─── Row building ─────────────────────────────────────────────────────────────

Deno.test('an asset row carries both endpoints, both clocks and the reconciliation', () => {
  const asset = wrapperAssetFromQuote(cmcRows('rwaQuotes', { data: { rwa_assets: [quoteRow(1, 'GOLD', 'Gold', 'commodity', 4706435873.737661, GOLD_TOKENS)] } }).rows[0])!
  const spread = wrapperSpread(asset)
  const list = listFigures(listRow(1, 'GOLD', 'Gold', 'commodity', 4706435873.737661, 1))
  const row = assetRow(spread, list, { capturedAt: HOUR, listCapturedAt: HOUR, listObservedAt: '2026-09-20T14:00:00.000Z', fetchedAt: HOUR, floor: LIQUIDITY_FLOOR_USD })
  eq(row.rwa_id, '1')
  eq(row.anchor_kind, 'liquid_wrapper_median')
  eq(row.anchor_members, 4)
  eq(row.list_tokenized_market_cap, 4706435873.737661)
  eq(row.list_observed_at, '2026-09-20T14:00:00.000Z')
  eq(row.source_observed_at, '2026-09-20T14:25:00.000Z')
  eq(row.reconcile_state, 'agree')
  eq(row.volume_floor_usd, LIQUIDITY_FLOOR_USD)
  eq(row.weight_denominated, true)
  eq(row.unit_normalised_count, 1)
  assert(typeof row.scope === 'string' && (row.scope as string).includes('not a tradable arbitrage'))

  const wrappers = tokenRows(spread, { capturedAt: HOUR, fetchedAt: HOUR })
  eq(wrappers.length, 4)
  const cgo = wrappers.find((r) => r.crypto_id === '20245')!
  eq(cgo.unit_state, 'normalised_troy_ounce')
  eq(cgo.wrapper_state, 'liquid')
  // A premium and an accrual gap are separate columns, and only one is ever set.
  eq(cgo.accrual_gap_bps, null)
  assert(cgo.premium_bps != null)

  // A list row that never arrived is a stated reason, not a ratio of 1.
  const orphan = assetRow(spread, null, { capturedAt: HOUR, listCapturedAt: null, listObservedAt: null, fetchedAt: HOUR, floor: LIQUIDITY_FLOOR_USD })
  eq(orphan.reconcile_state, 'not_comparable')
  eq(orphan.reconcile_reason, 'list_value_not_reported')
  eq(orphan.reconcile_ratio, null)
})

// ─── The lane ─────────────────────────────────────────────────────────────────

Deno.test('one run spends at most five credits and six calls, and writes both tables', async () => {
  const writes: Record<string, unknown[]> = {}
  const db = fakeDb({ [UNIVERSE_TABLE]: universeRows(HOUR) }, writes)
  const { request, calls } = fakeRequest(handler())
  const result = await captureRwaWrappers(db, ctxFor, NOW, { request })

  eq(result.error, undefined)
  eq(result.credits, 4) // three list pages, plus one quotes call; the map is free
  eq(result.calls, 5)
  eq(calls.filter((c) => c.name === 'rwaList').length, 3)
  eq(calls.filter((c) => c.name === 'rwaMap').length, 1)
  eq(calls.filter((c) => c.name === 'rwaQuotes').length, 1)
  // ONE quotes call carries every candidate, comma-joined, which is what makes
  // the whole set cost a single credit.
  const quotes = calls.find((c) => c.name === 'rwaQuotes')!
  assert(String(quotes.params.rwa_id).includes(','))
  assert(String(quotes.params.rwa_id).split(',').length <= RWA_WRAPPER_ASSET_CAP)
  // The list read is sorted by tokenised market cap so the top of each type is
  // what a 250-row page actually contains.
  eq(calls[0].params.sort, 'tokenized_market_cap')
  eq(calls[0].params.sort_dir, 'desc')

  // Only the multi-wrapper asset is stored.
  eq((writes[ASSET_TABLE] || []).length, 1)
  eq((writes[TOKEN_TABLE] || []).length, 4)
  eq(result.multiWrapper, 1)
  eq(result.anchored, 1)
  eq(result.rows, 5)
  // The wrappers are written BEFORE the assets, because the cadence guard reads
  // the asset table: a partial write must not make the next run skip the hour.
  eq(Object.keys(writes)[0], TOKEN_TABLE)
  // deno-lint-ignore no-explicit-any
  eq((writes[ASSET_TABLE][0] as any).captured_at, HOUR)
})

Deno.test('the lane obeys its policy row, its cadence and its call budget', async () => {
  const disabled = await captureRwaWrappers(fakeDb(), ctxFor, NOW, { request: () => Promise.resolve(null), policy: [{ feature: 'rwa_wrappers', enabled: false }] })
  eq(disabled.skipped, 'policy_disabled')
  eq(disabled.credits, 0)

  // A capture inside the cadence is skipped without a single provider call.
  const writes: Record<string, unknown[]> = {}
  const { request, calls } = fakeRequest(handler())
  const recent = await captureRwaWrappers(
    fakeDb({ [UNIVERSE_TABLE]: universeRows(HOUR), [ASSET_TABLE]: [{ rwa_id: '1', captured_at: HOUR, wrapper_count: 4 }] }, writes),
    ctxFor, NOW, { request },
  )
  eq(recent.skipped, 'within_cadence')
  eq(calls.length, 0)
  eq(recent.credits, 0)

  // Six hours later the same row no longer blocks the run.
  const later = new Date(NOW.getTime() + 6 * 3_600_000)
  const after = await captureRwaWrappers(
    fakeDb({ [UNIVERSE_TABLE]: universeRows(HOUR), [ASSET_TABLE]: [{ rwa_id: '1', captured_at: HOUR, wrapper_count: 4 }] }, {}),
    ctxFor, later, { request: fakeRequest(handler()).request },
  )
  eq(after.skipped, undefined)
  eq(after.multiWrapper, 1)

  // The default cadence is six hours, not the one-hour fallback the shared
  // helper would hand an unknown feature.
  eq(lanePolicy({ request: () => Promise.resolve(null) }).cadenceSeconds, RWA_WRAPPER_CADENCE_SECONDS)
  eq(lanePolicy({ request: () => Promise.resolve(null), policy: [{ feature: 'rwa_wrappers', cadence_seconds: 3600 }] }).cadenceSeconds, 3600)

  // A budget that cannot cover a list page and the quotes call spends nothing.
  const starved = await captureRwaWrappers(fakeDb({ [UNIVERSE_TABLE]: universeRows(HOUR) }), (n, m) => ctxFor(n, Math.min(m, 1)), NOW, { request: fakeRequest(handler()).request })
  eq(starved.skipped, 'call_budget')
  eq(starved.credits, 0)
})

Deno.test('a failed list page narrows the run instead of ending it, and a failed quotes call is an error', async () => {
  // Every list page failed, so the candidates come from the universe rows and the
  // free map alone, and the reconciliation has no list side to compare against.
  const writes: Record<string, unknown[]> = {}
  const partial = await captureRwaWrappers(
    fakeDb({ [UNIVERSE_TABLE]: universeRows(HOUR) }, writes), ctxFor, NOW,
    { request: fakeRequest(handler({ failList: true })).request },
  )
  eq(partial.partial, 'rate_limited')
  eq(partial.multiWrapper, 1)
  // deno-lint-ignore no-explicit-any
  const row = writes[ASSET_TABLE][0] as any
  eq(row.reconcile_state, 'not_comparable')
  eq(row.reconcile_reason, 'list_value_not_reported')
  eq(row.list_captured_at, null)
  // The premium side is untouched by the list failure: it comes from quotes.
  eq(row.anchor_kind, 'liquid_wrapper_median')

  const failed = await captureRwaWrappers(
    fakeDb({ [UNIVERSE_TABLE]: universeRows(HOUR) }), ctxFor, NOW,
    { request: fakeRequest(handler({ failQuotes: true })).request },
  )
  eq(failed.error, 'provider_unavailable')
  eq(failed.rows, 0)

  // An unreadable universe table is a partial, not a dead run: the list pages
  // still supply candidates from the documented default types.
  const noUniverse = await captureRwaWrappers(
    fakeDb({}, {}, { [UNIVERSE_TABLE]: 'permission denied' }), ctxFor, NOW,
    { request: fakeRequest(handler()).request },
  )
  eq(noUniverse.partial, 'universe_read_failed')
  eq(noUniverse.multiWrapper, 1)
})

Deno.test('the list endpoint zero survives the whole lane as a stated disagreement', async () => {
  const writes: Record<string, unknown[]> = {}
  // Silver: the list endpoint prices it at 0 while its wrappers report a value.
  const silverTokens = [
    token(80001, 'SLVA', 'Silver Wrapper A', 'a', 53.2, 4_000_000, 600_000),
    token(80002, 'SLVB', 'Silver Wrapper B', 'b', 53.6, 2_500_000, 400_000),
  ]
  const request = (name: string, params: Record<string, unknown>) => {
    if (name === 'rwaList') return Promise.resolve({ payload: { data: { rwa_assets: [listRow(5, 'SILVER', 'Silver', 'commodity', 0, 9)] } } })
    if (name === 'rwaMap') return Promise.resolve({ payload: { data: { rwa_assets: [] } } })
    if (name === 'rwaQuotes') return Promise.resolve({ payload: { data: { rwa_assets: [{ ...quoteRow(5, 'SILVER', 'Silver', 'commodity', 6_500_000, silverTokens) }] } } })
    return Promise.resolve({ payload: null, reason: `unexpected_${String(params.x)}` })
  }
  const result = await captureRwaWrappers(fakeDb({ [UNIVERSE_TABLE]: universeRows(HOUR) }, writes), ctxFor, NOW, { request })
  eq(result.outsideBand, 1)
  // deno-lint-ignore no-explicit-any
  const row = writes[ASSET_TABLE][0] as any
  eq(row.list_tokenized_market_cap, 0)
  eq(row.token_market_cap_sum, 6_500_000)
  eq(row.reconcile_state, 'outside_band')
  eq(row.reconcile_reason, 'list_endpoint_reports_zero')
  // No ratio: dividing by the provider's zero is not a finding, the zero is.
  eq(row.reconcile_ratio, null)
})

Deno.test('the lane is registered under its own op name and its cron matches the migration', async () => {
  eq(Object.keys(RWA_WRAPPER_CAPTURE_OPS), ['rwa_wrappers'])
  const result = await RWA_WRAPPER_CAPTURE_OPS.rwa_wrappers(
    fakeDb({ [UNIVERSE_TABLE]: universeRows(HOUR) }), ctxFor, NOW, 'startup', { request: fakeRequest(handler()).request },
  )
  eq(result.job, 'rwa_wrappers')
  // The schedule the read view advertises has to be the schedule the migration
  // actually installs, or an empty panel tells a reader the wrong thing.
  const sql = await Deno.readTextFile(new URL('../../../migrations/20260920150000_intel_rwa_wrapper_spread.sql', import.meta.url))
  assert(sql.includes(RWA_WRAPPER_CAPTURE_SCHEDULE.rwa_wrappers.job))
  assert(sql.includes(`'${RWA_WRAPPER_CAPTURE_SCHEDULE.rwa_wrappers.cron}'`))
  assert(sql.includes(`'rwa_wrappers', ${RWA_WRAPPER_CADENCE_SECONDS}`))
})

// ─── The read view ────────────────────────────────────────────────────────────

/** The rows one run of the lane actually wrote, read back through the view. */
async function captureThenRead(handlerOptions = {}) {
  const writes: Record<string, unknown[]> = {}
  await captureRwaWrappers(fakeDb({ [UNIVERSE_TABLE]: universeRows(HOUR) }, writes), ctxFor, NOW, { request: fakeRequest(handler(handlerOptions)).request })
  const db = fakeDb({ [ASSET_TABLE]: writes[ASSET_TABLE] || [], [TOKEN_TABLE]: writes[TOKEN_TABLE] || [] })
  return await readRwaWrappers(db, {}, NOW.getTime())
}

Deno.test('the read view answers with the newest hour, its wrappers and its chart points', async () => {
  const view = await captureThenRead()
  eq(view.view, 'rwa_wrappers')
  eq(view.asOf, HOUR)
  eq(view.reason, null)
  // deno-lint-ignore no-explicit-any
  const rows = view.rows as any[]
  eq(rows.length, 1)
  eq(rows[0].rwaId, '1')
  eq(rows[0].anchorKind, 'liquid_wrapper_median')
  eq(rows[0].tokens.length, 4)
  // Dearest wrapper first inside an asset.
  eq(rows[0].tokens[0].cryptoId, '5176')
  eq(rows[0].tokens.at(-1).cryptoId, '20245')
  assert(rows[0].anchorMeaning.includes('volume-weighted median'))
  // deno-lint-ignore no-explicit-any
  const summary = view.summary as any
  eq(summary.assets, 1)
  eq(summary.wrappers, 4)
  eq(summary.medianAnchored, 1)
  eq(summary.navAnchored, 0)
  eq(summary.unitNormalised, 1)
  eq(summary.reconcileAgree, 1)
  // One dot per wrapper that carries a premium and a volume.
  // deno-lint-ignore no-explicit-any
  const points = view.points as any[]
  eq(points.length, 4)
  eq(points[0].assetSymbol, 'GOLD')
  assert(points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)))
  // Both endpoints are named on the payload rather than restated in the page.
  // deno-lint-ignore no-explicit-any
  eq((view.endpoints as any[]).map((e) => e.capability), ['rwaQuotes', 'rwaList'])
  // deno-lint-ignore no-explicit-any
  eq((view.reconciliation as any[]).length, 1)
})

Deno.test('an uncaptured table is an empty view carrying its schedule, never an error', async () => {
  const view = await readRwaWrappers(fakeDb(), {}, NOW.getTime())
  eq(view.asOf, null)
  eq(view.reason, null)
  // deno-lint-ignore no-explicit-any
  eq((view.rows as any[]).length, 0)
  eq(view.coverage, { from: null, to: null, count: 0 })
  // deno-lint-ignore no-explicit-any
  eq((view.schedule as any).rwa_wrappers.cron, RWA_WRAPPER_CAPTURE_SCHEDULE.rwa_wrappers.cron)
  // A failed read is a reason on an empty view, not a thrown error.
  const broken = await readRwaWrappers(fakeDb({}, {}, { [ASSET_TABLE]: 'permission denied for table' }), {}, NOW.getTime())
  eq(broken.reason, 'permission denied for table')
  eq(broken.asOf, null)
})

Deno.test('the view never mixes two capture hours', async () => {
  const older = new Date(NOW.getTime() - 6 * 3_600_000).toISOString()
  const db = fakeDb({
    [ASSET_TABLE]: [
      { provider: 'coinmarketcap', rwa_id: '1', captured_at: HOUR, symbol: 'GOLD', wrapper_count: 4, anchor_kind: 'liquid_wrapper_median', anchor_price: 4369.87, dispersion_bps: 75.7, reconcile_state: 'agree', reconcile_ratio: 0.995 },
      { provider: 'coinmarketcap', rwa_id: '5', captured_at: older, symbol: 'SILVER', wrapper_count: 2, anchor_kind: 'liquid_wrapper_median', anchor_price: 53.2, dispersion_bps: 400, reconcile_state: 'outside_band' },
    ],
    [TOKEN_TABLE]: [
      { rwa_id: '1', crypto_id: '5176', captured_at: HOUR, symbol: 'XAUT', premium_bps: 0, volume_24h: 70850040, wrapper_state: 'liquid', in_anchor: true },
      { rwa_id: '5', crypto_id: '80001', captured_at: older, symbol: 'SLVA', premium_bps: -200, volume_24h: 600000, wrapper_state: 'liquid', in_anchor: true },
    ],
  })
  const view = await readRwaWrappers(db, {}, NOW.getTime())
  eq(view.asOf, HOUR)
  // deno-lint-ignore no-explicit-any
  const rows = view.rows as any[]
  eq(rows.length, 1)
  eq(rows[0].rwaId, '1')
  eq(rows[0].tokens.length, 1)
  // Coverage still reports the whole window the read actually spanned.
  // deno-lint-ignore no-explicit-any
  eq((view.coverage as any).from, older)
})

Deno.test('ranking and plotting refuse to turn an absent figure into a zero', () => {
  const ranked = rankAssets([
    { rwaId: '1', dispersionBps: null, tokenizedVolume24h: 10, rwaRank: 1, tokens: [] },
    { rwaId: '2', dispersionBps: 5, tokenizedVolume24h: 1, rwaRank: 2, tokens: [] },
    { rwaId: '3', dispersionBps: -80, tokenizedVolume24h: 1, rwaRank: 3, tokens: [] },
  ])
  // Widest absolute dispersion first; the asset with none sorts last and is kept.
  eq(ranked.map((r) => r.rwaId), ['3', '2', '1'])
  // A wrapper with no premium or no volume is not a dot at the origin.
  const points = premiumPoints([{
    rwaId: '1', symbol: 'GOLD', name: 'Gold',
    tokens: [
      { cryptoId: '1', symbol: 'A', premiumBps: 10, volume24h: 5, state: 'liquid', inAnchor: true },
      { cryptoId: '2', symbol: 'B', premiumBps: null, volume24h: 5, state: 'unit_not_established', inAnchor: false },
      { cryptoId: '3', symbol: 'C', premiumBps: 10, volume24h: null, state: 'volume_not_reported', inAnchor: false },
    ],
  }])
  eq(points.length, 1)
  eq(points[0].cryptoId, '1')
})

// ─── Logos, joined server side ────────────────────────────────────────────────
//
// The board shows an image for the UNDERLYING asset and one for every wrapper
// TOKEN. Both are joined here, in the read, so the surface makes ONE request for
// the whole board rather than one per row.

Deno.test('the read joins the underlying profile logo and each wrapper token logo, https only', async () => {
  const db = fakeDb({
    [ASSET_TABLE]: [
      { provider: 'coinmarketcap', rwa_id: '1', captured_at: HOUR, symbol: 'GOLD', name: 'Gold', wrapper_count: 3, anchor_kind: 'liquid_wrapper_median', anchor_price: 4369.87, dispersion_bps: 75.7, cheapest_crypto_id: '20245', reconcile_state: 'agree', reconcile_ratio: 0.995 },
    ],
    [TOKEN_TABLE]: [
      { rwa_id: '1', crypto_id: '5176', captured_at: HOUR, symbol: 'XAUT', premium_bps: 0, volume_24h: 70850040, wrapper_state: 'liquid', in_anchor: true },
      { rwa_id: '1', crypto_id: '20245', captured_at: HOUR, symbol: 'CGO', premium_bps: -75.7, volume_24h: 922206, wrapper_state: 'liquid', in_anchor: true },
      { rwa_id: '1', crypto_id: '31411', captured_at: HOUR, symbol: 'XAUTT', wrapper_state: 'no_price' },
    ],
    'intel_rwa_asset_profiles': [
      { rwa_id: '1', logo_url: 'https://s2.coinmarketcap.com/static/img/rwa/gold.png' },
    ],
    [CATALOGUE_TABLE]: [
      // The provider is part of the key: a catalogue row from another provider
      // that happens to share an id must never be read as this token's image.
      { source_provider: 'coingecko', provider_id: '5176', cached_image_url: 'https://cdn.example/WRONG.png', image_url: null },
      { source_provider: 'coinmarketcap', provider_id: '5176', cached_image_url: 'https://cdn.example/xaut.png', image_url: 'https://s2.coinmarketcap.com/xaut.png' },
      // Only the provider's own URL is stored: it becomes the image, and there
      // is no second candidate to fall back to.
      { source_provider: 'coinmarketcap', provider_id: '20245', cached_image_url: null, image_url: 'https://s2.coinmarketcap.com/cgo.png' },
      // An http URL is never put into an <img> on our page.
      { source_provider: 'coinmarketcap', provider_id: '31411', cached_image_url: 'http://insecure.example/x.png', image_url: null },
    ],
  })
  const view = await readRwaWrappers(db, {}, NOW.getTime())
  // deno-lint-ignore no-explicit-any
  const row = (view.rows as any[])[0]
  eq(row.logoUrl, 'https://s2.coinmarketcap.com/static/img/rwa/gold.png')
  // deno-lint-ignore no-explicit-any
  const byId = new Map(row.tokens.map((token: any) => [token.cryptoId, token]))
  // The mirrored copy leads, the provider's own URL is the fallback candidate.
  eq(byId.get('5176').logoUrl, 'https://cdn.example/xaut.png')
  eq(byId.get('5176').fallbackLogoUrl, 'https://s2.coinmarketcap.com/xaut.png')
  eq(byId.get('20245').logoUrl, 'https://s2.coinmarketcap.com/cgo.png')
  eq(byId.get('20245').fallbackLogoUrl, 'https://s2.coinmarketcap.com/cgo.png')
  eq(byId.get('31411').logoUrl, null)
  // The reconciliation table names the same assets, so it carries the same image.
  // deno-lint-ignore no-explicit-any
  eq((view.reconciliation as any[])[0].logoUrl, 'https://s2.coinmarketcap.com/static/img/rwa/gold.png')
})

Deno.test('a failed logo read leaves the images null and never fails the board', async () => {
  const db = fakeDb({
    [ASSET_TABLE]: [
      { provider: 'coinmarketcap', rwa_id: '1', captured_at: HOUR, symbol: 'GOLD', name: 'Gold', wrapper_count: 1, anchor_kind: 'liquid_wrapper_median', anchor_price: 4369.87, dispersion_bps: 75.7 },
    ],
    [TOKEN_TABLE]: [
      { rwa_id: '1', crypto_id: '5176', captured_at: HOUR, symbol: 'XAUT', premium_bps: 0, volume_24h: 70850040, wrapper_state: 'liquid', in_anchor: true },
    ],
  }, {}, { 'intel_rwa_asset_profiles': 'permission denied', [CATALOGUE_TABLE]: 'permission denied' })
  const view = await readRwaWrappers(db, {}, NOW.getTime())
  // deno-lint-ignore no-explicit-any
  const row = (view.rows as any[])[0]
  eq(row.logoUrl, null)
  eq(row.tokens[0].logoUrl, null)
  // An image that did not arrive is a monogram on the surface, not a reason on
  // the board: the FIGURES all read cleanly.
  eq(view.reason, null)
  eq(view.asOf, HOUR)
})
