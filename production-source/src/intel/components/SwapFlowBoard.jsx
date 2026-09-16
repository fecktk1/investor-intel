import React from 'react'
import { useTranslation } from 'react-i18next'
import BoardTableHeader from './BoardTableHeader'
import { formatUsd, formatCompact } from '../lib/market-format'
import { captureLabel } from './HolderTagBoard'

// Maker swap flow, rendered inside the contract research workspace's
// `maker_flow` view.
//
// Everything on this board is bound by five statements the backend makes and
// this file may never soften:
//
//  1. A MAKER IS A PUBLIC ON-CHAIN ACCOUNT, NOT A PERSON. Addresses are printed
//     verbatim. There is no name, no ENS, no exchange, no cluster and no second
//     address beside the maker: the read has no such field and this table
//     invents none. No account is ever related to another.
//  2. TWO CLOCKS. `capturedAt` is the hour WE swept the tape. The event stamps
//     are the provider's own swap times. Neither is ever shown as the other.
//  3. A COHORT IS ONE SWEEP. At most a few hundred swaps of tape, newest first.
//     It is not the holder base, not every trader and not the token's history.
//  4. FIRST TOUCH IS ONLY FIRST TOUCH WHEN THE TAPE RAN OUT. A sweep stopped by
//     our own page ceiling or credit budget shows the earliest appearance IN
//     WHAT WE CAPTURED, and the caption says so rather than implying more.
//  5. DIRECTION IS THE PROVIDER'S WORD, READ AGAINST A LEG. Accumulating and
//     distributing describe how the token moved, not intent, skill or advice.
//
// Shapes: `readSwapFlow` and `readSwapFlowCaptures` in
// supabase/functions/_shared/intel/swap-flow-read.ts.

const num = value => {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

const count = value => (num(value) == null ? '—' : formatCompact(num(value)))
const usd = value => (num(value) == null ? '—' : formatUsd(num(value)))
/** A token quantity is the provider's own figure in the token's own units. It
 * carries no currency and is never converted. */
const qty = value => (num(value) == null ? '—' : Number(value).toLocaleString(undefined, { maximumFractionDigits: 6 }))

/** A swap time, in the reader's own zone. It is an instant the PROVIDER dated,
 * unlike the capture hour beside it. */
export const eventLabel = value => {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** A signed USD net, shown as a direction. A null net is a dash and nothing
 * else: an account whose value the provider never reported has no direction. A
 * measured zero keeps its number and reads as unchanged. */
export function netLabel(value) {
  const n = num(value)
  if (n == null) return '—'
  return `${n > 0 ? '▲' : n < 0 ? '▼' : '—'} ${formatUsd(Math.abs(n))}`
}

/** How many swaps in a sweep named no maker at all. They are real swaps that
 * belong to no cohort, and the board reports them rather than absorbing them. */
export function unattributed(sweep) {
  const seen = num(sweep?.swapsSeen), withMaker = num(sweep?.swapsWithMaker)
  if (seen == null || withMaker == null) return null
  return Math.max(0, seen - withMaker)
}

/** One account row: the address as the row header, then its figures.
 *
 * Only the ROW is shared. Each table below writes out its own `<thead>` with a
 * LITERAL `numeric={[...]}` array, the way HolderTagBoard does, because the
 * alignment guard (scripts/check-intel-table-alignment.mjs) is a text scan: a
 * `numeric` passed as a variable is invisible to it, so a shared header
 * component would leave every right-aligned column reading as a column with no
 * right-aligned header. Writing the arrays out keeps the guard able to prove
 * that each header sits over its own column. */
function AccountRow({ row, cells }) {
  return (
    <tr>
      <th scope="row" className="text-left font-normal text-[var(--fg-2)] border-b border-[var(--border-default)] py-2 pr-3 break-all">{row.makerAddress}</th>
      {cells.map((cell, index) => (
        <td key={index} className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{cell}</td>
      ))}
    </tr>
  )
}

export default function SwapFlowBoard({ result, loading = false, selection = {}, onSelection, onRefresh }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const flow = result?.swapFlow || null
  const captures = Array.isArray(result?.flowCaptures?.captures) ? result.flowCaptures.captures : []
  const capture = result?.capture || null
  const sweep = flow?.sweep || null
  const summary = flow?.summary || null
  const firstTouch = flow?.firstTouch || null

  // A selection the retained window no longer holds falls back to the newest
  // sweep rather than blanking the board.
  const selected = captures.find(row => row?.capturedAt === selection.capturedAt) || captures.at(-1) || null
  const accumulating = Array.isArray(flow?.accumulating) ? flow.accumulating : []
  const distributing = Array.isArray(flow?.distributing) ? flow.distributing : []
  const firstWallets = Array.isArray(firstTouch?.wallets) ? firstTouch.wallets : []

  const change = patch => onSelection?.({ ...selection, ...patch })

  const scope = t('maker_flow.scope', {
    defaultValue: 'A maker is a public on-chain account, not a person. Nothing here is resolved to a name, an exchange or an entity, and no account is linked to any other.',
  })
  const basis = t('maker_flow.basis', {
    defaultValue: 'Direction is CoinMarketCap’s own buy/sell word for a swap, read against whichever leg is this contract. It describes how the token moved, not why: it is not intent, not skill and not advice. A swap the rule cannot place is counted as unclassified rather than forced onto a side.',
  })

  if (result?.state === 'unsupported') {
    return (
      <section className="space-y-3" aria-label={t('maker_flow.title', { defaultValue: 'Maker swap flow' })}>
        <p role="status">
          {result?.reason === 'plan_below_startup'
            ? result?.message || t('maker_flow.plan_below_startup', { defaultValue: 'Maker swap-flow cohorts need the CoinMarketCap Startup plan. No call was made.' })
            : t('maker_flow.unsupported', { defaultValue: 'Maker swap flow is unavailable for this contract identity.' })}
        </p>
        <p className="intel-analysis-caption">{scope}</p>
      </section>
    )
  }

  return (
    <section className="space-y-3" aria-label={t('maker_flow.title', { defaultValue: 'Maker swap flow' })}>
      <p className="intel-analysis-caption">
        {t('maker_flow.intro', {
          defaultValue: 'CoinMarketCap’s public swap tape for this exact contract, swept newest first and grouped by the maker account it attributes each swap to. One sweep reads a bounded slice of the tape, so this is what that sweep saw and never the whole history of the token.',
        })} {scope}
      </p>

      <div className="intel-holdings-toolbar">
        <label>
          {t('maker_flow.capture', { defaultValue: 'Sweep' })}
          <select className="select" aria-label={t('maker_flow.capture', { defaultValue: 'Sweep' })}
            value={selected?.capturedAt || ''} disabled={!captures.length}
            onChange={event => change({ capturedAt: event.target.value || null })}>
            {captures.length
              ? captures.map(row => <option key={row.capturedAt} value={row.capturedAt}>{captureLabel(row.capturedAt)}</option>)
              : <option value="">{t('maker_flow.no_captures', { defaultValue: 'No sweep recorded yet' })}</option>}
          </select>
        </label>
        <button className="btn" type="button" disabled={loading} onClick={() => onRefresh?.()}>
          {t('maker_flow.refresh', { defaultValue: 'Sweep the swap tape' })}
        </button>
      </div>
      <p className="intel-analysis-caption">
        {t('maker_flow.refresh_cost', {
          defaultValue: 'A sweep costs 1 CoinMarketCap credit for each page of 25 swaps it walks, at most 8. Sweeps are hourly, so a second one inside the same hour is skipped and costs nothing.',
        })}
      </p>

      {result?.state === 'unavailable' && !captures.length
        ? <p role="status">{t('maker_flow.none_yet', { defaultValue: 'No sweep has been taken for this contract yet. Sweep the tape to take the first one.' })}</p>
        : null}
      {result?.state === 'stale' && result?.flowCaptures?.asOf
        ? <p role="status">{t('maker_flow.stale', { at: captureLabel(result.flowCaptures.asOf), defaultValue: 'The newest sweep is from {{at}}, not this hour. Nothing here has been re-swept since.' })}</p>
        : null}
      {result?.state === 'partial'
        ? <p role="status">{t('maker_flow.partial', { reason: String(result?.reason || '').replaceAll('_', ' '), defaultValue: 'This sweep is incomplete ({{reason}}). The pages it did read are kept; the pages it did not are simply absent.' })}</p>
        : null}
      {capture?.skipped === 'within_cadence'
        ? <p role="status">{t('maker_flow.within_cadence', { defaultValue: 'A sweep already exists for this hour, so no call was made and no credit was spent.' })}</p>
        : null}
      {capture && num(capture.credits) != null
        ? <p className="intel-analysis-caption">{t('maker_flow.capture_cost', { credits: num(capture.credits), pages: num(capture.pages) ?? 0, defaultValue: 'Last sweep: {{pages}} pages walked, {{credits}} credits.' })}</p>
        : null}

      {sweep
        ? (
          <p className="intel-analysis-caption">
            {t('maker_flow.sweep_coverage', {
              pages: num(sweep.pages) ?? 0, swaps: num(sweep.swapsSeen) ?? 0, accounts: num(sweep.makers) ?? 0,
              from: eventLabel(sweep.oldestEventAt), to: eventLabel(sweep.newestEventAt),
              defaultValue: 'This sweep walked {{pages}} pages and read {{swaps}} swaps, dated by the provider from {{from}} to {{to}}, naming {{accounts}} accounts.',
            })}
            {' '}
            {sweep.exhausted
              ? t('maker_flow.sweep_exhausted', { defaultValue: 'The provider ran out of tape before our page ceiling did, so this sweep reached the oldest swap it publishes for this contract.' })
              : t('maker_flow.sweep_bounded', { reason: String(sweep.stopReason || '').replaceAll('_', ' '), defaultValue: 'The sweep stopped at our own limit ({{reason}}), not at the end of the provider’s tape, so older swaps exist that this sweep did not read.' })}
            {unattributed(sweep)
              ? ` ${t('maker_flow.no_maker_note', { swaps: unattributed(sweep), defaultValue: '{{swaps}} of those swaps named no maker at all. They are counted here but belong to no account, and none of them is folded into an invented one.' })}`
              : ''}
          </p>
        )
        : null}

      {summary
        ? (
          <p className="intel-analysis-caption">
            {t('maker_flow.summary', {
              accounts: num(summary.accounts) ?? 0, accumulating: num(summary.accumulating) ?? 0,
              distributing: num(summary.distributing) ?? 0, balanced: num(summary.balanced) ?? 0,
              unknown: num(summary.unknown) ?? 0,
              defaultValue: '{{accounts}} accounts in this sweep: {{accumulating}} took more of the token in than out, {{distributing}} more out than in. {{balanced}} moved the same value both ways and {{unknown}} reported no readable value at all. Those last two are different answers and are never merged.',
            })} {basis}
          </p>
        )
        : null}

      {captures.length ? <>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <caption className="text-left text-[11px] text-[var(--fg-4)] pb-2">
              {t('maker_flow.accumulating_caption', {
                at: captureLabel(flow?.capturedAt),
                defaultValue: 'Accounts that took more value of this token in than out, across the swaps of the sweep of {{at}}. Largest movement first.',
              })}
            </caption>
            <thead>
              <BoardTableHeader
                columns={[
                  t('maker_flow.col_account', { defaultValue: 'Account' }),
                  t('maker_flow.col_net', { defaultValue: 'Net (USD)' }),
                  t('maker_flow.col_acquired', { defaultValue: 'In (USD)' }),
                  t('maker_flow.col_acquired_qty', { defaultValue: 'In (tokens)' }),
                  t('maker_flow.col_swaps', { defaultValue: 'Swaps' }),
                  t('maker_flow.col_last_seen', { defaultValue: 'Last swap' }),
                ]}
                numeric={[1, 2, 3, 4, 5]}
              />
            </thead>
            <tbody>
              {accumulating.map(row => (
                <AccountRow key={row.makerAddress} row={row}
                  cells={[netLabel(row.netUsd), usd(row.acquiredUsd), qty(row.acquiredQty), count(row.swaps), eventLabel(row.lastEventAt)]} />
              ))}
            </tbody>
          </table>
        </div>
        {!accumulating.length
          ? <p role="status">{t('maker_flow.side_empty', { defaultValue: 'No account in this sweep took more of the token in than out.' })}</p>
          : null}

        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <caption className="text-left text-[11px] text-[var(--fg-4)] pb-2">
              {t('maker_flow.distributing_caption', {
                at: captureLabel(flow?.capturedAt),
                defaultValue: 'Accounts that sent more value of this token out than in, across the swaps of the sweep of {{at}}. Largest movement first.',
              })}
            </caption>
            <thead>
              <BoardTableHeader
                columns={[
                  t('maker_flow.col_account', { defaultValue: 'Account' }),
                  t('maker_flow.col_net', { defaultValue: 'Net (USD)' }),
                  t('maker_flow.col_disposed', { defaultValue: 'Out (USD)' }),
                  t('maker_flow.col_disposed_qty', { defaultValue: 'Out (tokens)' }),
                  t('maker_flow.col_swaps', { defaultValue: 'Swaps' }),
                  t('maker_flow.col_last_seen', { defaultValue: 'Last swap' }),
                ]}
                numeric={[1, 2, 3, 4, 5]}
              />
            </thead>
            <tbody>
              {distributing.map(row => (
                <AccountRow key={row.makerAddress} row={row}
                  cells={[netLabel(row.netUsd), usd(row.disposedUsd), qty(row.disposedQty), count(row.swaps), eventLabel(row.lastEventAt)]} />
              ))}
            </tbody>
          </table>
        </div>
        {!distributing.length
          ? <p role="status">{t('maker_flow.side_empty_out', { defaultValue: 'No account in this sweep sent more of the token out than in.' })}</p>
          : null}

        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <caption className="text-left text-[11px] text-[var(--fg-4)] pb-2">
              {`${t('maker_flow.first_touch_caption', {
                defaultValue: 'Accounts by their earliest swap of this contract, oldest first.',
              })} ${firstTouch?.complete
                ? t('maker_flow.first_touch_complete', { defaultValue: 'This sweep reached the end of the provider’s tape, so these are the earliest swaps CoinMarketCap publishes for this contract.' })
                : t('maker_flow.first_touch_partial', {
                  reason: String(firstTouch?.reason || '').replaceAll('_', ' '),
                  defaultValue: 'This sweep stopped at our own limit ({{reason}}), so these are the earliest swaps IN WHAT WE CAPTURED, not the first time any of these accounts touched the token.',
                })}`}
            </caption>
            <thead>
              <BoardTableHeader
                columns={[
                  t('maker_flow.col_account', { defaultValue: 'Account' }),
                  t('maker_flow.col_first_seen', { defaultValue: 'Earliest swap' }),
                  t('maker_flow.col_net', { defaultValue: 'Net (USD)' }),
                  t('maker_flow.col_swaps', { defaultValue: 'Swaps' }),
                ]}
                numeric={[1, 2, 3]}
              />
            </thead>
            <tbody>
              {firstWallets.map(row => (
                <AccountRow key={row.makerAddress} row={row}
                  cells={[eventLabel(row.firstEventAt), netLabel(row.netUsd), count(row.swaps)]} />
              ))}
            </tbody>
          </table>
        </div>
        {!firstWallets.length
          ? <p role="status">{t('maker_flow.first_touch_empty', { defaultValue: 'No account in this sweep carries a swap the provider dated.' })}</p>
          : null}
      </> : null}

      <p className="intel-analysis-caption">{scope} {basis}</p>
    </section>
  )
}
