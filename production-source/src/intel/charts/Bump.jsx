import React, { useMemo, useState } from 'react'
import { ChartFrame, ChartLegend, ChartTable, markProps, useChartText, defaultTimeFormat } from './frame'
import { paletteColor, toneColor, gridStroke, axisText, useReducedMotion } from './theme'
import { clamp, dodge, textWidth } from './geometry'

const W = 760
const PAD_L = 132, PAD_R = 104, PAD_T = 26, PAD_B = 34
// One row per rank slot. Twenty-five rows at eighteen points each is a figure
// that can be read; the old fixed 320 crushed them into seven points apiece.
const ROW_H = 18
const MIN_PLOT = 220
const FONT = 11
const LABEL_H = 13
// A dodged label keeps at least this much clear air above and below it, so two
// boxes of LABEL_H can never touch.
const LABEL_GAP = LABEL_H + 2
// Gutter geometry. Rank ticks sit hard left, the symbols right-anchored against
// the plot edge with a leader line to the path, and the current rank in the
// right gutter. Nothing a reader has to read overlaps a path or another label.
const TICK_X = 0
const LEFT_LABEL_X = PAD_L - 18
const RIGHT_LABEL_X = W - PAD_R + 18

const boxAround = (x, y, width) => ({ x, y: y - LABEL_H * 0.75, width, height: LABEL_H })
const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

// The whole geometry of a rank map as plain numbers: plot size, paths, and the
// box every piece of text will occupy. The component draws exactly this, so a
// test can prove no two labels collide without measuring a rendered DOM.
export function rankMapLayout({ series = [], maxRank } = {}) {
  const list = Array.isArray(series) ? series : []
  const times = [...new Set(list.flatMap(s => (s?.points || []).map(p => Number(p?.t))))]
    .filter(Number.isFinite).sort((a, b) => a - b)
  const ranks = list.flatMap(s => (s?.points || []).map(p => Number(p?.rank))).filter(Number.isFinite)
  const top = Number(maxRank) > 0 ? Number(maxRank) : Math.max(1, ...ranks, 1)

  // Height follows the series count with a floor, so the figure grows rather
  // than crowding. The frame reserves the box from this same ratio.
  const rows = Math.max(1, top, list.filter(s => (s?.points || []).length).length)
  const plotH = Math.max(MIN_PLOT, rows * ROW_H)
  const height = PAD_T + PAD_B + plotH

  const x = i => (times.length < 2 ? PAD_L : PAD_L + (i / (times.length - 1)) * (W - PAD_L - PAD_R))
  const xAt = tv => x(Math.max(0, times.indexOf(Number(tv))))
  const y = rank => PAD_T + (top <= 1 ? 0.5 : clamp((Number(rank) - 1) / (top - 1), 0, 1)) * plotH

  const lines = list.map((s, i) => {
    const points = (s?.points || [])
      .filter(p => Number.isFinite(Number(p?.rank)) && times.includes(Number(p?.t)))
      .sort((a, b) => Number(a.t) - Number(b.t))
    return {
      ...s,
      index: i,
      id: s?.key ?? i,
      color: s?.tone ? toneColor(s.tone) : paletteColor(i),
      points,
      d: points.map((p, j) => `${j === 0 ? 'M' : 'L'} ${xAt(p.t)} ${y(p.rank)}`).join(' '),
    }
  })

  const drawn = lines.filter(line => line.points.length)
  const bounds = { gap: LABEL_GAP, min: PAD_T + LABEL_H * 0.75, max: PAD_T + plotH }
  const leftY = dodge(drawn.map(line => y(line.points[0].rank)), bounds)
  const rightY = dodge(drawn.map(line => y(line.points.at(-1).rank)), bounds)

  const startLabels = drawn.map((line, i) => {
    const point = line.points[0]
    // Capped so a stray long name can never reach back into the rank ticks.
    const full = String(line.label ?? line.id ?? '')
    const text = full.length > 8 ? `${full.slice(0, 7)}…` : full
    const width = textWidth(text, FONT)
    return {
      id: line.id, color: line.color, text, anchor: 'end',
      x: LEFT_LABEL_X, y: leftY[i],
      pointX: xAt(point.t), pointY: y(point.rank),
      box: boxAround(LEFT_LABEL_X - width, leftY[i], width),
    }
  })

  // The current rank, once per row, at the right end. It is the number a reader
  // came for, and it never sits on top of the path it belongs to.
  const endLabels = drawn.map((line, i) => {
    const point = line.points.at(-1)
    const text = `#${point.rank}`
    const width = textWidth(text, FONT)
    return {
      id: line.id, color: line.color, text, anchor: 'start',
      x: RIGHT_LABEL_X, y: rightY[i],
      pointX: xAt(point.t), pointY: y(point.rank),
      box: boxAround(RIGHT_LABEL_X, rightY[i], width),
    }
  })

  const tickRanks = [...new Set(Array.from(
    { length: Math.min(top, 10) },
    (_, i) => Math.round(1 + i * ((top - 1) / Math.max(1, Math.min(top, 10) - 1))),
  ))]
  const ticks = tickRanks.map(rank => {
    const text = `#${rank}`
    return { rank, text, x: TICK_X, y: y(rank), box: boxAround(TICK_X, y(rank), textWidth(text, FONT)) }
  })

  return { width: W, height, plotH, times, top, rows, lines, drawn, startLabels, endLabels, ticks, x, xAt, y }
}

// Every text box the figure draws, in one list, so an overlap check covers the
// rank ticks as well as the two label gutters.
export const rankMapLabelBoxes = layout =>
  [...layout.ticks, ...layout.startLabels, ...layout.endLabels].map(item => ({ ...item.box, text: item.text }))

export const rankMapOverlaps = layout => {
  const boxes = rankMapLabelBoxes(layout)
  const hits = []
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      if (overlaps(boxes[i], boxes[j])) hits.push([boxes[i].text, boxes[j].text])
    }
  }
  return hits
}

// Rank paths over time, rank 1 at the top. A hovered or focused path is
// emphasized, comes forward and the others dim. A path that starts late is an
// entry; one that stops early is an exit — both read directly from where the
// path begins and ends. Symbols sit in the left gutter on a leader line and the
// current rank in the right one, so no label is ever printed over another.
export default function Bump({
  title, description, series = [], maxRank, formatTime, state = 'ready', reason, onHover, onSelect,
}) {
  const t = useChartText()
  const reduced = useReducedMotion()
  const time = formatTime || defaultTimeFormat
  const [active, setActive] = useState(null)

  const layout = useMemo(() => rankMapLayout({ series, maxRank }), [series, maxRank])
  const { height, plotH, times, lines, startLabels, endLabels, ticks, x, xAt, y } = layout

  const labelsFor = id => ({
    start: startLabels.find(label => label.id === id),
    end: endLabels.find(label => label.id === id),
  })
  // The active path is drawn last so its stroke and its labels sit above the
  // rest rather than under whatever happened to be declared after it.
  const order = active == null ? lines : [...lines.filter(l => l.id !== active), ...lines.filter(l => l.id === active)]

  return (
    <ChartFrame
      t={t} title={title} description={description} state={state} reason={reason}
      plot={{ width: W, height }}
      legend={<ChartLegend
        t={t} dense={lines.length > 8}
        items={lines.map(l => ({ key: l.id, color: l.color, label: l.label, value: l.points.length ? `#${l.points.at(-1).rank}` : '—' }))}
      />}
      table={
        <ChartTable
          t={t} caption={title}
          columns={[t('charts.legend', { defaultValue: 'Legend' }), ...times.map(tv => time(tv))]}
          rows={lines.map(l => [l.label ?? l.id ?? '—', ...times.map(tv => {
            const point = l.points.find(p => Number(p.t) === tv)
            return point ? `#${point.rank}` : '—'
          })])}
        />
      }
    >
      <svg viewBox={`0 0 ${W} ${height}`} role="img"
        aria-label={`${title}. ${t('charts.rank', { defaultValue: 'Rank' })}. ${t('charts.show_as_table', { defaultValue: 'Show as table' })}`}>
        {ticks.map(tick => (
          <g key={tick.rank}>
            <line x1={PAD_L} x2={W - PAD_R} y1={tick.y} y2={tick.y} stroke={gridStroke} strokeDasharray="2 6" />
            <text x={tick.x} y={tick.y + 4} textAnchor="start" fill={axisText}>{tick.text}</text>
          </g>
        ))}
        {times.map((tv, i) => (
          <text key={tv} x={x(i)} y={PAD_T + plotH + 24} textAnchor={i === 0 ? 'start' : i === times.length - 1 ? 'end' : 'middle'} fill={axisText}>
            {i === 0 || i === times.length - 1 || i === Math.floor(times.length / 2) ? time(tv) : ''}
          </text>
        ))}
        {order.map(line => {
          const dimmed = active != null && active !== line.id
          const label = labelsFor(line.id)
          const first = line.points[0]
          const last = line.points.at(-1)
          return (
            <g key={line.id}
              {...markProps({ label: `${line.label ?? ''} ${line.points.length ? `#${line.points.at(-1).rank}` : ''}`, onActivate: () => onSelect?.(line), reduced })}
              onMouseEnter={() => { setActive(line.id); onHover?.(line) }}
              onMouseLeave={() => { setActive(null); onHover?.(null) }}
              onFocus={() => { setActive(line.id); onHover?.(line) }}
              onBlur={() => { setActive(null); onHover?.(null) }}
              opacity={dimmed ? 0.22 : 1}
            >
              <title>{`${line.label ?? ''}${last ? ` · #${last.rank}` : ''}`}</title>
              <path d={line.d} fill="none" stroke={line.color} strokeWidth={dimmed ? 1 : active === line.id ? 2.6 : 1.4} strokeLinejoin="round" />
              {first ? <circle cx={xAt(first.t)} cy={y(first.rank)} r={active === line.id ? 3.4 : 2.4} fill={line.color} /> : null}
              {last ? <circle cx={xAt(last.t)} cy={y(last.rank)} r={active === line.id ? 3.4 : 2.4} fill={line.color} /> : null}
              {label.start ? (
                <>
                  <line x1={label.start.x + 4} x2={label.start.pointX} y1={label.start.y} y2={label.start.pointY} stroke={line.color} strokeWidth="0.75" opacity="0.7" />
                  <text x={label.start.x} y={label.start.y + 4} textAnchor="end" className="intel-chart-strong">{label.start.text}</text>
                </>
              ) : null}
              {label.end ? (
                <>
                  <line x1={label.end.pointX} x2={label.end.x - 4} y1={label.end.pointY} y2={label.end.y} stroke={line.color} strokeWidth="0.75" opacity="0.7" />
                  <text x={label.end.x} y={label.end.y + 4} textAnchor="start" className="intel-chart-strong">{label.end.text}</text>
                </>
              ) : null}
            </g>
          )
        })}
      </svg>
    </ChartFrame>
  )
}
