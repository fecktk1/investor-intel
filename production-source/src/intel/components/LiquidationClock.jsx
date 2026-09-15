import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { PolarClock, RadialBars } from '../charts'
import { readCaptureView, captureUnavailable, captureReasonText } from '../lib/capture-api'
import { assetBars, topIdsByMarketCap } from './LiquidationHeat'
import { formatUsd } from '../lib/market-format'

// Liquidation clock (CMC plan proposal 13). The same `liquidations` capture read
// as the heat strip, asked a different question: at WHICH HOURS OF THE DAY does
// the cascade land, and WHERE — which names and which side — is it landing now.
//
// Two honesty rules run through this file:
//   * An hour nobody captured is a GAP, not a zero. The clock carries null for
//     it and the table twin says so, because "no liquidations were reported"
//     and "we never looked" are different readings.
//   * A row that reports only a combined 24h figure keeps ONE undivided arc.
//     The long/short split is drawn only where the provider reported it.
//
// Everything here is a provider-reported aggregate sampled on the five-minute
// capture clock, not an exchange tape.

const MAX_IDS = 10
const DEFAULT_ASSETS = 5
const TOP_ARCS = 8
const HOURS = 24

const num = value => {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

const hourText = hour => `${String(hour).padStart(2, '0')}:00`

const clockTime = value => {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString()
}

// Intensity by hour of day, in the reader's own clock — the same hours the
// PolarClock's "now" marker uses.
//
// The capture writes a 5-minute row per asset, each carrying a ROLLING 1h total.
// Summing every row inside an hour would count the same rolling window twelve
// times over, so each asset contributes its LAST reading inside that hour and
// the assets are summed across. An hour with no capture at all for any asset
// stays null.
export function clockBuckets(rows = [], hours = HOURS) {
  const cells = Array.from({ length: hours }, () => null)
  for (const row of Array.isArray(rows) ? rows : []) {
    const latest = new Map()
    for (const point of Array.isArray(row?.points) ? row.points : []) {
      const at = Date.parse(point?.capturedAt)
      if (!Number.isFinite(at)) continue
      const hour = new Date(at).getHours() % hours
      const held = latest.get(hour)
      if (!held || at > held.at) latest.set(hour, { at, liq1h: num(point?.liq1h) })
    }
    for (const [hour, point] of latest) {
      // The hour was captured either way; only the figure can be missing.
      const cell = cells[hour] || { value: null, assets: 0, at: 0 }
      if (point.liq1h != null) cell.value = (cell.value ?? 0) + point.liq1h
      cell.assets += 1
      cell.at = Math.max(cell.at, point.at)
      cells[hour] = cell
    }
  }
  return cells.map((cell, hour) => ({
    hour,
    label: hourText(hour),
    value: cell ? cell.value : null,
    assets: cell ? cell.assets : 0,
    observed: !!cell,
    capturedAt: cell && cell.at ? new Date(cell.at).toISOString() : null,
  }))
}

// Where the cascade is: the largest 24h names first, each split into its long
// and short side when the capture reported one. A name that reported only a
// total keeps a single arc labelled as unsplit rather than being halved.
export function cascadeArcs(rows = [], max = TOP_ARCS) {
  const assets = assetBars(rows)
    .filter(bar => num(bar.liq24h) != null)
    .sort((a, b) => (num(b.liq24h) ?? -Infinity) - (num(a.liq24h) ?? -Infinity))
    .slice(0, Math.max(0, max))
  const arcs = []
  for (const asset of assets) {
    if (asset.split) {
      arcs.push({ key: `${asset.key}:long`, symbol: asset.symbol, side: 'long', value: asset.long, total: asset.liq24h })
      arcs.push({ key: `${asset.key}:short`, symbol: asset.symbol, side: 'short', value: asset.short, total: asset.liq24h })
    } else {
      arcs.push({ key: `${asset.key}:total`, symbol: asset.symbol, side: 'total', value: asset.liq24h, total: asset.liq24h })
    }
  }
  // One shared scale, so an arc on the inner ring is comparable with the outer.
  const ceiling = Math.max(0, ...arcs.map(arc => num(arc.value) ?? 0))
  return arcs.map(arc => ({ ...arc, max: ceiling > 0 ? ceiling : 1 }))
}

const ARC_TONE = { long: 'green', short: 'red', total: 'accent' }

export default function LiquidationClock({ ids = [], rows = [] }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  // Capture tables are service-role only: the read travels on the reader's own
  // authenticated client, never the anonymous one.
  const { supabase } = useSupabase()
  const orgId = org?.id || null

  // Identical selection rule to the heat strip beside it: the screen's rows win,
  // the ids prop is the fallback, and the read never asks for more than it takes.
  const fromRows = topIdsByMarketCap(rows, DEFAULT_ASSETS)
  const requested = (fromRows.length ? fromRows : (Array.isArray(ids) ? ids : []))
    .filter(id => id != null && id !== '')
    .slice(0, MAX_IDS)
  const idKey = requested.join(',')
  const requestedRef = useRef(requested)
  requestedRef.current = requested

  const [read, setRead] = useState({ status: 'loading', payload: null, reason: null })
  const [picked, setPicked] = useState(null)

  useEffect(() => {
    const list = requestedRef.current
    const controller = new AbortController()
    let alive = true
    setRead({ status: 'loading', payload: null, reason: null })
    setPicked(null)
    // The read takes `providerIds` (at most ten) and defaults to the last 24
    // hours, which is exactly the window this clock draws.
    readCaptureView('liquidations', { providerIds: list }, { orgId, signal: controller.signal, supabase })
      .then(payload => { if (alive) setRead({ status: 'ready', payload, reason: null }) })
      .catch(error => { if (alive) setRead({ status: 'unavailable', payload: null, reason: captureUnavailable(error).reason }) })
    return () => { alive = false; controller.abort() }
  }, [orgId, idKey, supabase])

  const buckets = useMemo(() => clockBuckets(read.payload?.rows), [read.payload])
  const arcs = useMemo(() => cascadeArcs(read.payload?.rows), [read.payload])
  const observed = buckets.filter(bucket => bucket.observed).length

  const failed = read.status === 'unavailable'
  const reason = failed ? captureReasonText(t, read.reason) : undefined
  const clockState = failed ? 'error' : (read.status === 'ready' && observed) ? 'ready' : 'empty'
  const arcState = failed ? 'error' : (read.status === 'ready' && arcs.length) ? 'ready' : 'empty'

  const asOf = clockTime(read.payload?.asOf)
  const caption = asOf
    ? t('structure.clock_caption_at', { at: asOf, defaultValue: 'Provider-reported aggregate on the five-minute capture clock, not an exchange tape. Latest capture {{at}}.' })
    : t('structure.clock_caption', { defaultValue: 'Provider-reported aggregate on the five-minute capture clock, not an exchange tape.' })

  // An hour is either a figure or a gap, and a gap says so rather than reading
  // as a quiet hour.
  const clockValue = value => (value == null
    ? t('structure.clock_no_capture', { defaultValue: 'Not captured' })
    : formatUsd(value))

  const arcLabel = arc => (arc.side === 'total'
    ? t('structure.clock_arc_total', { symbol: arc.symbol, defaultValue: '{{symbol}} · side not reported' })
    : arc.side === 'long'
      ? t('structure.clock_arc_long', { symbol: arc.symbol, defaultValue: '{{symbol}} · long' })
      : t('structure.clock_arc_short', { symbol: arc.symbol, defaultValue: '{{symbol}} · short' }))

  const readout = picked
    ? (picked.value == null
        ? t('structure.clock_readout_gap', { hour: picked.label, defaultValue: '{{hour}} — no capture recorded for this hour.' })
        : t('structure.clock_readout', { hour: picked.label, total: formatUsd(picked.value), assets: picked.assets, defaultValue: '{{hour}} · {{total}} across {{assets}} asset captures' }))
    : ''

  return (
    <section className="intel-structure-clock space-y-3" aria-label={t('structure.clock_title', { defaultValue: 'Liquidation clock' })}>
      <PolarClock
        title={t('structure.clock_title', { defaultValue: 'Liquidation clock' })}
        description={`${t('structure.clock_sub', { defaultValue: 'Liquidation intensity by hour of day for the assets in view — one mark per hour, each the freshest rolling one-hour total captured in that hour. An hour nobody captured is a gap, not a zero.' })} ${caption}`}
        period="24h"
        buckets={buckets}
        formatValue={clockValue}
        state={clockState}
        reason={reason}
        onSelect={bucket => setPicked(bucket || null)}
      />
      <p role="status" className="text-[12px] text-[var(--fg-3)] min-h-[1.2em]">{readout}</p>
      {read.status === 'ready' && !failed ? (
        <p className="text-[12px] text-[var(--fg-4)]">
          {t('structure.clock_observed', { observed, hours: HOURS, defaultValue: '{{observed}} of the last {{hours}} hours carry a capture; the rest are gaps.' })}
        </p>
      ) : null}
      <RadialBars
        title={t('structure.clock_arcs_title', { defaultValue: 'Where the cascade is' })}
        description={requested.length
          ? `${t('structure.clock_arcs_sub', { top: TOP_ARCS, defaultValue: 'The largest {{top}} names by 24-hour liquidations, each split into its long and short side where the capture reports one. All arcs share one scale, largest outermost.' })} ${caption}`
          : t('structure.clock_no_assets', { defaultValue: 'No assets were selected, so no per-asset liquidations were requested.' })}
        series={arcs.map(arc => ({ key: arc.key, label: arcLabel(arc), value: arc.value, max: arc.max, tone: ARC_TONE[arc.side] }))}
        formatValue={formatUsd}
        state={requested.length ? arcState : 'empty'}
        reason={reason}
      />
      <p className="text-[12px] text-[var(--fg-4)]">
        {t('structure.clock_disclaimer', { defaultValue: 'These are liquidations the provider reported, aggregated across the venues it covers. They are not positions at risk and they are not a measure of what will liquidate next.' })}
      </p>
    </section>
  )
}
