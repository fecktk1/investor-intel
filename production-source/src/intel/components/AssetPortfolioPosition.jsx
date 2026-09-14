import React from 'react'
import RepresentationNotice from './RepresentationNotice'
import { Link, useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { fmtPct, fmtPrice, pctClass } from '../lib/market-format'

const usd = (v) => v == null ? '—' : Number(v).toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
const BASIS_OK = new Set(['known', 'estimated', 'manual_override'])

export default function AssetPortfolioPosition({ context, compact=false }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const navigate = useNavigate()
  const { holding: h, portfolio, portfolios = [], portfolioId, loading, error, canonicalAssetKey } = context
  const select = (id) => {
    context.selectPortfolio(id)
    if (context.explicitPortfolioId) navigate(`/intel/portfolio/${id}/asset/${encodeURIComponent(canonicalAssetKey)}`)
  }
  const basisOK = h && BASIS_OK.has(h.cost_basis_status)
  const facts = h ? [
    [t('portfolio.asset.quantity', { defaultValue: 'Quantity' }), h.quantity == null ? '—' : Number(h.quantity).toLocaleString(undefined, { maximumFractionDigits: 8 })],
    [t('portfolio.cols.value', { defaultValue: 'Value' }), usd(h.current_value)],
    [t('portfolio.cols.allocation', { defaultValue: 'Allocation' }), h.allocation_pct == null ? '—' : fmtPct(h.allocation_pct)],
    [t('portfolio.asset.avg_cost', { defaultValue: 'Average cost' }), basisOK && h.average_cost != null ? fmtPrice(h.average_cost) : '—'],
    [t('portfolio.cost_basis', { defaultValue: 'Cost basis' }), basisOK ? usd(h.cost_basis_usd) : '—'],
    [t('portfolio.cols.unrealized', { defaultValue: 'Unrealized P&L' }), basisOK ? `${usd(h.unrealized_pnl)}${h.unrealized_pnl != null && h.unrealized_pnl_pct != null ? ` (${fmtPct(h.unrealized_pnl_pct)})` : ''}` : '—', basisOK ? pctClass(h.unrealized_pnl) : ''],
    [t('portfolio.realized_pnl', { defaultValue: 'Realized P&L' }), basisOK ? usd(h.realized_pnl) : '—', basisOK ? pctClass(h.realized_pnl) : ''],
  ] : []
  return <section aria-label={t('portfolio.your_position', { defaultValue: 'Your position' })} className={`intel-asset-position border-y border-[var(--border-default)] ${compact?'intel-asset-position--compact py-3 space-y-2':'py-5 space-y-4'}`}>
    <div className="flex items-baseline justify-between gap-4 flex-wrap">
      <h2 className="text-lg font-medium tracking-tight text-[var(--fg-1)]">{t('portfolio.your_position', { defaultValue: 'Your position' })}</h2>
      {portfolios.length > 1 ? <label className="flex items-center gap-3 text-xs text-[var(--fg-4)]">
        {t('nav.portfolio', { defaultValue: 'Portfolio' })}
        <select aria-label={t('nav.portfolio', { defaultValue: 'Portfolio' })} className="select rounded-none text-[var(--fg-1)]" value={portfolioId || ''} onChange={(e) => select(e.target.value)}>
          {!portfolioId && <option value="">—</option>}{portfolios.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select></label> : <span className="text-xs text-[var(--fg-4)]">{portfolio?.name}</span>}
    </div>
    <RepresentationNotice canonicalAssetKey={canonicalAssetKey}/>
    {loading ? <p role="status" className="text-sm text-[var(--fg-4)]">{t('portfolio.loading_position', { defaultValue: 'Loading your position…' })}</p>
      : error || context.positionError || context.invalidPortfolio ? <div role="status" className="text-sm text-[var(--fg-3)]">{t('portfolio.position_unavailable', { defaultValue: 'Your position is unavailable.' })} <button onClick={context.refresh} className="underline underline-offset-4">{t('common.retry', { defaultValue: 'Retry' })}</button></div>
        : !h ? <p className="text-sm text-[var(--fg-4)]">{context.events?.length ? t('portfolio.position_closed', { defaultValue: 'No current holding. Your recorded activity is shown on the chart.' }) : t('portfolio.no_asset_position', { defaultValue: 'No position recorded for this asset in this portfolio.' })} <Link className="text-[var(--accent)] underline underline-offset-4" to="/intel/portfolio">{t('portfolio.open_portfolio', { defaultValue: 'Open portfolio' })}</Link></p>
          : <>
            <dl className={`flex gap-x-8 ${compact?'gap-y-2':'gap-y-5'} flex-wrap [font-variant-numeric:tabular-nums]`}>
              {facts.map(([label, value, color]) => <div key={label} className="min-w-24 flex-1"><dt className="text-xs text-[var(--fg-4)] mb-1.5">{label}</dt><dd className={`text-base font-medium whitespace-nowrap ${color || 'text-[var(--fg-1)]'}`}>{value}</dd></div>)}
            </dl>
            <div className="flex gap-x-5 gap-y-1 flex-wrap text-xs text-[var(--fg-4)]">
              {h.is_closed && <span>{t('portfolio.closed_position', { defaultValue: 'Closed position' })}</span>}
              {h.cost_basis_status === 'estimated' && <span>{t('portfolio.cost_basis_status.estimated', { defaultValue: 'Estimated cost basis' })}</span>}
              {h.cost_basis_status === 'manual_override' && <span>{t('portfolio.cost_basis_status.manual_override', { defaultValue: 'Manual cost basis' })}</span>}
              {!basisOK && <span>{t('portfolio.asset.pnl_withheld', { defaultValue: 'P&L is withheld until cost basis is known.' })}</span>}
              {h.price_status === 'unpriced' && <span>{t('portfolio.states.unpriced', { defaultValue: 'Price unavailable' })}</span>}
              {h.price_status === 'stale' && <span>{t('portfolio.states.stale', { defaultValue: 'Price stale' })}</span>}
              {h.reconciliation_status === 'wallet_only' && <span>{t('portfolio.states.wallet_only', { defaultValue: 'Wallet synced, transaction history incomplete' })}</span>}
              {['wallet_higher', 'wallet_lower'].includes(h.reconciliation_status) && <span>{h.cost_basis_status === 'estimated' ? t('portfolio.states.wallet_reconciled', { defaultValue: 'Basis reconciled to wallet balance' }) : t('portfolio.states.wallet_mismatch', { defaultValue: 'Wallet and transaction history do not match' })}</span>}
              {h.last_priced_at&&<span>{h.price_source==='coinmarketcap'?'CoinMarketCap':'Price observation'} · <time dateTime={h.last_priced_at}>{new Date(h.last_priced_at).toLocaleString(undefined,{timeZoneName:'short'})}</time></span>}
              {h.market_context?.priceBasis&&<span>{h.market_context.priceBasis}</span>}
              {h.last_synced_at && <span>{t('portfolio.last_sync', { defaultValue: 'Last sync' })} <time dateTime={h.last_synced_at}>{new Date(h.last_synced_at).toLocaleString()}</time></span>}
            </div>
          </>}
  </section>
}
