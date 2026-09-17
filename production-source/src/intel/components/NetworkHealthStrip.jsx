import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { RadialGauge } from '../charts'
import { readCaptureView, captureUnavailable, captureReasonText } from '../lib/capture-api'
import { formatCompact } from '../lib/market-format'

// Network health strip (CMC plan proposal 29). Three gauges off the CoinMarketCap
// blockchain statistics read: hashrate over 24h, transactions per second over
// 24h and the pending transaction backlog, for the chains that publish them.
//
// PLAN GATE. CoinMarketCap publishes blockchain statistics from the Growth plan
// upwards. On the plan this workspace runs the capture lane is skipped and the
// read answers `rows: []` with `reason: 'plan_below_growth'` — a successful read
// that reports nothing. That is an EXPECTED absence, not a failure, so the strip
// keeps its heading and says so ONCE, in one calm line where the three gauges
// would have stood; three empty frames each carrying the same paragraph read as
// a broken page. The full sentence stays on the line's title attribute and in
// the `network_stats` lane of the page's capture receipts, so provenance is not
// lost. A read that genuinely failed still reports itself on every figure.
//
// It must never fall back to a derived, interpolated or remembered series: an
// unread network is unread.

const PLAN_REASON = 'plan_below_growth'
// One row per chain in reading order; the metric each chain is asked for first.
const HASHRATE_ORDER = ['BTC', 'LTC', 'ETH']
const THROUGHPUT_ORDER = ['ETH', 'LTC', 'BTC']

const num = value => {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** The row that actually reports `field`, preferring the chains the metric
 *  belongs to (hashrate is a proof-of-work reading, throughput an execution
 *  one). Returns null when no row published the field — never a zero, which on
 *  a gauge would read as a stalled chain. */
export function pickMetric(rows = [], field, preferred = []) {
  const usable = (Array.isArray(rows) ? rows : []).filter(row => num(row?.[field]) != null)
  for (const symbol of preferred) {
    const match = usable.find(row => String(row?.symbol || '').toUpperCase() === symbol)
    if (match) return { symbol: match.symbol, value: num(match[field]), capturedAt: match.capturedAt ?? null }
  }
  const first = usable[0]
  return first ? { symbol: first.symbol, value: num(first[field]), capturedAt: first.capturedAt ?? null } : null
}

/** Gauge numbers span twenty orders of magnitude here: a hashrate in the
 *  hundreds of quintillions and a throughput of fourteen transactions a second.
 *  The shared compact ladder drops the decimals below a thousand, which would
 *  print 14.2 TPS as "14" — a different reading — so small values keep one. */
export const gaugeFormat = value => {
  const n = num(value)
  if (n == null) return '—'
  return Math.abs(n) < 1000 ? formatCompact(n, { digits: 1 }) : formatCompact(n)
}

/** A round ceiling at or above a reading, so a single capture has a scale a
 *  reader can place it on: 1, 2 or 5 times a power of ten. */
export function niceCeiling(value) {
  const n = num(value)
  if (n == null || n <= 0) return 1
  const power = 10 ** Math.floor(Math.log10(n))
  for (const step of [1, 2, 5, 10]) if (n <= step * power) return step * power
  return 10 * power
}

export default function NetworkHealthStrip() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  // Service-role capture tables: the read travels on the reader's authenticated
  // client, never the anonymous one.
  const { supabase } = useSupabase()
  const orgId = org?.id || null
  const [read, setRead] = useState({ status: 'loading', payload: null, reason: null })

  useEffect(() => {
    const controller = new AbortController()
    let alive = true
    setRead({ status: 'loading', payload: null, reason: null })
    readCaptureView('network_stats', {}, { orgId, signal: controller.signal, supabase })
      .then(payload => { if (alive) setRead({ status: 'ready', payload, reason: null }) })
      .catch(error => { if (alive) setRead({ status: 'unavailable', payload: null, reason: captureUnavailable(error).reason }) })
    return () => { alive = false; controller.abort() }
  }, [orgId, supabase])

  const rows = useMemo(() => (Array.isArray(read.payload?.rows) ? read.payload.rows : []), [read.payload])
  // A successful read can still carry a reason: the plan gate is reported in the
  // body, not as a failure, and it is the reason a reader needs to see.
  const bodyReason = read.status === 'ready' ? (read.payload?.reason || null) : null
  const failed = read.status === 'unavailable'
  const stated = failed ? read.reason : bodyReason

  const planGated = stated != null && String(stated) === PLAN_REASON
  const reason = stated
    ? (planGated
        ? t('network.reason_plan', {
            defaultValue: 'CoinMarketCap publishes blockchain statistics from the Growth plan upwards; this workspace is below it, so the network lane is skipped and nothing was captured.',
          })
        : captureReasonText(t, stated))
    : undefined

  const gauges = [
    {
      key: 'hashrate',
      metric: pickMetric(rows, 'hashrate24h', HASHRATE_ORDER),
      title: t('network.hashrate_title', { defaultValue: 'Hashrate, 24h' }),
      description: t('network.hashrate_sub', { defaultValue: 'Reported hashes per second over the last 24 hours. The scale is a round ceiling above the reading, not a target.' }),
    },
    {
      key: 'tps',
      metric: pickMetric(rows, 'tps24h', THROUGHPUT_ORDER),
      title: t('network.tps_title', { defaultValue: 'Transactions per second, 24h' }),
      description: t('network.tps_sub', { defaultValue: 'Mean transactions per second over the last 24 hours. The scale is a round ceiling above the reading, not a target.' }),
    },
    {
      key: 'pending',
      metric: pickMetric(rows, 'pendingTransactions', THROUGHPUT_ORDER),
      title: t('network.pending_title', { defaultValue: 'Pending transactions' }),
      description: t('network.pending_sub', { defaultValue: 'Transactions waiting to be included at the moment of the capture. The scale is a round ceiling above the reading, not a target.' }),
    },
  ]

  return (
    <section className="intel-network-health space-y-2" aria-label={t('network.title', { defaultValue: 'Network health' })}>
      <div className="eyebrow">{t('network.eyebrow', { defaultValue: 'Network health' })}</div>
      {planGated ? (
        // One line in place of the whole group. The heading stays, so the lane is
        // visibly still part of the page rather than quietly removed.
        <p className="intel-chart-kit-note" role="status" title={reason} data-testid="network-plan-note">
          {t('network.plan_note', { defaultValue: 'Network statistics are not captured on this workspace’s CoinMarketCap plan.' })}
        </p>
      ) : (<>
        <p className="page-sub max-w-3xl">
          {t('network.sub', { defaultValue: 'What the chains themselves reported at the last capture. Each gauge names the chain it read; a chain that did not publish a figure is not drawn from another one.' })}
        </p>
        <div className="grid gap-x-8 gap-y-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 17rem), 1fr))', alignItems: 'start' }}>
          {gauges.map(gauge => {
            const value = gauge.metric?.value ?? null
            const state = reason ? 'error' : value == null ? 'empty' : 'ready'
            const max = niceCeiling(value)
            return (
              <RadialGauge
                key={gauge.key}
                title={gauge.title}
                description={gauge.metric?.symbol
                  ? `${gauge.description} ${t('network.read_from', { symbol: gauge.metric.symbol, defaultValue: 'Read from {{symbol}}.' })}`
                  : gauge.description}
                value={value}
                min={0}
                max={max}
                zones={value == null ? [] : [{ label: gauge.metric?.symbol || '—', to: max, tone: 'accent' }]}
                formatValue={gaugeFormat}
                state={state}
                reason={reason}
              />
            )
          })}
        </div>
      </>)}
    </section>
  )
}
