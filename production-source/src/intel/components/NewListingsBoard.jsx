import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import SortableHeader, { StaticHeader } from './SortableHeader'
import { BOARD_CELL_CLASS } from './BoardTableHeader'
import { Link } from 'react-router'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { Histogram, RadialGauge } from '../charts'
import { readCaptureView, captureUnavailable, captureReasonText } from '../lib/capture-api'
import { useUrlState } from '../lib/useUrlState'
import { useColumnSort, sortRows } from '../lib/useColumnSort'
import { getChain, chainIdFor } from '../lib/chains'
import { fmtNum, formatPct, formatPrice, formatUsd, pctClass } from '../lib/market-format'

// New-listing due diligence (CMC plan proposal 21). One row per asset the daily
// 06:10 UTC listing capture recorded inside the chosen window, built from that
// asset's NEWEST snapshot.
//
// WHAT THE BOARD LEADS WITH, AND WHY. The capture stores a price, a market cap,
// a 24h volume and a 24h move for EVERY row it records, and a chain, a holder
// count and a security document for only the minority of listings that carry a
// contract on a chain the provider publishes flags for. A board that led with
// the security columns was therefore mostly blank, and a mostly blank table
// reads as a broken one rather than as an honest one. So the table now leads
// with the columns the capture always fills, and the inspection result — which
// is the rarer and more valuable reading — is one word per row with the flag
// document behind a disclosure.
//
// Contract: `new_listings` takes { days: 7|30|90, status: 'flagged'|'inspected'|
// 'all' } and answers { rows, cohort, sinceListing, changed, asOf, coverage,
// reason }. Each row carries `security` (the whitelisted flag document, or
// null), `securityState` (the bounded machine reason the capture recorded),
// `flagCount` (reported hits only, NULL when nothing was inspected), `changed`
// (the two newest snapshots of this asset recorded different flag hashes),
// `sinceCapturePct` (first captured price to newest, NULL under two captures),
// `daysOnProvider` and `hasMarketPage`.
//
// THE ONE RULE THIS FIGURE EXISTS TO KEEP. `flagCount: null` is "nobody looked",
// not "nothing found". A listing with no contract on a verified chain, or one
// the day's due-diligence budget never reached, states the capture's own reason
// in the inspection column — never a clean zero, and never a gauge at zero. The
// daily budget is 25 inspected rows against a 100-row page, so most of any day's
// cohort is genuinely uninspected and saying so is the whole point of the column.
//
// A flag is an observation the provider published about the contract at that
// capture. It is not a verdict, and the caption says so once, on the table.

const DAYS = [7, 30, 90]
const DEFAULT_DAYS = 7
const STATUSES = ['all', 'inspected', 'flagged']
const DEFAULT_STATUS = 'all'
const DEFAULT_SORT = 'dateAdded'
const DEFAULT_DIR = 'desc'
// Columns whose natural first reading is smallest-first. Everything else — a
// price, a volume, a date, a flag count — opens largest or newest first.
const ASCENDING_FIRST = new Set(['symbol', 'name', 'chain'])
// Hoisted so useUrlState's memo/callback identities stay stable across renders.
const URL_DEFAULTS = {
  l_days: String(DEFAULT_DAYS), l_status: DEFAULT_STATUS,
  l_sort: DEFAULT_SORT, l_dir: DEFAULT_DIR, l_derivs: 'show',
}

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

const clockTime = value => {
  const at = Date.parse(value)
  return Number.isFinite(at) ? new Date(at).toLocaleString() : null
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

/** A wrapper around something that is not a crypto asset: a tokenised equity or
 *  ETF, or a leveraged long/short token.
 *
 *  THE RULE IS THE NAME, AND ONLY THE NAME. The capture stores no instrument
 *  type, so this reads the provider's own name for two patterns and nothing
 *  else: the word "tokenised"/"tokenized" ("Reddit Tokenized bStocks", "Wendy's
 *  Tokenized Stock (Ondo)", "iShares … Tokenized ETF"), and a leverage factor
 *  followed by a direction ("OPENAI 1x Long"). It is a NAME heuristic, so the
 *  control that uses it is off by default and says what it hides: a token that
 *  merely calls itself tokenised would be hidden by it, and a tokenised equity
 *  that does not say so in its name would not. */
export function isDerivativeListing(row) {
  const name = String(row?.name ?? '')
  if (!name) return false
  return /tokeni[sz]ed/i.test(name) || /\b\d+(?:\.\d+)?x\s+(?:long|short)\b/i.test(name)
}

/** What the gauge in a row's disclosure can honestly draw.
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

// The same bounded reasons as a SHORT phrase, and the empty-state kind each one
// is. Every one of them is an absence the capture records on purpose, so none
// of them is an error: a board of thirty listings must not repeat a paragraph
// thirty times. The full sentence above stays on the cell's title attribute, so
// provenance is a hover away. A reason the capture did not bound — a provider
// string, or nothing at all — is NOT in this map.
const STATE_NOTE = {
  no_contract_on_verified_chain: ['not_applicable', 'listings.note_no_contract', 'No contract to inspect'],
  due_diligence_budget: ['no_data', 'listings.note_budget', 'Not inspected yet'],
  no_security_record: ['no_data', 'listings.note_no_record', 'No security record'],
  captured: ['no_data', 'listings.note_captured', 'No flag document'],
}

/** { kind, note } for a bounded capture reason, or null when the reason is not
 *  one the capture lane records on purpose. */
export function listingStateNote(t, state) {
  const known = STATE_NOTE[String(state ?? '').trim()]
  if (!known) return null
  return { kind: known[0], note: t(known[1], { defaultValue: known[2] }) }
}

/** The one word the inspection column carries for a row, and whether the flag
 *  document behind it can be opened. An inspected listing reports its hits; an
 *  uninspected one reports the capture's own reason and opens nothing, because
 *  there is nothing behind it to open. */
export function inspectionOf(t, row) {
  const flags = num(row?.flagCount)
  if (flags != null) {
    return {
      openable: true,
      label: flags > 0
        ? t('listings.insp_flagged', { flags: fmtNum(flags), defaultValue: '{{flags}} flagged' })
        : t('listings.insp_clean', { defaultValue: 'No flags' }),
      title: t('listings.insp_title', { defaultValue: 'Items the provider marked as hit, out of the items it reported for this contract at the daily capture. Not a verdict.' }),
    }
  }
  const state = String(row?.securityState || '').trim()
  const calm = listingStateNote(t, state)
  return {
    openable: false,
    label: calm ? calm.note : listingStateText(t, state),
    title: listingStateText(t, state),
  }
}

/** The route the symbol cell opens: the CoinMarketCap identity, by id, with the
 *  symbol as the path label only. A row with no provider id is not linked —
 *  a guessed ticker is not an identity. */
export function listingHref(row) {
  const providerId = row?.providerId == null ? '' : String(row.providerId)
  if (!providerId) return null
  return `/intel/markets/${encodeURIComponent(row?.symbol || providerId)}?provider=coinmarketcap&id=${encodeURIComponent(providerId)}`
}

/** The read's own bins, as Histogram's caller-computed bins. The edges are the
 *  read's; this never re-derives them, and an empty bin keeps its slot. */
export function listingSinceBins(histogram) {
  return (Array.isArray(histogram) ? histogram : [])
    .filter(bin => bin && num(bin.from) != null)
    .map(bin => ({ key: `${bin.from}:${bin.to ?? ''}`, from: num(bin.from), to: num(bin.to), count: num(bin.count) ?? 0 }))
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
      kind="error"
      reason={risk.state === 'ready' ? undefined : listingStateText(t, risk.reason)}
    />
  )
}

/** The flag document, opened on demand. Reported hits first, then the items the
 *  provider reported and did not mark: both are readings, and hiding the
 *  unmarked ones would turn "27 items checked, none hit" into "nothing known". */
function FlagItems({ row, t }) {
  const items = Array.isArray(row?.security?.items) ? row.security.items : []
  if (!items.length) return null
  const ordered = [...items].sort((a, b) => (b?.hit === true ? 1 : 0) - (a?.hit === true ? 1 : 0))
  return (
    <ul className="space-y-1 text-[12px]" data-testid="listing-flag-items">
      {ordered.map((item, index) => (
        <li key={`${item?.code ?? 'item'}-${index}`} className="flex gap-2">
          <span className={item?.hit === true ? 'text-[var(--fg-1)]' : 'text-[var(--fg-4)]'}>
            {item?.hit === true
              ? t('listings.item_hit', { defaultValue: 'Hit' })
              : t('listings.item_clear', { defaultValue: 'Not marked' })}
          </span>
          <span className="text-[var(--fg-2)]">{String(item?.code ?? '—')}</span>
          {item?.description ? <span className="text-[var(--fg-4)]">{String(item.description)}</span> : null}
        </li>
      ))}
    </ul>
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
  const hideDerivatives = urlState.l_derivs === 'hide'
  const [read, setRead] = useState({ status: 'loading', payload: null, reason: null })
  const [open, setOpen] = useState(null)

  useEffect(() => {
    const controller = new AbortController()
    let alive = true
    setRead({ status: 'loading', payload: null, reason: null })
    setOpen(null)
    readCaptureView('new_listings', { days, status }, { orgId, signal: controller.signal, supabase })
      .then(payload => { if (alive) setRead({ status: 'ready', payload, reason: null }) })
      .catch(error => { if (alive) setRead({ status: 'unavailable', payload: null, reason: captureUnavailable(error).reason }) })
    return () => { alive = false; controller.abort() }
  }, [orgId, days, status, supabase])

  const payload = read.payload
  const allRows = useMemo(() => (Array.isArray(payload?.rows) ? payload.rows : []), [payload])
  const cohort = payload?.cohort && typeof payload.cohort === 'object' ? payload.cohort : null
  const since = payload?.sinceListing && typeof payload.sinceListing === 'object' ? payload.sinceListing : null

  const { sort, dir, toggle } = useColumnSort({
    sort: urlState.l_sort, dir: urlState.l_dir,
    setSort: next => setUrlState({ l_sort: next.sort, l_dir: next.dir }),
    defaultSort: DEFAULT_SORT, defaultDir: DEFAULT_DIR,
    initialDir: key => (ASCENDING_FIRST.has(key) ? 'asc' : 'desc'),
  })

  const rows = useMemo(() => {
    const kept = hideDerivatives ? allRows.filter(row => !isDerivativeListing(row)) : allRows
    // The ticker is the tie-break so two listings added on the same day keep one
    // order whichever column is pointing.
    return sortRows(kept, { key: sort, dir, tieBreak: row => String(row?.symbol ?? '') })
  }, [allRows, hideDerivatives, sort, dir])

  const hidden = allRows.length - rows.length

  // An empty capture table answers with an empty list and NO reason — that is an
  // empty reading. A reason on a successful read is a failed query behind it and
  // is reported like a thrown one rather than being shown as "empty".
  const stated = read.status === 'unavailable' ? read.reason : (read.status === 'ready' ? (payload?.reason || null) : null)
  const reason = stated ? captureReasonText(t, stated) : null
  const state = stated ? 'error' : (read.status === 'ready' && allRows.length) ? 'ready' : 'empty'

  // A valid zero stays a zero; a null reads as a dash. The cohort is measured
  // against every asset in the window, so the row filters narrow the table below
  // without ever narrowing these numbers.
  const summary = t('listings.cohort_line', {
    count: fmtNum(num(cohort?.count) ?? 0),
    withContract: fmtNum(num(cohort?.withContract) ?? 0),
    inspected: fmtNum(num(cohort?.inspected) ?? 0),
    flagged: fmtNum(num(cohort?.flagged) ?? 0),
    volume: num(cohort?.medianVolume24h) == null ? '—' : formatUsd(cohort.medianVolume24h),
    median: num(cohort?.medianHolderCount) == null ? '—' : fmtNum(cohort.medianHolderCount),
    defaultValue: '{{count}} listings captured in this window, {{withContract}} with a contract on a verified chain, {{inspected}} inspected, {{flagged}} with at least one reported flag. Median 24h volume {{volume}}, median holder count {{median}}.',
  })

  const sinceSample = num(since?.sample)
  const sinceLine = sinceSample == null ? '' : t('listings.since_line', {
    fell: fmtNum(num(since?.fell) ?? 0),
    sample: fmtNum(sinceSample),
    excluded: fmtNum(num(since?.excluded) ?? 0),
    defaultValue: '{{fell}} of the {{sample}} listings with two captured prices sit below their first captured price; {{excluded}} have only one capture and are not counted.',
  })

  const changed = num(payload?.changed)
  const changedLine = changed == null
    ? ''
    : t('listings.changed_line', { changed: fmtNum(changed), defaultValue: '{{changed}} assets recorded a different flag set than at their previous capture.' })

  const asOf = clockTime(payload?.asOf)
  const clockLine = t('listings.clock_line', {
    at: asOf || '—',
    defaultValue: 'Listing dates are the provider’s own date_added, read in UTC; every price, volume and flag on this page is the daily 06:10 UTC capture, newest captured_at {{at}}.',
  })

  const caption = t('listings.caption', {
    defaultValue: 'Flags are the provider’s reported security observations for the contract at the daily capture, not a verdict. A listing with no reported flag count was never inspected (the daily run inspects at most twenty-five contracts), and its row carries the capture’s own reason rather than a clean zero.',
  })

  const sinceBins = listingSinceBins(since?.histogram)

  // Column model. `key` is both the sort key and the row field, so a header and
  // the cells under it can never drift apart.
  const columns = [
    { key: 'symbol', label: t('listings.col_symbol', { defaultValue: 'Symbol' }), align: 'left' },
    { key: 'name', label: t('listings.col_name', { defaultValue: 'Name' }), align: 'left' },
    { key: 'dateAdded', label: t('listings.col_listed', { defaultValue: 'Listed' }), align: 'left' },
    { key: 'price', label: t('listings.col_price', { defaultValue: 'Price' }), align: 'right' },
    { key: 'change24hPct', label: t('listings.col_change', { defaultValue: '24h' }), align: 'right' },
    { key: 'volume24h', label: t('listings.col_volume', { defaultValue: '24h volume' }), align: 'right' },
    { key: 'marketCap', label: t('listings.col_market_cap', { defaultValue: 'Market cap' }), align: 'right' },
    { key: 'sinceCapturePct', label: t('listings.col_since', { defaultValue: 'Since first capture' }), align: 'right' },
    { key: 'chain', label: t('listings.col_chain', { defaultValue: 'Chain' }), align: 'left' },
    { key: 'flagCount', label: t('listings.col_inspection', { defaultValue: 'Inspection' }), align: 'left' },
    { key: 'holderCount', label: t('listings.col_holders', { defaultValue: 'Holders' }), align: 'right' },
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

  const statusLabel = value => (value === 'all'
    ? t('listings.status_all', { defaultValue: 'All' })
    : value === 'inspected'
      ? t('listings.status_inspected', { defaultValue: 'Inspected only' })
      : t('listings.status_flagged', { defaultValue: 'Flagged only' }))

  return (
    <section className="intel-new-listings-board space-y-3" aria-label={t('listings.board_title', { defaultValue: 'New listings' })}>
      <div className="space-y-1">
        <h2 className="intel-section-title">{t('listings.board_title', { defaultValue: 'New listings' })}</h2>
        <p className="intel-analysis-caption" data-testid="listings-cohort-summary">
          {[summary, sinceLine, changedLine].filter(Boolean).join(' ')}
        </p>
        <p className="intel-analysis-caption" data-testid="listings-clock">{clockLine}</p>
      </div>

      <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
        {control(
          t('listings.window', { defaultValue: 'Window' }),
          DAYS,
          days,
          value => setUrlState({ l_days: String(value) }),
          value => t('listings.window_option', { days: value, defaultValue: '{{days}}d' }),
        )}
        {control(
          t('listings.status', { defaultValue: 'Listings read' }),
          STATUSES,
          status,
          value => setUrlState({ l_status: value }),
          statusLabel,
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]" role="group" aria-label={t('listings.wrappers', { defaultValue: 'Wrapped instruments' })}>
          <span className="text-[var(--fg-4)]">{t('listings.wrappers', { defaultValue: 'Wrapped instruments' })}</span>
          <button
            type="button"
            aria-pressed={hideDerivatives}
            title={t('listings.wrappers_rule', { defaultValue: 'Hidden by name only: a listing whose name says tokenised, or names a leverage factor with a long or short direction. The capture stores no instrument type, so this reads the provider’s name and nothing else.' })}
            onClick={() => setUrlState({ l_derivs: hideDerivatives ? 'show' : 'hide' })}
            className={hideDerivatives
              ? 'text-[var(--fg-1)] underline underline-offset-4'
              : 'text-[var(--fg-4)] hover:text-[var(--fg-2)]'}
          >
            {t('listings.wrappers_hide', { defaultValue: 'Hide tokenised stocks and leveraged tokens' })}
          </button>
          {hidden > 0
            ? <span className="text-[var(--fg-4)]">{t('listings.wrappers_hidden', { hidden: fmtNum(hidden), defaultValue: '{{hidden}} hidden' })}</span>
            : null}
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
        <>
          <Histogram
            title={t('listings.since_title', { defaultValue: 'Change since first captured price' })}
            description={t('listings.since_sub', {
              sample: fmtNum(sinceSample ?? 0),
              excluded: fmtNum(num(since?.excluded) ?? 0),
              defaultValue: 'Every listing in this window measured from its own first captured price to its newest, both on the daily 06:10 UTC capture clock. This is a move since WE first priced it, not since the provider listed it. {{sample}} listings counted; {{excluded}} carry a single capture and are excluded rather than drawn at zero.',
            })}
            bins={sinceBins}
            formatValue={value => formatPct(value, { digits: 0 })}
            formatCount={value => fmtNum(value)}
            state={sinceSample ? 'ready' : 'empty'}
          />

          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <caption className="text-left text-[11px] text-[var(--fg-4)] pb-2" data-testid="listings-caption">{caption}</caption>
              <thead>
                <tr>
                  {/* The two alignments are written out rather than passed
                      through a variable, so the header row's alignment stays
                      readable to check-intel-table-alignment.mjs, which is a
                      text scan and cannot follow `align={column.align}`. */}
                  {columns.map(column => (column.align === 'right'
                    ? <SortableHeader key={column.key} sortKey={column.key} label={column.label} sort={sort} dir={dir} onToggle={toggle} align="right" />
                    : <SortableHeader key={column.key} sortKey={column.key} label={column.label} sort={sort} dir={dir} onToggle={toggle} align="left" />
                  ))}
                  <StaticHeader label={t('listings.col_changed', { defaultValue: 'Changed' })} />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => {
                  const href = row?.hasMarketPage ? listingHref(row) : null
                  const label = row?.symbol || String(row?.providerId ?? '—')
                  const key = row?.providerId ?? `${label}-${index}`
                  const inspection = inspectionOf(t, row)
                  const expanded = open === key
                  const marketCap = num(row?.marketCap)
                  const sincePct = num(row?.sinceCapturePct)
                  const onProvider = num(row?.daysOnProvider)
                  const change = num(row?.change24hPct)
                  return (
                    <React.Fragment key={key}>
                      <tr>
                        <th scope="row" className={`text-left font-normal text-[var(--fg-2)] ${BOARD_CELL_CLASS}`}>
                          {href ? <Link className="intel-text-link" to={href}>{label}</Link> : label}
                        </th>
                        <td className={BOARD_CELL_CLASS}>{row?.name || '—'}</td>
                        <td className={BOARD_CELL_CLASS}>
                          {listingDate(row?.dateAdded)}
                          {onProvider == null ? null : (
                            <span className="text-[var(--fg-4)]">
                              {` ${t('listings.days_on', { days: fmtNum(onProvider), defaultValue: '· {{days}}d on the provider' })}`}
                            </span>
                          )}
                        </td>
                        <td className={`intel-number ${BOARD_CELL_CLASS}`}>{formatPrice(row?.price)}</td>
                        <td className={`intel-number ${BOARD_CELL_CLASS} ${change == null ? '' : pctClass(change)}`}>{formatPct(change)}</td>
                        <td className={`intel-number ${BOARD_CELL_CLASS}`}>{formatUsd(row?.volume24h)}</td>
                        {/* A market cap of zero is the provider saying it has no
                            circulating supply to multiply, not a zero-value
                            asset: "$0" would be a claim the capture never made. */}
                        <td className={`intel-number ${BOARD_CELL_CLASS}`}>
                          {marketCap == null || marketCap <= 0
                            ? <span className="text-[var(--fg-4)]" title={t('listings.mc_none_title', { defaultValue: 'The provider published no market capitalisation for this listing, which it does when the circulating supply is unknown.' })}>
                                {t('listings.mc_none', { defaultValue: 'Not reported' })}
                              </span>
                            : formatUsd(marketCap)}
                        </td>
                        <td className={`intel-number ${BOARD_CELL_CLASS} ${sincePct == null ? '' : pctClass(sincePct)}`}>
                          {sincePct == null
                            ? <span className="text-[var(--fg-4)]" title={t('listings.since_one_title', { defaultValue: 'This listing carries a single captured price so far, so there is no move to report. It gets one at the next daily capture.' })}>
                                {t('listings.since_one', { defaultValue: 'First capture' })}
                              </span>
                            : formatPct(sincePct)}
                        </td>
                        <td className={BOARD_CELL_CLASS}>
                          {row?.chain
                            ? chainLabel(row.chain)
                            : <span className="text-[var(--fg-4)]" title={t('listings.state_no_contract', { defaultValue: 'This listing reported no contract on a chain the provider publishes security flags for, so nothing was inspected.' })}>
                                {t('listings.chain_none', { defaultValue: 'None reported' })}
                              </span>}
                        </td>
                        {/* One word. The flag document opens under the row, so
                            the sentence explaining it is printed once. */}
                        <td className={BOARD_CELL_CLASS}>
                          {inspection.openable ? (
                            <button
                              type="button"
                              className="intel-text-link"
                              aria-expanded={expanded}
                              aria-controls={`listing-flags-${key}`}
                              title={inspection.title}
                              onClick={() => setOpen(expanded ? null : key)}
                            >
                              {inspection.label}
                            </button>
                          ) : (
                            <span className="text-[var(--fg-4)]" title={inspection.title}>{inspection.label}</span>
                          )}
                        </td>
                        <td className={`intel-number ${BOARD_CELL_CLASS}`}>{fmtNum(num(row?.holderCount))}</td>
                        <td className={BOARD_CELL_CLASS}>
                          {row?.changed === true
                            ? t('listings.changed_yes', { defaultValue: 'Changed' })
                            : '—'}
                        </td>
                      </tr>
                      {expanded ? (
                        <tr id={`listing-flags-${key}`} data-testid={`listing-flags-${key}`}>
                          <td className={BOARD_CELL_CLASS} colSpan={columns.length + 1}>
                            <div className="space-y-2 pb-2">
                              <RowRisk row={row} t={t} />
                              <FlagItems row={row} t={t} />
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </React.Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}
