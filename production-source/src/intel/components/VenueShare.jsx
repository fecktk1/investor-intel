import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import BoardTableHeader from './BoardTableHeader'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { StackedShare, RadialBars, Sparkline } from '../charts'
import { readCaptureView, captureUnavailable, captureReasonText } from '../lib/capture-api'
import { useUrlState } from '../lib/useUrlState'
import { formatUsd, formatCompact } from '../lib/market-format'

// Venue share history (CMC plan proposal 16). Where reported volume actually
// sits, day by day, and whether that concentration is moving.
//
// Two honesties the figure is built around:
//
//  1. On the current plan only the DERIVATIVES half has rows. The spot lane is a
//     reported gap, and the capture answers a spot read with an empty series and
//     a reason. That is stated in a sentence, never drawn as a flat chart.
//  2. A share chart that silently drops the venues outside its top list is wrong
//     on every remaining band. The read already names the ten largest venues of
//     the newest captured day and folds every other venue into its own `other`,
//     so each day still closes at 100% — this component re-derives none of it.
//
// Shapes are `readVenueShare` in
// supabase/functions/_shared/intel/capture-venues-read.ts. Three traps live in
// there: a `shares` entry carries no slug (slugs come from `exchanges[]` and
// `pairs[]` by exchangeId), `sharePct` is on 0-100 and is NULL for a venue the
// day never captured (an absence, never a zero), and `other` is an object
// { value, sharePct, venues }, not a number. The backend's default kind is
// 'spot', so the kind is always sent rather than left to the default.

const DAYS = [30, 90, 365]
const DEFAULT_DAYS = 90
const KINDS = ['derivatives', 'spot']
// The plan records derivatives; spot is the gap, so the recorded half opens.
const DEFAULT_KIND = 'derivatives'
const TOP_VENUES = 10
// RadialBars steps the radius inward per series, so past five rings the arcs
// collide. The ring names five venues and the table twin carries them all.
const OI_RINGS = 5
// Hoisted so useUrlState's memo/callback identities stay stable across renders.
const URL_DEFAULTS = { vs_days: String(DEFAULT_DAYS), vs_kind: DEFAULT_KIND }

const num = value => {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

// `snapshot_date` is a provider CALENDAR DAY, not an instant: '2026-09-15'
// parses as UTC midnight, and formatting it in the reader's zone prints it as
// "Sep 14" for every reader west of Greenwich. The axis is formatted in UTC so a
// captured day reads as the day the provider stamped it, in every zone.
export const dayLabel = ms => {
  const date = new Date(Number(ms))
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

const pctValue = value => {
  const n = num(value)
  return n == null ? '—' : `${n.toFixed(1)}%`
}

// Captured days oldest first. A row without a parsable date is not a day.
function captureDays(series = []) {
  return (Array.isArray(series) ? series : [])
    .map(row => ({
      at: Date.parse(row?.date),
      shares: Array.isArray(row?.shares) ? row.shares : [],
      other: row?.other && typeof row.other === 'object' ? row.other : null,
    }))
    .filter(day => Number.isFinite(day.at))
    .sort((a, b) => a.at - b.at)
}

// A `shares` entry carries an exchangeId and nothing else identifying; the slug
// lives on `exchanges[]` (the newest day's top ten) and on `pairs[]`. A venue
// with no slug in either is labelled by its id rather than left blank.
export function venueSlugs({ exchanges = [], pairs = [] } = {}) {
  const map = new Map()
  for (const row of [
    ...(Array.isArray(exchanges) ? exchanges : []),
    ...(Array.isArray(pairs) ? pairs : []),
  ]) {
    if (row?.exchangeId == null) continue
    const key = String(row.exchangeId)
    if (!map.has(key) && row?.exchangeSlug) map.set(key, row.exchangeSlug)
  }
  return map
}

// One band per venue the read named, in the order it named them (the newest
// day's volume order), plus its own remainder. Nothing is re-ranked and nothing
// is re-bucketed here: the capture already decided which ten are named.
//
// A null sharePct is a venue that day's capture never saw. It becomes no point
// at all rather than a zero, so the table twin cannot read an absence as a
// venue that traded nothing.
export function venueBands(series = [], { slugs = new Map(), otherLabel = 'Other venues' } = {}) {
  const days = captureDays(series)
  if (!days.length) return []
  const order = []
  const seen = new Set()
  for (const day of [...days].reverse()) {
    for (const row of day.shares) {
      if (row?.exchangeId == null) continue
      const key = String(row.exchangeId)
      if (!seen.has(key)) { seen.add(key); order.push(key) }
    }
  }
  const bands = order
    .map(key => ({
      key,
      label: slugs.get(key) || key,
      points: days
        .map(day => ({ t: day.at, value: num(day.shares.find(row => String(row?.exchangeId) === key)?.sharePct) }))
        .filter(point => point.value != null),
    }))
    .filter(band => band.points.length)
  const other = days
    .map(day => ({ t: day.at, value: num(day.other?.sharePct) }))
    .filter(point => point.value != null && point.value > 0)
  if (other.length) bands.push({ key: '__other', label: otherLabel, tone: 'muted', points: other })
  return bands
}

// Newest captured open-interest day as concentric arcs. sharePct already arrives
// on 0-100, so each arc is read against a fixed 100 and stays comparable between
// reads. A venue with no reported OI share that day is not an arc.
export function oiRing(oiSeries = [], { slugs = new Map(), top = OI_RINGS } = {}) {
  const latest = captureDays(oiSeries).at(-1)
  if (!latest) return []
  return latest.shares
    .filter(row => row?.exchangeId != null && num(row?.sharePct) != null)
    .map(row => ({
      key: String(row.exchangeId),
      label: slugs.get(String(row.exchangeId)) || String(row.exchangeId),
      value: num(row.sharePct),
      max: 100,
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, Math.max(0, top))
}

// The table twin reads `exchanges[]` — the newest day's top ten, already in
// volume order — and hangs each venue's market-pair trace off `pairs[]`. A
// point the capture reported as null is a day with no pair count, not a zero.
export function venueRows(exchanges = [], pairs = []) {
  const traces = new Map()
  for (const venue of (Array.isArray(pairs) ? pairs : [])) {
    if (venue?.exchangeId == null) continue
    traces.set(String(venue.exchangeId), (Array.isArray(venue.points) ? venue.points : [])
      .map(point => ({ at: Date.parse(point?.date), value: num(point?.numMarketPairs) }))
      .filter(point => Number.isFinite(point.at) && point.value != null)
      .sort((a, b) => a.at - b.at)
      .map(point => point.value))
  }
  return (Array.isArray(exchanges) ? exchanges : [])
    .filter(row => row?.exchangeId != null)
    .map(row => ({
      key: String(row.exchangeId),
      label: row?.exchangeSlug || String(row.exchangeId),
      sharePct: num(row?.sharePct),
      volume24h: num(row?.volume24h),
      openInterest: num(row?.openInterest),
      oiSharePct: num(row?.oiSharePct),
      numMarketPairs: num(row?.numMarketPairs),
      pairs: traces.get(String(row.exchangeId)) || [],
    }))
}

export default function VenueShare() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  // Service-role capture tables: the read travels on the reader's authenticated
  // client, never the anonymous one.
  const { supabase } = useSupabase()
  const orgId = org?.id || null
  const [urlState, setUrlState] = useUrlState(URL_DEFAULTS)
  const days = DAYS.includes(Number(urlState.vs_days)) ? Number(urlState.vs_days) : DEFAULT_DAYS
  const kind = KINDS.includes(String(urlState.vs_kind)) ? String(urlState.vs_kind) : DEFAULT_KIND
  const [read, setRead] = useState({ status: 'loading', payload: null, reason: null })

  useEffect(() => {
    const controller = new AbortController()
    let alive = true
    setRead({ status: 'loading', payload: null, reason: null })
    readCaptureView('venue_share', { days, kind }, { orgId, signal: controller.signal, supabase })
      .then(payload => { if (alive) setRead({ status: 'ready', payload, reason: null }) })
      .catch(error => { if (alive) setRead({ status: 'unavailable', payload: null, reason: captureUnavailable(error).reason }) })
    return () => { alive = false; controller.abort() }
  }, [orgId, days, kind, supabase])

  const payload = read.payload
  const slugs = useMemo(() => venueSlugs(payload || {}), [payload])
  const bands = useMemo(
    () => venueBands(payload?.series, { slugs, otherLabel: t('structure.vs_other', { defaultValue: 'Other venues' }) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [payload, slugs],
  )
  const rings = useMemo(() => oiRing(payload?.oiSeries, { slugs }), [payload, slugs])
  const rows = useMemo(() => venueRows(payload?.exchanges, payload?.pairs), [payload])

  const failed = read.status === 'unavailable'
  const drawn = bands.some(band => band.points.some(point => (num(point.value) ?? 0) > 0))
  const state = failed ? 'error' : (read.status === 'ready' && drawn) ? 'ready' : 'empty'
  const oiState = failed ? 'error' : (read.status === 'ready' && rings.length) ? 'ready' : 'empty'
  const reason = read.reason ? captureReasonText(t, read.reason) : undefined

  // The capture reports its own gap. A spot read that comes back with no days is
  // the plan gap, and it is said in words rather than drawn as a flat chart.
  const gap = read.status === 'ready' && !drawn && kind === 'spot'
  const reported = read.status === 'ready' && payload?.reason ? captureReasonText(t, payload.reason) : null

  const kindLabel = value => (value === 'spot'
    ? t('structure.vs_kind_spot', { defaultValue: 'Spot' })
    : t('structure.vs_kind_derivatives', { defaultValue: 'Derivatives' }))

  const caption = t('structure.vs_caption', {
    defaultValue: 'Provider-reported venue volume on the daily capture clock, not an exchange tape.',
  })

  const columns = [
    t('structure.vs_col_venue', { defaultValue: 'Venue' }),
    t('structure.vs_col_share', { defaultValue: 'Share' }),
    t('structure.vs_col_volume', { defaultValue: '24h volume' }),
    t('structure.vs_col_oi', { defaultValue: 'Open interest' }),
    t('structure.vs_col_pairs', { defaultValue: 'Market pairs' }),
    t('structure.vs_col_trend', { defaultValue: 'Pairs trend' }),
  ]

  return (
    <section className="intel-structure-venue space-y-3" aria-label={t('structure.vs_title', { defaultValue: 'Venue share' })}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]" role="group" aria-label={t('structure.vs_kind', { defaultValue: 'Market' })}>
        <span className="text-[var(--fg-4)]">{t('structure.vs_kind', { defaultValue: 'Market' })}</span>
        {KINDS.map(value => (
          <button
            key={value}
            type="button"
            aria-pressed={value === kind}
            onClick={() => setUrlState({ vs_kind: value })}
            className={value === kind
              ? 'text-[var(--fg-1)] underline underline-offset-4'
              : 'text-[var(--fg-4)] hover:text-[var(--fg-2)]'}
          >
            {kindLabel(value)}
          </button>
        ))}
      </div>

      <StackedShare
        title={t('structure.vs_title', { defaultValue: 'Venue share' })}
        description={`${t('structure.vs_sub', {
          kind: kindLabel(kind).toLowerCase(),
          top: TOP_VENUES,
          days,
          defaultValue: 'Daily share of reported {{kind}} volume per venue across {{days}} days. The read names the {{top}} largest venues of the newest captured day and folds every other venue into one remainder, so each day still closes at 100%.',
        })} ${caption}`}
        series={bands}
        formatTime={dayLabel}
        state={state}
        reason={reason}
      />

      {gap ? (
        <p className="text-[12px] text-[var(--fg-3)]" role="status">
          {t('structure.vs_spot_gap', {
            defaultValue: 'Spot venue share is not available on this plan: the capture returned no spot days. Derivatives is the half that is recorded — select it to read the share.',
          })}
          {reported ? ` ${t('structure.vs_reported', { reason: reported, defaultValue: 'The capture reported: {{reason}}' })}` : ''}
        </p>
      ) : reported ? (
        <p className="text-[12px] text-[var(--fg-4)]" role="status">
          {t('structure.vs_reported', { reason: reported, defaultValue: 'The capture reported: {{reason}}' })}
        </p>
      ) : null}

      <div className="grid gap-x-8 gap-y-3 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] items-start">
        <RadialBars
          title={t('structure.vs_oi_title', { defaultValue: 'Open interest share' })}
          description={t('structure.vs_oi_sub', {
            top: OI_RINGS,
            defaultValue: 'Share of reported open interest on the newest captured day, for the {{top}} largest venues.',
          })}
          series={rings}
          formatValue={pctValue}
          state={oiState}
          reason={reason}
        />
        {state === 'ready' && rows.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <caption className="text-left text-[11px] text-[var(--fg-4)] pb-2">
                {t('structure.vs_table_caption', {
                  volume: formatUsd(num(payload?.totalVolume24h)),
                  oi: formatUsd(num(payload?.totalOpenInterest)),
                  defaultValue: 'Newest captured day per venue. Reported 24h volume {{volume}}, open interest {{oi}}.',
                })}
              </caption>
              <thead>
                <BoardTableHeader columns={columns} numeric={[1, 2, 3, 4]} />
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.key}>
                    <th scope="row" className="text-left font-normal text-[var(--fg-2)] border-b border-[var(--border-default)] py-2 pr-3">{row.label}</th>
                    <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{pctValue(row.sharePct)}</td>
                    <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{formatUsd(row.volume24h)}</td>
                    <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{formatUsd(row.openInterest)}</td>
                    <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{formatCompact(row.numMarketPairs)}</td>
                    <td className="border-b border-[var(--border-default)] py-2 pr-3">
                      {row.pairs.length
                        ? <Sparkline values={row.pairs} ariaLabel={t('structure.vs_pairs_label', { venue: row.label, count: row.pairs.length, defaultValue: '{{venue}} market pairs over the last {{count}} captured days' })} />
                        : <span className="text-[var(--fg-4)]">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]" role="group" aria-label={t('structure.vs_window', { defaultValue: 'Window' })}>
        <span className="text-[var(--fg-4)]">{t('structure.vs_window', { defaultValue: 'Window' })}</span>
        {DAYS.map(value => (
          <button
            key={value}
            type="button"
            aria-pressed={value === days}
            onClick={() => setUrlState({ vs_days: String(value) })}
            className={value === days
              ? 'text-[var(--fg-1)] underline underline-offset-4'
              : 'text-[var(--fg-4)] hover:text-[var(--fg-2)]'}
          >
            {t('structure.vs_window_option', { days: value, defaultValue: '{{days}} days' })}
          </button>
        ))}
      </div>
    </section>
  )
}
