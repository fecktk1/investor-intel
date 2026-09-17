import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import BoardTableHeader from './BoardTableHeader'
import { Link } from 'react-router'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { RadialGauge } from '../charts'
import { readCaptureView, captureUnavailable, captureReasonText } from '../lib/capture-api'
import { useUrlState } from '../lib/useUrlState'
import { getChain, chainIdFor } from '../lib/chains'
import { fmtNum } from '../lib/market-format'

// New-listing due diligence (CMC plan proposal 21). One row per asset the daily
// 06:10 UTC listing capture recorded inside the chosen window, built from that
// asset's NEWEST snapshot, with the provider's own reported security flags
// beside it.
//
// Contract: `new_listings` takes { days: 7|30|90, status: 'flagged'|'all' } and
// answers { rows, cohort, changed, asOf, coverage, reason }. Each row carries
// `security` (the whitelisted flag document, or null), `securityState` (the
// bounded machine reason the capture recorded), `flagCount` (reported hits only,
// NULL when nothing was inspected) and `changed` (the two newest snapshots of
// this asset recorded different flag hashes).
//
// THE ONE RULE THIS FIGURE EXISTS TO KEEP. `flagCount: null` is "nobody looked",
// not "nothing found". A listing with no contract on a verified chain, or one
// the day's due-diligence budget never reached, renders an UNAVAILABLE gauge
// carrying the capture's own reason — never a clean zero. The daily budget is 25
// inspected rows against a 100-row page, so most of any day's cohort is
// genuinely uninspected and saying so is the whole point of the column.
//
// A flag is an observation the provider published about the contract at that
// capture. It is not a verdict, and the caption says so on the figure and in the
// table twin of every row gauge.

const DAYS = [7, 30, 90]
const DEFAULT_DAYS = 7
const STATUSES = ['all', 'flagged']
const DEFAULT_STATUS = 'all'
// Hoisted so useUrlState's memo/callback identities stay stable across renders.
const URL_DEFAULTS = { l_days: String(DEFAULT_DAYS), l_status: DEFAULT_STATUS }

const num = value => {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

const optionOf = (options, raw, fallback) => (options.includes(Number(raw)) ? Number(raw) : fallback)

/** Provider `date_added` is a calendar date. Rendering it in the viewer's zone
 *  moves 2026-09-15 to "Sep 14" for anyone west of Greenwich, which is a
 *  different day, so it is read in UTC like every other capture date. */
export function listingDate(value) {
  const at = Date.parse(value)
  return Number.isFinite(at)
    ? new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
    : '—'
}

/** The capture stores a CAIP chain ('eip155:8453', 'solana'). Named the way
 *  chains.js names it; a chain the registry does not hold is shown verbatim
 *  rather than being folded onto a network we did not read. */
export function chainLabel(caip) {
  const raw = String(caip ?? '').trim()
  if (!raw) return '—'
  const [namespace, reference] = raw.includes(':') ? [raw.slice(0, raw.indexOf(':')), raw.slice(raw.indexOf(':') + 1)] : [raw, 'mainnet']
  return getChain(chainIdFor(namespace, reference) || '')?.label || raw
}

/** What the gauge on a row can honestly draw.
 *
 *  `flagCount` null is NOT a zero: it is a listing nobody inspected, and the
 *  gauge reports the capture's own `securityState` instead of a needle at zero.
 *  The denominator is the number of items the provider actually reported for
 *  this contract, so "2 of 9 reported items were hit" is the whole claim. */
export function listingRisk(row) {
  const flags = num(row?.flagCount)
  const items = Array.isArray(row?.security?.items) ? row.security.items.length : 0
  if (flags == null) {
    return { state: 'unavailable', value: null, items, reason: String(row?.securityState || '').trim() || null }
  }
  return { state: 'ready', value: flags, items, reason: null }
}

// The bounded machine reasons the capture lane records, in a sentence a reader
// can act on. Anything else — a provider string such as `malformed_response` —
// is shown verbatim rather than being swallowed by a generic line.
const STATE_TEXT = {
  no_contract_on_verified_chain: ['listings.state_no_contract', 'This listing reported no contract on a chain the provider publishes security flags for, so nothing was inspected.'],
  due_diligence_budget: ['listings.state_budget', 'The run’s due-diligence budget was spent before this listing; it is inspected on a later capture, not reported as clean.'],
  no_security_record: ['listings.state_no_record', 'The provider holds no security record for this contract.'],
  captured: ['listings.state_captured', 'The contract was inspected but the capture recorded no flag document.'],
}

export function listingStateText(t, state) {
  const code = String(state ?? '').trim()
  const known = STATE_TEXT[code]
  if (known) return t(known[0], { defaultValue: known[1] })
  return code || t('listings.state_unknown', { defaultValue: 'Nothing was inspected and the capture recorded no reason.' })
}

/** The route the symbol cell opens: the CoinMarketCap identity, by id, with the
 *  symbol as the path label only. A row with no provider id is not linked —
 *  a guessed ticker is not an identity. */
export function listingHref(row) {
  const providerId = row?.providerId == null ? '' : String(row.providerId)
  if (!providerId) return null
  return `/intel/markets/${encodeURIComponent(row?.symbol || providerId)}?provider=coinmarketcap&id=${encodeURIComponent(providerId)}`
}

function RowRisk({ row, t }) {
  const risk = listingRisk(row)
  const label = row?.symbol || row?.name || String(row?.providerId ?? '—')
  const title = t('listings.gauge_title', { symbol: label, defaultValue: '{{symbol}} reported flags' })
  const max = Math.max(1, risk.items)
  return (
    <RadialGauge
      title={title}
      description={t('listings.gauge_sub', {
        defaultValue: 'Items the provider marked as hit, out of the items it reported for this contract at the daily capture. Flags are the provider’s reported security observations for the contract at the daily capture, not a verdict.',
      })}
      value={risk.value ?? 0}
      min={0}
      max={max}
      zones={risk.state === 'ready'
        ? [{
            label: t('listings.gauge_band', { hits: risk.value, items: risk.items, defaultValue: '{{hits}} of {{items}} reported items hit' }),
            tone: risk.value > 0 ? 'yellow' : 'green',
            to: max,
          }]
        : []}
      formatValue={value => fmtNum(value)}
      height={72}
      state={risk.state === 'ready' ? 'ready' : 'error'}
      reason={risk.state === 'ready' ? undefined : listingStateText(t, risk.reason)}
    />
  )
}

export default function NewListingsBoard() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  // The capture tables are service-role only: the read travels on the reader's
  // authenticated client, never the anonymous one.
  const { supabase } = useSupabase()
  const orgId = org?.id || null
  const [urlState, setUrlState] = useUrlState(URL_DEFAULTS)
  const days = optionOf(DAYS, urlState.l_days, DEFAULT_DAYS)
  const status = STATUSES.includes(urlState.l_status) ? urlState.l_status : DEFAULT_STATUS
  const [read, setRead] = useState({ status: 'loading', payload: null, reason: null })

  useEffect(() => {
    const controller = new AbortController()
    let alive = true
    setRead({ status: 'loading', payload: null, reason: null })
    readCaptureView('new_listings', { days, status }, { orgId, signal: controller.signal, supabase })
      .then(payload => { if (alive) setRead({ status: 'ready', payload, reason: null }) })
      .catch(error => { if (alive) setRead({ status: 'unavailable', payload: null, reason: captureUnavailable(error).reason }) })
    return () => { alive = false; controller.abort() }
  }, [orgId, days, status, supabase])

  const payload = read.payload
  const rows = useMemo(() => (Array.isArray(payload?.rows) ? payload.rows : []), [payload])
  const cohort = payload?.cohort && typeof payload.cohort === 'object' ? payload.cohort : null

  // An empty capture table answers with an empty list and NO reason — that is an
  // empty reading. A reason on a successful read is a failed query behind it and
  // is reported like a thrown one rather than being shown as "empty".
  const stated = read.status === 'unavailable' ? read.reason : (read.status === 'ready' ? (payload?.reason || null) : null)
  const reason = stated ? captureReasonText(t, stated) : null
  const state = stated ? 'error' : (read.status === 'ready' && rows.length) ? 'ready' : 'empty'

  // A valid zero stays a zero; a null reads as a dash. The cohort is measured
  // against every asset in the window, so the `flagged` filter narrows the rows
  // below without ever narrowing these four numbers.
  const summary = t('listings.cohort_line', {
    count: fmtNum(num(cohort?.count) ?? 0),
    withContract: fmtNum(num(cohort?.withContract) ?? 0),
    flagged: fmtNum(num(cohort?.flagged) ?? 0),
    median: num(cohort?.medianHolderCount) == null ? '—' : fmtNum(cohort.medianHolderCount),
    defaultValue: '{{count}} listings captured in this window, {{withContract}} with a contract on a verified chain, {{flagged}} with at least one reported flag, median holder count {{median}}.',
  })

  const changed = num(payload?.changed)
  const changedLine = changed == null
    ? ''
    : t('listings.changed_line', { changed: fmtNum(changed), defaultValue: '{{changed}} assets recorded a different flag set than at their previous capture.' })

  const caption = t('listings.caption', {
    defaultValue: 'Flags are the provider’s reported security observations for the contract at the daily capture, not a verdict. A listing with no reported flag count was never inspected (the daily run inspects at most twenty-five contracts), and its gauge carries the capture’s own reason rather than a clean zero.',
  })

  const columns = [
    t('listings.col_symbol', { defaultValue: 'Symbol' }),
    t('listings.col_name', { defaultValue: 'Name' }),
    t('listings.col_date_added', { defaultValue: 'Date added' }),
    t('listings.col_chain', { defaultValue: 'Chain' }),
    t('listings.col_holders', { defaultValue: 'Holders' }),
    t('listings.col_flags', { defaultValue: 'Flags' }),
    t('listings.col_level', { defaultValue: 'Security level' }),
    t('listings.col_changed', { defaultValue: 'Changed' }),
    t('listings.col_risk', { defaultValue: 'Reported flags' }),
  ]

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

  return (
    <section className="intel-new-listings-board space-y-3" aria-label={t('listings.board_title', { defaultValue: 'New listings' })}>
      <div className="space-y-1">
        <h2 className="intel-section-title">{t('listings.board_title', { defaultValue: 'New listings' })}</h2>
        <p className="intel-analysis-caption" data-testid="listings-cohort-summary">
          {`${summary}${changedLine ? ` ${changedLine}` : ''}`}
        </p>
        <p className="intel-analysis-caption" data-testid="listings-caption">{caption}</p>
      </div>

      <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
        {control(
          t('listings.window', { defaultValue: 'Window' }),
          DAYS,
          days,
          value => setUrlState({ l_days: String(value) }),
          value => t('listings.window_option', { days: value, defaultValue: '{{days}}d' }),
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]" role="group" aria-label={t('listings.status', { defaultValue: 'Listings read' })}>
          <span className="text-[var(--fg-4)]">{t('listings.status', { defaultValue: 'Listings read' })}</span>
          {STATUSES.map(value => (
            <button
              key={value}
              type="button"
              aria-pressed={value === status}
              onClick={() => setUrlState({ l_status: value })}
              className={value === status
                ? 'text-[var(--fg-1)] underline underline-offset-4'
                : 'text-[var(--fg-4)] hover:text-[var(--fg-2)]'}
            >
              {value === 'all'
                ? t('listings.status_all', { defaultValue: 'All' })
                : t('listings.status_flagged', { defaultValue: 'Flagged only' })}
            </button>
          ))}
        </div>
      </div>

      {state === 'error' ? (
        <p className="intel-chart-kit-state" role="alert">
          {t('charts.unavailable', { defaultValue: 'This chart could not be built.' })}{' '}
          {reason || t('charts.no_reason', { defaultValue: 'No reason was reported.' })}
        </p>
      ) : state === 'empty' ? (
        <p className={`intel-chart-kit-state${read.status === 'loading' ? ' min-h-[60vh]' : ''}`} role="status">
          {t('listings.empty', { defaultValue: 'No listing has been captured for this window yet.' })}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <caption className="text-left text-[11px] text-[var(--fg-4)] pb-2">{caption}</caption>
            <thead>
              <BoardTableHeader columns={columns} numeric={[4, 5, 6]} />
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const href = listingHref(row)
                const label = row?.symbol || String(row?.providerId ?? '—')
                const level = num(row?.security?.level)
                const flags = num(row?.flagCount)
                return (
                  <tr key={row?.providerId ?? `${label}-${index}`}>
                    <th scope="row" className="text-left font-normal text-[var(--fg-2)] border-b border-[var(--border-default)] py-2 pr-3">
                      {href ? <Link className="intel-text-link" to={href}>{label}</Link> : label}
                    </th>
                    <td className="border-b border-[var(--border-default)] py-2 pr-3">{row?.name || '—'}</td>
                    <td className="border-b border-[var(--border-default)] py-2 pr-3">{listingDate(row?.dateAdded)}</td>
                    <td className="border-b border-[var(--border-default)] py-2 pr-3">{chainLabel(row?.chain)}</td>
                    <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{fmtNum(num(row?.holderCount))}</td>
                    {/* Never a zero for a listing nobody inspected. */}
                    <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{flags == null ? '—' : fmtNum(flags)}</td>
                    <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{level == null ? '—' : fmtNum(level)}</td>
                    <td className="border-b border-[var(--border-default)] py-2 pr-3">
                      {row?.changed === true
                        ? t('listings.changed_yes', { defaultValue: 'Changed' })
                        : '—'}
                    </td>
                    <td className="border-b border-[var(--border-default)] py-2 pr-3">
                      <RowRisk row={row} t={t} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
