import React, { useEffect, useState, useMemo } from 'react'
import { useParams, Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ExternalLink } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { explorerTxUrl } from '../lib/chains'
import { fmtPrice, fmtPct, pctClass, timeAgo } from '../lib/market-format'
import MarketSignalBadge from '../components/MarketSignalBadge'
import IntelDisclaimer from '../components/IntelDisclaimer'
import AssetThesisModule from '../components/thesis/AssetThesisModule'
import * as api from '../lib/portfolio-api'

const usd = (v) => v == null ? '—' : `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
const fmtAmt = (n) => n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 8 })
// P&L is trustworthy only when cost basis is actually known (or manually set).
const PNL_OK = new Set(['known', 'estimated', 'manual_override'])

function TokenLogo({ url, symbol }) {
  const [err, setErr] = useState(false)
  if (url && !err) return <img src={url} alt={symbol || ''} className="h-8 w-8 rounded-full bg-[var(--bg-3)] object-cover" onError={() => setErr(true)} />
  return <div className="h-8 w-8 rounded-full bg-[var(--bg-3)] grid place-items-center text-[11px] text-[var(--fg-4)]">{(symbol || '?').slice(0, 3)}</div>
}

function typeLabel(type, t) { return t(`portfolio.txn_type.${type}`, { defaultValue: String(type || 'unknown').replace(/_/g, ' ') }) }

// Read-only per-asset position view: YOUR holdings, value, cost basis, P&L and
// the transaction history for this one asset. Reached by clicking a holding.
// DB-first — reads only stored portfolio tables, never a provider.
export default function PortfolioAssetPage() {
  const { portfolioId, assetKey } = useParams()
  // Defensive decode: a no-op if the router already decoded (canonical keys have
  // no '%'), correct if it didn't. Keys look like solana:native:SOL / eip155:1:0x…
  const key = useMemo(() => { try { return decodeURIComponent(assetKey || '') } catch { return assetKey || '' } }, [assetKey])
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase } = useSupabase()
  const [holding, setHolding] = useState(null)
  const [activity, setActivity] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!org?.id || !portfolioId || !key) return
    let alive = true
    setLoading(true); setError(null)
    ;(async () => {
      try {
        const [{ holdings }, acts] = await Promise.all([
          api.getPortfolio(supabase, org.id, portfolioId),
          api.listActivity(supabase, org.id, portfolioId, { limit: 500 }),
        ])
        if (!alive) return
        setHolding((holdings || []).find((x) => x.canonical_asset_key === key) || null)
        setActivity((acts || []).filter((it) => (it.lineItems || []).some((li) => li.canonical_asset_key === key)))
      } catch (e) { if (alive) setError(e.message) }
      finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [org?.id, supabase, portfolioId, key])

  // Identity falls back to a transaction leg if the position was fully sold.
  const meta = useMemo(() => {
    const li = activity.flatMap((it) => it.lineItems || []).find((l) => l.canonical_asset_key === key)
    return {
      symbol: (holding?.asset_symbol || holding?.normalized_symbol || li?.symbol || '').toUpperCase(),
      name: holding?.name || li?.name || null,
      logo: holding?.logo_url || li?.logo_url || null,
      chain: holding?.chain || li?.chain || null,
    }
  }, [holding, activity, key])

  const sig = holding?.market_context?.signalDirection
  const pnlOk = holding && PNL_OK.has(holding.cost_basis_status) && holding.unrealized_pnl != null
  const realizedOk = holding && PNL_OK.has(holding.cost_basis_status) && holding.realized_pnl != null
  const inMarkets = holding && holding.price_status !== 'unpriced' && meta.symbol

  const back = (
    <Link to="/intel/portfolio" className="text-[12px] text-[var(--accent)] inline-flex items-center gap-1">
      <ArrowLeft className="h-3.5 w-3.5" /> {t('portfolio.back_to_portfolio', { defaultValue: 'Back to portfolio' })}
    </Link>
  )

  if (loading) return <div className="card p-10 grid place-items-center"><div className="animate-spin rounded-full h-7 w-7 border-b-2 border-[var(--accent)]" /></div>
  if (error) return <div className="space-y-3">{back}<div className="card--flat p-3 text-[13px] text-red-400">{error}</div></div>
  if (!holding && !activity.length) return <div className="space-y-3">{back}<div className="card p-8 text-center text-[13px] text-[var(--fg-4)]">{t('portfolio.asset_not_found', { defaultValue: 'This asset is no longer in your portfolio.' })}</div></div>

  const stats = [
    [t('portfolio.cols.value', { defaultValue: 'Value' }), holding?.current_value == null ? '—' : usd(holding.current_value), ''],
    [t('portfolio.asset.quantity', { defaultValue: 'Quantity' }), fmtAmt(holding?.quantity), ''],
    [t('portfolio.cols.price', { defaultValue: 'Price' }), holding?.current_price == null ? '—' : fmtPrice(holding.current_price), ''],
    [t('portfolio.cols.change_24h', { defaultValue: '24h' }), fmtPct(holding?.day_pnl_pct), pctClass(holding?.day_pnl_pct)],
    [t('portfolio.cols.allocation', { defaultValue: 'Alloc' }), holding?.allocation_pct == null ? '—' : `${holding.allocation_pct.toFixed(1)}%`, ''],
    [t('portfolio.asset.avg_cost', { defaultValue: 'Avg cost' }), pnlOk && holding?.average_cost != null ? fmtPrice(holding.average_cost) : '—', ''],
    [t('portfolio.cost_basis', { defaultValue: 'Cost basis' }), pnlOk ? usd(holding?.cost_basis_usd) : '—', ''],
    [t('portfolio.cols.unrealized', { defaultValue: 'Unreal. P&L' }), pnlOk ? `${usd(holding.unrealized_pnl)}${holding.unrealized_pnl_pct != null ? ` (${fmtPct(holding.unrealized_pnl_pct)})` : ''}` : '—', pnlOk ? pctClass(holding.unrealized_pnl) : ''],
    [t('portfolio.realized_pnl', { defaultValue: 'Realized P&L' }), realizedOk ? usd(holding.realized_pnl) : '—', realizedOk ? pctClass(holding.realized_pnl) : ''],
  ]
  const mc = holding?.market_context || {}

  return (
    <div className="space-y-4">
      {back}

      <div className="card p-4 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <TokenLogo url={meta.logo} symbol={meta.symbol} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-[20px] font-semibold text-[var(--fg-1)] truncate">{meta.symbol || t('portfolio.asset.unknown', { defaultValue: 'Unknown asset' })}</h1>
              {meta.chain && <span className="chip text-[10px] text-[var(--fg-4)]">{meta.chain}</span>}
              {sig && <MarketSignalBadge direction={sig} size="sm" />}
            </div>
            {meta.name && <div className="text-[12px] text-[var(--fg-4)] truncate">{meta.name}</div>}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[18px] font-semibold text-[var(--fg-1)]">{holding?.current_price == null ? '—' : fmtPrice(holding.current_price)}</div>
          <div className={`text-[12px] ${pctClass(holding?.day_pnl_pct)}`}>{fmtPct(holding?.day_pnl_pct)}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {stats.map(([label, val, cls]) => (
          <div key={label} className="card p-3">
            <div className="text-[10px] uppercase text-[var(--fg-5)]">{label}</div>
            <div className={`text-[16px] font-semibold mt-1 ${cls}`}>{val}</div>
          </div>
        ))}
      </div>

      {!pnlOk && !realizedOk && (
        <div className="card--flat p-2.5 text-[12px] text-[var(--fg-4)]">
          {t('portfolio.asset.pnl_withheld', { defaultValue: 'P&L is withheld until cost basis is known — value and allocation are shown from the current price.' })}
        </div>
      )}

      {(mc.marketCap != null || mc.liquidity != null) && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {mc.marketCap != null && <div className="card p-3"><div className="text-[10px] uppercase text-[var(--fg-5)]">{t('portfolio.asset.market_cap', { defaultValue: 'Market cap' })}</div><div className="text-[14px] mt-1 text-[var(--fg-1)]">{usd(mc.marketCap)}</div></div>}
          {mc.liquidity != null && <div className="card p-3"><div className="text-[10px] uppercase text-[var(--fg-5)]">{t('portfolio.asset.liquidity', { defaultValue: 'Liquidity' })}</div><div className="text-[14px] mt-1 text-[var(--fg-1)]">{usd(mc.liquidity)}</div></div>}
        </div>
      )}

      {inMarkets && (
        <Link to={`/intel/markets/${encodeURIComponent(meta.symbol)}`} className="btn btn--ghost btn--sm inline-flex">
          {t('portfolio.asset.open_market', { defaultValue: 'Open full market data' })} <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      )}

      {/* Why I own this — the thesis behind the position (or an entry point to create one) */}
      {meta.symbol && <AssetThesisModule symbol={meta.symbol} chain={holding?.chain} />}

      <section className="space-y-2">
        <span className="eyebrow">{t('portfolio.asset.history', { defaultValue: 'Transaction history' })}</span>
        {!activity.length ? (
          <div className="card p-6 text-center text-[13px] text-[var(--fg-4)]">{t('portfolio.asset.no_history', { defaultValue: 'No transactions recorded for this asset yet.' })}</div>
        ) : (
          <div className="space-y-1.5">
            {activity.map((it) => {
              const leg = (it.lineItems || []).find((l) => l.canonical_asset_key === key)
              const exp = it.txRef && it.chain ? explorerTxUrl(it.chain, it.txRef) : null
              const out = leg?.direction === 'out'
              return (
                <div key={`${it.kind}:${it.id}`} className="card--flat p-2.5 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] text-[var(--fg-1)] flex items-center gap-2 truncate">
                      <span className="chip text-[9px] uppercase">{typeLabel(it.type, t)}</span>
                      <span className="truncate">{it.title || typeLabel(it.type, t)}</span>
                      {it.isManual && <span className="chip text-[9px] text-[var(--fg-5)]">{t('portfolio.manual', { defaultValue: 'manual' })}</span>}
                    </div>
                    <div className="text-[11px] text-[var(--fg-5)] mt-0.5 flex items-center gap-2">
                      {it.timestamp ? timeAgo(it.timestamp) : ''}
                      {exp && <a href={exp} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-0.5 hover:text-[var(--accent)]">{t('portfolio.tx.view_explorer', { defaultValue: 'Explorer' })} <ExternalLink className="h-3 w-3" /></a>}
                    </div>
                    {(it.feeAmount != null || it.feeUsd != null) && (
                      <div className="text-[10px] text-[var(--fg-5)] mt-0.5">
                        {t('portfolio.tx.fee', { defaultValue: 'Fee' })}{' '}
                        {it.feeAmount != null ? `${fmtAmt(it.feeAmount)}${it.feeAsset ? ` ${it.feeAsset}` : ''}` : ''}
                        {it.feeAmount != null && it.feeUsd != null ? ' · ' : ''}
                        {it.feeUsd != null ? usd(Number(it.feeUsd)) : ''}
                      </div>
                    )}
                  </div>
                  <div className="text-right flex-shrink-0">
                    {leg?.amount != null && <div className={`text-[12px] ${out ? 'text-red-400' : 'text-[var(--ok)]'}`}>{out ? '-' : '+'}{fmtAmt(leg.amount)}</div>}
                    {leg?.value_usd_at_tx != null && <div className="text-[11px] text-[var(--fg-4)]">{usd(leg.value_usd_at_tx)}</div>}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      <IntelDisclaimer />
    </div>
  )
}
