// Investor Intel — "unusual for THIS asset" (pure, no reads, no model calls).
//
// A fixed threshold is not a finding. An 8% day is an ordinary Tuesday for a
// small alt and a major event for Bitcoin, so a movers list built on one number
// for every asset says more about the number than about the market. This module
// scores a day's move against the SAME asset's own trailing distribution, so the
// question it answers is "is this unusual FOR THIS ASSET", not "is this bigger
// than a constant someone picked".
//
// Four readings, all deterministic, all replayable from the same inputs:
//
//   1. ROBUST Z. |today's return| against the median and the median absolute
//      deviation of the trailing window's |returns|. Median and MAD rather than
//      mean and standard deviation because a crypto return series contains its
//      own outliers: one +40% day inflates a standard deviation enough to hide
//      the next one. MAD is scaled by 1.4826 so the figure reads on the same
//      scale as a normal-distribution sigma, and the scaling is NAMED rather
//      than folded in silently.
//   2. EMPIRICAL PERCENTILE. How many of the trailing days had a smaller absolute
//      move. This needs no distributional assumption at all, and it is the figure
//      the surface leads with, because "larger than 90 of the last 92 days" is a
//      sentence a reader can check.
//   3. LOG VOLUME. The same median/MAD and percentile treatment of ln(volume).
//      Volume is roughly multiplicative, so a log scale is the one on which "the
//      usual amount" is a stable centre; a zero or unreported volume is NOT a
//      log, and is left out of the window with its count reported.
//   4. MARKET-RELATIVE RESIDUAL. today's return minus beta times the market's
//      return, with beta from an ordinary least squares fit over the SAME
//      trailing window. This separates "this asset moved" from "everything moved
//      and this asset came along". Beta is always shown with its window and its
//      sample count, because a beta without a sample count is a decoration.
//
// HONESTY RULES this module enforces rather than leaves to callers:
//   * SHORT HISTORY IS NOT SCORED. Below the minimum sample the result carries
//     `reason: 'insufficient_history'` with the sample count and the requirement,
//     and every figure is null. A partial window is never quietly scored as if it
//     were whole.
//   * A WINDOW REPORTS ITS ACTUAL SAMPLE. A window labelled 90 days that only
//     reaches back 61 says `n: 61`, so the reader compares against what exists
//     rather than against the label.
//   * ZERO SPREAD IS NOT INFINITE UNUSUALNESS. A MAD of zero (a window in which
//     more than half the days moved by exactly the same amount) cannot scale a
//     deviation, so the robust z is null with `mad_zero` rather than Infinity.
//   * THE MARKET REFERENCE HAS NO BETA AGAINST ITSELF. Bitcoin's own row reports
//     `market_reference`, never a beta of 1 dressed up as a measurement.
//   * A STABLECOIN'S DISTRIBUTION IS NOT A PRICE DISTRIBUTION. A peg's trailing
//     moves are peg noise, so a 40-basis-point wobble scores as a once-in-a-
//     lifetime event. Pegs and wrapped claims on another asset are excluded by
//     tag and by symbol, with the reason recorded, never silently dropped.
//
// Everything here is a pure function over numbers the caller already holds. The
// reads that feed it live in `capture-unusual.ts`; the surface read lives in
// `capture-unusual-read.ts`.

/** MAD to a normal-distribution sigma. 1 / Φ⁻¹(3/4) = 1.4826…: for a normal
 * sample the scaled MAD converges on the standard deviation, so a robust z of 3
 * means roughly what a conventional z of 3 means, without a single outlier being
 * able to move the scale. */
export const MAD_TO_SIGMA = 1.4826

/** The two trailing windows every scored asset reports. 30 days is recent
 * behaviour; 90 days is a regime. A move unusual on both is a different claim
 * from one unusual only against the last month. */
export const UNUSUAL_WINDOW_DAYS = [30, 90] as const
export type UnusualWindowDays = typeof UNUSUAL_WINDOW_DAYS[number]

/** Trailing daily returns a window needs before anything is scored. Below this
 * the percentile has no resolution worth printing (each day would be worth more
 * than three percentage points) and the MAD is dominated by which days happen to
 * be in the sample. */
export const MIN_SAMPLE_DAYS = 30

/** Catalogue 24-hour volume an asset needs before its move is ranked. Without a
 * floor the top of the list fills with assets whose "unusual" day is one trade
 * against an empty book. The figure is the asset's OWN reported turnover, not a
 * market-wide one, so it is a statement about whether this price is being made
 * by anyone. */
export const DEFAULT_LIQUIDITY_FLOOR_USD = 1_000_000

/** CoinMarketCap tags that mean "this price is pegged, so its trailing
 * distribution is peg noise". Measured against the production catalogue on
 * 2026-09-20: `stablecoin` (51 assets), `asset-backed-stablecoin` (41),
 * `usd-stablecoin` (34), `fiat-stablecoin` (15), `algorithmic-stablecoin` (4),
 * `eur-stablecoin` (4).
 *
 * `stablecoin-protocol` (6 assets) is DELIBERATELY ABSENT. It marks the
 * governance or protocol token of a stablecoin issuer, which is a free-floating
 * price with a real distribution; excluding it would have removed exactly the
 * kind of asset this surface exists to rank. */
export const EXCLUDED_PEG_TAGS: readonly string[] = [
  'stablecoin', 'asset-backed-stablecoin', 'usd-stablecoin', 'fiat-stablecoin',
  'algorithmic-stablecoin', 'eur-stablecoin', 'gbp-stablecoin', 'jpy-stablecoin',
]

/** Tags that mean "this is a claim on another asset, so its distribution is that
 * asset's distribution". The production catalogue carried NO wrapped tag when
 * this was written (probed 2026-09-20: no tag matching `wrapped` exists on any
 * catalogue row), so the tag half of this gate is forward cover and the symbol
 * list below is the half that currently does the work. Recording both keeps the
 * reason specific when either one fires. */
export const EXCLUDED_WRAPPER_TAGS: readonly string[] = ['wrapped-tokens', 'wrapped-bitcoin']

/** Wrapped and liquid-staking receipt symbols. A short, explicit list of
 * symbols that are a receipt for another asset rather than an asset with its own
 * price discovery: their trailing distribution is the underlying's, so scoring
 * them would double-count the underlying's day.
 *
 * It is a LIST and not a pattern because a pattern over symbols is how MATIC-era
 * heuristics start excluding real assets: `^W` would have removed Worldcoin,
 * Wormhole, Walrus and WEMIX, all of which are ordinary free-floating tokens. */
export const EXCLUDED_WRAPPER_SYMBOLS: readonly string[] = [
  'WBTC', 'WETH', 'WBNB', 'WSOL', 'WAVAX', 'WMATIC', 'WPOL', 'WTRX', 'WHBAR',
  'STETH', 'WSTETH', 'WEETH', 'RETH', 'CBETH', 'CBBTC', 'RSETH', 'EZETH',
  'METH', 'SWETH', 'SFRXETH', 'FRXETH', 'JITOSOL', 'MSOL', 'BSOL', 'LBTC', 'TBTC',
]

/** Why an asset carries no score. Each value is a sentence the surface can say
 * in words; none of them is "no data". */
export type UnusualRefusal =
  | 'insufficient_history'
  | 'peg_excluded'
  | 'wrapper_excluded'
  | 'below_liquidity_floor'
  | 'liquidity_unknown'
  | 'no_subject_return'

/** Why one figure inside a scored window is absent. */
export type FigureRefusal = 'mad_zero' | 'short_window' | 'no_market_overlap' | 'market_reference' | 'market_flat' | 'volume_not_reported'

/** One stored daily candle, reduced to what the scoring needs. `day` is the UTC
 * date the period opened on ('2026-09-19'); a zero volume is a completed day in
 * which nothing traded and a null volume is a day whose volume was never
 * reported, and the two are never conflated. */
export interface DailyClose {
  day: string
  close: number
  volume: number | null
}

/** One close-to-close daily return, dated by the day it CLOSED on. */
export interface DailyReturn {
  day: string
  ret: number
  volume: number | null
}

export interface WindowScore {
  /** The window's label in days. */
  days: number
  /** Trailing daily returns actually inside it. Compare against `days`. */
  n: number
  /** Median absolute daily return, in percent: the asset's typical day. */
  medianAbsPct: number | null
  /** Median absolute deviation of |return|, in percent. */
  madPct: number | null
  /** (|today| − median) / (1.4826 × MAD). */
  robustZ: number | null
  robustZReason: FigureRefusal | null
  /** Share of the trailing window with a smaller-or-equal absolute move, 0..100. */
  percentile: number | null
  /** How many of the `n` trailing days today's move was at least as large as.
   * Printed as "larger than {exceeded} of the last {n} days". */
  exceeded: number | null
  /** Trailing days with a usable (strictly positive) reported volume. */
  volumeN: number
  /** Robust z of ln(today's volume) against the window's ln(volume). */
  volumeRobustZ: number | null
  volumeRobustZReason: FigureRefusal | null
  volumePercentile: number | null
  volumeExceeded: number | null
  /** OLS slope of this asset's daily returns on the market's, over this window. */
  beta: number | null
  betaN: number
  betaReason: FigureRefusal | null
  /** The market's own return on the scored day, in percent. */
  marketMovePct: number | null
  /** today − beta × market, in percent: the part of the day that was this asset's. */
  residualPct: number | null
  /** The window's own distribution of absolute daily moves, in percent, and the
   * bin the scored day falls in. Published by the scorer so the drawing and the
   * figures beside it can never disagree about the edges. */
  distribution: DistributionBin[]
  subjectBin: number | null
}

export interface UnusualScore {
  assetKey: string
  scored: boolean
  reason: UnusualRefusal | null
  /** Trailing daily returns available, whatever the outcome. */
  sampleDays: number
  requiredDays: number
  /** The UTC day the scored move closed on. */
  subjectDay: string | null
  /** Signed close-to-close return of that day, in percent. */
  movePct: number | null
  volume: number | null
  /** True for the asset the residual is measured against; it has no beta on itself. */
  isMarketReference: boolean
  windows: WindowScore[]
}

export interface ScoreInput {
  assetKey: string
  /** Daily candles, OLDEST FIRST, one per UTC day. Gaps are allowed: a missing
   * day produces no return rather than a two-day return dressed as one. */
  series: readonly DailyClose[]
  /** The market reference's own daily returns, for beta and the residual. */
  marketReturns?: readonly DailyReturn[] | null
  /** The market reference's key, so the reference recognises itself. */
  marketKey?: string | null
  /** Catalogue 24-hour turnover, for the liquidity gate and the ranking. */
  liquidityUsd?: number | null
  /** Catalogue tags (CoinMarketCap `categories`). */
  tags?: readonly string[] | null
  symbol?: string | null
  liquidityFloorUsd?: number
  minSampleDays?: number
  /** Windows to report. Defaults to UNUSUAL_WINDOW_DAYS. */
  windowDays?: readonly number[]
}

const finiteNumber = (value: unknown): number | null => {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Median of a sample. Even counts average the two middle values, which is the
 * ordinary definition and keeps the median of [1,2,3,4] at 2.5 rather than
 * picking a side. The input is copied before sorting: a helper that reorders its
 * caller's array is a bug waiting for a second caller. */
export function median(values: readonly number[]): number | null {
  const sample = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b)
  if (!sample.length) return null
  const middle = sample.length >> 1
  return sample.length % 2 ? sample[middle] : (sample[middle - 1] + sample[middle]) / 2
}

/** Median absolute deviation about a centre (the sample's own median unless one
 * is given). This is the raw MAD, NOT scaled: the scaling belongs to whoever
 * reads it as a sigma, and `robustZ` does it in one named place. */
export function medianAbsoluteDeviation(values: readonly number[], centre?: number | null): number | null {
  const sample = values.filter((v) => Number.isFinite(v))
  if (!sample.length) return null
  const mid = centre == null ? median(sample) : centre
  if (mid == null) return null
  return median(sample.map((v) => Math.abs(v - mid)))
}

/** (value − centre) / (1.4826 × MAD), or null with the reason it cannot be had.
 * A MAD of zero means more than half the window sat at one value, which gives
 * nothing to scale by; the answer is "not measurable on this window", never
 * Infinity and never a silent 0. */
export function robustZ(value: number | null, centre: number | null, mad: number | null): { z: number | null; reason: FigureRefusal | null } {
  if (value == null || centre == null || mad == null || !Number.isFinite(value) || !Number.isFinite(centre)) return { z: null, reason: 'short_window' }
  if (!(mad > 0)) return { z: null, reason: 'mad_zero' }
  return { z: (value - centre) / (MAD_TO_SIGMA * mad), reason: null }
}

/** Empirical percentile of `value` in `sample`, plus the count behind it.
 *
 * The definition is the inclusive one: how many sample points are LESS THAN OR
 * EQUAL TO the value, over the sample size. Two consequences are deliberate and
 * are what the surface says in words. A value at or above every trailing day
 * reads 100 ("larger than all 92 of the last 92 days"), which is true and is the
 * whole point of the figure. A value at or below every trailing day reads as its
 * share of ties rather than 0, because a day that tied the quietest day in the
 * window did not beat zero of them. */
export function percentileRank(value: number | null, sample: readonly number[]): { percentile: number | null; exceeded: number | null; n: number } {
  const usable = sample.filter((v) => Number.isFinite(v))
  if (value == null || !Number.isFinite(value) || !usable.length) return { percentile: null, exceeded: null, n: usable.length }
  const exceeded = usable.reduce((count, v) => (v <= value ? count + 1 : count), 0)
  return { percentile: (exceeded / usable.length) * 100, exceeded, n: usable.length }
}

/** Close-to-close simple returns, dated by the closing day.
 *
 * SIMPLE and not logarithmic, because the figure is shown to a reader beside a
 * price: "+23.0%" must mean the price is 1.23 times what it was. The log return
 * of the same day would read +20.7% and would not reconcile with anything else
 * on the page. The volume carried along is the CLOSING day's volume, so a return
 * and the turnover that produced it stay on one row.
 *
 * CONSECUTIVE DAYS ONLY. A gap in the archive would otherwise turn a three-day
 * move into one "daily" return, which is the exact dishonesty this module is
 * meant to remove from movers lists. A non-adjacent pair produces no return. */
export function dailyReturns(series: readonly DailyClose[]): DailyReturn[] {
  const rows = series
    .map((row) => ({ day: String(row?.day ?? ''), close: finiteNumber(row?.close), volume: finiteNumber(row?.volume) }))
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.day) && row.close != null && (row.close as number) > 0)
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
  const out: DailyReturn[] = []
  for (let i = 1; i < rows.length; i++) {
    const previous = rows[i - 1], current = rows[i]
    // One calendar day apart, measured on the dates themselves so a daylight
    // saving or leap-second argument never enters a UTC-dated series.
    if (Date.parse(`${current.day}T00:00:00Z`) - Date.parse(`${previous.day}T00:00:00Z`) !== 86_400_000) continue
    out.push({ day: current.day, ret: (current.close as number) / (previous.close as number) - 1, volume: current.volume })
  }
  return out
}

/** Ordinary least squares slope of `asset` on `market` over paired days.
 *
 * Plain sums rather than a library: the formula is three accumulations and one
 * division, and writing it out means the sample count and the refusal reason are
 * visible at the point they are decided. A market series with no variance over
 * the window has no slope to fit (`market_flat`), and fewer than two paired days
 * is not a fit at all. */
export function olsBeta(pairs: readonly { asset: number; market: number }[]): { beta: number | null; n: number; reason: FigureRefusal | null } {
  const usable = pairs.filter((p) => Number.isFinite(p?.asset) && Number.isFinite(p?.market))
  const n = usable.length
  if (n < 2) return { beta: null, n, reason: 'no_market_overlap' }
  let sumA = 0, sumM = 0, sumAM = 0, sumMM = 0
  for (const pair of usable) { sumA += pair.asset; sumM += pair.market; sumAM += pair.asset * pair.market; sumMM += pair.market * pair.market }
  const denominator = n * sumMM - sumM * sumM
  if (!(Math.abs(denominator) > 0)) return { beta: null, n, reason: 'market_flat' }
  return { beta: (n * sumAM - sumA * sumM) / denominator, n, reason: null }
}

/** One bar of an asset's own distribution of absolute daily moves, in percent. */
export interface DistributionBin { from: number; to: number; count: number }

/** Equal-width bins of the trailing absolute moves, plus the bin the scored day
 * falls in.
 *
 * THE RANGE COVERS THE SCORED DAY, deliberately. Binning only the trailing
 * window would leave an extreme day with no bar to stand in, which is the one
 * day the drawing exists to place. Where today is far outside the usual range
 * the picture is a tall bar at the left and a lone bar at the right, and that IS
 * the finding.
 *
 * The bins are computed HERE, not in the chart: the chart draws bins a caller
 * publishes, and re-deriving edges in the renderer is how two views of one
 * figure start to disagree. A degenerate window (every day identical, and today
 * the same) yields one bin naming that single value rather than a fabricated
 * range. */
export function distributionBins(values: readonly number[], subject: number | null, binCount = 10): { bins: DistributionBin[]; subjectBin: number | null } {
  const sample = values.filter((v) => Number.isFinite(v)).map((v) => Math.abs(v))
  if (!sample.length) return { bins: [], subjectBin: null }
  const today = subject == null || !Number.isFinite(subject) ? null : Math.abs(subject)
  const top = Math.max(...sample, today ?? 0)
  const count = Math.max(2, Math.trunc(binCount))
  if (!(top > 0)) return { bins: [{ from: 0, to: 0, count: sample.length }], subjectBin: today == null ? null : 0 }
  const width = top / count
  const bins: DistributionBin[] = Array.from({ length: count }, (_, i) => ({ from: i * width, to: (i + 1) * width, count: 0 }))
  // The top edge is inclusive so the largest trailing day lands in the last bin
  // rather than in a bin that does not exist.
  const slot = (value: number) => Math.min(count - 1, Math.max(0, Math.floor(value / width)))
  for (const value of sample) bins[slot(value)].count += 1
  return { bins, subjectBin: today == null ? null : slot(today) }
}

/** The tag/symbol gate, as its own function so the surface and the tests read
 * the same rule. Returns the refusal, or null when the asset is admissible. */
export function exclusionFor(tags: readonly string[] | null | undefined, symbol: string | null | undefined): UnusualRefusal | null {
  const normalised = (tags || []).map((tag) => String(tag ?? '').trim().toLowerCase()).filter(Boolean)
  if (normalised.some((tag) => EXCLUDED_PEG_TAGS.includes(tag))) return 'peg_excluded'
  if (normalised.some((tag) => EXCLUDED_WRAPPER_TAGS.includes(tag))) return 'wrapper_excluded'
  const ticker = String(symbol ?? '').trim().toUpperCase()
  if (ticker && EXCLUDED_WRAPPER_SYMBOLS.includes(ticker)) return 'wrapper_excluded'
  return null
}

const pct = (value: number | null): number | null => (value == null ? null : value * 100)

/** An unscored result, carrying the reason and the sample count so the surface
 * can say "insufficient history, 12 of 30 days" rather than leave a blank row. */
function refuse(assetKey: string, reason: UnusualRefusal, sampleDays: number, requiredDays: number, subjectDay: string | null = null): UnusualScore {
  return {
    assetKey, scored: false, reason, sampleDays, requiredDays, subjectDay,
    movePct: null, volume: null, isMarketReference: false, windows: [],
  }
}

/** One window's readings. `trailing` excludes the scored day: a day cannot be
 * part of the distribution it is being compared against, or an extreme day
 * quietly widens the very spread that is supposed to flag it. */
function scoreWindow(
  days: number,
  subject: DailyReturn,
  history: readonly DailyReturn[],
  marketByDay: Map<string, number>,
  subjectMarketReturn: number | null,
  isMarketReference: boolean,
): WindowScore {
  // Newest `days` trailing returns. `history` is oldest first, so the window is
  // its tail; a shorter history yields a shorter window and says so through `n`.
  const trailing = history.slice(Math.max(0, history.length - days))
  const absolute = trailing.map((row) => Math.abs(row.ret))
  const centre = median(absolute)
  const mad = medianAbsoluteDeviation(absolute, centre)
  const z = robustZ(Math.abs(subject.ret), centre, mad)
  const rank = percentileRank(Math.abs(subject.ret), absolute)

  // Volume. Only strictly positive reported volumes have a logarithm; a zero
  // (nothing traded) and a null (never reported) are both left out of the log
  // window, and `volumeN` says how many days the figure actually rests on.
  const logVolumes = trailing.map((row) => row.volume).filter((v): v is number => v != null && v > 0).map((v) => Math.log(v))
  const subjectLogVolume = subject.volume != null && subject.volume > 0 ? Math.log(subject.volume) : null
  const volumeCentre = median(logVolumes)
  const volumeMad = medianAbsoluteDeviation(logVolumes, volumeCentre)
  const volumeZ = subjectLogVolume == null
    ? { z: null, reason: 'volume_not_reported' as FigureRefusal }
    : robustZ(subjectLogVolume, volumeCentre, volumeMad)
  // The percentile runs on RAW volume, which is the same ordering as the log and
  // survives a window that contains a zero.
  const rawVolumes = trailing.map((row) => row.volume).filter((v): v is number => v != null)
  const volumeRank = percentileRank(subject.volume, rawVolumes)

  // Beta over the same trailing window, on the days both series reported.
  const fit = isMarketReference
    ? { beta: null, n: 0, reason: 'market_reference' as FigureRefusal }
    : olsBeta(trailing.map((row) => ({ asset: row.ret, market: marketByDay.get(row.day) as number })).filter((p) => Number.isFinite(p.market)))
  const residual = fit.beta != null && subjectMarketReturn != null ? subject.ret - fit.beta * subjectMarketReturn : null

  // In percent, so the drawing and the figures beside it share one unit.
  const shape = distributionBins(absolute.map((v) => v * 100), Math.abs(subject.ret) * 100)

  return {
    days, n: trailing.length,
    medianAbsPct: pct(centre), madPct: pct(mad),
    robustZ: z.z, robustZReason: z.reason,
    percentile: rank.percentile, exceeded: rank.exceeded,
    volumeN: logVolumes.length,
    volumeRobustZ: volumeZ.z, volumeRobustZReason: volumeZ.reason,
    volumePercentile: volumeRank.percentile, volumeExceeded: volumeRank.exceeded,
    beta: fit.beta, betaN: fit.n, betaReason: fit.reason,
    marketMovePct: pct(subjectMarketReturn), residualPct: pct(residual),
    distribution: shape.bins, subjectBin: shape.subjectBin,
  }
}

/**
 * Score one asset's most recent complete day against its own history.
 *
 * The scored day is the NEWEST return the series can produce, which is the last
 * complete UTC day the archive holds. It is not the rolling 24-hour figure the
 * catalogue reports: a rolling window cannot be compared with a distribution of
 * closed days without quietly changing the question, and the surface dates the
 * column so a reader can see which day was measured.
 */
export function scoreUnusualMove(input: ScoreInput): UnusualScore {
  const assetKey = String(input?.assetKey ?? '')
  const minSample = Math.max(2, Math.trunc(Number(input?.minSampleDays) || MIN_SAMPLE_DAYS))
  const windowDays = (input?.windowDays && input.windowDays.length ? input.windowDays : UNUSUAL_WINDOW_DAYS)
    .map((d) => Math.max(2, Math.trunc(Number(d) || 0))).filter((d) => d >= 2)

  // The cheap, definitive gates first, so the recorded reason is the most
  // specific true one rather than whichever check happened to run earliest.
  // Every refusal carries the day it WOULD have scored where one exists, so a
  // stored refusal can still be dated on the surface.
  const returns = dailyReturns(input?.series || [])
  const sampleDays = Math.max(0, returns.length - 1)
  const dayOrNull = returns.length ? returns[returns.length - 1].day : null

  const excluded = exclusionFor(input?.tags, input?.symbol)
  if (excluded) return refuse(assetKey, excluded, sampleDays, minSample, dayOrNull)

  const floor = finiteNumber(input?.liquidityFloorUsd) ?? DEFAULT_LIQUIDITY_FLOOR_USD
  const liquidity = finiteNumber(input?.liquidityUsd)
  if (liquidity == null) return refuse(assetKey, 'liquidity_unknown', sampleDays, minSample, dayOrNull)
  if (liquidity < floor) return refuse(assetKey, 'below_liquidity_floor', sampleDays, minSample, dayOrNull)

  if (!returns.length) return refuse(assetKey, 'no_subject_return', 0, minSample)
  const subject = returns[returns.length - 1]
  const history = returns.slice(0, returns.length - 1)
  if (history.length < minSample) return refuse(assetKey, 'insufficient_history', history.length, minSample, subject.day)

  const isMarketReference = !!input?.marketKey && input.marketKey === assetKey
  const marketByDay = new Map<string, number>()
  for (const row of input?.marketReturns || []) {
    const value = finiteNumber(row?.ret)
    if (value != null && row?.day) marketByDay.set(String(row.day), value)
  }
  const subjectMarketReturn = marketByDay.has(subject.day) ? (marketByDay.get(subject.day) as number) : null

  return {
    assetKey, scored: true, reason: null,
    sampleDays: history.length, requiredDays: minSample,
    subjectDay: subject.day, movePct: pct(subject.ret), volume: subject.volume,
    isMarketReference,
    windows: windowDays.map((days) => scoreWindow(days, subject, history, marketByDay, subjectMarketReturn, isMarketReference)),
  }
}

/** The window a surface leads with, or null when the score carries none. */
export function windowOf(score: UnusualScore | null | undefined, days: number): WindowScore | null {
  return (score?.windows || []).find((w) => w.days === days) ?? null
}

/**
 * Ranking order: percentile first, liquidity second.
 *
 * Percentile leads because it is the claim the section makes. Liquidity breaks
 * the tie rather than joining the score, because an asset is not more unusual
 * for being larger; a tie on percentile is common (with 92 trailing days there
 * are only 92 possible values) and resolving it by turnover puts the tie-break
 * on "which of these equally unusual days can a reader actually act on". The
 * order is total: the asset key settles a tie on both, so the same run always
 * produces the same list.
 */
export function compareUnusual(a: UnusualScore, b: UnusualScore, liquidity: (score: UnusualScore) => number | null, days = 90): number {
  const pa = windowOf(a, days)?.percentile ?? -1, pb = windowOf(b, days)?.percentile ?? -1
  if (pa !== pb) return pb - pa
  const la = liquidity(a) ?? -1, lb = liquidity(b) ?? -1
  if (la !== lb) return lb - la
  return a.assetKey < b.assetKey ? -1 : a.assetKey > b.assetKey ? 1 : 0
}
