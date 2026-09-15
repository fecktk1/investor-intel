import React from 'react'
import { ChartFrame, ChartTable, markProps, useChartText, defaultValueFormat, defaultTimeFormat } from './frame'
import { toneColor, gridStroke, useReducedMotion } from './theme'
import { clamp } from './geometry'

// A horizontal band sized to a given pixel width. It sits under an existing
// chart and receives that chart's viewport width so the two share one time axis.
export default function Ribbon({
  title, description, domain, segments = [], width, height = 18, formatTime, formatValue, state = 'ready', reason, onSelect,
}) {
  const t = useChartText()
  const reduced = useReducedMotion()
  const time = formatTime || defaultTimeFormat
  const fmt = formatValue || defaultValueFormat
  const w = Number(width) > 0 ? Number(width) : 640
  const h = Number(height) > 0 ? Number(height) : 18
  const from = Number(domain?.from), to = Number(domain?.to)
  const span = Number.isFinite(from) && Number.isFinite(to) && to > from ? to - from : 0
  const at = value => (span ? clamp((Number(value) - from) / span, 0, 1) * w : 0)

  // No reserved plot box is passed: this band is 14 to 20 pixels tall, and a box
  // that short would cut the state message off. It is the one figure whose plot
  // is shorter than the line of text that stands in for it.
  return (
    <ChartFrame
      t={t} title={title} description={description} state={state} reason={reason}
      table={
        <ChartTable
          t={t} caption={title}
          columns={[
            t('charts.legend', { defaultValue: 'Legend' }),
            t('charts.time', { defaultValue: 'Time' }),
            t('charts.value', { defaultValue: 'Value' }),
          ]}
          rows={segments.map(s => [s?.label ?? '—', `${time(s?.from)} – ${time(s?.to)}`, fmt(s?.value)])}
        />
      }
    >
      <svg viewBox={`0 0 ${w} ${h}`} role="img" preserveAspectRatio="none"
        style={{ width: Number(width) > 0 ? `${w}px` : '100%', maxWidth: '100%', height: `${h}px` }}
        aria-label={`${title}. ${segments.length} ${t('charts.legend', { defaultValue: 'Legend' })}. ${t('charts.show_as_table', { defaultValue: 'Show as table' })}`}>
        <rect x="0" y="0" width={w} height={h} fill="none" stroke={gridStroke} />
        {segments.map((segment, i) => {
          const x0 = at(segment?.from)
          const x1 = at(segment?.to)
          return (
            <rect
              key={`${segment?.label ?? 'segment'}-${i}`}
              {...markProps({ label: `${segment?.label ?? ''} ${time(segment?.from)} ${fmt(segment?.value)}`, onActivate: () => onSelect?.(segment), reduced })}
              x={x0} y={0} width={Math.max(1, x1 - x0)} height={h}
              fill={toneColor(segment?.tone)} fillOpacity="0.85"
            >
              <title>{`${segment?.label ?? ''} · ${time(segment?.from)} – ${time(segment?.to)} · ${fmt(segment?.value)}`}</title>
            </rect>
          )
        })}
      </svg>
    </ChartFrame>
  )
}
