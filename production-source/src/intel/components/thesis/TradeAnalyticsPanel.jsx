import React from 'react'
import { useTranslation } from 'react-i18next'
import { BarChart3 } from 'lucide-react'

// Closed-trade analytics from the intel_trade_analytics RPC (research only).
const Stat = ({ label, value, tone }) => (
  <div><dt className="text-[11px] text-[var(--fg-4)]">{label}</dt>
    <dd className={`font-semibold ${tone || 'text-[var(--fg-1)]'}`}>{value ?? '—'}</dd></div>
)
const pf = (n) => n == null ? null : Number(n).toFixed(2)

export default function TradeAnalyticsPanel({ analytics, loading }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  if (loading) return <p role="status">Loading journal analytics…</p>
  if(!analytics)return <p role="alert">Journal analytics could not be loaded.</p>
  const a = analytics
  if (!a.closed_trades) return <p className="intel-analysis-caption">{t('journal.trade.no_closed', { defaultValue: 'Close some trades to see analytics (win rate, expectancy, profit factor, R).' })}</p>
  const pnlBy = (obj) => Object.entries(obj || {}).sort((x, y) => Math.abs(y[1]) - Math.abs(x[1])).slice(0, 6)
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5"><BarChart3 className="h-3.5 w-3.5 text-[var(--accent)]" /><div className="eyebrow">{t('journal.trade.analytics', { defaultValue: 'Trade analytics' })}</div></div>
      <p className="intel-analysis-caption">Recorded closed journal trades. {a.priced_closed_trades!=null?`${a.priced_closed_trades} have P&L; ${a.unpriced_closed_trades} do not. The win-rate denominator includes only records with P&L.`:'P&L coverage is not reported by this legacy view.'} Portfolio accounting and thesis assessments remain separate.</p>
      <dl className="intel-thesis-facts">
        <Stat label={t('journal.trade.closed', { defaultValue: 'Closed' })} value={a.closed_trades} />
        <Stat label={t('journal.trade.winrate', { defaultValue: 'Win rate' })} value={a.win_rate != null ? `${a.win_rate}%` : '—'} tone={a.win_rate >= 50 ? 'text-[var(--ok)]' : 'text-[var(--fg-1)]'} />
        <Stat label={t('journal.trade.expectancy', { defaultValue: 'Expectancy' })} value={a.expectancy != null ? `$${a.expectancy}` : '—'} tone={a.expectancy >= 0 ? 'text-[var(--ok)]' : 'text-red-400'} />
        <Stat label={t('journal.trade.profit_factor', { defaultValue: 'Profit factor' })} value={pf(a.profit_factor)} />
        <Stat label={t('journal.trade.avg_r', { defaultValue: 'Avg R' })} value={pf(a.avg_r)} />
        <Stat label={t('journal.trade.total_pnl', { defaultValue: 'Total P&L' })} value={a.total_pnl_usd != null ? `$${a.total_pnl_usd}` : '—'} tone={a.total_pnl_usd >= 0 ? 'text-[var(--ok)]' : 'text-red-400'} />
        <Stat label={t('journal.trade.without_thesis', { defaultValue: 'No-thesis trades' })} value={a.trades_without_thesis} tone={a.trades_without_thesis > 0 ? 'text-amber-300' : 'text-[var(--fg-1)]'} />
      </dl>
      {Object.keys(a.pnl_by_asset || {}).length > 0 && (
        <section className="border-t border-[var(--border-default)] py-3"><h3>{t('journal.trade.pnl_by_asset', { defaultValue: 'P&L by asset' })}</h3>
          <dl>{pnlBy(a.pnl_by_asset).map(([k,v])=><div key={k} className="flex justify-between gap-4 text-sm"><dt className="break-all">{k}</dt><dd>{v==null?'Unpriced':`$${v}`}</dd></div>)}</dl></section>
      )}
      {Object.keys(a.mistakes_by_frequency || {}).length > 0 && (
        <section className="border-t border-[var(--border-default)] py-3"><h3>{t('journal.trade.mistakes', { defaultValue: 'Mistakes by frequency' })}</h3>
          <dl>{pnlBy(a.mistakes_by_frequency).map(([k,v])=><div key={k} className="flex justify-between gap-4 text-sm"><dt>{k.replaceAll('_',' ')}</dt><dd>{v}</dd></div>)}</dl></section>
      )}
    </div>
  )
}
