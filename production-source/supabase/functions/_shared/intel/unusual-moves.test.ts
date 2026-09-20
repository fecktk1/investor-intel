import { assertEquals as eq, assertAlmostEquals as near } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  DEFAULT_LIQUIDITY_FLOOR_USD, EXCLUDED_PEG_TAGS, MAD_TO_SIGMA, MIN_SAMPLE_DAYS,
  compareUnusual, dailyReturns, distributionBins, exclusionFor, median, medianAbsoluteDeviation,
  olsBeta, percentileRank, robustZ, scoreUnusualMove, windowOf,
  type DailyClose, type DailyReturn,
} from './unusual-moves.ts'

// ─── Test fixtures ────────────────────────────────────────────────────────────

const DAY = 86_400_000
/** `days` consecutive UTC dates ending on `last`, oldest first. */
function dates(last: string, days: number): string[] {
  const end = Date.parse(`${last}T00:00:00Z`)
  return Array.from({ length: days }, (_, i) => new Date(end - (days - 1 - i) * DAY).toISOString().slice(0, 10))
}
/** A close series built from a list of simple daily returns, starting at 100. */
function seriesFromReturns(last: string, returns: number[], volume: (index: number) => number | null = () => 1000): DailyClose[] {
  const days = dates(last, returns.length + 1)
  let close = 100
  const out: DailyClose[] = [{ day: days[0], close, volume: volume(-1) }]
  returns.forEach((ret, i) => { close = close * (1 + ret); out.push({ day: days[i + 1], close, volume: volume(i) }) })
  return out
}
const marketFromReturns = (last: string, returns: number[]): DailyReturn[] =>
  dates(last, returns.length).map((day, i) => ({ day, ret: returns[i], volume: null }))

// ─── Hand-computed median and MAD ─────────────────────────────────────────────

Deno.test('median on a known series, including the even-count average and the empty sample', () => {
  // Sorted: 1, 2, 3, 4, 100. Middle value is 3; the outlier moves nothing.
  eq(median([3, 1, 100, 2, 4]), 3)
  // Sorted: 1, 2, 3, 4. Mean of the two middle values.
  eq(median([4, 1, 3, 2]), 2.5)
  eq(median([7]), 7)
  eq(median([]), null)
  // Non-finite values are dropped rather than sorted to an end.
  eq(median([1, Number.NaN, 3]), 2)
})

Deno.test('MAD on a hand-computed series, and a mean-based spread would not agree', () => {
  // Sample 1, 2, 3, 4, 100. Median 3. Deviations |x-3| = 2, 1, 0, 1, 97.
  // Sorted deviations: 0, 1, 1, 2, 97 -> median 1.
  const sample = [1, 2, 3, 4, 100]
  eq(medianAbsoluteDeviation(sample), 1)
  // The whole reason MAD is used: the standard deviation of the same sample is
  // about 42.7, so the 100 would set the scale it is supposed to be judged by.
  const mean = sample.reduce((s, v) => s + v, 0) / sample.length
  const sd = Math.sqrt(sample.reduce((s, v) => s + (v - mean) ** 2, 0) / sample.length)
  near(sd, 39.01, 0.01)
  // An explicit centre is honoured instead of the sample's own median.
  // |x-0| = 1, 2, 3, 4, 100 -> median 3.
  eq(medianAbsoluteDeviation(sample, 0), 3)
  eq(medianAbsoluteDeviation([]), null)
})

Deno.test('robust z scales the MAD by 1.4826 and refuses a zero-spread window', () => {
  // value 10, centre 3, MAD 1: (10 - 3) / (1.4826 * 1).
  const scored = robustZ(10, 3, 1)
  near(scored.z as number, 7 / MAD_TO_SIGMA, 1e-12)
  near(scored.z as number, 4.72143, 1e-5)
  eq(scored.reason, null)
  // More than half the window at one value: nothing to scale by, and the answer
  // is a reason rather than Infinity.
  eq(robustZ(10, 3, 0), { z: null, reason: 'mad_zero' })
  eq(robustZ(10, 3, null), { z: null, reason: 'short_window' })
  eq(robustZ(null, 3, 1), { z: null, reason: 'short_window' })
})

// ─── Percentile edge cases ────────────────────────────────────────────────────

Deno.test('percentile rank counts the sample points at or below the value', () => {
  const sample = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  // 7 beats 1..7 inclusive: 7 of 10.
  eq(percentileRank(7, sample), { percentile: 70, exceeded: 7, n: 10 })
  // Above everything is 100, which is the claim the surface makes in words.
  eq(percentileRank(99, sample), { percentile: 100, exceeded: 10, n: 10 })
  // Exactly the largest still ties it, so it is at or above all ten.
  eq(percentileRank(10, sample), { percentile: 100, exceeded: 10, n: 10 })
  // Below everything beats none of them.
  eq(percentileRank(0, sample), { percentile: 0, exceeded: 0, n: 10 })
  // A tie with the smallest is not zero: it did not beat zero of them.
  eq(percentileRank(1, sample), { percentile: 10, exceeded: 1, n: 10 })
})

Deno.test('percentile rank over an empty or unusable sample is null, never 0 or 100', () => {
  eq(percentileRank(5, []), { percentile: null, exceeded: null, n: 0 })
  eq(percentileRank(null, [1, 2, 3]), { percentile: null, exceeded: null, n: 3 })
  eq(percentileRank(5, [Number.NaN, Number.POSITIVE_INFINITY]), { percentile: null, exceeded: null, n: 0 })
  // A window where every day tied reads 100 of 4, which is true of that window.
  eq(percentileRank(2, [2, 2, 2, 2]), { percentile: 100, exceeded: 4, n: 4 })
})

// ─── Returns ──────────────────────────────────────────────────────────────────

Deno.test('daily returns are simple, close to close, and only across consecutive days', () => {
  const rows = dailyReturns([
    { day: '2026-09-15', close: 100, volume: 10 },
    { day: '2026-09-16', close: 110, volume: 20 },
    // A gap: no 09-17 candle, so 09-18 produces NO return rather than a
    // two-day move presented as a daily one.
    { day: '2026-09-18', close: 121, volume: 30 },
    { day: '2026-09-19', close: 121, volume: 0 },
  ])
  eq(rows.length, 2)
  eq(rows[0].day, '2026-09-16')
  near(rows[0].ret, 0.1, 1e-12)
  eq(rows[0].volume, 20)
  eq(rows[1].day, '2026-09-19')
  eq(rows[1].ret, 0)
  // A zero volume is a completed day in which nothing traded and stays zero.
  eq(rows[1].volume, 0)
})

Deno.test('unordered, zero-price and undated candles cannot enter the return series', () => {
  const rows = dailyReturns([
    { day: '2026-09-17', close: 110, volume: null },
    { day: '2026-09-16', close: 100, volume: null },
    { day: 'not-a-day', close: 999, volume: null },
    { day: '2026-09-18', close: 0, volume: null },
  ])
  eq(rows.map((r) => r.day), ['2026-09-17'])
  near(rows[0].ret, 0.1, 1e-12)
  eq(dailyReturns([]), [])
})

// ─── Beta ─────────────────────────────────────────────────────────────────────

Deno.test('beta of a perfectly correlated series is the scale factor', () => {
  const market = [0.01, -0.02, 0.03, -0.015, 0.004, 0.02, -0.011]
  for (const scale of [2, 0.5, 1, -1.5]) {
    const fit = olsBeta(market.map((m) => ({ asset: scale * m, market: m })))
    near(fit.beta as number, scale, 1e-12)
    eq(fit.n, market.length)
    eq(fit.reason, null)
  }
})

Deno.test('beta reports its refusal instead of a slope it cannot fit', () => {
  // A market with no variance over the window has no slope.
  eq(olsBeta([{ asset: 1, market: 3 }, { asset: 2, market: 3 }]), { beta: null, n: 2, reason: 'market_flat' })
  // One paired day is not a fit.
  eq(olsBeta([{ asset: 1, market: 2 }]), { beta: null, n: 1, reason: 'no_market_overlap' })
  eq(olsBeta([]), { beta: null, n: 0, reason: 'no_market_overlap' })
  // Unpaired days are excluded from the count, not counted and then ignored.
  const fit = olsBeta([{ asset: 1, market: 1 }, { asset: 2, market: 2 }, { asset: 3, market: Number.NaN }])
  eq(fit.n, 2)
  near(fit.beta as number, 1, 1e-12)
})

Deno.test('an intercept is fitted, so a constant drift does not inflate beta', () => {
  const market = [0.01, -0.02, 0.03, -0.015, 0.004]
  // asset = 0.5 * market + 0.10 every day. A ratio-of-sums estimator would
  // return a large number; OLS returns the slope.
  const fit = olsBeta(market.map((m) => ({ asset: 0.5 * m + 0.1, market: m })))
  near(fit.beta as number, 0.5, 1e-10)
})

// ─── Exclusions ───────────────────────────────────────────────────────────────

Deno.test('pegs and wrapped receipts are excluded by tag and by symbol, and protocol tokens are not', () => {
  for (const tag of EXCLUDED_PEG_TAGS) eq(exclusionFor([tag], 'ANY'), 'peg_excluded')
  eq(exclusionFor(['STABLECOIN', ' usd-stablecoin '], null), 'peg_excluded')
  eq(exclusionFor(['wrapped-tokens'], null), 'wrapper_excluded')
  eq(exclusionFor([], 'wbtc'), 'wrapper_excluded')
  eq(exclusionFor([], 'STETH'), 'wrapper_excluded')
  // A stablecoin issuer's own free-floating token is NOT a peg.
  eq(exclusionFor(['defi', 'stablecoin-protocol'], 'ENA'), null)
  // Symbols that merely start with W are ordinary assets.
  for (const symbol of ['WLD', 'W', 'WAL', 'WEMIX', 'WLFI', 'WIF']) eq(exclusionFor(['defi'], symbol), null)
  eq(exclusionFor(null, null), null)
})

// ─── Short history refuses to score ───────────────────────────────────────────

Deno.test('short history is refused with its sample count, and nothing is scored', () => {
  // 20 closes gives 19 trailing returns after the subject day is removed.
  const score = scoreUnusualMove({
    assetKey: 'eip155:1:native', symbol: 'ETH', tags: ['pos'],
    series: seriesFromReturns('2026-09-19', Array.from({ length: 20 }, () => 0.01)),
    liquidityUsd: 9_000_000_000,
  })
  eq(score.scored, false)
  eq(score.reason, 'insufficient_history')
  eq(score.sampleDays, 19)
  eq(score.requiredDays, MIN_SAMPLE_DAYS)
  eq(score.subjectDay, '2026-09-19')
  eq(score.movePct, null)
  eq(score.windows, [])
})

Deno.test('exactly the minimum sample is scored and one day fewer is not', () => {
  const ret = Array.from({ length: MIN_SAMPLE_DAYS + 1 }, (_, i) => (i % 2 ? 0.02 : -0.01))
  const base = { assetKey: 'a:b:c', symbol: 'AAA', tags: ['defi'], liquidityUsd: 5_000_000 }
  eq(scoreUnusualMove({ ...base, series: seriesFromReturns('2026-09-19', ret) }).scored, true)
  eq(scoreUnusualMove({ ...base, series: seriesFromReturns('2026-09-19', ret.slice(1)) }).reason, 'insufficient_history')
})

Deno.test('the gates fire in order and each records its own reason', () => {
  const series = seriesFromReturns('2026-09-19', Array.from({ length: 95 }, () => 0.01))
  // A peg is refused even with ample history and turnover.
  eq(scoreUnusualMove({ assetKey: 'k', symbol: 'USDC', tags: ['stablecoin'], series, liquidityUsd: 9e9 }).reason, 'peg_excluded')
  // Liquidity that was never reported is not read as zero.
  eq(scoreUnusualMove({ assetKey: 'k', symbol: 'AAA', tags: [], series, liquidityUsd: null }).reason, 'liquidity_unknown')
  eq(scoreUnusualMove({ assetKey: 'k', symbol: 'AAA', tags: [], series, liquidityUsd: 10 }).reason, 'below_liquidity_floor')
  // The floor is the documented default unless the caller states another.
  eq(scoreUnusualMove({ assetKey: 'k', symbol: 'AAA', tags: [], series, liquidityUsd: DEFAULT_LIQUIDITY_FLOOR_USD }).scored, true)
  eq(scoreUnusualMove({ assetKey: 'k', symbol: 'AAA', tags: [], series, liquidityUsd: 10, liquidityFloorUsd: 5 }).scored, true)
  eq(scoreUnusualMove({ assetKey: 'k', symbol: 'AAA', tags: [], series: [], liquidityUsd: 9e9 }).reason, 'no_subject_return')
})

// ─── The whole score, hand-checked ────────────────────────────────────────────

Deno.test('a hand-computed score: 91 quiet days then one large one', () => {
  // 90 trailing days alternating +1% / -1%, then a +20% subject day.
  // |trailing returns| are all 0.01, so median 0.01 and MAD 0.
  const trailing = Array.from({ length: 90 }, (_, i) => (i % 2 ? 0.01 : -0.01))
  const score = scoreUnusualMove({
    assetKey: 'a', symbol: 'AAA', tags: ['defi'], liquidityUsd: 5_000_000,
    series: seriesFromReturns('2026-09-19', [...trailing, 0.2]),
  })
  eq(score.scored, true)
  eq(score.sampleDays, 90)
  eq(score.subjectDay, '2026-09-19')
  near(score.movePct as number, 20, 1e-10)
  const w90 = windowOf(score, 90)!
  eq(w90.n, 90)
  near(w90.medianAbsPct as number, 1, 1e-12)
  eq(w90.madPct, 0)
  // Every trailing day moved by exactly 1%: there is no spread to scale by, so
  // the robust z is a stated refusal and the percentile carries the finding.
  eq(w90.robustZ, null)
  eq(w90.robustZReason, 'mad_zero')
  eq(w90.percentile, 100)
  eq(w90.exceeded, 90)
  // The 30-day window is the tail of the same history.
  eq(windowOf(score, 30)!.n, 30)
  eq(windowOf(score, 30)!.exceeded, 30)
})

Deno.test('a real spread produces a finite robust z and a percentile that agree', () => {
  // Trailing |returns| alternate 1.5% and 3.5%, 45 of each: median 2.5%, every
  // deviation 1% -> MAD 1%. Subject +10%: z = (10 - 2.5) / (1.4826 * 1). The
  // 30-day tail is balanced the same way, so both windows agree.
  const trailing = Array.from({ length: 90 }, (_, i) => (i % 2 ? 0.015 : -0.035))
  const score = scoreUnusualMove({
    assetKey: 'a', symbol: 'AAA', tags: [], liquidityUsd: 5_000_000,
    series: seriesFromReturns('2026-09-19', [...trailing, 0.1]),
  })
  const w = windowOf(score, 90)!
  eq(w.n, 90)
  near(w.medianAbsPct as number, 2.5, 1e-9)
  near(w.madPct as number, 1, 1e-9)
  near(w.robustZ as number, 7.5 / MAD_TO_SIGMA, 1e-9)
  near(w.robustZ as number, 5.05869, 1e-5)
  eq(w.percentile, 100)
  eq(w.exceeded, 90)
  const short = windowOf(score, 30)!
  eq(short.n, 30)
  near(short.medianAbsPct as number, 2.5, 1e-9)
  near(short.madPct as number, 1, 1e-9)
})

Deno.test('the scored day is excluded from the distribution it is compared against', () => {
  // 40 trailing days at 1%, subject at 50%. If the subject were part of the
  // window the median and MAD would both move; they must not.
  const score = scoreUnusualMove({
    assetKey: 'a', symbol: 'AAA', tags: [], liquidityUsd: 5_000_000,
    series: seriesFromReturns('2026-09-19', [...Array.from({ length: 40 }, () => 0.01), 0.5]),
  })
  const w = windowOf(score, 30)!
  eq(w.n, 30)
  near(w.medianAbsPct as number, 1, 1e-12)
  eq(w.exceeded, 30)
})

Deno.test('volume is scored on the log scale, and unreported or zero days leave the window', () => {
  // Trailing volumes 1000 on odd days, null on even, and the subject at 1e6.
  const trailing = Array.from({ length: 92 }, () => 0.01)
  const score = scoreUnusualMove({
    assetKey: 'a', symbol: 'AAA', tags: [], liquidityUsd: 5_000_000,
    series: seriesFromReturns('2026-09-19', [...trailing, 0.02], (i) => (i === trailing.length ? 1_000_000 : i % 2 ? 1_000 : null)),
  })
  const w = windowOf(score, 90)!
  // 90 trailing days, 45 of them with a reported volume.
  eq(w.n, 90)
  eq(w.volumeN, 45)
  // ln(1e6) against a window sitting at ln(1000) with no spread: the reason is
  // stated rather than an Infinity, and the percentile still answers.
  eq(w.volumeRobustZ, null)
  eq(w.volumeRobustZReason, 'mad_zero')
  eq(w.volumePercentile, 100)
  eq(w.volumeExceeded, 45)
})

Deno.test('a volume the source never reported is a reason, not a zero', () => {
  const trailing = Array.from({ length: 92 }, () => 0.01)
  const score = scoreUnusualMove({
    assetKey: 'a', symbol: 'AAA', tags: [], liquidityUsd: 5_000_000,
    series: seriesFromReturns('2026-09-19', [...trailing, 0.02], (i) => (i === trailing.length ? null : 1_000 + i)),
  })
  const w = windowOf(score, 90)!
  eq(w.volumeRobustZ, null)
  eq(w.volumeRobustZReason, 'volume_not_reported')
  eq(w.volumePercentile, null)
})

// ─── Beta and the residual inside a score ─────────────────────────────────────

Deno.test('beta inside a score recovers the scale factor and the residual is the asset own part', () => {
  const marketReturns = Array.from({ length: 93 }, (_, i) => [0.01, -0.02, 0.015, -0.005][i % 4])
  // The asset is exactly twice the market on every trailing day, then adds 10
  // percentage points of its own on the subject day.
  const assetReturns = marketReturns.map((m) => 2 * m)
  assetReturns[assetReturns.length - 1] = 2 * marketReturns[marketReturns.length - 1] + 0.1
  const last = '2026-09-19'
  const score = scoreUnusualMove({
    assetKey: 'asset', marketKey: 'btc', symbol: 'AAA', tags: [], liquidityUsd: 5_000_000,
    series: seriesFromReturns(last, assetReturns),
    marketReturns: marketFromReturns(last, marketReturns),
  })
  const w = windowOf(score, 90)!
  eq(w.betaN, 90)
  near(w.beta as number, 2, 1e-9)
  eq(w.betaReason, null)
  near(w.marketMovePct as number, marketReturns[marketReturns.length - 1] * 100, 1e-9)
  // today − 2 × market = the 10 points the asset added by itself.
  near(w.residualPct as number, 10, 1e-8)
  eq(score.isMarketReference, false)
})

Deno.test('the market reference has no beta on itself and no residual', () => {
  const returns = Array.from({ length: 93 }, (_, i) => [0.01, -0.02, 0.015, -0.005][i % 4])
  const last = '2026-09-19'
  const score = scoreUnusualMove({
    assetKey: 'btc', marketKey: 'btc', symbol: 'BTC', tags: ['pow'], liquidityUsd: 2e10,
    series: seriesFromReturns(last, returns), marketReturns: marketFromReturns(last, returns),
  })
  eq(score.isMarketReference, true)
  const w = windowOf(score, 90)!
  eq(w.beta, null)
  eq(w.betaN, 0)
  eq(w.betaReason, 'market_reference')
  eq(w.residualPct, null)
  // The asset's own distribution is still scored: the reference is not exempt
  // from being unusual for itself.
  eq(typeof w.percentile, 'number')
})

Deno.test('no overlapping market history is a reason, and the percentile still stands', () => {
  const returns = Array.from({ length: 93 }, (_, i) => [0.01, -0.02, 0.03, -0.01][i % 4])
  const score = scoreUnusualMove({
    assetKey: 'asset', marketKey: 'btc', symbol: 'AAA', tags: [], liquidityUsd: 5_000_000,
    series: seriesFromReturns('2026-09-19', returns),
    // The market series is a year away: no day pairs.
    marketReturns: marketFromReturns('2025-09-19', returns),
  })
  const w = windowOf(score, 90)!
  eq(w.beta, null)
  eq(w.betaN, 0)
  eq(w.betaReason, 'no_market_overlap')
  eq(w.marketMovePct, null)
  eq(w.residualPct, null)
  eq(typeof w.percentile, 'number')
})

Deno.test('a window shorter than its label reports the sample it actually has', () => {
  // 45 trailing returns: the 30-day window is full, the 90-day one is not.
  const score = scoreUnusualMove({
    assetKey: 'a', symbol: 'AAA', tags: [], liquidityUsd: 5_000_000,
    series: seriesFromReturns('2026-09-19', Array.from({ length: 46 }, (_, i) => (i % 3 ? 0.01 : -0.02))),
  })
  eq(score.sampleDays, 45)
  eq(windowOf(score, 30)!.n, 30)
  eq(windowOf(score, 90)!.n, 45)
})

// ─── The distribution drawing ─────────────────────────────────────────────────

Deno.test('the bins span the scored day, so an extreme day has a bar to stand in', () => {
  // Trailing days all under 4, today at 20: the range runs to 20 in ten bins of
  // 2, every trailing day lands in the first two, and today lands in the last.
  const shape = distributionBins([1, 2, 3, 3.9, -2], 20)
  eq(shape.bins.length, 10)
  eq(shape.bins[0], { from: 0, to: 2, count: 1 })
  eq(shape.bins[1].count, 4, 'the lower edge of a bin belongs to it')
  eq(shape.bins[9].count, 0, 'a zero-count bin is a bin, not a gap')
  eq(shape.subjectBin, 9)
  eq(shape.bins.reduce((sum, bin) => sum + bin.count, 0), 5, 'every trailing day is counted exactly once')
})

Deno.test('the top edge is inclusive, and a sign is dropped before binning', () => {
  // Max 10 over five bins of 2: the value 10 belongs in the last bin, not off the end.
  const shape = distributionBins([-10, 10, 1], null, 5)
  eq(shape.bins.length, 5)
  eq(shape.bins[4], { from: 8, to: 10, count: 2 })
  eq(shape.bins[0].count, 1)
  eq(shape.subjectBin, null)
})

Deno.test('a degenerate window names its one value instead of inventing a range', () => {
  eq(distributionBins([0, 0, 0], 0), { bins: [{ from: 0, to: 0, count: 3 }], subjectBin: 0 })
  eq(distributionBins([], 5), { bins: [], subjectBin: null })
})

Deno.test('a scored window publishes its own bins, summing to its sample', () => {
  const trailing = Array.from({ length: 92 }, (_, i) => [0.01, -0.02, 0.03, -0.015][i % 4])
  const score = scoreUnusualMove({
    assetKey: 'a', symbol: 'AAA', tags: [], liquidityUsd: 5_000_000,
    series: seriesFromReturns('2026-09-19', [...trailing, 0.2]),
  })
  const w = windowOf(score, 90)!
  eq(w.distribution.length, 10)
  eq(w.distribution.reduce((sum, bin) => sum + bin.count, 0), w.n)
  eq(w.subjectBin, 9, 'a 20% day against a window topping out at 3% sits in the last bin')
  // The edges are in percent, the same unit as medianAbsPct beside them.
  near(w.distribution.at(-1)!.to, 20, 1e-9)
})

// ─── Ranking ──────────────────────────────────────────────────────────────────

Deno.test('ranking is percentile first, liquidity second, asset key last', () => {
  const at = (assetKey: string, percentile: number): ReturnType<typeof scoreUnusualMove> => ({
    assetKey, scored: true, reason: null, sampleDays: 90, requiredDays: 30, subjectDay: '2026-09-19',
    movePct: 1, volume: null, isMarketReference: false,
    windows: [{
      days: 90, n: 90, medianAbsPct: 1, madPct: 1, robustZ: 1, robustZReason: null,
      percentile, exceeded: 1, volumeN: 90, volumeRobustZ: null, volumeRobustZReason: null,
      volumePercentile: null, volumeExceeded: null, beta: null, betaN: 0, betaReason: null,
      marketMovePct: null, residualPct: null, distribution: [], subjectBin: null,
    }],
  })
  const liquidity: Record<string, number> = { low: 10, high: 1000, tied: 1000 }
  const sorted = [at('low', 90), at('high', 90), at('tied', 90), at('top', 99)]
    .sort((a, b) => compareUnusual(a, b, (s) => liquidity[s.assetKey] ?? null))
  // 99 leads; then the two at 1000 turnover in key order; then the thin one.
  eq(sorted.map((s) => s.assetKey), ['top', 'high', 'tied', 'low'])
})
