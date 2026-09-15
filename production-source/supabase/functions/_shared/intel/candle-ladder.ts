// Investor Intel — the candle ladder: which SOURCE answers a chart request, at
// which INTERVAL, over which RANGE, and what the reader is told about it.
//
// Two things used to be true and are no longer:
//
//   1. The four sub-hour widths were offered ONLY for a contract identity,
//      because the CoinMarketCap k-line aggregate was the only source that could
//      sample below an hour. The free public exchange registry
//      (`_shared/exchange-market`) samples 1m/5m/15m/30m for every pair those
//      venues list, so the widths are now offered for every identity and the
//      LADDER decides whether they can be served.
//   2. The longest range was one year, because one provider window was the whole
//      answer. Stored daily candles (`market_asset_candles`) now carry the years
//      behind that window, so 2Y, 5Y and ALL exist as ranges.
//
// NOTHING HERE FABRICATES A CANDLE. When a range and interval combination needs
// more periods than the chosen source can return in one request, the read answers
// the NEWEST bars it can and the coverage sentence states how far back they
// reach — exactly what `cmc-kline-chart.ts` already does for the k-line path.
// When the chosen source cannot sample the requested width at all, the SERVED
// interval is the finest one it can sample, and the coverage sentence names the
// interval that was served, never the one that was asked for.
//
// This module is pure: no database, no network, no clock except the `now` a
// caller passes. Every ladder decision is therefore testable on its own.

import { CHART_WINDOWS, CHART_INTERVALS, CMC_OHLCV_INTERVALS, SUB_HOUR_INTERVALS } from './cmc-chart.ts'

const HOUR = 3_600_000, DAY = 86_400_000

/** Ranges the chart may ask for. The nine original windows plus the three the
 * archive makes answerable. 'ALL' is not "unbounded": it is twenty years, which
 * predates every asset the catalogue carries (Bitcoin's first traded price is
 * 2010), so a plan built from it can never ask for a period before the asset
 * existed and then call the gap a failure. */
export const ALL_RANGE_MS = 20 * 365 * DAY
export const CANDLE_RANGE_MS: Record<string, number> = {
  ...CHART_WINDOWS,
  '2Y': 2 * 365 * DAY,
  '5Y': 5 * 365 * DAY,
  ALL: ALL_RANGE_MS,
}
/** Ranges whose answer is expected to come mostly from the stored archive. */
export const ARCHIVE_RANGES = ['1Y', '2Y', '5Y', 'ALL'] as const
export const isArchiveRange = (range: unknown) => (ARCHIVE_RANGES as readonly string[]).includes(String(range))

/** App interval key → the exchange registry's interval string. The four
 * providers agree on this vocabulary (`binance` uses it verbatim; `kraken`,
 * `kucoin` and `coinbase` translate it in their own adapters). */
export const EXCHANGE_INTERVALS: Record<string, string> = {
  '1M': '1m', '5M': '5m', '15M': '15m', '30M': '30m', '1H': '1h', '4H': '4h', '1D': '1d', '1W': '1w',
}

/** What each venue can genuinely sample, and how many candles one request
 * returns. These are the venue's own documented ceilings, not guesses:
 *
 *   * binance  `/api/v3/klines` — every width, 1000 rows a request.
 *   * kraken   `/public/OHLC` — every width, 720 rows.
 *   * kucoin   `/api/v1/market/candles` — every width, 1500 rows.
 *   * coinbase `/products/:id/candles` — 300 rows, and its granularity list has
 *     no 30-minute, 4-hour or 1-week bucket. `4h` is NOT listed here even though
 *     the adapter's map has a key for it: that key resolves to 3600 seconds, so
 *     asking coinbase for 4-hour candles returns HOURLY bars. Serving those
 *     under a 4-hour label would be a lie, so coinbase is simply not offered the
 *     width.
 */
export interface VenueCandleLimits { limit: number; intervals: string[] }
export const VENUE_CANDLES: Record<string, VenueCandleLimits> = {
  binance: { limit: 1000, intervals: ['1M', '5M', '15M', '30M', '1H', '4H', '1D', '1W'] },
  kraken: { limit: 720, intervals: ['1M', '5M', '15M', '30M', '1H', '4H', '1D', '1W'] },
  kucoin: { limit: 1500, intervals: ['1M', '5M', '15M', '30M', '1H', '4H', '1D', '1W'] },
  coinbase: { limit: 300, intervals: ['1M', '5M', '15M', '1H', '1D'] },
}
/** The k-line aggregate serves all eight widths, 1000 candles a request. */
export const KLINE_INTERVAL_KEYS = Object.keys(CHART_INTERVALS)
/** CoinMarketCap OHLCV has no period shorter than one hour. */
export const CMC_INTERVAL_KEYS = CMC_OHLCV_INTERVALS

export type CandleSourceId = 'exchange' | 'cmc_ohlcv' | 'kline' | 'coingecko' | 'archive'

/** Human name for a source, used in the coverage sentence. */
export const SOURCE_LABELS: Record<string, string> = {
  exchange: 'a public exchange listing',
  binance: 'Binance', coinbase: 'Coinbase', kraken: 'Kraken', kucoin: 'KuCoin',
  cmc_ohlcv: 'CoinMarketCap OHLCV', coinmarketcap: 'CoinMarketCap OHLCV',
  kline: 'the CoinMarketCap k-line aggregate', coinmarketcap_kline: 'the CoinMarketCap k-line aggregate',
  coingecko: 'CoinGecko', geckoterminal: 'a GeckoTerminal pool', birdeye: 'Birdeye',
  archive: 'the stored daily archive',
}
export const sourceLabel = (source: unknown) => SOURCE_LABELS[String(source)] || String(source || 'an unnamed source')

/** Readable name of an app interval, for the coverage sentence. */
export const INTERVAL_LABELS: Record<string, string> = {
  '1M': '1 minute', '5M': '5 minute', '15M': '15 minute', '30M': '30 minute',
  '1H': '1 hour', '4H': '4 hour', '1D': '1 day', '1W': '1 week',
}
export const intervalLabel = (interval: unknown) => INTERVAL_LABELS[String(interval)] || String(interval || 'unknown')

export const isCandleRange = (range: unknown) => Object.hasOwn(CANDLE_RANGE_MS, String(range))
export const isCandleInterval = (interval: unknown) => interval === 'auto' || Object.hasOwn(CHART_INTERVALS, String(interval))
export const isSubHour = (interval: unknown) => SUB_HOUR_INTERVALS.includes(String(interval))

/** The width `auto` means for a window. Short windows get minute candles, a week
 * gets hours, a month gets four hours, a year or two gets days, longer gets
 * weeks. Anything wider than two years at daily spacing is more bars than any
 * single provider request returns, so `auto` steps up rather than silently
 * truncating the oldest half of the chart. */
export function autoInterval(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '1H'
  if (durationMs <= HOUR) return '1M'
  if (durationMs <= 12 * HOUR) return '5M'
  if (durationMs <= DAY) return '15M'
  if (durationMs <= 7 * DAY) return '1H'
  if (durationMs <= 31 * DAY) return '4H'
  if (durationMs <= 2 * 365 * DAY) return '1D'
  return '1W'
}

export interface CandlePlan {
  range: string
  /** What the caller asked for ('auto' resolved to a width). */
  requested: string
  /** What the chosen source will actually sample. Equal to `requested` unless
   * the source cannot sample that width. */
  selected: string
  /** True when `selected` is not `requested`: the reader is told. */
  substituted: boolean
  step: number
  from: number
  to: number
  /** Completed periods the window needs, before any request ceiling. */
  wanted: number
  /** Extra completed periods GRANTED before the window, so a study that needs a
   * warm-up (a 50-period average needs 50 closes) has a value at the first
   * visible bar instead of an empty first fifty. It is what was asked for after
   * the source's own ceiling has been honoured: the window is served first and
   * the warm-up takes what is left, so asking for one can never shorten the
   * chart the reader actually sees. Zero when nothing asked for one. */
  lookback: number
  /** Periods one request may return. */
  limit: number
  /** True when the window needs more periods than one request can carry. */
  capped: boolean
  /** Oldest period one capped request can reach back to. */
  reachesFrom: number
}

/** The coarsest-first list of widths a source can sample, so a request for a
 * width it cannot sample is answered with the FINEST width it can — never with a
 * coarser one relabelled, and never with silence. */
export function nearestInterval(requested: string, supported: string[]): string | null {
  if (!supported.length) return null
  if (supported.includes(requested)) return requested
  const wanted = CHART_INTERVALS[requested]
  if (!wanted) return null
  const ordered = supported.filter((key) => CHART_INTERVALS[key]).sort((a, b) => CHART_INTERVALS[a] - CHART_INTERVALS[b])
  // The finest width at or above the request; failing that, the coarsest below.
  return ordered.find((key) => CHART_INTERVALS[key] >= wanted) ?? ordered.at(-1) ?? null
}

/**
 * One bounded (range, interval) plan for one source.
 *
 * `supported` is the source's own width vocabulary and `limit` its own per
 * request candle ceiling. The plan never asks for more than `limit` periods; a
 * window that needs more is `capped`, and `reachesFrom` says how far back the
 * newest `limit` periods actually go so the coverage sentence can state it.
 *
 * `lookback` is extra COMPLETED periods before the window, the warm-up a study
 * needs so it has a value at the first visible bar. `wanted` stays the periods
 * of the window itself, because every coverage sentence is about the window the
 * reader asked for and not about the bars fetched to warm an indicator up.
 */
export function candlePlan(range: string, interval: string, source: { limit: number; intervals: string[] }, now = Date.now(), lookback = 0): CandlePlan {
  const duration = CANDLE_RANGE_MS[range]
  if (!duration || !Number.isFinite(now)) throw new Error('invalid_chart_parameters')
  if (interval !== 'auto' && !CHART_INTERVALS[interval]) throw new Error('invalid_chart_parameters')
  const requested = interval === 'auto' ? autoInterval(duration) : interval
  const selected = nearestInterval(requested, source.intervals)
  if (!selected) throw new Error('invalid_chart_parameters')
  const step = CHART_INTERVALS[selected]
  // `to` is the open of the period still in progress; every kept candle closed.
  const to = Math.floor(now / step) * step
  const wanted = Math.max(1, Math.ceil(duration / step))
  const ceiling = Math.max(1, Math.trunc(source.limit))
  // The WINDOW IS SERVED FIRST. Warm-up periods take only what the ceiling has
  // left after the window and its one in-progress period, so a study asking for
  // a long warm-up can never push the oldest visible bars out of the request.
  const asked = Number.isFinite(Number(lookback)) ? Math.trunc(Number(lookback)) : 0
  const granted = Math.min(Math.max(0, asked), Math.max(0, ceiling - wanted - 1))
  // One extra period, because the newest row a provider returns is usually the
  // period still in progress and is dropped locally.
  const limit = Math.min(ceiling, wanted + granted + 1)
  // `capped` is still about the WINDOW: a chart is short when the range itself
  // does not fit, never because a warm-up request was trimmed.
  const capped = wanted + 1 > ceiling
  return {
    range, requested, selected, substituted: selected !== requested, step,
    from: to - (wanted + granted) * step, to, wanted, lookback: granted, limit, capped,
    reachesFrom: to - Math.max(0, limit - 1) * step,
  }
}

/** "about 14 days", "about 3 hours" — the span a capped answer actually covers. */
export function spanWords(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'no completed period'
  const [unit, n] = ms >= 365 * DAY ? ['year', Math.round(ms / (365 * DAY))] as const
    : ms >= DAY ? ['day', Math.round(ms / DAY)] as const
    : ['hour', Math.max(1, Math.round(ms / HOUR))] as const
  return `${n} ${unit}${n === 1 ? '' : 's'}`
}

export interface CoverageInput {
  plan: CandlePlan
  /** The source that answered, e.g. 'binance' or 'coinmarketcap'. */
  source: string
  /** Oldest candle actually returned, or null when nothing came back. */
  oldest: number | null
  count: number
  /** How many of the candles came out of the stored archive. */
  archived?: number
  /** Newest stored archive candle, when the archive contributed. */
  archiveTo?: number | null
  reason?: string | null
  extra?: (string | null | undefined)[]
}

/** The coverage sentence. It always NAMES THE SOURCE AND THE INTERVAL, says when
 * the served interval is not the requested one, and says how far back a capped
 * answer reaches instead of presenting a short series as a complete one. */
export function candleCoverage(input: CoverageInput): string {
  const { plan, source, oldest, count } = input
  const archived = Number(input.archived) || 0
  // The shortfall sentence is about the WINDOW the reader asked for. Warm-up
  // periods sit before it, so a series that covers the whole range but not the
  // warm-up is a complete range and is not announced as a short one.
  const windowFrom = plan.to - plan.wanted * plan.step
  const reachesStart = oldest != null && oldest <= windowFrom + plan.step
  const parts: (string | null | undefined)[] = [
    `${intervalLabel(plan.selected)} candles for ${plan.range} from ${sourceLabel(source)}.`,
    plan.substituted
      ? `${intervalLabel(plan.requested)} candles are not available from ${sourceLabel(source)}; these are ${intervalLabel(plan.selected)} candles, not relabelled ${intervalLabel(plan.requested)} ones.`
      : null,
    archived > 0
      ? `${archived} of ${count} candles come from the stored daily archive${input.archiveTo != null ? `, which ends ${new Date(input.archiveTo).toISOString().slice(0, 10)}` : ''}; the rest are the provider's recent window.`
      : null,
    plan.capped
      ? `${plan.range} at ${intervalLabel(plan.selected)} needs ${plan.wanted} periods, more than the ${plan.limit}-candle ceiling of one request.`
      : null,
    count && !reachesStart ? `They reach back about ${spanWords(plan.to - (oldest as number))}, not the full ${plan.range} range.` : null,
    ...(input.extra || []),
    input.reason ? `Some candles are unavailable (${input.reason}).` : null,
    count ? null : 'No completed candles were returned for this window.',
  ]
  return parts.filter(Boolean).join(' ')
}

// ─── Source order ─────────────────────────────────────────────────────────────

export interface LadderContext {
  /** The asset has a confidence-gated exchange identity. Without it a same-ticker
   * market is NOT this asset's history and the exchange rung is not offered. */
  cexVerified: boolean
  /** The asset has a CoinMarketCap listing id. */
  cmcId: string | null
  /** The asset names a contract on a verified CMC DEX chain. */
  klineIdentity: boolean
  /** The asset is a CoinGecko row with a provider id. */
  coingeckoId: boolean
  /** The requested interval, already resolved from 'auto'. */
  interval: string
}

/**
 * The order the sources are tried for ONE asset.
 *
 * Free public exchange data first when the asset has a VERIFIED listing, then
 * CoinMarketCap OHLCV through the governed transport, then the DEX k-line for a
 * contract, then the CoinGecko window.
 *
 * A contract identity keeps its own rule: without a verified exchange listing
 * its only genuine history is its own on-chain trading, so the k-line comes
 * before anything that would substitute a same-ticker market.
 *
 * CoinMarketCap OHLCV has no period below an hour, so it is not offered for a
 * sub-hour request — it would answer hourly bars under a minute label.
 */
export function candleSourceOrder(ctx: LadderContext): CandleSourceId[] {
  const order: CandleSourceId[] = []
  if (ctx.cexVerified) order.push('exchange')
  if (ctx.cmcId && !isSubHour(ctx.interval)) order.push('cmc_ohlcv')
  if (ctx.klineIdentity) order.push('kline')
  if (ctx.coingeckoId) order.push('coingecko')
  return order
}
