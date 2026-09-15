import React, { useMemo } from 'react'
import { ChartFrame, ChartLegend, ChartTable, markProps, useChartText, defaultTimeFormat, defaultValueFormat } from './frame'
import { seriesColor, toneColor, gridStroke, axisText, useReducedMotion } from './theme'

const W = 760, H = 300, PAD_L = 46, PAD_R = 16, PAD_T = 18, PAD_B = 34

// 100% stacked area over time. Drawn as native SVG so the same viewBox rules
// (no clipping, tabular numerals, token colours) apply as in the radial charts.
// When every value at a time is zero the shares are zero and the bands stay flat
// on the baseline — a real zero, not an empty chart.
export default function StackedShare({ title, description, series = [], formatTime, state = 'ready', reason, onSelect }) {
  const t = useChartText()
  const reduced = useReducedMotion()
  const time = formatTime || defaultTimeFormat

  const model = useMemo(() => {
    const times = [...new Set(series.flatMap(s => (s?.points || []).map(p => Number(p?.t))))].filter(Number.isFinite).sort((a, b) => a - b)
    const valueAt = (s, tv) => {
      const point = (s?.points || []).find(p => Number(p?.t) === tv)
      const v = Number(point?.value)
      return Number.isFinite(v) ? v : 0
    }
    const totals = times.map(tv => series.reduce((sum, s) => sum + valueAt(s, tv), 0))
    const shares = series.map(s => times.map((tv, i) => (totals[i] > 0 ? valueAt(s, tv) / totals[i] : 0)))
    return { times, totals, shares, valueAt }
  }, [series])

  const { times, shares, valueAt } = model
  const x = i => (times.length < 2 ? PAD_L : PAD_L + (i / (times.length - 1)) * (W - PAD_L - PAD_R))
  const y = share => H - PAD_B - share * (H - PAD_T - PAD_B)

  // Cumulative stack, bottom band first.
  const bands = series.map((s, si) => {
    const below = times.map((_, i) => shares.slice(0, si).reduce((sum, row) => sum + row[i], 0))
    const above = times.map((_, i) => below[i] + shares[si][i])
    const top = times.map((_, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(2)} ${y(above[i]).toFixed(2)}`).join(' ')
    const back = times.map((_, i) => times.length - 1 - i).map(i => `L ${x(i).toFixed(2)} ${y(below[i]).toFixed(2)}`).join(' ')
    return { ...s, index: si, color: s?.tone ? toneColor(s.tone) : seriesColor(si), d: times.length ? `${top} ${back} Z` : '' }
  })

  return (
    <ChartFrame
      t={t} title={title} description={description} state={state} reason={reason}
      plot={{ width: W, height: H }}
      legend={<ChartLegend t={t} items={bands.map(b => ({ key: b.key ?? b.index, color: b.color, label: b.label }))} />}
      table={
        <ChartTable
          t={t} caption={title}
          columns={[t('charts.legend', { defaultValue: 'Legend' }), ...times.map(tv => time(tv))]}
          rows={bands.map(b => [b.label ?? b.key ?? '—', ...times.map((tv, i) => `${(shares[b.index][i] * 100).toFixed(1)}% · ${defaultValueFormat(valueAt(b, tv))}`)])}
        />
      }
    >
      <svg viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label={`${title}. ${t('charts.share', { defaultValue: 'Share' })}. ${t('charts.show_as_table', { defaultValue: 'Show as table' })}`}>
        {[0, 0.25, 0.5, 0.75, 1].map(share => (
          <g key={share}>
            <line x1={PAD_L} x2={W - PAD_R} y1={y(share)} y2={y(share)} stroke={gridStroke} strokeDasharray="2 6" />
            <text x={PAD_L - 8} y={y(share) + 4} textAnchor="end" fill={axisText}>{`${share * 100}%`}</text>
          </g>
        ))}
        {bands.map(band => (
          <path
            key={band.key ?? band.index}
            {...markProps({ label: `${band.label ?? ''} ${t('charts.share', { defaultValue: 'Share' })}`, onActivate: () => onSelect?.(band), reduced })}
            d={band.d} fill={band.color} fillOpacity="0.8" stroke={band.color} strokeWidth="1"
          >
            <title>{band.label}</title>
          </path>
        ))}
        {times.map((tv, i) => (
          <text key={tv} x={x(i)} y={H - 10} textAnchor={i === 0 ? 'start' : i === times.length - 1 ? 'end' : 'middle'} fill={axisText}>
            {i === 0 || i === times.length - 1 || i === Math.floor(times.length / 2) ? time(tv) : ''}
          </text>
        ))}
      </svg>
    </ChartFrame>
  )
}
