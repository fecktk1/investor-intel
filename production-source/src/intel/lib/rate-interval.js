// Intervals on quoted rates.
//
// A hit rate or win rate printed alone reads as more certain than it is: 3 wins
// out of 4 and 750 out of 1,000 are both "75%". Every quoted rate therefore
// carries a Wilson score interval at 95% and the sample it was measured on.
//
// WHY WILSON. The textbook normal interval (p plus or minus z times the standard
// error) collapses to zero width at 0% and 100% and leaves [0, 1] for small n,
// which is exactly where a journal lives. The Wilson score interval stays inside
// [0, 1], is never zero width, and has close to nominal coverage at small n.
//
// NO SAMPLE, NO INTERVAL. n = 0 is not a 0% rate with a wide interval; it is no
// measurement, and the caller renders nothing. A sample below SMALL_SAMPLE is
// labelled so, because an interval that wide is itself the finding.

export const Z95 = 1.959963984540054
export const SMALL_SAMPLE = 30

const count = value => {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 ? n : null
}

/** Wilson score interval for `successes` out of `n`. Returns null when there is
 *  no sample or the counts are not a valid pair of whole numbers. Bounds are
 *  fractions in [0, 1]. */
export function wilsonInterval(successes, n, z = Z95) {
  const k = count(successes), total = count(n)
  if (k == null || total == null || total === 0 || k > total || !(z > 0)) return null
  const p = k / total
  const z2 = z * z
  const denominator = 1 + z2 / total
  const centre = (p + z2 / (2 * total)) / denominator
  const half = (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denominator
  // At 0% and 100% the bound on that side is exactly 0 or 1; computing it leaves
  // floating-point dust. Elsewhere the interval is inside [0, 1] by construction.
  return {
    rate: p,
    low: k === 0 ? 0 : Math.max(0, centre - half),
    high: k === total ? 1 : Math.min(1, centre + half),
    n: total,
    successes: k,
    small: total < SMALL_SAMPLE,
  }
}

/** A pooled base rate over several groups of {successes, n}. Groups with an
 *  unreadable count are skipped rather than read as zero. */
export function pooledRate(groups = []) {
  let k = 0, total = 0
  for (const group of Array.isArray(groups) ? groups : []) {
    const s = count(group?.successes), n = count(group?.n)
    if (s == null || n == null || s > n) continue
    k += s
    total += n
  }
  return total > 0 ? { rate: k / total, successes: k, n: total } : null
}

/** Percent text for a fraction, one decimal. */
export const percentText = fraction => (fraction == null || !Number.isFinite(Number(fraction)) ? null : `${(Number(fraction) * 100).toFixed(1)}%`)
