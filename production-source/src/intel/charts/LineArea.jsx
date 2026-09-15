import React from 'react'
import { ChartFrame, ChartLegend, ChartTable, markProps, useChartText, defaultValueFormat, defaultTimeFormat } from './frame'
import { TONES, gridStroke, toneColor, useReducedMotion } from './theme'

// One measurement over time as a line, with a second measurement underneath it
// as a faint area, plus named time spans and single moments marked on the same
// axis. Built for a price series carrying its volume, its deepest decline and
// the moment it recovered — but it knows nothing about prices: the caller names
// both series and every span.
//
// The area is deliberately confined to the bottom third of the plot. A volume
// series shares the time axis with price but not its scale, and stacking the two
// full height would invite reading one against the other.

const W = 520, H = 300
const PAD = { top: 16, right: 18, bottom: 46, left: 66 }
const X0 = PAD.left, X1 = W - PAD.right, Y0 = PAD.top, Y1 = H - PAD.bottom
const PLOT_W = X1 - X0, PLOT_H = Y1 - Y0
const SECONDARY_H = PLOT_H * 0.34

const finite = v => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const round = n => Math.round(n * 100) / 100

export default function LineArea({
  title, description, points = [], spans = [], marks = [],
  valueLabel, secondaryLabel, formatValue, formatSecondary, formatTime,
  tableColumns, tableRows, state = 'ready', reason, onSelect,
}) {
  const t = useChartText()
  const reduced = useReducedMotion()
  const fmtValue = formatValue || defaultValueFormat
  const fmtSecondary = formatSecondary || defaultValueFormat
  const fmtTime = formatTime || defaultTimeFormat

  // A point without a finite time or a finite value is not an observation. A
  // zero value is one, and is kept.
  const usable = (Array.isArray(points) ? points : [])
    .map(point => ({ ...point, t: finite(point?.t), value: finite(point?.value), secondary: finite(point?.secondary) }))
    .filter(point => point.t != null && point.value != null)
    .sort((a, b) => a.t - b.t)

  const t0 = usable.length ? usable[0].t : 0
  const t1 = usable.length ? usable[usable.length - 1].t : 1
  const px = time => {
    const n = finite(time)
    if (n == null || t1 === t0) return X0
    return X0 + Math.min(1, Math.max(0, (n - t0) / (t1 - t0))) * PLOT_W
  }

  const values = usable.map(point => point.value)
  const lo = values.length ? Math.min(...values) : 0
  const hi = values.length ? Math.max(...values) : 1
  // A flat series still needs a band to sit in, or it would draw on the axis.
  const headroom = hi === lo ? (Math.abs(hi) * 0.05 || 1) : (hi - lo) * 0.06
  const yLo = lo - headroom, yHi = hi + headroom
  const py = value => {
    const n = finite(value)
    if (n == null || yHi === yLo) return Y1
    return Y1 - Math.min(1, Math.max(0, (n - yLo) / (yHi - yLo))) * PLOT_H
  }

  const secondaryMax = Math.max(0, ...usable.map(point => point.secondary ?? 0))
  const psy = value => {
    const n = finite(value)
    if (n == null || secondaryMax <= 0) return Y1
    return Y1 - Math.min(1, Math.max(0, n / secondaryMax)) * SECONDARY_H
  }

  const line = usable.map((point, i) => `${i === 0 ? 'M' : 'L'} ${round(px(point.t))} ${round(py(point.value))}`).join(' ')
  const area = usable.length && secondaryMax > 0
    ? `M ${round(px(usable[0].t))} ${round(Y1)} ${usable.map(point => `L ${round(px(point.t))} ${round(psy(point.secondary))}`).join(' ')} L ${round(px(usable.at(-1).t))} ${round(Y1)} Z`
    : ''

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(at => ({ at, value: yLo + at * (yHi - yLo) }))
  const xTicks = usable.length
    ? [0, 0.5, 1].map(at => ({ at, value: t0 + at * (t1 - t0) }))
    : []

  const drawnSpans = (Array.isArray(spans) ? spans : [])
    .map((span, index) => ({ ...span, index, from: finite(span?.from), to: finite(span?.to) }))
    .filter(span => span.from != null && span.to != null && span.to >= span.from)
  const drawnMarks = (Array.isArray(marks) ? marks : [])
    .map((mark, index) => ({ ...mark, index, t: finite(mark?.t) }))
    .filter(mark => mark.t != null)

  const resolved = state === 'ready' && !usable.length ? 'empty' : state
  const defaultColumns = [
    t('charts.time', { defaultValue: 'Time' }),
    valueLabel || t('charts.value', { defaultValue: 'Value' }),
    secondaryLabel || t('charts.value', { defaultValue: 'Value' }),
  ]
  const defaultRows = usable.map(point => [fmtTime(point.t), fmtValue(point.value), point.secondary == null ? '—' : fmtSecondary(point.secondary)])

  return (
    <ChartFrame
      t={t} title={title} description={description} state={resolved} reason={reason}
      plot={{ width: W, height: H }}
      legend={
        <ChartLegend t={t} items={[
          { key: 'value', color: TONES.accent, label: valueLabel || t('charts.value', { defaultValue: 'Value' }), value: usable.length ? fmtValue(usable.at(-1).value) : null },
          ...(secondaryMax > 0 ? [{ key: 'secondary', color: TONES.blue, label: secondaryLabel || t('charts.value', { defaultValue: 'Value' }), value: fmtSecondary(secondaryMax) }] : []),
          ...drawnSpans.map(span => ({ key: `span-${span.index}`, color: toneColor(span.tone), label: span.label, value: span.value == null ? null : fmtValue(span.value) })),
          ...drawnMarks.map(mark => ({ key: `mark-${mark.index}`, color: toneColor(mark.tone), label: mark.label, value: fmtTime(mark.t) })),
        ].filter(item => item.label)} />
      }
      table={<ChartTable t={t} caption={title} columns={tableColumns || defaultColumns} rows={tableRows || defaultRows} />}
    >
      <svg viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label={`${title}. ${usable.length} ${t('charts.time', { defaultValue: 'Time' })}. ${t('charts.show_as_table', { defaultValue: 'Show as table' })}`}>
        <line x1={X0} y1={Y1} x2={X1} y2={Y1} stroke={gridStroke} />
        <line x1={X0} y1={Y0} x2={X0} y2={Y1} stroke={gridStroke} />
        {yTicks.map(tick => (
          <g key={`y-${tick.at}`}>
            <line x1={X0 - 4} y1={Y1 - tick.at * PLOT_H} x2={X0} y2={Y1 - tick.at * PLOT_H} stroke={gridStroke} />
            <text x={X0 - 8} y={Y1 - tick.at * PLOT_H + 4} textAnchor="end">{fmtValue(tick.value)}</text>
          </g>
        ))}
        {xTicks.map(tick => (
          <g key={`x-${tick.at}`}>
            <line x1={X0 + tick.at * PLOT_W} y1={Y1} x2={X0 + tick.at * PLOT_W} y2={Y1 + 4} stroke={gridStroke} />
            <text x={X0 + tick.at * PLOT_W} y={Y1 + 18} textAnchor={tick.at === 0 ? 'start' : tick.at === 1 ? 'end' : 'middle'}>{fmtTime(tick.value)}</text>
          </g>
        ))}

        {/* The spans sit under the line: they are context for it, not a mark on it. */}
        {drawnSpans.map(span => (
          <rect
            key={`span-${span.index}`}
            {...markProps({ label: `${span.label ?? ''} ${fmtTime(span.from)} – ${fmtTime(span.to)}`, onActivate: () => onSelect?.(span), reduced })}
            x={round(px(span.from))} y={Y0} width={Math.max(1, round(px(span.to) - px(span.from)))} height={PLOT_H}
            fill={toneColor(span.tone)} fillOpacity={0.14} stroke={toneColor(span.tone)} strokeOpacity={0.4} strokeWidth="1"
          >
            <title>{`${span.label ?? ''} · ${fmtTime(span.from)} – ${fmtTime(span.to)}`}</title>
          </rect>
        ))}

        {area ? <path d={area} fill={TONES.blue} fillOpacity={0.16} stroke="none" pointerEvents="none" /> : null}
        {line ? <path d={line} fill="none" stroke={TONES.accent} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" pointerEvents="none" /> : null}

        {drawnMarks.map(mark => (
          <g key={`mark-${mark.index}`}
            {...markProps({ label: `${mark.label ?? ''} ${fmtTime(mark.t)}`, onActivate: () => onSelect?.(mark), reduced })}>
            <line x1={round(px(mark.t))} y1={Y0} x2={round(px(mark.t))} y2={Y1} stroke={toneColor(mark.tone)} strokeWidth="1" strokeDasharray="3 4" />
            <circle cx={round(px(mark.t))} cy={Y0 + 5} r="3.4" fill={toneColor(mark.tone)} />
            <title>{`${mark.label ?? ''} · ${fmtTime(mark.t)}`}</title>
          </g>
        ))}
      </svg>
    </ChartFrame>
  )
}
