// Investor Intel — chart candles from STORED prices only.
//
// Two callers:
//   * the public demo (intel-demo-read), which may never ask a provider: every
//     range of every tracked asset is answered from here first;
//   * a member's chart (intel-markets), as the LAST rung of the candle ladder,
//     when no live source answered (a sub-hour range on an asset with no verified
//     exchange listing, a tokenised real-world asset token, a refused request).
//
// Where the prices come from (public.intel_stored_price_series, migration
// 20260923140000_intel_stored_price_series.sql):
//
//   quotes             CoinMarketCap quotes the observation lanes store, every 2 to
//                      5 minutes for assets in use and hourly for the rest
//                      (intel_quote_tape, a narrow copy of intel_market_observations)
//   wrapper captures   the six-hourly RWA wrapper lane (intel_rwa_wrapper_tokens)
//   coverage captures  the daily RWA universe lane (intel_rwa_coverage_tokens)
//   catalogue snapshots  the CoinGecko catalogue every 30 minutes, for a CoinGecko
//                      asset with no CoinMarketCap identity (market_asset_snapshots)
//   archive            stored daily candles (market_asset_candles)
//   backfill           daily closes from the CoinMarketCap OHLCV backfill
//                      (intel_rwa_wrapper_premium_backfill)
//
// HONESTY RULES
//   * A candle's open, high, low and close are the first, highest, lowest and last
//     STORED price inside its period. The coverage and the caption say so: the
//     high and low are those of the stored quotes, not of every trade.
//   * A period with no stored price is not drawn. Nothing is carried forward,
//     interpolated or filled in: a gap stays a gap.
//   * A backfill day holds a close only and is drawn as a close, never as a
//     candle with invented open, high and low; a chart holding one draws a line.
//   * The width is never finer than the stored prices can support: a candle is
//     at least twice the typical spacing of the stored prices, so a candle holds
//     about two prices or more. When the window is too short for that, fewer
//     prices per candle are drawn and the spacing is stated.
//   * Only periods that have closed are candles. The period in progress is not.
//
// Pure planning (storedWidthPlan, the bar builders) is exported and tested with
// no database; loadStoredCandles takes its RPC as an injectable function.

import { CHART_INTERVALS } from './cmc-chart.ts'
import { autoInterval, CANDLE_RANGE_MS, intervalLabel, sourceLabel, spanWords } from './candle-ladder.ts'
import { marketCanonicalIdentity } from './market-read-quality.ts'
import { marketCmcIdentity } from './market-asset-source.ts'
import type { Bar } from './chart-analysis.ts'

const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000, WEEK = 7 * DAY

/** Widths, finest first. Intraday ones are built by the database from stored
 * prices; '1D' and '1W' from the daily rows. */
export const STORED_WIDTHS = ['1M', '5M', '15M', '30M', '1H', '4H', '1D', '1W'] as const
export const STORED_INTRADAY = ['1M', '5M', '15M', '30M', '1H', '4H'] as const
/** Candles one window may hold; a finer width that would exceed it steps up. */
export const STORED_MAX_BARS = 4000
/** An automatic long range stays daily until it would draw more days than this,
 * then it is drawn in complete weeks. */
export const STORED_WEEKLY_AFTER = 3000
/** Nothing we store predates this. */
export const STORED_EPOCH_MS = Date.UTC(2009, 0, 1)
/** A candle must hold about this many stored prices at the typical spacing. */
export const PRICES_PER_CANDLE = 2
/** A window whose stored prices begin more than this share of the window late
 * falls back to daily rows when those reach further back. */
export const LATE_START_SHARE = 0.2

// deno-lint-ignore no-explicit-any
type Any = any
export type StoredMode = 'stats' | 'buckets' | 'daily'
export type StoredRpc = (mode: StoredMode, args: { from: number; to: number; bucketSeconds?: number }) => Promise<Any>

export interface StoredIdentity {
  /** CoinMarketCap listing id: quotes, RWA captures and the backfill. */
  cmcId: string | null
  /** CoinGecko id, read only when there is no CoinMarketCap id. */
  coingeckoId: string | null
  /** market_asset_candles keys to read besides the ones the archive maps itself. */
  archiveKeys: string[]
}

/** The stored-price identity of a catalogue row (market_assets shape). */
export function storedIdentity(asset: Any): StoredIdentity {
  const cmcId = marketCmcIdentity(asset)
  const coingeckoId = asset?.source_provider === 'coingecko' && /^[a-z0-9][a-z0-9._-]{0,119}$/.test(String(asset?.provider_id ?? ''))
    ? String(asset.provider_id) : null
  const keys = [
    marketCanonicalIdentity(asset).canonicalAssetKey,
    cmcId ? `cmc:${cmcId}` : null,
    asset?.source_provider && asset?.provider_id != null ? `market:${asset.source_provider}:${asset.provider_id}` : null,
  ].filter((key): key is string => typeof key === 'string' && /^[A-Za-z0-9:._/-]{1,200}$/.test(key))
  return { cmcId, coingeckoId, archiveKeys: [...new Set(keys)].slice(0, 8) }
}

const widthMs = (width: string) => CHART_INTERVALS[width] ?? 0
const wider = (a: string, b: string) => (widthMs(a) >= widthMs(b) ? a : b)
/** The finest width of at least `ms`, or null. */
export function widthAtLeast(ms: number): string | null {
  return STORED_WIDTHS.find((width) => widthMs(width) >= ms) ?? null
}
/** The widest width of at most `ms`, or the finest width. */
export function widthAtMost(ms: number): string {
  return [...STORED_WIDTHS].reverse().find((width) => widthMs(width) <= ms) ?? STORED_WIDTHS[0]
}

export interface StoredStats {
  points: number
  first: string | null
  last: string | null
  spacingSeconds: number | null
  sources: Record<string, number>
  archiveFirst: string | null
  backfillFirst: string | null
}

export interface StoredWidthPlan {
  mode: 'intraday' | 'daily'
  /** The width that will be drawn. */
  width: string
  /** What the caller asked for, 'auto' resolved. */
  requested: string
  substituted: boolean
  /** Why the width differs from the request, for the coverage sentence. */
  reason: 'as_requested' | 'price_spacing' | 'short_window' | 'bar_ceiling' | 'daily_reaches_further' | 'no_intraday_prices'
  /** 'auto' on a long range: daily until the daily rows exceed STORED_WEEKLY_AFTER. */
  weeklyIfLong: boolean
}

const time = (value: unknown) => { const t = Date.parse(String(value ?? '')); return Number.isFinite(t) ? t : null }

/**
 * The width a window is drawn at. Pure.
 *
 *   requested  'auto' becomes the app's automatic width for the range.
 *   spacing    a candle is at least twice the median spacing of the stored
 *              prices, so it holds about two of them.
 *   window     never wider than a sixth of the window, so even a short window
 *              draws a few candles; a window that forces a finer width than the
 *              spacing supports draws fewer prices per candle, and says so.
 *   ceiling    never more than STORED_MAX_BARS candles.
 *   coverage   when the stored prices begin well inside the window and the daily
 *              rows (the archive, the backfill) reach meaningfully further back,
 *              the window is drawn from the daily rows instead.
 */
export function storedWidthPlan(range: string, interval: string, stats: StoredStats | null, now: number): StoredWidthPlan {
  const duration = CANDLE_RANGE_MS[range]
  if (!duration) throw new Error('invalid_chart_parameters')
  if (interval !== 'auto' && !CHART_INTERVALS[interval]) throw new Error('invalid_chart_parameters')
  const requested = interval === 'auto' ? autoInterval(duration) : interval
  const weeklyIfLong = interval === 'auto' && requested === '1W'
  const daily = (reason: StoredWidthPlan['reason'], width = requested === '1W' ? '1W' : '1D'): StoredWidthPlan =>
    ({ mode: 'daily', width, requested, substituted: width !== requested && !weeklyIfLong, reason, weeklyIfLong })
  if (widthMs(requested) >= DAY) return daily('as_requested')
  if (!stats || !(stats.points > 0)) return daily('no_intraday_prices')

  let width = requested
  let reason: StoredWidthPlan['reason'] = 'as_requested'
  const spacingMs = stats.points > 1 && Number(stats.spacingSeconds) > 0 ? Number(stats.spacingSeconds) * 1000 : duration
  const supported = widthAtLeast(PRICES_PER_CANDLE * spacingMs) ?? '1D'
  if (widthMs(supported) > widthMs(width)) { width = supported; reason = 'price_spacing' }
  const windowCap = widthAtMost(duration / 6)
  if (widthMs(width) > widthMs(windowCap)) { width = wider(requested, windowCap); reason = 'short_window' }
  while (duration / widthMs(width) > STORED_MAX_BARS) {
    const next = STORED_WIDTHS[STORED_WIDTHS.indexOf(width as typeof STORED_WIDTHS[number]) + 1]
    if (!next) break
    width = next; reason = 'bar_ceiling'
  }
  if (widthMs(width) >= DAY) return daily(reason === 'as_requested' ? 'price_spacing' : reason, width === '1W' ? '1W' : '1D')

  // Coverage: stored prices that begin well inside the window, while the daily
  // rows begin meaningfully earlier, are drawn from the daily rows.
  const windowFrom = now - duration
  const first = time(stats.first)
  const dailyFirst = [time(stats.archiveFirst), time(stats.backfillFirst)].filter((t): t is number => t != null)
  const reachesFrom = dailyFirst.length ? Math.min(...dailyFirst) : null
  if (first != null && duration >= 3 * DAY && first - windowFrom > LATE_START_SHARE * duration
    && reachesFrom != null && reachesFrom < first - LATE_START_SHARE * duration) {
    return daily('daily_reaches_further', '1D')
  }
  return { mode: 'intraday', width, requested, substituted: width !== requested, reason, weeklyIfLong: false }
}

const num = (value: unknown): number | null => {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export interface BuiltBars { bars: Bar[]; prices: number; singles: number; closesOnly: number }

/** Intraday rows [open ms, o, h, l, c, prices, newest price ms] → bars. A bucket
 * holding ONE stored price is drawn flat at that price: its open, high, low and
 * close are that price, which is exactly what was stored. */
export function intradayBars(rows: unknown, step: number): BuiltBars {
  const bars: Bar[] = []
  let prices = 0, singles = 0
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!Array.isArray(row)) continue
    const t = num(row[0]), o = num(row[1]), h = num(row[2]), l = num(row[3]), c = num(row[4]), n = num(row[5]) ?? 0
    if (t == null || c == null || c <= 0 || o == null || h == null || l == null || t % step !== 0) continue
    if (!(h >= Math.max(o, c, l) && l <= Math.min(o, c, h) && l > 0)) continue
    prices += n
    if (n <= 1) singles++
    bars.push({ t, o, h, l, c, v: null, closedAt: t + step - 1 })
  }
  return { bars: bars.sort((a, b) => a.t - b.t), prices, singles, closesOnly: 0 }
}

export interface DailyRow { t: number; o: number | null; h: number | null; l: number | null; c: number; v: number | null; n: number | null; kind: 'archive' | 'backfill' | 'quotes'; provider: string }

/** Daily rows [day ms, o, h, l, c, v, prices, kind, provider] → typed rows. */
export function dailyRows(rows: unknown): DailyRow[] {
  const out: DailyRow[] = []
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!Array.isArray(row)) continue
    const t = num(row[0]), c = num(row[4])
    const kind = row[7] === 'archive' || row[7] === 'backfill' || row[7] === 'quotes' ? row[7] : null
    if (t == null || c == null || c <= 0 || !kind || t % DAY !== 0) continue
    let o = num(row[1]), h = num(row[2]), l = num(row[3])
    // A candle whose own numbers disagree is kept as its close only.
    if (o == null || h == null || l == null || !(h >= Math.max(o, c, l) && l <= Math.min(o, c, h) && l > 0)) o = h = l = null
    const v = num(row[5])
    out.push({ t, o, h, l, c, v: v != null && v >= 0 ? v : null, n: num(row[6]), kind, provider: typeof row[8] === 'string' ? row[8] : 'coinmarketcap' })
  }
  return out.sort((a, b) => a.t - b.t)
}

/** Daily rows → daily bars. */
export function dayBars(rows: DailyRow[]): BuiltBars {
  let prices = 0, singles = 0, closesOnly = 0
  const bars = rows.map((row) => {
    if (row.kind === 'quotes') { prices += row.n ?? 0; if ((row.n ?? 0) <= 1) singles++ }
    if (row.o == null) closesOnly++
    return { t: row.t, o: row.o, h: row.h, l: row.l, c: row.c, v: row.v, closedAt: row.t + DAY - 1, ...(row.v != null ? { volumeKind: 'period' as const, volumeUnit: 'USD' as const } : {}) }
  })
  return { bars, prices, singles, closesOnly }
}

/** Complete Monday-to-Sunday UTC weeks from daily rows. A week missing a day is
 * not drawn (a gap stays a gap). A week with any close-only day is its closing
 * day's close only. Volume is summed only when every day reported it. */
export function weekBars(rows: DailyRow[], now: number): BuiltBars {
  const offset = 4 * DAY // 1970-01-01 was a Thursday; weeks open on Monday.
  const groups = new Map<number, DailyRow[]>()
  for (const row of rows) {
    const week = Math.floor((row.t - offset) / WEEK) * WEEK + offset
    const list = groups.get(week) || []
    list.push(row)
    groups.set(week, list)
  }
  const bars: Bar[] = []
  let closesOnly = 0
  for (const [t, days] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (t + WEEK > now || days.length !== 7) continue
    days.sort((a, b) => a.t - b.t)
    const ohlc = days.every((d) => d.o != null && d.h != null && d.l != null)
    if (!ohlc) closesOnly++
    const volume = days.every((d) => d.v != null) ? days.reduce((sum, d) => sum + (d.v as number), 0) : null
    bars.push({
      t, closedAt: t + WEEK - 1, c: days[6].c,
      o: ohlc ? days[0].o : null, h: ohlc ? Math.max(...days.map((d) => d.h as number)) : null, l: ohlc ? Math.min(...days.map((d) => d.l as number)) : null,
      v: volume, ...(volume != null ? { volumeKind: 'period' as const, volumeUnit: 'USD' as const } : {}),
    })
  }
  return { bars, prices: 0, singles: 0, closesOnly }
}

const PROVIDER_ORDER: Record<string, number> = { binance: 0, coinbase: 1, kraken: 2, kucoin: 3, coinmarketcap: 4, coinmarketcap_kline: 5, coingecko: 6 }
/** A `+`-joined provider label, venues before aggregates, as the archive names it. */
export function providerList(providers: Iterable<string>): string {
  return [...new Set([...providers].filter(Boolean))].sort((a, b) => (PROVIDER_ORDER[a] ?? 99) - (PROVIDER_ORDER[b] ?? 99) || a.localeCompare(b)).join('+')
}

/** "about 2 min", "about 1 h", "about 6 h", "about 1 d" for the coverage sentence. */
export function spacingWords(seconds: number | null): string | null {
  if (!(Number(seconds) > 0)) return null
  const ms = Number(seconds) * 1000
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MINUTE))} min`
  if (ms < DAY) return `${Math.round(ms / HOUR)} h`
  return `${Math.round(ms / DAY)} d`
}

/** What the page says about a stored series, in data; the chart renders it in
 * the reader's language (src/intel/lib/stored-series-caption.js). */
export interface StoredSeries {
  version: 1
  /** 'quotes': intraday candles from stored prices. 'daily' / 'weekly': daily rows. */
  mode: 'quotes' | 'daily' | 'weekly'
  interval: string
  intervalMs: number
  requestedInterval: string
  substituted: boolean
  reason: StoredWidthPlan['reason']
  /** The provider of the stored prices ('coinmarketcap' or 'coingecko'). */
  quoteProvider: string
  /** Stored prices inside the drawn candles, and how they are spaced. */
  prices: number
  spacingSeconds: number | null
  /** Candles built from a single stored price. */
  singles: number
  /** Bars that carry a close only (the chart then draws a line). */
  closesOnly: number
  /** Where the prices came from, counted: quotes, wrapper_captures, coverage_captures, catalogue_snapshots. */
  sources: Record<string, number>
  /** Daily bars by kind, and the archive's own providers. */
  days: { archive: number; backfill: number; quotes: number; archiveProviders: string[] }
  bars: number
  firstAt: string | null
  lastAt: string | null
  /** Newest stored price behind the series. */
  latestPriceAt: string | null
  windowFrom: string
  /** True when the first candle is inside the window's first period. */
  reachesStart: boolean
  /** Time the stored read took on the server, in milliseconds. */
  readMs: number
}

const iso = (t: number | null | undefined) => (t == null || !Number.isFinite(t) ? null : new Date(t).toISOString())

// deno-lint-ignore no-explicit-any
export function storedRpc(db: any, identity: StoredIdentity): StoredRpc {
  return async (mode, args) => {
    const { data, error } = await db.rpc('intel_stored_price_series', {
      p_mode: mode, p_cmc_id: identity.cmcId, p_coingecko_id: identity.cmcId ? null : identity.coingeckoId,
      p_archive_keys: identity.archiveKeys, p_from: new Date(Math.max(STORED_EPOCH_MS, args.from)).toISOString(),
      p_to: new Date(args.to).toISOString(), p_bucket_seconds: args.bucketSeconds ?? null,
    })
    if (error) throw new Error(`stored_series_unavailable:${String(error.code || error.message || '').slice(0, 60)}`)
    return data
  }
}

/**
 * One chart answer from stored prices. Never calls a provider. Returns the
 * ladder's response shape plus `storedSeries`; an empty `candles` with reason
 * 'no_stored_prices' when nothing is stored for the window.
 */
export async function loadStoredCandles(db: Any, identity: StoredIdentity, range = '7D', interval = 'auto', now = Date.now(), lookback = 0, rpc?: StoredRpc): Promise<Any> {
  const duration = CANDLE_RANGE_MS[range]
  if (!duration) throw new Error('invalid_chart_parameters')
  const started = Date.now()
  const call = rpc ?? storedRpc(db, identity)
  const warm = Number.isFinite(Number(lookback)) ? Math.max(0, Math.min(1000, Math.trunc(Number(lookback)))) : 0
  if (!identity.cmcId && !identity.coingeckoId && !identity.archiveKeys.length) return emptyAnswer(range, interval, now, 'no_stored_identity')
  const windowFrom = now - duration
  const requestedIntraday = widthMs(interval === 'auto' ? autoInterval(duration) : interval) < DAY
  const stats: StoredStats | null = requestedIntraday ? await call('stats', { from: windowFrom, to: now }) : null
  const plan = storedWidthPlan(range, interval, stats, now)

  let built: BuiltBars, width = plan.width, mode: StoredSeries['mode'], sources: Record<string, number> = {}, latest: number | null = null
  const days = { archive: 0, backfill: 0, quotes: 0, archiveProviders: [] as string[] }
  const providers = new Set<string>()
  const quoteProvider = identity.cmcId ? 'coinmarketcap' : 'coingecko'
  if (plan.mode === 'intraday') {
    const step = widthMs(width)
    const answer = await call('buckets', { from: Math.floor((windowFrom - warm * step) / step) * step, to: now, bucketSeconds: step / 1000 })
    built = intradayBars(answer?.bars, step)
    sources = answer?.sources || {}
    latest = time(answer?.last)
    mode = 'quotes'
    providers.add(quoteProvider)
  } else {
    const weeklyWanted = width === '1W'
    const unit = weeklyWanted ? WEEK : DAY
    const answer = await call('daily', { from: windowFrom - warm * unit - (weeklyWanted ? WEEK : 0), to: now })
    const rows = dailyRows(answer?.days)
    sources = answer?.sources || {}
    latest = time(answer?.last)
    const weekly = weeklyWanted && (!plan.weeklyIfLong || rows.length > STORED_WEEKLY_AFTER)
    if (weeklyWanted && !weekly) width = '1D'
    built = weekly ? weekBars(rows, now) : dayBars(rows)
    mode = weekly ? 'weekly' : 'daily'
    for (const row of rows) {
      days[row.kind]++
      providers.add(row.kind === 'quotes' ? quoteProvider : row.provider)
      if (row.kind === 'archive') days.archiveProviders.push(row.provider)
    }
    days.archiveProviders = [...new Set(days.archiveProviders)]
    if (latest == null && rows.length) latest = rows[rows.length - 1].t + DAY - 1
  }
  const step = widthMs(width)
  const bars = built.bars
  if (!bars.length) return emptyAnswer(range, interval, now, 'no_stored_prices', plan, sources)
  const source = providerList(providers)
  const firstBar = bars[0].t
  const reachesStart = firstBar <= windowFrom + step
  const staleAfter = mode === 'quotes' ? Math.max(2 * step, 2 * HOUR) : 3 * DAY
  const series: StoredSeries = {
    version: 1, mode, interval: width, intervalMs: step, requestedInterval: plan.requested,
    substituted: width !== plan.requested && !(plan.weeklyIfLong && width === '1D'), reason: plan.reason,
    quoteProvider, prices: built.prices, spacingSeconds: stats?.spacingSeconds != null ? Math.round(Number(stats.spacingSeconds)) : null,
    singles: built.singles, closesOnly: built.closesOnly, sources, days, bars: bars.length,
    firstAt: iso(firstBar), lastAt: iso(bars[bars.length - 1].t), latestPriceAt: iso(latest), windowFrom: iso(windowFrom) as string, reachesStart,
    readMs: Date.now() - started,
  }
  const hasVolume = bars.some((bar) => bar.v != null)
  return {
    candles: bars, source, bestProvider: source, bestPair: null, barIntervalMs: step, timestampMeaning: 'open',
    ...(hasVolume ? { volumeUnit: 'USD' } : {}),
    coverage: storedCoverage(range, series, now),
    sourceState: latest != null && now - latest <= staleAfter ? 'fresh' : 'stale', sourceReason: null,
    // The newest stored price behind the series is the only clock it has.
    provenance: latest != null ? [{ fetchedAt: iso(latest), origin: 'stored' }] : [], receipts: [], storedSeries: series,
    ladder: { range, source: 'stored', interval: width, requestedInterval: plan.requested, substituted: series.substituted, storedMode: mode, sourcesTried: ['stored'], sourcesUnavailable: [] },
  }
}

function emptyAnswer(range: string, interval: string, now: number, reason: string, plan?: StoredWidthPlan, sources: Record<string, number> = {}): Any {
  const requested = plan?.requested ?? (interval === 'auto' ? autoInterval(CANDLE_RANGE_MS[range] || 0) : interval)
  return {
    candles: [], source: 'stored', bestProvider: null, bestPair: null, barIntervalMs: widthMs(plan?.width ?? requested) || null, timestampMeaning: 'open',
    coverage: `No stored price covers this ${range} window. Nothing was asked of a provider.`,
    sourceState: 'unavailable', sourceReason: reason, provenance: [], receipts: [], storedSources: sources,
    ladder: { range, source: 'stored', interval: plan?.width ?? requested, requestedInterval: requested, substituted: false, sourcesTried: ['stored'], sourcesUnavailable: [`stored:${reason}`] },
    windowFrom: new Date(now - (CANDLE_RANGE_MS[range] || 0)).toISOString(),
  }
}

const SOURCE_WORDS: Record<string, string> = {
  quotes: 'stored CoinMarketCap quotes', wrapper_captures: 'RWA wrapper captures', coverage_captures: 'RWA coverage captures', catalogue_snapshots: 'stored CoinGecko catalogue snapshots',
}

/** The English coverage sentence (the chart's caption is rendered from
 * `storedSeries` in the reader's language). */
export function storedCoverage(range: string, series: StoredSeries, now = Date.now()): string {
  const parts: string[] = []
  const counted = Object.entries(series.sources).filter(([, n]) => Number(n) > 0).map(([key, n]) => `${n} ${SOURCE_WORDS[key] || key}`)
  if (series.mode === 'quotes') {
    const spacing = spacingWords(series.spacingSeconds)
    parts.push(`${intervalLabel(series.interval)} candles for ${range}, built from ${series.prices} stored prices (${counted.join(', ') || 'none'})${spacing ? `, about one every ${spacing}` : ''}.`)
    parts.push('Each candle opens at its first stored price, closes at its last, and its high and low are those of the stored prices, not of every trade.')
    if (series.singles) parts.push(`${series.singles} of ${series.bars} candles hold a single stored price and are drawn flat.`)
  } else {
    const what: string[] = []
    if (series.days.archive) what.push(`${series.days.archive} daily candles from the stored archive (${series.days.archiveProviders.map(sourceLabel).join(', ')})`)
    if (series.days.backfill) what.push(`${series.days.backfill} daily closes from the CoinMarketCap OHLCV backfill`)
    if (series.days.quotes) what.push(`${series.days.quotes} days built from ${counted.join(', ') || 'stored prices'}`)
    parts.push(`${series.mode === 'weekly' ? 'Complete weeks built from ' : ''}${what.join('; ')}.`)
    if (series.closesOnly) parts.push(`${series.closesOnly} of ${series.bars} periods hold a close only, so the chart draws a line of closes.`)
  }
  if (series.substituted) {
    parts.push(series.reason === 'price_spacing' || series.reason === 'no_intraday_prices'
      ? `${intervalLabel(series.requestedInterval)} candles would hold less than one stored price each; these are ${intervalLabel(series.interval)} candles, not relabelled ones.`
      : series.reason === 'daily_reaches_further'
        ? `Stored intraday prices begin late in this window, so it is drawn from daily rows that reach further back.`
        : `${intervalLabel(series.requestedInterval)} candles are not drawn for this window; these are ${intervalLabel(series.interval)} candles.`)
  }
  if (!series.reachesStart && series.firstAt) parts.push(`Stored prices reach back about ${spanWords(now - Date.parse(series.firstAt))}, not the full ${range} window.`)
  parts.push('A period with nothing stored is left empty. Read from stored data; no provider was asked.')
  return parts.join(' ')
}
