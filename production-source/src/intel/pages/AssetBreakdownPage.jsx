import React, { useEffect, useState, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Scale, HelpCircle, Star, RefreshCw, TrendingUp, TrendingDown, Newspaper, ExternalLink, Bell } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { getEntityByRef } from '../lib/artifact-api'
import { addEntityToWatchlist } from '../lib/watchlist-api'
import { loadTokenChart, loadWalletPortfolio } from '../lib/chart-api'
import { listEntityNews, listGlobalNews } from '../lib/news-api'
import { getChain } from '../lib/chains'
import { cleanNewsTitle } from '../lib/text-clean'
import { useArtifact } from '../lib/useArtifact'
import ArtifactView from '../components/ArtifactView'
import TokenChart from '../components/TokenChart'
import WalletHoldingsChart from '../components/WalletHoldingsChart'
import IntelActionButton from '../components/IntelActionButton'
import MarketContextCard from '../components/MarketContextCard'
import { loadMarketContextBySymbols } from '../lib/markets-api'
import IntelDisclaimer from '../components/IntelDisclaimer'

const TIMEFRAMES = ['1H', '4H', '1D', '1W']
const SENT_CLS = { bullish: 'chip--ok', bearish: 'chip--err', mixed: 'chip--info', neutral: '' }
const fmtNum = (n) => n == null ? '—' : Number(n) >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : Number(n) >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : Number(n) >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${Number(n).toFixed(0)}`
const fmtPrice = (p) => p == null ? '—' : p < 1 ? `$${Number(p).toPrecision(4)}` : `$${Number(p).toLocaleString(undefined, { maximumFractionDigits: 2 })}`

// P4 — Token intelligence page: chart + live market stats + AI breakdown +
// risk panel + news, unified for the selected token. Wallet entities show the
// wallet summary instead of a price chart.
export default function AssetBreakdownPage() {
  const { ref } = useParams()
  const decoded = decodeURIComponent(ref || '')
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase, user } = useSupabase()
  const [entity, setEntity] = useState(null)
  const [loadingEntity, setLoadingEntity] = useState(true)
  const [saved, setSaved] = useState(false)
  const [chart, setChart] = useState(null)
  const [chartLoading, setChartLoading] = useState(false)
  const [timeframe, setTimeframe] = useState('1D')
  const [news, setNews] = useState([])
  const [walletPf, setWalletPf] = useState(null)
  const [walletLoading, setWalletLoading] = useState(false)
  const [marketCtx, setMarketCtx] = useState(null)
  const breakdown = useArtifact()
  const risk = useArtifact()
  const isWallet = entity?.entity_kind === 'wallet'

  useEffect(() => {
    let alive = true
    ;(async () => {
      if (!org?.id) return
      setLoadingEntity(true)
      try {
        let e = await getEntityByRef(supabase, org.id, decoded)
        // Native chain coin (ref='native:<chain>') — chart it via CoinGecko with
        // a lightweight synthetic entity; no watchlist row required.
        if (!e && decoded.startsWith('native:')) {
          const cid = decoded.slice('native:'.length); const ch = getChain(cid)
          if (ch) e = { id: null, canonical_ref_key: decoded, entity_kind: 'asset', asset_type: 'native', display_symbol: ch.nativeSymbol, chain_namespace: ch.label, _native: true, _chain: cid }
        }
        if (alive) setEntity(e)
      } catch { /* */ } finally { if (alive) setLoadingEntity(false) }
    })()
    return () => { alive = false }
  }, [org?.id, decoded, supabase])

  const loadChart = useCallback(async (tf) => {
    if (!entity || isWallet) return
    setChartLoading(true)
    try { setChart(await loadTokenChart(supabase, org.id, { entityId: entity.id, ref: entity.canonical_ref_key, timeframe: tf })) } catch { /* */ } finally { setChartLoading(false) }
  }, [entity, isWallet, org?.id, supabase])

  const run = useCallback((force = false) => {
    if (!entity?.id) return // AI breakdown/risk need a real watchlist entity (native coins are chart+news only)
    breakdown.generate({ artifactType: isWallet ? 'wallet_summary' : 'token_breakdown', entityId: entity.id, force })
    if (!isWallet) risk.generate({ artifactType: 'risk_panel', entityId: entity.id, force })
  }, [entity, isWallet, breakdown, risk])

  useEffect(() => {
    if (!entity) return
    if (entity.id) run(false)
    if (!isWallet) {
      loadChart(timeframe)
      ;(async () => {
        try {
          const n = entity._native
            ? await listGlobalNews(supabase, { chains: [entity._chain], limit: 15, requireChain: true })
            : await listEntityNews(supabase, org.id, entity.id, entity.display_symbol)
          setNews(n)
        } catch { /* */ }
      })()
      ;(async () => { try { const m = await loadMarketContextBySymbols(supabase, [entity.display_symbol]); setMarketCtx(m[String(entity.display_symbol || '').toUpperCase()] || null) } catch { /* */ } })()
    } else {
      ;(async () => { setWalletLoading(true); try { setWalletPf(await loadWalletPortfolio(supabase, org.id, { entityId: entity.id })) } catch { /* */ } finally { setWalletLoading(false) } })()
    }
  }, [entity?.canonical_ref_key]) // eslint-disable-line

  const onSave = useCallback(async () => {
    if (!entity || !org?.id) return
    try { await addEntityToWatchlist(supabase, org.id, user?.id, entity, isWallet ? 'wallet' : 'token'); setSaved(true) } catch { /* */ }
  }, [entity, org?.id, supabase, user?.id, isWallet])

  if (loadingEntity) return <div className="card p-8 grid place-items-center"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--accent)]" /></div>
  if (!entity) return <div className="card p-8 text-center text-[var(--fg-3)] text-sm">{t('breakdown.not_found', { defaultValue: 'Asset not found in this workspace. Add it from the Watchlist first.' })}</div>

  const ov = chart?.overview
  const change = ov?.price_change_24h_pct
  const stats = [
    ['price', t('breakdown.price', { defaultValue: 'Price' }), fmtPrice(ov?.price)],
    ['mcap', t('breakdown.mcap', { defaultValue: 'Market cap' }), fmtNum(ov?.market_cap)],
    ['fdv', 'FDV', fmtNum(ov?.fdv)],
    ['liq', t('breakdown.liquidity_stat', { defaultValue: 'Liquidity' }), fmtNum(ov?.liquidity)],
    ['vol', t('breakdown.volume', { defaultValue: '24h volume' }), fmtNum(ov?.volume_24h_usd)],
    ['holders', t('breakdown.holders', { defaultValue: 'Holders' }), ov?.holders != null ? Number(ov.holders).toLocaleString() : '—'],
  ]

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="eyebrow">{entity.chain_namespace || 'asset'}</div>
          <div className="flex items-center gap-3">
            <h1 className="page-title">{entity.display_symbol || entity.asset_id}</h1>
            {!isWallet && ov?.price != null && (
              <div className="flex items-baseline gap-2">
                <span className="text-xl font-semibold text-[var(--fg-1)]">{fmtPrice(ov.price)}</span>
                {typeof change === 'number' && <span className={`text-sm font-semibold flex items-center gap-0.5 ${change >= 0 ? 'text-[var(--ok)]' : 'text-red-400'}`}>{change >= 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}{change >= 0 ? '+' : ''}{change.toFixed(1)}%</span>}
              </div>
            )}
          </div>
          <p className="page-sub font-mono text-[12px] break-all">{entity.canonical_ref_key}</p>
        </div>
        {!entity._native && (
          <div className="flex gap-2 flex-wrap">
            <IntelActionButton label={saved ? t('breakdown.saved', { defaultValue: 'Saved' }) : t('actions.add_watchlist', { defaultValue: 'Add to watchlist' })} onClick={onSave} className="btn btn--quiet btn--sm">
              <Star className="h-4 w-4" /> {saved ? t('breakdown.saved', { defaultValue: 'Saved' }) : t('actions.add_watchlist', { defaultValue: 'Add to watchlist' })}
            </IntelActionButton>
            <Link to="/intel/compare" className="btn btn--quiet btn--sm"><Scale className="h-4 w-4" /> {t('actions.compare', { defaultValue: 'Compare' })}</Link>
            <Link to={`/intel/explain?ref=${encodeURIComponent(entity.canonical_ref_key)}`} className="btn btn--quiet btn--sm"><HelpCircle className="h-4 w-4" /> {t('actions.explain', { defaultValue: 'Explain this' })}</Link>
            <Link to="/intel/alerts" className="btn btn--quiet btn--sm"><Bell className="h-4 w-4" /> {t('breakdown.alert', { defaultValue: 'Alert' })}</Link>
            <button onClick={() => run(true)} className="btn btn--ghost btn--sm"><RefreshCw className="h-4 w-4" /></button>
          </div>
        )}
      </div>

      {!isWallet && (
        <>
          {/* Market stats */}
          <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
            {stats.map(([k, label, val]) => (
              <div key={k} className="card p-3"><div className="text-[10px] text-[var(--fg-4)] uppercase">{label}</div><div className="text-sm font-semibold text-[var(--fg-1)] truncate">{val}</div></div>
            ))}
          </div>

          {marketCtx && <MarketContextCard ctx={marketCtx} variant="card" />}

          {/* Chart + timeframe */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="eyebrow">{t('breakdown.chart', { defaultValue: 'Price chart' })}</div>
              <div className="flex gap-1">
                {TIMEFRAMES.map((tf) => (
                  <button key={tf} onClick={() => { setTimeframe(tf); loadChart(tf) }} className={`btn btn--sm ${timeframe === tf ? 'btn--primary' : 'btn--ghost'}`}>{tf}</button>
                ))}
              </div>
            </div>
            <TokenChart candles={chart?.candles} loading={chartLoading} />
            {chart?.unsupported && <div className="card--flat p-2 text-[12px] text-[var(--fg-4)]">{t('breakdown.chart_unsupported', { defaultValue: 'Live market data is not available for this chain yet.' })}</div>}
          </div>
        </>
      )}

      {isWallet && (
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="eyebrow">{t('breakdown.holdings_section', { defaultValue: 'Holdings' })}</div>
            {walletPf?.portfolio?.total_usd != null && <div className="text-sm font-semibold text-[var(--fg-1)]">{fmtNum(walletPf.portfolio.total_usd)} · {walletPf.portfolio.token_count} {t('breakdown.tokens', { defaultValue: 'tokens' })}</div>}
          </div>
          <WalletHoldingsChart holdings={walletPf?.portfolio?.top_holdings} loading={walletLoading} />
          {walletPf?.unsupported && <div className="card--flat p-2 text-[12px] text-[var(--fg-4)]">{t('breakdown.wallet_unsupported', { defaultValue: 'Holdings data is not available for this chain yet.' })}</div>}
        </section>
      )}

      {entity.id ? (
        <section className="space-y-2">
          <div className="eyebrow">{isWallet ? t('breakdown.wallet_section', { defaultValue: 'Wallet summary' }) : t('breakdown.section', { defaultValue: 'Breakdown' })}</div>
          <ArtifactView result={breakdown.result} loading={breakdown.loading} />
          {breakdown.error && <div className="card--flat p-3 text-[13px] text-red-400">{breakdown.error}</div>}
        </section>
      ) : entity._native ? (
        <div className="card--flat p-3 text-[12px] text-[var(--fg-4)]">{t('breakdown.native_note', { defaultValue: 'Showing live price and news for this chain’s native coin. Add a specific token to your watchlist for a full AI breakdown and risk panel.' })}</div>
      ) : null}

      {!isWallet && entity.id && (
        <section className="space-y-2">
          <div className="eyebrow">{t('breakdown.risk_section', { defaultValue: 'Risk panel' })}</div>
          <ArtifactView result={risk.result} loading={risk.loading} />
          {risk.error && <div className="card--flat p-3 text-[13px] text-red-400">{risk.error}</div>}
        </section>
      )}

      {/* News for this token */}
      {!isWallet && (
        <section className="card p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="eyebrow flex items-center gap-1.5"><Newspaper className="h-3.5 w-3.5" /> {t('breakdown.news', { defaultValue: 'News' })}</div>
            <Link to="/intel/news" className="text-[12px] text-[var(--accent)]">{t('pulse.all', { defaultValue: 'All' })}</Link>
          </div>
          {news.length === 0 ? <p className="text-[13px] text-[var(--fg-3)]">{t('breakdown.no_news', { defaultValue: 'No news yet for this token. Add a source or fetch news.' })}</p> : (
            <div className="space-y-2">
              {news.map((n) => (
                <div key={n.id} className="flex items-start gap-2">
                  {n.curated && <span className="chip text-[9px] uppercase mt-0.5 flex-shrink-0">{t('news.curated', { defaultValue: 'Curated' })}</span>}
                  {n.sentiment && <span className={`chip ${SENT_CLS[n.sentiment] || ''} text-[9px] uppercase mt-0.5 flex-shrink-0`}>{n.sentiment}</span>}
                  <div className="min-w-0">
                    {n.url ? <a href={n.url} target="_blank" rel="noopener noreferrer" className="text-[13px] text-[var(--fg-2)] hover:text-[var(--accent)] line-clamp-1 flex items-center gap-1">{cleanNewsTitle(n.title)} <ExternalLink className="h-3 w-3 flex-shrink-0 text-[var(--fg-5)]" /></a> : <span className="text-[13px] text-[var(--fg-2)] line-clamp-1">{cleanNewsTitle(n.title)}</span>}
                    <div className="text-[11px] text-[var(--fg-4)]">{n.source_name}{n.published_at ? ` · ${new Date(n.published_at).toLocaleDateString()}` : ''}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <IntelDisclaimer variant="block" />
    </div>
  )
}
