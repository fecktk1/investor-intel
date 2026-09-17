import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import BoardTableHeader from './BoardTableHeader'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { RadialBars, Sparkline } from '../charts'
import { readCaptureView, captureUnavailable, captureReasonText } from '../lib/capture-api'
import { useUrlState } from '../lib/useUrlState'
import { formatUsd, formatPct, fmtNum } from '../lib/market-format'

// Category board (CMC plan proposal 22). CoinMarketCap publishes its own
// category list with a market cap, a volume and a 24h move per category; this
// figure reads it as a SECOND source of market breadth beside the CoinGecko
// categories the rest of Intel uses, and never blends the two — a category that
// only one catalogue publishes is a reading of that catalogue, not of "the
// market".
//
// Contract: `categories` takes { days: 1|7|30, top } (the read caps `top` at 60)
// and answers { rows, series, asOf, coverage, reason }. `rows` is the latest
// captured board, largest market cap first; `series` carries one market-cap
// point per capture per category.
//
// Hourly category captures began 2026-09-15 01:00 UTC, so the trace beside each
// row is short by construction. The figure says how many captures the chosen
// window actually holds rather than drawing a confident line through two points.

const DAYS = [1, 7, 30]
const DEFAULT_DAYS = 7
// The read caps `top` at 60; these are the three sizes the control offers.
const TOPS = [12, 30, 60]
const DEFAULT_TOP = 30
// The ring can only separate so many concentric arcs; the table below carries
// every category the read returned.
const RING = 12
// Hoisted so useUrlState's memo/callback identities stay stable across renders.
const URL_DEFAULTS = { c_days: String(DEFAULT_DAYS), c_top: String(DEFAULT_TOP) }

const num = value => {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

const optionOf = (options, raw, fallback) => (options.includes(Number(raw)) ? Number(raw) : fallback)

/** The captured board, largest market cap first. The read already orders it, but
 *  a row with no market cap cannot be placed on a market-cap ring and sorts last
 *  rather than at zero. */
export function topCategories(rows = [], max = RING) {
  return (Array.isArray(rows) ? rows : [])
    .filter(row => row && (row.categoryId != null || row.name))
    .slice()
    .sort((a, b) => (num(b?.marketCap) ?? -Infinity) - (num(a?.marketCap) ?? -Infinity))
    .slice(0, Math.max(0, max))
}

/** Market-cap trace per category id, oldest capture first. A point without a
 *  parsable time or a finite market cap is dropped, never pinned to zero. */
export function categoryTraces(series = []) {
  const out = {}
  for (const row of Array.isArray(series) ? series : []) {
    const key = row?.categoryId
    if (key == null) continue
    out[String(key)] = (Array.isArray(row.points) ? row.points : [])
      .map(point => ({ at: Date.parse(point?.capturedAt), value: num(point?.marketCap) }))
      .filter(point => Number.isFinite(point.at) && point.value != null)
      .sort((a, b) => a.at - b.at)
      .map(point => point.value)
  }
  return out
}

/** How many captures the chosen window actually holds: the longest trace the
 *  read returned. Stated on the figure so a two-point line is never read as a
 *  month of history. */
export function captureDepth(series = []) {
  return (Array.isArray(series) ? series : []).reduce(
    (deepest, row) => Math.max(deepest, Array.isArray(row?.points) ? row.points.length : 0),
    0,
  )
}

const toneFor = change => {
  const n = num(change)
  if (n == null || n === 0) return 'muted'
  return n > 0 ? 'green' : 'red'
}

export default function CategoryBoard() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  // The capture tables are service-role only: the read travels on the reader's
  // authenticated client, never the anonymous one.
  const { supabase } = useSupabase()
  const orgId = org?.id || null
  const [urlState, setUrlState] = useUrlState(URL_DEFAULTS)
  const days = optionOf(DAYS, urlState.c_days, DEFAULT_DAYS)
  const top = optionOf(TOPS, urlState.c_top, DEFAULT_TOP)
  const [read, setRead] = useState({ status: 'loading', payload: null, reason: null })

  useEffect(() => {
    const controller = new AbortController()
    let alive = true
    setRead({ status: 'loading', payload: null, reason: null })
    readCaptureView('categories', { days, top }, { orgId, signal: controller.signal, supabase })
      .then(payload => { if (alive) setRead({ status: 'ready', payload, reason: null }) })
      .catch(error => { if (alive) setRead({ status: 'unavailable', payload: null, reason: captureUnavailable(error).reason }) })
    return () => { alive = false; controller.abort() }
  }, [orgId, days, top, supabase])

  const payload = read.payload
  const rows = useMemo(() => (Array.isArray(payload?.rows) ? payload.rows : []), [payload])
  const ranked = useMemo(() => topCategories(rows, RING), [rows])
  const traces = useMemo(() => categoryTraces(payload?.series), [payload])
  const depth = useMemo(() => captureDepth(payload?.series), [payload])

  // An empty capture table answers with an empty board and NO reason — that is
  // an empty reading. A reason on a successful read is a failed query behind it
  // and is reported like a thrown one rather than being shown as "empty".
  const stated = read.status === 'unavailable' ? read.reason : (read.status === 'ready' ? (payload?.reason || null) : null)
  const state = stated ? 'error' : (read.status === 'ready' && ranked.length) ? 'ready' : 'empty'
  const reason = stated ? captureReasonText(t, stated) : undefined

  const ceiling = Math.max(0, ...ranked.map(row => num(row.marketCap) ?? 0)) || 1
  const series = ranked.map((row, index) => ({
    key: row.categoryId ?? row.name ?? index,
    label: row.name || row.title || String(row.categoryId ?? '—'),
    value: num(row.marketCap) ?? 0,
    max: ceiling,
    tone: toneFor(row.marketCapChange24hPct),
  }))

  const columns = [
    t('categories.col_category', { defaultValue: 'Category' }),
    t('categories.col_tokens', { defaultValue: 'Tokens' }),
    t('categories.col_market_cap', { defaultValue: 'Market cap' }),
    t('categories.col_change', { defaultValue: '24h change' }),
    t('categories.col_volume', { defaultValue: 'Volume' }),
    t('categories.col_trend', { defaultValue: 'Market cap trace' }),
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
    <section className="intel-category-board space-y-3" aria-label={t('categories.board_title', { defaultValue: 'Category breadth' })}>
      <RadialBars
        title={t('categories.board_title', { defaultValue: 'Category breadth' })}
        description={`${t('categories.board_sub', {
          ring: RING,
          defaultValue: 'The {{ring}} largest CoinMarketCap categories by market capitalisation. A green arc rose over the last 24 hours, a red arc fell, a grey arc did not move. This is the CoinMarketCap category list, a second source beside the CoinGecko categories used elsewhere in Intel, never a blend of the two.',
        })} ${depth
          ? t('categories.board_depth', { captures: depth, days, defaultValue: 'Hourly category captures began on 15 September 2026; the last {{days}} days hold {{captures}} captures.' })
          : t('categories.board_no_depth', { defaultValue: 'No category capture has been recorded for this window yet.' })}`}
        series={series}
        formatValue={formatUsd}
        state={state}
        reason={reason}
      />

      <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
        {control(
          t('categories.window', { defaultValue: 'Window' }),
          DAYS,
          days,
          value => setUrlState({ c_days: String(value) }),
          value => t('categories.window_option', { days: value, defaultValue: '{{days}}d' }),
        )}
        {control(
          t('categories.top', { defaultValue: 'Categories read' }),
          TOPS,
          top,
          value => setUrlState({ c_top: String(value) }),
          value => t('categories.top_option', { top: value, defaultValue: 'Top {{top}}' }),
        )}
      </div>

      {state === 'ready' ? (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <caption className="text-left text-[11px] text-[var(--fg-4)] pb-2">
              {t('categories.table_caption', {
                count: rows.length, shown: ranked.length,
                defaultValue: 'Latest capture for {{count}} categories; the {{shown}} largest are drawn on the ring above.',
              })}
            </caption>
            <thead>
              <BoardTableHeader columns={columns} numeric={[1, 2, 3, 4]} />
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const name = row?.name || row?.title || String(row?.categoryId ?? '—')
                const values = traces[String(row?.categoryId)] || []
                return (
                  <tr key={row?.categoryId ?? `${name}-${index}`}>
                    <th scope="row" className="text-left font-normal text-[var(--fg-2)] border-b border-[var(--border-default)] py-2 pr-3">{name}</th>
                    <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{fmtNum(num(row?.numTokens))}</td>
                    <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{formatUsd(num(row?.marketCap))}</td>
                    <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{formatPct(num(row?.marketCapChange24hPct))}</td>
                    <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{formatUsd(num(row?.volume24h))}</td>
                    <td className="border-b border-[var(--border-default)] py-2 pr-3">
                      {values.length
                        ? <Sparkline values={values} ariaLabel={t('categories.trend_label', { name, count: values.length, defaultValue: '{{name}} market cap over the last {{count}} captures' })} />
                        : <span className="text-[var(--fg-4)]">—</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  )
}
