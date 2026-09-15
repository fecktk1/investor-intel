import {useContractChartEvidence} from '../lib/useContractChartEvidence'
import ContractChartEvidenceStatus from '../components/ContractChartEvidenceStatus'
import LiveTape from '../components/LiveTape'
import { useScreenParams } from '../lib/useScreenParams'
import BookCalendar from '../components/BookCalendar'
import { mergeLinkedAssetMarkers } from '../lib/chart-history'
import React, { useEffect, useState, useCallback } from 'react'
import { useParams, Link, useLocation, useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, TrendingUp, TrendingDown, Activity } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { useMarketDetailCache } from '../context/MarketDetailCache'
import { loadMarketDetail, loadMarketCandleSnapshot, loadMarkets } from '../lib/markets-api'
// PriceWorkstation.jsx stays untouched (plan rule); the k-line source name is
// mapped here, before the chart source reaches it.
import { chartProviderLabel } from '../lib/chart-source-label'
import { useTokenProfile } from '../lib/useTokenProfile'
import { marketIdentityParams,marketNativeChain } from '../lib/asset-identity'
import { useAssetThesisHistory } from '../lib/useAssetThesisHistory'
import { useLiveHistoryEnd } from '../lib/useLiveHistoryEnd'
import { intelReadError } from '../lib/read-error'
import { useAssetPortfolioContext } from '../lib/useAssetPortfolioContext'
import { useMarketPortfolioIdentity } from '../lib/useMarketPortfolioIdentity'
import {useMarketQuote} from '../lib/useMarketQuote'
import TokenAvatar from '../components/TokenAvatar'
import AssetPortfolioPosition from '../components/AssetPortfolioPosition'
import AssetNewsPanel from '../components/AssetNewsPanel'
import { fmtPrice, fmtPct, fmtVol, fmtNum, pctClass, bucketConfidence } from '../lib/market-format'
import { useDisplayCurrency } from '../lib/display-currency'
import MarketSignalBadge from '../components/MarketSignalBadge'
import ConfidenceChip from '../components/ConfidenceChip'
import ProviderCoveragePill from '../components/ProviderCoveragePill'
import CrossExchangeSpreadCard from '../components/CrossExchangeSpreadCard'
import OrderbookDepthCard from '../components/OrderbookDepthCard'
import MarketMemorySummary from '../components/MarketMemorySummary'
import TokenChart, { CHART_RANGE_MS, candleIntervals, candleIntervalLabel } from '../components/TokenChart'
import ProfilePanel from '../components/ProfilePanel'
import { useArtifact } from '../lib/useArtifact'
import AssetAnalystBrief from '../components/AssetAnalystBrief'
import AssetSectionNav from '../components/AssetSectionNav'
import AssetVenueWorkspace from '../components/DeferredAssetVenueWorkspace'
import ContractResearchWorkspace from '../components/ContractResearchWorkspace'
import IntelDisclaimer from '../components/IntelDisclaimer'
import AssetThesisModule from '../components/thesis/AssetThesisModule'
import AssetYearInReview from '../components/AssetYearInReview'
import { OnchainActivityCard, EcosystemNarrativesCard, CatalystsNewsCard, UpcomingUnlocksCard } from '../components/MarketEnrichmentCards'
import TokenRiskBadge from '../components/TokenRiskBadge'
import MarketCoverageRing from '../components/MarketCoverageRing'
import AssetProvenance from '../components/AssetProvenance'
import AssetHistoryFigure from '../components/AssetHistoryFigure'
import AssetFactsPanel from '../components/AssetFactsPanel'
import AttentionPersistence from '../components/AttentionPersistence'
import { IntelHeroRead, IntelMetricCard, IntelPageShell } from '../components/IntelPrimitives'

// `coinmarketcap_kline` is the contract k-line aggregate, not the listed-asset
// OHLCV series: it is named as such so the two are never read as one source.
const PROVIDER_LABELS = { binance: 'Binance', coinbase: 'Coinbase', kraken: 'Kraken', kucoin: 'KuCoin', coinmarketcap_kline: 'CoinMarketCap k-line' }
const EFFECT_DOT = { bullish: 'bg-[var(--ok)]', bearish: 'bg-red-400', caution: 'bg-amber-400', neutral: 'bg-[var(--fg-5)]' }

// Exchange-asset detail — opens for ANY asset on the Markets page (not just the
// 17 native chains). Leads with the market signal and explains WHY (the
// deterministic factors), then chart, per-exchange reads, metrics, market cap,
// spread, RAG memory, and an optional analyst brief.
export default function MarketAssetPage() {
  const { symbol } = useParams()
  const routeSymbol = String(symbol || '').toUpperCase()
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase, user } = useSupabase()
  // Hero money in the reader's currency. Every figure below is still stored in
  // USD; only the rendering changes. The venue rows further down stay in USD
  // for now — see docs/investor-intel/display-currency.md.
  const money = useDisplayCurrency()
  const detailCache = useMarketDetailCache()
  const location = useLocation()
  const navigate = useNavigate()
  const [detail, setD] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [retry, setRetry] = useState(0)
  const [candidates, setCandidates] = useState([])
  const query = new URLSearchParams(location.search)
  const providerId = query.get('id'), sourceProvider = query.get('provider')
  const identity = providerId && sourceProvider ? { sourceProvider, providerId } : {}
  const detailScope = JSON.stringify([user?.id, org?.id, routeSymbol, sourceProvider, providerId])
  const initialDetail = detail?.scope === detailScope ? detail.data : null
  const projectProfile = useTokenProfile({supabase,orgId:org?.id,userId:user?.id,ident:initialDetail?.providerId?{sourceProvider:initialDetail.sourceProvider,providerId:String(initialDetail.providerId)}:null})
  const { profile } = projectProfile
  const liveQuote=useMarketQuote({supabase,orgId:org?.id,userId:user?.id,detail:initialDetail})
  const d=initialDetail?{...initialDetail,...liveQuote.quote,chain:marketNativeChain(initialDetail.sourceProvider,initialDetail.providerId)||initialDetail.chain}:null
  const [chartOptions,setChartOptions]=useScreenParams('chart_', {range:'7D',interval:'auto'})
  // Sub-hour widths exist only for a contract identity; a saved '5M' on any other
  // asset falls back to automatic rather than being sent and refused.
  const candleIntervalChoices=candleIntervals(d?.sourceProvider)
  const candleInterval=candleIntervalChoices.includes(chartOptions.interval)?chartOptions.interval:'auto'
  const setCandleInterval=interval=>setChartOptions(previous=>({...previous,interval}))
  const sym = String(d?.symbol || routeSymbol).toUpperCase()
  const marketKey = d?.sourceProvider && d?.providerId != null ? `market:${d.sourceProvider}:${d.providerId}` : null
  const network = useMarketPortfolioIdentity({ identityChoices: d?.identityChoices, defaultKey: d?.canonicalAssetKey, marketKey, explicitKey: query.get('network') })
  const historyTo = useLiveHistoryEnd(org?.id)
  const historyRange=Object.hasOwn(CHART_RANGE_MS,chartOptions.range)?chartOptions.range:'7D'
  const setHistoryRange=range=>setChartOptions(previous=>({...previous,range}))
  // A market-only asset has a valid research workspace. A network match that is
  // still pending or failed does not: do not open temporary private workspaces.
  const canonicalKey = network.canonicalAssetKey || (!network.choices.length && !network.invalidExplicit ? marketKey : null)
  const chartPending = !canonicalKey && network.loading
  const selectedNetwork=network.choices.find(choice=>choice.canonicalAssetKey===canonicalKey)
  const riskAddress=canonicalKey?.startsWith('eip155:')&&/^0x[0-9a-f]{40}$/i.test(canonicalKey.split(':')[2]||'')?canonicalKey.split(':')[2]:canonicalKey?.startsWith('solana:')&&!canonicalKey.includes(':native:')?canonicalKey.slice(7):null
  const historyFrom = historyTo - CHART_RANGE_MS[historyRange]
  const position = useAssetPortfolioContext({ canonicalAssetKey: network.canonicalAssetKey, from: historyFrom, to: historyTo })
  const research = useAssetThesisHistory({ canonicalKey, from: historyFrom, to: historyTo })
  const publicEvidence=useContractChartEvidence({canonicalKey,from:historyFrom,to:historyTo,portfolioId:position.portfolioId})
  // The live lane. Its own marker kind and layer, so a streamed event is never
  // merged into the retained public history it sits beside.
  const [tapeMarkers,setTapeMarkers]=useState([])
  const analysis = useArtifact(`${detailScope}:${canonicalKey || ''}`)
  const backTo = typeof location.state?.from === 'string' && /^\/intel(?:[/?]|$)/.test(location.state.from) ? location.state.from : '/intel/markets'

  useEffect(() => {
    if (!org?.id || !routeSymbol) return
    let alive = true
    setLoading(true); setError(null); setD(null); setCandidates([])
    ;(async () => {
      try {
        const load = () => loadMarketDetail(supabase, org.id, routeSymbol, identity)
        const r = await (detailCache ? detailCache.read(identity, load, { force: retry > 0 }) : load()); if (!alive) return; setD({ scope: detailScope, data: r }); setLoading(false)
      } catch (e) { if (alive) setError(e.message); if (alive && e.code === 'ambiguous_asset') { const matches = await loadMarkets(supabase, org.id, { search: routeSymbol, limit: 50 }).catch(() => null); if (alive) setCandidates((matches?.rows || []).filter(row => String(row.symbol).toUpperCase() === routeSymbol)) } }
      finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [org?.id, user?.id, supabase, routeSymbol, sourceProvider, providerId, detailScope, retry, detailCache])

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
      canonicalKey,
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
  }, [d, sig, sym, analysis, profile, canonicalKey])

  if (loading && !d) return <p role="status" className="py-10 text-sm text-[var(--fg-4)]">{t('asset.loading', { defaultValue: 'Loading asset observations…' })}</p>
  if (error || !d) return (
    <div className="space-y-3">
      <Link to={backTo} className="text-[12px] text-[var(--accent)] flex items-center gap-1"><ArrowLeft className="h-3.5 w-3.5" /> {t('markets.backToMarkets', { defaultValue: 'Back to Markets' })}</Link>
      {(!error || candidates.length > 0) && <p className="py-8 text-sm text-[var(--fg-4)]">{candidates.length ? t('markets.choose_identity', { defaultValue: 'This symbol identifies more than one asset. Choose the asset you want to investigate.' }) : t('markets.assetNotFound', { defaultValue: 'No exchange market data for this asset yet.' })}</p>}
      {error && !candidates.length && <p role="alert">{t('asset.read_failed', { defaultValue: 'The asset read could not be completed.' })} <button className="underline" onClick={() => setRetry(value => value + 1)}>{t('common.retry', { defaultValue: 'Retry' })}</button></p>}
      {candidates.map(row => <Link className="block border-b border-[var(--border-default)] py-4" key={`${row.sourceProvider}:${row.providerId}`} to={`/intel/markets/${encodeURIComponent(row.symbol)}${marketIdentityParams(row)}`}>{row.displayName || row.symbol} · {row.chain || row.sourceProvider} · {row.providerId}</Link>)}
    </div>
  )

  const cap = d.marketCap
  const r1h = d.rollups?.['1h']?.price_change_pct
  const stats = [
    [t('markets.priceLabel', { defaultValue: 'Price' }), money.formatMoneyPrice(d.price)],
    ['1h', fmtPct(r1h), pctClass(r1h)],
    ['24h', fmtPct(d.change24h), pctClass(d.change24h)],
    ['7d', fmtPct(d.change7d), pctClass(d.change7d)],
    [t('markets.volLabel', { defaultValue: '24h volume' }), money.formatMoney(d.volume24h)],
    [t('markets.marketCap', { defaultValue: 'Market cap' }), cap?.market_cap != null ? money.formatMoney(cap.market_cap) : t('markets.marketCapUnavailable', { defaultValue: 'N/A' })],
    ['FDV', cap?.fdv != null ? money.formatMoney(cap.fdv) : '—'],
    [t('markets.supply', { defaultValue: 'Circ. supply' }), cap?.circulating_supply != null ? fmtNum(cap.circulating_supply) : '—'],
  ]

  return (
    <IntelPageShell className="intel-asset-desk">
      <Link to={backTo} className="text-[12px] text-[var(--accent)] flex items-center gap-1"><ArrowLeft className="h-3.5 w-3.5" /> {t('markets.backToMarkets', { defaultValue: 'Back to Markets' })}</Link>

      {/* Header */}
      <div className="intel-dossier-heading">
        <div>
          <div className="eyebrow">{d.chain || t('market.source', { defaultValue: 'Exchange' })}</div>
          <div className="flex items-center gap-3 flex-wrap">
            <TokenAvatar src={d.imageUrl||profile?.image_url} symbol={sym} name={d.displayName} size="lg"/>
            <h1 className="page-title">{d.displayName || sym}</h1>
            {marketKey && <Link className="intel-text-link text-sm" to={`/intel/investigate?${new URLSearchParams({asset:marketKey,...(network.canonicalAssetKey?{network:network.canonicalAssetKey}:{})})}`}>{t('investigation.open',{defaultValue:'Open connected research'})}</Link>}
            {d.price != null && (
              <div className="flex items-baseline gap-2">
                <span className="text-xl font-semibold text-[var(--fg-1)]">{money.formatMoneyPrice(d.price)}</span>
                {d.change24h != null && <span className={`text-sm font-semibold flex items-center gap-0.5 ${pctClass(d.change24h)}`}>{d.change24h >= 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}{fmtPct(d.change24h)}</span>}
                {sig && <MarketSignalBadge direction={sig.direction} />}
              </div>
            )}
            {riskAddress&&selectedNetwork?.chain&&<TokenRiskBadge key={canonicalKey} symbol={sym} chain={selectedNetwork.chain} address={riskAddress} />}
          </div>
          {d.bestPair && <p className="page-sub font-mono text-[12px]">{PROVIDER_LABELS[d.bestProvider] || d.bestProvider} · {d.bestPair}</p>}
          {d.quoteProvider&&<p className="intel-event-meta">{d.quoteProvider==='coinmarketcap'?'CoinMarketCap':d.quoteProvider==='coingecko'?'CoinGecko':d.quoteProvider} · {d.asOf&&<time dateTime={d.asOf}>{new Date(d.asOf).toLocaleTimeString()}</time>}{d.quoteRefreshSeconds?` · Quotes checked every ${d.quoteRefreshSeconds===60?'minute':'5 minutes'}`:''}{d.sourceFreshness&&d.sourceFreshness!=='fresh'?` · ${d.sourceFreshness}`:''}</p>}
          {liveQuote.error&&<p role="status" className="intel-event-meta">{liveQuote.error}</p>}
          {/* Money above is converted from the stored USD at display time. When
              the reader asked for a currency the hourly capture cannot supply,
              the figures stay in dollars and say so rather than misprice. */}
          {money.fallback
            ? <p className="intel-event-meta" data-display-currency={money.currency}>{t('markets.currency_fallback', { currency: money.currency, defaultValue: 'Rates unavailable — money figures shown in USD.' })}</p>
            : money.currency !== 'USD' && <p className="intel-event-meta" data-display-currency={money.currency}>{t('markets.currency_note', { currency: money.currency, defaultValue: 'Money figures in {{currency}}, converted from USD at display time.' })}</p>}
        </div>
        {sig && d.price == null && <MarketSignalBadge direction={sig.direction} />}
      </div>

      {/* What this identity can feed, and why the rest cannot. Detail payloads
          from before universal resolution carry no coverage: render nothing. */}
      {d.coverage && <MarketCoverageRing coverage={d.coverage} identity={d.identity} />}

      {/* How the platform knows what this asset IS — every rung of the resolver
          ladder, with its timing. It reads nothing unless this page's identity
          is a contract or a CoinMarketCap id, because a resolution is a paid
          question and an exchange market is not one it can be asked. */}
      <AssetProvenance sourceProvider={d.sourceProvider} providerId={d.providerId} canonicalKey={canonicalKey} />

      {/* Price history is read on request only — one range is one provider
          sampling charged against the shared budget — so this figure fetches
          nothing until the reader chooses a range. The facts panel below it
          reads rows the daily passes already wrote and costs nothing. */}
      <AssetHistoryFigure sourceProvider={d.sourceProvider} providerId={d.providerId} symbol={sym} />
      <AssetFactsPanel sourceProvider={d.sourceProvider} providerId={d.providerId} symbol={sym} />
      <AttentionPersistence sourceProvider={d.sourceProvider} providerId={d.providerId} symbol={sym} />

      <AssetSectionNav sections={[
        { id: 'asset-chart', key: 'asset.chart_position', label: 'Chart & position' },
        { id: 'asset-research', key: 'asset.context', label: 'Market context' },
        { id: 'asset-venue-evidence', key: 'asset.venueEvidence', label: 'Venues & positioning' },
        ...(d.providers?.length ? [{ id: 'asset-exchanges', key: 'asset.venues', label: 'Venues' }] : []),
        { id: 'asset-news', key: 'asset.news', label: 'News' },
        { id: 'asset-brief', key: 'asset.research', label: 'Research' },
        { id: 'asset-theses', key: 'asset.theses', label: 'Your theses' },
      ]}/>
      <section id="asset-chart" aria-label={t('asset.workspace', { defaultValue: 'Price, position and research' })}>
        {network.choices.length > 0 && <div className="flex items-start justify-between gap-4 flex-wrap border-t border-[var(--border-default)] py-4">
          <label className="flex items-center gap-3 text-xs text-[var(--fg-4)]">
            {t('asset.position_network', { defaultValue: 'Position network' })}
            <select aria-label={t('asset.position_network', { defaultValue: 'Position network' })} className="select rounded-none max-w-full text-[var(--fg-1)]" value={network.canonicalAssetKey || ''} onChange={event => {
              if (!network.selectNetwork(event.target.value)) return
              const next = new URLSearchParams(location.search); next.set('network', event.target.value)
              navigate({ pathname: location.pathname, search: `?${next}` }, { replace: true, state: location.state })
            }}>
              {!network.canonicalAssetKey && <option value="">{network.loading ? 'Matching your portfolio…' : 'Choose network'}</option>}
              {network.choices.map(choice => <option key={choice.canonicalAssetKey} value={choice.canonicalAssetKey}>{choice.label || choice.chain} · {choice.canonicalAssetKey}</option>)}
            </select>
          </label>
          <p className="text-xs text-[var(--fg-4)] max-w-lg">{t('asset.network_scope', { defaultValue: 'Position and research markers follow this network. The price chart shows the asset’s market-wide price.' })}</p>
          {network.invalidExplicit && <p role="status" className="text-sm text-[var(--fg-4)]">{t('asset.invalid_network', { defaultValue: 'This network is not a verified representation of this asset. Choose a listed network.' })}</p>}
          {network.error && <p role="status" className="text-sm text-[var(--fg-4)]">{t('asset.network_unavailable', { defaultValue: 'Your portfolio network match is unavailable.' })} <button onClick={network.retry} className="underline underline-offset-4">{t('common.retry', { defaultValue: 'Retry' })}</button></p>}
        </div>}
        {chartPending ? <div role="status" className="min-h-[420px] flex items-center justify-center text-sm text-[var(--fg-4)]">{t('asset.matching_chart_network', { defaultValue: 'Matching your portfolio network…' })}</div> : <TokenChart key={`${user?.id}:${org?.id}:${canonicalKey || marketKey}:${position.portfolioId}`} assetKey={`${user?.id}:${org?.id}:${canonicalKey || marketKey}:${position.portfolioId}`} candles={d.candles} persistence={canonicalKey ? {supabase,userId:user?.id,orgId:org?.id,asset:canonicalKey} : null} readOnly={!canonicalKey}
          requestKey={candleInterval}
          rangeExtra={<label className="intel-event-meta">Candle interval <select aria-label="Candle interval" value={candleInterval} onChange={e=>setCandleInterval(e.target.value)}>{candleIntervalChoices.map(choice=><option key={choice} value={choice}>{candleIntervalLabel(choice,d.sourceProvider)}</option>)}</select>{d.sourceProvider==='contract'&&<span> Sub-hour candles come only from the CoinMarketCap k-line aggregate for this contract.</span>}</label>}
          markers={[...mergeLinkedAssetMarkers(position.markers, research.markers),...publicEvidence.markers,...tapeMarkers]} timeWindow={{ from: historyFrom, to: historyTo }} showDensityToggles defaultRange={historyRange} onRangeChange={setHistoryRange}
          historyLoading={research.loading || position.loading || research.loadingMore || position.loadingMore}
          historyError={research.error || (position.error && intelReadError(position.error, 'Your portfolio activity is temporarily unavailable. Please retry from Your position.'))} historyHasMore={!!(research.nextCursor || position.nextCursor)}
          onLoadMoreHistory={() => { if (research.nextCursor) research.loadMore(); if (position.nextCursor) position.loadMore() }}
          priceCoverage={{ chartSource:d.chartSource&&d.chartSource.provider==='coinmarketcap_kline'?{...d.chartSource,provider:chartProviderLabel(d.chartSource.provider)}:d.chartSource,capture:d.captureProof?{proof:d.captureProof,bars:d.candles}:null, coverage: d.chartCoverage, state: d.chartState, provenance: d.chartProvenance }}
          loadCandles={tf => loadMarketCandleSnapshot(supabase, org.id, sym, tf, { sourceProvider: d.sourceProvider, providerId: d.providerId,interval:candleInterval })} />}
        {network.choices.length ? <AssetPortfolioPosition context={{ ...position, loading: position.loading || network.loading, error: position.error || network.error, invalidPortfolio: position.invalidPortfolio || network.invalidExplicit, refresh: network.error ? network.retry : position.refresh }}/> : <p className="intel-event-meta py-4">{t('asset.position_identity_required', { defaultValue: 'A verified network identity is not available for this market asset yet. Your market research remains available below.' })}</p>}
      </section>

      <div id="asset-research"><IntelHeroRead
        eyebrow={t('markets.assetDossier', { defaultValue: 'Asset dossier' })}
        title={t('asset.research_heading', { defaultValue: 'Market context' })}
        meta={(
          <>
            <span>{d.providers?.length || 0} {t('markets.exchangeFeeds', { defaultValue: 'exchange feeds' })}</span>
            <span>·</span>
            <span>{d.catalysts?.status === 'error' ? t('markets.catalystUnavailable', { defaultValue: 'Catalyst coverage unavailable' }) : <>{d.catalysts?.curated_news?.length ?? 0} {t('markets.catalystStories', { defaultValue: 'catalyst stories' })}{d.catalysts?.status === 'partial' ? ` · ${t('common.partial', { defaultValue: 'partial' })}` : ''}</>}</span>
            <span>·</span>
            <span>{sig?.confidence != null ? `${Math.round(sig.confidence)} ${t('markets.confidenceScore', { defaultValue: 'confidence' })}` : t('markets.confidencePending', { defaultValue: 'confidence pending' })}</span>
          </>
        )}
      /></div>

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
            <details className="intel-evidence-expand space-y-1.5 pt-1">
              <summary>{t('markets.whyThisRead', { defaultValue: 'Why this read' })} · {sig.factors.length}</summary>
              <ul className="space-y-1">
                {sig.factors.map((f, i) => (
                  <li key={i} className="flex items-start gap-2 text-[12px] text-[var(--fg-2)]">
                    <span className={`mt-1.5 h-1.5 w-1.5 rounded-full shrink-0 ${EFFECT_DOT[f.effect] || EFFECT_DOT.neutral}`} />
                    <span>{f.detail}</span>
                  </li>
                ))}
              </ul>
            </details>
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
      <ProfilePanel {...projectProfile} />



      {/* Metrics */}
      <div className="grid gap-2 grid-cols-2 sm:grid-cols-4 lg:grid-cols-8">
        {stats.map(([label, val, cls], i) => (
          <IntelMetricCard key={i} label={label} value={<span className={cls || ''}>{val}</span>} />
        ))}
      </div>

      {/* Per-exchange reads */}
      {d.providers?.length > 0 && (
        <section id="asset-exchanges" className="space-y-2">
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
      {canonicalKey&&<AssetVenueWorkspace canonicalKey={canonicalKey}/>}
      <><ContractChartEvidenceStatus evidence={publicEvidence}/><LiveTape canonicalKey={canonicalKey} onMarkers={setTapeMarkers}/><ContractResearchWorkspace canonicalKey={canonicalKey} onEvidence={publicEvidence.acceptEvidence}/></>

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
      <AssetNewsPanel identity={{ key: marketKey || `asset:${d.displayName}:${d.chain}`, name: d.displayName, symbol: sym, chain: d.primaryChain || d.chain, native: /:native(?::|$)/.test(d.canonicalAssetKey || '') }} />
      {d.catalysts?.status === 'available' && <details className="py-3 text-sm"><summary className="cursor-pointer text-[var(--fg-4)]">{t('asset_news.earlier', { defaultValue: 'Earlier coverage & notable events' })}</summary><CatalystsNewsCard data={d.catalysts} historical /></details>}
      <UpcomingUnlocksCard data={d.unlocks} />
      {canonicalKey && <BookCalendar key={canonicalKey} asset={canonicalKey} chartLane/>}

      {/* AI deep-dive (grounded in the exchange data above) */}
      <section id="asset-brief">{canonicalKey && <AssetAnalystBrief analysis={analysis} onOpen={explain} />}</section>

      <section id="asset-theses">{canonicalKey && <AssetThesisModule symbol={sym} chain={network.choices.find(choice => choice.canonicalAssetKey === network.canonicalAssetKey)?.chain || d.chain || d.primaryChain} canonicalAssetKey={canonicalKey} sourceProvider={d.sourceProvider} providerId={d.providerId} />}</section>

      <AssetYearInReview symbol={sym} />

      <IntelDisclaimer variant="block" />
    </IntelPageShell>
  )
}
