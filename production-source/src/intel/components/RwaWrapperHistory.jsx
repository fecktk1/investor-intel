import React, { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { useTranslation } from 'react-i18next'
import { LineArea } from '../charts'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { readCaptureView, captureUnavailable, captureReasonText } from '../lib/capture-api'
import { bpsLabel, widthLabel } from './RwaWrapperSpread'

// Wrapper premium OVER TIME for one tokenised real-world asset.
//
// Two sources share one line, and the figure never lets them blur:
//   * live captures, from the six-hourly wrapper lane, and
//   * days RECONSTRUCTED from daily OHLCV closes, only ever before the asset's
//     first live capture. They are shaded as their own span, marked by a line
//     where the live history begins, and labelled row by row in the table twin.
//
// Closed-market days are shaded: weekends and NYSE holidays for a stock or ETF,
// weekends only for a commodity (the COMEX holiday calendar is not modelled, and
// the figure says so).
//
// An accruing wrapper carries an accrual gap, never a premium, and the figure
// renames its value axis rather than drawing the gap as a premium.
//
// House visual language: no pills and no cards. Text controls, hairlines, a
// plain figure with a table twin.

export const HISTORY_RANGES = [30, 90, 180, 365]
const DEFAULT_DAYS = 90

const num = value => {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
const ID = /^[1-9][0-9]{0,11}$/

/** The wrapper shown first: the asset's cheapest liquid route when it has one,
 * then the first wrapper whose latest state is liquid, then the first listed. */
export function defaultWrapper(wrappers, cheapestCryptoId) {
  const list = Array.isArray(wrappers) ? wrappers : []
  return list.find(w => w.cryptoId === cheapestCryptoId)
    || list.find(w => w.latestState === 'liquid')
    || list[0]
    || null
}

/** A point's plotted value: its premium, or for an accruing wrapper its accrual
 * gap. Which one it is travels with the point so the axis can say so. */
export function pointValue(point) {
  const premium = num(point?.premiumBps)
  if (premium != null) return { value: premium, kind: 'premium' }
  const gap = num(point?.accrualGapBps)
  if (gap != null) return { value: gap, kind: 'accrual' }
  return { value: null, kind: null }
}

export default function RwaWrapperHistory() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase } = useSupabase()
  const orgId = org?.id || null
  const [params, setParams] = useSearchParams()
  const urlAsset = ID.test(String(params.get('asset') || '')) ? params.get('asset') : null
  const [fallbackAsset, setFallbackAsset] = useState(null)
  const rwaId = urlAsset || fallbackAsset
  const [days, setDays] = useState(DEFAULT_DAYS)
  const [wrapperId, setWrapperId] = useState(null)
  const [read, setRead] = useState({ status: 'loading', payload: null, reason: null })

  useEffect(() => {
    const controller = new AbortController()
    let alive = true
    setRead(prev => ({ status: 'loading', payload: prev.payload, reason: null }))
    readCaptureView('rwa_wrapper_history', rwaId ? { rwaId, days } : { days }, { orgId, signal: controller.signal, supabase })
      .then(payload => {
        if (!alive) return
        setRead({ status: 'ready', payload, reason: null })
        // No asset in the address: take the first the selector offers, which the
        // view ranks by widest dispersion.
        const first = Array.isArray(payload?.assets) ? payload.assets[0]?.rwaId : null
        if (!rwaId && first) setFallbackAsset(first)
      })
      .catch(error => { if (alive) setRead({ status: 'unavailable', payload: null, reason: captureUnavailable(error).reason }) })
    return () => { alive = false; controller.abort() }
  }, [orgId, supabase, rwaId, days])

  const payload = read.payload || {}
  const assets = useMemo(() => (Array.isArray(payload.assets) ? payload.assets : []), [payload])
  const wrappers = useMemo(() => (payload.rwaId === rwaId && Array.isArray(payload.wrappers) ? payload.wrappers : []), [payload, rwaId])
  const fallbackWrapper = defaultWrapper(wrappers, payload.asset?.cheapestCryptoId)
  const wrapper = wrappers.find(w => w.cryptoId === wrapperId) || fallbackWrapper
  const boundary = payload.boundary && typeof payload.boundary === 'object' ? payload.boundary : {}
  const calendar = payload.calendar && typeof payload.calendar === 'object' ? payload.calendar : null
  const bps = t('rwa_wrappers.bps_unit', { defaultValue: 'bps' })

  const chosenAsset = id => {
    setWrapperId(null)
    setParams(current => { const next = new URLSearchParams(current); next.set('asset', id); return next }, { replace: true })
  }

  // Dispersion is an ASSET figure; it is laid under the wrapper's line at the
  // same instants, so the area and the line are read against one clock.
  const dispersionAt = useMemo(() => {
    const map = new Map()
    for (const row of Array.isArray(payload.anchor) ? payload.anchor : []) {
      const at = num(row?.t)
      if (at != null) map.set(at, num(row?.dispersionBps))
    }
    return map
  }, [payload])

  const plotted = useMemo(() => (wrapper?.points || []).map(point => {
    const { value, kind } = pointValue(point)
    return { t: num(point?.t), value, kind, state: point?.state || null, source: point?.source, secondary: dispersionAt.get(num(point?.t)) ?? null }
  }).filter(point => point.t != null && point.value != null), [wrapper, dispersionAt])
  const unplotted = (wrapper?.points?.length || 0) - plotted.length
  const accruing = plotted.some(point => point.kind === 'accrual')
  const reconstructedCount = plotted.filter(point => point.source === 'ohlcv_reconstructed').length

  const sourceLabel = source => (source === 'ohlcv_reconstructed'
    ? t('rwa_wrapper_history.source_reconstructed', { defaultValue: 'Reconstructed from daily close' })
    : t('rwa_wrapper_history.source_capture', { defaultValue: 'Live capture' }))
  const stateLabel = state => (state ? t(`rwa_wrappers.state_${state}`, { defaultValue: state }) : '—')
  const timeLabel = value => {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' })
  }

  const spans = useMemo(() => {
    if (!plotted.length) return []
    // Only what overlaps the drawn series, clipped to it: the chart pins an
    // out-of-range time to its edge, which would stack stray bands there.
    const times = plotted.map(point => point.t)
    const lo = Math.min(...times), hi = Math.max(...times)
    const clip = span => (span.from != null && span.to != null && span.to >= lo && span.from <= hi
      ? { ...span, from: Math.max(span.from, lo), to: Math.min(span.to, hi) }
      : null)
    const out = []
    const from = Date.parse(boundary.reconstructedFrom || ''), to = Date.parse(boundary.reconstructedTo || '')
    if (Number.isFinite(from) && Number.isFinite(to) && reconstructedCount > 0) {
      const span = clip({ from, to, tone: 'yellow', label: t('rwa_wrapper_history.span_reconstructed', { defaultValue: 'Reconstructed from daily OHLCV closes' }) })
      if (span) out.push(span)
    }
    // Closed days: only the first DRAWN span of each kind carries a legend label,
    // so a year of weekends is one legend line rather than fifty.
    const labelled = new Set()
    for (const raw of Array.isArray(calendar?.spans) ? calendar.spans : []) {
      const kind = raw?.kind === 'holiday' ? 'holiday' : 'weekend'
      const span = clip({ from: num(raw?.from), to: num(raw?.to), tone: 'muted' })
      if (!span) continue
      if (!labelled.has(kind)) {
        span.label = kind === 'holiday'
          ? t('rwa_wrapper_history.span_holiday', { defaultValue: 'NYSE holiday (market closed)' })
          : t('rwa_wrapper_history.span_weekend', { defaultValue: 'Weekend (market closed)' })
        labelled.add(kind)
      }
      out.push(span)
    }
    return out
  }, [boundary.reconstructedFrom, boundary.reconstructedTo, calendar, reconstructedCount, plotted, t])

  const liveFrom = Date.parse(boundary.liveFrom || '')
  const marks = Number.isFinite(liveFrom) && reconstructedCount > 0
    ? [{ t: liveFrom, tone: 'accent', label: t('rwa_wrapper_history.mark_live', { defaultValue: 'Live captures begin' }) }]
    : []

  const calendarNote = calendar?.note === 'nyse_weekends_and_holidays'
    ? t('rwa_wrapper_history.calendar_nyse', { defaultValue: 'Shaded days are weekends and scheduled NYSE full-day holidays. Holidays are listed for 2026 to 2028 only; earlier holidays are not shaded.' })
    : calendar?.note === 'comex_holidays_not_modelled'
      ? t('rwa_wrapper_history.calendar_comex', { defaultValue: 'Shaded days are weekends. COMEX holidays are not modelled, so a commodity holiday is not shaded.' })
      : calendar
        ? t('rwa_wrapper_history.calendar_none', { defaultValue: 'No market calendar is modelled for this asset type, so no days are shaded.' })
        : null

  const valueLabel = accruing
    ? t('rwa_wrapper_history.value_accrual', { defaultValue: 'Accrual gap (not a premium)' })
    : t('rwa_wrapper_history.value_premium', { defaultValue: 'Premium against the anchor' })

  return (
    <section className="intel-rwa-wrapper-history space-y-4 border-t border-[var(--border-default)] pt-6" aria-label={t('rwa_wrapper_history.title', { defaultValue: 'Wrapper premium over time' })}>
      <div>
        <div className="eyebrow">{t('rwa_wrapper_history.eyebrow', { defaultValue: 'Our calculation, over time' })}</div>
        <h3 className="text-lg font-medium mt-1">{t('rwa_wrapper_history.title', { defaultValue: 'Wrapper premium over time' })}</h3>
        <p className="text-[11px] leading-relaxed text-[var(--fg-4)] mt-1 max-w-[80ch]">
          {t('rwa_wrapper_history.intro', { defaultValue: 'The premium or discount of one wrapper against its asset\'s anchor, from every six-hourly capture since the wrapper lane began. Days before that are reconstructed from each wrapper\'s daily closing price and daily volume, run through the same unit guard, accrual guard, liquidity floor and anchor rule, and are shaded and labelled as reconstructed. A reconstructed day compares closes, not quotes read at the same moment.' })}
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-4 text-[12px]">
        <label className="flex flex-col gap-1">
          <span>{t('rwa_wrapper_history.control_asset', { defaultValue: 'Asset' })}</span>
          <select className="select" value={rwaId || ''} onChange={e => chosenAsset(e.target.value)} disabled={!assets.length}>
            {!rwaId && <option value="">{t('rwa_wrapper_history.control_asset_none', { defaultValue: 'No asset captured yet' })}</option>}
            {rwaId && !assets.some(a => a.rwaId === rwaId) && <option value={rwaId}>{payload.asset?.name || rwaId}</option>}
            {assets.map(asset => (
              <option key={asset.rwaId} value={asset.rwaId}>{asset.name || asset.symbol || asset.rwaId}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span>{t('rwa_wrapper_history.control_wrapper', { defaultValue: 'Wrapper' })}</span>
          <select className="select" value={wrapper?.cryptoId || ''} onChange={e => setWrapperId(e.target.value)} disabled={!wrappers.length}>
            {!wrappers.length && <option value="">{t('rwa_wrapper_history.control_wrapper_none', { defaultValue: 'No wrapper history' })}</option>}
            {wrappers.map(w => (
              <option key={w.cryptoId} value={w.cryptoId}>
                {`${w.symbol || w.name || w.cryptoId}${w.cheapestLiquid ? ` · ${t('rwa_wrapper_history.cheapest_suffix', { defaultValue: 'cheapest liquid route' })}` : ''}`}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-col gap-1" role="group" aria-label={t('rwa_wrapper_history.control_range', { defaultValue: 'Range' })}>
          <span>{t('rwa_wrapper_history.control_range', { defaultValue: 'Range' })}</span>
          <div className="flex gap-3">
            {HISTORY_RANGES.map(range => (
              <button key={range} type="button" className="intel-text-link" aria-pressed={days === range} onClick={() => setDays(range)}>
                {t('rwa_wrapper_history.range_days', { days: range, defaultValue: '{{days}} days' })}
              </button>
            ))}
          </div>
        </div>
      </div>

      {read.status === 'loading' && <p role="status" className="text-[12px]">{t('rwa_wrapper_history.loading', { defaultValue: 'Reading the stored wrapper history…' })}</p>}

      {read.status === 'unavailable' && (
        <p role="alert" className="text-[12px]">
          {t('rwa_wrapper_history.unavailable', {
            reason: captureReasonText(t, read.reason),
            defaultValue: 'The wrapper history could not be read. {{reason}} No premium is asserted for any day.',
          })}
        </p>
      )}

      {read.status === 'ready' && (
        <>
          {payload.reason && payload.reason !== 'no_asset_selected' && (
            <p role="status" className="text-[12px]">
              {t('rwa_wrapper_history.partial', { reason: captureReasonText(t, payload.reason), defaultValue: 'Part of this read did not answer ({{reason}}). What did load is shown, and nothing was replaced with a zero.' })}
            </p>
          )}

          {!assets.length && !rwaId && (
            <p role="status" className="text-[12px]">
              {t('rwa_wrapper_history.no_assets', { defaultValue: 'No wrapper capture has been stored yet, so there is no history to draw.' })}
            </p>
          )}

          {rwaId && payload.rwaId === rwaId && !wrappers.length && (
            <p role="status" className="text-[12px]">
              {t('rwa_wrapper_history.no_history', { days, defaultValue: 'No wrapper of this asset has a stored premium in the last {{days}} days.' })}
            </p>
          )}

          {wrapper && (
            <>
              <LineArea
                title={t('rwa_wrapper_history.figure_title', { wrapper: wrapper.symbol || wrapper.name || wrapper.cryptoId, asset: payload.asset?.name || payload.asset?.symbol || rwaId, defaultValue: '{{wrapper}} against the {{asset}} anchor' })}
                description={valueLabel}
                points={plotted}
                spans={spans}
                marks={marks}
                valueLabel={valueLabel}
                secondaryLabel={t('rwa_wrapper_history.secondary_dispersion', { defaultValue: 'Asset dispersion' })}
                formatValue={value => bpsLabel(value, bps) ?? '—'}
                formatSecondary={value => widthLabel(value, bps) ?? '—'}
                tableColumns={[
                  t('rwa_wrapper_history.col_time', { defaultValue: 'Time (UTC)' }),
                  valueLabel,
                  t('rwa_wrapper_history.col_state', { defaultValue: 'State' }),
                  t('rwa_wrapper_history.col_source', { defaultValue: 'Source' }),
                ]}
                tableRows={plotted.map(point => [timeLabel(point.t), bpsLabel(point.value, bps) ?? '—', stateLabel(point.state), sourceLabel(point.source)])}
              />

              <p className="text-[12px]">
                {t('rwa_wrapper_history.counts', {
                  captured: plotted.length - reconstructedCount,
                  reconstructed: reconstructedCount,
                  defaultValue: 'Live captures drawn: {{captured}}. Reconstructed days drawn: {{reconstructed}}.',
                })}
                {unplotted > 0 && ` ${t('rwa_wrapper_history.unplotted', { n: unplotted, defaultValue: 'Observations without a premium, for example a price in an unestablished unit, left undrawn: {{n}}.' })}`}
              </p>
              {reconstructedCount > 0 && (
                <p className="text-[11px] text-[var(--fg-4)] max-w-[80ch]">
                  {t('rwa_wrapper_history.reconstructed_note', { defaultValue: 'Reconstructed days use each wrapper\'s daily close and that day\'s reported volume in place of a live quote and 24 hour volume. A wrapper with no candle on a day is left out of that day rather than carried forward, so a reconstructed anchor can have fewer members than a live one.' })}
                </p>
              )}
              {calendarNote && <p className="text-[11px] text-[var(--fg-4)]">{calendarNote}</p>}
              {(payload.truncated || payload.downsampled) && (
                <p className="text-[11px] text-[var(--fg-4)]">
                  {payload.truncated
                    ? t('rwa_wrapper_history.truncated', { defaultValue: 'This range holds more rows than one read returns, so its oldest live captures are not shown. Choose a shorter range to see every capture.' })
                    : t('rwa_wrapper_history.downsampled', { defaultValue: 'The series is thinned to an even sample for drawing; the first and last observations are always kept.' })}
                </p>
              )}
            </>
          )}
        </>
      )}
    </section>
  )
}
