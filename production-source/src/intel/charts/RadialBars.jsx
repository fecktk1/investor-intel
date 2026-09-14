import React from 'react'
import { ChartFrame, ChartLegend, ChartTable, markProps, useChartText, defaultValueFormat } from './frame'
import { toneColor, trackStroke, seriesColor, useReducedMotion } from './theme'
import { arcStroke, fraction } from './geometry'

const CX = 140, CY = 140, R_OUTER = 116, STEP = 22, BAND = 13, A0 = -135, A1 = 135

// Concentric arcs, one per series, outer to inner. The label rows beside the
// ring carry the same values; activating an arc calls onSelect(series).
export default function RadialBars({ title, description, series = [], formatValue, state = 'ready', reason, onSelect }) {
  const t = useChartText()
  const reduced = useReducedMotion()
  const fmt = formatValue || defaultValueFormat
  const rows = series.map((s, i) => {
    const max = Number.isFinite(Number(s?.max)) ? Number(s.max) : 100
    return { ...s, index: i, radius: Math.max(16, R_OUTER - i * STEP), max, share: fraction(s?.value, 0, max), color: s?.tone ? toneColor(s.tone) : seriesColor(i) }
  })

  return (
    <ChartFrame
      t={t} title={title} description={description} state={state} reason={reason}
      legend={<ChartLegend t={t} items={rows.map(r => ({ key: r.key ?? r.index, color: r.color, label: r.label, value: fmt(r.value) }))} />}
      table={
        <ChartTable
          t={t} caption={title}
          columns={[t('charts.legend', { defaultValue: 'Legend' }), t('charts.value', { defaultValue: 'Value' }), t('charts.share', { defaultValue: 'Share' })]}
          rows={rows.map(r => [r.label ?? r.key ?? '—', fmt(r.value), `${(r.share * 100).toFixed(1)}%`])}
        />
      }
    >
      <svg viewBox="0 0 280 280" role="img"
        aria-label={`${title}. ${rows.map(r => `${r.label}: ${fmt(r.value)}`).join('. ')}`}>
        {rows.map(r => (
          <g key={r.key ?? r.index}>
            {/* The track carries the interaction so a zero-value series stays
                reachable by pointer and keyboard. */}
            <path
              {...markProps({ label: `${r.label ?? ''} ${fmt(r.value)}`, onActivate: () => onSelect?.(r), reduced })}
              d={arcStroke(CX, CY, r.radius, A0, A1)} fill="none" stroke={trackStroke} strokeWidth={BAND}
            >
              <title>{`${r.label ?? ''} · ${fmt(r.value)} / ${fmt(r.max)}`}</title>
            </path>
            <path
              d={arcStroke(CX, CY, r.radius, A0, A0 + r.share * (A1 - A0))}
              fill="none" stroke={r.color} strokeWidth={BAND} strokeLinecap="butt" pointerEvents="none"
            />
          </g>
        ))}
        <text className="intel-chart-value" x={CX} y={CY + 4} textAnchor="middle" style={{ fontSize: 13 }}>
          {rows.length ? fmt(rows[0].value) : fmt(0)}
        </text>
      </svg>
    </ChartFrame>
  )
}
