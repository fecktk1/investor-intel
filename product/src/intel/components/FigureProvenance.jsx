import React from 'react'
import { useTranslation } from 'react-i18next'
import { envelopeKind, envelopeFreshness, providerLabel } from '../lib/source-receipt'
import SourceCallReceipt from './SourceCallReceipt'

const time = v => (v && Number.isFinite(Date.parse(v)) ? new Date(v).toLocaleString() : null)
const FRESHNESS_DEFAULTS = {
  fresh: 'Fresh: a provider call answered this read',
  cached: 'Cached: inside its refresh limit',
  stale: 'Stale: past its refresh limit',
  unavailable: 'Unavailable: nothing usable answered this read',
}

/** Play 7: one figure's provenance envelope, in the same <details> idiom as the
 * source call receipt. It renders the source, the clock, the freshness and the
 * sentence saying what the figure does not mean.
 *
 * The view BRANCHES on the envelope kind. A curated envelope whose review window
 * has closed (on the server, or since, in a client cache) is drawn with its own
 * label and never as a current figure. An unknown kind draws nothing rather than
 * an unfounded claim. Optional `receipts` render beneath as source call receipts. */
export default function FigureProvenance({ envelope, receipts = [] }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const kind = envelopeKind(envelope)
  const list = (Array.isArray(receipts) ? receipts : []).filter(Boolean)
  if (!kind) return list.length ? <>{list.map((r, i) => <SourceCallReceipt key={i} receipt={r} />)}</> : null
  const freshness = envelopeFreshness(envelope)
  const freshnessText = freshness
    ? t(`receipt_state.${freshness}`, { defaultValue: FRESHNESS_DEFAULTS[freshness] })
    : t('receipt_state.unmeasured', { defaultValue: 'Not measurable: the source reported no clock' })
  const scope = envelope.scopeKey ? t(`figure_scope.${envelope.scopeKey}`, { defaultValue: envelope.scope || '' }) : envelope.scope
  // What this figure cost the reader looking at it, in the summary rather than
  // the drawer. A 'stored' or 'curated' envelope is a precomputed capture that
  // everyone reads from one row, so it costs a reader nothing; a 'live' envelope
  // was answered by a call, and its own receipts below state that call's credits.
  // The capture time is already reported as fetchedAt, so the line names it.
  const captured = envelope.fetchedAt && Number.isFinite(Date.parse(envelope.fetchedAt)) ? new Date(envelope.fetchedAt).toLocaleString() : null
  const shared = kind !== 'live'
  // A curated record is a reviewed record, not a capture, so it gets its own noun.
  // Both cost a reader nothing, which is the claim the line is actually making.
  const sharedText = kind === 'curated' || kind === 'curated_stale'
    ? t('receipt_cost.shared_curated', { defaultValue: 'Shared record, no per-reader provider cost' })
    : t('receipt_cost.shared', { defaultValue: 'Shared capture, no per-reader provider cost' })
  const costText = shared
    ? [sharedText, captured ? t('receipt_cost.captured_at', { date: captured, defaultValue: 'captured {{date}}' }) : null].filter(Boolean).join(' · ')
    : t('receipt_cost.answered_live', { defaultValue: 'A provider call answered this read' })
  return (
    <details className="intel-source-call-receipt" data-envelope={kind} data-freshness={freshness || 'unmeasured'} data-served={shared ? 'shared' : 'live'}>
      <summary>
        {t('receipt_state.figure_summary', { defaultValue: 'About this figure' })}
        {kind === 'curated_stale' ? <> · <strong>{t('receipt_state.curated_stale', { defaultValue: 'Past its review window' })}</strong></> : null}
        {' · '}<span className="intel-receipt-cost" data-served={shared ? 'shared' : 'live'}>{costText}</span>
      </summary>
      <dl className="intel-event-facts">
        <dt>{t('receipt_state.source', { defaultValue: 'Source' })}</dt><dd>{providerLabel(envelope.source, t)}</dd>
        <dt>{t('research.fetched', { defaultValue: 'Retrieved' })}</dt>
        <dd>{envelope.fetchedAt ? <time dateTime={envelope.fetchedAt}>{time(envelope.fetchedAt)}</time> : t('receipt.not_reported', { defaultValue: 'not reported' })}</dd>
        <dt>{t('receipt_state.freshness', { defaultValue: 'Freshness' })}</dt><dd>{freshnessText}</dd>
      </dl>
      {scope && <p className="intel-analysis-caption">{scope}</p>}
      {list.map((r, i) => <SourceCallReceipt key={i} receipt={r} />)}
    </details>
  )
}
