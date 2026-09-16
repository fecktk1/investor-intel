import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Gauge } from 'lucide-react'
import { IntelPageHeader, IntelPageShell } from '../components/IntelPrimitives'
import CaptureReceipts from '../components/CaptureReceipts'
import RegimeRibbon from '../components/RegimeRibbon'
import RegimeDayPanel from '../components/RegimeDayPanel'
import NetworkHealthStrip from '../components/NetworkHealthStrip'
import BreadthSpread from '../components/BreadthSpread'
import { captureReasonText } from '../lib/capture-api'
import { PolarClock } from '../charts'

// Route: /intel/regime. What regime the market has been in, what a single
// recorded day looked like, and which hour of the day the recorded captures are
// most fearful in. Every figure reads the same `regime` series: the ribbon owns
// the read and reports it here, so the page never asks the capture service for
// the same window twice.

const HOURS = 24

/** Mean fear and greed per UTC hour of day across the whole range. Every one of
 *  the 24 hours is emitted so the clock face keeps its bearings; an hour with no
 *  capture carries a null value and prints as a dash rather than as a zero,
 *  which on this scale would read as "maximally fearful". */
export function hourlyFearGreed(series = []) {
  const buckets = Array.from({ length: HOURS }, () => ({ total: 0, count: 0 }))
  for (const point of Array.isArray(series) ? series : []) {
    const at = Date.parse(point?.capturedAt)
    const value = point?.fearGreed
    if (!Number.isFinite(at) || value == null || value === '' || typeof value === 'boolean') continue
    const n = Number(value)
    if (!Number.isFinite(n)) continue
    const bucket = buckets[new Date(at).getUTCHours()]
    bucket.total += n
    bucket.count += 1
  }
  return buckets.map((bucket, hour) => ({
    hour,
    label: `${String(hour).padStart(2, '0')}:00`,
    value: bucket.count ? bucket.total / bucket.count : null,
    observations: bucket.count,
  }))
}

// The capture lanes whose newest run the receipt drawer describes.
const CAPTURE_RECEIPT_LANES = ['regime', 'network_stats']

export default function RegimePage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const [read, setRead] = useState({ payload: null, unavailable: null, loading: true })

  const series = Array.isArray(read.payload?.series) ? read.payload.series : []
  const hours = useMemo(() => hourlyFearGreed(series), [series])
  const observed = hours.filter(bucket => bucket.observations > 0).length
  const unavailable = read.unavailable || (read.payload?.reason ? { reason: read.payload.reason } : null)
  const reason = unavailable ? captureReasonText(t, unavailable.reason) : undefined
  const clockState = unavailable ? 'error' : observed ? 'ready' : 'empty'

  return (
    <IntelPageShell>
      <IntelPageHeader
        icon={Gauge}
        eyebrow={t('regime.page_eyebrow', { defaultValue: 'Market regime' })}
        title={t('regime.page_title', { defaultValue: 'Market regime' })}
        subtitle={t('regime.page_sub', { defaultValue: 'What the market has looked like, read from the captures that were actually recorded. Every figure names the clock of the observation behind it.' })}
      />
      <CaptureReceipts lanes={CAPTURE_RECEIPT_LANES} />

      <RegimeRibbon onLoad={setRead} />

      {/* Breadth in one number. Owns its read of the daily listing capture. */}
      <BreadthSpread />

      <RegimeDayPanel coverageFrom={read.payload?.coverage?.from || null} />

      <section className="space-y-2" aria-label={t('regime.hours_title', { defaultValue: 'Fear and greed by hour of day' })}>
        <div className="eyebrow">{t('regime.hours_eyebrow', { defaultValue: 'Time of day' })}</div>
        <PolarClock
          title={t('regime.hours_title', { defaultValue: 'Fear and greed by hour of day' })}
          description={t('regime.hours_sub', {
            observed, hours: HOURS,
            defaultValue: 'Mean fear and greed for each hour (UTC) across the selected period. A shorter bar is a more fearful hour. {{observed}} of {{hours}} hours have captures.',
          })}
          period="24h"
          buckets={hours}
          formatValue={value => (value == null || value === '' ? '—' : Number(value).toFixed(0))}
          state={clockState} reason={reason}
        />
      </section>

      {/* What the chains themselves reported, beside what the market felt. Owns
          its own read and its own plan gate. */}
      <NetworkHealthStrip />
    </IntelPageShell>
  )
}
