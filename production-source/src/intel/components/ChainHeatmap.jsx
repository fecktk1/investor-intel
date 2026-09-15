import React from 'react'
import { useTranslation } from 'react-i18next'
import { HeatStrip } from '../charts'
import { formatPct, formatUsd, pctClass } from '../lib/market-format'

// Ecosystem heat from exchange-listed assets (snake_case rows from
// exchange_latest_chain_rollups).
//
// The old card grid is gone — a bordered box per chain is not a reading — but
// none of its data is: the strip carries the 24h average, and the table below
// keeps the volume, the bullish/bearish/caution counts and the top mover that
// the cards used to show. Same export and same props, so every existing caller
// (MarketsPage, the demo section) keeps working.
export default function ChainHeatmap({ chains = [], onSelect }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  if (!chains?.length) return null
  const sorted = [...chains].sort((a, b) => (b.avg_change_24h_pct ?? -999) - (a.avg_change_24h_pct ?? -999))
  const cells = sorted.map(row => ({ t: row.chain, value: row.avg_change_24h_pct == null ? null : Number(row.avg_change_24h_pct), label: row.chain }))
  return (
    <section className="space-y-2">
      <HeatStrip
        title={t('markets.chainHeat', { defaultValue: 'Chain / ecosystem heat' })}
        description={t('markets.chainHeat_sub', { defaultValue: 'Average 24h move across the exchange-listed assets of each chain.' })}
        cells={cells}
        columns={6}
        formatValue={formatPct}
        state="ready"
        onSelect={cell => { if (cell?.t) onSelect?.(cell.t) }}
      />
      <div className="intel-table-scroll"><table>
        <caption className="sr-only">{t('markets.chainHeat', { defaultValue: 'Chain / ecosystem heat' })}</caption>
        <thead><tr>
          <th scope="col" className="text-left">{t('markets.chain_name', { defaultValue: 'Chain' })}</th>
          <th scope="col" className="intel-number">{t('markets.column_24h', { defaultValue: '24h' })}</th>
          <th scope="col" className="intel-number">{t('markets.trackedVolume', { defaultValue: 'Tracked 24h volume' })}</th>
          <th scope="col" className="intel-number">{t('markets.chain_bullish', { defaultValue: 'Bullish' })}</th>
          <th scope="col" className="intel-number">{t('markets.chain_bearish', { defaultValue: 'Bearish' })}</th>
          <th scope="col" className="intel-number">{t('markets.chain_caution', { defaultValue: 'Caution' })}</th>
          <th scope="col" className="text-left">{t('markets.topMover', { defaultValue: 'Top' })}</th>
        </tr></thead>
        <tbody>{sorted.map(c => (
          <tr key={c.chain}>
            <th scope="row" className="text-left capitalize font-medium text-[var(--fg-2)]">{c.chain}</th>
            <td className={`intel-number ${c.avg_change_24h_pct == null ? 'text-[var(--fg-4)]' : pctClass(c.avg_change_24h_pct)}`}>{formatPct(c.avg_change_24h_pct)}</td>
            <td className="intel-number">{formatUsd(c.total_volume_quote_24h)}</td>
            <td className="intel-number">{c.bullish_count ?? '—'}</td>
            <td className="intel-number">{c.bearish_count ?? '—'}</td>
            <td className="intel-number">{c.caution_count ?? '—'}</td>
            <td className="text-[var(--fg-3)]">{c.top_mover_symbol
              ? <>{c.top_mover_symbol} <span className={c.top_mover_change_pct == null ? 'text-[var(--fg-4)]' : pctClass(c.top_mover_change_pct)}>{formatPct(c.top_mover_change_pct)}</span></>
              : '—'}</td>
          </tr>
        ))}</tbody>
      </table></div>
    </section>
  )
}
