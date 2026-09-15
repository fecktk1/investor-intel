import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import BoardTableHeader from './BoardTableHeader'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { Sunburst, Sparkline } from '../charts'
import { readCaptureView, captureUnavailable, captureReasonText } from '../lib/capture-api'
import { useUrlState } from '../lib/useUrlState'
import { formatUsd, formatCompact, formatPct } from '../lib/market-format'

// Exchange reserve drift (CMC plan proposal 15). What one exchange holds, by
// asset, and how that changed against the day the window opens on.
//
// Two things a reader has to keep straight and the figure therefore states:
//
//  1. This is a WALLET-LEVEL provider reading — balances the provider attributes
//     to addresses it believes belong to the exchange — read once a day on the
//     capture clock. It is not an exchange statement and it is not a tape.
//  2. Drift needs two days. `priorDate` is ALWAYS returned — it is the anchor day
//     the window opens on, not evidence that anything was captured then — so the
//     honest flag is the picked exchange's `priorAvailable`. On the current plan
//     the reserves lane started capturing on 2026-09-15, so the anchor day is
//     usually missing; every drift then arrives null, and this figure renders a
//     dash and says why rather than interpolating a number nobody measured.
//
// Shapes are `readExchangeReserves` in
// supabase/functions/_shared/intel/capture-venues-read.ts: an exchange is named
// by `exchangeSlug` (there is no display name), composition shares are `sharePct`
// on 0-100, and a `series` day carries `byExchange` as an ARRAY of
// { exchangeId, total }, not a map.

const DAYS = [7, 30, 90]
const DEFAULT_DAYS = 30
// Hoisted so useUrlState's memo/callback identities stay stable across renders.
const URL_DEFAULTS = { er_days: String(DEFAULT_DAYS) }

const num = value => {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

// `snapshot_date` is a provider CALENDAR DAY, not an instant. Formatting it in
// the reader's zone shifts it: '2026-08-16' parses as UTC midnight and prints as
// "Aug 15" for every reader west of Greenwich. Formatting in UTC makes a captured
// day read as the day the provider stamped it, in every zone.
export const dayLabel = iso => {
  if (iso == null || iso === '') return '—'
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? String(iso)
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

// The capture closes each composition list with one aggregated remainder row.
// It has no provider id of its own, so it is never treated as an asset.
const isOther = row => row?.providerId == null || String(row?.symbol ?? '').trim().toLowerCase() === 'other'

// Composition is keyed by providerId + platformSymbol, so one exchange really
// does hold "BTC" more than once: native BTC and a wrapped or bridged BTC on
// another chain are different holdings that share a ticker. A repeated symbol is
// therefore a REAL duplicate to be told apart, never a bug to be deduplicated —
// collapsing them would silently add two different assets together.
export function duplicateSymbols(composition = []) {
  const seen = new Map()
  for (const row of (Array.isArray(composition) ? composition : [])) {
    if (isOther(row)) continue
    const symbol = String(row?.symbol ?? '').trim()
    if (!symbol) continue
    seen.set(symbol, (seen.get(symbol) || 0) + 1)
  }
  return new Set([...seen.entries()].filter(([, count]) => count > 1).map(([symbol]) => symbol))
}

const bareSymbol = (row, index) => row?.symbol || row?.platformSymbol || String(row?.providerId ?? index)

/** Ring label: the bare ticker, qualified by its platform only where it repeats. */
export function assetLabel(row, index, duplicates = new Set()) {
  const symbol = bareSymbol(row, index)
  return duplicates.has(String(row?.symbol ?? '').trim()) && row?.platformSymbol
    ? `${symbol} · ${row.platformSymbol}`
    : symbol
}

// An exchange has no display name in the capture, only the provider's slug. It
// is shown verbatim: inventing a prettier name would be inventing a fact.
export const exchangeLabel = exchange => exchange?.exchangeSlug || (exchange?.exchangeId == null ? '—' : String(exchange.exchangeId))

/** The exchange holding the most, by reported USD value. Null when none were reported. */
export function largestExchange(exchanges = []) {
  const rows = (Array.isArray(exchanges) ? exchanges : []).filter(row => row?.exchangeId != null)
  if (!rows.length) return null
  return rows.reduce(
    (best, row) => ((num(row?.totalUsdValue) ?? -Infinity) > (num(best?.totalUsdValue) ?? -Infinity) ? row : best),
    rows[0],
  )
}

// One ring: the assets the capture named, plus its own remainder row. The
// remainder is NOT recomputed here — the capture already reports it, and
// re-deriving it locally would quietly disagree with the total it publishes.
export function reserveRoot(exchange, { rootName = 'Reserves', otherName = 'Other assets' } = {}) {
  const rows = Array.isArray(exchange?.composition) ? exchange.composition : []
  const duplicates = duplicateSymbols(rows)
  return {
    name: exchange?.exchangeSlug || (exchange?.exchangeId == null ? rootName : String(exchange.exchangeId)),
    children: rows.map((row, index) => ({
      // Two arcs labelled "BTC" would be unreadable, so a repeated ticker is
      // qualified by its platform. A unique one stays bare.
      name: isOther(row) ? otherName : assetLabel(row, index, duplicates),
      value: num(row?.usdValue) ?? 0,
      ...(isOther(row) ? { tone: 'muted' } : {}),
    })),
  }
}

// An arrow is a DIRECTION, not a decoration: a null drift is a day that was
// never captured and reads as a dash, never as a flat zero.
export function driftLabel(driftPct) {
  const n = num(driftPct)
  if (n == null) return '—'
  return `${n > 0 ? '▲ ' : n < 0 ? '▼ ' : ''}${formatPct(n)}`
}

// The chosen exchange's daily total across the window, oldest day first.
// `byExchange` is an array of { exchangeId, total }: a day that does not list
// this exchange is a day it was not captured, and is dropped rather than drawn
// as a zero balance.
export function exchangeTotals(series = [], exchangeId) {
  const key = String(exchangeId ?? '')
  return (Array.isArray(series) ? series : [])
    .map(row => ({
      at: Date.parse(row?.date),
      value: num((Array.isArray(row?.byExchange) ? row.byExchange : []).find(entry => String(entry?.exchangeId) === key)?.total),
    }))
    .filter(row => Number.isFinite(row.at) && row.value != null)
    .sort((a, b) => a.at - b.at)
    .map(row => row.value)
}

export default function ExchangeReserves() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  // Service-role capture tables: the read travels on the reader's authenticated
  // client, never the anonymous one.
  const { supabase } = useSupabase()
  const orgId = org?.id || null
  const [urlState, setUrlState] = useUrlState(URL_DEFAULTS)
  const days = DAYS.includes(Number(urlState.er_days)) ? Number(urlState.er_days) : DEFAULT_DAYS
  const [read, setRead] = useState({ status: 'loading', payload: null, reason: null })
  const [picked, setPicked] = useState(null)

  useEffect(() => {
    const controller = new AbortController()
    let alive = true
    setRead({ status: 'loading', payload: null, reason: null })
    readCaptureView('exchange_reserves', { days }, { orgId, signal: controller.signal, supabase })
      .then(payload => { if (alive) setRead({ status: 'ready', payload, reason: null }) })
      .catch(error => { if (alive) setRead({ status: 'unavailable', payload: null, reason: captureUnavailable(error).reason }) })
    return () => { alive = false; controller.abort() }
  }, [orgId, days, supabase])

  const exchanges = useMemo(
    () => (Array.isArray(read.payload?.exchanges) ? read.payload.exchanges : []).filter(row => row?.exchangeId != null),
    [read.payload],
  )
  // The picked exchange is a selection, not state of record: a window change
  // that drops it falls back to the largest rather than blanking the ring.
  const exchange = exchanges.find(row => String(row.exchangeId) === String(picked)) || largestExchange(exchanges)
  const composition = Array.isArray(exchange?.composition) ? exchange.composition : []

  const otherName = t('structure.er_other', {
    count: num(exchange?.otherAssetCount) ?? 0,
    defaultValue: 'Other {{count}} assets',
  })
  const root = reserveRoot(exchange, {
    rootName: t('structure.er_root', { defaultValue: 'Reserves' }),
    otherName,
  })
  const totals = useMemo(
    () => exchangeTotals(read.payload?.series, exchange?.exchangeId),
    [read.payload, exchange],
  )

  const drawn = composition.some(row => (num(row?.usdValue) ?? 0) > 0)
  const state = read.status === 'unavailable' ? 'error' : (read.status === 'ready' && drawn) ? 'ready' : 'empty'
  const reason = read.reason ? captureReasonText(t, read.reason) : undefined

  // `priorDate` is the anchor day the window opens on and is ALWAYS returned;
  // it says nothing about whether anything was captured then. Only the picked
  // exchange's `priorAvailable` does, so that is what decides the sentence.
  const priorDate = read.payload?.priorDate || null
  const driftable = exchange?.priorAvailable === true

  const caption = t('structure.er_caption', {
    defaultValue: 'Wallet balances the provider attributes to each exchange, read once a day on the capture clock — a provider reading, not an exchange statement.',
  })

  const columns = [
    t('structure.er_col_asset', { defaultValue: 'Asset' }),
    t('structure.er_col_balance', { defaultValue: 'Balance' }),
    t('structure.er_col_value', { defaultValue: 'USD value' }),
    t('structure.er_col_wallets', { defaultValue: 'Wallets' }),
    t('structure.er_col_drift', { defaultValue: 'Drift' }),
  ]

  return (
    <section className="intel-structure-reserves space-y-3" aria-label={t('structure.er_title', { defaultValue: 'Exchange reserves' })}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]" role="group" aria-label={t('structure.er_exchange', { defaultValue: 'Exchange' })}>
        <span className="text-[var(--fg-4)]">{t('structure.er_exchange', { defaultValue: 'Exchange' })}</span>
        {exchanges.length ? exchanges.map(row => (
          <button
            key={row.exchangeId}
            type="button"
            aria-pressed={String(row.exchangeId) === String(exchange?.exchangeId)}
            onClick={() => setPicked(row.exchangeId)}
            className={String(row.exchangeId) === String(exchange?.exchangeId)
              ? 'text-[var(--fg-1)] underline underline-offset-4'
              : 'text-[var(--fg-4)] hover:text-[var(--fg-2)]'}
          >
            {exchangeLabel(row)}
          </button>
        )) : (
          <span className="text-[var(--fg-3)]">{t('structure.er_no_exchanges', { defaultValue: 'No exchange was reported for this window.' })}</span>
        )}
      </div>

      <div className="grid gap-x-8 gap-y-3 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] items-start">
        <Sunburst
          title={t('structure.er_title', { defaultValue: 'Exchange reserves' })}
          description={`${t('structure.er_sub', {
            exchange: exchange ? exchangeLabel(exchange) : t('structure.er_root', { defaultValue: 'Reserves' }),
            assets: num(exchange?.assetCount) ?? 0,
            defaultValue: 'What {{exchange}} holds, by asset, at the latest captured day. The twelve largest of its {{assets}} captured assets are named and everything else is one reported remainder.',
          })} ${caption}`}
          root={root}
          depth={1}
          formatValue={formatUsd}
          state={state}
          reason={reason}
        />
        {state === 'ready' ? (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <caption className="text-left text-[11px] text-[var(--fg-4)] pb-2">
                {t('structure.er_table_caption', {
                  exchange: exchange ? exchangeLabel(exchange) : '—',
                  total: formatUsd(num(exchange?.totalUsdValue)),
                  drift: driftLabel(exchange?.driftPct),
                  defaultValue: '{{exchange}} — reported total {{total}}, window drift {{drift}}.',
                })}
              </caption>
              <thead>
                <BoardTableHeader columns={columns} numeric={[1, 2, 3, 4]} />
              </thead>
              <tbody>
                {composition.map((row, index) => (
                  // providerId alone is not a key: the same asset appears once
                  // per platform it is held on.
                  <tr key={`${row?.providerId ?? 'other'}|${row?.platformSymbol ?? ''}|${index}`}>
                    <th scope="row" className="text-left font-normal text-[var(--fg-2)] border-b border-[var(--border-default)] py-2 pr-3">
                      {isOther(row) ? otherName : bareSymbol(row, index)}
                      {/* The twin always carries the platform, duplicate or not:
                          it is the only place the two "BTC" rows are told apart
                          by a reader copying numbers out of the table. */}
                      {!isOther(row) && row?.platformSymbol
                        ? <span className="text-[var(--fg-4)]">{` · ${row.platformSymbol}`}</span>
                        : null}
                    </th>
                    <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{formatCompact(num(row?.balance))}</td>
                    <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{formatUsd(num(row?.usdValue))}</td>
                    <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{formatCompact(num(row?.walletCount))}</td>
                    <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{driftLabel(row?.driftPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]" role="group" aria-label={t('structure.er_window', { defaultValue: 'Window' })}>
        <span className="text-[var(--fg-4)]">{t('structure.er_window', { defaultValue: 'Window' })}</span>
        {DAYS.map(value => (
          <button
            key={value}
            type="button"
            aria-pressed={value === days}
            onClick={() => setUrlState({ er_days: String(value) })}
            className={value === days
              ? 'text-[var(--fg-1)] underline underline-offset-4'
              : 'text-[var(--fg-4)] hover:text-[var(--fg-2)]'}
          >
            {t('structure.er_window_option', { days: value, defaultValue: '{{days}} days' })}
          </button>
        ))}
        {totals.length ? (
          <Sparkline
            values={totals}
            ariaLabel={t('structure.er_trend_label', {
              exchange: exchange ? exchangeLabel(exchange) : '—',
              count: totals.length,
              defaultValue: '{{exchange}} total reserves over the last {{count}} captured days',
            })}
          />
        ) : null}
      </div>

      <p className="text-[12px] text-[var(--fg-4)]">
        {driftable
          ? t('structure.er_drift_against', {
              date: dayLabel(priorDate),
              defaultValue: 'Drift is measured against {{date}}, the day this window opens on.',
            })
          : t('structure.er_one_day', {
              exchange: exchange ? exchangeLabel(exchange) : '—',
              date: dayLabel(priorDate),
              defaultValue: 'No capture exists for {{exchange}} on {{date}}, the day this window drifts against: one day recorded, drift needs two. Every drift reads as a dash rather than being interpolated.',
            })}
      </p>
    </section>
  )
}
