import { assert, assertEquals as eq, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { chartResearchRead, chartReadDrawing, explainChartLevel } from './chart-read.ts'
const t = Date.UTC(2026, 8, 1), step = 3600000
const bars = Array.from({ length: 240 }, (_, i) => { const c = 100 + 10 * Math.sin(i * Math.PI / 12); return { t: t + i * step, closedAt: t + (i + 1) * step - 1, recordedAt: t + (i + 1) * step, o: c - .1, h: c + .5, l: c - .5, c, v: 100, volumeKind: 'snapshot' as const, volumeUnit: 'USD' as const } })
const options = { at: t + 240 * step, intervalMs: step, window: 2 }
Deno.test('annotated scenarios use exact surrounding confirmed zone boundaries and never create targets or orders', () => {
  const read = chartResearchRead(bars, options); eq(read.scenarios.map(s => s.available), [true, true, true])
  const support = read.levels.find(l => l!.label === 'Support zone')!, resistance = read.levels.find(l => l!.label === 'Resistance zone')!
  eq(read.scenarios[0].trigger, resistance.upper); eq(read.scenarios[0].invalidation, resistance.lower); eq(read.scenarios[2].trigger, support.lower)
  assert(read.scenarios[0].criterion.includes(String(resistance.upper))); eq('target' in read.scenarios[0], false); eq('positionSize' in read.scenarios[0], false)
})
Deno.test('per-indicator readings and drill-ins preserve warmup and incompatible source-volume explanations', () => {
  const read = chartResearchRead(bars, options); eq(read.studies.length, 7)
  const rsi = read.studies.find(s => s.id === 'rsi')!; assert(rsi.readings[0].value! >= 0 && rsi.readings[0].value! <= 100); eq(rsi.readings[0].points.length, 20)
  const vwap = read.studies.find(s => s.id === 'vwap')!; assert(vwap.reason!.includes('volume snapshots')); eq(vwap.readings, [])
  const early = chartResearchRead(bars.slice(0, 10), options); assert(early.studies.find(s => s.id === 'dema')!.reason!.includes('85'))
})
Deno.test('neutral and conditional reads become private drawing annotations without changing the input data', () => {
  const read = chartResearchRead(bars, options), original = JSON.stringify(read)
  for (const mode of ['neutral', 'bull', 'base', 'bear']) {
    const note = chartReadDrawing(read, 'd204aaf9-ef74-4f93-a1c3-936d2c4be4f1', mode, 'Synthetic golden fixture')
    eq(note.tool, 'text'); eq(note.anchors[0], { t: bars.at(-1)!.t, price: bars.at(-1)!.c }); assert(note.text.includes('read-1')); assert(note.text.includes('Synthetic golden fixture'))
  }
  eq(JSON.stringify(read), original); assertThrows(() => chartReadDrawing(read, 'd204aaf9-ef74-4f93-a1c3-936d2c4be4f1', 'unknown', 'Fixture'))
})
Deno.test('level explanations retain literal prices, exact pivot evidence and confirmation time', () => {
  const read = chartResearchRead(bars, options), level = read.levels[0]!, explanation = explainChartLevel(level, read.last!, 'CMC hourly fixture')
  assert(explanation.includes(String(level.lower))); assert(explanation.includes(String(read.last!.c))); assert(explanation.includes(new Date(level.confirmedAt).toISOString())); assert(explanation.includes('not reliability odds'))
})
Deno.test('replaying complete history equals its available prefix and late observations remain excluded', () => {
  const at = bars[199].recordedAt, opts = { ...options, at, knownOnly: true }
  eq(chartResearchRead(bars, opts), chartResearchRead(bars.slice(0, 200), opts))
  const late = bars.map((b, i) => i === 199 ? { ...b, recordedAt: options.at + 1 } : b)
  eq(chartResearchRead(late, opts).last!.t, bars[198].t)
})
Deno.test('gaps reset warmup and unknown intervals or missing price history remain unavailable', () => {
  const read = chartResearchRead([...bars.slice(0, 238), bars[239]], options); assert(read.studies.find(s => s.id === 'dema')!.reason!.includes('85')); eq(read.scenarios.every(s => !s.available), true)
  eq(chartResearchRead(bars, { ...options, intervalMs: null }).last, null); eq(chartResearchRead([], options).last, null)
  assertThrows(() => chartResearchRead(bars, { ...options, at: NaN })); assertThrows(() => chartReadDrawing(read, 'd204aaf9-ef74-4f93-a1c3-936d2c4be4f1', 'bull', 'Fixture'))
})
