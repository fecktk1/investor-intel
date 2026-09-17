import React from 'react'
import { ChartFrame, ChartLegend, ChartTable, markProps, useChartText, defaultValueFormat } from './frame'
import { toneColor, trackStroke, useReducedMotion } from './theme'
import { arcStroke, polar, fraction, anchorFor, clamp } from './geometry'

const CX = 170, CY = 156, R = 108, BAND = 18, A0 = -120, A1 = 120

// Arc gauge with zone bands, a needle at the value and the value printed in the
// centre. Zones are keyboard reachable; activating one calls onSelect(zone).
export default function RadialGauge({
  title, description, value, min = 0, max = 100, zones = [], formatValue, state = 'ready', kind = 'error', note, reason, onSelect, height = 180,
}) {
  const t = useChartText()
  const reduced = useReducedMotion()
  const fmt = formatValue || defaultValueFormat
  const lo = Number(min), hi = Number(max)
  const angle = v => A0 + fraction(v, lo, hi) * (A1 - A0)
  const safeValue = Number.isFinite(Number(value)) ? Number(value) : lo
  const bands = []
  let from = lo
  for (const zone of zones) {
    const to = Number.isFinite(Number(zone?.to)) ? Number(zone.to) : hi
    bands.push({ ...zone, from, to })
    from = to
  }
  const needle = angle(safeValue)
  const [nx, ny] = polar(CX, CY, R - BAND / 2 - 6, needle)
  const [mx, my] = polar(CX, CY, R - BAND / 2, needle)

  return (
    <ChartFrame
      t={t} title={title} description={description} state={state} kind={kind} note={note} reason={reason}
      plot={{ width: 420, height: 246, radial: true, maxHeight: `${height * 1.4}px` }}
      legend={<ChartLegend t={t} items={bands.map((b, i) => ({ key: b.label ?? i, color: toneColor(b.tone), label: b.label, value: fmt(b.to) }))} />}
      table={
        <ChartTable
          t={t} caption={title}
          columns={[t('charts.legend', { defaultValue: 'Legend' }), t('charts.value', { defaultValue: 'Value' })]}
          rows={[
            [t('charts.value', { defaultValue: 'Value' }), fmt(safeValue)],
            ...bands.map(b => [b.label ?? '—', fmt(b.to)]),
          ]}
        />
      }
    >
      {/* Extra horizontal room so the outermost zone labels never clip at phone width. */}
      <svg viewBox="-40 0 420 246" role="img" className="intel-chart-radial" style={{ maxHeight: `${height * 1.4}px` }}
        aria-label={`${title}. ${fmt(safeValue)}. ${t('charts.show_as_table', { defaultValue: 'Show as table' })}`}>
        <path d={arcStroke(CX, CY, R - BAND / 2, A0, A1)} fill="none" stroke={trackStroke} strokeWidth={BAND} />
        {bands.map((band, i) => {
          const a = angle(band.from), b = clamp(angle(band.to), A0, A1)
          const mid = (a + b) / 2
          const [lx, ly] = polar(CX, CY, R + 14, mid)
          return (
            <g key={band.label ?? i}>
              <path
                {...markProps({ label: `${band.label ?? ''} ${fmt(band.to)}`, onActivate: () => onSelect?.(band), reduced })}
                d={arcStroke(CX, CY, R - BAND / 2, a, b)} fill="none" stroke={toneColor(band.tone)} strokeWidth={BAND}
              >
                <title>{`${band.label ?? ''} · ${fmt(band.from)} – ${fmt(band.to)}`}</title>
              </path>
              <text x={lx} y={ly + 4} textAnchor={anchorFor(mid)}>{band.label}</text>
            </g>
          )
        })}
        <line x1={CX} y1={CY} x2={nx} y2={ny} stroke="var(--fg-1)" strokeWidth="2.5" />
        <circle cx={CX} cy={CY} r="4" fill="var(--fg-1)" />
        <circle cx={mx} cy={my} r="5" fill="var(--fg-1)" />
        <text className="intel-chart-value" x={CX} y={CY - 18} textAnchor="middle" style={{ fontSize: 30 }}>{fmt(safeValue)}</text>
        <text x={CX} y={CY + 34} textAnchor="middle">{`${fmt(lo)} – ${fmt(hi)}`}</text>
      </svg>
    </ChartFrame>
  )
}
