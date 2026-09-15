// Investor Intel — the candle history lane (goal B).
//
// Bitcoin used to show one year, because one provider window was the whole
// answer. This lane fetches an asset's COMPLETE daily history ONCE, stores it in
// `market_asset_candles`, and then appends yesterday's candle every day. The
// chart read merges what is stored under the provider's recent window, so the
// long ranges are real history rather than a longer request.
//
// Same contract as every other lane (`capture-listings.ts` is the template): one
// function per op, bounded by an explicit ceiling, obeying
// `provider_schedule_policy`, never throwing — a failure becomes `{ error }` on
// the result. The CoinMarketCap transport is injected as `deps.request` and the
// exchange transport as `deps.exchange`, so the module tests with no network and
// no database.
//
// WHERE THE HISTORY COMES FROM, per asset, cheapest first:
//
//   1. BINANCE, free. `/api/v3/klines` pages forward from `startTime`, 1000
//      daily candles a request, back to the pair's listing (2017 for the
//      majors). Costs no CoinMarketCap credit at all.
//   2. COINMARKETCAP OHLCV, for the years before the venue listed the asset and
//      for every asset Binance does not list. `/v2/cryptocurrency/ohlcv/
//      historical` is documented at ONE CREDIT PER 100 DAILY POINTS, so a
//      thousand-day page is about 10 credits and Bitcoin since 2013 (about
//      4,900 days) is about 50.
//
// CREDIT BUDGET. The whole top 100 is budgeted under 5,000 credits and the
// ceiling lives in `provider_schedule_policy.max_credits` for the `candle_history`
// feature, not in this file: the lane reads it, adds what it has already spent
// (the sum of `credits_spent` in the backfill state table) and stops. A run also
// carries its own smaller ceiling so one run can never spend the whole budget.
//
// HONESTY RULES:
//   * A day the source did not report is NOT written. A gap stays a gap; it is
//     never filled by carrying the previous close forward.
//   * A zero volume is a completed day in which nothing traded and is stored as
//     zero. A volume the source did not report is stored NULL.
//   * `oldest_candle` is only recorded as the asset's first day when the walk ran
//     out of ROWS. A walk that ran out of PAGES is `partial` and resumes.
//   * An asset with no free venue and no CoinMarketCap listing is stored as
//     `unavailable` with a reason. It is never silently dropped from the queue.

import { estimateCmcCredits, planAllows } from '../market-assets/cmc-capabilities.ts'
import type { MarketAssetsContext } from '../market-assets/types.ts'
import { CAPTURE_PROVIDER, schedulePolicy } from './capture-jobs.ts'
import type { CaptureDeps, JobResult } from './capture-jobs.ts'
import { cmcOhlcvBars } from './cmc-chart.ts'
import { binanceDailyHistory, BINANCE_EPOCH_MS } from './exchange-history.ts'
import { marketCanonicalIdentity } from './market-read-quality.ts'
import { marketCmcIdentity } from './market-asset-source.ts'
import type { Bar } from './chart-analysis.ts'

const DAY = 86_400_000
/** Nothing in this catalogue traded before 2010; asking earlier buys nothing. */
export const HISTORY_EPOCH_MS = Date.UTC(2010, 0, 1)
/** Assets whose history is filled in one scheduled run. */
export const BACKFILL_ASSETS_PER_RUN = 10
/** Catalogue assets the lane seeds itself with. */
export const BACKFILL_TOP_N = 100
/** Daily points one CoinMarketCap OHLCV page asks for.
 *
 * 250 IS THE REGISTRY'S OWN CEILING, not a preference: `numericCeiling` in
 * `cmc-capabilities.ts` caps `count` at 250 for this capability, so a page that
 * asks for more is refused by `cmcParams` with `invalid_parameter:count` BEFORE
 * any request is made. A page therefore covers 249 days and asks for 250 points
 * (a window carries one extra point, the way `cmcChartPlan` builds its pages).
 * At one credit per 100 points that is 3 credits a page. */
export const OHLCV_PAGE_DAYS = 249
/** Points one page asks for: the registry's ceiling for `ohlcv`. */
export const OHLCV_PAGE_COUNT = 250
/** Pages one asset may take from CoinMarketCap in a single pass. 2010 to today
 * is about 6,100 days, which is 25 pages of 249; 26 leaves a page of headroom so
 * a full walk is never cut short by the page ceiling alone. */
export const OHLCV_MAX_PAGES = 26
/** Credits ONE backfill run may spend, whatever the standing budget allows. Ten
 * assets at a thousand-day page each is about 100; the rest is headroom for an
 * asset with a decade of history. */
export const BACKFILL_RUN_CREDITS = 400
/** The standing ceiling for the whole backfill, used when
 * `provider_schedule_policy.max_credits` has no row. */
export const BACKFILL_CREDIT_CEILING = 5_000
/** Assets whose newest stored day is refreshed in one daily append. */
export const DAILY_APPEND_ASSETS = 150
/** Credits ONE daily append may spend. The free venue path costs nothing, so
 * this only ever binds for assets no venue lists. */
export const DAILY_APPEND_CREDITS = 150
/** CoinMarketCap-sourced catalogue rows read for the identity join. The whole
 * ranked universe is 1,000 rows, which is also this project's PostgREST ceiling. */
export const CMC_INDEX_ROWS = 1_000
/** Rows written in one statement. */
const MAX_UPSERT_ROWS = 500
/** Cadence a lane falls back to when its policy row is missing. */
const LANE_CADENCE: Record<string, number> = { candle_history: 1200, candle_daily: 86_400 }

export const CANDLE_TABLE = 'market_asset_candles'
export const BACKFILL_TABLE = 'market_asset_candle_backfill'

const text = (v: unknown, max = 200): string | null => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null }
const dayIso = (ms: number) => new Date(Math.floor(ms / DAY) * DAY).toISOString()
const dayOnly = (ms: number) => new Date(Math.floor(ms / DAY) * DAY).toISOString().slice(0, 10)
const failed = (job: string, credits: number, e: unknown): JobResult =>
  ({ job, rows: 0, credits, error: ((e as Error)?.message || 'capture_failed').slice(0, 200) })

export interface CandleLaneDeps extends CaptureDeps {
  /** Binance daily history. Injected so the lane tests with no network. */
  exchange?: typeof binanceDailyHistory
}

function lanePolicy(deps: CaptureDeps, feature: string): { enabled: boolean; cadenceSeconds: number; maxCredits: number | null } {
  const row = (deps.policy || []).find((r) => r?.feature === feature && (r.provider ?? CAPTURE_PROVIDER) === CAPTURE_PROVIDER)
  const policy = row ? schedulePolicy(deps.policy, feature) : { enabled: true, cadenceSeconds: LANE_CADENCE[feature] ?? 3600 }
  const ceiling = Number((row as { max_credits?: unknown } | undefined)?.max_credits)
  return {
    enabled: policy.enabled,
    cadenceSeconds: row ? policy.cadenceSeconds : (LANE_CADENCE[feature] ?? 3600),
    maxCredits: Number.isFinite(ceiling) && ceiling >= 0 ? Math.trunc(ceiling) : null,
  }
}

// deno-lint-ignore no-explicit-any
async function upsert(db: any, table: string, rows: Record<string, unknown>[], onConflict: string): Promise<{ rows: number; error?: string }> {
  if (!rows.length) return { rows: 0 }
  let written = 0
  for (let start = 0; start < rows.length; start += MAX_UPSERT_ROWS) {
    const chunk = rows.slice(start, start + MAX_UPSERT_ROWS)
    try {
      const { error } = await db.from(table).upsert(chunk, { onConflict })
      if (error) return { rows: written, error: String(error.message || error).slice(0, 200) }
      written += chunk.length
    } catch (e) { return { rows: written, error: ((e as Error)?.message || 'write_failed').slice(0, 200) } }
  }
  return { rows: written }
}

// deno-lint-ignore no-explicit-any
async function readRows(build: () => any): Promise<{ rows: any[]; reason: string | null }> {
  try {
    const { data, error } = await build()
    if (error) return { rows: [], reason: String(error.message || error.code || error).slice(0, 200) }
    return { rows: Array.isArray(data) ? data : data ? [data] : [], reason: null }
  } catch (e) { return { rows: [], reason: ((e as Error)?.message || 'read_failed').slice(0, 200) } }
}

// ─── Candle rows ──────────────────────────────────────────────────────────────

/** One bar → one stored row. A bar with no close is not a candle and is dropped
 * rather than stored with an invented price. */
export function candleRow(assetKey: string, provider: string, bar: Bar, sourceRef: string | null, recordedAt: string): Record<string, unknown> | null {
  if (bar?.c == null || !Number.isFinite(Number(bar.t)) || Number(bar.t) % DAY !== 0) return null
  return {
    asset_key: assetKey, provider, candle_interval: '1d', candle_time: dayIso(Number(bar.t)),
    open: bar.o ?? null, high: bar.h ?? null, low: bar.l ?? null, close: bar.c,
    // A zero stays a zero; an unreported volume stays NULL.
    volume: bar.v == null ? null : Number(bar.v),
    source_ref: sourceRef, recorded_at: recordedAt,
  }
}

/** Backward pages for a CoinMarketCap OHLCV history walk. Shaped exactly like
 * `cmcChartPlan`'s pages, so the registry's own window validation accepts them. */
export function ohlcvHistoryPages(id: string, from: number, to: number, pageDays = OHLCV_PAGE_DAYS, maxPages = OHLCV_MAX_PAGES): Record<string, unknown>[] {
  const end = Math.floor(to / DAY) * DAY, start = Math.floor(Math.max(HISTORY_EPOCH_MS, from) / DAY) * DAY
  const pages: Record<string, unknown>[] = []
  for (let until = end; until > start && pages.length < maxPages;) {
    const first = Math.max(start, until - pageDays * DAY), count = (until - first) / DAY
    if (count < 1) break
    pages.push({
      id, time_period: 'daily', interval: 'daily',
      time_start: new Date(first - 1).toISOString(), time_end: new Date(until - 1).toISOString(), count: count + 1,
    })
    until = first
  }
  return pages
}

// ─── One asset ────────────────────────────────────────────────────────────────

export interface AssetHistoryResult {
  assetKey: string
  source: string | null
  rows: number
  credits: number
  oldest: number | null
  newest: number | null
  complete: boolean
  reason: string | null
  error?: string
}

/** The Binance pair for a normalized symbol and the asset its volume is quoted
 * in, or null. The pair with the highest quote volume is a USD stablecoin for
 * every asset in this catalogue, which is why the stored quote volume is one
 * unit with the CoinMarketCap USD figures beside it. */
// deno-lint-ignore no-explicit-any
async function binancePair(db: any, symbol: string): Promise<{ symbol: string; quote: string | null } | null> {
  if (!symbol) return null
  const page = await readRows(() => db.from('exchange_latest_tickers')
    .select('provider,provider_symbol,quote_asset,volume_quote_24h').eq('normalized_symbol', symbol).eq('provider', 'binance')
    .order('volume_quote_24h', { ascending: false }).limit(1))
  const row = page.rows[0]
  return row?.provider_symbol ? { symbol: String(row.provider_symbol), quote: row.quote_asset ? String(row.quote_asset) : null } : null
}

/** How a pass relates to what is already stored.
 *
 *   full    nothing is stored: the venue walks forward from the epoch and the
 *           paid rung buys everything the venue could not reach.
 *   resume  a PARTIAL asset: the venue resumes FORWARD from the day after the
 *           newest stored candle (its own walk pages forward, so a truncated
 *           one leaves its gap at the new end), while the paid rung pages
 *           BACKWARD from the OLDEST stored candle, because that gap is at the
 *           old end and is exactly what an interrupted run still owes.
 *   append  a finished asset's daily top-up: FORWARD ONLY. It must never walk
 *           older years, so a complete asset costs about one credit a day when
 *           no venue lists it and nothing at all when one does.
 */
export type BackfillMode = 'full' | 'resume' | 'append'

export interface BackfillWindow {
  mode?: BackfillMode
  /** Day the FORWARD walk starts from. */
  from?: number
  /** Oldest day already stored, for a backward resume. */
  oldest?: number | null
}

/**
 * The daily history of ONE asset.
 *
 * A pass never re-asks for a period already stored: the forward walk starts the
 * day after the newest stored candle, and the backward walk ends at the oldest.
 */
// deno-lint-ignore no-explicit-any
export async function backfillAssetHistory(db: any, asset: { assetKey: string; symbol: string | null; cmcId: string | null },
  ctx: MarketAssetsContext, now: number, creditBudget: number, deps: CandleLaneDeps,
  window: BackfillWindow = {}): Promise<AssetHistoryResult> {
  const mode: BackfillMode = window.mode ?? 'full'
  const from = Number.isFinite(window.from) ? Math.max(HISTORY_EPOCH_MS, window.from as number) : HISTORY_EPOCH_MS
  const storedOldest = Number.isFinite(window.oldest) ? (window.oldest as number) : null
  const recordedAt = new Date(now).toISOString()
  const yesterday = Math.floor(now / DAY) * DAY - DAY
  const result: AssetHistoryResult = { assetKey: asset.assetKey, source: null, rows: 0, credits: 0, oldest: null, newest: null, complete: false, reason: null }
  const written: Record<string, unknown>[] = []
  let venueOldest: number | null = null
  // The two rungs report completeness SEPARATELY. "Binance does not list this
  // asset" says nothing about whether the OHLCV walk reached the asset's first
  // day, and must not leave a fully filled asset queued forever.
  let venueComplete = false, venueReason: string | null = null
  let cmcComplete = false, cmcReason: string | null = null

  // 1. The free venue, walking FORWARD in every mode.
  const pair = await binancePair(db, String(asset.symbol || '').toUpperCase())
  if (pair) {
    const history = await (deps.exchange ?? binanceDailyHistory)(ctx, pair.symbol, Math.max(from, BINANCE_EPOCH_MS), yesterday + DAY - 1, now).catch(() => null)
    if (history?.bars.length) {
      result.source = 'binance'
      venueOldest = history.bars[0].t
      // The source reference NAMES THE UNIT the stored volume is in, so a reader
      // of the table never has to infer it from the provider column.
      const sourceRef = `binance:${pair.symbol}:volume_quote_${pair.quote ?? 'unknown'}`
      for (const bar of history.bars) {
        const row = candleRow(asset.assetKey, 'binance', bar, sourceRef, recordedAt)
        if (row) written.push(row)
      }
      // Only a walk that ran out of ROWS proves it saw the pair's first day.
      venueComplete = history.complete
      venueReason = history.reason
    } else venueReason = history?.reason ?? 'no_completed_candles'
  } else venueReason = 'no_binance_pair'

  // 2. CoinMarketCap OHLCV for the years the venue cannot reach.
  //
  // `append` is forward only: its window starts where the forward walk started,
  // so a finished asset can never be charged for a decade it already holds.
  // `resume` is the opposite: it ends at the OLDEST stored day and starts at the
  // epoch, because that is the gap an interrupted run still owes. Resuming a
  // partial asset forward would leave the window empty, mark it COMPLETE and
  // silently abandon the older years.
  const paidStart = mode === 'append' ? from : HISTORY_EPOCH_MS
  const paidEnd = mode === 'resume'
    ? Math.min(...[storedOldest, venueOldest, yesterday + DAY].filter((value): value is number => value != null))
    : venueOldest != null ? venueOldest : yesterday + DAY
  if (!asset.cmcId) cmcReason = 'no_cmc_listing'
  else if (paidEnd <= paidStart) cmcComplete = true  // nothing is owed that the venue has not already covered
  else if (creditBudget <= 0) cmcReason = 'credit_budget'
  else {
    const pages = ohlcvHistoryPages(asset.cmcId, paidStart, paidEnd)
    let spent = 0, stopped = false
    for (const params of pages) {
      const cost = estimateCmcCredits('ohlcv', { count: String(params.count) })
      if (spent + cost > creditBudget) { cmcReason = 'credit_budget'; stopped = true; break }
      // deno-lint-ignore no-explicit-any
      const response: any = await deps.request('ohlcv', params, ctx).catch(() => null)
      // CREDITS ARE COUNTED ONLY FOR A REQUEST THAT REACHED THE PROVIDER. A page
      // the local validator refused, or a call that threw, never left this
      // process and must not be recorded as spent: the estimate is a floor the
      // transport reconciles, not a charge this lane may invent.
      if (response?.payload || response?.provenance?.fetchedAt) spent += cost
      if (!response?.payload) { cmcReason = text(response?.reason, 60) || 'provider_unavailable'; stopped = true; break }
      const recorded = Date.parse(response.provenance?.fetchedAt || '')
      const bars = cmcOhlcvBars(response.payload, asset.cmcId, Number.isFinite(recorded) ? recorded : null, DAY)
      for (const bar of bars) {
        const row = candleRow(asset.assetKey, CAPTURE_PROVIDER, bar, `coinmarketcap:ohlcv:${asset.cmcId}:volume_USD`, recordedAt)
        if (row) written.push(row)
      }
      if (!result.source) result.source = CAPTURE_PROVIDER
      else if (result.source === 'binance') result.source = 'binance+coinmarketcap'
      // A page the provider answered with nothing is the asset's first listing:
      // there is no earlier history to page towards.
      if (!bars.length) { cmcComplete = true; stopped = true; break }
    }
    result.credits += spent
    // The walk is complete when it ran out of HISTORY, not out of pages.
    if (!stopped && pages.length < OHLCV_MAX_PAGES) cmcComplete = true
  }

  // The paid rung owns the older years, so it decides completeness whenever it
  // was available at all; otherwise the venue does.
  result.complete = asset.cmcId ? cmcComplete : venueComplete
  result.reason = cmcReason ?? venueReason

  if (!written.length) {
    result.reason = result.reason || (asset.cmcId ? 'no_completed_candles' : 'no_free_venue_and_no_cmc_listing')
    return result
  }
  const times = written.map((row) => Date.parse(String(row.candle_time))).filter((t) => Number.isFinite(t)).sort((a, b) => a - b)
  result.oldest = times[0] ?? null
  result.newest = times.at(-1) ?? null
  const write = await upsert(db, CANDLE_TABLE, written, 'asset_key,provider,candle_interval,candle_time')
  result.rows = write.rows
  if (write.error) result.error = write.error
  return result
}

// ─── Seeding the queue ────────────────────────────────────────────────────────

/** CoinMarketCap-sourced catalogue rows, indexed two ways for the identity join
 * below. A symbol claimed by MORE THAN ONE CoinMarketCap asset is dropped from
 * the symbol index entirely: a same-ticker match is not an identity, and buying
 * a decade of the wrong asset's history is worse than buying none. */
export interface CmcCatalogueIndex { byKey: Map<string, string>; bySymbol: Map<string, string> }
// deno-lint-ignore no-explicit-any
export function cmcCatalogueIndex(rows: any[]): CmcCatalogueIndex {
  const byKey = new Map<string, string>(), counts = new Map<string, number>(), first = new Map<string, string>()
  for (const row of rows || []) {
    const id = String(row?.provider_id ?? '')
    if (!/^[1-9][0-9]{0,9}$/.test(id)) continue
    const key = marketCanonicalIdentity(row).canonicalAssetKey
    if (key && !byKey.has(key)) byKey.set(key, id)
    const symbol = String(row?.normalized_symbol || row?.symbol || '').toUpperCase().trim()
    if (!symbol) continue
    counts.set(symbol, (counts.get(symbol) ?? 0) + 1)
    if (!first.has(symbol)) first.set(symbol, id)
  }
  const bySymbol = new Map<string, string>()
  for (const [symbol, count] of counts) if (count === 1) bySymbol.set(symbol, first.get(symbol) as string)
  return { byKey, bySymbol }
}

/** The CoinMarketCap id of a catalogue row, or null when it genuinely resolves
 * to nothing.
 *
 * Three steps, narrowest first:
 *   1. `marketCmcIdentity` — the SAME resolver `intel-markets` uses for the
 *      chart. It accepts a CoinMarketCap-sourced row directly, maps an issuer
 *      identity, and maps a native asset through its canonical key.
 *   2. the CANONICAL KEY of a CoinMarketCap-sourced catalogue row. The catalogue
 *      holds both providers' rows; when a CoinGecko-sourced asset and a
 *      CoinMarketCap one resolve to the same canonical identity they ARE the
 *      same asset, so the CoinMarketCap id is the one to buy history against.
 *   3. a normalized symbol that exactly ONE CoinMarketCap asset claims. An
 *      ambiguous ticker resolves to nothing rather than to a guess.
 *
 * Deriving the id from `source_provider` alone, as the lane first did, left every
 * CoinGecko-sourced top-100 asset without its pre-venue years. */
// deno-lint-ignore no-explicit-any
export function cmcIdOf(row: any, index: CmcCatalogueIndex = { byKey: new Map(), bySymbol: new Map() }): string | null {
  try {
    const direct = marketCmcIdentity(row)
    if (typeof direct === 'string' && /^[1-9][0-9]{0,9}$/.test(direct)) return direct
  } catch { /* an unresolvable row is a null identity, not a failed run */ }
  const key = marketCanonicalIdentity(row).canonicalAssetKey
  if (key && index.byKey.has(key)) return index.byKey.get(key) as string
  const symbol = String(row?.normalized_symbol || row?.symbol || '').toUpperCase().trim()
  return symbol && index.bySymbol.has(symbol) ? index.bySymbol.get(symbol) as string : null
}

/** The catalogue's top N by rank, plus every asset a reader has opened. The two
 * lists are merged on the canonical asset key; a demanded asset that is also in
 * the top N keeps the better (lower) priority. */
// deno-lint-ignore no-explicit-any
export function backfillCandidates(catalogue: any[], demand: any[], now: number,
  index: CmcCatalogueIndex = { byKey: new Map(), bySymbol: new Map() }): Record<string, unknown>[] {
  const byKey = new Map<string, Record<string, unknown>>()
  const add = (key: string | null, row: Record<string, unknown>) => {
    if (!key) return
    const held = byKey.get(key)
    if (!held || Number(row.priority) < Number(held.priority)) byKey.set(key, { ...held, ...row, asset_key: key })
  }
  for (const row of catalogue || []) {
    const key = marketCanonicalIdentity(row).canonicalAssetKey
      || (row?.source_provider && row?.provider_id != null ? `market:${row.source_provider}:${row.provider_id}` : null)
    const rank = Number(row?.market_cap_rank)
    add(key, {
      provider: text(row?.source_provider, 40), provider_id: text(row?.provider_id, 40),
      // The CoinMarketCap id is resolved the SAME way the chart read resolves it,
      // from the catalogue row: a CoinGecko-sourced asset can still have a CMC
      // listing, through its issuer identity or the native-asset table. Deriving
      // it from `source_provider` alone left XRP with Binance history from 2018
      // and no pre-venue years, and stablecoins with no history at all.
      cmc_id: cmcIdOf(row, index),
      symbol: text(row?.normalized_symbol || row?.symbol, 50),
      priority: Number.isFinite(rank) && rank > 0 ? Math.trunc(rank) : BACKFILL_TOP_N + 1,
      state: 'pending', first_seen_at: new Date(now).toISOString(),
    })
  }
  for (const row of demand || []) {
    // A demanded asset carries no rank; it queues behind the ranked cohort but
    // ahead of nothing, because someone has actually opened it.
    add(text(row?.asset_key, 200), {
      provider: text(row?.provider, 40), provider_id: text(row?.provider_id, 40), symbol: null,
      cmc_id: cmcIdOf({ source_provider: row?.provider, provider_id: row?.provider_id, platforms: row?.platforms }, index),
      priority: BACKFILL_TOP_N + 1, state: 'pending', first_seen_at: new Date(now).toISOString(),
    })
  }
  return [...byKey.values()]
}

/** Put the queue in the state table. Existing rows are never reset: the insert
 * ignores a conflict, so a completed asset stays completed and a resumable one
 * keeps its progress. */
// deno-lint-ignore no-explicit-any
export async function seedBackfillQueue(db: any, now: number): Promise<{ seeded: number; reason: string | null }> {
  const [catalogue, demand, cmcRows] = await Promise.all([
    readRows(() => db.from('market_assets')
      .select('source_provider,provider_id,symbol,normalized_symbol,market_cap_rank,platforms')
      .eq('in_current_catalog', true).not('market_cap_rank', 'is', null)
      .order('market_cap_rank', { ascending: true }).limit(BACKFILL_TOP_N)),
    readRows(() => db.from('market_asset_demand').select('asset_key,provider,provider_id')
      .order('last_demanded_at', { ascending: false }).limit(250)),
    // CoinMarketCap-sourced rows, for the identity join. NOT filtered by
    // `in_current_catalog`: when the live catalogue is the CoinGecko one, the
    // CoinMarketCap rows are retained rather than current, and they are exactly
    // the rows that carry the ids the paid rung needs.
    readRows(() => db.from('market_assets')
      .select('source_provider,provider_id,symbol,normalized_symbol,market_cap_rank,platforms')
      .eq('source_provider', CAPTURE_PROVIDER)
      .order('market_cap_rank', { ascending: true }).limit(CMC_INDEX_ROWS)),
  ])
  const rows = backfillCandidates(catalogue.rows, demand.rows, now, cmcCatalogueIndex(cmcRows.rows))
  if (!rows.length) return { seeded: 0, reason: catalogue.reason || demand.reason }
  try {
    const { error } = await db.from(BACKFILL_TABLE).upsert(rows, { onConflict: 'asset_key', ignoreDuplicates: true })
    if (error) return { seeded: 0, reason: String(error.message || error).slice(0, 200) }
  } catch (e) { return { seeded: 0, reason: ((e as Error)?.message || 'seed_failed').slice(0, 200) } }
  return { seeded: rows.length, reason: catalogue.reason || demand.reason }
}

/** Credits the backfill has already spent, from the state table. */
// deno-lint-ignore no-explicit-any
export async function spentCredits(db: any): Promise<number> {
  const page = await readRows(() => db.from(BACKFILL_TABLE).select('credits_spent').gt('credits_spent', 0).limit(2000))
  return page.rows.reduce((sum, row) => sum + (Number(row?.credits_spent) || 0), 0)
}

// deno-lint-ignore no-explicit-any
async function saveState(db: any, assetKey: string, patch: Record<string, unknown>): Promise<string | null> {
  try {
    const { error } = await db.from(BACKFILL_TABLE).update(patch).eq('asset_key', assetKey)
    return error ? String(error.message || error).slice(0, 200) : null
  } catch (e) { return ((e as Error)?.message || 'state_write_failed').slice(0, 200) }
}

/** One asset's pass, with its state row updated from the outcome. */
// deno-lint-ignore no-explicit-any
async function runOne(db: any, row: any, ctx: MarketAssetsContext, now: number, budget: number, deps: CandleLaneDeps,
  mode: BackfillMode = 'full'): Promise<AssetHistoryResult> {
  const assetKey = String(row?.asset_key || '')
  // The id the SEED resolved, which is the one the stored years were bought
  // against. A row seeded before the column existed falls back to the resolver,
  // so an older queue is not left behind by the fix.
  const seededCmcId = String(row?.cmc_id || '')
  const cmcId = /^[1-9][0-9]{0,9}$/.test(seededCmcId) ? seededCmcId
    : cmcIdOf({ source_provider: row?.provider, provider_id: row?.provider_id })
  // The FORWARD walk starts the day after what is already stored, so no pass
  // ever re-asks for a stored period. The mode is passed by the CALLER, not
  // inferred from the state: the daily append resumes an asset that is COMPLETE,
  // and a partial asset's paid rung owes the OLDER years, not the newer ones.
  const storedNewest = Date.parse(String(row?.newest_candle || ''))
  const storedOldest = Date.parse(String(row?.oldest_candle || ''))
  const from = Number.isFinite(storedNewest) && mode !== 'full' ? storedNewest + DAY : HISTORY_EPOCH_MS
  const outcome = await backfillAssetHistory(db, { assetKey, symbol: text(row?.symbol, 50), cmcId }, ctx, now, budget, deps,
    { mode, from, oldest: Number.isFinite(storedOldest) ? storedOldest : null })
  const attempts = (Number(row?.attempts) || 0) + 1
  const held = String(row?.state || 'pending')
  const stored = Number(row?.candles) || 0
  // A daily append stores one day. It must never narrow the recorded window to
  // that day, and must never turn a finished asset back into an unfilled one.
  const state = outcome.error ? 'partial'
    : held === 'complete' ? 'complete'
    : outcome.rows === 0 ? (stored > 0 ? held : 'unavailable')
    : outcome.complete ? 'complete' : 'partial'
  const earliest = [row?.oldest_candle ? String(row.oldest_candle) : null, outcome.oldest != null ? dayOnly(outcome.oldest) : null].filter((v): v is string => !!v).sort()
  const latest = [row?.newest_candle ? String(row.newest_candle) : null, outcome.newest != null ? dayOnly(outcome.newest) : null].filter((v): v is string => !!v).sort()
  const oldest = earliest[0] ?? null
  const newest = latest.at(-1) ?? null
  const error = await saveState(db, assetKey, {
    state, source: outcome.source, oldest_candle: oldest, newest_candle: newest,
    candles: (Number(row?.candles) || 0) + outcome.rows,
    credits_spent: (Number(row?.credits_spent) || 0) + outcome.credits,
    attempts, reason: outcome.error || outcome.reason, last_attempt_at: new Date(now).toISOString(),
    completed_at: state === 'complete' ? (row?.completed_at ?? new Date(now).toISOString()) : null,
    updated_at: new Date(now).toISOString(),
  })
  return { ...outcome, ...(error ? { error } : {}) }
}

// ─── Ops ──────────────────────────────────────────────────────────────────────

/** The queued backfill: seed, then fill at most `BACKFILL_ASSETS_PER_RUN` assets,
 * resumable, bounded by both the run's own credit ceiling and the standing
 * budget in `provider_schedule_policy.max_credits`. */
// deno-lint-ignore no-explicit-any
export async function captureCandleBackfill(db: any, ctxFor: (name: string, maxCalls: number) => MarketAssetsContext,
  now = new Date(), plan = 'basic', deps: CandleLaneDeps = { request: () => Promise.resolve(null) }): Promise<JobResult> {
  const job = 'candle_backfill'
  const at = now instanceof Date ? now.getTime() : now
  let credits = 0
  try {
    const policy = lanePolicy(deps, 'candle_history')
    if (!policy.enabled) return { job, rows: 0, credits: 0, skipped: 'policy_disabled' }
    const seed = await seedBackfillQueue(db, at)
    const ceiling = policy.maxCredits ?? BACKFILL_CREDIT_CEILING
    const alreadySpent = await spentCredits(db)
    let budget = Math.max(0, Math.min(BACKFILL_RUN_CREDITS, ceiling - alreadySpent))
    // A CoinMarketCap page needs the Startup plan. Below it the venue path still
    // runs and costs nothing, so the lane is NOT skipped — only its paid rung is.
    if (!planAllows(plan, 'startup')) budget = 0
    const queue = await readRows(() => db.from(BACKFILL_TABLE)
      .select('asset_key,provider,provider_id,cmc_id,symbol,source,state,priority,oldest_candle,newest_candle,candles,credits_spent,attempts,completed_at')
      .in('state', ['pending', 'partial'])
      .order('priority', { ascending: true }).order('asset_key', { ascending: true })
      .limit(BACKFILL_ASSETS_PER_RUN))
    if (!queue.rows.length) {
      return { job, rows: 0, credits: 0, skipped: 'queue_empty', seeded: seed.seeded, creditCeiling: ceiling, creditsSpentToDate: alreadySpent, ...(queue.reason || seed.reason ? { partial: queue.reason || seed.reason } : {}) }
    }
    const ctx = ctxFor('candle-backfill', OHLCV_MAX_PAGES * BACKFILL_ASSETS_PER_RUN)
    const assets: AssetHistoryResult[] = []
    let rows = 0
    for (const row of queue.rows) {
      // A partial asset resumes: its paid rung pages BACKWARD from the oldest
      // day already stored, which is the gap an interrupted run still owes.
      const outcome = await runOne(db, row, ctx, at, budget - credits, deps, String(row?.state) === 'partial' ? 'resume' : 'full')
      credits += outcome.credits
      rows += outcome.rows
      assets.push(outcome)
    }
    return {
      job, rows, credits, seeded: seed.seeded, assets: assets.length,
      complete: assets.filter((a) => a.complete).length,
      creditCeiling: ceiling, creditsSpentToDate: alreadySpent + credits,
      budgetExhausted: credits >= budget && budget > 0,
      detail: assets.map((a) => ({ assetKey: a.assetKey, source: a.source, rows: a.rows, credits: a.credits, complete: a.complete, reason: a.reason ?? null })),
      ...(assets.some((a) => a.error) ? { error: assets.find((a) => a.error)!.error } : {}),
    }
  } catch (e) { return failed(job, credits, e) }
}

/** Backfill ONE named asset, for a live verification run. Uses the whole run
 * ceiling on that one asset and answers with what it stored. */
// deno-lint-ignore no-explicit-any
export async function backfillOneAsset(db: any, assetKey: string, ctxFor: (name: string, maxCalls: number) => MarketAssetsContext,
  now = new Date(), plan = 'basic', deps: CandleLaneDeps = { request: () => Promise.resolve(null) }): Promise<JobResult> {
  const job = 'history_backfill'
  const at = now instanceof Date ? now.getTime() : now
  try {
    const key = String(assetKey || '').trim()
    if (!key || key.length > 200) return { job, rows: 0, credits: 0, error: 'invalid_asset_key' }
    const policy = lanePolicy(deps, 'candle_history')
    if (!policy.enabled) return { job, rows: 0, credits: 0, skipped: 'policy_disabled' }
    const existing = await readRows(() => db.from(BACKFILL_TABLE)
      .select('asset_key,provider,provider_id,cmc_id,symbol,source,state,oldest_candle,newest_candle,candles,credits_spent,attempts,completed_at').eq('asset_key', key).limit(1))
    let row = existing.rows[0]
    if (!row) {
      // The asset is not queued yet. Its identity is resolved from the SAME two
      // sources the seeder uses; a key in neither is refused rather than queued
      // from a guessed symbol that would fill the archive with the wrong asset.
      const [catalogue, demand, cmcRows] = await Promise.all([
        readRows(() => db.from('market_assets')
          .select('source_provider,provider_id,symbol,normalized_symbol,market_cap_rank,platforms')
          .eq('in_current_catalog', true).order('market_cap_rank', { ascending: true }).limit(CMC_INDEX_ROWS)),
        readRows(() => db.from('market_asset_demand').select('asset_key,provider,provider_id').eq('asset_key', key).limit(1)),
        readRows(() => db.from('market_assets')
          .select('source_provider,provider_id,symbol,normalized_symbol,market_cap_rank,platforms')
          .eq('source_provider', CAPTURE_PROVIDER).order('market_cap_rank', { ascending: true }).limit(CMC_INDEX_ROWS)),
      ])
      const seeded = backfillCandidates(catalogue.rows, demand.rows, at, cmcCatalogueIndex(cmcRows.rows)).find((candidate) => candidate.asset_key === key)
      if (!seeded) return { job, rows: 0, credits: 0, error: 'asset_not_in_catalogue', assetKey: key }
      const write = await upsert(db, BACKFILL_TABLE, [seeded], 'asset_key')
      if (write.error) return { job, rows: 0, credits: 0, error: write.error }
      row = { ...seeded, state: 'pending' }
    }
    const ceiling = policy.maxCredits ?? BACKFILL_CREDIT_CEILING
    const alreadySpent = await spentCredits(db)
    const budget = planAllows(plan, 'startup') ? Math.max(0, Math.min(BACKFILL_RUN_CREDITS, ceiling - alreadySpent)) : 0
    const outcome = await runOne(db, row, ctxFor('candle-history', OHLCV_MAX_PAGES + 2), at, budget, deps,
      String(row?.state) === 'partial' ? 'resume' : 'full')
    return {
      job, rows: outcome.rows, credits: outcome.credits, assetKey: key, source: outcome.source,
      complete: outcome.complete, creditCeiling: ceiling, creditsSpentToDate: alreadySpent + outcome.credits,
      oldest: outcome.oldest != null ? dayOnly(outcome.oldest) : null,
      newest: outcome.newest != null ? dayOnly(outcome.newest) : null,
      ...(outcome.reason ? { partial: outcome.reason } : {}), ...(outcome.error ? { error: outcome.error } : {}),
    }
  } catch (e) { return failed(job, 0, e) }
}

/** Yesterday's candle for every asset the archive already holds.
 *
 * Assets are taken oldest-newest-candle first, so an asset that fell behind is
 * caught up before one that is current and nothing starves. The free venue path
 * costs nothing; the paid rung is bounded by `DAILY_APPEND_CREDITS`. */
// deno-lint-ignore no-explicit-any
export async function captureCandleDaily(db: any, ctxFor: (name: string, maxCalls: number) => MarketAssetsContext,
  now = new Date(), plan = 'basic', deps: CandleLaneDeps = { request: () => Promise.resolve(null) }): Promise<JobResult> {
  const job = 'candle_daily'
  const at = now instanceof Date ? now.getTime() : now
  let credits = 0
  try {
    const policy = lanePolicy(deps, 'candle_daily')
    if (!policy.enabled) return { job, rows: 0, credits: 0, skipped: 'policy_disabled' }
    const yesterday = dayOnly(Math.floor(at / DAY) * DAY - DAY)
    const queue = await readRows(() => db.from(BACKFILL_TABLE)
      .select('asset_key,provider,provider_id,cmc_id,symbol,source,state,oldest_candle,newest_candle,candles,credits_spent,attempts,completed_at')
      .in('state', ['complete', 'partial'])
      .order('newest_candle', { ascending: true, nullsFirst: true }).order('asset_key', { ascending: true })
      .limit(DAILY_APPEND_ASSETS))
    const due = queue.rows.filter((row) => String(row?.newest_candle || '') < yesterday)
    if (!due.length) {
      return { job, rows: 0, credits: 0, skipped: 'nothing_due', day: yesterday, tracked: queue.rows.length, ...(queue.reason ? { partial: queue.reason } : {}) }
    }
    const ctx = ctxFor('candle-daily', DAILY_APPEND_ASSETS + 8)
    const paid = planAllows(plan, 'startup') ? DAILY_APPEND_CREDITS : 0
    let rows = 0, appended = 0, skippedForBudget = 0
    for (const row of due) {
      const remaining = paid - credits
      // An asset with no venue pair can only be appended through the paid rung.
      // With the paid budget gone it is left for the next run rather than
      // recorded as having no candle for the day.
      if (remaining <= 0 && !row?.symbol) { skippedForBudget += 1; continue }
      // FORWARD ONLY. The append asks for the days AFTER the newest stored
      // candle and never walks older years, so a Binance asset costs nothing and
      // an asset no venue lists costs about one credit a day.
      const outcome = await runOne(db, row, ctx, at, Math.max(0, remaining), deps, 'append')
      credits += outcome.credits
      rows += outcome.rows
      if (outcome.rows) appended += 1
    }
    return { job, rows, credits, day: yesterday, assets: due.length, appended, skippedForBudget, tracked: queue.rows.length, ...(queue.reason ? { partial: queue.reason } : {}) }
  } catch (e) { return failed(job, credits, e) }
}

/** Integration surface, wired in `intel-capture/index.ts` alongside the other
 * lanes. `history_backfill` takes an `assetKey` from the request body. */
export const CANDLE_CAPTURE_OPS: Record<string, (
  // deno-lint-ignore no-explicit-any
  admin: any, ctxFor: (name: string, maxCalls: number) => MarketAssetsContext, now: Date, plan: string, deps: CaptureDeps, body?: Record<string, unknown>
) => Promise<JobResult>> = {
  candle_backfill: (admin, ctxFor, now, plan, deps) => captureCandleBackfill(admin, ctxFor, now, plan, deps as CandleLaneDeps),
  candle_daily: (admin, ctxFor, now, plan, deps) => captureCandleDaily(admin, ctxFor, now, plan, deps as CandleLaneDeps),
  history_backfill: (admin, ctxFor, now, plan, deps, body) => backfillOneAsset(admin, String(body?.assetKey ?? ''), ctxFor, now, plan, deps as CandleLaneDeps),
}
