import {useContractChartEvidence} from '../lib/useContractChartEvidence'
import { useScreenParams } from '../lib/useScreenParams'
import { mergeLinkedAssetMarkers } from '../lib/chart-history'
import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useChartWorkingState, workingCandleInterval, workingInitialState, workingRangePreset } from '../lib/chart-working-state'
import { useParams, Link, useLocation, useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, TrendingUp, TrendingDown, Activity } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { useMarketDetailCache } from '../context/MarketDetailCache'
import { DETAIL_CANDLE_RANGE, loadMarketDetail, loadMarketCandleSnapshot, assetAddressTarget, resolveAssetAddress, suggestMarketAssets } from '../lib/markets-api'
// PriceWorkstation.jsx stays untouched (plan rule); the k-line source name is
// mapped here, before the chart source reaches it.
import { chartProviderLabel } from '../lib/chart-source-label'
import { useTokenProfile } from '../lib/useTokenProfile'
import { marketNativeChain } from '../lib/asset-identity'
import { useAssetThesisHistory } from '../lib/useAssetThesisHistory'
import { useLiveHistoryEnd } from '../lib/useLiveHistoryEnd'
import { intelReadError } from '../lib/read-error'
import { useAssetPortfolioContext } from '../lib/useAssetPortfolioContext'
import { useMarketPortfolioIdentity } from '../lib/useMarketPortfolioIdentity'
import {useMarketQuote} from '../lib/useMarketQuote'
import TokenAvatar from '../components/TokenAvatar'
import AssetPortfolioPosition from '../components/AssetPortfolioPosition'
import CopyAddress from '../components/CopyAddress'
import { fmtPrice, fmtPct, fmtVol, fmtNum, pctClass, bucketConfidence } from '../lib/market-format'
import { useDisplayCurrency } from '../lib/display-currency'
import MarketSignalBadge from '../components/MarketSignalBadge'
import { isUncataloguedContract, uncataloguedContractLabel } from '../lib/contract-suggestion'
import ConfidenceChip from '../components/ConfidenceChip'
import ProviderCoveragePill from '../components/ProviderCoveragePill'
import TokenChart, { CHART_RANGE_MS, candleIntervals, candleIntervalLabel } from '../components/TokenChart'
import { useArtifact } from '../lib/useArtifact'
import AssetSectionNav from '../components/AssetSectionNav'
import AssetVenueWorkspace from '../components/DeferredAssetVenueWorkspace'
import IntelDisclaimer from '../components/IntelDisclaimer'
import { deferredPanel } from '../components/deferred-panel'
// Everything below the chart, the position and the market context. Each one
// reads through its own hooks after it mounts, so nothing here is first
// content, and each one dragged a sizeable closure — the artifact reader, the
// contract research workspace, the thesis workspace — in front of this page's
// first authorized asset read. The section headings stay in AssetSectionNav so
// the jump links are unchanged whether or not the code has arrived yet.
const AssetAnalystBrief = deferredPanel(() => import('../components/AssetAnalystBrief'), { label: 'Research for this asset' })
const ContractResearchWorkspace = deferredPanel(() => import('../components/ContractResearchWorkspace'), { label: 'Contract research' })
const AssetThesisModule = deferredPanel(() => import('../components/thesis/AssetThesisModule'), { label: 'Your theses for this asset' })
const AssetYearInReview = deferredPanel(() => import('../components/AssetYearInReview'), { label: 'The year in review' })
const BookCalendar = deferredPanel(() => import('../components/BookCalendar'), { label: 'The asset calendar' })
const LiveTape = deferredPanel(() => import('../components/LiveTape'), { label: 'The live on-chain tape' })
const MarketMemorySummary = deferredPanel(() => import('../components/MarketMemorySummary'), { label: 'Market context' })
const AssetNewsPanel = deferredPanel(() => import('../components/AssetNewsPanel'), { label: 'News for this asset' })
const CrossExchangeSpreadCard = deferredPanel(() => import('../components/CrossExchangeSpreadCard'), { label: 'The cross-exchange spread' })
const OrderbookDepthCard = deferredPanel(() => import('../components/OrderbookDepthCard'), { label: 'Order book depth' })
const OnchainActivityCard = deferredPanel(() => import('../components/MarketEnrichmentCards').then(module => ({ default: module.OnchainActivityCard })), { label: 'On-chain activity' })
const EcosystemNarrativesCard = deferredPanel(() => import('../components/MarketEnrichmentCards').then(module => ({ default: module.EcosystemNarrativesCard })), { label: 'Ecosystem narratives' })
const CatalystsNewsCard = deferredPanel(() => import('../components/MarketEnrichmentCards').then(module => ({ default: module.CatalystsNewsCard })), { label: 'Earlier coverage' })
const UpcomingUnlocksCard = deferredPanel(() => import('../components/MarketEnrichmentCards').then(module => ({ default: module.UpcomingUnlocksCard })), { label: 'Upcoming unlocks' })
// The five figures between the hero and the chart are the shared chart kit's
// only callers on this route. Each already reads through its own hook after it
// mounts and renders nothing until that read returns, so deferring their code
// changes when the kit downloads, not when a figure appears.
const MarketCoverageRing = deferredPanel(() => import('../components/MarketCoverageRing'), { label: 'Identity coverage' })
const AssetProvenance = deferredPanel(() => import('../components/AssetProvenance'), { label: 'Identity provenance' })
const AssetHistoryFigure = deferredPanel(() => import('../components/AssetHistoryFigure'), { label: 'Price history' })
const AssetFactsPanel = deferredPanel(() => import('../components/AssetFactsPanel'), { label: 'Asset facts' })
const AttentionPersistence = deferredPanel(() => import('../components/AttentionPersistence'), { label: 'Attention persistence' })
// Tokenised real-world assets only: the block renders nothing at all unless the
// daily depth lane has captured this CoinMarketCap id, so every other asset page
// is unchanged. Deferred like its neighbours.
const RwaTokenDepth = deferredPanel(() => import('../components/RwaTokenDepth'), { label: 'Tokenised asset' })
// The project profile's own read stays in the page (the analyst question and
// the avatar fallback both use it); only the panel that draws it is deferred.
const ProfilePanel = deferredPanel(() => import('../components/ProfilePanel'), { label: 'The project profile' })
const ContractChartEvidenceStatus = deferredPanel(() => import('../components/ContractChartEvidenceStatus'), { label: 'Contract chart evidence' })
import TokenRiskBadge from '../components/TokenRiskBadge'
import FigureProvenance from '../components/FigureProvenance'
import MetricAgreementChip from '../components/MetricAgreementChip'
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
  // The address is kept EXACTLY as it was typed as well as uppercased. A ticker
  // reads the same either way; a contract address and a project name do not, and
  // both have to survive to the catalogue lookup below.
  const routeInput = String(symbol || '')
  const routeSymbol = routeInput.toUpperCase()
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
  // Every width is selectable for every identity now: the backend ladder decides
  // which source can serve it and states the width it actually served.
  const candleIntervalChoices=candleIntervals()
  const sym = String(d?.symbol || routeSymbol).toUpperCase()
  const marketKey = d?.sourceProvider && d?.providerId != null ? `market:${d.sourceProvider}:${d.providerId}` : null
  const network = useMarketPortfolioIdentity({ identityChoices: d?.identityChoices, defaultKey: d?.canonicalAssetKey, marketKey, explicitKey: query.get('network') })
  const historyTo = useLiveHistoryEnd(org?.id)
  // A market-only asset has a valid research workspace. A network match that is
  // still pending or failed does not: do not open temporary private workspaces.
  const canonicalKey = network.canonicalAssetKey || (!network.choices.length && !network.invalidExplicit ? marketKey : null)
  const chartPending = !canonicalKey && network.loading
  const selectedNetwork=network.choices.find(choice=>choice.canonicalAssetKey===canonicalKey)
  const riskAddress=canonicalKey?.startsWith('eip155:')&&/^0x[0-9a-f]{40}$/i.test(canonicalKey.split(':')[2]||'')?canonicalKey.split(':')[2]:canonicalKey?.startsWith('solana:')&&!canonicalKey.includes(':native:')?canonicalKey.slice(7):null
  // The chart this member last left on this asset, read BEFORE the chart is built
  // so the workstation paints once, already carrying their drawings, indicators,
  // window and candle width. The stored period and width become the defaults the
  // controls start from, so choosing another one still writes it to the address
  // and still wins.
  const workspaceContext = canonicalKey && user?.id && org?.id ? { supabase, userId: user.id, orgId: org.id, asset: canonicalKey } : null
  const workspace = useChartWorkingState(workspaceContext)
  const restoredState = workspace.working?.state || null
  const restoredSavedAt = workspace.working?.updatedAt ? Date.parse(workspace.working.updatedAt) : null
  const [chartOptions,setChartOptions]=useScreenParams('chart_', {
    range: workingRangePreset(restoredState?.range, CHART_RANGE_MS) || '7D',
    interval: workingCandleInterval(restoredState?.interval, candleIntervalChoices) || 'auto',
  })
  const candleInterval=candleIntervalChoices.includes(chartOptions.interval)?chartOptions.interval:'auto'
  const setCandleInterval=interval=>setChartOptions(previous=>({...previous,interval}))
  const historyRange=Object.hasOwn(CHART_RANGE_MS,chartOptions.range)?chartOptions.range:'7D'
  const setHistoryRange=range=>setChartOptions(previous=>({...previous,range}))
  // The window keeps its width and ends at now, so a day or two away simply moves
  // the drawings left; a window the member had scrolled back to is left where it is.
  const restoredLayout = useMemo(() => workingInitialState(restoredState, Date.now(), restoredSavedAt), [restoredState, restoredSavedAt])
  const historyFrom = historyTo - CHART_RANGE_MS[historyRange]
  const position = useAssetPortfolioContext({ canonicalAssetKey: network.canonicalAssetKey, from: historyFrom, to: historyTo })
  const research = useAssetThesisHistory({ canonicalKey, from: historyFrom, to: historyTo })
  const publicEvidence=useContractChartEvidence({canonicalKey,from:historyFrom,to:historyTo,portfolioId:position.portfolioId})
  // The live lane. Its own marker kind and layer, so a streamed event is never
  // merged into the retained public history it sits beside.
  const [tapeMarkers,setTapeMarkers]=useState([])
  const analysis = useArtifact(`${detailScope}:${canonicalKey || ''}`)
  const backTo = typeof location.state?.from === 'string' && /^\/intel(?:[/?]|$)/.test(location.state.from) ? location.state.from : '/intel/markets'
  // The address as it stands right now, read WITHOUT making this page's asset
  // read depend on it. Every chart control writes its own query parameter, so a
  // location in the dependency list would re-fetch the asset on each of them.
  const here = useRef(location)
  here.current = location

  useEffect(() => {
    if (!org?.id || !routeSymbol) return
    let alive = true
    // An address that already carries an exact identity is settled, so nothing is
    // asked about it and nothing extra is spent on a click from the table.
    const addressed = Boolean(sourceProvider && providerId)
    // Set when the resolution is being handed to another address: the loading
    // state has to survive the navigation, or the wrong asset's "not found"
    // flashes between the two renders.
    let leaving = false
    // The ranked answer for a bare address, kept so the read's own fall-back
    // never asks the same question twice.
    let suggested = null
    setLoading(true); setError(null); setD(null); setCandidates([])
    ;(async () => {
      try {
        // A bare address is the reader's words, not an identity: a ticker, a
        // project name or a pasted contract. Ask the ranked catalogue what it
        // names BEFORE reading anything, because the symbol read cannot tell
        // "the asset called Bitcoin" from "a token whose ticker is BITCOIN" and
        // it answers for the second one. Free market_boards read; nothing spent.
        if (!addressed) {
          const address = await resolveAssetAddress(supabase, org.id, routeInput, `${here.current.pathname}${here.current.search}`, { limit: 8 })
          if (!alive) return
          suggested = address.matches
          if (address.open) { leaving = true; navigate(address.open.href, { replace: true, state: here.current.state }); return }
          if (address.candidates.length) { setCandidates(address.candidates); return }
          // Nothing in the exact tier, or the catalogue could not be asked: the
          // address is read as a symbol exactly as it was before.
        }
        const load = () => loadMarketDetail(supabase, org.id, routeSymbol, identity)
        const r = await (detailCache ? detailCache.read(identity, load, { force: retry > 0 }) : load()); if (!alive) return; setD({ scope: detailScope, data: r }); setLoading(false)
      } catch (e) {
        if (!alive) return
        setError(e.message)
        // An address with an exact identity on it already said which asset it
        // means, so a failure there is a failure, not an identity question.
        if (addressed) return
        const matches = suggested ?? await suggestMarketAssets(supabase, org.id, routeInput, { limit: 8 }).catch(() => [])
        if (!alive || !matches.length) return
        // Exactly one asset in the exact tier IS the answer: open it rather than
        // asking the reader to confirm a list of one. When the typed text really
        // does name several, the whole tier is the choice, in the server's order.
        const target = assetAddressTarget(matches, `${here.current.pathname}${here.current.search}`)
        if (target.open) { leaving = true; navigate(target.open.href, { replace: true, state: here.current.state }); return }
        setCandidates(target.candidates)
      }
      finally { if (alive && !leaving) setLoading(false) }
    })()
    return () => { alive = false }
  }, [org?.id, user?.id, supabase, routeSymbol, routeInput, sourceProvider, providerId, detailScope, retry, detailCache, navigate])

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
      {candidates.map(row => <Link className="intel-asset-choice" key={`${row.sourceProvider}:${row.providerId}`} to={row.href} state={location.state}>
        {/* A pasted address that reads as several chains offers one row per
            chain we have already observed it on, named as the offer it is. */}
        <strong>{isUncataloguedContract(row) ? uncataloguedContractLabel(row, t) : row.displayName || row.symbol || row.providerId}</strong>
        <span>{[row.symbol, row.chain, `${row.sourceProvider} ${row.providerId}`].filter(Boolean).join(' · ')}</span>
        <em>{row.marketCap == null ? t('markets.suggest_no_market_cap', { defaultValue: 'No market cap' }) : money.formatMoney(row.marketCap)}</em>
      </Link>)}
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
  // Pool liquidity is the one figure a contract identity has that a listed asset
  // does not, and it is the figure that says whether the price above means
  // anything. Shown only when the answering DEX source reported it.
  if (d.contract?.liquidityUsd != null) stats.push([t('markets.dex_liquidity', { defaultValue: 'DEX liquidity' }), money.formatMoney(d.contract.liquidityUsd)])

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
          {/* The contract this page IS. A reader who has to carry it into an
              explorer or a wallet should never have to transcribe it off the
              screen, so the short form is a label with the full address on its
              title and the copy control writes the full address. */}
          {riskAddress && <p className="page-sub text-[12px] flex flex-wrap items-baseline gap-2">
            <span className="text-[var(--fg-4)]">{t('asset.contract_address', { defaultValue: 'Contract address' })}</span>
            <CopyAddress value={riskAddress} />
          </p>}
          {/* `quoteProvider` is the shape of the identity, and for a contract it
              is the literal word "contract" — not the name of a source. The
              answering source's own label rides in the response, so a DEX quote
              is credited to "DEX Screener" and never to "contract". */}
          {d.quoteProvider&&<p className="intel-event-meta">{d.quoteProvider==='coinmarketcap'?'CoinMarketCap':d.quoteProvider==='coingecko'?'CoinGecko':d.quoteSourceLabel||d.quoteProvider} · {d.asOf&&<time dateTime={d.asOf}>{new Date(d.asOf).toLocaleTimeString()}</time>}{d.quoteRefreshSeconds?` · Quotes checked every ${d.quoteRefreshSeconds===60?'minute':'5 minutes'}`:''}{d.sourceFreshness&&d.sourceFreshness!=='fresh'&&d.sourceFreshness!=='cached'?` · ${d.sourceFreshness}`:''}</p>}
          {/* Play 1 and 7: what answered the quote (the minute refresh replaces
              these with its own receipts) and what the price does not mean. */}
          <FigureProvenance envelope={d.quoteProvenance?.price} receipts={d.quoteReceipts} />
          {/* Play 4: read from retained observations on the server, no provider call. */}
          <MetricAgreementChip agreement={d.metricAgreement} />
          {liveQuote.error&&<p role="status" className="intel-event-meta">{liveQuote.error}</p>}
          {/* Money above is converted from the stored USD at display time. When
              the reader asked for a currency the hourly capture cannot supply,
              the figures stay in dollars and say so rather than misprice. */}
          {money.fallback
            ? <p className="intel-event-meta" data-display-currency={money.currency}>{t('markets.currency_fallback', { currency: money.currency, defaultValue: 'Rates unavailable, so money figures are shown in USD.' })}</p>
            : money.currency !== 'USD' && <p className="intel-event-meta" data-display-currency={money.currency}>{t('markets.currency_note', { currency: money.currency, defaultValue: 'Money figures in {{currency}}, converted from USD at display time.' })}</p>}
        </div>
        {sig && d.price == null && <MarketSignalBadge direction={sig.direction} />}
      </div>

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
        {chartPending || workspace.loading ? <div role="status" className="min-h-[420px] flex items-center justify-center text-sm text-[var(--fg-4)]">{chartPending ? t('asset.matching_chart_network', { defaultValue: 'Matching your portfolio network…' }) : t('asset.restoring_chart', { defaultValue: 'Restoring the chart you left…' })}</div> : <TokenChart key={`${user?.id}:${org?.id}:${canonicalKey || marketKey}:${position.portfolioId}`} assetKey={`${user?.id}:${org?.id}:${canonicalKey || marketKey}:${position.portfolioId}`} candles={d.candles} persistence={canonicalKey ? {supabase,userId:user?.id,orgId:org?.id,asset:canonicalKey,interval:candleInterval} : null} readOnly={!canonicalKey} assetName={d.displayName} assetSymbol={sym}
          requestKey={candleInterval} initialLayout={restoredLayout} workingRevision={workspace.working?.revision || 0}
          rangeExtra={<label className="intel-event-meta">Candle interval <select aria-label="Candle interval" value={candleInterval} onChange={e=>setCandleInterval(e.target.value)}>{candleIntervalChoices.map(choice=><option key={choice} value={choice}>{candleIntervalLabel(choice)}</option>)}</select><span> The chart names its source and the width it served under Price coverage.</span></label>}
          markers={[...mergeLinkedAssetMarkers(position.markers, research.markers),...publicEvidence.markers,...tapeMarkers]} timeWindow={{ from: historyFrom, to: historyTo }} showDensityToggles defaultRange={historyRange} candlesRange={DETAIL_CANDLE_RANGE} onRangeChange={setHistoryRange}
          historyLoading={research.loading || position.loading || research.loadingMore || position.loadingMore}
          historyError={research.error || (position.error && intelReadError(position.error, 'Your portfolio activity is temporarily unavailable. Please retry from Your position.'))} historyHasMore={!!(research.nextCursor || position.nextCursor)}
          onLoadMoreHistory={() => { if (research.nextCursor) research.loadMore(); if (position.nextCursor) position.loadMore() }}
          priceCoverage={{ chartSource:d.chartSource&&d.chartSource.provider==='coinmarketcap_kline'?{...d.chartSource,provider:chartProviderLabel(d.chartSource.provider)}:d.chartSource,capture:d.captureProof?{proof:d.captureProof,bars:d.candles}:null, coverage: d.chartCoverage, state: d.chartState, provenance: d.chartProvenance,
            // The server's receipts and envelope for THIS first load only. Every other
            // period's snapshot carries its own, re-derived by the chart.
            chartEnvelope: d.figureProvenance?.chart ?? null, chartReceipts: d.chartReceipts ?? null }}
          candleProvenance
          loadCandles={(tf, extra) => loadMarketCandleSnapshot(supabase, org.id, sym, tf, { sourceProvider: d.sourceProvider, providerId: d.providerId,interval:candleInterval, ...extra })} />}
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

      {/* The five reads below each size themselves only once their own read
          returns. They sit under the chart and the research heading so a late
          read grows into space no one is looking at, instead of pushing the
          chart down the page after first paint. */}

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
      <RwaTokenDepth sourceProvider={d.sourceProvider} providerId={d.providerId} />
      <AttentionPersistence sourceProvider={d.sourceProvider} providerId={d.providerId} symbol={sym} />

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
      {canonicalKey&&<AssetVenueWorkspace canonicalKey={canonicalKey} provenance={{cex:d.figureProvenance?.cex,orderbook:d.figureProvenance?.orderbook,dex:d.figureProvenance?.dex}}/>}
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
