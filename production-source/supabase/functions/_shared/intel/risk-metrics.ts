// Derived risk measures over an asset's own price history (CMC plan proposal 10,
// and the Basic-plan fallback for proposal 14's "distance from high").
//
// Pure and deterministic: no provider, no clock of its own, no database. Every
// measure states how many samples it used. A measure that cannot be computed
// returns NULL components — never a zero that would read as a calm market. A
// genuinely flat series is the one case where zero is the answer, and it is
// reported as zero.
export interface PricePoint { t: number; price: number }
export interface Volatility { pct: number | null; samples: number; intervalSeconds: number | null; windowDays: number }
export interface Drawdown { pct: number | null; peakT: number | null; troughT: number | null; recoveredT: number | null; daysUnderWater: number | null }
export interface DistanceFromHigh { high: number | null; highT: number | null; pct: number | null; daysSince: number | null }

const DAY = 86400000, YEAR_SECONDS = 365 * 86400
const MIN_POINTS = 3

/** Ascending, deduplicated by timestamp, positive finite prices only. */
export function normalizePricePoints(points: readonly PricePoint[] | null | undefined): PricePoint[] {
  const byTime = new Map<number, PricePoint>()
  for (const p of Array.isArray(points) ? points : []) {
    const t = Number(p?.t), price = Number(p?.price)
    if (!Number.isFinite(t) || !Number.isFinite(price) || price <= 0) continue
    if (!byTime.has(t)) byTime.set(t, { t, price })
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t)
}
function medianGapSeconds(points: readonly PricePoint[]): number | null {
  const gaps: number[] = []
  for (let i = 1; i < points.length; i++) { const gap = points[i].t - points[i - 1].t; if (gap > 0) gaps.push(gap) }
  if (!gaps.length) return null
  gaps.sort((a, b) => a - b)
  const middle = gaps.length >> 1
  const median = gaps.length % 2 ? gaps[middle] : (gaps[middle - 1] + gaps[middle]) / 2
  return median > 0 ? median / 1000 : null
}

/** Annualised standard deviation of log returns, sampled at the series' own
 * interval. The sample count is part of the answer: a 30-day window of daily
 * closes and a 30-day window of hourly closes are not the same evidence. */
export function realizedVolatility(points: readonly PricePoint[] | null | undefined, options: { windowDays?: number } = {}): Volatility {
  const windowDays = Number.isFinite(Number(options.windowDays)) && Number(options.windowDays) > 0 ? Number(options.windowDays) : 30
  const all = normalizePricePoints(points)
  const empty: Volatility = { pct: null, samples: 0, intervalSeconds: null, windowDays }
  if (all.length < MIN_POINTS) return empty
  const cutoff = all[all.length - 1].t - windowDays * DAY
  const window = all.filter(p => p.t >= cutoff)
  if (window.length < MIN_POINTS) return empty
  const intervalSeconds = medianGapSeconds(window)
  if (intervalSeconds == null) return empty
  const returns: number[] = []
  for (let i = 1; i < window.length; i++) returns.push(Math.log(window[i].price / window[i - 1].price))
  if (returns.length < 2) return { ...empty, intervalSeconds }
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1)
  const perYear = YEAR_SECONDS / intervalSeconds
  const pct = Math.sqrt(Math.max(0, variance) * perYear) * 100
  return { pct: Number.isFinite(pct) ? pct : null, samples: returns.length, intervalSeconds, windowDays }
}

/** Deepest peak-to-trough decline in the series, with the episode's own clock.
 * `pct` is the signed return from the peak (<= 0); recovery is the first later
 * point back at or above that peak, and is null while the asset is still under
 * water. A series that never declines reports a valid zero. */
export function maxDrawdown(points: readonly PricePoint[] | null | undefined): Drawdown {
  const all = normalizePricePoints(points)
  if (all.length < MIN_POINTS) return { pct: null, peakT: null, troughT: null, recoveredT: null, daysUnderWater: null }
  let peak = all[0].price, peakT = all[0].t
  let worst = 0, worstPeak = all[0].price, worstPeakT = all[0].t, worstTroughT = all[0].t
  for (const p of all) {
    if (p.price >= peak) { peak = p.price; peakT = p.t; continue }
    const decline = (p.price - peak) / peak * 100
    if (decline < worst) { worst = decline; worstPeak = peak; worstPeakT = peakT; worstTroughT = p.t }
  }
  if (worst === 0) return { pct: 0, peakT: all[0].t, troughT: all[0].t, recoveredT: all[0].t, daysUnderWater: 0 }
  const recovered = all.find(p => p.t > worstTroughT && p.price >= worstPeak)?.t ?? null
  return { pct: worst, peakT: worstPeakT, troughT: worstTroughT, recoveredT: recovered,
    daysUnderWater: ((recovered ?? all[all.length - 1].t) - worstPeakT) / DAY }
}

/** How far below its highest observed close the asset is now, and how long ago
 * that high was LAST reached. The high is the high of the supplied window only. */
export function distanceFromHigh(points: readonly PricePoint[] | null | undefined, now: number): DistanceFromHigh {
  const all = normalizePricePoints(points)
  const empty: DistanceFromHigh = { high: null, highT: null, pct: null, daysSince: null }
  if (all.length < MIN_POINTS || !Number.isFinite(now)) return empty
  let high = -Infinity, highT = all[0].t
  for (const p of all) if (p.price >= high) { high = p.price; highT = p.t }
  const last = all[all.length - 1].price
  const pct = (last - high) / high * 100
  return { high, highT, pct: Number.isFinite(pct) ? pct : null, daysSince: Math.max(0, now - highT) / DAY }
}

/** Total time the series spent below a previous peak, in days. Each interval is
 * attributed to the point that closes it. */
export function timeUnderWaterDays(points: readonly PricePoint[] | null | undefined): number | null {
  const all = normalizePricePoints(points)
  if (all.length < MIN_POINTS) return null
  let peak = all[0].price, underWater = 0
  for (let i = 1; i < all.length; i++) {
    if (all[i].price < peak) underWater += all[i].t - all[i - 1].t
    else peak = all[i].price
  }
  return underWater / DAY
}

/** Where a value sits inside a comparison sample, 0-100. Ties count as half, so
 * a value equal to every sample member is the median, not the maximum. */
export function percentileRank(value: unknown, sample: readonly unknown[] | null | undefined): number | null {
  // Null, empty text and booleans are absent values, never a numeric zero.
  const num = (v: unknown) => v == null || v === '' || typeof v === 'boolean' ? Number.NaN : Number(v)
  const v = num(value)
  if (!Number.isFinite(v)) return null
  const values = (Array.isArray(sample) ? sample : []).map(num).filter(n => Number.isFinite(n))
  if (!values.length) return null
  let below = 0, equal = 0
  for (const n of values) { if (n < v) below++; else if (n === v) equal++ }
  return (below + equal / 2) / values.length * 100
}
