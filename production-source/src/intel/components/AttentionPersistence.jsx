import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { PolarClock, Sparkline } from '../charts'
import { readCaptureView, captureUnavailable, captureReasonText } from '../lib/capture-api'

// Attention persistence (CMC plan proposal 23). How LONG this asset has stayed
// on the provider's attention lists — trending, most visited, gainers, losers —
// rather than whether it appeared on one once.
//
// The read answers with the asset's own rows AND `captures` — every hourly
// capture stamp in the window, taken from the rank-1 row of each list. That
// second list is what keeps the two absences apart, and the component never
// infers observation from the asset's own rows:
//   * an hour IN `captures` where the asset appears on no list is a real "not
//     in the list";
//   * an hour missing from `captures` is "not captured", and stays a gap.
//
// The `attention` prop is an override for the chart lab and for tests; when it
// is supplied no read is spent.
//
// Appearing on an attention list is a measure of where readers are looking. It
// is not a valuation, a flow, or a forecast.

const HOUR_MS = 3600000
const HOURS = 24
export const ATTENTION_LISTS = ['trending', 'most_visited', 'gainers', 'losers']

const num = value => {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

const hourText = hour => `${String(hour).padStart(2, '0')}:00`
const floorHour = ms => Math.floor(ms / HOUR_MS) * HOUR_MS

const clockTime = value => {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString()
}

const emptyList = () => ({ buckets: [], present: 0, streak: 0 })

// Project the capture contract — { lists: { trending: [{ capturedAt, rank,
// timePeriod }] }, captures: [capturedAt…], asOf } — onto the last 24 hourly
// slots.
//
// Buckets are indexed BY HOUR OF DAY (0..23), not by how recent they are, so the
// clock's "now" marker lands on the reader's actual hour. A value of 1 is a
// capture that carried the asset, 0 is a capture that ran without it, and null
// is an hour with no capture at all.
//
// Observation comes from `captures`, never from the asset's own rows: an asset
// that is on no list for six hours was still captured for those six hours, and
// drawing that as a gap would be a different (and wrong) reading.
export function attentionClock(attention, hours = HOURS) {
  const lists = attention?.lists && typeof attention.lists === 'object' ? attention.lists : {}
  const seen = {}
  const stamps = []
  for (const key of ATTENTION_LISTS) {
    const map = new Map()
    for (const entry of Array.isArray(lists[key]) ? lists[key] : []) {
      const at = Date.parse(entry?.capturedAt)
      if (!Number.isFinite(at)) continue
      map.set(floorHour(at), num(entry?.rank))
      stamps.push(at)
    }
    seen[key] = map
  }
  const captured = new Set()
  for (const stamp of Array.isArray(attention?.captures) ? attention.captures : []) {
    const at = Date.parse(stamp)
    if (!Number.isFinite(at)) continue
    captured.add(floorHour(at))
    stamps.push(at)
  }
  const asOf = Date.parse(attention?.asOf)
  const newest = Number.isFinite(asOf) ? asOf : (stamps.length ? Math.max(...stamps) : NaN)
  if (!Number.isFinite(newest)) {
    return { slots: [], observedHours: 0, lists: Object.fromEntries(ATTENTION_LISTS.map(key => [key, emptyList()])) }
  }
  const end = floorHour(newest)
  const slots = Array.from({ length: hours }, (_, i) => end - (hours - 1 - i) * HOUR_MS)
  // A read that carried rows but no capture stamps is an older payload shape:
  // fall back to the asset's own hours rather than blanking every bucket.
  const observed = captured.size
    ? slots.map(slot => captured.has(slot))
    : slots.map(slot => ATTENTION_LISTS.some(key => seen[key].has(slot)))

  const projected = {}
  for (const key of ATTENTION_LISTS) {
    const cells = Array.from({ length: hours }, (_, hour) => ({ hour, label: hourText(hour), at: null, value: null, rank: null, observed: false }))
    slots.forEach((slot, index) => {
      const hour = new Date(slot).getHours() % hours
      const present = seen[key].has(slot)
      cells[hour] = {
        hour,
        label: hourText(hour),
        at: new Date(slot).toISOString(),
        value: observed[index] ? (present ? 1 : 0) : null,
        rank: present ? seen[key].get(slot) : null,
        observed: observed[index],
      }
    })
    let streak = 0
    for (let index = slots.length - 1; index >= 0; index -= 1) {
      if (!seen[key].has(slots[index])) break
      streak += 1
    }
    projected[key] = { buckets: cells, present: slots.filter(slot => seen[key].has(slot)).length, streak }
  }
  return { slots, observedHours: observed.filter(Boolean).length, lists: projected }
}

// This asset's weekly rank line out of the rank map capture. A rank map covers
// CoinMarketCap identities only, so a row is matched on the provider id and
// never on the symbol.
export function rankLine(payload, providerId) {
  const wanted = String(providerId ?? '')
  if (!wanted) return []
  const row = (Array.isArray(payload?.series) ? payload.series : [])
    .find(entry => String(entry?.providerId ?? '') === wanted)
  return (Array.isArray(row?.points) ? row.points : [])
    .map(point => ({ at: Date.parse(point?.date), rank: num(point?.rank) }))
    .filter(point => Number.isFinite(point.at) && point.rank != null)
    .sort((a, b) => a.at - b.at)
}

export default function AttentionPersistence({ sourceProvider, providerId, symbol, attention = null }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  // Capture tables are service-role only: the read travels on the reader's own
  // authenticated client.
  const { supabase } = useSupabase()
  const orgId = org?.id || null
  const cmc = sourceProvider === 'coinmarketcap' && providerId != null && providerId !== ''

  const [read, setRead] = useState({ status: 'idle', payload: null, reason: null })
  const [ranks, setRanks] = useState({ status: 'idle', payload: null, reason: null })

  // The attention read. A supplied `attention` prop is an override — the lab and
  // the tests draw from a fixture — and then no read is spent.
  useEffect(() => {
    if (!cmc || attention) { setRead({ status: 'idle', payload: null, reason: null }); return undefined }
    const controller = new AbortController()
    let alive = true
    setRead({ status: 'loading', payload: null, reason: null })
    readCaptureView('attention', { providerId, hours: HOURS }, { orgId, signal: controller.signal, supabase })
      .then(payload => { if (alive) setRead({ status: 'ready', payload, reason: payload?.reason ?? null }) })
      .catch(error => { if (alive) setRead({ status: 'unavailable', payload: null, reason: captureUnavailable(error).reason }) })
    return () => { alive = false; controller.abort() }
  }, [cmc, attention, orgId, providerId, supabase])

  // The weekly rank line is its own read, so a failing attention view never
  // takes the rank line down with it.
  useEffect(() => {
    if (!cmc) { setRanks({ status: 'idle', payload: null, reason: null }); return undefined }
    const controller = new AbortController()
    let alive = true
    setRanks({ status: 'loading', payload: null, reason: null })
    readCaptureView('rank_map', { limit: 25 }, { orgId, signal: controller.signal, supabase })
      .then(payload => { if (alive) setRanks({ status: 'ready', payload, reason: null }) })
      .catch(error => { if (alive) setRanks({ status: 'unavailable', payload: null, reason: captureUnavailable(error).reason }) })
    return () => { alive = false; controller.abort() }
  }, [cmc, orgId, providerId, supabase])

  const line = useMemo(() => rankLine(ranks.payload, providerId), [ranks.payload, providerId])
  const payload = attention || read.payload
  const clock = useMemo(() => attentionClock(payload), [payload])
  const failed = !attention && read.status === 'unavailable'
  const drawn = clock.slots.length > 0
  const name = symbol || String(providerId ?? '')

  const listLabel = key => ({
    trending: t('asset_attention.list_trending', { defaultValue: 'Trending' }),
    most_visited: t('asset_attention.list_most_visited', { defaultValue: 'Most visited' }),
    gainers: t('asset_attention.list_gainers', { defaultValue: 'Top gainers' }),
    losers: t('asset_attention.list_losers', { defaultValue: 'Top losers' }),
  }[key] || key)

  const presenceText = value => (value == null
    ? t('asset_attention.not_captured', { defaultValue: 'Not captured' })
    : value
      ? t('asset_attention.in_list', { defaultValue: 'In the list' })
      : t('asset_attention.out_of_list', { defaultValue: 'Not in the list' }))

  const caption = t('asset_attention.caption', {
    defaultValue: 'Hourly attention captures. An hour that was captured while this asset was on no list reads as not in the list; an hour with no capture at all stays a gap. Being on an attention list says where readers are looking; it is not a valuation.',
  })

  return (
    <section className="intel-asset-attention space-y-3" aria-label={t('asset_attention.title', { defaultValue: 'Attention persistence' })}>
      <div>
        <div className="eyebrow">{t('asset_attention.eyebrow', { defaultValue: 'Attention' })}</div>
        <h2 className="text-[15px] text-[var(--fg-1)]">{t('asset_attention.title', { defaultValue: 'Attention persistence' })}</h2>
        <p className="text-[12px] text-[var(--fg-4)]">
          {t('asset_attention.subtitle', { symbol: name, defaultValue: 'How many of the last 24 hourly captures carried {{symbol}} on each attention list, and how long the current run is.' })}
        </p>
      </div>

      {!cmc ? (
        <p className="text-[12px] text-[var(--fg-3)]" data-testid="attention-state">
          {t('asset_attention.not_cmc', { defaultValue: 'The attention captures cover CoinMarketCap identities only, so this asset has no attention record.' })}
        </p>
      ) : failed ? (
        <p className="text-[12px] text-[var(--fg-3)]" role="alert" data-testid="attention-state">
          {t('asset_attention.unavailable', { defaultValue: 'The attention captures could not be read.' })}{' '}
          {captureReasonText(t, read.reason)}
        </p>
      ) : drawn ? (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            {ATTENTION_LISTS.map(key => {
              const list = clock.lists[key] || emptyList()
              return (
                <div key={key} className="space-y-1">
                  <PolarClock
                    title={listLabel(key)}
                    description={`${t('asset_attention.list_sub', { symbol: name, list: listLabel(key), defaultValue: 'Hours of the last day in which the capture of {{list}} carried {{symbol}}.' })} ${caption}`}
                    period="24h"
                    buckets={list.buckets}
                    formatValue={presenceText}
                    state={list.buckets.length ? 'ready' : 'empty'}
                  />
                  <p className="text-[12px] text-[var(--fg-3)]" data-testid={`attention-figure-${key}`}>
                    {t('asset_attention.figure', {
                      present: list.present, hours: HOURS, streak: list.streak,
                      defaultValue: 'In {{present}} of the last {{hours}} captures · current run {{streak}} consecutive hours',
                    })}
                  </p>
                </div>
              )
            })}
          </div>
          <p className="text-[12px] text-[var(--fg-4)]">
            {clock.observedHours < HOURS
              ? t('asset_attention.observed', { observed: clock.observedHours, hours: HOURS, defaultValue: '{{observed}} of the last {{hours}} hours carry an attention capture; the rest are gaps.' })
              : t('asset_attention.observed_full', { hours: HOURS, defaultValue: 'All {{hours}} of the last hours carry an attention capture.' })}
            {payload?.asOf ? ` ${t('asset_attention.as_of', { at: clockTime(payload.asOf) || String(payload.asOf), defaultValue: 'Latest capture {{at}}.' })}` : ''}
          </p>
        </>
      ) : read.status === 'loading' ? (
        <p className="text-[12px] text-[var(--fg-4)]" role="status" data-testid="attention-state">
          {t('asset_attention.loading', { defaultValue: 'Reading the hourly attention captures…' })}
        </p>
      ) : (
        // A successful read with no capture in the window is an EMPTY reading,
        // not a failure, and it carries whatever reason the read gave.
        <p className="text-[12px] text-[var(--fg-3)]" data-testid="attention-state">
          {t('asset_attention.empty', { hours: HOURS, defaultValue: 'No hourly attention capture has been recorded in the last {{hours}} hours, so there is nothing to draw. This is a missing capture, not an absence of attention.' })}
          {read.reason ? ` ${captureReasonText(t, read.reason)}` : ''}
        </p>
      )}

      {/* The one attention-shaped reading that IS published: where this asset
          sits in the weekly rank capture. */}
      <div className="space-y-1">
        <p className="text-[12px] text-[var(--fg-4)]">{t('asset_attention.rank_title', { defaultValue: 'Weekly rank capture' })}</p>
        {!cmc ? (
          <p className="text-[12px] text-[var(--fg-3)]" data-testid="attention-rank-line">
            {t('asset_attention.rank_not_cmc', { defaultValue: 'The weekly rank capture covers CoinMarketCap identities only, so this asset has no rank line.' })}
          </p>
        ) : ranks.status === 'unavailable' ? (
          <p className="text-[12px] text-[var(--fg-3)]" role="alert" data-testid="attention-rank-line">
            {t('asset_attention.rank_unavailable', { defaultValue: 'The weekly rank capture could not be read.' })}{' '}
            {captureReasonText(t, ranks.reason)}
          </p>
        ) : line.length ? (
          <p className="text-[12px] text-[var(--fg-3)] flex items-center gap-2" data-testid="attention-rank-line">
            <Sparkline values={line.map(point => point.rank)} tone="blue" ariaLabel={t('asset_attention.rank_aria', { symbol: name, weeks: line.length, defaultValue: 'Weekly captured rank for {{symbol}} over {{weeks}} weeks' })} />
            <span>
              {t('asset_attention.rank_line', { first: line[0].rank, last: line.at(-1).rank, weeks: line.length, defaultValue: '#{{first}} → #{{last}} over {{weeks}} captured weeks. The line rises as the rank number grows, which is a worse rank.' })}
            </span>
          </p>
        ) : (
          <p className="text-[12px] text-[var(--fg-3)]" data-testid="attention-rank-line">
            {t('asset_attention.rank_empty', { defaultValue: 'No weekly rank has been captured for this asset yet.' })}
          </p>
        )}
      </div>
    </section>
  )
}
