import React from 'react'
import { ChartFrame, ChartTable, markProps, useChartText, defaultValueFormat } from './frame'
import { TONES, axisText, gridStroke, useReducedMotion } from './theme'

// Two measurements against each other, on log axes by default because the
// interesting spread in market data is always multiplicative: $50k and $50M of
// liquidity have to be distinguishable in the same picture.
//
// The quadrant dividers are the point of the chart. They are drawn at values
// the caller chooses (not at the data's median), so the four corners keep the
// same meaning as the data moves underneath them.

const W = 440, H = 300
const PAD = { top: 18, right: 18, bottom: 48, left: 66 }
const X0 = PAD.left, X1 = W - PAD.right, Y0 = PAD.top, Y1 = H - PAD.bottom
const PLOT_W = X1 - X0, PLOT_H = Y1 - Y0
const RADIUS = 3.6

const finite = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// A scale is a normaliser (value -> 0..1) plus the ticks to label. Log ticks are
// powers of ten only: a "3.2 x 10^6" gridline reads as noise.
function buildScale(values, { log }) {
  const usable = values.map(finite).filter((v) => v != null && (!log ? true : v > 0))
  if (log) {
    const lo = usable.length ? Math.min(...usable) : 1
    const hi = usable.length ? Math.max(...usable) : 10
    const a = Math.floor(Math.log10(lo > 0 ? lo : 1))
    const b = Math.max(a + 1, Math.ceil(Math.log10(hi > 0 ? hi : 10)))
    const span = b - a
    const step = Math.max(1, Math.ceil(span / 6))
    const ticks = []
    for (let e = a; e <= b; e += step) ticks.push({ value: 10 ** e, at: (e - a) / span })
    const project = (v) => {
      const n = finite(v)
      if (n == null || n <= 0) return 0
      return Math.min(1, Math.max(0, (Math.log10(n) - a) / span))
    }
    return { project, ticks, floor: 10 ** a }
  }
  const lo = Math.min(0, ...(usable.length ? usable : [0]))
  const hiRaw = usable.length ? Math.max(...usable) : 1
  const hi = hiRaw === lo ? lo + 1 : hiRaw
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((at) => ({ value: lo + at * (hi - lo), at }))
  const project = (v) => {
    const n = finite(v)
    if (n == null) return 0
    return Math.min(1, Math.max(0, (n - lo) / (hi - lo)))
  }
  return { project, ticks, floor: lo }
}

export default function Scatter({
  title, description, points = [], xLabel, yLabel, quadrants = null, log = true,
  formatX, formatY, state = 'ready', reason, onSelect,
}) {
  const t = useChartText()
  const reduced = useReducedMotion()
  const fmtX = formatX || defaultValueFormat
  const fmtY = formatY || defaultValueFormat

  const usable = (Array.isArray(points) ? points : []).filter((p) => finite(p?.x) != null && finite(p?.y) != null)
  const qx = quadrants ? finite(quadrants.x) : null
  const qy = quadrants ? finite(quadrants.y) : null
  const labels = Array.isArray(quadrants?.labels) ? quadrants.labels : []

  const xScale = buildScale([...usable.map((p) => p.x), ...(qx == null ? [] : [qx])], { log })
  const yScale = buildScale([...usable.map((p) => p.y), ...(qy == null ? [] : [qy])], { log })
  const px = (v) => X0 + xScale.project(v) * PLOT_W
  const py = (v) => Y1 - yScale.project(v) * PLOT_H

  const resolved = state === 'ready' && !usable.length ? 'empty' : state
  const plotted = usable.map((p, i) => ({
    ...p,
    key: p.key ?? `${p.label ?? 'point'}-${i}`,
    cx: px(p.x),
    cy: py(p.y),
  }))

  return (
    <ChartFrame
      t={t} title={title} description={description} state={resolved} reason={reason}
      plot={{ width: W, height: H }}
      table={
        <ChartTable
          t={t} caption={title}
          columns={[t('charts.legend', { defaultValue: 'Legend' }), xLabel || t('charts.value', { defaultValue: 'Value' }), yLabel || t('charts.value', { defaultValue: 'Value' })]}
          rows={usable.map((p) => [p.label ?? p.key ?? '—', fmtX(p.x), fmtY(p.y)])}
        />
      }
    >
      <svg viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label={`${title}. ${usable.length} ${t('charts.observations', { defaultValue: 'observations' })}. ${xLabel || ''} / ${yLabel || ''}`}>
        {/* axes */}
        <line x1={X0} y1={Y1} x2={X1} y2={Y1} stroke={gridStroke} />
        <line x1={X0} y1={Y0} x2={X0} y2={Y1} stroke={gridStroke} />
        {xScale.ticks.map((tick) => (
          <g key={`x-${tick.value}`}>
            <line x1={X0 + tick.at * PLOT_W} y1={Y1} x2={X0 + tick.at * PLOT_W} y2={Y1 + 4} stroke={gridStroke} />
            <text x={X0 + tick.at * PLOT_W} y={Y1 + 16} textAnchor="middle">{fmtX(tick.value)}</text>
          </g>
        ))}
        {yScale.ticks.map((tick) => (
          <g key={`y-${tick.value}`}>
            <line x1={X0 - 4} y1={Y1 - tick.at * PLOT_H} x2={X0} y2={Y1 - tick.at * PLOT_H} stroke={gridStroke} />
            <text x={X0 - 8} y={Y1 - tick.at * PLOT_H + 4} textAnchor="end">{fmtY(tick.value)}</text>
          </g>
        ))}
        {xLabel ? <text x={X0 + PLOT_W / 2} y={H - 8} textAnchor="middle" className="intel-chart-strong">{xLabel}</text> : null}
        {yLabel ? <text x={12} y={Y0 + PLOT_H / 2} textAnchor="middle" className="intel-chart-strong" transform={`rotate(-90 12 ${Y0 + PLOT_H / 2})`}>{yLabel}</text> : null}

        {/* quadrant dividers, and the name of each corner */}
        {qx == null ? null : <line x1={px(qx)} y1={Y0} x2={px(qx)} y2={Y1} stroke={gridStroke} strokeDasharray="3 4" />}
        {qy == null ? null : <line x1={X0} y1={py(qy)} x2={X1} y2={py(qy)} stroke={gridStroke} strokeDasharray="3 4" />}
        {labels[0] ? <text x={X0 + 6} y={Y0 + 12} textAnchor="start" fill={axisText}>{labels[0]}</text> : null}
        {labels[1] ? <text x={X1 - 6} y={Y0 + 12} textAnchor="end" fill={axisText}>{labels[1]}</text> : null}
        {labels[2] ? <text x={X0 + 6} y={Y1 - 6} textAnchor="start" fill={axisText}>{labels[2]}</text> : null}
        {labels[3] ? <text x={X1 - 6} y={Y1 - 6} textAnchor="end" fill={axisText}>{labels[3]}</text> : null}

        {plotted.map((p) => (
          <circle
            key={p.key}
            {...markProps({ label: `${p.label ?? ''} ${fmtX(p.x)} / ${fmtY(p.y)}`, onActivate: () => onSelect?.(p), reduced })}
            cx={p.cx} cy={p.cy} r={RADIUS} fill={TONES.accent} fillOpacity={0.75} stroke="none"
          >
            <title>{`${p.label ?? ''} · ${fmtX(p.x)} · ${fmtY(p.y)}`}</title>
          </circle>
        ))}
      </svg>
    </ChartFrame>
  )
}
