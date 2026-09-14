import React from 'react'
import { ChartFrame, ChartTable, markProps, useChartText, defaultValueFormat, defaultTimeFormat } from './frame'
import { TONES, gridStroke, useReducedMotion } from './theme'
import { fraction } from './geometry'

const CELL = 26, GAP = 4, PAD = 2

// Calendar-intensity cells. Intensity is the opacity of the accent token, with a
// visible floor so a real zero still reads as a cell rather than as a gap.
export default function HeatStrip({
  title, description, cells = [], columns = 7, formatValue, formatTime, state = 'ready', reason, onSelect,
}) {
  const t = useChartText()
  const reduced = useReducedMotion()
  const fmt = formatValue || defaultValueFormat
  const time = formatTime || defaultTimeFormat
  const cols = Math.max(1, Math.trunc(Number(columns) || 7))
  const rows = Math.max(1, Math.ceil(cells.length / cols))
  const max = Math.max(0, ...cells.map(c => Number(c?.value) || 0))
  const w = PAD * 2 + cols * CELL + (cols - 1) * GAP
  const h = PAD * 2 + rows * CELL + (rows - 1) * GAP

  return (
    <ChartFrame
      t={t} title={title} description={description} state={state} reason={reason}
      table={
        <ChartTable
          t={t} caption={title}
          columns={[t('charts.time', { defaultValue: 'Time' }), t('charts.value', { defaultValue: 'Value' })]}
          rows={cells.map(c => [c?.label ?? time(c?.t), fmt(c?.value)])}
        />
      }
    >
      <svg viewBox={`0 0 ${w} ${h}`} role="img" style={{ maxWidth: `${w * 1.5}px` }}
        aria-label={`${title}. ${cells.length} ${t('charts.time', { defaultValue: 'Time' })}. ${t('charts.show_as_table', { defaultValue: 'Show as table' })}`}>
        {cells.map((cell, i) => {
          const col = i % cols
          const row = Math.floor(i / cols)
          const intensity = max > 0 ? fraction(cell?.value, 0, max) : 0
          return (
            <rect
              key={`${cell?.t ?? 'cell'}-${i}`}
              {...markProps({ label: `${cell?.label ?? time(cell?.t)} ${fmt(cell?.value)}`, onActivate: () => onSelect?.(cell), reduced })}
              x={PAD + col * (CELL + GAP)} y={PAD + row * (CELL + GAP)} width={CELL} height={CELL}
              fill={TONES.accent} fillOpacity={0.08 + intensity * 0.87}
              stroke={gridStroke} strokeWidth="1"
            >
              <title>{`${cell?.label ?? time(cell?.t)} · ${fmt(cell?.value)}`}</title>
            </rect>
          )
        })}
      </svg>
    </ChartFrame>
  )
}
