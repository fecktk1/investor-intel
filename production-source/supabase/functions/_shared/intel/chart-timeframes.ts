import { normalizeBars, calculateStudy, type Bar } from './chart-analysis.ts'

export const ALIGNMENT_VERSION = 'alignment-1'
const HOUR = 3600000, DAY = 24 * HOUR, WEEK = 7 * DAY
export type AlignmentOptions = { at: number; intervalMs: number | null; knownOnly?: boolean }
const lastSegment = (bars: Bar[], step: number) => {
  let start = 0
  for (let i = 1; i < bars.length; i++) if (bars[i].t - bars[i - 1].t !== step) start = i
  return bars.slice(start)
}
const frameName = (step: number) => step === WEEK ? '1 week' : step >= DAY ? `${step / DAY} day` : step >= HOUR ? `${step / HOUR} hour` : `${step / 60000} min`

/** Larger UTC bars are allowed only when every source period is explicitly
 * bounded and present. Missing/in-progress periods are never synthesized. */
export function aggregateCompletedBars(input: Bar[], base: number, target: number, at: number) {
  if (!Number.isSafeInteger(base) || base < 1000 || !Number.isSafeInteger(target) || target < base || target % base) throw Error('invalid_alignment_interval')
  const eligible = normalizeBars(input).bars.filter(b => b.closedAt != null && b.closedAt <= at)
  if (target === base) return { bars: eligible, omitted: input.length - eligible.length, reason: null }
  if (eligible.some(b => b.closedAt !== b.t + base - 1 || b.o == null)) return { bars: [], omitted: eligible.length, reason: 'Larger candles require explicit source period boundaries and complete OHLC.' }
  const offset = target === WEEK ? 4 * DAY : 0 // Monday 00:00 UTC.
  const groups = new Map<number, Bar[]>()
  for (const b of eligible) { const t = Math.floor((b.t - offset) / target) * target + offset; const group = groups.get(t) || []; group.push(b); groups.set(t, group) }
  const bars: Bar[] = []; let omitted = 0
  for (const [t, group] of groups) {
    if (t + target > at || group.length !== target / base || group.some((b, i) => b.t !== t + i * base)) { omitted += group.length; continue }
    const snapshot = group.some(b => b.volumeKind === 'snapshot'), period = group.every(b => b.volumeKind === 'period')
    const v = snapshot ? group.at(-1)!.v : period && group.every(b => b.v != null) ? group.reduce((sum, b) => sum + b.v!, 0) : null
    bars.push({ t, closedAt: t + target - 1, o: group[0].o, h: Math.max(...group.map(b => b.h!)), l: Math.min(...group.map(b => b.l!)), c: group.at(-1)!.c, v,
      ...(snapshot ? { volumeKind: 'snapshot' as const } : period ? { volumeKind: 'period' as const } : {}),
      ...(group.every(b => b.volumeUnit === 'USD') ? { volumeUnit: 'USD' as const } : {}),
      ...(group.every(b => b.recordedAt != null) ? { recordedAt: Math.max(...group.map(b => b.recordedAt!)) } : {}) })
  }
  return { bars, omitted, reason: null }
}

export function chartTimeframeAlignment(input: Bar[], options: AlignmentOptions) {
  if (!Number.isFinite(options.at)) throw Error('invalid_alignment_time')
  const base = options.intervalMs
  if (!Number.isSafeInteger(base) || base! < 1000) return { version: ALIGNMENT_VERSION, rows: [], agreement: 'Unavailable', covered: 0, reason: 'A verified base interval is required.' }
  const eligible = normalizeBars(input).bars.filter(b => b.closedAt != null && b.closedAt <= options.at && (!options.knownOnly || b.recordedAt != null && b.recordedAt <= options.at))
  const frames = [...new Set([base!, ...[15 * 60000, HOUR, 4 * HOUR, DAY, WEEK].filter(n => n > base! && n % base! === 0)])].slice(0, 4)
  const rows = frames.map(interval => {
    const aggregate = aggregateCompletedBars(eligible, base!, interval, options.at), bars = lastSegment(aggregate.bars, interval), last = bars.at(-1)
    const read = (type: string, params = {}) => calculateStudy(bars, { id: type, type, params }, {intervalMs:interval})
    const dema = read('dema', { period: 43 }), rsi = read('rsi', { period: 14 }), atr = read('atr', { period: 14 }), vwap = read('vwap')
    const latest = (result: ReturnType<typeof read>) => { const point=result.series[0]?.points.at(-1);return point?.t===last?.t?point?.value??null:null }
    const average = latest(dema), momentum = latest(rsi), volatility = latest(atr), weighted = latest(vwap)
    const delta = last && average != null ? last.c - average : null
    const epsilon = Math.max(Math.abs(last?.c || 0), Math.abs(average || 0)) * Number.EPSILON * 64
    const trend = !last || average == null ? 'Unavailable' : delta! > epsilon ? 'Above DEMA' : delta! < -epsilon ? 'Below DEMA' : 'At DEMA'
    const stretch = last && average != null && volatility != null && volatility > 0 ? (last.c - average) / volatility : null
    const state = !last || average == null || momentum == null ? 'Unavailable' : delta! > epsilon && momentum > 50 ? 'Upward agreement' : delta! < -epsilon && momentum < 50 ? 'Downward agreement' : 'Mixed / neutral'
    return { id: String(interval), intervalMs: interval, label: frameName(interval), sourceTime:last?.t ?? null, bars: bars.length, lastClose: last?.c ?? null, at: last?.closedAt ?? null,
      knownAt: bars.length && bars.every(b => b.recordedAt != null) ? Math.max(...bars.map(b => b.recordedAt!)) : null,
      dema: average, rsi: momentum, atr: volatility, vwap: weighted, trend, state, stretchAtr: stretch,
      vwapState: weighted == null || !last ? 'Unavailable' : last.c > weighted ? 'Above UTC VWAP' : last.c < weighted ? 'Below UTC VWAP' : 'At UTC VWAP',
      gaps: [aggregate.reason, !last ? 'No complete periods.' : null, bars.length < 85 ? `DEMA(43) needs 85 contiguous closes; ${bars.length} are available.` : null, vwap.reason, ...(aggregate.omitted ? [`${aggregate.omitted} source bars excluded from incomplete periods.`] : [])].filter(Boolean),
      criteria: 'Upward agreement: close > DEMA(43) and RSI(14) > 50. Downward agreement: both inequalities reverse. A close at/crossing DEMA or RSI at/crossing 50 ends that agreement; mixed states remain explicit. Stretch is (close − DEMA) / Wilder ATR(14). DEMA equality allows 64 machine-epsilon units to suppress floating-point noise. VWAP is a UTC-session candle approximation, shown only with compatible asset-unit period volume.' }
  })
  const covered = rows.filter(r => r.state !== 'Unavailable'), up = covered.filter(r => r.state === 'Upward agreement').length, down = covered.filter(r => r.state === 'Downward agreement').length
  const agreement = covered.length < 2 ? 'Insufficient timeframe coverage' : up === covered.length ? 'Upward agreement across covered frames' : down === covered.length ? 'Downward agreement across covered frames' : 'Timeframes disagree or are neutral'
  return { version: ALIGNMENT_VERSION, rows, covered: covered.length, agreement, reason: 'Descriptive states from available completed bars, not trade recommendations or calibrated odds. Higher frames reuse verified source periods; no provider call is made. Each frame retains its own latest close time.' }
}
