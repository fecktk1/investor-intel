import {useContractChartEvidence} from '../lib/useContractChartEvidence'
import ContractChartEvidenceStatus from '../components/ContractChartEvidenceStatus'
import {cmcDexIdentity} from '../../../supabase/functions/_shared/market-assets/cmc-dex.ts'
import { useScreenParams } from '../lib/useScreenParams'
import BookCalendar from '../components/BookCalendar'
import { mergeLinkedAssetMarkers } from '../lib/chart-history'
import React, { useEffect, useState, useCallback, useRef } from 'react'
import { useParams, Link, useLocation } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Scale, HelpCircle, Star, RefreshCw, TrendingUp, TrendingDown, Bell } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { getEntityByRef, listArtifacts } from '../lib/artifact-api'
import { addEntityToWatchlist, resolveEntity } from '../lib/watchlist-api'
import { loadTokenChart, loadWalletPortfolio } from '../lib/chart-api'
import AssetNewsPanel from '../components/AssetNewsPanel'
import { getChain, chainIdFor, normalizeAddressForChain, assetRef, loadChainCoverage, capabilityStatus } from '../lib/chains'
import { useArtifact } from '../lib/useArtifact'
import ArtifactView from '../components/ArtifactView'
import TokenRiskBadge from '../components/TokenRiskBadge'
import TokenAvatar from '../components/TokenAvatar'
import TokenChart, { CHART_RANGE_MS } from '../components/TokenChart'
import { entityPortfolioKey, nativeAssetEntity, contractAssetEntity, assetLogoUrl, assetChartRef } from '../lib/asset-identity'
import AssetSectionNav from '../components/AssetSectionNav'
import AssetVenueWorkspace from '../components/DeferredAssetVenueWorkspace'
import ContractResearchWorkspace from '../components/ContractResearchWorkspace'
import { useAssetPortfolioContext } from '../lib/useAssetPortfolioContext'
import { useAssetThesisHistory } from '../lib/useAssetThesisHistory'
import { useLiveHistoryEnd } from '../lib/useLiveHistoryEnd'
import AssetThesisModule from '../components/thesis/AssetThesisModule'
import AssetPortfolioPosition from '../components/AssetPortfolioPosition'
import WalletHoldingsChart from '../components/WalletHoldingsChart'
import IntelActionButton from '../components/IntelActionButton'
import MarketContextCard from '../components/MarketContextCard'
import { formatUsd, formatPrice } from '../lib/market-format'
import ProfilePanel from '../components/ProfilePanel'
import DegenSignalsCard from '../components/DegenSignalsCard'
import DegenMomentum from '../components/DegenMomentum'
import { loadMarketContextBySymbols, loadDegenToken } from '../lib/markets-api'
import { useTokenProfile } from '../lib/useTokenProfile'
import IntelDisclaimer from '../components/IntelDisclaimer'

const TIMEFRAMES = ['1H', '4H', '1D', '1W']
const providerLabel = (p) => String(p || '').toLowerCase() === 'alchemy' ? 'Alchemy' : String(p || '').toLowerCase() === 'helius' ? 'Helius' : 'Provider'

// P4 — Token intelligence page: chart + live market stats + AI breakdown +
// risk panel + news, unified for the selected token. Wallet entities show the
// wallet summary instead of a price chart.
export default function AssetBreakdownPage() {
  const { ref } = useParams()
  const location = useLocation()
  const returnTo = typeof location.state?.from === 'string' && /^\/intel(?:[/?]|$)/.test(location.state.from) ? location.state.from : '/intel/markets'
  const decoded = decodeURIComponent(ref || '')
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase, user } = useSupabase()
  const entityScope = `${user?.id}:${org?.id}:${decoded}`
  const [entityState, setEntityState] = useState(null)
  const entity = entityState?.scope === entityScope ? entityState.value : null
  const setEntity = value => setEntityState({ scope: entityScope, value })
  const [loadingEntity, setLoadingEntity] = useState(true)
  const [entityError, setEntityError] = useState(null)
  const [entityRetry, setEntityRetry] = useState(0)
  const [saved, setSaved] = useState(false)
  const [chart, setChart] = useState(null)
  const [chartOptions,setChartOptions]=useScreenParams('chart_', {range:'7D',interval:'auto'})
  const timeframe=['auto','1H','4H','1D','1W'].includes(chartOptions.interval)?chartOptions.interval:'auto'
  const setTimeframe=interval=>setChartOptions(previous=>({...previous,interval}))
  const [walletPf, setWalletPf] = useState(null)
  const [walletLoading, setWalletLoading] = useState(false)
  const [marketCtx, setMarketCtx] = useState(null)
  const [degenSignals, setDegenSignals] = useState(null)
  const [coverage, setCoverage] = useState({})
  const breakdown = useArtifact(entityScope)
  const risk = useArtifact(entityScope)
  const isWallet = entity?.entity_kind === 'wallet'
  const projectProfile = useTokenProfile({supabase,orgId:org?.id,userId:user?.id,ident:!entity||isWallet?null:entity._chain&&entity._address?{chain:entity._chain,tokenAddress:entity._address}:{ref:entity.canonical_ref_key}})
  const { profile } = projectProfile
  const historyTo = useLiveHistoryEnd(org?.id)
  const historyRange=Object.hasOwn(CHART_RANGE_MS,chartOptions.range)?chartOptions.range:'7D'
  const setHistoryRange=range=>setChartOptions(previous=>({...previous,range}))
  const canonicalKey = entityPortfolioKey(entity)
  const historyFrom = historyTo - CHART_RANGE_MS[historyRange]
  const position = useAssetPortfolioContext({ canonicalAssetKey: canonicalKey, from: historyFrom, to: historyTo })
  const research = useAssetThesisHistory({ canonicalKey, entityId: isWallet ? null : entity?.id, from: historyFrom, to: historyTo })
  const publicEvidence=useContractChartEvidence({canonicalKey,from:historyFrom,to:historyTo,portfolioId:position.portfolioId})
  const chartScope = `${user?.id}:${org?.id}:${decoded}:${timeframe}`
  const chartScopeRef = useRef(chartScope)
  chartScopeRef.current = chartScope

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const map = await loadChainCoverage(supabase)
        if (alive) setCoverage(map)
      } catch { /* coverage is additive */ }
    })()
    return () => { alive = false }
  }, [supabase])

  useEffect(() => {
    let alive = true
    ;(async () => {
      if (!org?.id) return
      setLoadingEntity(true); setEntityError(null); setEntity(null); setChart(null); setMarketCtx(null); setSaved(false); setDegenSignals(null); setWalletPf(null)
      try {
        let e = await getEntityByRef(supabase, org.id, decoded)
        // All registered native aliases reach the existing chart/portfolio path.
        // A display ticker alone never creates an entity or resolves a network.
        if (!e) e = nativeAssetEntity(decoded)
        if (!e) e = contractAssetEntity(decoded)
        // Contract token by app `chain:address` (Degen rows + non-CoinGecko top-1000).
        // Synthetic entity — NO org `entities` row until Add to watchlist. id:null +
        // _synthetic signal every hook this is temporary (entity-scoped features guard on id).
        if (!e && !decoded.startsWith('native:') && decoded.includes(':') && !decoded.includes('/')) {
          const idx = decoded.indexOf(':'); const cid = decoded.slice(0, idx); const ch = getChain(cid)
          const addr = ch ? normalizeAddressForChain(cid, decoded.slice(idx + 1)) : decoded.slice(idx + 1) // EVM lowercased so the case-sensitive Degen read + profile lookup hit
          if (ch && addr) e = { id: null, canonical_ref_key: assetRef(cid, addr), entity_kind: 'asset', asset_type: ch.namespace === 'eip155' ? 'erc20' : (cid === 'solana' ? 'spl' : 'token'), contract_address: addr, chain_id: cid, chain_namespace: ch.label, display_symbol: null, _contract: true, _synthetic: true, _chain: cid, _address: addr }
        }
        // DB-loaded contract entity (post-watchlist-save / "Open chart"): the real
        // entities row carries no _chain/_address/_contract synthetic flags, so
        // reconstruct them from its CAIP columns (chain_id is the CAIP ref → map via
        // chainIdFor). Without this the page looks the profile up by canonical_ref_key
        // and skips the Degen signals — losing the rich data the synthetic view had.
        if (e && e.id && !e._synthetic && !e._native && e.contract_address && e.asset_type !== 'native') {
          const appId = chainIdFor(e.chain_namespace, e.chain_id)
          if (appId) e = { ...e, _chain: appId, _address: e.contract_address, _contract: true }
        }
        if (alive) setEntity(e)
      } catch { if (alive) setEntityError(true) } finally { if (alive) setLoadingEntity(false) }
    })()
    return () => { alive = false }
  }, [org?.id, user?.id, decoded, supabase, entityRetry])

  const loadPriceCandles = useCallback(async (range) => {
    if (!entity || isWallet) return []
    const interval = timeframe === 'auto' ? ({ '1H':'1H','12H':'1H','24H':'1H','3D':'4H','7D':'4H','1M':'1D','3M':'1W','6M':'1W','1Y':'1W' })[range] || '1D' : timeframe
    const value = await loadTokenChart(supabase, org.id, { entityId: entity.id, ref: assetChartRef(entity), timeframe: interval, range })
    if (chartScopeRef.current === chartScope) setChart(value)
    return {...value,candles:(value?.candles || []).filter(c => { const ts = Number(c.t) < 1e12 ? Number(c.t) * 1000 : Number(c.t); return ts >= historyTo - CHART_RANGE_MS[range] && ts <= historyTo })}
  }, [entity, isWallet, org?.id, supabase, timeframe, chartScope, historyTo])

  const run = useCallback((force = false) => {
    if (!entity?.id) return // AI breakdown/risk need a real watchlist entity (native coins are chart+news only)
    breakdown.generate({ artifactType: isWallet ? 'wallet_summary' : 'token_breakdown', entityId: entity.id, force })
    if (!isWallet) risk.generate({ artifactType: 'risk_panel', entityId: entity.id, force })
  }, [entity, isWallet, breakdown, risk])

  useEffect(() => {
    if (!entity) return
    let alive = true
    breakdown.setResult(null); risk.setResult(null)
    if (entity.id) {
      for (const [type, target] of [[isWallet ? 'wallet_summary' : 'token_breakdown', breakdown], ['risk_panel', risk]]) {
        if (isWallet && type === 'risk_panel') continue
        listArtifacts(supabase, org.id, { artifactType: type, entityId: entity.id, limit: 1 }).then(rows => { if (alive && rows[0]) target.setResult({ artifact: rows[0], cached: true }) }).catch(() => {})
      }
    }
    if (!isWallet) {

      ;(async () => { try { const m = await loadMarketContextBySymbols(supabase, [entity.display_symbol]); if (alive) setMarketCtx(m[String(entity.display_symbol || '').toUpperCase()] || null) } catch { /* */ } })()
      // Free cached Degen signals (contract tokens) — useful before watchlist add.
      if (entity._chain && entity._address) ;(async () => { try { const d = await loadDegenToken(supabase, entity._chain, entity._address); if (d && alive) setDegenSignals(d) } catch { /* */ } })()
    } else {
      ;(async () => { setWalletLoading(true); try { const pf = await loadWalletPortfolio(supabase, org.id, { entityId: entity.id }); if (alive) setWalletPf(pf) } catch { /* */ } finally { if (alive) setWalletLoading(false) } })()
    }
    return () => { alive = false }
  }, [entity?.canonical_ref_key, entity?.id, org?.id, user?.id]) // eslint-disable-line

  const onSave = useCallback(async () => {
    if (!entity || !org?.id) return
    try {
      let ent = entity
      // Synthetic contract entity → resolve a real org entity first, then swap
      // state in place (no manual refresh, keep chart/profile/signals loaded).
      if (entity._synthetic && entity._chain && entity._address) {
        const resolved = await resolveEntity(supabase, org.id, { kind: 'asset', chain: entity._chain, value: entity._address })
        ent = { ...resolved, _chain: entity._chain, _address: entity._address, _contract: true }
        setEntity(ent)   // canonical_ref_key changes → effect re-enables AI/persisted features
      }
      await addEntityToWatchlist(supabase, org.id, user?.id, ent, isWallet ? 'wallet' : 'token'); setSaved(true)
    } catch { /* */ }
  }, [entity, org?.id, supabase, user?.id, isWallet])

  if (loadingEntity) return <p role="status" className="py-8 text-sm text-[var(--fg-4)]">{t('asset.loading', { defaultValue: 'Loading asset observations…' })}</p>
  if (entityError) return <div role="alert" className="py-8 text-sm">{t('asset.read_failed', { defaultValue: 'The asset read could not be completed.' })} <button className="underline" onClick={() => setEntityRetry(value => value + 1)}>{t('common.retry', { defaultValue: 'Retry' })}</button></div>
  if (!entity) return <div className="card p-8 text-center text-[var(--fg-3)] text-sm">{t('breakdown.not_found', { defaultValue: 'Asset not found in this workspace. Add it from the Watchlist first.' })}</div>

  const ov = chart?.overview
  const appChainId = walletPf?.entity?.app_chain || entity?._chain || chainIdFor(entity?.chain_namespace, entity?.chain_id)
  const appChain = appChainId ? getChain(appChainId) : null
  const holderStatus = appChainId ? capabilityStatus(appChainId, 'holders', coverage) : 'unverified'
  const coverageChip = isWallet && walletPf?.provider
    ? t('breakdown.holdings_via', { defaultValue: 'Holdings via {{provider}}', provider: providerLabel(walletPf.provider) })
    : (!isWallet && appChain && holderStatus !== 'live')
      ? cmcDexIdentity(canonicalKey)?'CMC contract holder evidence is available in On-chain participation.':t('breakdown.holders_source_unavailable', { defaultValue: 'Current profile source does not cover holders on {{chain}}', chain: appChain.label })
      : null
  const change = ov?.price_change_24h_pct
  const stats = [
    ['price', t('breakdown.price', { defaultValue: 'Price' }), formatPrice(ov?.price)],
    ['mcap', t('breakdown.mcap', { defaultValue: 'Market cap' }), formatUsd(ov?.market_cap)],
    ['fdv', 'FDV', formatUsd(ov?.fdv)],
    ['liq', t('breakdown.liquidity_stat', { defaultValue: 'Liquidity' }), formatUsd(ov?.liquidity)],
    ['vol', t('breakdown.volume', { defaultValue: '24h volume' }), formatUsd(ov?.volume_24h_usd)],
    ['holders', t('breakdown.holders', { defaultValue: 'Holders' }), ov?.holders != null ? Number(ov.holders).toLocaleString() : '—'],
  ]

  return (
    <div className="intel-asset-workspace space-y-4">
      <Link to={returnTo} className="text-xs text-[var(--accent)] underline underline-offset-4">{t('asset.back_to_research', { defaultValue: 'Back to research' })}</Link>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="eyebrow">{entity.chain_namespace || 'asset'}</div>
          <div className="flex items-center gap-3 flex-wrap">
            {!isWallet&&<TokenAvatar src={ov?.image_url||profile?.image_url||degenSignals?.image_url||assetLogoUrl(entity.canonical_ref_key)} symbol={entity.display_symbol||chart?.entity?.symbol||profile?.symbol} size="lg"/>}
            <h1 className="page-title">{entity.display_symbol || chart?.entity?.symbol || profile?.symbol || degenSignals?.symbol || (entity._address ? `${entity._address.slice(0, 4)}…${entity._address.slice(-4)}` : entity.asset_id)}</h1>
            {!isWallet && ov?.price != null && (
              <div className="flex items-baseline gap-2">
                <span className="text-xl font-semibold text-[var(--fg-1)]">{formatPrice(ov.price)}</span>
                {typeof change === 'number' && <span className={`text-sm font-semibold flex items-center gap-0.5 ${change >= 0 ? 'text-[var(--ok)]' : 'text-red-400'}`}>{change >= 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}{change >= 0 ? '+' : ''}{change.toFixed(1)}%</span>}
              </div>
            )}
            {entity._contract && entity._chain && entity._address && (
              <TokenRiskBadge chain={entity._chain} address={entity._address} symbol={entity.display_symbol} source={degenSignals ? 'degen' : 'lookup'} />
            )}
          </div>
          <details className="intel-asset-identity"><summary>{t('asset.identity',{defaultValue:'Asset identity'})}</summary><p className="break-all">{entity.canonical_ref_key}</p></details>
          {entity.entity_kind!=='wallet' && <Link className="intel-text-link text-sm" to={`/intel/investigate?${new URLSearchParams({asset:entity.canonical_ref_key})}`}>{t('investigation.open',{defaultValue:'Open connected research'})}</Link>}
          {coverageChip && <p className="intel-analysis-caption mt-1">{coverageChip}</p>}
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
          <AssetSectionNav sections={[
            { id: 'canonical-chart', key: 'asset.chart_position', label: 'Chart & position' },
              { id: 'canonical-theses', key: 'asset.theses', label: 'Your theses' },
              { id: 'asset-venue-evidence', key: 'asset.venueEvidence', label: 'Venues & positioning' },
            { id: 'canonical-profile', key: 'asset.profile', label: 'Profile & sources' },
            ...(entity.id ? [{ id: 'canonical-research', key: 'asset.research', label: 'Research' }] : []),
            { id: 'asset-news', key: 'asset.news', label: 'News' },
          ]}/>
          {/* Market stats */}
          <div className="intel-asset-summary intel-table-scroll"><table aria-label={t('asset.market_summary',{defaultValue:'Asset market summary'})}><thead><tr>{stats.map(([k,label])=><th key={k}>{label}</th>)}</tr></thead><tbody><tr>{stats.map(([k,,val])=><td key={k}>{val}</td>)}</tr></tbody></table></div>

          {marketCtx && <MarketContextCard ctx={marketCtx} variant="card" />}

          {/* Free cached Degen risk & quality signals (contract tokens) */}
          {entity._contract && degenSignals && <DegenSignalsCard token={degenSignals} />}
          {entity._contract && entity._chain && entity._address && <DegenMomentum chain={entity._chain} address={entity._address} />}

          {/* Chart + timeframe */}
          <div id="canonical-chart" className="space-y-2">
            <TokenChart key={`${user?.id}:${org?.id}:${canonicalKey}:${position.portfolioId}`} assetKey={`${user?.id}:${org?.id}:${canonicalKey}:${position.portfolioId}`} requestKey={timeframe}
              persistence={{supabase,userId:user?.id,orgId:org?.id,asset:canonicalKey,interval:timeframe}}
              defaultRange={historyRange} onRangeChange={setHistoryRange}
              rangeExtra={<label className="intel-chart-interval">{t('chart.interval', { defaultValue: 'Price interval' })}<select className="select" value={timeframe} onChange={e => setTimeframe(e.target.value)}><option value="auto">{t('chart.automatic', { defaultValue: 'Automatic' })}</option>{TIMEFRAMES.map(tf => <option key={tf} value={tf}>{tf}</option>)}</select></label>}
              loadCandles={loadPriceCandles}
              markers={[...mergeLinkedAssetMarkers(position.markers, research.markers),...publicEvidence.markers]} timeWindow={{ from: historyFrom, to: historyTo }} showDensityToggles historyLoading={research.loading || position.loading}
              historyError={research.error || position.error?.message} historyHasMore={!!(research.nextCursor || position.nextCursor)}
              onLoadMoreHistory={() => { if (research.nextCursor) research.loadMore(); if (position.nextCursor) position.loadMore() }}/>
            <AssetPortfolioPosition context={position}/>
            <section id="canonical-theses"><AssetThesisModule symbol={entity.display_symbol || chart?.entity?.symbol} canonicalAssetKey={canonicalKey} entityId={entity.id} chain={entity._chain}/></section>
            {chart?.unsupported ? (
              <div className="card--flat p-2 text-[12px] text-[var(--fg-4)]">{
                chart.state === 'pre_liquidity' ? t('breakdown.chart_pre_liquidity', { defaultValue: 'Pre-liquidity / no verified pool yet.' })
                : chart.state === 'pool_pending' ? t('breakdown.chart_pool_pending', { defaultValue: 'Pool not found yet / retrying.' })
                : t('breakdown.chart_unsupported', { defaultValue: 'Live chart is not available for this token yet.' })
              }</div>
            ) : chart?.source ? (
              <div className="text-[10px] text-[var(--fg-5)] flex items-center gap-1">{t('breakdown.chart_via', { defaultValue: 'Chart via' })} {chart.source_label || chart.source}{chart.pair_url && <> · <a href={chart.pair_url} target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] hover:underline">{chart.dex_id || t('breakdown.pool', { defaultValue: 'pool' })}</a></>}</div>
            ) : null}
          </div>
          <details id="canonical-profile" className="intel-asset-profile"><summary>{t('asset.project_profile',{defaultValue:'Project profile and source details'})}</summary><ProfilePanel {...projectProfile}/></details>
        </>
      )}

      {isWallet && (
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="eyebrow">{t('breakdown.holdings_section', { defaultValue: 'Holdings' })}</div>
            {walletPf?.portfolio?.total_usd != null && <div className="text-sm font-semibold text-[var(--fg-1)]">{formatUsd(walletPf.portfolio.total_usd)} · {walletPf.portfolio.token_count} {t('breakdown.tokens', { defaultValue: 'tokens' })}</div>}
          </div>
          <WalletHoldingsChart holdings={walletPf?.portfolio?.top_holdings} loading={walletLoading} />
          {walletPf?.unsupported && <div className="card--flat p-2 text-[12px] text-[var(--fg-4)]">{t('breakdown.wallet_unsupported', { defaultValue: 'Holdings data is not available for this chain yet.' })}</div>}
        </section>
      )}

      {entity.id ? (
        <section id="canonical-research" className="space-y-2">
          <div className="eyebrow">{isWallet ? t('breakdown.wallet_section', { defaultValue: 'Wallet summary' }) : t('breakdown.section', { defaultValue: 'Breakdown' })}</div>
          <ArtifactView result={breakdown.result} loading={breakdown.loading} />
          {breakdown.error && <div className="card--flat p-3 text-[13px] text-red-400">{breakdown.error}</div>}
        </section>
      ) : entity._native ? (
        <div className="card--flat p-3 text-[12px] text-[var(--fg-4)]">{t('breakdown.native_note', { defaultValue: 'Showing live price and news for this chain’s native coin. Add a specific token to your watchlist for a full AI breakdown and risk panel.' })}</div>
      ) : entity._contract ? (
        <div className="card--flat p-3 text-[12px] text-[var(--fg-4)]">{t('breakdown.contract_note', { defaultValue: 'Add to watchlist to unlock the AI breakdown and deeper (Birdeye) holder/security enrichment. Free chart, profile and signals are shown above.' })}</div>
      ) : null}

      {!isWallet && entity.id && (
        <section className="space-y-2">
          <div className="eyebrow">{t('breakdown.risk_section', { defaultValue: 'Risk panel' })}</div>
          <ArtifactView result={risk.result} loading={risk.loading} />
          {risk.error && <div className="card--flat p-3 text-[13px] text-red-400">{risk.error}</div>}
        </section>
      )}

      {!isWallet && <AssetNewsPanel identity={{ key: canonicalKey || entity.canonical_ref_key, entityId: entity.id, symbol: entity.display_symbol || profile?.symbol, name: entity._native ? appChain?.label : profile?.display_name || profile?.name, chain: appChainId, address: entity._address || entity.contract_address, native: entity._native || entity.asset_type === 'native' }} />}

      {!isWallet && canonicalKey && <AssetVenueWorkspace canonicalKey={canonicalKey}/>}
      {!isWallet&&<><ContractChartEvidenceStatus evidence={publicEvidence}/><ContractResearchWorkspace canonicalKey={canonicalKey} onEvidence={publicEvidence.acceptEvidence}/></>}
      {!isWallet && <BookCalendar key={canonicalKey} asset={canonicalKey} chartLane/>}
      <IntelDisclaimer variant="block" />
    </div>
  )
}
