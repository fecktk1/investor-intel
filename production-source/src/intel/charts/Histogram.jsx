import React from 'react'
import { ChartFrame, ChartTable, markProps, useChartText, defaultValueFormat } from './frame'
import { TONES, toneColor, gridStroke, axisText, useReducedMotion } from './theme'
import { fraction } from './geometry'

const W = 760, H = 260, PAD_L = 54, PAD_R = 16, PAD_T = 16, PAD_B = 46, GAP = 3

// Distribution bars over bins the CALLER computed. This chart never bins
// anything itself: the bin edges are a reading, and re-deriving them here would
// quietly disagree with the source that published them.
//
// Three rules run through the drawing:
//   * A bin whose count is zero is drawn as a zero-height bar in its own slot,
//     never omitted. A gap in a histogram reads as "no range here", which is a
//     different statement from "no observations in this range".
//   * A bin is named by its EDGES — never by an index, never by a midpoint. A
//     bin whose two edges are the same value crosses no range at all (one
//     observed magnitude) and is named by that single edge.
//   * Negative ranges are supported and keep their own tone, so a loss bin is
//     never read as a small gain.

const num = value => {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** Edge label for one bin. Open-ended edges read as a bound, not as a range. */
export function binLabel(bin, format = defaultValueFormat) {
  const from = num(bin?.from), to = num(bin?.to)
  if (from == null && to == null) return '—'
  if (from == null) return `≤ ${format(to)}`
  if (to == null) return `≥ ${format(from)}`
  return from === to ? format(from) : `${format(from)} – ${format(to)}`
}

/** An explicit tone wins. Otherwise a bin touching the negative side is the
 * loss tone and everything else is the accent: the two signs must never be
 * indistinguishable. */
export function binTone(bin) {
  if (bin?.tone) return toneColor(bin.tone)
  const from = num(bin?.from), to = num(bin?.to)
  return (from != null && from < 0) || (to != null && to < 0) ? TONES.red : TONES.accent
}

export default function Histogram({
  title, description, bins = [], formatValue, formatCount, state = 'ready', reason, onSelect,
}) {
  const t = useChartText()
  const reduced = useReducedMotion()
  const fmt = formatValue || defaultValueFormat
  const counted = formatCount || defaultValueFormat

  const rows = (Array.isArray(bins) ? bins : []).map((bin, index) => ({
    ...bin, index,
    label: binLabel(bin, fmt),
    // A bin without a readable count is an empty bin, not a missing bar.
    value: num(bin?.count) ?? 0,
    color: binTone(bin),
  }))
  const max = Math.max(0, ...rows.map(row => row.value))
  const total = rows.reduce((sum, row) => sum + row.value, 0)
  const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B
  const slot = rows.length ? plotW / rows.length : plotW
  const barW = Math.max(1, slot - GAP)
  const y = value => PAD_T + plotH - fraction(value, 0, max) * plotH
  // The first bin that is not negative. A histogram that carries both signs
  // says where they meet rather than leaving a reader to count bars.
  const boundary = rows.findIndex(row => (num(row.from) ?? 0) >= 0)
  const crossing = boundary > 0 ? PAD_L + boundary * slot : null

  const gridlines = max > 0 ? [0, 0.25, 0.5, 0.75, 1] : [0]

  return (
    <ChartFrame
      t={t} title={title} description={description} state={state} reason={reason}
      plot={{ width: W, height: H }}
      table={
        <ChartTable
          t={t} caption={title}
          columns={[
            t('charts.range', { defaultValue: 'Range' }),
            t('charts.count', { defaultValue: 'Count' }),
            t('charts.share', { defaultValue: 'Share' }),
          ]}
          rows={rows.map(row => [row.label, counted(row.value), `${(total > 0 ? (row.value / total) * 100 : 0).toFixed(1)}%`])}
        />
      }
    >
      <svg viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label={`${title}. ${rows.map(row => `${row.label}: ${counted(row.value)}`).join('. ')}`}>
        {gridlines.map(step => (
          <g key={step}>
            <line x1={PAD_L} x2={W - PAD_R} y1={y(max * step)} y2={y(max * step)} stroke={gridStroke} strokeDasharray="2 6" />
            <text x={PAD_L - 8} y={y(max * step) + 4} textAnchor="end" fill={axisText}>{counted(max * step)}</text>
          </g>
        ))}
        {crossing == null ? null : (
          <g>
            <line x1={crossing} x2={crossing} y1={PAD_T} y2={PAD_T + plotH} stroke={gridStroke} />
            <text x={crossing} y={H - 26} textAnchor="middle" fill={axisText}>{fmt(0)}</text>
          </g>
        )}
        {rows.map(row => {
          const x = PAD_L + row.index * slot
          const top = y(row.value)
          return (
            <g key={`${row.key ?? row.label}-${row.index}`}>
              {/* The slot carries the interaction so an empty bin stays
                  reachable by pointer and by keyboard. */}
              <rect
                {...markProps({ label: `${row.label} ${counted(row.value)}`, onActivate: () => onSelect?.(row), reduced })}
                x={x} y={PAD_T} width={Math.max(1, slot)} height={plotH} fill="transparent"
              >
                <title>{`${row.label} · ${counted(row.value)}`}</title>
              </rect>
              <rect
                x={x + (slot - barW) / 2} y={top} width={barW} height={PAD_T + plotH - top}
                fill={row.color} fillOpacity="0.85" pointerEvents="none"
              />
            </g>
          )
        })}
        <line x1={PAD_L} x2={W - PAD_R} y1={PAD_T + plotH} y2={PAD_T + plotH} stroke={gridStroke} />
        {rows.length ? (
          <>
            <text x={PAD_L} y={H - 10} textAnchor="start" fill={axisText}>{fmt(num(rows[0].from) ?? 0)}</text>
            <text x={W - PAD_R} y={H - 10} textAnchor="end" fill={axisText}>{fmt(num(rows.at(-1).to) ?? 0)}</text>
          </>
        ) : null}
      </svg>
    </ChartFrame>
  )
}
