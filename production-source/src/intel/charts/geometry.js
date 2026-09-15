// Shared polar/path helpers. Angles are degrees, 0 at twelve o'clock, growing
// clockwise, so a "clock face" reads the way a reader expects.
const round = n => Math.round(n * 100) / 100

export const polar = (cx, cy, r, deg) => {
  const a = ((Number(deg) || 0) - 90) * Math.PI / 180
  return [round(cx + r * Math.cos(a)), round(cy + r * Math.sin(a))]
}

// Open arc, drawn with a stroke (gauge bands, radial bars).
export function arcStroke(cx, cy, r, a0, a1) {
  const span = a1 - a0
  if (!(Math.abs(span) > 0.01) || !(r > 0)) return ''
  const sweep = span > 0 ? 1 : 0
  const large = Math.abs(span) > 180 ? 1 : 0
  const [x0, y0] = polar(cx, cy, r, a0)
  const [x1, y1] = polar(cx, cy, r, a1)
  return `M ${x0} ${y0} A ${round(r)} ${round(r)} 0 ${large} ${sweep} ${x1} ${y1}`
}

// Filled annulus sector (sunburst rings, polar clock bars). rInner 0 gives a pie
// wedge. A full 360 turn is split so the arc command stays unambiguous.
export function arcPath(cx, cy, rInner, rOuter, a0, a1) {
  const span = a1 - a0
  if (!(Math.abs(span) > 0.01) || !(rOuter > 0)) return ''
  if (Math.abs(span) >= 359.99) {
    const half = a0 + 180
    return `${arcPath(cx, cy, rInner, rOuter, a0, half)} ${arcPath(cx, cy, rInner, rOuter, half, a0 + 360)}`
  }
  const large = Math.abs(span) > 180 ? 1 : 0
  const [x0, y0] = polar(cx, cy, rOuter, a0)
  const [x1, y1] = polar(cx, cy, rOuter, a1)
  if (!(rInner > 0)) return `M ${round(cx)} ${round(cy)} L ${x0} ${y0} A ${round(rOuter)} ${round(rOuter)} 0 ${large} 1 ${x1} ${y1} Z`
  const [x2, y2] = polar(cx, cy, rInner, a1)
  const [x3, y3] = polar(cx, cy, rInner, a0)
  return `M ${x0} ${y0} A ${round(rOuter)} ${round(rOuter)} 0 ${large} 1 ${x1} ${y1} L ${x2} ${y2} A ${round(rInner)} ${round(rInner)} 0 ${large} 0 ${x3} ${y3} Z`
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

// A share of a span that stays 0 (not NaN) when the span is 0 — an all-zero
// series must draw as a flat zero, never as a blank chart.
export const fraction = (value, min, max) => {
  const v = Number(value), lo = Number(min), hi = Number(max)
  if (!Number.isFinite(v) || !Number.isFinite(lo) || !Number.isFinite(hi) || hi === lo) return 0
  return clamp((v - lo) / (hi - lo), 0, 1)
}

// Width an svg <text> run will take, without a DOM to measure with. Inter and
// Geist Mono at the chart size average a little under two thirds of the font
// size per glyph; the estimate rounds up so a label box is never smaller than
// the glyphs inside it and an overlap test cannot pass by underestimating.
export const textWidth = (text, fontSize = 11) => String(text ?? '').length * fontSize * 0.66

// One-dimensional label dodge. Every entry keeps its ideal position unless a
// neighbour is closer than `gap`, in which case the run is spread — forwards
// first, then pulled back off the far edge — and the caller gets its positions
// back in the order it passed them. Sizing the plot from the row count is what
// leaves room for this; the dodge only resolves the ties inside that room.
export function dodge(values = [], { gap = 12, min = -Infinity, max = Infinity } = {}) {
  const items = values
    .map((value, index) => ({ index, value: Number.isFinite(Number(value)) ? Number(value) : 0 }))
    .sort((a, b) => a.value - b.value || a.index - b.index)
  const out = new Array(items.length)
  let previous = -Infinity
  for (const item of items) {
    const y = Math.max(item.value, previous + gap, min)
    out[item.index] = y
    previous = y
  }
  let next = Infinity
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const { index } = items[i]
    const y = Math.min(out[index], next - gap, max)
    out[index] = y
    next = y
  }
  return out
}

export const anchorFor = deg => {
  const [x] = polar(0, 0, 100, deg)
  if (x > 12) return 'start'
  if (x < -12) return 'end'
  return 'middle'
}

export { round }
