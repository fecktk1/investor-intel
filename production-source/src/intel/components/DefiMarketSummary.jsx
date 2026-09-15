import React from 'react'
import { useTranslation } from 'react-i18next'
import { formatUsd } from '../../lib/defi-intelligence'

const pct = value => value == null ? '—' : `${(Number(value) * 100).toFixed(2)}%`
export default function DefiMarketSummary({ summary, view, loading }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const lending = view === 'lending', values = loading ? null : summary
  const measures = [
    [lending ? 'stat_reserves' : 'stat_pools', lending ? 'Reserves' : 'Pools', values?.count == null ? '—' : String(values.count)],
    [lending ? 'stat_top_supply' : 'stat_top_apy', lending ? 'Top Supply APY' : 'Top APY', pct(values?.topApy)],
    [lending ? 'stat_total_supplied' : 'stat_total_tvl', lending ? 'Total Supplied' : 'Total TVL', values?.tvl == null ? '—' : formatUsd(values.tvl)],
    [lending ? 'stat_avg_util' : 'stat_twapy', lending ? 'Avg Utilization' : 'TVL-Wtd APY', pct(lending ? values?.averageUtilization : values?.weightedApy)],
  ]
  return <dl aria-label={t('defi.market_summary', { defaultValue: 'DeFi market summary' })} aria-busy={loading} className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-4 border-b border-[var(--border-default)] py-4 [font-variant-numeric:tabular-nums]">
    {measures.map(([key, label, value]) => <div key={key}><dt className="text-[11px] text-[var(--fg-4)]">{t(`defi.${key}`, { defaultValue: label })}</dt><dd className="text-lg font-semibold mt-0.5 text-[var(--fg-1)]">{value}</dd></div>)}
  </dl>
}
