import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { readCaptureView, captureUnavailable, captureReasonText } from '../lib/capture-api'
import { useUrlState } from '../lib/useUrlState'
import { RadialGauge, Ribbon } from '../charts'
import { ChartFrame, ChartTable, useChartText } from '../charts/frame'
import { toneColor, gridStroke } from '../charts/theme'
import { clamp, fraction } from '../charts/geometry'

// Investor Intel — what regime the market has been in, read from the recorded
// CoinMarketCap captures (`intel-capture`, view `regime`). Fear/greed is a band
// of colour, altcoin season is a second band, BTC dominance is a line drawn over
// the same time axis, and the latest reading of each is a gauge beside them.
//
// Plain figures from the shared kit — no cards, no pills, no chips. Every colour
// is a workspace token: the published fear/greed CLASS picks its tone by its
// POSITION in the ordered scale below, never by a literal colour.
//
// Zero is a reading. A fear/greed of 0 draws as 0 and prints as "0"; only a
// missing observation is a gap, and only a thrown read is "unavailable".

export const REGIME_RANGES = ['7d', '30d', '90d', '1y']
export const DEFAULT_REGIME_RANGE = '30d'
const RANGE_DEFAULTS = { r_range: DEFAULT_REGIME_RANGE }

// Ordered fear → greed scale. Index 0 is the most fearful class.
const FEAR_GREED_CLASSES = ['extreme_fear', 'fear', 'neutral', 'greed', 'extreme_greed']
const FEAR_GREED_TONES = ['red', 'yellow', 'muted', 'green', 'accent']
const FEAR_GREED_LABELS = ['Extreme fear', 'Fear', 'Neutral', 'Greed', 'Extreme greed']
// Upper bound of every class but the last, used only when the provider did not
// publish a class name for a capture it did publish a value for.
const FEAR_GREED_BOUNDS = [25, 45, 55, 75]

// Ordered bitcoin → altcoin scale, same rule.
const ALTCOIN_CLASSES = ['bitcoin_season', 'mixed', 'altcoin_season']
const ALTCOIN_TONES = ['accent', 'muted', 'blue']
const ALTCOIN_LABELS = ['Bitcoin season', 'Mixed', 'Altcoin season']
const ALTCOIN_BOUNDS = [25, 75]

// The three gauges share one row until the viewport can no longer hold a
// readable arc; auto-fit then drops to two and finally to one column.
const ROW = { display: 'grid', gap: '1.25rem 2.5rem', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 15rem), 1fr))', alignItems: 'start' }

const num = value => { if (value == null || value === '' || typeof value === 'boolean') return null; const n = Number(value); return Number.isFinite(n) ? n : null }
const scaleIndex = (bounds, value) => { const i = bounds.findIndex(bound => value < bound); return i === -1 ? bounds.length : i }
const normalizeClass = raw => String(raw ?? '').trim().toLowerCase().replace(/[^a-z]+/g, '_').replace(/^_+|_+$/g, '')

/** The published class, or — when only a value was published — the class its
 *  value falls in. null when the capture carried neither. */
export function fearGreedClassKey(point) {
  const named = normalizeClass(point?.fearGreedClass)
  if (FEAR_GREED_CLASSES.includes(named)) return named
  const value = num(point?.fearGreed)
  return value == null ? null : FEAR_GREED_CLASSES[scaleIndex(FEAR_GREED_BOUNDS, value)]
}

export function altcoinClassKey(point) {
  const value = num(point?.altcoinSeason)
  return value == null ? null : ALTCOIN_CLASSES[scaleIndex(ALTCOIN_BOUNDS, value)]
}

const toneFor = (classes, tones, key) => tones[classes.indexOf(key)] || 'muted'

// The gauge zones ARE the scale above, so the ribbon and every other surface
// that shows a fear/greed or altcoin-season reading share one definition.
export const fearGreedZones = t => FEAR_GREED_BOUNDS.concat(100).map((to, i) => ({
  to, tone: FEAR_GREED_TONES[i], label: t(`regime.fg_${FEAR_GREED_CLASSES[i]}`, { defaultValue: FEAR_GREED_LABELS[i] }),
}))
export const altcoinZones = t => ALTCOIN_BOUNDS.concat(100).map((to, i) => ({
  to, tone: ALTCOIN_TONES[i], label: t(`regime.alt_${ALTCOIN_CLASSES[i]}`, { defaultValue: ALTCOIN_LABELS[i] }),
}))

/** Median gap between consecutive captures; the last band is given this width so
 *  the newest observation is visible instead of a zero-width sliver. */
function medianStep(stamps) {
  const gaps = []
  for (let i = 1; i < stamps.length; i += 1) { const gap = stamps[i] - stamps[i - 1]; if (gap > 0) gaps.push(gap) }
  if (!gaps.length) return 3_600_000
  gaps.sort((a, b) => a - b)
  return gaps[Math.floor(gaps.length / 2)]
}

/** Consecutive captures that published the same class become one band. A band
 *  keeps the recorded start of its first capture and the recorded start of the
 *  next band as its end, so no time is invented between two observations. */
export function classBands(series = [], keyOf) {
  const points = (Array.isArray(series) ? series : [])
    .map(point => ({ at: Date.parse(point?.capturedAt), point, key: keyOf(point) }))
    .filter(entry => Number.isFinite(entry.at))
    .sort((a, b) => a.at - b.at)
  if (!points.length) return []
  const step = medianStep(points.map(entry => entry.at))
  const bands = []
  points.forEach((entry, i) => {
    const end = i + 1 < points.length ? points[i + 1].at : entry.at + step
    const last = bands[bands.length - 1]
    if (last && last.key === entry.key) { last.to = end; last.point = entry.point; last.count += 1; return }
    bands.push({ key: entry.key, from: entry.at, to: end, point: entry.point, count: 1 })
  })
  return bands
}

/** { t, value } pairs for one numeric field, in capture order. */
export function fieldLine(series = [], field) {
  return (Array.isArray(series) ? series : [])
    .map(point => ({ at: Date.parse(point?.capturedAt), value: num(point?.[field]) }))
    .filter(entry => Number.isFinite(entry.at) && entry.value != null)
    .sort((a, b) => a.at - b.at)
}

const LINE_HEIGHT = 56

// A line drawn over the same time axis as the bands above it. The kit's Ribbon
// owns its own <svg>, so the dominance track is its own figure in the same frame
// rather than a measured overlay painted into another figure's internals.
function DominanceLine({ title, description, points = [], domain, width, state = 'ready', reason, formatValue, formatTime }) {
  const t = useChartText()
  const w = Number(width) > 0 ? Number(width) : 640
  const h = LINE_HEIGHT
  const from = Number(domain?.from), to = Number(domain?.to)
  const span = Number.isFinite(from) && Number.isFinite(to) && to > from ? to - from : 0
  const values = points.map(point => point.value)
  const lo = values.length ? Math.min(...values) : 0
  const hi = values.length ? Math.max(...values) : 0
  // A flat track is a real reading: keep it on the mid-line rather than dividing
  // by a zero span.
  const pad = hi === lo ? 1 : (hi - lo) * 0.15
  const x = at => (span ? clamp((at - from) / span, 0, 1) * w : 0)
  const y = value => h - 4 - fraction(value, lo - pad, hi + pad) * (h - 8)
  const path = points.map((point, i) => `${i ? 'L' : 'M'} ${x(point.at).toFixed(1)} ${y(point.value).toFixed(1)}`).join(' ')
  const last = points[points.length - 1]

  return (
    <ChartFrame
      t={t} title={title} description={description} state={state} reason={reason}
      table={
        <ChartTable
          t={t} caption={title}
          columns={[t('charts.time', { defaultValue: 'Time' }), t('charts.value', { defaultValue: 'Value' })]}
          rows={points.map(point => [formatTime(point.at), formatValue(point.value)])}
        />
      }
    >
      <svg viewBox={`0 0 ${w} ${h}`} role="img" preserveAspectRatio="none"
        style={{ width: Number(width) > 0 ? `${w}px` : '100%', maxWidth: '100%', height: `${h}px` }}
        aria-label={`${title}. ${points.length ? formatValue(last.value) : ''} ${t('charts.show_as_table', { defaultValue: 'Show as table' })}`}>
        <rect x="0" y="0" width={w} height={h} fill="none" stroke={gridStroke} />
        {path ? <path d={path} fill="none" stroke={toneColor('accent')} strokeWidth="1.5" /> : null}
        {last ? <circle cx={x(last.at)} cy={y(last.value)} r="3" fill={toneColor('accent')} /> : null}
      </svg>
    </ChartFrame>
  )
}

export default function RegimeRibbon({ compact = false, onLoad = null }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase } = useSupabase()
  const [urlState, setUrlState] = useUrlState(RANGE_DEFAULTS)
  // The compact mount on Markets has no range control, so it never reads the
  // shared URL parameter the full page owns.
  const range = compact ? DEFAULT_REGIME_RANGE : (REGIME_RANGES.includes(urlState.r_range) ? urlState.r_range : DEFAULT_REGIME_RANGE)

  const [payload, setPayload] = useState(null)
  const [failed, setFailed] = useState(null)
  const [loading, setLoading] = useState(true)
  const host = useRef(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const node = host.current
    if (!node || typeof ResizeObserver !== 'function') return undefined
    const observer = new ResizeObserver(entries => {
      const next = Math.round(entries[0]?.contentRect?.width || 0)
      setWidth(prev => (prev === next ? prev : next))
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let alive = true
    setLoading(true)
    setFailed(null)
    readCaptureView('regime', { range }, { orgId: org?.id || undefined, supabase })
      .then(data => { if (alive) { setPayload(data); setFailed(null) } })
      .catch(error => { if (alive) { setPayload(null); setFailed(captureUnavailable(error)) } })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [range, org?.id, supabase])

  // Reported through a ref so a parent passing an inline callback cannot turn
  // this into a render loop.
  const report = useRef(onLoad)
  report.current = onLoad
  useEffect(() => { report.current?.({ payload, unavailable: failed, loading, range }) }, [payload, failed, loading, range])

  const series = useMemo(() => (Array.isArray(payload?.series) ? payload.series : []), [payload])
  // The server reports a failed read as a `reason` on an otherwise empty body;
  // that is unavailable, not empty.
  const unavailable = failed || (payload?.reason ? { state: 'unavailable', reason: payload.reason } : null)
  const reason = unavailable ? captureReasonText(t, unavailable.reason) : undefined
  const state = unavailable ? 'error' : (loading && !payload) || !series.length ? 'empty' : 'ready'

  const fearBands = useMemo(() => classBands(series, fearGreedClassKey), [series])
  const altBands = useMemo(() => classBands(series, altcoinClassKey), [series])
  const dominance = useMemo(() => fieldLine(series, 'btcDominance'), [series])
  const latest = series[series.length - 1] || null

  const domain = useMemo(() => {
    const ends = [...fearBands, ...altBands]
    if (!ends.length) return { from: 0, to: 0 }
    return { from: Math.min(...ends.map(band => band.from)), to: Math.max(...ends.map(band => band.to)) }
  }, [fearBands, altBands])

  const clock = value => {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? String(value ?? '—') : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
  }
  const day = value => {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? String(value ?? '—') : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }
  const index = value => (num(value) == null ? '—' : Number(value).toFixed(0))
  const share = value => (num(value) == null ? '—' : `${Number(value).toFixed(1)}%`)

  // Every figure names the clock of the observation it is showing: the provider's
  // own clock when one was published, otherwise the capture clock, labelled as
  // what it is.
  const clockCaption = point => {
    if (!point) return t('regime.no_clock', { defaultValue: 'No observation clock has been recorded yet.' })
    if (point.observedAt) return t('regime.observed_at', { time: clock(point.observedAt), defaultValue: 'Provider clock: {{time}}' })
    if (point.capturedAt) return t('regime.captured_at', { time: clock(point.capturedAt), defaultValue: 'No provider clock was published; captured {{time}}' })
    return t('regime.no_clock', { defaultValue: 'No observation clock has been recorded yet.' })
  }

  const gaugeState = value => (unavailable ? 'error' : num(value) == null ? 'empty' : 'ready')
  const height = compact ? 112 : 168

  const fearZones = fearGreedZones(t)
  const altZones = altcoinZones(t)

  const segmentsOf = (bands, classes, tones, labels, prefix, field) => bands.map(band => ({
    from: band.from,
    to: band.to,
    value: num(band.point?.[field]),
    tone: band.key ? toneFor(classes, tones, band.key) : 'muted',
    label: band.key
      ? t(`regime.${prefix}_${band.key}`, { defaultValue: labels[classes.indexOf(band.key)] })
      : t('regime.class_unknown', { defaultValue: 'No class published' }),
  }))

  const coverage = payload?.coverage || null
  const coverageLine = coverage && coverage.count
    ? t('regime.coverage', {
        count: coverage.count, from: day(coverage.from), to: day(coverage.to),
        defaultValue: '{{count}} captures recorded · {{from}} → {{to}}',
      })
    : t('regime.coverage_none', { defaultValue: 'No captures have been recorded for this period yet.' })

  return (
    <section className="intel-regime-ribbon space-y-3" aria-label={t('regime.figures', { defaultValue: 'Market regime figures' })}>
      <div className="eyebrow">{t('regime.eyebrow', { defaultValue: 'Market regime' })}</div>

      {compact ? null : (
        <div className="intel-investigation-controls">
          <label>
            {t('regime.range_label', { defaultValue: 'Period' })}
            <select value={range} onChange={event => setUrlState({ r_range: event.target.value })}>
              {REGIME_RANGES.map(value => (
                <option key={value} value={value}>{t(`regime.range_${value}`, { defaultValue: value })}</option>
              ))}
            </select>
          </label>
          <p className="intel-analysis-caption">
            {coverageLine}
            {coverage?.truncated ? ` · ${t('regime.coverage_truncated', { defaultValue: 'The oldest captures beyond the read limit are not shown.' })}` : ''}
          </p>
        </div>
      )}

      {loading && !payload ? (
        <p role="status" className="text-[12px] text-[var(--fg-4)]">{t('regime.loading', { defaultValue: 'Loading recorded market captures…' })}</p>
      ) : null}

      <div ref={host}>
        <Ribbon
          title={t('regime.alt_title', { defaultValue: 'Altcoin season' })}
          description={t('regime.alt_sub', { defaultValue: 'The same captures read on the bitcoin-to-altcoin scale.' })}
          domain={domain}
          segments={segmentsOf(altBands, ALTCOIN_CLASSES, ALTCOIN_TONES, ALTCOIN_LABELS, 'alt', 'altcoinSeason')}
          width={width || undefined} height={compact ? 14 : 20}
          formatTime={day} formatValue={index}
          state={state} reason={reason}
        />
        <DominanceLine
          title={t('regime.dominance_title', { defaultValue: 'BTC dominance' })}
          description={t('regime.dominance_sub', { defaultValue: 'The recorded bitcoin share of total market capitalisation, over the same period and the same time axis as the bands above.' })}
          points={dominance} domain={domain} width={width || undefined}
          formatTime={day} formatValue={share}
          state={unavailable ? 'error' : dominance.length ? 'ready' : 'empty'} reason={reason}
        />
      </div>

      <div style={ROW}>
        <RadialGauge
          title={t('regime.fg_gauge_title', { defaultValue: 'Fear and Greed' })}
          description={clockCaption(latest)}
          value={num(latest?.fearGreed) ?? 0} min={0} max={100} zones={fearZones}
          formatValue={index} height={height}
          state={gaugeState(latest?.fearGreed)} reason={reason}
        />
        <RadialGauge
          title={t('regime.alt_gauge_title', { defaultValue: 'Altcoin Season' })}
          description={clockCaption(latest)}
          value={num(latest?.altcoinSeason) ?? 0} min={0} max={100} zones={altZones}
          formatValue={index} height={height}
          state={gaugeState(latest?.altcoinSeason)} reason={reason}
        />
        <RadialGauge
          title={t('regime.dom_gauge_title', { defaultValue: 'BTC Dominance' })}
          description={clockCaption(latest)}
          value={num(latest?.btcDominance) ?? 0} min={0} max={100} zones={[]}
          formatValue={share} height={height}
          state={gaugeState(latest?.btcDominance)} reason={reason}
        />
      </div>

      {compact ? (
        <p className="text-[12px]">
          <Link className="intel-text-link" to="/intel/regime">
            {t('regime.open_page', { defaultValue: 'Open the market regime workspace' })}
          </Link>
        </p>
      ) : null}
    </section>
  )
}
