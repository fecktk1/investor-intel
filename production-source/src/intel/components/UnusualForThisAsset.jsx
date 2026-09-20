import React, { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { readCaptureView, captureUnavailable, captureReasonText } from '../lib/capture-api'
import { formatPct, formatUsd } from '../lib/market-format'
import { marketPanelHref } from '../lib/market-links'
import TokenAvatar from './TokenAvatar'
import MetricAgreementChip from './MetricAgreementChip'
import BoardTableHeader, { BOARD_CELL_CLASS } from './BoardTableHeader'
import RateInterval from './thesis/RateInterval'
import Histogram from '../charts/Histogram'

// "Unusual for this asset" — the movers list the fixed-threshold ones cannot be.
//
// An 8% day is an ordinary Tuesday for a small alt and a major event for
// Bitcoin. Every row here is scored against the SAME asset's own trailing
// distribution, so the ranking answers "is this unusual FOR THIS ASSET" rather
// than "is this bigger than a constant someone picked". The existing top movers
// and top losers lists are untouched: this sits beside them.
//
// It reads ONE precomputed capture view (`unusual_moves`), which the hourly
// `intel-capture` lane builds from our own stored daily candle archive at zero
// provider credits. Every reader sees the same stored answer, which is what puts
// it on the free `capture_views` surface.
//
// House style: a plain table, an eyebrow, hairline rows. No pills, no cards. The
// lead figure is the empirical percentile IN WORDS ("larger than 90 of the last
// 92 days") because that is a sentence a reader can check; the robust z and the
// market-relative residual sit beside it for a reader who wants the scale.
//
// Every absent figure is a REASON, never a bare dash: a MAD of zero, a market
// series with no overlapping day, the market reference's own row, a volume the
// source never reported. The refusals are counted under the table so a reader
// can see what was left out and why.

const num = value => {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** A signed percentage with two places, or null. `formatPct` already carries the
 *  sign and the percent sign, so this only guards the absent case. */
const pctText = value => (num(value) == null ? null : formatPct(value, { digits: 2 }))

/** An unsigned magnitude with two places: a typical daily move has no direction. */
const magnitudeText = value => (num(value) == null ? null : `${Math.abs(num(value)).toFixed(2)}%`)

/** One place is all a percentile over fewer than a thousand days can carry. */
const percentileText = value => (num(value) == null ? null : `${num(value).toFixed(1)}`)

const zText = value => (num(value) == null ? null : num(value).toFixed(1))

/** The reason a single figure is absent, as a sentence. An unknown code is shown
 *  verbatim rather than swallowed by a generic line. */
export function figureReasonText(t, code) {
  const key = String(code ?? '').trim()
  if (!key) return null
  const known = {
    mad_zero: ['unusual.reason_mad_zero', 'Every day in this window moved by the same amount, so there is no spread to measure against.'],
    short_window: ['unusual.reason_short_window', 'This window holds too few days to measure against.'],
    no_market_overlap: ['unusual.reason_no_market_overlap', 'No day in this window has a Bitcoin reading to compare with.'],
    market_reference: ['unusual.reason_market_reference', 'This is the reference the others are measured against, so it has no reading against itself.'],
    market_flat: ['unusual.reason_market_flat', 'Bitcoin did not move across this window, so no slope can be fitted to it.'],
    volume_not_reported: ['unusual.reason_volume_not_reported', 'The source reported no volume for this day.'],
  }[key]
  return known ? t(known[0], { defaultValue: known[1] }) : key
}

/** Why an asset carries no score, as a sentence. */
export function refusalText(t, code, count) {
  const known = {
    insufficient_history: ['unusual.excluded_insufficient_history', '{{count}} with fewer than 30 stored days'],
    peg_excluded: ['unusual.excluded_peg', '{{count}} pegged (a peg’s trailing moves are peg noise)'],
    wrapper_excluded: ['unusual.excluded_wrapper', '{{count}} wrapped or staking receipts (their distribution is the underlying’s)'],
    below_liquidity_floor: ['unusual.excluded_liquidity', '{{count}} under the turnover floor'],
    liquidity_unknown: ['unusual.excluded_liquidity_unknown', '{{count}} with no reported turnover'],
    no_subject_return: ['unusual.excluded_no_day', '{{count}} with no complete stored day'],
  }[String(code ?? '')]
  return known ? t(known[0], { count, defaultValue: known[1] }) : `${count} ${code}`
}

/** The window a row leads with, falling back to whatever it carries. */
export function leadWindow(row, days) {
  const windows = Array.isArray(row?.windows) ? row.windows : []
  return windows.find(w => Number(w?.days) === Number(days)) || windows[windows.length - 1] || null
}

/** How many days the row's `exceeded` and `percentile` were measured over.
 *
 * Both are the LEAD WINDOW's readings, so their denominator is that window's own
 * day count. `sampleDays` is a different number: the whole stored history behind
 * the asset, which is usually longer than the 90-day lead window, and using it
 * as the denominator made the sentence and the percentile contradict each other
 * on every asset with more than 90 stored days. The read view now states the
 * count directly; the window's own `n` is the fallback for a row captured before
 * it did, and a row carrying neither is not measured. */
export function leadSample(row, window) {
  const stated = num(row?.leadWindowN)
  if (stated != null && stated > 0) return stated
  const fallback = num(window?.n)
  return fallback != null && fallback > 0 ? fallback : null
}

export default function UnusualForThisAsset({ limit = 25 }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase } = useSupabase()
  const orgId = org?.id || null
  const [read, setRead] = useState({ status: 'loading', payload: null, reason: null })
  const [open, setOpen] = useState(null)

  useEffect(() => {
    const controller = new AbortController()
    let alive = true
    setRead({ status: 'loading', payload: null, reason: null })
    readCaptureView('unusual_moves', { limit }, { orgId: orgId || undefined, signal: controller.signal, supabase })
      .then(payload => { if (alive) setRead({ status: 'ready', payload, reason: payload?.reason || null }) })
      .catch(error => { if (alive) setRead({ status: 'unavailable', payload: null, reason: captureUnavailable(error).reason }) })
    return () => { alive = false; controller.abort() }
  }, [orgId, supabase, limit])

  const p = read.payload || {}
  const rows = Array.isArray(p.rows) ? p.rows : []
  const leadDays = num(p.leadWindowDays) ?? 90
  const excluded = p.excluded && typeof p.excluded === 'object' ? p.excluded : {}
  const shortHistory = Array.isArray(p.shortHistory) ? p.shortHistory : []
  const excludedLines = useMemo(
    () => Object.entries(excluded).filter(([, count]) => num(count) > 0).sort((a, b) => b[1] - a[1]),
    [p.excluded], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const columns = [
    t('unusual.col_asset', { defaultValue: 'Asset' }),
    t('unusual.col_move', { defaultValue: 'Move' }),
    t('unusual.col_typical', { defaultValue: 'Typical day' }),
    t('unusual.col_unusual', { defaultValue: 'How unusual' }),
    t('unusual.col_z', { defaultValue: 'Robust z' }),
    t('unusual.col_volume', { defaultValue: 'Volume rank' }),
    t('unusual.col_residual', { defaultValue: 'Own move vs market' }),
    t('unusual.col_turnover', { defaultValue: '24h turnover' }),
    t('unusual.col_detail', { defaultValue: 'Detail' }),
  ]

  let body
  if (read.status === 'loading') {
    body = <p role="status" className="intel-analysis-caption">{t('unusual.loading', { defaultValue: 'Reading the stored candle archive…' })}</p>
  } else if (read.status === 'unavailable' || read.reason) {
    body = <p role="alert" className="intel-analysis-caption">{t('unusual.unavailable', { defaultValue: 'This ranking could not be read.' })} {captureReasonText(t, read.reason)}</p>
  } else if (!p.subjectDay) {
    body = <p role="status" className="intel-analysis-caption">{t('unusual.empty_no_day', { defaultValue: 'No complete day has been scored yet, so there is nothing to rank. The hourly capture writes the first day once the archive holds one.' })}</p>
  } else if (!rows.length) {
    body = <p role="status" className="intel-analysis-caption">{t('unusual.empty_all_excluded', {
      tracked: num(p.trackedAssets) ?? 0,
      defaultValue: 'None of the {{tracked}} assets with stored history could be scored for this day. The reasons are listed below.',
    })}</p>
  } else {
    body = (
      <div className="intel-table-scroll">
        <table>
          <thead><BoardTableHeader columns={columns} numeric={[1, 2, 4, 6, 7]} /></thead>
          <tbody>
            {rows.map(row => {
              const key = row.assetKey || row.cmcId || row.symbol
              const expanded = open === key
              const lead = leadWindow(row, leadDays)
              const href = marketPanelHref({ symbol: row.symbol, sourceProvider: 'coinmarketcap', providerId: row.cmcId })
              const identity = (
                <span className="intel-market-asset-label flex items-center gap-3">
                  <TokenAvatar src={row.imageUrl} fallbackSrc={row.fallbackImageUrl} symbol={row.symbol} name={row.name} size="sm" />
                  <span>
                    <strong className="font-medium">{row.name || row.symbol}</strong>
                    <span className="block text-xs text-[var(--fg-4)]">{row.symbol}</span>
                  </span>
                </span>
              )
              return (
                <React.Fragment key={key}>
                  <tr>
                    <th scope="row" className={`text-left font-normal ${BOARD_CELL_CLASS}`}>
                      {href ? <Link to={href}>{identity}</Link> : identity}
                    </th>
                    <td className={`intel-number ${BOARD_CELL_CLASS}`}>{pctText(row.movePct) ?? t('unusual.not_measured', { defaultValue: 'Not measured' })}</td>
                    <td className={`intel-number ${BOARD_CELL_CLASS}`}>{magnitudeText(row.medianAbsPct) ?? t('unusual.not_measured', { defaultValue: 'Not measured' })}</td>
                    {/* ONE window behind both figures. `exceeded` and
                        `percentile` are the lead window's readings, so the
                        denominator is that window's own day count and never
                        `sampleDays`, which is the whole stored history and is
                        usually longer. Printing the two together was how "larger
                        than 90 of the last 92 days" came to sit beside "100.0th
                        percentile", two true numbers over different windows. */}
                    <td className={BOARD_CELL_CLASS}>
                      {row.exceeded != null && leadSample(row, lead)
                        ? <>
                            <span>{t('unusual.exceeded', { exceeded: row.exceeded, sample: leadSample(row, lead), defaultValue: 'Larger than {{exceeded}} of the last {{sample}} days' })}</span>
                            <span className="block text-[11px] text-[var(--fg-4)]">{t('unusual.percentile_suffix', { value: percentileText(row.percentile), defaultValue: '{{value}}th percentile' })}</span>
                          </>
                        : t('unusual.not_measured', { defaultValue: 'Not measured' })}
                    </td>
                    <td className={`intel-number ${BOARD_CELL_CLASS}`} title={figureReasonText(t, lead?.robustZReason) || undefined}>
                      {zText(row.robustZ) ?? figureReasonText(t, lead?.robustZReason) ?? t('unusual.not_measured', { defaultValue: 'Not measured' })}
                    </td>
                    <td className={BOARD_CELL_CLASS}>
                      {lead?.volumeExceeded != null && lead?.volumeN
                        ? t('unusual.exceeded', { exceeded: lead.volumeExceeded, sample: lead.volumeN, defaultValue: 'Larger than {{exceeded}} of the last {{sample}} days' })
                        : figureReasonText(t, lead?.volumeRobustZReason) ?? t('unusual.not_measured', { defaultValue: 'Not measured' })}
                    </td>
                    <td className={`intel-number ${BOARD_CELL_CLASS}`}>
                      {row.residualPct != null && num(row.beta) != null
                        ? <>
                            <span>{pctText(row.residualPct)}</span>
                            <span className="block text-[11px] text-[var(--fg-4)]">{t('unusual.beta_sample', {
                              beta: num(row.beta).toFixed(2), n: row.betaN, days: lead?.days ?? leadDays,
                              defaultValue: 'beta {{beta}} over {{n}} of the last {{days}} days',
                            })}</span>
                          </>
                        : figureReasonText(t, lead?.betaReason) ?? t('unusual.not_measured', { defaultValue: 'Not measured' })}
                    </td>
                    <td className={`intel-number ${BOARD_CELL_CLASS}`}>{formatUsd(row.liquidityUsd)}</td>
                    <td className={BOARD_CELL_CLASS}>
                      <button
                        type="button"
                        className="intel-text-link"
                        aria-expanded={expanded}
                        aria-controls={`unusual-detail-${key}`}
                        onClick={() => setOpen(expanded ? null : key)}
                      >
                        {expanded ? t('unusual.hide_detail', { defaultValue: 'Hide' }) : t('unusual.show_detail', { defaultValue: 'Distribution' })}
                      </button>
                    </td>
                  </tr>
                  {expanded && (
                    <tr id={`unusual-detail-${key}`}>
                      <td colSpan={columns.length} className={BOARD_CELL_CLASS}>
                        <UnusualDetail row={row} leadDays={leadDays} marketReference={p.marketReference} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    )
  }

  return (
    <section className="space-y-2" aria-label={t('unusual.title', { defaultValue: 'Unusual for this asset' })}>
      <div className="eyebrow">{t('unusual.title', { defaultValue: 'Unusual for this asset' })}</div>
      <p className="text-[12px] text-[var(--fg-2)]">{t('unusual.subtitle', {
        defaultValue: 'Each asset’s last complete day measured against its OWN trailing distribution, not against one threshold for everything. An 8% day is an ordinary Tuesday for a small alt and a major event for Bitcoin.',
      })}</p>
      {body}
      {read.status === 'ready' && !read.reason && p.subjectDay && (
        <>
          {excludedLines.length > 0 && (
            <p className="intel-analysis-caption">
              {t('unusual.excluded_lead', { defaultValue: 'Left out of the ranking:' })}{' '}
              {excludedLines.map(([code, count]) => refusalText(t, code, count)).join('; ')}.
            </p>
          )}
          {shortHistory.length > 0 && (
            <p className="intel-analysis-caption">
              {shortHistory.map(asset => t('unusual.short_history_item', {
                symbol: asset.symbol, sample: asset.sampleDays, required: asset.requiredDays,
                defaultValue: '{{symbol}}: insufficient history, {{sample}} of {{required}} days',
              })).join(' · ')}
            </p>
          )}
          <p className="intel-analysis-caption">{t('unusual.method', {
            day: p.subjectDay, scored: num(p.scoredAssets) ?? 0, tracked: num(p.trackedAssets) ?? 0,
            minSample: num(p.minSampleDays) ?? 30, floor: formatUsd(p.liquidityFloorUsd),
            defaultValue: 'Our calculation over our own stored daily candles: the UTC day that closed on {{day}}, scored for {{scored}} of {{tracked}} assets with stored history. Median and median absolute deviation over the trailing 30 and 90 days, an empirical percentile of the absolute move, the same treatment of log volume, and a residual after removing beta times the Bitcoin move fitted on the same window. At least {{minSample}} trailing days and {{floor}} of reported 24h turnover are required; no provider was called to build it.',
          })}</p>
          <p className="intel-analysis-caption">{t('unusual.not_meaning', {
            defaultValue: 'It is not a forecast and not a reason: an unusual day says this asset rarely moves like this, not why it did or what happens next.',
          })}</p>
          {p.asOf && <p className="intel-analysis-caption">{t('unusual.clock', { at: p.asOf, defaultValue: 'Scored at {{at}}.' })}</p>}
        </>
      )}
    </section>
  )
}

/** The expanded row: the asset's own distribution with today's bar marked, plus
 *  the second window's figures. The bins come from the capture, never from the
 *  chart: re-deriving edges here would quietly disagree with the percentile
 *  printed in the row above. */
export function UnusualDetail({ row, leadDays, marketReference }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const windows = Array.isArray(row?.windows) ? row.windows : []
  const lead = leadWindow(row, leadDays)
  const other = windows.find(w => Number(w?.days) !== Number(leadDays)) || null
  const bins = (Array.isArray(lead?.distribution) ? lead.distribution : []).map((bin, index) => ({
    ...bin,
    // The bar today's move falls in is toned so the reader can find it without a
    // legend entry that repeats the number already in the row. Every bin here is
    // an ABSOLUTE move, so none of them is negative and the chart's own
    // red-for-loss rule never fires; the tone is free to mean "today".
    tone: index === lead?.subjectBin ? 'yellow' : undefined,
  }))

  return (
    <div className="space-y-2">
      {bins.length > 0 ? (
        <Histogram
          title={t('unusual.chart_title', { symbol: row.symbol, days: lead?.days ?? leadDays, defaultValue: '{{symbol}}: absolute daily moves over the last {{days}} days' })}
          description={t('unusual.chart_description', {
            move: pctText(row.movePct), day: row.subjectDay,
            defaultValue: 'Each bar counts the days whose absolute move fell in that range. The highlighted bar holds {{day}}’s move of {{move}}.',
          })}
          bins={bins}
          formatValue={value => `${Number(value).toFixed(1)}%`}
        />
      ) : (
        <p role="status" className="intel-analysis-caption">{t('unusual.chart_empty', { defaultValue: 'This window holds no trailing days to draw, so there is no distribution to show.' })}</p>
      )}
      {lead?.exceeded != null && lead?.n > 0 && (
        <p className="intel-analysis-caption">
          {t('unusual.rate_lead', { days: lead.days, defaultValue: 'Share of the last {{days}} days this move was at least as large as:' })}{' '}
          <RateInterval successes={lead.exceeded} n={lead.n} className="" />
        </p>
      )}
      {other && (
        <p className="intel-analysis-caption">{t('unusual.other_window', {
          days: other.days, n: other.n,
          typical: magnitudeText(other.medianAbsPct) ?? t('unusual.not_measured', { defaultValue: 'Not measured' }),
          exceeded: other.exceeded ?? 0,
          z: zText(other.robustZ) ?? figureReasonText(t, other.robustZReason) ?? t('unusual.not_measured', { defaultValue: 'Not measured' }),
          defaultValue: 'Over the last {{days}} days ({{n}} stored): typical day {{typical}}, larger than {{exceeded}} of them, robust z {{z}}.',
        })}</p>
      )}
      {row.isMarketReference
        ? <p className="intel-analysis-caption">{t('unusual.is_reference', { defaultValue: 'This is the market reference the other rows are measured against, so it carries no beta and no residual against itself.' })}</p>
        : row.marketMovePct != null && marketReference?.symbol && (
          <p className="intel-analysis-caption">{t('unusual.market_that_day', {
            symbol: marketReference.symbol, move: pctText(row.marketMovePct), day: row.subjectDay,
            defaultValue: '{{symbol}} moved {{move}} on {{day}}; the residual above is what is left after removing beta times that move.',
          })}</p>
        )}
      <MetricAgreementChip agreement={row.metricAgreement} />
      {row.catalogueAsOf && (
        <p className="intel-analysis-caption">{t('unusual.turnover_clock', { at: row.catalogueAsOf, defaultValue: 'Turnover from the catalogue capture of {{at}}.' })}</p>
      )}
    </div>
  )
}
