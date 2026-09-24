import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  captureRwaWrappers, candidateSeed, rankCandidates, assetRow, tokenRows, lanePolicy,
  RWA_WRAPPER_CAPTURE_OPS, RWA_WRAPPER_CAPTURE_SCHEDULE, RWA_WRAPPER_ASSET_CAP, RWA_WRAPPER_MAX_TYPES,
  RWA_WRAPPER_DEFAULT_TYPES, RWA_WRAPPER_CADENCE_SECONDS, ASSET_TABLE, TOKEN_TABLE, UNIVERSE_TABLE,
  REFERENCE_TABLE, captureUnderlyingReferenceForLatest, captureAccrualForLatest,
} from './capture-rwa-wrappers.ts'
import type { AccrualMultiplierSource } from './accrual-multiplier.ts'
import { PROFILE_TABLE, REGISTRANT_TABLE } from './capture-rwa-underlyings.ts'
import type { ReferenceReading, UnderlyingReferenceSource } from './underlying-reference.ts'
import { wrapperAssetFromQuote, assetListFigures, wrapperSpread, LIQUIDITY_FLOOR_USD } from './rwa-wrapper-spread.ts'
import { cmcRows } from '../market-assets/cmc-capabilities.ts'
import { CATALOGUE_TABLE, readRwaWrappers, premiumPoints, rankAssets, underlyingFallbackLogo, cmcCoinLogo } from './capture-rwa-wrappers-read.ts'

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
  // The scheduled lane, the unscheduled one-off fill of its newest capture's
  // stock reference, and the one-off dividend-multiplier recompute of that
  // capture (both zero credits).
  eq(Object.keys(RWA_WRAPPER_CAPTURE_OPS), ['rwa_wrappers', 'rwa_wrapper_reference', 'rwa_wrapper_accrual'])
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
  // An http catalogue URL is refused, so the wrapper falls to the provider's
  // coin image addressed by its CoinMarketCap id. Never by ticker.
  eq(byId.get('31411').logoUrl, 'https://s2.coinmarketcap.com/static/img/coins/64x64/31411.png')
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
  // A commodity never borrows a wrapper's brand as its own picture.
  eq(row.logoUrl, null)
  // The catalogue read failed, so the wrapper shows the image built from its id.
  eq(row.tokens[0].logoUrl, 'https://s2.coinmarketcap.com/static/img/coins/64x64/5176.png')
  // An image that did not arrive is a monogram on the surface, not a reason on
  // the board: the FIGURES all read cleanly.
  eq(view.reason, null)
  eq(view.asOf, HOUR)
})

Deno.test('a stock with no provider logo borrows its largest wrapper image, a commodity never does', () => {
  const tokens = [
    { logoUrl: 'https://cdn.example/small.png', marketCap: 5 },
    { logoUrl: 'https://cdn.example/large.png', marketCap: 900 },
    { logoUrl: null, marketCap: 5000 },
  ]
  eq(underlyingFallbackLogo('stock', tokens), 'https://cdn.example/large.png')
  eq(underlyingFallbackLogo('etf', tokens), 'https://cdn.example/large.png')
  eq(underlyingFallbackLogo('commodity', tokens), null)
  eq(underlyingFallbackLogo('stock', []), null)
  eq(cmcCoinLogo('5176'), 'https://s2.coinmarketcap.com/static/img/coins/64x64/5176.png')
  eq(cmcCoinLogo('0'), null)
  eq(cmcCoinLogo('../x'), null)
})

// ─── The underlying stock reference ───────────────────────────────────────────

/** A stand-in reference source: NVDA at a fixed price, or a failed read. It
 * records every instant it was asked for, so the clock rule is checked. */
function fakeReference(options: { price?: number; fail?: boolean } = {}) {
  const asked: { ticker: string; asOfMs: number }[] = []
  const source: UnderlyingReferenceSource = {
    id: 'chainlink',
    covers: (ticker) => (ticker === 'NVDA' ? { assetType: 'stock' } : null),
    readAsOf(requests) {
      asked.push(...requests)
      return Promise.resolve(new Map(requests.map((r) => {
        const reading: ReferenceReading = {
          source: 'chainlink', ticker: r.ticker, state: options.fail ? 'unavailable' : 'observed',
          reason: options.fail ? 'feed_read_failed' : null, detail: options.fail ? 'rpc_http_503' : null,
          network: 'arbitrum', address: '0x4881a4418b5f2460b21d6f08cd5aa0678a7f262f', feed: 'NVDA / USD', onChainDescription: 'NVDA / USD',
          decimals: 8, deviationPct: 0.5, heartbeatSeconds: 86400, hours: 'nyse_regular',
          roundId: options.fail ? null : '36893488147419103232', price: options.fail ? null : (options.price ?? 176),
          roundUpdatedAt: options.fail ? null : new Date(r.asOfMs - 1800_000).toISOString(), ageSeconds: options.fail ? null : 1800,
          comparedAt: new Date(r.asOfMs).toISOString(), session: 'regular', roundsRead: 1,
        }
        return [`${r.ticker}@${r.asOfMs}`, reading] as const
      })))
    },
  }
  return { source, asked }
}

const NVDA_TOKENS = [
  token(70001, 'NVDAX', 'Nvidia xStock', 'backed', 176.2, 134448519.41406974, 900_000),
  token(70002, 'NVDAon', 'NVIDIA (Ondo Tokenized)', 'ondo', 176.9, 50_000_000, 2_000_000),
]
const stockHandler = () => {
  const base = handler()
  return (name: string, params: Record<string, unknown>) => {
    if (name !== 'rwaQuotes') return base(name, params)
    return { payload: { data: { rwa_assets: [
      quoteRow(1, 'GOLD', 'Gold', 'commodity', 4706435873.737661, GOLD_TOKENS),
      { ...quoteRow(2, 'NVDA', 'Nvidia Corp', 'stock', 184448519, NVDA_TOKENS), tradfi_markets: [{ ticker: 'NVDA', exchange: { name: 'Binance' } }] },
    ] } } }
  }
}

Deno.test('reference: the lane stores the stock beside the anchor, read at the wrapper prices own clock', async () => {
  const writes: Record<string, unknown[]> = {}
  const ref = fakeReference({ price: 176 })
  const result = await captureRwaWrappers(
    fakeDb({ [UNIVERSE_TABLE]: universeRows(HOUR), [PROFILE_TABLE]: [{ rwa_id: 2, primary_exchange: 'Nasdaq' }], [REGISTRANT_TABLE]: [{ rwa_id: 2, tickers: ['NVDA'] }] }, writes),
    ctxFor, NOW, { request: fakeRequest(stockHandler()).request, referenceSource: ref.source },
  )
  // Zero credits for the reference: the lane's own ceiling is unchanged.
  assert(result.credits <= 5)
  // deno-lint-ignore no-explicit-any
  const reference = result.reference as any
  eq(reference.stockAssets, 1)
  eq(reference.observed, 1)
  eq(reference.stored, 1)
  // Read at the provider's quote clock, never at the capture hour.
  eq(ref.asked, [{ ticker: 'NVDA', asOfMs: Date.parse('2026-09-20T14:25:00.000Z') }])
  // deno-lint-ignore no-explicit-any
  const assets = writes[ASSET_TABLE] as any[]
  const nvda = assets.find((row) => row.rwa_id === '2')
  const gold = assets.find((row) => row.rwa_id === '1')
  eq(nvda.anchor_kind, 'liquid_wrapper_median')
  eq(nvda.underlying_ref_state, 'observed')
  eq(nvda.underlying_ref_price, 176)
  eq(nvda.underlying_ref_feed, 'NVDA / USD')
  eq(typeof nvda.underlying_ref_anchor_bps, 'number')
  eq(gold.underlying_ref_state, null)
  // deno-lint-ignore no-explicit-any
  const tokens = writes[TOKEN_TABLE] as any[]
  const dear = tokens.find((row) => row.crypto_id === '70002')
  // 176.9 against 176 is 51.1 bps: just outside the 0.5% band.
  eq(Math.round(dear.underlying_ref_bps * 10) / 10, 51.1)
  eq(dear.underlying_ref_within_band, false)
  const close = tokens.find((row) => row.crypto_id === '70001')
  eq(close.underlying_ref_within_band, true)
  // The premium to the anchor is untouched by the reference.
  assert(close.premium_bps != null)
  assert(tokens.filter((row) => row.rwa_id === '1').every((row) => row.underlying_ref_bps === null))
  // deno-lint-ignore no-explicit-any
  const obs = writes[REFERENCE_TABLE] as any[]
  eq(obs.length, 1)
  eq(obs[0].ticker, 'NVDA')
  eq(obs[0].capture_op, 'rwa_wrappers')
  eq(obs[0].captured_at, HOUR)
  eq(obs[0].read_state, 'observed')
})

Deno.test('reference: a failed feed read is a stated reason and never fails the wrapper capture', async () => {
  const writes: Record<string, unknown[]> = {}
  const result = await captureRwaWrappers(
    fakeDb({ [UNIVERSE_TABLE]: universeRows(HOUR) }, writes), ctxFor, NOW,
    { request: fakeRequest(stockHandler()).request, referenceSource: fakeReference({ fail: true }).source },
  )
  eq(result.error, undefined)
  // deno-lint-ignore no-explicit-any
  const nvda = (writes[ASSET_TABLE] as any[]).find((row) => row.rwa_id === '2')
  eq(nvda.underlying_ref_state, 'unavailable')
  eq(nvda.underlying_ref_reason, 'feed_read_failed')
  eq(nvda.underlying_ref_price, null)
  eq(nvda.underlying_ref_anchor_bps, null)
  // deno-lint-ignore no-explicit-any
  assert((writes[TOKEN_TABLE] as any[]).every((row) => row.underlying_ref_bps === null && row.underlying_ref_price === null))
  // deno-lint-ignore no-explicit-any
  const obs = (writes[REFERENCE_TABLE] as any[])[0]
  eq(obs.read_state, 'unavailable')
  eq(obs.price, null)
  // A source that throws outright is caught too, and switched off means untouched.
  const thrower: UnderlyingReferenceSource = { id: 'chainlink', covers: () => ({ assetType: 'stock' }), readAsOf: () => Promise.reject(new Error('boom')) }
  const thrown = await captureRwaWrappers(fakeDb({ [UNIVERSE_TABLE]: universeRows(HOUR) }, {}), ctxFor, NOW, { request: fakeRequest(stockHandler()).request, referenceSource: thrower })
  eq(thrown.error, undefined)
  // deno-lint-ignore no-explicit-any
  eq((thrown.reference as any).error, 'boom')
  const off: Record<string, unknown[]> = {}
  await captureRwaWrappers(fakeDb({ [UNIVERSE_TABLE]: universeRows(HOUR) }, off), ctxFor, NOW, { request: fakeRequest(stockHandler()).request, referenceSource: false })
  // deno-lint-ignore no-explicit-any
  assert(!('underlying_ref_state' in (off[ASSET_TABLE] as any[])[0]))
  eq(off[REFERENCE_TABLE], undefined)
})

Deno.test('reference: a non-US listing refuses the mapping and reads nothing', async () => {
  const writes: Record<string, unknown[]> = {}
  const ref = fakeReference()
  await captureRwaWrappers(
    fakeDb({ [UNIVERSE_TABLE]: universeRows(HOUR), [PROFILE_TABLE]: [{ rwa_id: 2, primary_exchange: 'London Stock Exchange' }] }, writes),
    ctxFor, NOW, { request: fakeRequest(stockHandler()).request, referenceSource: ref.source },
  )
  eq(ref.asked, [])
  // deno-lint-ignore no-explicit-any
  const nvda = (writes[ASSET_TABLE] as any[]).find((row) => row.rwa_id === '2')
  eq(nvda.underlying_ref_state, 'mapping_refused')
  eq(nvda.underlying_ref_reason, 'not_a_us_listing')
  eq(writes[REFERENCE_TABLE], undefined)
})

Deno.test('reference: the one-off step fills the newest stored capture and the read passes it through', async () => {
  // A capture the lane wrote with the step switched off, as every capture before this feature was.
  const stored: Record<string, unknown[]> = {}
  await captureRwaWrappers(fakeDb({ [UNIVERSE_TABLE]: universeRows(HOUR) }, stored), ctxFor, NOW, { request: fakeRequest(stockHandler()).request, referenceSource: false })
  const tables: Record<string, unknown[]> = { [ASSET_TABLE]: stored[ASSET_TABLE], [TOKEN_TABLE]: stored[TOKEN_TABLE] }
  const writes: Record<string, unknown[]> = {}
  const ref = fakeReference({ price: 176 })
  const later = new Date(NOW.getTime() + 5 * 3_600_000)
  const result = await captureUnderlyingReferenceForLatest(fakeDb(tables, writes), later, { request: () => Promise.reject(new Error('no provider call')), referenceSource: ref.source })
  eq(result.credits, 0)
  eq(result.capturedAt, HOUR)
  // Still read at the stored quote clock, five hours before the step ran.
  eq(ref.asked[0].asOfMs, Date.parse('2026-09-20T14:25:00.000Z'))
  // deno-lint-ignore no-explicit-any
  const nvda = (writes[ASSET_TABLE] as any[]).find((row) => row.rwa_id === '2')
  eq(nvda.underlying_ref_state, 'observed')
  eq(nvda.anchor_kind, 'liquid_wrapper_median')
  // deno-lint-ignore no-explicit-any
  eq((writes[REFERENCE_TABLE] as any[])[0].capture_op, 'rwa_wrapper_reference')
  // Too old a capture is refused rather than filled.
  const stale = await captureUnderlyingReferenceForLatest(fakeDb(tables, {}), new Date(NOW.getTime() + 14 * 3_600_000), { request: () => Promise.reject(new Error('x')), referenceSource: ref.source })
  eq(stale.skipped, 'newest_capture_too_old')

  // The board reads the filled rows back with the reference on the asset and on each wrapper.
  const board = await readRwaWrappers(fakeDb({ [ASSET_TABLE]: writes[ASSET_TABLE], [TOKEN_TABLE]: writes[TOKEN_TABLE] }), {}, later)
  // deno-lint-ignore no-explicit-any
  const row = (board.rows as any[]).find((r) => r.rwaId === '2')
  eq(row.underlyingReference.state, 'observed')
  eq(row.underlyingReference.price, 176)
  eq(row.underlyingReference.networkLabel, 'Arbitrum')
  eq(row.underlyingReference.deviationPct, 0.5)
  // deno-lint-ignore no-explicit-any
  const wrapper = row.tokens.find((t: any) => t.cryptoId === '70001')
  eq(wrapper.underlyingRefWithinBand, true)
  eq(typeof wrapper.underlyingRefBps, 'number')
  eq(typeof board.referenceScope, 'string')
  // A commodity row has no reference object at all.
  // deno-lint-ignore no-explicit-any
  eq((board.rows as any[]).find((r) => r.rwaId === '1').underlyingReference, null)
})

// ─── The dividend-reinvestment multiplier ─────────────────────────────────────
//
// The SPY wrappers as the 2026-09-23 20:00 capture stored them, with the real
// CoinMarketCap issuer ids, so the register classifies them exactly as it does
// in production. Quote clock: the fixture's 2026-09-20 14:25 UTC.

const SPY_TOKENS = [
  { crypto_id: 40694, symbol: 'SPY', name: 'SPDR S&P 500 Trust Tokenized ETF (Robinhood)', issuer_id: '6a465832fbe3004b1a0ea2dd', issuer_name: 'Robinhood', price: 767.9687413290569, market_cap: 22443238.12, volume_24h: 27054054.94667706 },
  { crypto_id: 37006, symbol: 'SPYX', name: 'SP500 tokenized ETF (xStock)', issuer_id: '6878977dcbbf471de3366e85', issuer_name: 'Backed Assets', price: 770.6229441216093, market_cap: 66914607.4, volume_24h: 20183064.40722753 },
  { crypto_id: 38067, symbol: 'SPYon', name: 'SPDR S&P 500 Tokenized ETF (Ondo)', issuer_id: '688ca4ccabae9b5b9fb3167a', issuer_name: 'Ondo Assets', price: 775.6931836496483, market_cap: 45365708.28, volume_24h: 2573093.87005658 },
  { crypto_id: 41525, symbol: 'wSPYx', name: 'Wrapped SP500 Tokenized ETF (xStock)', issuer_id: '6878977dcbbf471de3366e85', issuer_name: 'Backed Assets', price: 772.072232628172, market_cap: 0, volume_24h: 98025.95433425 },
]
const SPYON_MINT = 'k18WJUULWheRkSpSquYGdNNmtuE2Vbw1hpuUi92ondo'
const SPYX_MINT = 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W'
const XSTOCKS_AUTHORITY = 'S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS'
const accrualHandler = () => {
  const base = handler()
  return (name: string, params: Record<string, unknown>) => {
    if (name !== 'rwaQuotes') return base(name, params)
    return { payload: { data: { rwa_assets: [
      { ...quoteRow(2, 'NVDA', 'Nvidia Corp', 'stock', 184448519, NVDA_TOKENS), tradfi_markets: [{ ticker: 'NVDA', exchange: { name: 'Binance' } }] },
      quoteRow(86, 'SPY', 'SPDR S&P 500 ETF Trust', 'etf', 150000000, SPY_TOKENS),
    ] } } }
  }
}

/** A stand-in multiplier source: SPYon's and SPYx's real 2026-09-23 readings
 * (SPYon's effective time may be moved), or a failed read. Records what it was
 * asked for. */
function fakeAccrual(options: { fail?: boolean; effectiveAt?: number; readAt?: string } = {}) {
  const asked: { mint: string; symbol: string; authority?: string }[] = []
  const source: AccrualMultiplierSource = {
    id: 'solana_scaled_ui', network: 'solana',
    read(requests, runReadAt) {
      asked.push(...requests)
      // The lane's own clock is a week back from today, so a test that turns on
      // when the chain was read pins it.
      const readAt = options.readAt ?? runReadAt
      if (options.fail) return Promise.reject(new Error('rpc_http_503'))
      return Promise.resolve(new Map(requests.map((r) => [r.mint, r.mint === SPYX_MINT
        ? {
          mint: r.mint, state: 'read' as const, reason: null, detail: null, onChainSymbol: r.symbol,
          multiplier: 1.003909240011759, newMultiplier: 1.005714560286254, effectiveAt: 1781755200, readAt,
        }
        : {
          mint: r.mint, state: 'read' as const, reason: null, detail: null, onChainSymbol: r.symbol,
          multiplier: 1.0094730727840426, newMultiplier: 1.0094730727840426,
          effectiveAt: options.effectiveAt ?? 1789754055, readAt,
        }])))
    },
  }
  return { source, asked }
}

Deno.test('accrual: the lane divides a reinvesting wrapper by its own multiplier before any comparison', async () => {
  const writes: Record<string, unknown[]> = {}
  const acc = fakeAccrual({ effectiveAt: Date.parse('2026-09-18T17:54:15Z') / 1000 })
  const result = await captureRwaWrappers(fakeDb({ [UNIVERSE_TABLE]: universeRows(HOUR) }, writes), ctxFor, NOW,
    { request: fakeRequest(accrualHandler()).request, referenceSource: false, accrualSource: acc.source })
  // Zero credits: the provider calls are exactly what they were.
  assert(result.credits <= 5)
  eq(result.accrual, { reinvesting: 3, adjusted: 2, notAdjusted: 1, reads: 2 })
  // Only the registry mints are read, once each: SPYX and wSPYx share SPYx's.
  eq(acc.asked, [{ mint: SPYX_MINT, symbol: 'SPYx', authority: XSTOCKS_AUTHORITY }, { mint: SPYON_MINT, symbol: 'SPYon' }])
  // deno-lint-ignore no-explicit-any
  const tokens = writes[TOKEN_TABLE] as any[]
  const on = tokens.find((row) => row.crypto_id === '38067')
  eq(on.accrual_treatment, 'adjusted')
  eq(on.accrual_multiplier, 1.0094730727840426)
  eq(on.accrual_multiplier_source, 'ondo_solana_scaled_ui')
  eq(on.accrual_multiplier_as_of, '2026-09-18T17:54:15.000Z')
  eq(on.accrual_multiplier_network, 'solana')
  eq(on.accrual_multiplier_address, SPYON_MINT)
  eq(on.accrual_reason, null)
  eq(on.normalised_price, 775.6931836496483)
  eq(Math.round(on.adjusted_price * 1e4) / 1e4, 768.4139)
  eq(on.wrapper_state, 'liquid')
  eq(Math.round(on.premium_bps * 10) / 10, 5.8)
  eq(Math.round(on.raw_premium_bps * 10) / 10, 100.6)
  // The wrapped xStock is divided by SPYx's multiplier: one wrapped token is that many shares.
  const wrapped = tokens.find((row) => row.crypto_id === '41525')
  eq(wrapped.accrual_treatment, 'adjusted')
  eq(wrapped.accrual_multiplier, 1.005714560286254)
  eq(wrapped.accrual_multiplier_source, 'xstocks_solana_scaled_ui')
  eq(wrapped.accrual_multiplier_as_of, '2026-06-18T04:00:00.000Z')
  eq(wrapped.accrual_multiplier_address, SPYX_MINT)
  eq(wrapped.wrapper_state, 'too_thin_to_anchor')
  eq(Math.round(wrapped.premium_bps * 10) / 10, -3.7)
  eq(Math.round(wrapped.raw_premium_bps * 10) / 10, 53.4)
  // SPYX: its multiplier is proved and above 1, but its quote blends per-share
  // venues with per-raw-unit pools, so it is labelled, not divided, and never anchors.
  const spyx = tokens.find((row) => row.crypto_id === '37006')
  eq(spyx.wrapper_state, 'accrues_in_price')
  eq(spyx.state_reason, 'reinvested_dividends_not_adjusted')
  eq(spyx.accrual_treatment, 'not_adjusted')
  eq(spyx.accrual_reason, 'quote_unit_mixed')
  eq(spyx.accrual_multiplier, null)
  eq(spyx.adjusted_price, null)
  eq(spyx.premium_bps, null)
  eq(spyx.in_anchor, false)
  eq(Math.round(spyx.accrual_gap_bps * 10) / 10, 34.6)
  // Every wrapper row carries every accrual key, so an upsert clears a stale one.
  for (const row of tokens) assert('accrual_treatment' in row && 'adjusted_price' in row && 'raw_premium_bps' in row)
  eq(tokens.find((row) => row.crypto_id === '40694').accrual_treatment, null)
  // A reinvesting wrapper under another asset of the same run is not touched.
  assert(tokens.filter((row) => row.rwa_id === '2').every((row) => row.accrual_treatment === null))
  // deno-lint-ignore no-explicit-any
  const spy = (writes[ASSET_TABLE] as any[]).find((row) => row.rwa_id === '86')
  eq(spy.accrual_adjusted_count, 2)
  eq(spy.accrual_count, 1)
  // SPYX leaving the anchor does not move it here: the Robinhood token is the weighted median either way.
  eq(spy.anchor_price, 767.9687413290569)
})

Deno.test('accrual: a failed or out-of-date multiplier labels the wrapper and never fails the capture', async () => {
  const failed: Record<string, unknown[]> = {}
  const result = await captureRwaWrappers(fakeDb({ [UNIVERSE_TABLE]: universeRows(HOUR) }, failed), ctxFor, NOW,
    { request: fakeRequest(accrualHandler()).request, referenceSource: false, accrualSource: fakeAccrual({ fail: true }).source })
  eq(result.error, undefined)
  // deno-lint-ignore no-explicit-any
  eq((result.accrual as any).error, 'rpc_http_503')
  // deno-lint-ignore no-explicit-any
  const on = (failed[TOKEN_TABLE] as any[]).find((row) => row.crypto_id === '38067')
  eq(on.wrapper_state, 'accrues_in_price')
  eq(on.accrual_treatment, 'not_adjusted')
  eq(on.accrual_reason, 'multiplier_read_failed')
  eq(on.accrual_multiplier, null)
  eq(on.premium_bps, null)
  eq(on.in_anchor, false)
  // SPYX and wSPYx are labelled with the same reason: an xStock whose multiplier
  // could not be read is never assumed to be at 1.
  // deno-lint-ignore no-explicit-any
  for (const id of ['37006', '41525']) {
    // deno-lint-ignore no-explicit-any
    const row = (failed[TOKEN_TABLE] as any[]).find((r) => r.crypto_id === id)
    eq(row.accrual_reason, 'multiplier_read_failed')
    eq(row.premium_bps, null)
    eq(row.in_anchor, false)
  }
  // That leaves SPY one liquid wrapper, so it has no anchor and no gap at all:
  // fewer figures, never a wrong one.
  // deno-lint-ignore no-explicit-any
  const spy = (failed[ASSET_TABLE] as any[]).find((row) => row.rwa_id === '86')
  eq(spy.anchor_price, null)
  eq(spy.anchor_reason, 'not_enough_liquid_wrappers')
  eq(on.accrual_gap_bps, null)
  // A multiplier that took effect after the prices were observed is not applied.
  const late: Record<string, unknown[]> = {}
  await captureRwaWrappers(fakeDb({ [UNIVERSE_TABLE]: universeRows(HOUR) }, late), ctxFor, NOW,
    { request: fakeRequest(accrualHandler()).request, referenceSource: false, accrualSource: fakeAccrual({ effectiveAt: Date.parse('2026-09-21T00:00:00Z') / 1000, readAt: '2026-09-23T21:30:00.000Z' }).source })
  // deno-lint-ignore no-explicit-any
  eq((late[TOKEN_TABLE] as any[]).find((row) => row.crypto_id === '38067').accrual_reason, 'multiplier_changed_after_observation')
  // Still pending when the chain was read: a stated reason of its own, not applied either.
  const pending: Record<string, unknown[]> = {}
  await captureRwaWrappers(fakeDb({ [UNIVERSE_TABLE]: universeRows(HOUR) }, pending), ctxFor, NOW,
    { request: fakeRequest(accrualHandler()).request, referenceSource: false, accrualSource: fakeAccrual({ effectiveAt: Date.parse('2026-09-21T00:00:00Z') / 1000, readAt: '2026-09-20T20:00:00.000Z' }).source })
  // deno-lint-ignore no-explicit-any
  const pendingRow = (pending[TOKEN_TABLE] as any[]).find((row) => row.crypto_id === '38067')
  eq(pendingRow.accrual_reason, 'multiplier_update_pending')
  eq(pendingRow.premium_bps, null)
  // The read switched off still labels, never reverts to a premium.
  const off: Record<string, unknown[]> = {}
  await captureRwaWrappers(fakeDb({ [UNIVERSE_TABLE]: universeRows(HOUR) }, off), ctxFor, NOW,
    { request: fakeRequest(accrualHandler()).request, referenceSource: false, accrualSource: false })
  // deno-lint-ignore no-explicit-any
  const offRow = (off[TOKEN_TABLE] as any[]).find((row) => row.crypto_id === '38067')
  eq(offRow.accrual_reason, 'multiplier_not_read')
  eq(offRow.premium_bps, null)
})

Deno.test('accrual: the one-off op recomputes the newest capture, re-reads the reference, and the board shows both figures', async () => {
  // A capture stored before the adjustment existed: no accrual columns at all.
  const stored: Record<string, unknown[]> = {}
  await captureRwaWrappers(fakeDb({ [UNIVERSE_TABLE]: universeRows(HOUR) }, stored), ctxFor, NOW,
    { request: fakeRequest(accrualHandler()).request, referenceSource: false, accrualSource: false })
  const strip = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([k]) => !k.startsWith('accrual_') && k !== 'adjusted_price' && k !== 'raw_premium_bps'))
  // deno-lint-ignore no-explicit-any
  const tables: Record<string, unknown[]> = { [ASSET_TABLE]: (stored[ASSET_TABLE] as any[]).map(strip), [TOKEN_TABLE]: (stored[TOKEN_TABLE] as any[]).map(strip) }
  // deno-lint-ignore no-explicit-any
  eq((tables[TOKEN_TABLE] as any[]).find((row) => row.crypto_id === '38067').wrapper_state, 'accrues_in_price')

  const writes: Record<string, unknown[]> = {}
  const later = new Date(NOW.getTime() + 5 * 3_600_000)
  const ref = fakeReference({ price: 176 })
  const acc = fakeAccrual()
  const result = await captureAccrualForLatest(fakeDb(tables, writes), later,
    { request: () => Promise.reject(new Error('no provider call')), referenceSource: ref.source, accrualSource: acc.source })
  eq(result.credits, 0)
  eq(result.error, undefined)
  eq(result.capturedAt, HOUR)
  // deno-lint-ignore no-explicit-any
  eq((result.accrual as any).adjusted, 2)
  // deno-lint-ignore no-explicit-any
  const on = (writes[TOKEN_TABLE] as any[]).find((row) => row.crypto_id === '38067')
  eq(on.accrual_treatment, 'adjusted')
  eq(on.wrapper_state, 'liquid')
  eq(Math.round(on.premium_bps * 10) / 10, 5.8)
  // The capture's own clocks are kept: this is a recompute, not a new read.
  // deno-lint-ignore no-explicit-any
  eq(on.fetched_at, (tables[TOKEN_TABLE] as any[]).find((row) => row.crypto_id === '38067').fetched_at)
  // deno-lint-ignore no-explicit-any
  const spy = (writes[ASSET_TABLE] as any[]).find((row) => row.rwa_id === '86')
  eq(spy.accrual_adjusted_count, 2)
  eq(spy.source_observed_at, '2026-09-20T14:25:00.000Z')
  // The reference is re-read at the stored quote clock, and tagged with this op.
  eq(ref.asked[0].asOfMs, Date.parse('2026-09-20T14:25:00.000Z'))
  // deno-lint-ignore no-explicit-any
  eq((writes[REFERENCE_TABLE] as any[])[0].capture_op, 'rwa_wrapper_accrual')
  // Idempotent against the lane: the same figures as a scheduled run with the multiplier.
  const direct: Record<string, unknown[]> = {}
  await captureRwaWrappers(fakeDb({ [UNIVERSE_TABLE]: universeRows(HOUR) }, direct), ctxFor, NOW,
    { request: fakeRequest(accrualHandler()).request, referenceSource: false, accrualSource: fakeAccrual().source })
  // deno-lint-ignore no-explicit-any
  for (const row of direct[TOKEN_TABLE] as any[]) {
    // deno-lint-ignore no-explicit-any
    const again = (writes[TOKEN_TABLE] as any[]).find((r) => r.crypto_id === row.crypto_id && r.rwa_id === row.rwa_id)
    eq(again.premium_bps, row.premium_bps)
    eq(again.accrual_gap_bps, row.accrual_gap_bps)
    eq(again.in_anchor, row.in_anchor)
    eq(again.adjusted_price, row.adjusted_price)
  }

  // Refusals: too old a capture, and no reference to keep the gap to the stock consistent.
  const stale = await captureAccrualForLatest(fakeDb(tables, {}), new Date(NOW.getTime() + 14 * 3_600_000), { request: () => Promise.reject(new Error('x')), referenceSource: ref.source, accrualSource: acc.source })
  eq(stale.skipped, 'newest_capture_too_old')
  const noRef = await captureAccrualForLatest(fakeDb(tables, {}), later, { request: () => Promise.reject(new Error('x')), referenceSource: false, accrualSource: acc.source })
  eq(noRef.skipped, 'reference_switched_off')
  const thrower: UnderlyingReferenceSource = { id: 'chainlink', covers: () => ({ assetType: 'stock' }), readAsOf: () => Promise.reject(new Error('boom')) }
  const nothing: Record<string, unknown[]> = {}
  const broken = await captureAccrualForLatest(fakeDb(tables, nothing), later, { request: () => Promise.reject(new Error('x')), referenceSource: thrower, accrualSource: acc.source })
  eq(broken.error, 'boom')
  eq(nothing[TOKEN_TABLE], undefined)

  // The board reads both figures back, and the picks name the adjusted wrapper's multiplier.
  const board = await readRwaWrappers(fakeDb({ [ASSET_TABLE]: writes[ASSET_TABLE], [TOKEN_TABLE]: writes[TOKEN_TABLE] }), {}, later)
  // deno-lint-ignore no-explicit-any
  const row = (board.rows as any[]).find((r) => r.rwaId === '86')
  eq(row.accrualAdjustedCount, 2)
  // deno-lint-ignore no-explicit-any
  const wrapper = row.tokens.find((t: any) => t.cryptoId === '38067')
  eq(wrapper.accrualTreatment, 'adjusted')
  eq(wrapper.accrualMultiplier, 1.0094730727840426)
  eq(wrapper.accrualSource, 'ondo_solana_scaled_ui')
  eq(wrapper.accrualAsOf, '2026-09-18T17:54:15.000Z')
  eq(Math.round(wrapper.rawPremiumBps * 10) / 10, 100.6)
  // deno-lint-ignore no-explicit-any
  const wrapped = row.tokens.find((t: any) => t.cryptoId === '41525')
  eq(wrapped.accrualTreatment, 'adjusted')
  eq(wrapped.accrualSource, 'xstocks_solana_scaled_ui')
  eq(wrapped.accrualMultiplier, 1.005714560286254)
  // deno-lint-ignore no-explicit-any
  const spyx = row.tokens.find((t: any) => t.cryptoId === '37006')
  eq(spyx.accrualTreatment, 'not_adjusted')
  eq(spyx.accrualReason, 'quote_unit_mixed')
  eq(spyx.premiumBps, null)
  // deno-lint-ignore no-explicit-any
  eq((board.summary as any).accrualAdjusted, 2)
  eq(typeof board.accrualScope, 'string')
  // deno-lint-ignore no-explicit-any
  const excluded = row.picks.excluded.find((e: any) => e.cryptoId === '37006')
  eq(excluded.reason, 'reinvested_dividends_not_adjusted')
})

// ─── A capture stores the provider's answer NOW, never the cache's stale copy ──

Deno.test('every provider read of a capture asks the transport to wait for a fresh copy', async () => {
  // deno-lint-ignore no-explicit-any
  const seen: any[] = []
  const inner = handler()
  // deno-lint-ignore no-explicit-any
  const request = (name: string, params: Record<string, unknown> = {}, ctx?: any) => { seen.push({ name, ctx }); return Promise.resolve(inner(name, params)) }
  const result = await captureRwaWrappers(fakeDb({ [UNIVERSE_TABLE]: universeRows(HOUR) }), ctxFor, NOW, { request })
  assert(!result.error, String(result.error))
  assert(seen.length >= 2)
  // The transport serves a key past its window but inside its stale window from
  // the OLD copy unless told to wait; the six-hourly cron lands on that boundary.
  for (const call of seen) eq(call.ctx?.waitForFresh, true, call.name)
  eq(seen.filter((c) => c.name === 'rwaQuotes').length, 1)
})

Deno.test('a stale quotes copy returned by a failed refresh is refused, not stored under a new hour', async () => {
  const writes: Record<string, unknown[]> = {}
  const inner = handler()
  const request = (name: string, params: Record<string, unknown> = {}) => {
    const answer = inner(name, params)
    // What cmc-transport returns when the live refresh fails but a stale copy is
    // kept: the old payload, state 'stale', and the reason the refresh failed.
    return Promise.resolve(name === 'rwaQuotes' ? { ...answer, state: 'stale', reason: 'provider_unavailable' } : answer)
  }
  const result = await captureRwaWrappers(fakeDb({ [UNIVERSE_TABLE]: universeRows(HOUR) }, writes), ctxFor, NOW, { request })
  eq(result.rows, 0)
  eq(result.error, 'quotes_not_refreshed:provider_unavailable')
  eq(writes[ASSET_TABLE], undefined)
  eq(writes[TOKEN_TABLE], undefined)
  // The call was made and is still counted: the list pages and the quotes read.
  assert(Number(result.credits) >= 1)
})

Deno.test('a quotes copy served fresh from the shared cache inside its window is stored as before', async () => {
  const writes: Record<string, unknown[]> = {}
  const inner = handler()
  const request = (name: string, params: Record<string, unknown> = {}) =>
    Promise.resolve(name === 'rwaQuotes' ? { ...inner(name, params), state: 'cached', reason: null } : inner(name, params))
  const result = await captureRwaWrappers(fakeDb({ [UNIVERSE_TABLE]: universeRows(HOUR) }, writes), ctxFor, NOW, { request })
  assert(!result.error, String(result.error))
  assert((writes[ASSET_TABLE] || []).length >= 1)
})
