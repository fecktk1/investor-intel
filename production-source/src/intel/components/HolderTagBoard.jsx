import React from 'react'
import { useTranslation } from 'react-i18next'
import BoardTableHeader from './BoardTableHeader'
import { Histogram, RadialBars } from '../charts'
import { formatUsd, formatCompact } from '../lib/market-format'

// Holder tags and cohort PnL (CMC plan proposal 20), rendered inside the
// contract research workspace's `holder_tags` view.
//
// Everything on this board is bound by four statements the backend makes and
// this file may never soften:
//
//  1. THE CLOCK IS OURS. `capturedAt` is the hour WE asked CoinMarketCap.
//     Neither `/v1/dex/holders/tag_count` nor `/v1/dex/holders/list` publishes an
//     observation time, so no date here may be presented as a provider reading.
//  2. A TAG IS A PROVIDER LABEL FOR AN ADDRESS. `tag_kol`, `tag_insider` and the
//     rest are printed verbatim: renaming `tag_dev` to "the developer" would
//     turn a classification of an address into a claim about a person.
//  3. A WALLET IS AN ADDRESS. No name, no ENS, no exchange, no clustering — the
//     cohort read has no such field and this table invents none.
//  4. THE RATIO HAS NO UNIT. The provider states neither fraction nor percent, so
//     the number is printed as reported and the caption says the unit is unknown.
//
// Shapes: `readHolderTags`, `readHolderCohort` and `compareHolderTags` in
// supabase/functions/_shared/intel/holder-tags-read.ts.

const num = value => {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

const count = value => (num(value) == null ? '—' : formatCompact(num(value)))
/** The ratio has no stated unit, so it is printed as reported — never as a
 * percentage and never rescaled. */
const ratio = value => (num(value) == null ? '—' : Number(value).toLocaleString(undefined, { maximumFractionDigits: 6 }))

/** A capture hour, in the reader's own zone. It is an instant (the hour we asked),
 * so it is formatted as an instant rather than as a calendar day. */
export const captureLabel = value => {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** A direction, not a decoration.
 *
 * A null delta is a dash and nothing else: "we did not measure it on one of the
 * two sides" is not a change. A measured zero is a real answer and keeps its
 * number, marked as unchanged. */
export function deltaLabel(value, format = count) {
  const n = num(value)
  if (n == null) return '—'
  return `${n > 0 ? '▲' : n < 0 ? '▼' : '—'} ${format(Math.abs(n))}`
}

/** The cohort entry to open: the asked-for tag, else the first tag the capture
 * returned. An asked-for tag the capture holds no page for keeps its NAME with an
 * empty page — "this tag recorded no addresses" is a reading, and falling back to
 * a different tag under the same heading would be a mislabel. */
export function cohortFor(cohort, tag) {
  const tags = Array.isArray(cohort?.tags) ? cohort.tags : []
  if (tag) return tags.find(row => row?.tag === tag) || { tag, wallets: [], realized: null }
  return tags[0] || null
}

/** Realized-gain bins, toned by sign. The backend never emits a bin that crosses
 * zero, so the sign of an edge is the sign of the whole bin. */
export function realizedBins(realized) {
  return (Array.isArray(realized?.histogram) ? realized.histogram : []).map(bin => ({
    ...bin,
    tone: (num(bin?.from) ?? 0) < 0 || (num(bin?.to) ?? 0) < 0 ? 'red' : 'green',
  }))
}

export default function HolderTagBoard({ result, loading = false, selection = {}, onSelection, onRefresh }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const tags = result?.holderTags || null
  const cohort = result?.holderCohort || null
  const comparison = result?.comparison || null
  const capture = result?.capture || null
  const captures = Array.isArray(tags?.captures) ? tags.captures : []

  // A selection the retained window no longer holds falls back to the newest
  // capture rather than blanking the board.
  const selected = captures.find(row => row?.capturedAt === selection.capturedAt) || tags?.latest || captures.at(-1) || null
  const points = Array.isArray(selected?.tags) ? selected.tags : []
  const ceiling = Math.max(0, ...points.map(point => num(point?.holderCount) ?? 0))
  const opened = cohortFor(cohort, selection.tag || null)
  const wallets = Array.isArray(opened?.wallets) ? opened.wallets : []
  const realized = opened?.realized || null
  const bins = realizedBins(realized)

  const change = (patch) => onSelection?.({ ...selection, ...patch })

  const clock = t('holder_tags.clock', {
    defaultValue: 'Every date here is a capture time: the hour we asked CoinMarketCap. Neither endpoint publishes an observation time, so nothing on this board dates the provider’s own measurement.',
  })
  const ratioNote = t('holder_tags.ratio_unit', {
    defaultValue: 'The provider states no unit for the holding ratio (fraction or percent is unconfirmed), so it is printed exactly as reported and never converted.',
  })

  if (result?.state === 'unsupported') {
    return (
      <section className="space-y-3" aria-label={t('holder_tags.title', { defaultValue: 'Holder tags and cohort' })}>
        <p role="status">
          {result?.reason === 'plan_below_startup'
            ? result?.message || t('holder_tags.plan_below_startup', { defaultValue: 'Holder tags and cohort PnL need the CoinMarketCap Startup plan. No call was made.' })
            : t('holder_tags.unsupported', { defaultValue: 'Holder tags are unavailable for this contract identity.' })}
        </p>
        <p className="intel-analysis-caption">{clock}</p>
      </section>
    )
  }

  return (
    <section className="space-y-3" aria-label={t('holder_tags.title', { defaultValue: 'Holder tags and cohort' })}>
      <p className="intel-analysis-caption">
        {t('holder_tags.intro', {
          defaultValue: 'CoinMarketCap’s tag board for this exact contract, kept on our own capture clock, and for each tag one page of at most 50 addresses as the provider returned them. Tags are CoinMarketCap’s labels for addresses. An address is not a person, and nothing here is resolved to a name, an exchange or an entity.',
        })}
      </p>

      <div className="intel-holdings-toolbar">
        <label>
          {t('holder_tags.capture', { defaultValue: 'Capture' })}
          <select className="select" aria-label={t('holder_tags.capture', { defaultValue: 'Capture' })}
            value={selected?.capturedAt || ''} disabled={!captures.length}
            onChange={event => change({ capturedAt: event.target.value || null })}>
            {captures.length
              ? captures.map(row => <option key={row.capturedAt} value={row.capturedAt}>{captureLabel(row.capturedAt)}</option>)
              : <option value="">{t('holder_tags.no_captures', { defaultValue: 'No capture recorded yet' })}</option>}
          </select>
        </label>
        <label>
          {t('holder_tags.compare', { defaultValue: 'Compare with' })}
          <select className="select" aria-label={t('holder_tags.compare', { defaultValue: 'Compare with' })}
            value={selection.compareWith || ''}
            onChange={event => change({ compareWith: event.target.value || null })}>
            <option value="">{t('holder_tags.compare_none', { defaultValue: 'No comparison' })}</option>
            {captures.filter(row => row.capturedAt !== selected?.capturedAt).map(row => (
              <option key={row.capturedAt} value={row.capturedAt}>{captureLabel(row.capturedAt)}</option>
            ))}
          </select>
        </label>
        <label>
          {t('holder_tags.cohort_tag', { defaultValue: 'Cohort tag' })}
          <select className="select" aria-label={t('holder_tags.cohort_tag', { defaultValue: 'Cohort tag' })}
            value={selection.tag || ''}
            onChange={event => change({ tag: event.target.value || null })}>
            <option value="">{t('holder_tags.cohort_all', { defaultValue: 'First tag in the capture' })}</option>
            {points.map(point => <option key={point.tag} value={point.tag}>{point.tag}</option>)}
          </select>
        </label>
        <button className="btn" type="button" disabled={loading} onClick={() => onRefresh?.()}>
          {t('holder_tags.refresh', { defaultValue: 'Refresh holder tags' })}
        </button>
      </div>
      <p className="intel-analysis-caption">
        {t('holder_tags.refresh_cost', {
          defaultValue: 'A refresh takes a new capture: 1 CoinMarketCap credit for the tag board plus 1 for each tag with holders, at most 9. Captures are hourly, so a second refresh inside the same hour is skipped and costs nothing.',
        })}
      </p>

      {result?.state === 'unavailable' && !captures.length
        ? <p role="status">{t('holder_tags.none_yet', { defaultValue: 'No holder-tag capture has been taken for this contract yet. Refresh to take the first one.' })}</p>
        : null}
      {result?.state === 'stale' && tags?.asOf
        ? <p role="status">{t('holder_tags.stale', { at: captureLabel(tags.asOf), defaultValue: 'The newest capture is from {{at}}, not this hour. Nothing here has been re-asked since.' })}</p>
        : null}
      {result?.state === 'partial'
        ? <p role="status">{t('holder_tags.partial', { reason: String(result?.reason || '').replaceAll('_', ' '), defaultValue: 'This capture is incomplete ({{reason}}). The tag board it did record is kept; the cohort pages it did not are simply absent.' })}</p>
        : null}
      {capture?.skipped === 'within_cadence'
        ? <p role="status">{t('holder_tags.within_cadence', { defaultValue: 'A capture already exists for this hour, so no call was made and no credit was spent.' })}</p>
        : null}
      {capture && num(capture.credits) != null
        ? <p className="intel-analysis-caption">{t('holder_tags.capture_cost', { credits: num(capture.credits), calls: num(capture.calls) ?? 0, defaultValue: 'Last refresh: {{calls}} provider calls, {{credits}} credits.' })}</p>
        : null}

      <RadialBars
        title={t('holder_tags.board_title', { defaultValue: 'Holder accounts by tag' })}
        description={`${t('holder_tags.board_sub', {
          at: captureLabel(selected?.capturedAt),
          defaultValue: 'Holder accounts CoinMarketCap classified under each of its tags, at the capture of {{at}}. Arcs share one scale. A tag the provider did not count is a dash, not a zero.',
        })} ${clock}`}
        series={points.map(point => ({
          key: point.tag,
          label: point.tag,
          // A count the provider did not report stays null: it draws as no arc
          // and reads as a dash, never as a measured zero.
          value: num(point.holderCount),
          max: ceiling > 0 ? ceiling : 1,
          tone: point.tag === (selection.tag || opened?.tag) ? 'accent' : 'blue',
        }))}
        formatValue={count}
        state={points.length ? 'ready' : 'empty'}
        onSelect={row => change({ tag: row?.key || null })}
      />

      {comparison
        ? (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <caption className="text-left text-[11px] text-[var(--fg-4)] pb-2">
                {t('holder_tags.compare_caption', {
                  from: captureLabel(comparison.from), to: captureLabel(comparison.to),
                  defaultValue: 'From the capture of {{from}} to the capture of {{to}}. A delta exists only where BOTH captures reported the number: a tag that appeared, disappeared or was never counted reads as a dash, because “it went from nothing to 400” and “we did not measure it before” are different statements.',
                })}
                {comparison.reason === 'one_side_missing'
                  ? ` ${t('holder_tags.compare_one_side', { defaultValue: 'One of the two captures is outside the retained window, so every delta is a dash.' })}`
                  : ''}
              </caption>
              <thead>
                <BoardTableHeader
                  columns={[
                    t('holder_tags.col_tag', { defaultValue: 'Tag' }),
                    t('holder_tags.col_holders_from', { defaultValue: 'Holders before' }),
                    t('holder_tags.col_holders_to', { defaultValue: 'Holders after' }),
                    t('holder_tags.col_holder_delta', { defaultValue: 'Change in holders' }),
                    t('holder_tags.col_balance_delta', { defaultValue: 'Change in balance' }),
                    t('holder_tags.col_ratio_delta', { defaultValue: 'Change in ratio (unit unknown)' }),
                  ]}
                  numeric={[1, 2, 3, 4, 5]}
                />
              </thead>
              <tbody>
                {(Array.isArray(comparison.tags) ? comparison.tags : []).map(row => (
                  <tr key={row.tag}>
                    <th scope="row" className="text-left font-normal text-[var(--fg-2)] border-b border-[var(--border-default)] py-2 pr-3">{row.tag}</th>
                    <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{count(row.from?.holderCount)}</td>
                    <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{count(row.to?.holderCount)}</td>
                    <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{deltaLabel(row.holderCountDelta)}</td>
                    <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{deltaLabel(row.balanceDelta)}</td>
                    <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{deltaLabel(row.ratioDelta, ratio)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
        : null}

      {/* With no capture at all there is no cohort to shape: an empty histogram
          and an empty address table would both be figures about nothing. */}
      {captures.length ? <>
      <Histogram
        title={t('holder_tags.realized_title', { tag: opened?.tag || '—', defaultValue: 'Realized gains: {{tag}}' })}
        description={`${t('holder_tags.realized_sub', {
          defaultValue: 'Addresses in this tag’s captured page, by the size of the realized gain the provider reports for each. Losses and gains are binned separately, so no bin crosses zero. A realized figure is the provider’s, not a valuation and not advice.',
        })} ${clock}`}
        bins={bins}
        formatValue={formatUsd}
        formatCount={count}
        state={bins.length ? 'ready' : 'empty'}
      />
      {realized
        ? (
          <p className="intel-analysis-caption">
            {t('holder_tags.realized_counts', {
              profit: num(realized.inProfit) ?? 0, loss: num(realized.atLoss) ?? 0,
              flat: num(realized.flat) ?? 0, unknown: num(realized.unknown) ?? 0,
              defaultValue: '{{profit}} addresses in profit, {{loss}} at a loss. {{flat}} reported exactly zero and {{unknown}} reported no realized figure at all. Neither is binned, because an explicit zero cannot be log-binned and “we do not know” is not “no gain”.',
            })}
          </p>
        )
        : null}

      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <caption className="text-left text-[11px] text-[var(--fg-4)] pb-2">
            {t('holder_tags.cohort_caption', {
              tag: opened?.tag || '—', at: captureLabel(cohort?.capturedAt),
              defaultValue: '{{tag}}: one page of at most 50 addresses as the provider returned them at the capture of {{at}}. The cursor is not followed, so this is neither the holder base nor a ranking this platform produced.',
            })}
          </caption>
          <thead>
            <BoardTableHeader
              columns={[
                t('holder_tags.col_address', { defaultValue: 'Address' }),
                t('holder_tags.col_balance', { defaultValue: 'Balance' }),
                t('holder_tags.col_percent', { defaultValue: 'Percent (as reported)' }),
                t('holder_tags.col_buy', { defaultValue: 'Buy volume' }),
                t('holder_tags.col_sell', { defaultValue: 'Sell volume' }),
                t('holder_tags.col_realized', { defaultValue: 'Realized' }),
              ]}
              numeric={[1, 2, 3, 4, 5]}
            />
          </thead>
          <tbody>
            {wallets.map(wallet => (
              <tr key={wallet.walletAddress}>
                <th scope="row" className="text-left font-normal text-[var(--fg-2)] border-b border-[var(--border-default)] py-2 pr-3 break-all">{wallet.walletAddress}</th>
                <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{count(wallet.balance)}</td>
                <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{ratio(wallet.percent)}</td>
                <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{formatUsd(num(wallet.buyVolumeUsd))}</td>
                <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{formatUsd(num(wallet.sellVolumeUsd))}</td>
                <td className="intel-number border-b border-[var(--border-default)] py-2 pr-3">{formatUsd(num(wallet.realizedPnlUsd))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!wallets.length
        ? <p role="status">{t('holder_tags.cohort_empty', { defaultValue: 'No addresses were recorded for this tag at this capture.' })}</p>
        : null}
      </> : null}

      <p className="intel-analysis-caption">{clock} {ratioNote}</p>
    </section>
  )
}
