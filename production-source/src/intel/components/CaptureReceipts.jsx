import React, { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18next from 'i18next'
import { formatDataTime } from '../lib/as-of'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { readCaptureView, captureUnavailable, captureReasonText } from '../lib/capture-api'
import SourceCallReceipt from './SourceCallReceipt'

// Capture times in the one format (../lib/as-of.js): UTC and its age.
const time = v => formatDataTime(v, { language: i18next.language })
const FRESHNESS_DEFAULTS = {
  fresh: 'Fresh: a provider call answered this read',
  cached: 'Cached: inside its refresh limit',
  stale: 'Stale: past its refresh limit',
  unavailable: 'Unavailable: nothing usable answered this read',
}
const LANE_DEFAULTS = {
  regime: 'Market regime', network_stats: 'Network statistics', rank: 'Rank history', rwa: 'Tokenized asset universe',
  index: 'Index constituents', liquidations: 'Liquidations', attention: 'Attention lists', exchange_reserves: 'Exchange reserves',
  venue_share: 'Venue share', categories: 'Categories', airdrops: 'Airdrops', new_listings: 'New listings', meme_stages: 'Meme launch stages',
  launchpad_stages: 'Launchpad stages', sunpump_stages: 'SunPump launch log',
}

/** Receipts for figures read from the capture tables (Play 1 on the capture
 * views). They describe the newest scheduled capture run: when it captured, the
 * endpoints it called, the status and credits it recorded, and the age of the
 * capture against its cadence. Nothing here asks a provider for anything.
 *
 * The read happens only when a reader opens the drawer, so a page view costs
 * nothing extra and the figures on the page keep their own reads.
 *
 * `sources` is the other half of the same question. A receipt describes a RUN;
 * a source line describes what that run's lane actually left in the window a
 * reader is looking at. Two lanes can write the same table, so without it a
 * CoinMarketCap-only window and a CoinGecko-only one look identical. The lines
 * are built by whichever figure owns the read (it already has the payload), so
 * nothing here reads the capture tables a second time to say the same thing. */
export default function CaptureReceipts({ lanes = [], sources = null }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase } = useSupabase()
  const [read, setRead] = useState({ status: 'idle', payload: null, reason: null })
  const started = useRef(false)
  const laneKey = (Array.isArray(lanes) ? lanes : []).join(',')

  const load = useCallback(event => {
    if (!event?.currentTarget?.open || started.current) return
    started.current = true
    setRead({ status: 'loading', payload: null, reason: null })
    readCaptureView('capture_receipts', { lanes: laneKey.split(',').filter(Boolean) }, { orgId: org?.id || null, supabase })
      .then(payload => setRead({ status: 'ready', payload, reason: null }))
      .catch(error => { started.current = false; setRead({ status: 'unavailable', payload: null, reason: captureUnavailable(error).reason }) })
  }, [laneKey, org?.id, supabase])

  if (!laneKey) return null
  const rows = Array.isArray(read.payload?.lanes) ? read.payload.lanes : []
  return (
    <details className="intel-source-call-receipt" onToggle={load} data-testid="capture-receipts">
      <summary>{t('receipt_state.captures_title', { defaultValue: 'Capture receipts' })}</summary>
      <p className="intel-analysis-caption">{t('receipt_state.captures_sub', { defaultValue: 'What the newest scheduled capture run recorded about its own provider calls. Reading these receipts made no provider call.' })}</p>
      {read.status === 'loading' && <p role="status" className="intel-event-meta">{t('receipt_state.captures_loading', { defaultValue: 'Loading capture receipts…' })}</p>}
      {read.status === 'unavailable' && <p role="status" className="intel-event-meta">{t('receipt_state.captures_unavailable', { defaultValue: 'Capture receipts could not be read.' })} {captureReasonText(t, read.reason)}</p>}
      {Array.isArray(sources) && sources.length ? (
        <section className="space-y-1 pt-2" aria-label={t('receipt_state.sources_title', { defaultValue: 'What each capture lane left in this window' })} data-testid="capture-receipt-sources">
          <div className="eyebrow">{t('receipt_state.sources_title', { defaultValue: 'What each capture lane left in this window' })}</div>
          {sources.map(line => <p key={line?.source} className="intel-event-meta">{line?.text}</p>)}
        </section>
      ) : null}
      {rows.map(lane => (
        <section key={lane.lane} className="space-y-1 pt-2" aria-label={t(`receipt_state.lane_${lane.lane}`, { defaultValue: LANE_DEFAULTS[lane.lane] || lane.lane })}>
          <div className="eyebrow">{t(`receipt_state.lane_${lane.lane}`, { defaultValue: LANE_DEFAULTS[lane.lane] || lane.lane })}</div>
          <dl className="intel-event-facts">
            <dt>{t('receipt_state.captured', { defaultValue: 'Captured' })}</dt>
            <dd>{lane.capturedAt ? <time dateTime={lane.capturedAt}>{time(lane.capturedAt)}</time> : t('receipt.not_reported', { defaultValue: 'not reported' })}</dd>
            <dt>{t('receipt_state.freshness', { defaultValue: 'Freshness' })}</dt>
            <dd>{t(`receipt_state.${FRESHNESS_DEFAULTS[lane.freshness] ? lane.freshness : 'unavailable'}`, { defaultValue: FRESHNESS_DEFAULTS[lane.freshness] || FRESHNESS_DEFAULTS.unavailable })}</dd>
          </dl>
          {lane.reason === 'call_log_unavailable' && <p className="intel-event-meta">{t('receipt_state.captures_lane_unavailable', { defaultValue: 'The call log for this lane could not be read.' })}</p>}
          {lane.reason === 'no_recent_capture_calls' && <p className="intel-event-meta">{t('receipt_state.captures_none', { defaultValue: 'No capture calls were recorded in the recent window for this lane.' })}</p>}
          {(Array.isArray(lane.receipts) ? lane.receipts : []).map((receipt, index) => (
            <SourceCallReceipt key={`${receipt.endpoint}-${index}`} receipt={receipt} scopeKey="capture_record"
              scope="A recorded capture of provider figures at the stated capture time. Reading it made no new provider call and it is not a reading of the market now." />
          ))}
        </section>
      ))}
    </details>
  )
}
