import React from 'react'
import { ChartFrame, ChartTable, markProps, useChartText, defaultValueFormat } from './frame'
import { TONES, gridStroke, useReducedMotion } from './theme'
import { arcPath, polar, anchorFor, fraction } from './geometry'

const CX = 170, CY = 170, R_IN = 46, R_OUT = 126

// Which bucket the reader is standing in. 24h buckets are hours, 7d buckets are
// days starting at the array's first entry (Sunday-first, as Date#getDay reports).
const currentBucket = (period, count) => {
  if (!count) return -1
  const now = new Date()
  const index = period === '7d' ? now.getDay() : now.getHours()
  return index % count
}

// A ring of radial bars arranged like a clock face.
export default function PolarClock({ title, description, period = '24h', buckets = [], formatValue, state = 'ready', reason, onSelect }) {
  const t = useChartText()
  const reduced = useReducedMotion()
  const fmt = formatValue || defaultValueFormat
  const count = buckets.length
  const max = Math.max(0, ...buckets.map(b => Number(b?.value) || 0))
  const step = count ? 360 / count : 0
  const gap = count > 12 ? 2.5 : 4
  const now = currentBucket(period, count)
  const labelEvery = count > 12 ? 3 : 1

  return (
    <ChartFrame
      t={t} title={title} description={description} state={state} reason={reason}
      plot={{ width: 340, height: 340, radial: true }}
      table={
        <ChartTable
          t={t} caption={title}
          columns={[t('charts.time', { defaultValue: 'Time' }), t('charts.value', { defaultValue: 'Value' })]}
          rows={buckets.map(b => [b?.label ?? '—', fmt(b?.value)])}
        />
      }
    >
      <svg viewBox="0 0 340 340" role="img" className="intel-chart-radial"
        aria-label={`${title}. ${period}. ${t('charts.show_as_table', { defaultValue: 'Show as table' })}`}>
        <circle cx={CX} cy={CY} r={R_IN} fill="none" stroke={gridStroke} />
        <circle cx={CX} cy={CY} r={R_OUT} fill="none" stroke={gridStroke} strokeDasharray="2 5" />
        {buckets.map((bucket, i) => {
          const a0 = i * step + gap / 2
          const a1 = (i + 1) * step - gap / 2
          const share = max > 0 ? fraction(bucket?.value, 0, max) : 0
          const rOut = R_IN + Math.max(1.5, share * (R_OUT - R_IN))
          const mid = (a0 + a1) / 2
          const [lx, ly] = polar(CX, CY, R_OUT + 14, mid)
          const isNow = i === now
          return (
            <g key={bucket?.label ?? i}>
              <path
                {...markProps({ label: `${bucket?.label ?? ''} ${fmt(bucket?.value)}`, onActivate: () => onSelect?.({ ...bucket, index: i }), reduced, selected: isNow })}
                d={arcPath(CX, CY, R_IN, rOut, a0, a1)}
                fill={isNow ? TONES.accent : TONES.blue}
                fillOpacity={isNow ? 1 : 0.6}
                stroke={isNow ? 'var(--fg-1)' : 'none'} strokeWidth={isNow ? 1.5 : 0}
                aria-current={isNow ? 'time' : undefined}
              >
                <title>{`${bucket?.label ?? ''} · ${fmt(bucket?.value)}`}</title>
              </path>
              {i % labelEvery === 0 ? <text x={lx} y={ly + 4} textAnchor={anchorFor(mid)}>{bucket?.label}</text> : null}
            </g>
          )
        })}
        <text className="intel-chart-value" x={CX} y={CY + 2} textAnchor="middle" style={{ fontSize: 14 }}>{fmt(max)}</text>
        <text x={CX} y={CY + 20} textAnchor="middle">{period}</text>
      </svg>
    </ChartFrame>
  )
}
