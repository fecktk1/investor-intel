import React from 'react'
import { useTranslation } from 'react-i18next'
import { BarChart3 } from 'lucide-react'

// Closed-trade analytics from the intel_trade_analytics RPC (research only).
const Stat = ({ label, value, tone }) => (
  <div className="card p-3"><div className="text-[11px] text-[var(--fg-4)]">{label}</div>
    <div className={`text-lg font-semibold ${tone || 'text-[var(--fg-1)]'}`}>{value ?? '—'}</div></div>
)
const pf = (n) => n == null ? null : Number(n).toFixed(2)

export default function TradeAnalyticsPanel({ analytics, loading }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  if (loading) return <div className="card p-6 grid place-items-center"><div className="animate-spin rounded-full h-5 w-5 border-b-2 border-[var(--accent)]" /></div>
  const a = analytics || {}
  if (!a.closed_trades) return <div className="card--flat p-3 text-[12px] text-[var(--fg-4)]">{t('journal.trade.no_closed', { defaultValue: 'Close some trades to see analytics (win rate, expectancy, profit factor, R).' })}</div>
  const pnlBy = (obj) => Object.entries(obj || {}).sort((x, y) => Math.abs(y[1]) - Math.abs(x[1])).slice(0, 6)
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5"><BarChart3 className="h-3.5 w-3.5 text-[var(--accent)]" /><div className="eyebrow">{t('journal.trade.analytics', { defaultValue: 'Trade analytics' })}</div></div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label={t('journal.trade.closed', { defaultValue: 'Closed' })} value={a.closed_trades} />
        <Stat label={t('journal.trade.winrate', { defaultValue: 'Win rate' })} value={a.win_rate != null ? `${a.win_rate}%` : '—'} tone={a.win_rate >= 50 ? 'text-[var(--ok)]' : 'text-[var(--fg-1)]'} />
        <Stat label={t('journal.trade.expectancy', { defaultValue: 'Expectancy' })} value={a.expectancy != null ? `$${a.expectancy}` : '—'} tone={a.expectancy >= 0 ? 'text-[var(--ok)]' : 'text-red-400'} />
        <Stat label={t('journal.trade.profit_factor', { defaultValue: 'Profit factor' })} value={pf(a.profit_factor)} />
        <Stat label={t('journal.trade.avg_r', { defaultValue: 'Avg R' })} value={pf(a.avg_r)} />
        <Stat label={t('journal.trade.total_pnl', { defaultValue: 'Total P&L' })} value={a.total_pnl_usd != null ? `$${a.total_pnl_usd}` : '—'} tone={a.total_pnl_usd >= 0 ? 'text-[var(--ok)]' : 'text-red-400'} />
        <Stat label={t('journal.trade.without_thesis', { defaultValue: 'No-thesis trades' })} value={a.trades_without_thesis} tone={a.trades_without_thesis > 0 ? 'text-amber-300' : 'text-[var(--fg-1)]'} />
      </div>
      {Object.keys(a.pnl_by_asset || {}).length > 0 && (
        <div className="card p-3"><div className="eyebrow mb-1">{t('journal.trade.pnl_by_asset', { defaultValue: 'P&L by asset' })}</div>
          <div className="flex flex-wrap gap-1.5">{pnlBy(a.pnl_by_asset).map(([k, v]) => <span key={k} className={`chip text-[11px] ${v >= 0 ? 'chip--ok' : 'chip--err'}`}>{k} ${v}</span>)}</div></div>
      )}
      {Object.keys(a.mistakes_by_frequency || {}).length > 0 && (
        <div className="card p-3"><div className="eyebrow mb-1">{t('journal.trade.mistakes', { defaultValue: 'Mistakes by frequency' })}</div>
          <div className="flex flex-wrap gap-1.5">{pnlBy(a.mistakes_by_frequency).map(([k, v]) => <span key={k} className="chip text-[11px] text-amber-300">{k.replace(/_/g, ' ')} ×{v}</span>)}</div></div>
      )}
    </div>
  )
}
