import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import BoardTableHeader from './BoardTableHeader'
import { Histogram, RadialBars } from '../charts'
import { ChartFrame } from '../charts/frame'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { readCaptureView, captureUnavailable, captureReasonText } from '../lib/capture-api'
import { useUrlState } from '../lib/useUrlState'
import { getChain, chainIdFor } from '../lib/chains'
import { formatUsd, fmtNum } from '../lib/market-format'
import RateInterval from './thesis/RateInterval'

// Meme graduation lifecycle (CMC plan proposal 30). The hourly launch-stage
// capture read as a funnel, a cohort graduation rate, a time-to-graduate
// distribution and a retention table.
//
// Contract: `meme_graduation` takes { days: 1|7|30, chain? } — `chain` is a CAIP
// chain, omitted for "all" — and answers { funnel, graduationRate, cohort,
// timeToGraduate, retention, recent, asOf, coverage, reason }.
//
// WHAT THE NUMBERS MEAN, because they mean nothing without it:
//
//   funnel          the stage board of the NEWEST capture only, never a sum over
//                   the window. `contracts` is a bounded sample of the stage, not
//                   the stage.
//   graduationRate  a COHORT rate: of the contracts FIRST SEEN inside the window,
//                   how many reached the graduates list inside the same window.
//                   Null when nothing was first seen — an unmeasurable rate is
//                   never drawn as a zero.
//   timeToGraduate  hours between OUR first sighting and the graduation
//                   transition. The provider publishes no clock for a discovery
//                   list, so `captured_at` is our capture hour: every hour figure
//                   here is time since we first saw the contract, not since it
//                   was deployed.
//   retention       `eligible` counts only the contracts that have HAD H hours
//                   since their own first sighting, so a contract first seen
//                   twenty minutes ago cannot fail a 24-hour test.
//
// FOUR.MEME IS NOT COVERED. The lane reads the four CoinMarketCap DEX platforms
// this platform has verified evidence for — solana, base, ethereum, arbitrum.
// Four.meme launches on BNB Chain, which is not one of them, so no Four.meme
// cohort is captured and none is implied.
//
// THE HONEST EMPTY STATE. The hourly lane can run and be told by the provider
// that every platform has an empty list. That is a successful read with an empty
// funnel and `asOf: null`, and it renders as "the provider reported no launches
// for these platforms at the last capture" — never an error, and never a
// fabricated funnel.

const DAYS = [1, 7, 30]
const DEFAULT_DAYS = 7
export const STAGES = ['newCreations', 'aboutGraduates', 'graduates']
export const MEME_CHAINS = ['all', 'solana', 'base', 'ethereum', 'arbitrum']
const DEFAULT_CHAIN = 'all'
const RECENT_MAX = 25
// Hoisted so useUrlState's memo/callback identities stay stable across renders.
const URL_DEFAULTS = { g_days: String(DEFAULT_DAYS), g_chain: DEFAULT_CHAIN }

const num = value => {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

const optionOf = (options, raw, fallback) => (options.includes(Number(raw)) ? Number(raw) : fallback)

/** The CAIP chain the read is asked for, or null for "all". Derived from the
 *  chain registry rather than written out again, so a chain whose CAIP reference
 *  moves there cannot silently point at the wrong network. */
export function chainCaip(id) {
  if (!id || id === 'all' || !MEME_CHAINS.includes(id)) return null
  const chain = getChain(id)
  if (!chain) return null
  return chain.namespace === 'eip155' ? `eip155:${chain.caip2Ref}` : chain.id
}

/** A stored CAIP chain, named the way chains.js names it. An unknown chain is
 *  shown verbatim rather than folded onto a network we did not read. */
export function chainLabel(caip) {
  const raw = String(caip ?? '').trim()
  if (!raw) return '—'
  const [namespace, reference] = raw.includes(':') ? [raw.slice(0, raw.indexOf(':')), raw.slice(raw.indexOf(':') + 1)] : [raw, 'mainnet']
  return getChain(chainIdFor(namespace, reference) || '')?.label || raw
}

/** The three stages in launch order, whatever order the read returned them in
 *  and whichever of them the newest capture happened to hold. `max` is the
 *  LARGEST stage count, so the outer ring is the widest stage and the rings below
 *  it are read as shares of it. A stage the capture did not report is a zero on a
 *  board that has other stages — not a missing ring. */
export function funnelSeries(funnel = []) {
  const rows = Array.isArray(funnel) ? funnel.filter(row => row && row.stage) : []
  if (!rows.length) return []
  const counts = new Map(rows.map(row => [row.stage, num(row.count) ?? 0]))
  const ceiling = Math.max(1, ...STAGES.map(stage => counts.get(stage) ?? 0))
  return STAGES.map(stage => ({
    key: stage,
    stage,
    label: stage,
    value: counts.get(stage) ?? 0,
    max: ceiling,
  }))
}

/** The time-to-graduate histogram in the chart kit's bin shape. The read owns
 *  the edges — fixed hour buckets with the last one open-ended — and they are
 *  passed straight through: re-deriving bins here would quietly disagree with the
 *  source that published them. An empty bucket stays in the answer as a zero
 *  rather than closing the gap and implying a denser distribution. */
export function histogramBins(timeToGraduate) {
  const bins = Array.isArray(timeToGraduate?.histogram) ? timeToGraduate.histogram : []
  return bins.map(bin => {
    const from = num(bin?.fromHours) ?? 0
    // A null upper edge is the open-ended last bucket, not a zero.
    const to = num(bin?.toHours)
    return { key: `${from}-${to ?? 'open'}`, from, to, count: num(bin?.count) ?? 0 }
  })
}

const hours = value => (num(value) == null ? '—' : `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 })}h`)

const stamp = value => {
  const at = Date.parse(value)
  return Number.isFinite(at)
    ? new Date(at).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })
    : '—'
}

const shortAddress = value => {
  const raw = String(value ?? '').trim()
  if (!raw) return '—'
  return raw.length <= 16 ? raw : `${raw.slice(0, 8)}…${raw.slice(-6)}`
}

export default function GraduationFunnel() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  // Service-role capture tables: the read travels on the reader's authenticated
  // client, never the anonymous one.
  const { supabase } = useSupabase()
  const orgId = org?.id || null
  const [urlState, setUrlState] = useUrlState(URL_DEFAULTS)
  const days = optionOf(DAYS, urlState.g_days, DEFAULT_DAYS)
  const chain = MEME_CHAINS.includes(urlState.g_chain) ? urlState.g_chain : DEFAULT_CHAIN
  const caip = chainCaip(chain)
  const [read, setRead] = useState({ status: 'loading', payload: null, reason: null })

  useEffect(() => {
    const controller = new AbortController()
    let alive = true
    setRead({ status: 'loading', payload: null, reason: null })
    // `chain` is omitted, never sent as null: an explicit null is a filter the
    // read would have to interpret, and "all platforms" is the absence of one.
    const params = caip ? { days, chain: caip } : { days }
    readCaptureView('meme_graduation', params, { orgId, signal: controller.signal, supabase })
      .then(payload => { if (alive) setRead({ status: 'ready', payload, reason: null }) })
      .catch(error => { if (alive) setRead({ status: 'unavailable', payload: null, reason: captureUnavailable(error).reason }) })
    return () => { alive = false; controller.abort() }
  }, [orgId, days, caip, supabase])

  const payload = read.payload
  const funnel = useMemo(() => funnelSeries(payload?.funnel), [payload])
  const bins = useMemo(() => histogramBins(payload?.timeToGraduate), [payload])
  const retention = useMemo(() => (Array.isArray(payload?.retention) ? payload.retention : []), [payload])
  const recent = useMemo(() => (Array.isArray(payload?.recent) ? payload.recent.slice(0, RECENT_MAX) : []), [payload])
  const cohort = payload?.cohort && typeof payload.cohort === 'object' ? payload.cohort : null
  const ttg = payload?.timeToGraduate && typeof payload.timeToGraduate === 'object' ? payload.timeToGraduate : null

  // An empty capture answers with an empty funnel and NO reason — that is an
  // empty reading. A reason on a successful read is a failed query behind it.
  const stated = read.status === 'unavailable' ? read.reason : (read.status === 'ready' ? (payload?.reason || null) : null)
  const reason = stated ? captureReasonText(t, stated) : undefined
  const ready = !stated && read.status === 'ready'
  const funnelState = stated ? 'error' : (ready && funnel.length) ? 'ready' : 'empty'
  const binState = stated ? 'error' : (ready && bins.length) ? 'ready' : 'empty'

  // The provider answering EMPTY lists for every platform is a successful read,
  // not a failure and not "no observations": the honest line names what actually
  // happened at the last capture.
  const emptyNote = (ready && !funnel.length)
    ? t('graduation.empty_provider', {
        defaultValue: 'The hourly capture ran and the provider reported no launches for these platforms at the last capture.',
      })
    : null
  const frameText = (key, options) => (key === 'charts.empty' && emptyNote ? emptyNote : t(key, options))

  const clock = t('graduation.clock', {
    defaultValue: 'The launch lists are captured once an hour. The provider publishes no clock for a discovery list, so the capture hour is OURS and every hour figure here is time since WE first saw the contract, not since it was deployed. Four.meme is not covered: it launches on BNB Chain, which is not one of the four CoinMarketCap DEX platforms this lane reads.',
  })

  const stageLabel = stage => (stage === 'newCreations'
    ? t('graduation.stage_new', { defaultValue: 'New creations' })
    : stage === 'aboutGraduates'
      ? t('graduation.stage_about', { defaultValue: 'About to graduate' })
      : stage === 'graduates'
        ? t('graduation.stage_graduates', { defaultValue: 'Graduates' })
        : stage || '—')

  const rate = num(payload?.graduationRate)
  const rateLine = !ready
    ? ''
    : rate == null
      ? t('graduation.rate_none', {
          defaultValue: 'No graduation rate: no cohort completed the window, so there is no denominator to measure against.',
        })
      : t('graduation.rate_line', {
          rate: `${(rate * 100).toFixed(1)}%`,
          graduated: fmtNum(num(cohort?.graduatedInWindow) ?? 0),
          seen: fmtNum(num(cohort?.firstSeenInWindow) ?? 0),
          defaultValue: '{{graduated}} of the {{seen}} contracts first seen inside this window reached the graduates list inside it — {{rate}}.',
        })

  const control = (label, options, current, apply, format) => (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]" role="group" aria-label={label}>
      <span className="text-[var(--fg-4)]">{label}</span>
      {options.map(value => (
        <button
          key={value}
          type="button"
          aria-pressed={value === current}
          onClick={() => apply(value)}
          className={value === current
            ? 'text-[var(--fg-1)] underline underline-offset-4'
            : 'text-[var(--fg-4)] hover:text-[var(--fg-2)]'}
        >
          {format(value)}
        </button>
      ))}
    </div>
  )

  const funnelTitle = t('graduation.funnel_title', { defaultValue: 'Launch stage funnel' })
  const funnelDescription = `${t('graduation.funnel_sub', {
    defaultValue: 'The stage board of the NEWEST capture only, from new creations through about-to-graduate to graduates. The outer ring is the largest stage; the rings inside it are read as a share of it. This is a snapshot of one hour, never a sum over the window.',
  })} ${clock}`

  const binTitle = t('graduation.hist_title', { defaultValue: 'Time to graduate' })
  const binDescription = `${t('graduation.hist_sub', {
    defaultValue: 'How long the graduations recorded in this window took, counted from our first sighting of the contract. Fixed hour buckets, the last one open-ended; an empty bucket stays a zero rather than closing the gap.',
  })}${ttg
    ? ` ${t('graduation.hist_percentiles', {
        median: hours(ttg.median), p25: hours(ttg.p25), p75: hours(ttg.p75), sample: fmtNum(num(ttg.sample) ?? 0),
        defaultValue: 'Median {{median}}, 25th percentile {{p25}}, 75th percentile {{p75}}, over {{sample}} recorded graduations.',
      })}`
    : ` ${t('graduation.hist_none', { defaultValue: 'No graduation transition is retained in this window, so there is no distribution to draw.' })}`}`

  return (
    <section className="intel-graduation-funnel space-y-3" aria-label={funnelTitle}>
      {funnelState === 'ready' ? (
        <RadialBars
          title={funnelTitle}
          description={funnelDescription}
          series={funnel.map(row => ({ ...row, label: stageLabel(row.stage) }))}
          formatValue={value => fmtNum(value)}
          state="ready"
        />
      ) : (
        <ChartFrame t={frameText} title={funnelTitle} description={funnelDescription} state={funnelState} reason={reason} />
      )}

      <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
        {control(
          t('graduation.window', { defaultValue: 'Window' }),
          DAYS,
          days,
          value => setUrlState({ g_days: String(value) }),
          value => t('graduation.window_option', { days: value, defaultValue: '{{days}}d' }),
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]" role="group" aria-label={t('graduation.chain', { defaultValue: 'Platform' })}>
          <span className="text-[var(--fg-4)]">{t('graduation.chain', { defaultValue: 'Platform' })}</span>
          {MEME_CHAINS.map(value => (
            <button
              key={value}
              type="button"
              aria-pressed={value === chain}
              onClick={() => setUrlState({ g_chain: value })}
              className={value === chain
                ? 'text-[var(--fg-1)] underline underline-offset-4'
                : 'text-[var(--fg-4)] hover:text-[var(--fg-2)]'}
            >
              {value === 'all' ? t('graduation.chain_all', { defaultValue: 'All platforms' }) : (getChain(value)?.label || value)}
            </button>
          ))}
        </div>
      </div>

      {rateLine ? <p className="intel-analysis-caption" data-testid="graduation-rate">{rateLine}</p> : null}
      {/* A cohort rate is quoted with its Wilson 95% interval and cohort size, so
          2 of 8 never reads as certain as 200 of 800. No cohort, no interval. */}
      {ready && rate != null ? <p className="intel-analysis-caption" data-testid="graduation-rate-interval"><RateInterval successes={num(cohort?.graduatedInWindow)} n={num(cohort?.firstSeenInWindow)} className="" /></p> : null}

      {binState === 'ready' ? (
        <Histogram
          title={binTitle}
          description={binDescription}
          bins={bins}
          formatValue={value => `${fmtNum(value)}h`}
          formatCount={value => fmtNum(value)}
          state="ready"
        />
      ) : (
        <ChartFrame t={frameText} title={binTitle} description={binDescription} state={binState} reason={reason} />
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-[12px]" data-testid="graduation-retention">
          <caption className="text-left text-[11px] text-[var(--fg-4)] pb-2">
            {t('graduation.retention_caption', {
              defaultValue: 'Of the contracts first seen inside this window, how many were still on a stage list at least that long after their OWN first sighting. A contract that has not yet had that long since we first saw it is not eligible and is not counted against the test.',
            })}
          </caption>
          <thead>
            <BoardTableHeader
              columns={[
                t('graduation.col_hours', { defaultValue: 'Hours since first seen' }),
                t('graduation.col_still', { defaultValue: 'Still listed' }),
                t('graduation.col_eligible', { defaultValue: 'Eligible' }),
                t('graduation.col_share', { defaultValue: 'Share' }),
              ]}
              numeric={[1, 2, 3]}
            />
          </thead>
          <tbody>
            {retention.length ? retention.map(row => {
              const eligible = num(row?.eligible) ?? 0
              const still = num(row?.stillListed) ?? 0
              return (
                <tr key={row?.hoursSinceFirstSeen}>
                  <th scope="row" className="text-left font-normal text-[var(--fg-2)] border-b border-[var(--border-default)] py-2 pr-3">{`${fmtNum(num(row?.hoursSinceFirstSeen))}h`}</th>
                  <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{fmtNum(still)}</td>
                  <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{fmtNum(eligible)}</td>
                  {/* No eligible contracts is not a zero share: it is no reading. */}
                  <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">
                    <span data-share>{eligible > 0 ? `${((still / eligible) * 100).toFixed(1)}%` : '\u2014'}</span>
                    {eligible > 0 ? <span className="block text-[11px] text-[var(--fg-4)]" data-testid="graduation-retention-interval"><RateInterval successes={still} n={eligible} className="" /></span> : null}
                  </td>
                </tr>
              )
            }) : (
              <tr><td colSpan={4} className="py-2 text-[var(--fg-4)]">{emptyNote || t('graduation.retention_empty', { defaultValue: 'No cohort was first seen inside this window, so there is nothing to retain.' })}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[12px]" data-testid="graduation-recent">
          <caption className="text-left text-[11px] text-[var(--fg-4)] pb-2">
            {t('graduation.recent_caption', {
              count: recent.length,
              defaultValue: 'The {{count}} most recently captured contracts, newest sighting first. The stage is the one the last capture recorded, and the market cap is the provider’s at that capture.',
            })}
          </caption>
          <thead>
            <BoardTableHeader
              columns={[
                t('graduation.col_symbol', { defaultValue: 'Symbol' }),
                t('graduation.col_name', { defaultValue: 'Name' }),
                t('graduation.col_chain', { defaultValue: 'Chain' }),
                t('graduation.col_contract', { defaultValue: 'Contract' }),
                t('graduation.col_stage', { defaultValue: 'Stage' }),
                t('graduation.col_first_seen', { defaultValue: 'First seen (UTC)' }),
                t('graduation.col_captured', { defaultValue: 'Captured (UTC)' }),
                t('graduation.col_market_cap', { defaultValue: 'Market cap' }),
              ]}
              numeric={[7]}
            />
          </thead>
          <tbody>
            {recent.length ? recent.map((row, index) => (
              <tr key={`${row?.chain}-${row?.contractAddress}-${index}`}>
                <th scope="row" className="text-left font-normal text-[var(--fg-2)] border-b border-[var(--border-default)] py-2 pr-3">{row?.symbol || '—'}</th>
                <td className="border-b border-[var(--border-default)] py-2 pr-3">{row?.name || '—'}</td>
                <td className="border-b border-[var(--border-default)] py-2 pr-3">{chainLabel(row?.chain)}</td>
                <td className="border-b border-[var(--border-default)] py-2 pr-3">{shortAddress(row?.contractAddress)}</td>
                <td className="border-b border-[var(--border-default)] py-2 pr-3">{stageLabel(row?.stage)}</td>
                <td className="border-b border-[var(--border-default)] py-2 pr-3">{stamp(row?.firstSeenAt)}</td>
                <td className="border-b border-[var(--border-default)] py-2 pr-3">{stamp(row?.capturedAt)}</td>
                <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{num(row?.marketCap) == null ? '—' : formatUsd(row.marketCap)}</td>
              </tr>
            )) : (
              <tr><td colSpan={8} className="py-2 text-[var(--fg-4)]">{emptyNote || t('graduation.recent_empty', { defaultValue: 'No contract was captured inside this window.' })}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}
