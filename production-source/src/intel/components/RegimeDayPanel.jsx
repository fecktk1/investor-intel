import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { readCaptureView, captureUnavailable, captureReasonText } from '../lib/capture-api'
import { useUrlState } from '../lib/useUrlState'
import { RadialGauge } from '../charts'
import { fearGreedZones, altcoinZones } from './RegimeRibbon'
import TokenAvatar from './TokenAvatar'
import { formatUsd, formatPct, formatPrice } from '../lib/market-format'

// "What did the market look like that day." One date picker reading the
// `regime_at` view: the regime figures recorded closest to that date and the
// top ten assets as they were ranked on it.
//
// The ranking can come from two different places, and the panel always says
// which: a historical listing recorded FOR that date, or today's catalogue when
// the date sits inside the daily-capture window and no historical listing was
// taken. Those are not the same claim and are never presented as if they were.

const DATE_DEFAULTS = { r_date: '' }
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

// Local calendar day: the reader picks the date they are standing in, not UTC.
export const todayLocal = (now = new Date()) => {
  const offset = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
  return offset.toISOString().slice(0, 10)
}

const num = value => { if (value == null || value === '' || typeof value === 'boolean') return null; const n = Number(value); return Number.isFinite(n) ? n : null }
const dayPart = value => (ISO_DAY.test(String(value || '').slice(0, 10)) ? String(value).slice(0, 10) : null)

/** Which listing the ranking came from. 'historical' is a listing recorded for
 *  that date; 'latest' is today's catalogue standing in for one. */
export function topSource(rows = []) {
  const sources = new Set((Array.isArray(rows) ? rows : []).map(row => row?.source).filter(Boolean))
  if (sources.has('listings_historical')) return 'historical'
  if (sources.has('listings_latest')) return 'latest'
  return null
}

export default function RegimeDayPanel({ coverageFrom = null, logos = null }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase } = useSupabase()
  const [urlState, setUrlState] = useUrlState(DATE_DEFAULTS)
  const today = todayLocal()
  const date = ISO_DAY.test(urlState.r_date) ? urlState.r_date : today
  const min = dayPart(coverageFrom)

  const [payload, setPayload] = useState(null)
  const [failed, setFailed] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setFailed(null)
    readCaptureView('regime_at', { date }, { orgId: org?.id || undefined, supabase })
      .then(data => { if (alive) { setPayload(data); setFailed(null) } })
      .catch(error => { if (alive) { setPayload(null); setFailed(captureUnavailable(error)) } })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [date, org?.id, supabase])

  const unavailable = failed || (payload?.reason ? { state: 'unavailable', reason: payload.reason } : null)
  const reason = unavailable ? captureReasonText(t, unavailable.reason) : undefined
  const regime = unavailable ? null : payload?.regime || null
  const top = useMemo(() => (unavailable || !Array.isArray(payload?.top) ? [] : payload.top), [payload, unavailable])
  const source = topSource(top)

  const clock = value => {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? String(value ?? '—') : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
  }
  const index = value => (num(value) == null ? '—' : Number(value).toFixed(0))
  const share = value => (num(value) == null ? '—' : `${Number(value).toFixed(1)}%`)

  const caption = !regime
    ? t('regime.day_no_capture', { defaultValue: 'No capture was recorded on or near this date.' })
    : regime.observedAt
      ? t('regime.observed_at', { time: clock(regime.observedAt), defaultValue: 'Provider clock: {{time}}' })
      : t('regime.captured_at', { time: clock(regime.capturedAt), defaultValue: 'No provider clock was published; captured {{time}}' })

  const gaugeState = value => (unavailable ? 'error' : !regime || num(value) == null ? 'empty' : 'ready')

  return (
    <section className="intel-regime-day space-y-3" aria-label={t('regime.day_title', { defaultValue: 'What the market looked like that day' })}>
      <div className="eyebrow">{t('regime.day_eyebrow', { defaultValue: 'A single day' })}</div>
      <p className="intel-analysis-caption">
        {t('regime.day_sub', { defaultValue: 'Pick a date to read the regime recorded closest to it and the ten largest assets as they were ranked on it.' })}
      </p>

      <div className="intel-investigation-controls">
        <label>
          {t('regime.day_date_label', { defaultValue: 'Date' })}
          <input
            type="date" className="input" value={date} max={today} {...(min ? { min } : {})}
            onChange={event => setUrlState({ r_date: event.target.value === today ? '' : event.target.value })}
          />
        </label>
        {min ? (
          <p className="intel-analysis-caption">
            {t('regime.day_min', { date: min, defaultValue: 'Captures begin on {{date}}.' })}
          </p>
        ) : null}
      </div>

      {unavailable ? (
        <p role="alert" className="text-[13px] text-[var(--fg-3)]">
          {t('regime.day_unavailable', { defaultValue: 'This day could not be read.' })} {reason}
        </p>
      ) : null}

      {loading && !payload ? (
        <p role="status" className="text-[12px] text-[var(--fg-4)]">{t('regime.day_loading', { defaultValue: 'Loading that day…' })}</p>
      ) : null}

      <div style={{ display: 'grid', gap: '1rem 2.5rem', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 14rem), 1fr))', alignItems: 'start' }}>
        <RadialGauge
          title={t('regime.fg_gauge_title', { defaultValue: 'Fear and greed now' })}
          description={caption} value={num(regime?.fearGreed) ?? 0} min={0} max={100} zones={fearGreedZones(t)}
          formatValue={index} height={104} state={gaugeState(regime?.fearGreed)} reason={reason}
        />
        <RadialGauge
          title={t('regime.alt_gauge_title', { defaultValue: 'Altcoin season now' })}
          description={caption} value={num(regime?.altcoinSeason) ?? 0} min={0} max={100} zones={altcoinZones(t)}
          formatValue={index} height={104} state={gaugeState(regime?.altcoinSeason)} reason={reason}
        />
        <RadialGauge
          title={t('regime.dom_gauge_title', { defaultValue: 'BTC dominance now' })}
          description={caption} value={num(regime?.btcDominance) ?? 0} min={0} max={100}
          formatValue={share} height={104} state={gaugeState(regime?.btcDominance)} reason={reason}
        />
      </div>

      <p className="intel-analysis-caption" data-testid="regime-day-source">
        {source === 'historical'
          ? t('regime.day_source_historical', { defaultValue: 'Ranked from the historical listing recorded for this date (listings_historical).' })
          : source === 'latest'
            ? t('regime.day_source_latest', { defaultValue: "Ranked from today's catalogue, not a historical listing (listings_latest)." })
            : t('regime.day_source_none', { defaultValue: 'No ranking was recorded for this date.' })}
      </p>

      {top.length ? (
        <div className="intel-table-scroll">
          <table aria-label={t('regime.day_top_title', { defaultValue: 'Top ten on this date' })}>
            <thead>
              <tr>
                <th scope="col">{t('regime.col_rank', { defaultValue: 'Rank' })}</th>
                <th scope="col">{t('regime.col_asset', { defaultValue: 'Asset' })}</th>
                <th scope="col" className="intel-number">{t('regime.col_price', { defaultValue: 'Price' })}</th>
                <th scope="col" className="intel-number">{t('regime.col_market_cap', { defaultValue: 'Market cap' })}</th>
                <th scope="col" className="intel-number">{t('regime.col_change_24h', { defaultValue: '24h' })}</th>
              </tr>
            </thead>
            <tbody>
              {top.map((row, i) => (
                <tr key={row?.providerId || `${row?.symbol}-${i}`}>
                  <th scope="row" className="intel-number">{num(row?.rank) == null ? '—' : `#${Number(row.rank)}`}</th>
                  <td>
                    <span className="flex items-center gap-2 min-w-0">
                      <TokenAvatar src={logos?.[row?.providerId] || null} symbol={row?.symbol} name={row?.name} size="sm" />
                      <span className="text-[var(--fg-1)]">{row?.symbol || '—'}</span>
                      {row?.name ? <span className="text-[11px] text-[var(--fg-5)] truncate">{row.name}</span> : null}
                    </span>
                  </td>
                  <td className="intel-number">{num(row?.price) == null ? '—' : formatPrice(row.price)}</td>
                  <td className="intel-number">{num(row?.marketCap) == null ? '—' : formatUsd(row.marketCap)}</td>
                  <td className="intel-number">{num(row?.change24hPct) == null ? '—' : formatPct(row.change24hPct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : unavailable || (loading && !payload) ? null : (
        <p className="text-[13px] text-[var(--fg-4)]">{t('regime.day_top_empty', { defaultValue: 'No ranking was recorded for this date.' })}</p>
      )}
    </section>
  )
}
