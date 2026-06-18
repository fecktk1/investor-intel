import React, { useEffect, useState, useCallback } from 'react'
import { useParams, Link, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, TrendingUp, TrendingDown, Sparkles, Activity } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { loadMarketDetail, loadTokenProfile, loadMarketCandles } from '../lib/markets-api'
import { thesisMarkersForSymbol } from '../lib/thesis-api'
import { fmtPrice, fmtPct, fmtVol, fmtNum, pctClass, bucketConfidence } from '../lib/market-format'
import MarketSignalBadge from '../components/MarketSignalBadge'
import ConfidenceChip from '../components/ConfidenceChip'
import ProviderCoveragePill from '../components/ProviderCoveragePill'
import CrossExchangeSpreadCard from '../components/CrossExchangeSpreadCard'
import OrderbookDepthCard from '../components/OrderbookDepthCard'
import MarketMemorySummary from '../components/MarketMemorySummary'
import TokenChart from '../components/TokenChart'
import ProfilePanel from '../components/ProfilePanel'
import { useArtifact } from '../lib/useArtifact'
import ArtifactView from '../components/ArtifactView'
import IntelDisclaimer from '../components/IntelDisclaimer'
import AssetThesisModule from '../components/thesis/AssetThesisModule'
import AssetYearInReview from '../components/AssetYearInReview'
import { OnchainActivityCard, EcosystemNarrativesCard, CatalystsNewsCard, UpcomingUnlocksCard } from '../components/MarketEnrichmentCards'
import { IntelHeroRead, IntelMetricCard, IntelPageShell } from '../components/IntelPrimitives'

const PROVIDER_LABELS = { binance: 'Binance', coinbase: 'Coinbase', kraken: 'Kraken', kucoin: 'KuCoin' }
const EFFECT_DOT = { bullish: 'bg-[var(--ok)]', bearish: 'bg-red-400', caution: 'bg-amber-400', neutral: 'bg-[var(--fg-5)]' }

// Exchange-asset detail — opens for ANY asset on the Markets page (not just the
// 17 native chains). Leads with the market signal and explains WHY (the
// deterministic factors), then chart, per-exchange reads, metrics, market cap,
// spread, RAG memory, and an optional analyst brief.
export default function MarketAssetPage() {
  const { symbol } = useParams()
  const sym = String(symbol || '').toUpperCase()
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase } = useSupabase()
  const location = useLocation()
  const [d, setD] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [profile, setProfile] = useState(null)
  const [profileState, setProfileState] = useState(null)
  const [thesisMarkers, setThesisMarkers] = useState([])
  const analysis = useArtifact()
  const backTo = location.state?.from || '/intel/markets'

  useEffect(() => {
    if (!org?.id || !sym) return
    let alive = true
    setLoading(true); setError(null)
    ;(async () => {
      try {
        const r = await loadMarketDetail(supabase, org.id, sym); if (!alive) return; setD(r)
        // Rich project profile from the canonical CoinGecko id (description,
        // website, socials, explorer, github, docs…). Falls back to symbol.
        const ident = r?.providerId ? { sourceProvider: r.sourceProvider || 'coingecko', providerId: r.providerId } : { symbol: sym }
        try { const pr = await loadTokenProfile(supabase, ident); if (alive && pr) { setProfile(pr.profile); setProfileState(pr.state) } } catch { /* */ }
      } catch (e) { if (alive) setError(e.message) }
      finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [org?.id, supabase, sym])

  // Per-user thesis chart markers (RLS-scoped — never shown on another user's chart).
  useEffect(() => {
    if (!org?.id || !sym) return
    let alive = true
    thesisMarkersForSymbol(supabase, org.id, sym).then((m) => { if (alive) setThesisMarkers(m) }).catch(() => {})
    return () => { alive = false }
  }, [org?.id, supabase, sym])

  const sig = d?.signal
  const explain = useCallback((force = false) => {
    if (!d) return
    const primaryChain = d.primaryChain || d.chain || null
    const assetIdentity = {
      symbol: sym,
      displayName: d.displayName || sym,
      providerId: d.providerId || null,
      sourceProvider: d.sourceProvider || null,
      primaryChain,
      chain: primaryChain,
      canonicalKey: d.sourceProvider && d.providerId ? `market:${d.sourceProvider}:${d.providerId}` : null,
    }
    const generationExtra = {
      title: `${sym} market read`,
      symbols: [sym],
      symbol: sym,
      providerId: d.providerId || null,
      sourceProvider: d.sourceProvider || null,
      primaryChain,
      canonicalKey: assetIdentity.canonicalKey,
      question: `Explain the current market read for ${sym}: why is it ${sig?.direction || 'mixed'}? Synthesize market/price action, CEX depth and spreads, DEX liquidity, on-chain or flow activity, protocol and chain context, project profile, narrative state, curated news, and social context where available. If a dimension is missing, name the specific missing data instead of giving a generic warning. Research context only - not advice.`,
    }
    const generationContext = {
      asset_identity: assetIdentity,
      exchange_market: {
        symbol: sym,
        providerId: d.providerId || null,
        sourceProvider: d.sourceProvider || null,
        primaryChain,
        signal: sig,
        providers: d.providers,
        marketCap: d.marketCap,
        spread: d.spread,
        orderbook: d.orderbook,
        dex: d.dex,
        rollups: d.rollups,
        price: d.price,
        change24h: d.change24h,
        change7d: d.change7d,
        volume24h: d.volume24h,
        profile: d.profile,
        memorySummary: d.memorySummary,
      },
      token_profile: profile ? {
        name: profile.name,
        symbol: profile.symbol,
        description: profile.description,
        categories: profile.categories,
        links: profile.links,
        sentiment: profile.sentiment,
      } : null,
    }
    analysis.generate({
      artifactType: 'explain',
      force: force === true,
      extra: generationExtra,
      context: generationContext,
    })
  }, [d, sig, sym, analysis, profile])

  if (loading && !d) return <div className="card p-10 grid place-items-center"><div className="animate-spin rounded-full h-7 w-7 border-b-2 border-[var(--accent)]" /></div>
  if (error || !d) return (
    <div className="space-y-3">
      <Link to={backTo} className="text-[12px] text-[var(--accent)] flex items-center gap-1"><ArrowLeft className="h-3.5 w-3.5" /> {t('markets.backToMarkets', { defaultValue: 'Back to Markets' })}</Link>
      <div className="card p-8 text-center text-[13px] text-[var(--fg-4)]">{t('markets.assetNotFound', { defaultValue: 'No exchange market data for this asset yet.' })}</div>
    </div>
  )

  const cap = d.marketCap
  const r1h = d.rollups?.['1h']?.price_change_pct
  const stats = [
    [t('markets.priceLabel', { defaultValue: 'Price' }), fmtPrice(d.price)],
    ['1h', fmtPct(r1h), pctClass(r1h)],
    ['24h', fmtPct(d.change24h), pctClass(d.change24h)],
    ['7d', fmtPct(d.change7d), pctClass(d.change7d)],
    [t('markets.volLabel', { defaultValue: '24h volume' }), fmtVol(d.volume24h)],
    [t('markets.marketCap', { defaultValue: 'Market cap' }), cap?.market_cap != null ? fmtVol(cap.market_cap) : t('markets.marketCapUnavailable', { defaultValue: 'N/A' })],
    ['FDV', cap?.fdv != null ? fmtVol(cap.fdv) : '—'],
    [t('markets.supply', { defaultValue: 'Circ. supply' }), cap?.circulating_supply != null ? fmtNum(cap.circulating_supply) : '—'],
  ]

  return (
    <IntelPageShell>
      <Link to={backTo} className="text-[12px] text-[var(--accent)] flex items-center gap-1"><ArrowLeft className="h-3.5 w-3.5" /> {t('markets.backToMarkets', { defaultValue: 'Back to Markets' })}</Link>

      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="eyebrow">{d.chain || t('market.source', { defaultValue: 'Exchange' })}</div>
          <div className="flex items-center gap-3">
            <h1 className="page-title">{d.displayName || sym}</h1>
            {d.price != null && (
              <div className="flex items-baseline gap-2">
                <span className="text-xl font-semibold text-[var(--fg-1)]">{fmtPrice(d.price)}</span>
                {d.change24h != null && <span className={`text-sm font-semibold flex items-center gap-0.5 ${pctClass(d.change24h)}`}>{d.change24h >= 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}{fmtPct(d.change24h)}</span>}
              </div>
            )}
          </div>
          {d.bestPair && <p className="page-sub font-mono text-[12px]">{PROVIDER_LABELS[d.bestProvider] || d.bestProvider} · {d.bestPair}</p>}
        </div>
        {sig && <MarketSignalBadge direction={sig.direction} />}
      </div>

      <IntelHeroRead
        eyebrow={t('markets.assetDossier', { defaultValue: 'Asset dossier' })}
        title={t('markets.assetDossierRead', { defaultValue: 'Start with the signal, then verify depth, exchange confirmation, narratives, catalysts, and thesis drift.' })}
        meta={(
          <>
            <span>{d.providers?.length || 0} {t('markets.exchangeFeeds', { defaultValue: 'exchange feeds' })}</span>
            <span>·</span>
            <span>{d.catalysts?.curated_news?.length || 0} {t('markets.catalystStories', { defaultValue: 'catalyst stories' })}</span>
            <span>·</span>
            <span>{sig?.confidence != null ? `${Math.round(sig.confidence)} ${t('markets.confidenceScore', { defaultValue: 'confidence' })}` : t('markets.confidencePending', { defaultValue: 'confidence pending' })}</span>
          </>
        )}
      />

      {/* Market signal + WHY (the point of this page) */}
      {sig && (
        <section className="card p-4 space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <MarketSignalBadge direction={sig.direction} />
              <span className="text-[13px] font-semibold text-[var(--fg-1)]">{sig.title || `${sym} market signal`}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-[var(--fg-5)] flex items-center gap-1"><Activity className="h-3 w-3" /> {t('market.strength', { defaultValue: 'Strength' })} {Math.round(sig.strength ?? 0)}</span>
              <span className="inline-block h-1.5 w-20 rounded-full bg-[var(--bg-3)] overflow-hidden"><span className="block h-full" style={{ width: `${Math.max(0, Math.min(100, sig.strength ?? 0))}%`, background: sig.direction === 'caution' ? 'var(--warn, #f59e0b)' : sig.direction === 'bearish' ? 'var(--err, #f87171)' : 'var(--ok)' }} /></span>
              {sig.confidence != null && <ConfidenceChip value={bucketConfidence(sig.confidence)} />}
            </div>
          </div>

          {sig.whyItMatters && <p className="text-[13px] text-[var(--fg-2)] leading-relaxed">{sig.whyItMatters}</p>}

          {/* WHY — explainable factors */}
          {sig.factors?.length > 0 && (
            <div className="space-y-1.5 pt-1">
              <div className="text-[10px] uppercase tracking-wide text-[var(--fg-5)]">{t('markets.whyThisRead', { defaultValue: 'Why this read' })}</div>
              <ul className="space-y-1">
                {sig.factors.map((f, i) => (
                  <li key={i} className="flex items-start gap-2 text-[12px] text-[var(--fg-2)]">
                    <span className={`mt-1.5 h-1.5 w-1.5 rounded-full shrink-0 ${EFFECT_DOT[f.effect] || EFFECT_DOT.neutral}`} />
                    <span>{f.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {(sig.confirmingProviders?.length > 0 || sig.conflictingProviders?.length > 0) && (
            <div className="flex items-center gap-2 flex-wrap pt-1 text-[11px] text-[var(--fg-4)]">
              {sig.confirmingProviders?.length > 0 && <span>{t('markets.confirmedBy', { defaultValue: 'Confirmed by' })}: <ProviderCoveragePill providers={sig.confirmingProviders} confirming={sig.confirmingProviders} size="sm" /></span>}
              {sig.conflictingProviders?.length > 0 && <span>{t('markets.conflict', { defaultValue: 'Conflict' })}: <ProviderCoveragePill providers={sig.conflictingProviders} size="sm" /></span>}
            </div>
          )}
        </section>
      )}

      {/* Rich, globally-cached project profile (description, links, socials, explorer, github…) */}
      <ProfilePanel profile={profile} state={profileState} />

      {/* Chart */}
      <div className="space-y-2">
        <div className="eyebrow">{t('breakdown.chart', { defaultValue: 'Price chart' })}</div>
        <TokenChart candles={d.candles} markers={thesisMarkers} showDensityToggles defaultRange="7D"
          loadCandles={(tf) => loadMarketCandles(supabase, org.id, sym, tf)} />
      </div>

      {/* Metrics */}
      <div className="grid gap-2 grid-cols-2 sm:grid-cols-4 lg:grid-cols-8">
        {stats.map(([label, val, cls], i) => (
          <IntelMetricCard key={i} label={label} value={<span className={cls || ''}>{val}</span>} />
        ))}
      </div>

      {/* Per-exchange reads */}
      {d.providers?.length > 0 && (
        <section className="space-y-2">
          <div className="eyebrow">{t('markets.byExchange', { defaultValue: 'By exchange' })}</div>
          <div className="space-y-1.5">
            {d.providers.map((p) => (
              <div key={p.provider} className="card--flat p-2.5 flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="chip text-[10px]">{PROVIDER_LABELS[p.provider] || p.provider}</span>
                  {p.direction && <MarketSignalBadge direction={p.direction} size="sm" />}
                  {p.providerSymbol && <span className="text-[10px] text-[var(--fg-5)] font-mono truncate">{p.providerSymbol}</span>}
                </div>
                <div className="flex items-center gap-4 shrink-0 text-[12px]">
                  <span className="text-[var(--fg-2)]">{fmtPrice(p.price)}</span>
                  <span className={pctClass(p.change24h)}>{fmtPct(p.change24h)}</span>
                  <span className="text-[var(--fg-4)] hidden sm:inline">{t('markets.volLabel', { defaultValue: 'Vol' })} {fmtVol(p.volume24h)}</span>
                  {p.spreadPct != null && <span className="text-[var(--fg-5)] hidden md:inline">{t('market.spread', { defaultValue: 'Spread' })} {Number(p.spreadPct).toFixed(3)}%</span>}
                  {p.orderbook?.imbalancePct != null && <span className={`hidden lg:inline ${p.orderbook.imbalancePct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{t('market.imbalance', { defaultValue: 'Imb' })} {p.orderbook.imbalancePct >= 0 ? '+' : ''}{Number(p.orderbook.imbalancePct).toFixed(0)}%</span>}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Cross-exchange spread (informational only) */}
      {d.spread && (
        <section className="space-y-2">
          <div className="eyebrow">{t('markets.spreadWatch', { defaultValue: 'Cross-Exchange Spread Watch' })}</div>
          <CrossExchangeSpreadCard spread={d.spread} />
        </section>
      )}

      <OrderbookDepthCard orderbook={d.orderbook} />

      {d.memorySummary && (
        <section className="space-y-1">
          <div className="eyebrow">{t('markets.context', { defaultValue: 'Market context' })}</div>
          <MarketMemorySummary summary={d.memorySummary} />
        </section>
      )}

      {/* Always-visible enrichment — same data that grounds the AI explanation:
          public on-chain activity, ecosystem narratives, and curated catalysts. */}
      <OnchainActivityCard onchain={d.onchain} />
      <EcosystemNarrativesCard data={d.ecosystemNarratives} />
      <CatalystsNewsCard data={d.catalysts} />
      <UpcomingUnlocksCard data={d.unlocks} />

      {/* AI deep-dive (grounded in the exchange data above) */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="eyebrow">{t('markets.aiExplain', { defaultValue: 'Analyst brief' })}</div>
          {!analysis.result && <button onClick={explain} disabled={analysis.loading} className="btn btn--primary btn--sm disabled:opacity-50">{analysis.loading ? <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-current" /> : <><Sparkles className="h-4 w-4" /> {t('markets.explainWhy', { defaultValue: 'Open brief' })}</>}</button>}
        </div>
        {analysis.result && <ArtifactView result={analysis.result} loading={analysis.loading} onRefresh={explain ? () => explain(true) : undefined} />}
      </section>

      <AssetThesisModule symbol={symbol} chain={d.chain || d.primaryChain} />

      <AssetYearInReview symbol={sym} />

      <IntelDisclaimer variant="block" />
    </IntelPageShell>
  )
}
