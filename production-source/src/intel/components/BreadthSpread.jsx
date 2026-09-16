import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { readCaptureView, captureUnavailable, captureReasonText } from '../lib/capture-api'
import { formatPct } from '../lib/market-format'

// Breadth in one number: the capitalisation-weighted 24h return minus the median
// 24h return, over the newest daily listing capture (`breadth` capture view,
// supabase/functions/_shared/intel/breadth-spread.ts). The figure is derived from
// a capture recorded once for everyone, so reading it never calls a provider.
//
// A plain figure: an eyebrow, one number, and the sentences that say what it
// means and what it does not. No card, no chip. A read with nothing usable is
// "not measured", never a zero spread.

const num = value => {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** Percentage points, signed, two places. A spread is a difference of two
 *  percentages, so it is never printed with a percent sign. */
export function formatSpreadPts(value) {
  const n = num(value)
  if (n == null) return null
  const rounded = Math.abs(n) < 0.005 ? 0 : n
  return `${rounded > 0 ? '+' : rounded < 0 ? '-' : ''}${Math.abs(rounded).toFixed(2)}`
}

export default function BreadthSpread() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase } = useSupabase()
  const orgId = org?.id || null
  const [read, setRead] = useState({ status: 'loading', payload: null, reason: null })

  useEffect(() => {
    const controller = new AbortController()
    let alive = true
    setRead({ status: 'loading', payload: null, reason: null })
    readCaptureView('breadth', {}, { orgId: orgId || undefined, signal: controller.signal, supabase })
      .then(payload => { if (alive) setRead({ status: 'ready', payload, reason: payload?.reason || null }) })
      .catch(error => { if (alive) setRead({ status: 'unavailable', payload: null, reason: captureUnavailable(error).reason }) })
    return () => { alive = false; controller.abort() }
  }, [orgId, supabase])

  const p = read.payload || {}
  const spread = formatSpreadPts(p.spreadPts)
  const included = num(p.included) ?? 0
  const noCap = num(p.excludedNoMarketCap) ?? 0
  const noReturn = num(p.excludedNoReturn) ?? 0
  const total = num(p.total) ?? 0

  let body
  if (read.status === 'loading') {
    body = <p role="status" className="intel-analysis-caption">{t('breadth_spread.loading', { defaultValue: 'Reading the daily listing capture…' })}</p>
  } else if (read.status === 'unavailable' || (spread == null && read.reason)) {
    body = <p role="alert" className="intel-analysis-caption">{t('breadth_spread.unavailable', { defaultValue: 'The spread could not be read.' })} {captureReasonText(t, read.reason)}</p>
  } else if (spread == null) {
    body = <p role="status" className="intel-analysis-caption">{t('breadth_spread.empty', { defaultValue: 'No daily listing capture with market capitalisation and 24h change is recorded yet, so the spread is not measured.' })}</p>
  } else {
    body = <>
      <p className="intel-number text-[22px] font-semibold text-[var(--fg-1)]">{t('breadth_spread.value', { value: spread, defaultValue: '{{value}} pts' })}</p>
      <p className="text-[12px] text-[var(--fg-2)]">{t('breadth_spread.sides', {
        weighted: formatPct(p.capWeightedReturnPct, { digits: 2 }), median: formatPct(p.medianReturnPct, { digits: 2 }), included, total,
        defaultValue: 'Capitalisation-weighted 24h return {{weighted}} minus the median asset’s {{median}}, over {{included}} of {{total}} captured assets.',
      })}</p>
      <p className="intel-analysis-caption">{t('breadth_spread.meaning', { defaultValue: 'Above zero, the largest assets did better than the typical asset; below zero, the typical asset did better than the largest ones.' })}</p>
      <p className="intel-analysis-caption">{t('breadth_spread.not_meaning', { defaultValue: 'It is not a forecast and not a count of assets up or down, and a spread near zero does not mean every asset moved alike.' })}</p>
      {(noCap > 0 || noReturn > 0) && <p className="intel-analysis-caption">{t('breadth_spread.excluded', { noCap, noReturn, defaultValue: '{{noCap}} assets without a market capitalisation and {{noReturn}} without a 24h change were left out of both sides.' })}</p>}
      {p.snapshotDate && <p className="intel-analysis-caption">{t('breadth_spread.clock', { date: p.snapshotDate, defaultValue: 'Daily listing capture of {{date}} (UTC).' })}</p>}
    </>
  }

  return (
    <section className="space-y-1" aria-label={t('breadth_spread.title', { defaultValue: 'Breadth in one number' })}>
      <div className="eyebrow">{t('breadth_spread.title', { defaultValue: 'Breadth in one number' })}</div>
      {body}
    </section>
  )
}
