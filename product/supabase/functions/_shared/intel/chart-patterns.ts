import { normalizeBars, calculateStudy, type Bar } from './chart-analysis.ts'
import { chartStructure, type StructureFinding } from './chart-structure.ts'
import { validateDrawing } from './chart-workspace-contract.ts'

export const PATTERN_VERSION = 'patterns-1'
export type PatternOptions = { at: number; intervalMs: number | null; window?: number; knownOnly?: boolean }
export type PatternRead = { id: string; label: string; t: number; confirmedAt: number; knownAt: number | null; price: number; definition: string; anchors: { t: number; price: number }[]; members: StructureFinding[] }
const known = (bars: Bar[]) => bars.length && bars.every(b => b.recordedAt != null) ? Math.max(...bars.map(b => b.recordedAt!)) : null
const axis = (a: { t: number; price: number }, b: { t: number; price: number }, t: number) => a.price + (b.price - a.price) * (t - a.t) / (b.t - a.t)
const evidenceKnown = (bars: Bar[], pivots: StructureFinding[]) => { const clock=known(bars); return clock!=null&&pivots.every(p=>p.knownAt!=null)?Math.max(clock,...pivots.map(p=>p.knownAt!)):null }
const alternating = (points: StructureFinding[]) => points.every((p, i) => !i || p.kind !== points[i - 1].kind)

/** Bounded, descriptive shape rules. No probabilities, targets, or implicit trades. */
export function shapeCandidates(pivots: StructureFinding[], bars: Bar[], interval: number): PatternRead[] {
  const out: PatternRead[] = []
  for (let i = 4; i < pivots.length; i++) {
    const five = pivots.slice(i - 4, i + 1), [a, b, c, d, e] = five
    if (!alternating(five) || e.t - a.t > 240 * interval) continue
    const inputs = bars.filter(bar => bar.t >= a.t && bar.closedAt! <= e.confirmedAt)
    const emit = (kind: string, label: string, price: number, definition: string, anchors = [b, d]) => out.push({ id: `${kind}:${a.t}:${e.t}`, label, t: a.t, confirmedAt: e.confirmedAt, knownAt: evidenceKnown(inputs, five), price, definition, anchors: anchors.map(p => ({ t: p.t, price: p.price })), members: five })
    const sign = a.kind === 'high' ? 1 : -1
    const [left, valley1, head, valley2, right] = five.map(p => p.price * sign)
    const depth = head - (valley1 + valley2) / 2
    const symmetry = (c.t - a.t) / (e.t - c.t)
    if (depth > 0 && head - Math.max(left, right) >= .1 * depth && Math.abs(left - right) <= .15 * depth && Math.abs(valley1 - valley2) <= .2 * depth && left > valley1 && right > valley2 && symmetry >= 1 / 3 && symmetry <= 3) {
      const neckline = axis(b, d, e.t)
      if (neckline > 0) emit('shoulders', sign === 1 ? 'Head and shoulders candidate' : 'Inverse head and shoulders candidate', neckline,
        'Five alternating confirmed pivots. Head prominence ≥10% of head-to-neckline depth; shoulders differ ≤15% of depth; valleys differ ≤20%; left/right duration ratio is between 1/3 and 3. The line joins the two neckline pivots. This is a shape candidate, not a confirmed breakout or calibrated probability.')
    }
    // Cup-and-handle: the bowl must occupy time, not just a single V-shaped wick.
    if (a.kind === 'high') {
      const depth = (a.price + c.price) / 2 - b.price, width = c.t - a.t, handle = c.price - d.price
      const bowl = inputs.filter(bar => bar.t >= a.t && bar.t <= c.t), floor = bowl.filter(bar => bar.c <= b.price + depth / 3)
      if (depth > 0 && width >= 12 * interval && b.t - a.t >= 3 * interval && c.t - b.t >= 3 * interval && Math.abs(a.price - c.price) <= .15 * depth && handle >= .1 * depth && handle <= .5 * depth && e.t - c.t <= .6 * width && e.price >= c.price - .15 * depth && floor.length >= 3 && floor.at(-1)!.t - floor[0].t >= 2 * interval) {
        emit('cup', 'Cup and handle candidate', c.price,
          'Five alternating confirmed pivots: left rim, bowl, right rim, handle, recovery. Rim difference ≤15% of cup depth; bowl spans ≥12 bars with ≥3 closes in its bottom third; each bowl side spans ≥3 bars. Handle depth is 10–50% of cup depth and duration ≤60% of bowl width. Recovery returns within 15% of depth below the right rim. Shape only; no breakout, buy point or win-rate claim.', [a, c])
      }
    }
    if (i < 5) continue
    const six = pivots.slice(i - 5, i + 1)
    if (!alternating(six) || six.at(-1)!.t - six[0].t > 240 * interval) continue
    const highs = six.filter(p => p.kind === 'high'), lows = six.filter(p => p.kind === 'low')
    if (highs.length !== 3 || lows.length !== 3) continue
    const from = Math.max(highs[0].t, lows[0].t), to = Math.min(highs[2].t, lows[2].t)
    const upperStart = axis(highs[0], highs[2], from), lowerStart = axis(lows[0], lows[2], from), initial = upperStart - lowerStart
    const upperEnd = axis(highs[0], highs[2], to), lowerEnd = axis(lows[0], lows[2], to), end = upperEnd - lowerEnd
    const tolerance = initial * .05
    if (!(initial > 0 && end > 0 && end <= .75 * initial) || highs.some((p, j) => j && p.price > highs[j - 1].price + tolerance) || lows.some((p, j) => j && p.price < lows[j - 1].price - tolerance)) continue
    if (Math.abs(highs[1].price - axis(highs[0], highs[2], highs[1].t)) > .15 * initial || Math.abs(lows[1].price - axis(lows[0], lows[2], lows[1].t)) > .15 * initial) continue
    const flatHigh = Math.abs(highs[2].price - highs[0].price) <= tolerance, flatLow = Math.abs(lows[2].price - lows[0].price) <= tolerance
    const label = flatHigh ? 'Ascending triangle candidate' : flatLow ? 'Descending triangle candidate' : 'Converging triangle candidate'
    const last = six.at(-1)!, triangleBars = bars.filter(bar => bar.t >= six[0].t && bar.closedAt! <= last.confirmedAt)
    out.push({ id: `triangle:${six[0].t}:${last.t}`, label, t: six[0].t, confirmedAt: last.confirmedAt, knownAt: evidenceKnown(triangleBars, six), price: (upperEnd + lowerEnd) / 2,
      anchors: [highs[0], highs[2], lows[0], lows[2]].map(p => ({ t: p.t, price: p.price })), members: six,
      definition: 'Six alternating confirmed pivots: three highs and three lows. Fitted boundaries converge to ≤75% of their initial width and have not crossed. Opposing movement tolerance is 5% of initial width; middle-pivot deviation ≤15%. A boundary changing ≤5% is described as flat. The shape does not predict the breakout direction.' })
  }
  return out.slice(-40)
}

/** Uniform candle-range allocation is an explicit approximation, never trades at price. */
export function candleVolumeProfile(bars: Bar[], count = 20) {
  if (!Number.isInteger(count) || count < 5 || count > 50 || bars.length > 5000) throw Error('invalid_profile_budget')
  const empty = (reason: string) => ({ bins: [], total: 0, poc: null, valueArea: null, unit: null, reason, method: 'Uniform candle-range approximation; not observed trade distribution.' })
  if (!bars.length || bars.some(b => b.o == null || b.h == null || b.l == null || b.v == null || b.volumeKind !== 'period')) return empty('Requires complete OHLC with explicitly non-overlapping period volume. Volume snapshots cannot form a price profile.')
  const units = new Set(bars.map(b => b.volumeUnit || 'asset'))
  if (units.size !== 1) return empty('Volume units must agree across every candle.')
  const low = Math.min(...bars.map(b => b.l!)), high = Math.max(...bars.map(b => b.h!)), total = bars.reduce((sum, b) => sum + b.v!, 0)
  if (!(total > 0) || !Number.isFinite(total)) return empty('No finite positive period volume is available.')
  const size = high === low ? 1 : count, width = (high - low) / size
  const bins = Array.from({ length: size }, (_, i) => ({ id: String(i), low: low + i * width, high: low + (i + 1) * width, volume: 0, fraction: 0 }))
  for (const bar of bars) {
    if (bar.h === bar.l) { bins[Math.max(0, Math.min(size - 1, width ? Math.floor((bar.c - low) / width) : 0))].volume += bar.v!; continue }
    for (const bin of bins) bin.volume += bar.v! * Math.max(0, Math.min(bin.high, bar.h!) - Math.max(bin.low, bar.l!)) / (bar.h! - bar.l!)
  }
  for (const bin of bins) bin.fraction = bin.volume / total
  const poc = bins.reduce((best, bin, i) => bin.volume > bins[best].volume ? i : best, 0)
  let left = poc, right = poc, included = bins[poc].volume
  while (included < total * .7 && (left > 0 || right < size - 1)) {
    if (left > 0 && (right === size - 1 || bins[left - 1].volume >= bins[right + 1].volume)) included += bins[--left].volume
    else included += bins[++right].volume
  }
  return { bins, total, poc: { ...bins[poc], price: (bins[poc].low + bins[poc].high) / 2 }, valueArea: { low: bins[left].low, high: bins[right].high, fraction: included / total }, unit: [...units][0], reason: null,
    method: 'Each candle’s volume is spread uniformly over its low–high range. A flat candle goes into one bin. POC is the largest bin (lower-price tie wins); the contiguous value area grows toward the larger adjacent bin until ≥70% of volume is included. Bin midpoints are approximations, not execution prices.' }
}

export function chartPatterns(input: Bar[], options: PatternOptions) {
  if (!Number.isFinite(options.at)) throw Error('invalid_pattern_time')
  const step = options.intervalMs
  if (!Number.isSafeInteger(step) || step! < 1000) return { version: PATTERN_VERSION, patterns: [], impulse: null, profile: candleVolumeProfile([]), week: null, bars: 0, reason: 'A verified interval is required.' }
  const eligible = normalizeBars(input).bars.filter(b => b.o != null && b.closedAt != null && b.closedAt <= options.at && (!options.knownOnly || b.recordedAt != null && b.recordedAt <= options.at))
  let start = 0
  for (let i = 1; i < eligible.length; i++) if (eligible[i].t - eligible[i - 1].t !== step) start = i
  const bars = eligible.slice(start).slice(-1200), last = bars.at(-1), structure = chartStructure(bars, options)
  // Consecutive same-side pivots collapse to the more extreme one. A wide bar
  // confirmed as both high and low is ambiguous and cannot define a swing order.
  const counts = new Map<number, number>(); for (const p of structure.pivots) counts.set(p.t, (counts.get(p.t) || 0) + 1)
  const pivots: StructureFinding[] = []
  for (const p of structure.pivots.filter(p => counts.get(p.t) === 1)) { const previous = pivots.at(-1); if (previous?.kind === p.kind) { if (p.kind === 'high' ? p.price > previous.price : p.price < previous.price) pivots[pivots.length - 1] = p } else pivots.push(p) }
  const pair = pivots.slice(-2), atr = calculateStudy(bars, { id: 'atr', type: 'atr' }, { intervalMs: step }).series[0]?.points.at(-1)?.value
  const impulse = pair.length === 2 && atr != null && atr > 0 && Math.abs(pair[1].price - pair[0].price) >= 2 * atr ? {
    direction: pair[1].price > pair[0].price ? 'Upward' : 'Downward', anchors: pair.map(p => ({ t: p.t, price: p.price })), confirmedAt: pair[1].confirmedAt, knownAt: evidenceKnown(bars.filter(b => b.t >= pair[0].t && b.closedAt! <= pair[1].confirmedAt), pair),
    levels: [0, .236, .382, .5, .618, .706, .786, 1, 1.618].map(ratio => ({ id: String(ratio), ratio, price: pair[1].price + (pair[0].price - pair[1].price) * ratio })).filter(p => p.price > 0),
    definition: 'Latest two opposing confirmed pivots separated by at least 2 × current ATR(14). Retracement zero is the endpoint; one is the origin. 1.618 extends beyond the origin. These are arithmetic reference levels, not forecasts or recommended orders.' } : null
  let week = null
  if (last) {
    const day = 86400000, monday = (Math.floor(last.t / day) - (new Date(last.t).getUTCDay() + 6) % 7) * day, rows = bars.filter(b => b.t >= monday)
    const first = rows[0], high = Math.max(...rows.map(b => b.h!)), low = Math.min(...rows.map(b => b.l!)), open = first.o!, close = last.c, range = high - low
    week = { from: first.t, to: last.closedAt!, price: close, knownAt: known(rows), bars: rows.length, partial: first.t !== monday || rows.some(b => b.closedAt !== b.t + step! - 1),
      day: new Date(last.t).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long' }), bodyPct: (close - open) / open * 100, wickFraction: range > 0 ? Math.max(0, range - Math.abs(close - open)) / range : null,
      definition: 'Describes only the loaded portion of the current Monday–Sunday UTC week: open-to-close change and combined wick/range fraction. An incomplete start is explicitly partial. Day of week is calendar context, not an accumulation/distribution phase or a predictive cycle.' }
  }
  return { version: PATTERN_VERSION, patterns: shapeCandidates(pivots, bars, step!), impulse, profile: candleVolumeProfile(bars), week, bars: bars.length,
    reason: 'Heuristic candidates from at most 1,200 completed, contiguous OHLC bars. Pivot confirmation uses only closed right-hand bars. Missing observations reset the candidate window. No win rates, confidence grades or trade-side volume are inferred.' }
}

export function patternDrawing(read: PatternRead, id: string, source: string) {
  return validateDrawing({ id, tool: 'text', anchors: [{ t: read.t, price: read.price }], text: `${read.label}. ${PATTERN_VERSION}. Confirmed ${new Date(read.confirmedAt).toISOString()}. Source: ${source.slice(0, 120)}. ${read.definition} Pivots: ${read.members.map(p => `${p.kind} ${p.price} at ${new Date(p.t).toISOString()}`).join('; ')}`, color: '#DFA647', width: 1 })
}
