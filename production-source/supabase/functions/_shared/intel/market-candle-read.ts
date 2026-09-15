// Investor Intel — one candle read for one asset: pick the source, bound the
// (range, interval) pair, merge the stored archive under the provider's recent
// window, and say all of it in the coverage sentence.
//
// THE LADDER, in order, for every identity:
//
//   1. exchange   the free public venue registry, when the asset has a VERIFIED
//                 exchange identity. Costs nothing and samples to one minute.
//   2. cmc_ohlcv  CoinMarketCap OHLCV through the governed transport, when the
//                 asset has a CMC listing id. Skipped for a sub-hour request:
//                 the endpoint has no period below an hour and would answer
//                 hourly bars under a minute label.
//   3. kline      the CoinMarketCap DEX k-line aggregate, for a contract on a
//                 verified CMC DEX chain. A contract WITHOUT a verified exchange
//                 identity reaches this rung first, because a same-ticker market
//                 is not that contract's history.
//   4. coingecko  the CoinGecko OHLC window, for a CoinGecko-sourced row.
//
// THE ARCHIVE sits UNDER all of them, not beside them. For the long ranges
// (1Y, 2Y, 5Y, ALL) at an archived width the stored daily candles are read for
// the whole window and merged with whatever the live rung returned; the provider
// row wins on any period both hold. That is what makes "Bitcoin since 2013" a
// chart rather than "Bitcoin since last September".
//
// Every source is injected, so this module tests with no network and no database.

import { autoInterval, candleCoverage, candlePlan, candleSourceOrder, CANDLE_RANGE_MS, intervalLabel, isArchiveRange, sourceLabel, VENUE_CANDLES, KLINE_INTERVAL_KEYS, CMC_INTERVAL_KEYS } from './candle-ladder.ts'
import { archiveCanAnswer, archiveSeries, mergeCandles } from './candle-archive.ts'
import { normalizeBars, type Bar } from './chart-analysis.ts'

/** The widest width vocabulary any venue offers, used to resolve `auto` before a
 * source has been chosen. Binance carries all eight. */
const ALL_WIDTHS = VENUE_CANDLES.binance.intervals

/** What a rung hands back. `candles` is deliberately loose: the four rungs are
 * older modules with their own bar shapes, and every one of them is put through
 * `normalizeBars` here rather than trusted to match a type. */
export interface SourceResult {
  // deno-lint-ignore no-explicit-any
  candles: any[]
  source?: string
  bestProvider?: string | null
  bestPair?: string | null
  barIntervalMs?: number | null
  timestampMeaning?: string
  volumeUnit?: string
  currency?: string | null
  coverage?: string
  sourceState?: string
  sourceReason?: string | null
  // deno-lint-ignore no-explicit-any
  provenance?: any[]
  [key: string]: unknown
}

// deno-lint-ignore no-explicit-any
type RungAnswer = { candles?: any[]; [key: string]: any }
/** Every rung takes the same trailing `lookback`: extra completed periods before
 * the window, so one warm-up request answers the whole chart whichever rung ends
 * up serving it. The CoinGecko rung is bound to its timeframe by its caller and
 * has never read the range or width it was handed, so it takes the lookback on
 * its own. */
export interface CandleLadderDeps {
  exchange?: (range: string, interval: string, lookback: number) => Promise<RungAnswer>
  cmc?: (id: string, range: string, interval: string, lookback: number) => Promise<RungAnswer>
  kline?: (range: string, interval: string, lookback: number) => Promise<RungAnswer>
  coingecko?: (lookback: number) => Promise<RungAnswer>
  archive?: (assetKey: string, interval: string, from: number, to: number) => Promise<{ bars: Bar[]; reason: string | null; truncated: boolean; incomplete?: number }>
}

export interface LadderIdentity {
  assetKey: string | null
  symbol: string | null
  cexVerified: boolean
  cmcId: string | null
  klineIdentity: boolean
  coingeckoId: boolean
}

/** Widths a rung can genuinely sample, for the substitution note. */
const SOURCE_WIDTHS: Record<string, string[]> = {
  exchange: ALL_WIDTHS,
  cmc_ohlcv: CMC_INTERVAL_KEYS,
  kline: KLINE_INTERVAL_KEYS,
  // The CoinGecko OHLC window has its own provider spacing per day count; it is
  // never relabelled, so it is planned at the width it was asked for.
  coingecko: ALL_WIDTHS,
}

/** The interval a request resolves to before a source is chosen. */
export function resolveInterval(range: string, interval: string): string {
  const duration = CANDLE_RANGE_MS[range]
  if (!duration) throw new Error('invalid_chart_parameters')
  return interval === 'auto' ? autoInterval(duration) : interval
}

/**
 * One candle answer for one asset.
 *
 * Never throws for a provider failure: a rung that cannot answer records its
 * reason and the walk continues. When no rung answers and the archive holds
 * nothing either, the result carries an empty series, the reasons of every rung
 * that was tried, and a coverage sentence that says which sources were asked.
 *
 * `lookback` is extra completed periods BEFORE the window, so a study drawn on
 * the chart (a 50-period average, say) has a value at the FIRST visible bar
 * instead of an empty first fifty. It extends every rung's own plan and the
 * archive window by the same amount; the window itself is always served first,
 * so a warm-up request can never shorten the range the reader asked for.
 */
export async function loadMarketCandles(identity: LadderIdentity, range = '7D', interval = 'auto',
  now = Date.now(), deps: CandleLadderDeps = {}, lookback = 0): Promise<SourceResult> {
  if (!CANDLE_RANGE_MS[range]) throw new Error('invalid_chart_parameters')
  const requested = resolveInterval(range, interval)
  const order = candleSourceOrder({
    cexVerified: identity.cexVerified, cmcId: identity.cmcId,
    klineIdentity: identity.klineIdentity, coingeckoId: identity.coingeckoId, interval: requested,
  })

  const tried: string[] = []
  const reasons: string[] = []
  let answer: SourceResult | null = null
  // The last rung that answered at all, even with no candles. Its descriptive
  // fields (volume unit, currency, provenance) still describe what was asked
  // for, so an empty answer keeps the response SHAPE a full one has instead of
  // dropping fields the page reads.
  let lastResult: SourceResult | null = null
  let answeredBy = ''
  for (const rung of order) {
    const call = rung === 'exchange' ? deps.exchange
      : rung === 'cmc_ohlcv' ? (identity.cmcId ? (r: string, i: string, lb: number) => deps.cmc!(identity.cmcId as string, r, i, lb) : undefined)
      : rung === 'kline' ? deps.kline
      : deps.coingecko ? (_r: string, _i: string, lb: number) => deps.coingecko!(lb) : undefined
    if (!call) continue
    tried.push(rung)
    // Each rung is planned against its OWN width vocabulary, so a rung that
    // cannot sample the requested width is asked for the nearest width it can
    // and the substitution is reported rather than hidden.
    let answered: RungAnswer | null = null
    try { answered = await call(range, requested, lookback) } catch { answered = null }
    if (!answered) { reasons.push(`${rung}:provider_unavailable`); continue }
    const result: SourceResult = { ...answered, candles: answered.candles ?? [] }
    lastResult = result
    if (result.sourceReason) reasons.push(`${rung}:${result.sourceReason}`)
    if (result.candles?.length) { answer = result; answeredBy = rung; break }
    if (!result.sourceReason) reasons.push(`${rung}:no_completed_candles`)
  }

  // The served width is whatever the answering rung actually sampled; with no
  // answer it is the width the request resolved to.
  const servedWidths = SOURCE_WIDTHS[answeredBy] || ALL_WIDTHS
  // The ladder plan is unbounded on purpose: the CAP belongs to the rung that
  // answered and is already stated in its own coverage sentence, which is
  // appended below. Repeating it here would report one ceiling twice.
  const plan = candlePlan(range, requested, { limit: Number.MAX_SAFE_INTEGER, intervals: servedWidths }, now, lookback)
  const served = plan.selected

  // ── The archive, under the live window ──
  let archived = 0, archiveTo: number | null = null, archiveReason: string | null = null, archiveTruncated = false
  // Every rung's bars go through the same normaliser, so one shape reaches the
  // merge, the coverage sentence and the response.
  let candles: Bar[] = answer?.candles?.length ? normalizeBars(answer.candles).bars : []
  const archiveWanted = isArchiveRange(range) && archiveCanAnswer(served) && !!identity.assetKey && !!deps.archive
  if (archiveWanted) {
    // The archive is read for the warm-up too, otherwise a study on a long range
    // would warm up on provider bars for a chart the archive is drawing.
    // `plan.step` is the served width and `plan.lookback` the periods granted.
    const window = { from: now - CANDLE_RANGE_MS[range] - plan.lookback * plan.step, to: now }
    const read = await deps.archive!(identity.assetKey as string, served, window.from, window.to).catch(() => null)
    if (!read) archiveReason = 'archive_read_failed'
    else {
      archiveReason = read.reason
      archiveTruncated = read.truncated
      if (read.bars.length) {
        const merged = mergeCandles(read.bars, candles)
        candles = merged.candles
        archived = merged.archived
        archiveTo = merged.archiveTo
      }
    }
  }

  const source = answeredBy
    ? String(answer?.source || answer?.bestProvider || answeredBy)
    : archived ? 'archive' : String(lastResult?.source || 'none')
  const oldest = candles[0]?.t ?? null
  const coverage = candleCoverage({
    plan, source, oldest, count: candles.length, archived, archiveTo,
    reason: reasons.length ? [...new Set(reasons)].join(', ') : null,
    extra: [
      answer?.coverage ? String(answer.coverage) : null,
      archived > 0 ? 'Archived volume is USD for every period: the archive stores the CoinMarketCap USD figure and the venue\'s quote turnover, never a base-asset amount, so one unit runs through the whole series.' : null,
      archiveTruncated ? 'The stored archive read hit its row ceiling; the oldest stored candles are not in this window.' : null,
      archiveReason ? `The stored archive could not be read (${archiveReason}).` : null,
      !order.length ? 'This asset has no verified exchange listing, no CoinMarketCap listing and no verified contract, so no candle source could be asked.' : null,
      tried.length && !answeredBy ? `Sources tried: ${tried.map(sourceLabel).join(', ')}.` : null,
    ],
  })

  return {
    ...(answer || lastResult || {}),
    candles,
    source,
    bestProvider: candles.length ? (answer?.bestProvider ?? (archived ? 'archive' : source)) : null,
    bestPair: answer?.bestPair ?? null,
    // Archived periods are USD. When they are in the series the whole series is
    // reported in USD rather than under the live rung's own venue label.
    ...(archived > 0 ? { volumeUnit: 'USD' } : {}),
    barIntervalMs: plan.step,
    timestampMeaning: 'open',
    coverage,
    sourceState: candles.length ? (answer?.sourceState === 'stale' ? 'stale' : 'fresh') : 'unavailable',
    sourceReason: candles.length ? (answer?.sourceReason ?? null) : (reasons[0]?.split(':').slice(1).join(':') || 'no_candle_source'),
    // ONE added key, so the detail response shape gains one field rather than
    // six. Everything the page needs to say what it is showing lives in it.
    ladder: {
      range, source, interval: served, requestedInterval: requested, substituted: served !== requested,
      archivedCandles: archived, archiveEndsAt: archiveTo == null ? null : new Date(archiveTo).toISOString(),
      sourcesTried: tried, sourcesUnavailable: [...new Set(reasons)],
    },
  }
}

/** The one-line summary a caller can log or show beside the chart. */
// deno-lint-ignore no-explicit-any
export function candleSummary(result: SourceResult): string {
  const ladder = (result?.ladder || {}) as Record<string, any>
  return `${intervalLabel(String(ladder.interval || ''))} candles from ${sourceLabel(result.source)}; ${result.candles?.length ?? 0} periods, ${Number(ladder.archivedCandles) || 0} from the archive.`
}
