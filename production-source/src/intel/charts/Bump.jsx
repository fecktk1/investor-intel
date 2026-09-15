import React, { useMemo, useState } from 'react'
import { ChartFrame, ChartLegend, ChartTable, markProps, useChartText, defaultTimeFormat } from './frame'
import { seriesColor, toneColor, gridStroke, axisText, useReducedMotion } from './theme'
import { clamp } from './geometry'

const W = 760, H = 320, PAD_L = 118, PAD_R = 118, PAD_T = 26, PAD_B = 34

// Rank paths over time, rank 1 at the top. A hovered or focused path is
// emphasized and the others dim. A path that starts late is an entry; one that
// stops early is an exit — both read directly from where the path begins and ends.
export default function Bump({
  title, description, series = [], maxRank, formatTime, state = 'ready', reason, onHover, onSelect,
}) {
  const t = useChartText()
  const reduced = useReducedMotion()
  const time = formatTime || defaultTimeFormat
  const [active, setActive] = useState(null)

  const model = useMemo(() => {
    const times = [...new Set(series.flatMap(s => (s?.points || []).map(p => Number(p?.t))))].filter(Number.isFinite).sort((a, b) => a - b)
    const ranks = series.flatMap(s => (s?.points || []).map(p => Number(p?.rank))).filter(Number.isFinite)
    const top = Number(maxRank) > 0 ? Number(maxRank) : Math.max(1, ...ranks)
    return { times, top }
  }, [series, maxRank])

  const { times, top } = model
  const x = i => (times.length < 2 ? PAD_L : PAD_L + (i / (times.length - 1)) * (W - PAD_L - PAD_R))
  const xAt = tv => x(Math.max(0, times.indexOf(Number(tv))))
  const y = rank => PAD_T + (top <= 1 ? 0.5 : clamp((Number(rank) - 1) / (top - 1), 0, 1)) * (H - PAD_T - PAD_B)

  const lines = series.map((s, i) => {
    const points = (s?.points || []).filter(p => Number.isFinite(Number(p?.rank)) && times.includes(Number(p?.t)))
      .sort((a, b) => Number(a.t) - Number(b.t))
    return {
      ...s, index: i,
      color: s?.tone ? toneColor(s.tone) : seriesColor(i),
      points,
      d: points.map((p, j) => `${j === 0 ? 'M' : 'L'} ${xAt(p.t)} ${y(p.rank)}`).join(' '),
    }
  })

  const rankTicks = Array.from({ length: Math.min(top, 10) }, (_, i) => Math.round(1 + i * ((top - 1) / Math.max(1, Math.min(top, 10) - 1))))

  return (
    <ChartFrame
      t={t} title={title} description={description} state={state} reason={reason}
      plot={{ width: W, height: H }}
      legend={<ChartLegend t={t} items={lines.map(l => ({ key: l.key ?? l.index, color: l.color, label: l.label, value: l.points.length ? `#${l.points.at(-1).rank}` : '—' }))} />}
      table={
        <ChartTable
          t={t} caption={title}
          columns={[t('charts.legend', { defaultValue: 'Legend' }), ...times.map(tv => time(tv))]}
          rows={lines.map(l => [l.label ?? l.key ?? '—', ...times.map(tv => {
            const point = l.points.find(p => Number(p.t) === tv)
            return point ? `#${point.rank}` : '—'
          })])}
        />
      }
    >
      <svg viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label={`${title}. ${t('charts.rank', { defaultValue: 'Rank' })}. ${t('charts.show_as_table', { defaultValue: 'Show as table' })}`}>
        {[...new Set(rankTicks)].map(rank => (
          <g key={rank}>
            <line x1={PAD_L} x2={W - PAD_R} y1={y(rank)} y2={y(rank)} stroke={gridStroke} strokeDasharray="2 6" />
            <text x={PAD_L - 10} y={y(rank) + 4} textAnchor="end" fill={axisText}>{`#${rank}`}</text>
          </g>
        ))}
        {times.map((tv, i) => (
          <text key={tv} x={x(i)} y={H - 10} textAnchor={i === 0 ? 'start' : i === times.length - 1 ? 'end' : 'middle'} fill={axisText}>
            {i === 0 || i === times.length - 1 || i === Math.floor(times.length / 2) ? time(tv) : ''}
          </text>
        ))}
        {lines.map(line => {
          const dimmed = active != null && active !== (line.key ?? line.index)
          const first = line.points[0]
          const last = line.points.at(-1)
          return (
            <g key={line.key ?? line.index}
              {...markProps({ label: `${line.label ?? ''} ${line.points.length ? `#${line.points.at(-1).rank}` : ''}`, onActivate: () => onSelect?.(line), reduced })}
              onMouseEnter={() => { setActive(line.key ?? line.index); onHover?.(line) }}
              onMouseLeave={() => { setActive(null); onHover?.(null) }}
              onFocus={() => { setActive(line.key ?? line.index); onHover?.(line) }}
              onBlur={() => { setActive(null); onHover?.(null) }}
              opacity={dimmed ? 0.25 : 1}
            >
              <title>{`${line.label ?? ''}${last ? ` · #${last.rank}` : ''}`}</title>
              <path d={line.d} fill="none" stroke={line.color} strokeWidth={dimmed ? 1.4 : 2.4} strokeLinejoin="round" />
              {first ? <circle cx={xAt(first.t)} cy={y(first.rank)} r="4" fill={line.color} /> : null}
              {last ? <circle cx={xAt(last.t)} cy={y(last.rank)} r="4" fill={line.color} /> : null}
              {first ? <text x={xAt(first.t) - 10} y={y(first.rank) + 4} textAnchor="end" className="intel-chart-strong">{line.label}</text> : null}
              {last ? <text x={xAt(last.t) + 10} y={y(last.rank) + 4} textAnchor="start" className="intel-chart-strong">{`#${last.rank}`}</text> : null}
            </g>
          )
        })}
      </svg>
    </ChartFrame>
  )
}
