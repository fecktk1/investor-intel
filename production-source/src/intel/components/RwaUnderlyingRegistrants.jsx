import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import SortableHeader, { StaticHeader } from './SortableHeader'
import { BOARD_CELL_CLASS } from './BoardTableHeader'
import TokenAvatar from './TokenAvatar'
import { useColumnSort, sortRows } from '../lib/useColumnSort'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { readCaptureView, captureUnavailable } from '../lib/capture-api'
import { fmtNum } from '../lib/market-format'

// Underlying registrants: the LISTED COMPANY beneath a tokenised stock or fund.
//
// THE DISTINCTION THIS BOARD MUST NEVER BLUR. The issuer board above it answers
// "who issued this token?", from dated hand assertions only. This board answers a
// different question: CoinMarketCap publishes an SEC filer number (CIK) for
// tokenised equities and ETFs, and that number belongs to the company whose share
// is being wrapped (Nvidia's), not to the firm that wrapped it. So every CIK here
// is labelled as a PROVIDER ASSERTION, and the registrant facts beside it are what
// WE read at EDGAR for that number.
//
// Four rules this file may never soften:
//   1. A MISMATCH IS A FINDING. When the registrant's name and the asset's name do
//      not agree, the row says so and shows both normalised strings. It is never
//      hidden, and a match is never claimed from similarity.
//   2. A LATE FILER IS THE INTERESTING ROW. The default order is our own day count
//      descending, so a registrant that has not filed a periodic report in a long
//      time is the first thing a reader sees.
//   3. OUR FIGURE SAYS IT IS OURS. The day count names its two inputs (EDGAR's
//      latest annual and quarterly filing dates) and the threshold it is judged
//      against, which differs for a foreign private issuer that files no 10-Q.
//   4. A FAILURE STATES ITS REASON, and "not read yet" is not the same as "clean".
//
// House visual language: no pills and no cards. Eyebrows, hairlines and underline
// rails, matching RwaIssuerLegitimacy.jsx and RwaUniverse.jsx.

const num = value => {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** Rows shown before the first "show more". */
export const PAGE_SIZE = 25

export const SORT_KEYS = ['rank', 'asset', 'registrant', 'cik', 'exchange', 'industry', 'annual', 'quarterly', 'days', 'match']
export const DEFAULT_SORT = 'days'

/** Read off the row exactly the way the cell under the header reads it, so a
 *  header and its column can never disagree. */
export function boardValue(row, key) {
  if (key === 'rank') return num(row?.rwaRank)
  if (key === 'asset') return row?.name || row?.symbol || null
  if (key === 'registrant') return row?.registrant?.name || null
  if (key === 'cik') return row?.cik || null
  if (key === 'exchange') return row?.primaryExchange || (row?.edgarExchanges || [])[0] || null
  if (key === 'industry') return row?.industry || null
  if (key === 'annual') return row?.registrant?.annual?.filingDate || null
  if (key === 'quarterly') return row?.registrant?.quarterly?.filingDate || null
  if (key === 'days') return num(row?.periodic?.days)
  if (key === 'match') return row?.registrant?.nameMatch || null
  return null
}

/** Registrants our own day count puts past the stated threshold. Exported so the
 *  test asserts the rule rather than the sentence. */
export function overdueRows(rows = []) {
  return rows.filter(row => row?.periodic?.state === 'overdue')
}

/** The daily capture times (UTC) the read view serves, with the migration's own
 *  times as a fallback for an older payload. */
export function captureTimes(schedule) {
  return {
    mapTime: schedule?.rwa_asset_map?.utc || '03:11',
    profileTime: schedule?.rwa_asset_profiles?.utc || '03:29',
    registrantTime: schedule?.rwa_underlying_registrants?.utc || '03:47',
  }
}

const cell = BOARD_CELL_CLASS

function Scope({ children }) {
  return <p className="text-[11px] leading-relaxed text-[var(--fg-4)] mt-1 max-w-[75ch]">{children}</p>
}

/** A filing as "10-K, 2026-02-21". A form with no date is still the newest form
 *  we saw, so it prints the form and says the date is missing rather than hiding
 *  the filing entirely. */
function Filing({ filing, t }) {
  if (!filing?.form) return <span className="text-[var(--fg-4)]">{t('rwa_underlying.no_filing', { defaultValue: 'None read' })}</span>
  return (
    <>
      {filing.url
        ? <a className="intel-text-link" href={filing.url} target="_blank" rel="noreferrer noopener">{filing.form}</a>
        : <span>{filing.form}</span>}
      {' '}
      <span className="text-[var(--fg-4)]">{filing.filingDate || t('rwa_underlying.no_date', { defaultValue: 'date not published' })}</span>
    </>
  )
}

export default function RwaUnderlyingRegistrants() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  // Service-role capture tables: the read travels on the reader's own
  // authenticated client, never the anonymous one.
  const { supabase } = useSupabase()
  const orgId = org?.id || null
  const [read, setRead] = useState({ status: 'loading', payload: null, reason: null })
  const [shown, setShown] = useState(PAGE_SIZE)
  const [sortState, setSortState] = useState({ sort: DEFAULT_SORT, dir: 'desc' })

  useEffect(() => {
    const controller = new AbortController()
    let alive = true
    setRead({ status: 'loading', payload: null, reason: null })
    readCaptureView('rwa_underlying_registrants', {}, { orgId, signal: controller.signal, supabase })
      .then(payload => { if (alive) setRead({ status: 'ready', payload, reason: null }) })
      .catch(error => { if (alive) setRead({ status: 'unavailable', payload: null, reason: captureUnavailable(error).reason }) })
    return () => { alive = false; controller.abort() }
  }, [orgId, supabase])

  const { sort, dir, toggle } = useColumnSort({
    sort: SORT_KEYS.includes(sortState.sort) ? sortState.sort : null,
    dir: sortState.dir,
    setSort: next => { setSortState(next); setShown(PAGE_SIZE) },
    defaultSort: DEFAULT_SORT,
  })

  const payload = read.payload || {}
  const rows = useMemo(() => (Array.isArray(payload.rows) ? payload.rows : []), [payload])
  const ordered = useMemo(
    () => sortRows(rows, { key: sort, dir, accessor: boardValue, tieBreak: row => String(row?.symbol ?? row?.rwaId ?? '') }),
    [rows, sort, dir],
  )
  const overdue = useMemo(() => overdueRows(rows), [rows])
  const universe = payload.universe || {}
  const times = captureTimes(payload.schedule)
  const thresholds = payload.thresholds || {}

  const tokenised = num(universe.tokenised)
  const withCik = num(universe.withCik)
  const confirmed = num(universe.confirmed)
  // An enumerated universe of zero means the map op has not run yet, which is a
  // stated state rather than a coverage claim of "0 of 0".
  const nothingEnumerated = read.status === 'ready' && !tokenised

  return (
    <section className="intel-rwa-underlying space-y-4" aria-label={t('rwa_underlying.title', { defaultValue: 'Underlying registrants' })}>
      <div>
        <div className="eyebrow">{t('rwa_underlying.eyebrow', { defaultValue: 'Underlying registrants' })}</div>
        <h3 className="text-lg font-medium mt-1">{t('rwa_underlying.title', { defaultValue: 'Underlying registrants' })}</h3>
        <Scope>{t('rwa_underlying.intro', { defaultValue: 'A tokenized stock wraps a share in a company that files with the SEC. CoinMarketCap publishes that company\'s filer number, and this board records it as the provider\'s assertion and then reads the filer number at EDGAR ourselves. This is not the same question as who issued the token: that is answered above, from dated assertions only. Nothing here establishes your eligibility to invest, and nothing here is advice.' })}</Scope>
      </div>

      {read.status === 'loading' && <p role="status">{t('rwa_underlying.loading', { defaultValue: 'Reading stored profiles and filer records…' })}</p>}

      {read.status === 'unavailable' && (
        <p role="alert">{t('rwa_underlying.unavailable', { reason: read.reason || 'unknown', defaultValue: 'The underlying registrant board could not be read ({{reason}}). Nothing is asserted about any company.' })}</p>
      )}

      {read.status === 'ready' && (
        <>
          {/* Coverage first, and about the WHOLE universe: the row list below can
              be capped, these three counts are not. */}
          {nothingEnumerated ? (
            <p role="status" className="text-[12px]">
              {t('rwa_underlying.not_enumerated', { ...times, defaultValue: 'The tokenized asset universe has not been enumerated yet. It is listed daily at {{mapTime}} UTC, descriptive profiles are read at {{profileTime}} UTC and the filer records at {{registrantTime}} UTC.' })}
            </p>
          ) : (
            <p className="text-[13px]" data-testid="rwa-underlying-coverage">
              {t('rwa_underlying.coverage', {
                withCik: fmtNum(withCik ?? 0), tokenised: fmtNum(tokenised ?? 0), confirmed: fmtNum(confirmed ?? 0),
                defaultValue: '{{withCik}} of {{tokenised}} tokenized equities and funds carry an SEC filer number from CoinMarketCap; {{confirmed}} confirmed against EDGAR.',
              })}
            </p>
          )}

          {payload.reason && (
            <p role="status" className="text-[12px]">
              {t('rwa_underlying.partial', { reason: payload.reason, defaultValue: 'Some reads did not answer ({{reason}}). What did load is shown; nothing was replaced with a zero.' })}
            </p>
          )}

          {num(universe.notFoundAtEdgar) > 0 && (
            <p role="status" className="text-[12px]">
              {t('rwa_underlying.not_found_note', {
                count: num(universe.notFoundAtEdgar),
                defaultValue: 'EDGAR has no filer under the number the provider gave for {{count}} of these assets. That is a finding about the provider\'s number, not about the company.',
              })}
            </p>
          )}

          {overdue.length > 0 && (
            <p role="status" className="text-[12px]" data-testid="rwa-underlying-overdue">
              {t('rwa_underlying.overdue_note', {
                count: overdue.length, domestic: thresholds.domesticDays ?? 130, foreign: thresholds.foreignDays ?? 500,
                defaultValue: '{{count}} of the registrants read have not filed a periodic report within the window we judge them against: {{domestic}} days for a filer that lodges quarterly reports, {{foreign}} days for one that files an annual report only. They are listed first.',
              })}
            </p>
          )}

          <Scope>
            {t('rwa_underlying.days_scope', {
              defaultValue: 'Days since the last periodic filing is our own subtraction: the time you are reading this minus the later of the latest annual and latest quarterly filing dates EDGAR published for that filer. The filing dates and accession numbers are EDGAR\'s, the day count is ours, and the name comparison is ours and is an exact comparison of normalized strings rather than a similarity score.',
            })}
          </Scope>

          {rows.length === 0 && !nothingEnumerated ? (
            <p role="status" className="text-[12px]">
              {t('rwa_underlying.rows_empty', { ...times, defaultValue: 'No tokenized asset carries a filer number in the profiles captured so far. Profiles are read daily at {{profileTime}} UTC, a batch at a time, so coverage grows over several days.' })}
            </p>
          ) : null}

          {rows.length > 0 && (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]" data-testid="rwa-underlying-table">
                  <caption className="text-left text-[11px] text-[var(--fg-4)] pb-2">
                    {t('rwa_underlying.table_caption', {
                      shown: Math.min(shown, ordered.length), total: ordered.length,
                      defaultValue: 'Showing {{shown}} of {{total}} tokenized assets whose underlying carries a filer number. Every column sorts.',
                    })}
                  </caption>
                  <thead>
                    <tr>
                      <SortableHeader sortKey="asset" label={t('rwa_underlying.col_asset', { defaultValue: 'Tokenized asset' })} sort={sort} dir={dir} onToggle={toggle} align="left" />
                      <SortableHeader sortKey="registrant" label={t('rwa_underlying.col_registrant', { defaultValue: 'Registrant at EDGAR' })} sort={sort} dir={dir} onToggle={toggle} align="left" />
                      <SortableHeader sortKey="cik" label={t('rwa_underlying.col_cik', { defaultValue: 'Filer number' })} sort={sort} dir={dir} onToggle={toggle} align="left" />
                      <SortableHeader sortKey="exchange" label={t('rwa_underlying.col_exchange', { defaultValue: 'Exchange' })} sort={sort} dir={dir} onToggle={toggle} align="left" />
                      <SortableHeader sortKey="industry" label={t('rwa_underlying.col_industry', { defaultValue: 'Industry' })} sort={sort} dir={dir} onToggle={toggle} align="left" />
                      <SortableHeader sortKey="annual" label={t('rwa_underlying.col_annual', { defaultValue: 'Latest annual report' })} sort={sort} dir={dir} onToggle={toggle} align="left" />
                      <SortableHeader sortKey="quarterly" label={t('rwa_underlying.col_quarterly', { defaultValue: 'Latest quarterly report' })} sort={sort} dir={dir} onToggle={toggle} align="left" />
                      <SortableHeader sortKey="days" label={t('rwa_underlying.col_days', { defaultValue: 'Days since (our count)' })} sort={sort} dir={dir} onToggle={toggle} align="right" />
                      <SortableHeader sortKey="match" label={t('rwa_underlying.col_match', { defaultValue: 'Name comparison' })} sort={sort} dir={dir} onToggle={toggle} align="left" />
                      <StaticHeader label={t('rwa_underlying.col_rank', { defaultValue: 'RWA rank' })} align="right" />
                    </tr>
                  </thead>
                  <tbody>
                    {ordered.slice(0, shown).map(row => {
                      const registrant = row?.registrant || null
                      const days = num(row?.periodic?.days)
                      return (
                        <tr key={row.rwaId} data-rwa-id={row.rwaId} data-periodic={row?.periodic?.state || 'unknown'}>
                          <th scope="row" className={`text-left font-normal text-[var(--fg-2)] ${cell}`}>
                            <span className="inline-flex items-center gap-2">
                              <TokenAvatar src={row.logoUrl} symbol={row.symbol} name={row.name} size="sm" />
                              <span>
                                {row.name || row.symbol || `#${row.rwaId}`}
                                {row.symbol && row.name ? <span className="text-[var(--fg-4)]">{` ${row.symbol}`}</span> : null}
                              </span>
                            </span>
                          </th>
                          <td className={cell}>
                            {registrant?.name
                              ? registrant.name
                              : registrant?.state === 'not_found'
                                ? <span title={t('rwa_underlying.not_found_title', { defaultValue: 'EDGAR returned no filer for this number. The provider asserted it; we could not confirm it.' })}>
                                  {t('rwa_underlying.state_not_found', { defaultValue: 'No filer at EDGAR' })}
                                </span>
                                : registrant?.state === 'unavailable'
                                  ? <span title={registrant?.reason || ''}>{t('rwa_underlying.state_unavailable', { defaultValue: 'EDGAR did not answer' })}</span>
                                  : <span className="text-[var(--fg-4)]">{t('rwa_underlying.state_unread', { time: times.registrantTime, defaultValue: 'Not read yet (daily at {{time}} UTC)' })}</span>}
                          </td>
                          <td className={cell}>
                            {row.cik
                              ? <a className="intel-text-link font-mono" href={row.filerUrl} target="_blank" rel="noreferrer noopener">{row.cik}</a>
                              : <span className="text-[var(--fg-4)]">—</span>}
                          </td>
                          <td className={cell}>
                            {row.primaryExchange || (row.edgarExchanges || []).join(', ') || <span className="text-[var(--fg-4)]">—</span>}
                          </td>
                          <td className={cell}>{row.industry || <span className="text-[var(--fg-4)]">—</span>}</td>
                          <td className={cell}><Filing filing={registrant?.annual} t={t} /></td>
                          <td className={cell}><Filing filing={registrant?.quarterly} t={t} /></td>
                          <td className={`intel-number ${cell}`}>
                            {days == null
                              ? <span className="text-[var(--fg-4)]" title={t('rwa_underlying.days_unknown_title', { defaultValue: 'No annual or quarterly report has been read for this filer, so there is nothing to subtract from.' })}>—</span>
                              : <span data-days title={t('rwa_underlying.days_title', {
                                from: row?.periodic?.from || '—',
                                basis: t(`rwa_underlying.basis_${row?.periodic?.basis || 'none'}`, { defaultValue: row?.periodic?.basis || 'none' }),
                                threshold: row?.periodic?.thresholdDays ?? thresholds.domesticDays ?? 130,
                                defaultValue: 'Counted by us from the {{basis}} report filed {{from}}. Judged against {{threshold}} days.',
                              })}>{fmtNum(days)}</span>}
                            {row?.periodic?.state === 'overdue' && (
                              <span className="block text-[11px] text-[var(--fg-4)]">{t('rwa_underlying.overdue', { defaultValue: 'past the window' })}</span>
                            )}
                          </td>
                          <td className={cell}>
                            {registrant
                              ? <span title={registrant.nameMatch === 'exact' ? '' : t('rwa_underlying.match_title', {
                                registrant: registrant.registrantNameNormalized || '—', asset: registrant.assetNameNormalized || '—',
                                defaultValue: 'Compared as normalized strings: {{registrant}} against {{asset}}.',
                              })}>
                                {t(`rwa_underlying.match_${registrant.nameMatch}`, { defaultValue: registrant.nameMatch })}
                              </span>
                              : <span className="text-[var(--fg-4)]">—</span>}
                          </td>
                          <td className={`intel-number ${cell}`}>{row.rwaRank == null ? <span className="text-[var(--fg-4)]">—</span> : fmtNum(row.rwaRank)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {shown < ordered.length && (
                <button type="button" className="intel-text-link text-[12px]" onClick={() => setShown(value => value + PAGE_SIZE)}>
                  {t('rwa_underlying.show_more', { count: Math.min(PAGE_SIZE, ordered.length - shown), defaultValue: 'Show {{count}} more' })}
                </button>
              )}

              {payload.coverage?.truncated && (
                <p role="status" className="text-[11px] text-[var(--fg-4)]">
                  {t('rwa_underlying.truncated', { cap: payload.rowCap ?? 1000, defaultValue: 'The list stops at the {{cap}} highest-ranked assets carrying a filer number. The three coverage counts above it are of the whole universe and are not affected.' })}
                </p>
              )}
            </>
          )}
        </>
      )}
    </section>
  )
}
