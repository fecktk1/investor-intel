import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Navigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useProfile } from '../../lib/profile-context'
import { IntelPageHeader, IntelPageShell } from '../components/IntelPrimitives'
import { RadialGauge, RadialBars, Sunburst, PolarClock, Ribbon, Bump, HeatStrip, StackedShare, Sparkline, LineArea, Histogram } from '../charts'

const DAY = 86400000
const WEEK = DAY * 7
const T0 = Date.UTC(2026, 5, 1)

const usd = v => `$${Number(v || 0).toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 1 })}`
const pct = v => `${Number(v || 0).toFixed(1)}%`
const day = t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
const week = t => `W${Math.round((Number(t) - T0) / WEEK) + 1}`

const GAUGE_ZONES = [
  { to: 25, label: 'Extreme fear', tone: 'red' },
  { to: 45, label: 'Fear', tone: 'yellow' },
  { to: 55, label: 'Neutral', tone: 'muted' },
  { to: 75, label: 'Greed', tone: 'green' },
  { to: 100, label: 'Extreme greed', tone: 'accent' },
]

const DOMINANCE = [
  { key: 'btc', label: 'BTC', value: 58.2, tone: 'accent' },
  { key: 'eth', label: 'ETH', value: 12.1, tone: 'blue' },
  { key: 'stables', label: 'Stablecoins', value: 7.4, tone: 'green' },
  { key: 'other', label: 'Other', value: 22.3, tone: 'fourth' },
]

const SUNBURST = {
  name: 'Tokenized equities',
  children: [
    {
      name: 'NVDA',
      tone: 'green',
      children: [
        { name: 'Backed Finance', children: [{ name: 'bNVDA', value: 41_200_000 }, { name: 'bNVDAx', value: 6_400_000 }] },
        { name: 'Ondo Global Markets', children: [{ name: 'NVDAon', value: 18_900_000 }] },
      ],
    },
    {
      name: 'TSLA',
      tone: 'blue',
      children: [
        { name: 'Backed Finance', children: [{ name: 'bTSLA', value: 22_700_000 }] },
        { name: 'Dinari', children: [{ name: 'dTSLA', value: 9_100_000 }, { name: 'dTSLA.d', value: 2_050_000 }] },
      ],
    },
    {
      name: 'AAPL',
      tone: 'fourth',
      children: [
        { name: 'Ondo Global Markets', children: [{ name: 'AAPLon', value: 14_300_000 }] },
        { name: 'Dinari', children: [{ name: 'dAAPL', value: 4_800_000 }] },
      ],
    },
  ],
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const POLAR = [412_000_000, 178_000_000, 96_400_000, 244_000_000, 131_000_000, 88_600_000, 305_000_000]
  .map((value, i) => ({ label: WEEKDAYS[i], value }))

const REGIME = [
  { from: T0, to: T0 + DAY * 9, value: 9, label: 'Risk-on', tone: 'green' },
  { from: T0 + DAY * 9, to: T0 + DAY * 16, value: 7, label: 'BTC-led', tone: 'accent' },
  { from: T0 + DAY * 16, to: T0 + DAY * 24, value: 8, label: 'Risk-off', tone: 'red' },
  { from: T0 + DAY * 24, to: T0 + DAY * 42, value: 18, label: 'Altcoin rotation', tone: 'fourth' },
  { from: T0 + DAY * 42, to: T0 + DAY * 56, value: 14, label: 'No clear regime', tone: 'muted' },
]

// Twelve weekly rank readings. SUI enters at week 4; ADA stops being recorded
// after week 9 — the path start and end show both without extra ink.
const BUMP_RANKS = {
  BTC: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  ETH: [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2],
  SOL: [5, 5, 4, 4, 3, 3, 3, 4, 3, 3, 3, 3],
  XRP: [3, 3, 3, 3, 4, 4, 5, 5, 5, 4, 4, 4],
  BNB: [4, 4, 5, 5, 5, 5, 4, 3, 4, 5, 5, 5],
  DOGE: [6, 7, 7, 6, 6, 7, 7, 7, 7, 7, 6, 6],
  SUI: [null, null, null, 8, 8, 6, 6, 6, 6, 6, 7, 7],
  ADA: [7, 6, 6, 7, 7, 8, 8, 8, 8, null, null, null],
}
const BUMP_SERIES = Object.entries(BUMP_RANKS).map(([symbol, ranks]) => ({
  key: symbol,
  label: symbol,
  points: ranks.map((rank, i) => (rank == null ? null : { t: T0 + i * WEEK, rank })).filter(Boolean),
}))

const HEAT = Array.from({ length: 28 }, (_, i) => {
  const base = [61, 44, 38, 120, 92, 27, 19][i % 7]
  const value = Math.round(base * (1 + (i % 4) * 0.34) * 1_000_000)
  return { t: T0 + i * DAY, value, label: day(T0 + i * DAY) }
})

const SHARE_TIMES = Array.from({ length: 9 }, (_, i) => T0 + i * WEEK)
const SHARE_SERIES = [
  { key: 'btc', label: 'BTC', tone: 'accent', track: [54.1, 55.4, 56.8, 57.9, 58.6, 58.2, 57.4, 58.0, 58.2] },
  { key: 'eth', label: 'ETH', tone: 'blue', track: [13.8, 13.4, 13.0, 12.6, 12.2, 12.1, 12.5, 12.3, 12.1] },
  { key: 'stables', label: 'Stablecoins', tone: 'green', track: [6.9, 7.0, 7.1, 7.2, 7.3, 7.4, 7.5, 7.4, 7.4] },
  { key: 'other', label: 'Other', tone: 'fourth', track: [25.2, 24.2, 23.1, 22.3, 21.9, 22.3, 22.6, 22.3, 22.3] },
].map(s => ({ ...s, points: SHARE_TIMES.map((t, i) => ({ t, value: s.track[i] })) }))

// Forty-two daily closes with their reported volume, a decline from day 6 to
// day 21 and a recovery on day 34 — the shape the price-history figure draws.
const LINE_PRICES = [
  3120, 3186, 3240, 3298, 3355, 3402, 3361, 3288, 3190, 3104, 3021, 2960, 2884, 2812,
  2760, 2705, 2688, 2641, 2604, 2570, 2538, 2496, 2544, 2611, 2688, 2742, 2810, 2879,
  2944, 3011, 3086, 3140, 3212, 3288, 3410, 3388, 3441, 3496, 3522, 3489, 3540, 3588,
]
const LINE_POINTS = LINE_PRICES.map((price, i) => ({
  t: T0 + i * DAY,
  value: price,
  secondary: Math.round((9 + ((i * 7) % 11)) * 1_000_000_000 * (1 + (i % 5) * 0.12)),
}))
const LINE_SPANS = [{ from: T0 + DAY * 6, to: T0 + DAY * 21, tone: 'red', label: 'Deepest decline: -25.7%' }]
const LINE_MARKS = [{ t: T0 + DAY * 34, tone: 'green', label: 'Back at the previous peak' }]

// Realized gains for one cohort: five loss bins, five gain bins, no bin crossing
// zero, and a measured range nobody landed in (-180 to -60) kept as an empty bar
// rather than dropped. The widest gain bin is one magnitude, so its two edges are
// the same number and it is named by that single edge.
const HISTOGRAM = [
  { from: -4200, to: -1400, count: 3, tone: 'red' },
  { from: -1400, to: -520, count: 6, tone: 'red' },
  { from: -520, to: -180, count: 4, tone: 'red' },
  { from: -180, to: -60, count: 0, tone: 'red' },
  { from: -60, to: -12, count: 2, tone: 'red' },
  { from: 15, to: 90, count: 5, tone: 'green' },
  { from: 90, to: 340, count: 9, tone: 'green' },
  { from: 340, to: 1250, count: 7, tone: 'green' },
  { from: 1250, to: 4800, count: 0, tone: 'green' },
  { from: 9600, to: 9600, count: 1, tone: 'green' },
]

const SPARKS = [
  { key: 'BTC', label: 'BTC', tone: 'accent', values: [64100, 64980, 63120, 65340, 66800, 66210, 68040] },
  { key: 'ETH', label: 'ETH', tone: 'blue', values: [3120, 3080, 3190, 3240, 3160, 3210, 3305] },
  { key: 'SOL', label: 'SOL', tone: 'green', values: [148, 151, 143, 139, 146, 152, 157] },
]

const zeroTree = node => ({
  ...node,
  value: node.value == null ? undefined : 0,
  children: Array.isArray(node.children) ? node.children.map(zeroTree) : undefined,
})

const SAMPLES = {
  populated: {
    gaugeValue: 72,
    dominance: DOMINANCE,
    sunburst: SUNBURST,
    polar: POLAR,
    regime: REGIME,
    bump: BUMP_SERIES,
    heat: HEAT,
    share: SHARE_SERIES,
    sparks: SPARKS,
    line: LINE_POINTS,
    histogram: HISTOGRAM,
  },
  zero: {
    gaugeValue: 0,
    dominance: DOMINANCE.map(d => ({ ...d, value: 0 })),
    sunburst: zeroTree(SUNBURST),
    polar: POLAR.map(p => ({ ...p, value: 0 })),
    regime: REGIME.map(r => ({ ...r, value: 0 })),
    bump: BUMP_SERIES.map(s => ({ ...s, points: s.points.map(p => ({ ...p, rank: 1 })) })),
    heat: HEAT.map(c => ({ ...c, value: 0 })),
    share: SHARE_SERIES.map(s => ({ ...s, points: s.points.map(p => ({ ...p, value: 0 })) })),
    sparks: SPARKS.map(s => ({ ...s, values: s.values.map(() => 0) })),
    line: LINE_POINTS.map(p => ({ ...p, value: 0, secondary: 0 })),
    // Every bin measured, nobody in any of them: ten zero-height bars on their
    // own edges, never a blank plot.
    histogram: HISTOGRAM.map(b => ({ ...b, count: 0 })),
  },
}

// Route: /intel/lab/charts. Every chart in src/intel/charts rendered against
// recorded values, an all-zero set and a failed read. Super admin only.
export default function ChartLabPage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { isSuperAdmin } = useProfile()
  const [mode, setMode] = useState('populated')
  const [selected, setSelected] = useState(null)
  const ribbonHost = useRef(null)
  const [ribbonWidth, setRibbonWidth] = useState(0)

  // The ribbon sits under another chart and takes that chart's viewport width.
  useEffect(() => {
    const host = ribbonHost.current
    if (!host || typeof ResizeObserver !== 'function') return undefined
    const observer = new ResizeObserver(entries => {
      const next = Math.round(entries[0]?.contentRect?.width || 0)
      setRibbonWidth(prev => (prev === next ? prev : next))
    })
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  const failed = mode === 'error'
  const data = SAMPLES[failed ? 'populated' : mode] || SAMPLES.populated
  const state = failed ? 'error' : 'ready'
  const reason = failed ? t('lab.charts_reason', { defaultValue: 'The provider returned no response for this period.' }) : undefined
  const pick = label => value => setSelected(`${label}: ${value?.label ?? value?.name ?? value?.key ?? '—'}`)

  const domain = useMemo(() => ({ from: REGIME[0].from, to: REGIME.at(-1).to }), [])

  if (!isSuperAdmin) return <Navigate to="/intel" replace />

  return (
    <IntelPageShell>
      <IntelPageHeader
        eyebrow="Internal"
        title={t('lab.charts_title', { defaultValue: 'Chart lab' })}
        subtitle={t('lab.charts_sub', { defaultValue: 'Every chart in the shared kit, rendered against recorded values, an all-zero set and a failed read. Super admin only.' })}
      />

      <div className="intel-investigation-controls">
        <label>
          {t('lab.charts_dataset', { defaultValue: 'Sample data set' })}
          <select value={mode} onChange={event => { setMode(event.target.value); setSelected(null) }}>
            <option value="populated">{t('lab.charts_dataset_populated', { defaultValue: 'Recorded observations' })}</option>
            <option value="zero">{t('lab.charts_dataset_zero', { defaultValue: 'All-zero observations' })}</option>
            <option value="error">{t('lab.charts_dataset_error', { defaultValue: 'Failed read' })}</option>
          </select>
        </label>
        <p className="intel-analysis-caption" aria-live="polite">
          {t('lab.charts_selected', { defaultValue: 'Last selection' })}: {selected || t('lab.charts_selected_none', { defaultValue: 'Nothing selected yet.' })}
        </p>
      </div>

      <RadialGauge
        title={t('lab.charts_gauge_title', { defaultValue: 'Fear and greed' })}
        description={t('lab.charts_gauge_sub', { defaultValue: 'Composite sentiment reading on its published 0–100 scale.' })}
        value={data.gaugeValue} min={0} max={100} zones={GAUGE_ZONES}
        formatValue={v => Number(v).toFixed(0)}
        state={state} reason={reason} onSelect={pick('Gauge zone')}
      />

      <RadialBars
        title={t('lab.charts_radial_title', { defaultValue: 'Dominance by segment' })}
        description={t('lab.charts_radial_sub', { defaultValue: "Each arc is that segment's share against the largest recorded share." })}
        series={data.dominance.map(d => ({ ...d, max: 100 }))}
        formatValue={pct} state={state} reason={reason} onSelect={pick('Dominance')}
      />

      <Sunburst
        title={t('lab.charts_sunburst_title', { defaultValue: 'Tokenized equity breakdown' })}
        description={t('lab.charts_sunburst_sub', { defaultValue: 'Tokenized assets by underlying stock, issuer and token.' })}
        root={data.sunburst} depth={3} formatValue={usd}
        state={state} reason={reason} onSelect={pick('Sunburst arc')}
      />

      <PolarClock
        title={t('lab.charts_polar_title', { defaultValue: 'Liquidations by weekday' })}
        description={t('lab.charts_polar_sub', { defaultValue: 'Recorded liquidation totals by day of week.' })}
        period="7d" buckets={data.polar} formatValue={usd}
        state={state} reason={reason} onSelect={pick('Weekday')}
      />

      <div ref={ribbonHost}>
        <Ribbon
          title={t('lab.charts_ribbon_title', { defaultValue: 'Regime ribbon' })}
          description={t('lab.charts_ribbon_sub', { defaultValue: 'Recorded market regime over the period. Each segment keeps its own recorded start and end.' })}
          domain={domain} segments={data.regime} width={ribbonWidth || undefined} height={18}
          formatTime={day} formatValue={v => `${Number(v || 0)} d`}
          state={state} reason={reason} onSelect={pick('Regime')}
        />
      </div>

      <Bump
        title={t('lab.charts_bump_title', { defaultValue: 'Market cap rank movement' })}
        description={t('lab.charts_bump_sub', { defaultValue: 'Weekly rank over twelve weeks. A path that starts late is an entry; one that stops early is an exit.' })}
        series={data.bump} maxRank={8} formatTime={week}
        state={state} reason={reason} onHover={() => {}} onSelect={pick('Rank path')}
      />

      <HeatStrip
        title={t('lab.charts_heat_title', { defaultValue: 'Liquidation calendar' })}
        description={t('lab.charts_heat_sub', { defaultValue: 'Daily recorded liquidation totals over four weeks. Intensity is the share of the largest day.' })}
        cells={data.heat} columns={7} formatValue={usd} formatTime={day}
        state={state} reason={reason} onSelect={pick('Day')}
      />

      <StackedShare
        title={t('lab.charts_stacked_title', { defaultValue: 'Dominance share over time' })}
        description={t('lab.charts_stacked_sub', { defaultValue: 'Recorded share of total market capitalisation by segment.' })}
        series={data.share} formatTime={week}
        state={state} reason={reason} onSelect={pick('Share band')}
      />

      <LineArea
        title={t('lab.charts_linearea_title', { defaultValue: 'Price with volume, decline and recovery' })}
        description={t('lab.charts_linearea_sub', { defaultValue: 'Daily closes as the line, reported volume as the faint band along the bottom, the deepest decline shaded between its peak and trough, and the day the peak was regained marked.' })}
        points={data.line} spans={LINE_SPANS} marks={LINE_MARKS}
        valueLabel={t('lab.charts_linearea_value', { defaultValue: 'Close' })}
        secondaryLabel={t('lab.charts_linearea_secondary', { defaultValue: 'Volume' })}
        formatValue={usd} formatSecondary={usd} formatTime={day}
        state={state} reason={reason} onSelect={pick('Span or mark')}
      />

      <Histogram
        title={t('lab.charts_histogram_title', { defaultValue: 'Realized gains by size' })}
        description={t('lab.charts_histogram_sub', { defaultValue: 'Addresses by the size of the realized gain reported for them. Losses and gains are binned separately so no bin crosses zero, and a measured range nobody landed in stays as an empty bar.' })}
        bins={data.histogram} formatValue={usd} formatCount={v => `${Number(v || 0).toFixed(0)}`}
        state={state} reason={reason} onSelect={pick('Bin')}
      />

      <figure className="intel-chart intel-chart-kit">
        <figcaption>
          <span className="intel-chart-kit-title">{t('lab.charts_sparkline_title', { defaultValue: 'Sparklines' })}</span>
          <span className="intel-chart-kit-description">{t('lab.charts_sparkline_sub', { defaultValue: 'Inline lines with the latest observation emphasized. No table twin: the row around them carries the values.' })}</span>
        </figcaption>
        {failed ? (
          <p className="intel-chart-kit-state" role="alert">{t('charts.unavailable', { defaultValue: 'This chart could not be built.' })} {reason}</p>
        ) : (
          <table>
            <caption>{t('lab.charts_sparkline_title', { defaultValue: 'Sparklines' })}</caption>
            <thead>
              <tr>
                <th scope="col">{t('charts.legend', { defaultValue: 'Series' })}</th>
                <th scope="col" className="intel-number">{t('charts.value', { defaultValue: 'Value' })}</th>
                <th scope="col">{t('charts.time', { defaultValue: 'Time' })}</th>
              </tr>
            </thead>
            <tbody>
              {data.sparks.map(spark => (
                <tr key={spark.key}>
                  <th scope="row">{spark.label}</th>
                  <td className="intel-number">{Number(spark.values.at(-1)).toLocaleString()}</td>
                  <td><Sparkline values={spark.values} tone={spark.tone} ariaLabel={`${spark.label} recent observations`} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </figure>
    </IntelPageShell>
  )
}
