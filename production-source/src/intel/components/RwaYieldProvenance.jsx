import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import BoardTableHeader, { BOARD_CELL_CLASS } from './BoardTableHeader'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { readCaptureView, captureUnavailable, captureReasonText } from '../lib/capture-api'
import { formatPct } from '../lib/market-format'

// RWA yield provenance and NAV integrity.
//
// Three figures per tokenised fund, side by side: what the issuer ADVERTISES,
// what the fund actually REALIZED according to its own on-chain net asset value
// history, and what the ACTUAL underlying instrument paid over the same period.
//
// THE RULE THIS SURFACE EXISTS TO KEEP. A realized yield is only ever drawn as a
// number when the capture marked it publishable. A fund whose NAV fell is drawn
// as "unexplained, in review" with no number at all, because a falling NAV may
// be a distribution or a credit loss and free data cannot tell them apart.
// Rendering minus fifty-three percent as a yield headline would state a fact
// nobody has established.
//
// A realized yield of exactly 0 is drawn as 0. A stable-NAV fund really did
// change by nothing, and blanking that would erase the measurement this engine
// is most confident about. The note under the table says why a flat NAV is not
// the same as no return.
//
// House style: eyebrows, hairlines and an underline rail. No pills, no cards.

const num = value => {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** Hours, for a staleness age the reader can judge against a heartbeat. */
export function ageHours(seconds) {
  const n = num(seconds)
  return n == null ? null : n / 3600
}

/** What the realized column may draw.
 *
 * `publishable` is the capture's own decision, carried through the read view.
 * This function never re-derives it from the number, because a number that
 * exists is not the same as a number we are allowed to show. */
export function realizedCell(row) {
  if (row?.publishable && num(row?.realizedPct) != null) return { kind: 'value', value: num(row.realizedPct) }
  return { kind: 'state', state: String(row?.realizedState || 'insufficient_history') }
}

/** The capture times (UTC) the read view serves for the yield lane, with the
 * times the migration schedules as a fallback for an older payload. Same
 * pattern as captureTimes() on the issuer legitimacy board. */
export function yieldCaptureTimes(schedule) {
  return schedule?.rwa_yield?.utc || '01:29, 07:29, 13:29, 19:29'
}

/** Nothing captured yet: the read found no capture hour at all. A panel in this
 * state says when it fills instead of rendering as blank. */
export function yieldNotCaptured(payload) {
  return !payload?.asOf && !(Array.isArray(payload?.rows) && payload.rows.length)
}

/** A capture instant as a readable UTC minute. */
const utcMinute = value => {
  const text = String(value || '')
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text) ? `${text.slice(0, 10)} ${text.slice(11, 16)} UTC` : text
}

export default function RwaYieldProvenance() {
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
    readCaptureView('rwa_yield', {}, { orgId, signal: controller.signal, supabase })
      .then(payload => { if (alive) setRead({ status: 'ready', payload, reason: null }) })
      .catch(error => { if (alive) setRead({ status: 'unavailable', payload: null, reason: captureUnavailable(error).reason }) })
    return () => { alive = false; controller.abort() }
  }, [orgId, supabase])

  const rows = useMemo(
    () => (Array.isArray(read.payload?.rows) ? read.payload.rows : []),
    [read.payload],
  )
  const summary = read.payload?.summary || {}
  const benchmarks = Array.isArray(read.payload?.benchmarks) ? read.payload.benchmarks : []
  // When the capture lane runs, as the read view reports it.
  const times = yieldCaptureTimes(read.payload?.schedule)

  const stateLabel = state => t(`structure.rwa_yield_state_${state}`, {
    defaultValue: {
      published: 'Published',
      review_declining: 'Unexplained decline, in review',
      review_implausible: 'Implausible for window, in review',
      insufficient_history: 'Not enough history',
      stale_feed: 'Feed stale',
    }[state] || state,
  })
  const notAvailable = t('structure.rwa_yield_not_available', { defaultValue: 'Not available' })
  const benchmarkLabel = key => t(`structure.rwa_yield_benchmark_${key}`, {
    defaultValue: {
      us_treasury_bill_3m: 'US 3 month bill',
      us_treasury_bill_avg: 'US bill average',
      sofr: 'SOFR',
      estr: 'ESTR',
    }[key] || key,
  })

  const columns = [
    t('structure.rwa_yield_col_feed', { defaultValue: 'Fund' }),
    t('structure.rwa_yield_col_advertised', { defaultValue: 'Advertised' }),
    t('structure.rwa_yield_col_realized', { defaultValue: 'Realized from NAV' }),
    t('structure.rwa_yield_col_benchmark', { defaultValue: 'Underlying instrument' }),
    t('structure.rwa_yield_col_spread', { defaultValue: 'Gap' }),
    t('structure.rwa_yield_col_deviation', { defaultValue: 'Price vs NAV' }),
    t('structure.rwa_yield_col_health', { defaultValue: 'Feed health' }),
  ]

  const state = read.status === 'unavailable' ? 'error' : (read.status === 'ready' && rows.length) ? 'ready' : read.status === 'loading' ? 'loading' : 'empty'

  return (
    <section className="intel-rwa-yield space-y-3" aria-label={t('structure.rwa_yield_title', { defaultValue: 'RWA yield provenance' })}>
      <div className="border-b border-[var(--border-default)] pb-2">
        <div className="eyebrow">{t('structure.rwa_yield_eyebrow', { defaultValue: 'Yield provenance' })}</div>
        <p className="intel-analysis-caption mb-0">
          {t('structure.rwa_yield_sub', { defaultValue: 'What each tokenised fund advertises, what its own on-chain net asset value history actually delivered, and what the underlying instrument paid over the same period. Every feed address is proved on chain before it is shown.' })}
        </p>
      </div>

      {state === 'loading' && <p role="status">{t('structure.rwa_yield_loading', { defaultValue: 'Reading the recorded yield captures…' })}</p>}

      {state === 'error' && (
        <p role="alert">
          {t('structure.rwa_yield_unavailable', { defaultValue: 'The recorded yield captures could not be read.' })}
          {' '}
          {captureReasonText(t, read.reason)}
        </p>
      )}

      {state === 'empty' && (
        <p role="status">
          {yieldNotCaptured(read.payload)
            ? t('structure.rwa_yield_not_captured', { times, defaultValue: 'No yield capture has been recorded yet. Net asset value feeds are read every six hours, at {{times}} UTC. Nothing is estimated in the meantime.' })
            : t('structure.rwa_yield_empty', { defaultValue: 'No yield capture has been recorded yet. Nothing is estimated in the meantime.' })}
        </p>
      )}

      {state === 'ready' && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <caption className="text-left text-[11px] text-[var(--fg-4)] pb-2">
                {t('structure.rwa_yield_caption', {
                  feeds: summary.feeds ?? rows.length,
                  published: summary.published ?? 0,
                  review: summary.review ?? 0,
                  defaultValue: '{{feeds}} proved feeds. {{published}} publishable, {{review}} routed to review because the change in net asset value cannot be explained from free data.',
                })}
              </caption>
              <thead>
                <BoardTableHeader columns={columns} numeric={[1, 2, 3, 4, 5]} />
              </thead>
              <tbody>
                {rows.map(row => {
                  const realized = realizedCell(row)
                  const advertised = num(row.advertisedPct)
                  const benchmark = num(row.benchmarkPct)
                  const spread = num(row.spreadPct)
                  const deviation = num(row.deviationPct)
                  const hours = ageHours(row.ageSeconds)
                  return (
                    <tr key={row.feedKey}>
                      <th scope="row" className={`text-left font-normal text-[var(--fg-2)] ${BOARD_CELL_CLASS}`}>
                        {row.feedName || row.feedKey}
                        {row.validationState === 'refused' && (
                          <span className="block text-[11px] text-[var(--fg-4)]">
                            {t('structure.rwa_yield_refused', {
                              reason: String(row.validationReason || '').replaceAll('_', ' '),
                              defaultValue: 'Refused on chain: {{reason}}',
                            })}
                          </span>
                        )}
                      </th>
                      <td className={`intel-number ${BOARD_CELL_CLASS}`}>
                        {advertised != null
                          ? formatPct(advertised)
                          : <span className="text-[var(--fg-4)]">{t('structure.rwa_yield_not_published', { defaultValue: 'Not published' })}</span>}
                      </td>
                      <td className={`intel-number ${BOARD_CELL_CLASS}`}>
                        {realized.kind === 'value'
                          // An exact zero renders as zero. It is a measurement.
                          ? formatPct(realized.value)
                          : <span className="text-[var(--fg-4)]">{stateLabel(realized.state)}</span>}
                      </td>
                      <td className={`intel-number ${BOARD_CELL_CLASS}`}>
                        {benchmark != null
                          ? (
                            <>
                              {formatPct(benchmark)}
                              <span className="block text-[11px] text-[var(--fg-4)]">{benchmarkLabel(row.benchmarkKey)}</span>
                            </>
                          )
                          : <span className="text-[var(--fg-4)]">{String(row.benchmarkReason || '').replaceAll('_', ' ') || notAvailable}</span>}
                      </td>
                      <td className={`intel-number ${BOARD_CELL_CLASS}`}>
                        {spread != null ? formatPct(spread) : <span className="text-[var(--fg-4)]">{notAvailable}</span>}
                      </td>
                      <td className={`intel-number ${BOARD_CELL_CLASS}`}>
                        {deviation != null
                          ? (
                            <>
                              {formatPct(deviation)}
                              {/* The market half is a different source from the NAV
                                  half, so the row says which catalogue it came from. */}
                              <span className="block text-[11px] text-[var(--fg-4)]">{row.marketProvider}</span>
                            </>
                          )
                          : <span className="text-[var(--fg-4)]">{String(row.deviationReason || '').replaceAll('_', ' ') || notAvailable}</span>}
                      </td>
                      <td className={BOARD_CELL_CLASS}>
                        {t(`structure.rwa_yield_health_${row.staleness}`, {
                          defaultValue: { fresh: 'Fresh', stale: 'Stale', unknown: 'Unknown' }[row.staleness] || row.staleness,
                        })}
                        {hours != null && (
                          <span className="block text-[11px] text-[var(--fg-4)]">
                            {t('structure.rwa_yield_age', { hours: hours.toFixed(1), defaultValue: '{{hours}} h since the last round' })}
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <p className="intel-analysis-caption">
            {t('structure.rwa_yield_cadence', {
              times,
              asOf: utcMinute(read.payload?.asOf),
              defaultValue: 'Net asset value feeds are read every six hours, at {{times}} UTC. This table is the capture of {{asOf}}.',
            })}
          </p>

          <p className="intel-analysis-caption">
            {t('structure.rwa_yield_integrity', {
              stale: summary.stale ?? 0,
              unknown: summary.unknown ?? 0,
              defaultValue: 'NAV integrity: {{stale}} feeds are past their own published heartbeat and {{unknown}} could not be judged at all. A feed we could not read is not reported as healthy.',
            })}
          </p>

          {benchmarks.length > 0 && (
            <p className="intel-analysis-caption">
              {t('structure.rwa_yield_benchmark_sources', { defaultValue: 'Benchmark rates, each on its own publication date:' })}
              {' '}
              {benchmarks.map(entry => `${benchmarkLabel(entry.key)} ${formatPct(num(entry.ratePct))} (${entry.observedAt})`).join(', ')}
            </p>
          )}

          {/* The two halves of a price-against-NAV figure are always two
              different sources. An unstated source mix is not acceptable, so it
              is named here beside the column that uses it. */}
          <p className="intel-analysis-caption">
            {t('structure.rwa_yield_market_note', { defaultValue: 'The net asset value is the fund\'s own published figure read on chain. The market price comes from our CoinGecko-sourced catalogue, matched on that catalogue\'s provider id with the fund name re-verified, never on a ticker. These are two different sources with two different clocks.' })}
            {' '}
            {t('structure.rwa_yield_market_limit', { defaultValue: 'CoinMarketCap publishes no identifier for these tokenised treasury and credit funds, so the market side cannot come from it.' })}
          </p>

          <p className="intel-analysis-caption">
            {t('structure.rwa_yield_total_return_note', { defaultValue: 'Net asset value growth is not total return. A fund that distributes its income holds its net asset value flat, so a realized figure of zero can mean the return was paid out rather than accrued. Distributions are not observable from the feed, and a fund whose net asset value fell is never published as a negative yield.' })}
          </p>
        </>
      )}
    </section>
  )
}
