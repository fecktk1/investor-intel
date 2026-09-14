import { assert, assertEquals as eq, assertAlmostEquals as near, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { chartPatterns, candleVolumeProfile, patternDrawing } from './chart-patterns.ts'
import type { Bar } from './chart-analysis.ts'
const t = Date.UTC(2026, 8, 7), step = 3600000
function path(vertices: number[][]): Bar[] {
  const out: Bar[] = []
  for (let i = 0; i <= vertices.at(-1)![0]; i++) {
    const next = vertices.findIndex(p => p[0] >= i), [x, y] = vertices[Math.max(0, next - 1)], [x2, y2] = vertices[next]
    const c = x2 === x ? y : y + (y2 - y) * (i - x) / (x2 - x)
    out.push({ t: t + i * step, closedAt: t + (i + 1) * step - 1, recordedAt: t + (i + 1) * step, o: c, h: c + .2, l: c - .2, c, v: 100, volumeKind: 'period' })
  }
  return out
}
const shoulders = path([[0, 100], [4, 110], [8, 100], [12, 120], [16, 100], [20, 111], [24, 98]])
const opts = { at: t + 100 * step, intervalMs: step, window: 1 }
Deno.test('golden OHLC shoulders fixture needs the final confirming close and retains all five pivot clocks', () => {
  const r = chartPatterns(shoulders, opts), read = r.patterns.find(p => p.label === 'Head and shoulders candidate')!
  assert(read); eq(read.members.map(p => p.t), [4, 8, 12, 16, 20].map(i => t + i * step)); near(read.price, 99.8)
  eq(read.confirmedAt, t + 22 * step - 1); eq(chartPatterns(shoulders, { ...opts, at: read.confirmedAt - 1 }).patterns.length, 0)
  eq(read.knownAt, t + 22 * step)
  const inverse = shoulders.map(b => ({ ...b, o: 250 - b.o!, h: 250 - b.l!, l: 250 - b.h!, c: 250 - b.c }))
  assert(chartPatterns(inverse, opts).patterns.some(p => p.label === 'Inverse head and shoulders candidate'))
})
Deno.test('golden triangle fixture exposes converging boundaries without a predicted breakout', () => {
  const r = chartPatterns(path([[0, 100], [4, 120], [8, 90], [12, 115], [16, 95], [20, 110], [24, 100], [28, 105]]), opts)
  const read = r.patterns.find(p => p.label === 'Converging triangle candidate')!; assert(read); eq(read.anchors.length, 4); eq(read.members.length, 6)
  assert(read.definition.includes('does not predict'))
  const widening = chartPatterns(path([[0, 100], [4, 110], [8, 95], [12, 115], [16, 90], [20, 120], [24, 85], [28, 105]]), opts)
  eq(widening.patterns.some(p => p.label.includes('triangle')), false)
})
Deno.test('golden cup-and-handle fixture requires a time-extended bowl and a shallow handle', () => {
  const bowl = path([[0, 110], [4, 120], [8, 106], [10, 100], [12, 99], [14, 100], [16, 106], [20, 120], [24, 113], [28, 120], [32, 110]])
  assert(chartPatterns(bowl, opts).patterns.some(p => p.label === 'Cup and handle candidate'))
  const v = path([[0, 110], [4, 120], [5, 99], [6, 120], [7, 113], [8, 120], [10, 110]])
  eq(chartPatterns(v, opts).patterns.some(p => p.label.includes('Cup')), false)
})
Deno.test('flat, monotonic and equal-extreme adversarial bars cannot fabricate a chart pattern', () => {
  for (const rows of [path([[0, 100], [99, 100]]), path([[0, 100], [99, 200]]), path([[0, 200], [99, 100]])]) eq(chartPatterns(rows, opts).patterns, [])
  eq(chartPatterns(shoulders.map(b => ({ ...b, h: 130, l: 90 })), opts).patterns, [])
})
Deno.test('missing prices and late capture clocks never join patterns across missing evidence', () => {
  eq(chartPatterns(shoulders.filter((_b, i) => i !== 15), opts).patterns, [])
  const late = shoulders.map((b, i) => i === 19 ? { ...b, recordedAt: opts.at + 1 } : b)
  eq(chartPatterns(late, { ...opts, knownOnly: true }).patterns, [])
  const retrospective = chartPatterns(late, opts).patterns[0]; eq(retrospective.knownAt, opts.at + 1)
  for (let i = 1; i < shoulders.length; i++) {
    const options = { ...opts, at: shoulders[i].recordedAt!, knownOnly: true }
    eq(chartPatterns(shoulders, options), chartPatterns(shoulders.slice(0, i + 1), options))
  }
})
Deno.test('impulse retracements retain opposing pivots and independent endpoint arithmetic', () => {
  const result = chartPatterns(shoulders, opts), impulse = result.impulse!; assert(impulse)
  eq(impulse.anchors.map(p => p.t), [t + 16 * step, t + 20 * step]); near(impulse.levels[0].price, 111.2)
  near(impulse.levels.find(p => p.ratio === .5)!.price, (99.8 + 111.2) / 2); near(impulse.levels.find(p => p.ratio === 1)!.price, 99.8)
  eq(chartPatterns(path([[0, 100], [99, 100]]), opts).impulse, null)
})
Deno.test('profile conserves independently known candle volume and declares deterministic value-area ties', () => {
  const rows: Bar[] = [{ t, o: 15, h: 20, l: 10, c: 15, v: 100, volumeKind: 'period' }]
  const result = candleVolumeProfile(rows, 5); eq(result.bins.map(b => b.volume), [20, 20, 20, 20, 20]); eq(result.total, 100)
  eq(result.poc?.price, 11); eq(result.valueArea, { low: 10, high: 18, fraction: .8 })
  const flat = candleVolumeProfile([{ ...rows[0], o: 12, h: 12, l: 12, c: 12 }]); eq(flat.bins.length, 1); eq(flat.bins[0].volume, 100); eq(flat.poc?.price, 12)
  const mixed = candleVolumeProfile([...rows, { ...rows[0], t: t + step, o: 12, h: 12, l: 12, c: 12, v: 50 }], 5)
  near(mixed.bins.reduce((s, b) => s + b.volume, 0), 150); eq(mixed.poc?.low, 12)
})
Deno.test('snapshot, absent, mixed-unit and zero volume remain unavailable instead of fake distributions', () => {
  eq(candleVolumeProfile(shoulders.map(b => ({ ...b, volumeKind: 'snapshot' }))).bins, [])
  eq(candleVolumeProfile(shoulders.map(b => ({ ...b, volumeKind: undefined }))).bins, [])
  eq(candleVolumeProfile(shoulders.map(b => ({ ...b, v: 0 }))).bins, [])
  eq(candleVolumeProfile(shoulders.map((b, i) => ({ ...b, volumeUnit: i % 2 ? 'USD' : undefined }))).bins, [])
  assertThrows(() => candleVolumeProfile(shoulders, 1000))
})
Deno.test('weekly description labels partial starts, zero-range wicks and real calendar context', () => {
  const r = chartPatterns(shoulders, opts); eq(r.week?.partial, false); eq(r.week?.day, 'Tuesday'); near(r.week!.bodyPct, -2)
  eq(chartPatterns(shoulders.slice(2), opts).week?.partial, true)
  const flat = shoulders.map(b => ({ ...b, o: 100, h: 100, l: 100, c: 100 })); eq(chartPatterns(flat, opts).week?.wickFraction, null)
})
Deno.test('kept patterns are bounded validated notes with exact evidence and no confidence claim', () => {
  const read = chartPatterns(shoulders, opts).patterns[0], drawing = patternDrawing(read, 'd204aaf9-ef74-4f93-a1c3-936d2c4be4f1', 'Synthetic golden fixture')
  eq(drawing.tool, 'text'); eq(drawing.anchors[0], { t: read.t, price: read.price }); assert(drawing.text.includes('patterns-1')); assert(drawing.text.includes('Pivots:'))
  eq(chartPatterns(shoulders, { ...opts, intervalMs: null }).patterns, []); assertThrows(() => chartPatterns(shoulders, { ...opts, at: NaN }))
})
