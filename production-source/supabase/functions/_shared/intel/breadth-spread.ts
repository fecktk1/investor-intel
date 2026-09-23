// Breadth in one number: the capitalisation-weighted return minus the median
// return, over ONE population of assets.
//
// WHAT IT MEASURES. The weighted return is what the market "as a whole" did,
// dominated by its largest assets. The median return is what the typical asset
// did. Their difference, in percentage points, says how narrow the day was:
//
//   spread > 0   the largest assets did better than the typical asset
//   spread < 0   the typical asset did better than the largest assets
//
// WHAT IT DOES NOT MEASURE. It is not a forecast, it is not a count of assets up
// or down (that is the separate up/down breadth figure), and a spread near zero
// does not mean every asset moved alike: two very dispersed halves can still
// share a weighted mean and a median.
//
// ONE POPULATION. Both sides are computed over exactly the same rows. A row with
// no usable return, or with no positive market capitalisation to weigh it by, is
// left out of BOTH sides and counted, because comparing a weighted mean over one
// set of assets with a median over a larger set would measure the difference
// between the two sets rather than the breadth of either. A missing value is
// never read as zero.

export interface BreadthRow { symbol?: unknown; providerId?: unknown; marketCap: unknown; returnPct: unknown }

export interface BreadthWeight { symbol: string | null; providerId: string | null; weightPct: number; returnPct: number }

export interface BreadthSpread {
  /** Sum of weight x return over the included rows, in percent. */
  capWeightedReturnPct: number | null
  /** Median return of the included rows, in percent; the mean of the two middle
   * values when the count is even. */
  medianReturnPct: number | null
  /** capWeightedReturnPct minus medianReturnPct, in percentage points. */
  spreadPts: number | null
  included: number
  excludedNoReturn: number
  excludedNoMarketCap: number
  total: number
  /** The largest weights, heaviest first, so a reader can see what dominates. */
  top: BreadthWeight[]
}

const finite = (value: unknown): number | null => {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
const text = (value: unknown, max: number): string | null => {
  const s = value == null ? '' : String(value).trim()
  return s ? s.slice(0, max) : null
}

/** Median of a numeric sample; null for an empty one. Even counts take the mean
 * of the two middle values. */
export function medianReturn(values: readonly number[]): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b)
  if (!sorted.length) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

export function capWeightedMinusMedian(rows: readonly BreadthRow[] | null | undefined, topCount = 5): BreadthSpread {
  const all = Array.isArray(rows) ? rows : []
  let excludedNoReturn = 0, excludedNoMarketCap = 0
  const used: { row: BreadthRow; cap: number; ret: number }[] = []
  for (const row of all) {
    const ret = finite(row?.returnPct)
    if (ret == null) { excludedNoReturn++; continue }
    const cap = finite(row?.marketCap)
    // A zero or negative capitalisation cannot weigh anything; it is not a tiny
    // weight, it is an absent one.
    if (cap == null || cap <= 0) { excludedNoMarketCap++; continue }
    used.push({ row, cap, ret })
  }
  const empty = { capWeightedReturnPct: null, medianReturnPct: null, spreadPts: null, included: 0, excludedNoReturn, excludedNoMarketCap, total: all.length, top: [] }
  if (!used.length) return empty
  const totalCap = used.reduce((sum, u) => sum + u.cap, 0)
  if (!(totalCap > 0) || !Number.isFinite(totalCap)) return empty
  const weighted = used.reduce((sum, u) => sum + (u.cap / totalCap) * u.ret, 0)
  const median = medianReturn(used.map((u) => u.ret))
  const top = used.slice().sort((a, b) => b.cap - a.cap).slice(0, Math.max(0, topCount)).map((u) => ({
    symbol: text(u.row.symbol, 50), providerId: text(u.row.providerId, 40),
    weightPct: (u.cap / totalCap) * 100, returnPct: u.ret,
  }))
  return {
    capWeightedReturnPct: weighted,
    medianReturnPct: median,
    spreadPts: median == null ? null : weighted - median,
    included: used.length, excludedNoReturn, excludedNoMarketCap, total: all.length, top,
  }
}
