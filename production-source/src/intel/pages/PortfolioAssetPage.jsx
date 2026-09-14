import {useContractChartEvidence} from '../lib/useContractChartEvidence'
import ContractChartEvidenceStatus from '../components/ContractChartEvidenceStatus'
import BookCalendar from '../components/BookCalendar'
import { mergeLinkedAssetMarkers } from '../lib/chart-history'
import React, { useCallback, useState, useMemo, useRef, useEffect } from 'react'
import { useParams, Link, useLocation } from 'react-router'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ExternalLink } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { explorerTxUrl } from '../lib/chains'
import { fmtPrice, fmtPct, pctClass } from '../lib/market-format'
import MarketSignalBadge from '../components/MarketSignalBadge'
import IntelDisclaimer from '../components/IntelDisclaimer'
import AssetThesisModule from '../components/thesis/AssetThesisModule'
import { useAssetPortfolioContext } from '../lib/useAssetPortfolioContext'
import { useAssetThesisHistory } from '../lib/useAssetThesisHistory'
import { portfolioAssetChartRef } from '../lib/portfolio-markers'
import { loadTokenChart } from '../lib/chart-api'
import AssetPortfolioPosition from '../components/AssetPortfolioPosition'
import TokenChart, { CHART_RANGE_MS } from '../components/TokenChart'
import {activityChartWindow,activityMarkerFor} from '../lib/portfolio-activity-route'
import { useLiveHistoryEnd } from '../lib/useLiveHistoryEnd'
import {usePortfolioActivityTarget} from '../lib/usePortfolioActivityTarget'
import {assetLogoUrl} from '../lib/asset-identity'
import TokenAvatar from '../components/TokenAvatar'
import ConnectedAssetSources from '../components/ConnectedAssetSources'
import ContractResearchWorkspace from '../components/ContractResearchWorkspace'
import {portfolioMarketDisplay,portfolioAssetDisplay} from '../lib/portfolio-asset-display'

const usd = (v) => v == null ? '—' : `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
const fmtAmt = (n) => n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 8 })
// P&L is trustworthy only when cost basis is actually known (or manually set).
const PNL_OK = new Set(['known', 'estimated', 'manual_override'])

function TokenLogo({ url, symbol, assetKey }) {
  const src = typeof url === 'string' && /^https:\/\//.test(url) ? url : assetLogoUrl(assetKey)
  return <TokenAvatar src={src} symbol={symbol} className="!h-8 !w-8" />
}

function typeLabel(type, t) { return t(`portfolio.txn_type.${type}`, { defaultValue: String(type || 'unknown').replace(/_/g, ' ') }) }

// Read-only per-asset position view: YOUR holdings, value, cost basis, P&L and
// the transaction history for this one asset. Reached by clicking a holding.
// DB-first — reads only stored portfolio tables, never a provider.
function PortfolioAssetPageBody() {
  const { portfolioId, assetKey } = useParams()
  // Defensive decode: a no-op if the router already decoded (canonical keys have
  // no '%'), correct if it didn't. Keys look like solana:native:SOL / eip155:1:0x…
  const key = useMemo(() => { try { return decodeURIComponent(assetKey || '') } catch { return assetKey || '' } }, [assetKey])
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase, user } = useSupabase()
  const location=useLocation()
  const [now] = useState(Date.now)
  const initialActivity=useMemo(()=>activityChartWindow(location.search,now),[location.search,now])
  const liveEnd = useLiveHistoryEnd(org?.id)
  const scope = `${user?.id}:${org?.id}:${portfolioId}:${key}`
  const activeScope = useRef(scope); activeScope.current = scope
  const [marketObservation, setMarketObservation] = useState(null)
  const marketOverview = marketObservation?.scope === scope ? marketObservation.overview : null
  const [historyYear, setHistoryYear] = useState(initialActivity.year)
  const [chartRange, setChartRange] = useState(initialActivity.range)
  const historyTo = historyYear === 0 ? liveEnd : now - historyYear * 365 * 86400000
  const chartFrom = historyTo - CHART_RANGE_MS[chartRange]
  // Transaction history retains year navigation; chart activity pages exactly
  // the visible interval instead of filtering the first 200 annual records.
  const context = useAssetPortfolioContext({ portfolioId, canonicalAssetKey: key, from: historyTo - 365 * 86400000, to: historyTo })
  const chartContext = useAssetPortfolioContext({ portfolioId, canonicalAssetKey: key, from: chartFrom, to: historyTo })
  const thesisHistory = useAssetThesisHistory({ canonicalKey: key, from: chartFrom, to: historyTo })
  const publicEvidence=useContractChartEvidence({canonicalKey:key,from:chartFrom,to:historyTo,portfolioId})
  const target=usePortfolioActivityTarget({supabase,userId:user?.id,orgId:org?.id,portfolioId,canonicalAssetKey:key,eventKey:initialActivity.event})
  const targetTime=target.marker?.t??initialActivity.at
  useEffect(()=>{if(target.marker){const period=activityChartWindow('?'+new URLSearchParams({at:String(target.marker.t),event:initialActivity.event}),now);setHistoryYear(period.year);setChartRange(period.range)}},[target.marker?.id,target.marker?.t,initialActivity.event,now]) // eslint-disable-line
  const { holding, events: activity, loading, error } = context
  const markers = useMemo(() => mergeLinkedAssetMarkers([...new Map([...chartContext.markers,...target.marker?[target.marker]:[]].map(m=>[m.id,m])).values()], [...thesisHistory.markers,...publicEvidence.markers]), [chartContext.markers, thesisHistory.markers,target.marker,publicEvidence.markers])
  const loadMoreHistory = useCallback(() => Promise.allSettled([chartContext.loadMore(), thesisHistory.loadMore()]), [chartContext.loadMore, thesisHistory.loadMore])
  const chartIdentity = useMemo(() => portfolioAssetChartRef(key), [key])
  const loadCandles = useCallback(async (range) => {
    // The existing endpoint supplies trailing windows, not arbitrary past ranges.
    // Preserve archived activity without substituting current provider prices.
    if (!chartIdentity || !org?.id || historyYear > 0) return []
    const days = ({ '1H': 1 / 24, '12H': 0.5, '24H': 1, '3D': 3, '7D': 7, '1M': 30, '3M': 90, '6M': 180, '1Y': 365 })[range] || 7
    const timeframe = chartIdentity.native
      ? days <= 1 ? '1H' : days <= 7 ? '4H' : days <= 30 ? '1D' : '1W'
      : days <= 7 ? '1H' : days <= 30 ? '4H' : days <= 180 ? '1D' : '1W'
    const data = await loadTokenChart(supabase, org.id, { ref: chartIdentity.ref, timeframe, range })
    const market=portfolioMarketDisplay(data,chartIdentity.ref)
    if (activeScope.current === scope && market) setMarketObservation({scope,...market})
    const end = historyTo, start = end - days * 86400000
    return {...data,candles:(data.candles || []).filter((c) => { const time = Number(c.t) < 1e12 ? Number(c.t) * 1000 : Number(c.t); return Number.isFinite(time) && time >= start && time <= end })}
  }, [chartIdentity, org?.id, supabase, historyTo, historyYear, scope])

  // Identity falls back to a transaction leg if the position was fully sold.
  const meta = useMemo(() => portfolioAssetDisplay(holding,activity,key,chartIdentity,marketObservation?.scope===scope?marketObservation:null), [holding, activity, key, chartIdentity,marketObservation,scope])

  const sig = holding?.market_context?.signalDirection
  const pnlOk = holding && PNL_OK.has(holding.cost_basis_status) && holding.unrealized_pnl != null
  const realizedOk = holding && PNL_OK.has(holding.cost_basis_status) && holding.realized_pnl != null

  const returnState=location.state?.portfolioReturn
  const returnUrl=returnState?.orgId===org?.id&&returnState?.userId===user?.id&&returnState?.portfolioId===portfolioId&&/^\/intel\/portfolio(?:\?[^#]*)?$/.test(returnState?.url||'')&&returnState.url.length<=3000?returnState.url:'/intel/portfolio'
  const back = (
    <Link to={returnUrl} onClick={() => context.selectPortfolio(portfolioId)} className="text-[12px] text-[var(--accent)] inline-flex items-center gap-1">
      <ArrowLeft className="h-3.5 w-3.5" /> {t('portfolio.back_to_portfolio', { defaultValue: 'Back to portfolio' })}
    </Link>
  )

  const mc = holding?.market_context || {}
  const canonicalMarket = mc.canonicalAssetKey === key && mc.priceProvider === 'coinmarketcap'
  const marketCap = canonicalMarket && Number.isFinite(mc.marketCap) ? mc.marketCap : marketOverview?.market_cap
  const marketCapSource = canonicalMarket && Number.isFinite(mc.marketCap) ? 'CoinMarketCap' : marketOverview?.source_label || marketOverview?.source
  const priceTime = holding?.current_price!=null?holding.last_priced_at:marketOverview?.as_of
  const marketCapTime = canonicalMarket && Number.isFinite(mc.marketCap) ? holding?.last_priced_at : marketOverview?.as_of

  return (
    <div className="space-y-4">
      {back}

      <div className="border-b border-[var(--border-default)] rounded-none p-4 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3 min-w-0">
      <TokenLogo url={meta.logo || marketOverview?.image_url} symbol={meta.symbol} assetKey={key} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-[20px] font-semibold text-[var(--fg-1)] truncate">{meta.symbol || t('portfolio.asset.unknown', { defaultValue: 'Unknown asset' })}</h1>
              {meta.chain && <span className="text-[10px] text-[var(--fg-4)]">{meta.chain}</span>}
              {sig && <MarketSignalBadge direction={sig} size="sm" />}
            </div>
            {meta.name && <div className="text-[12px] text-[var(--fg-4)] truncate">{meta.name}</div>}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wide text-[var(--fg-4)]">{t('portfolio.observed_price', { defaultValue: 'Observed price' })}</div>
          <div className="text-[18px] font-semibold text-[var(--fg-1)]">{holding?.current_price == null && marketOverview?.price == null ? '—' : fmtPrice(holding?.current_price??marketOverview?.price)}</div>
          {Number.isFinite(Date.parse(priceTime))&&<div className="intel-analysis-caption">{new Date(priceTime).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'long'})}</div>}
          <div className={`text-[12px] ${pctClass(holding?.day_pnl_pct)}`}>{fmtPct(holding?.day_pnl_pct)}</div>
        </div>
      </div>

      <AssetPortfolioPosition context={context}/>
      <ConnectedAssetSources assets={[{asset:key,label:meta.name||meta.symbol||key}]}/><ContractChartEvidenceStatus evidence={publicEvidence}/><ContractResearchWorkspace canonicalKey={key} onEvidence={publicEvidence.acceptEvidence}/>
      <div className="text-[11px] text-[var(--fg-4)]">{new Date(chartFrom).toLocaleString()} – {new Date(historyTo).toLocaleString()}</div>
      {historyYear > 0 && <p className="text-[12px] text-[var(--fg-3)]">{t('portfolio.archived_price_unavailable', { defaultValue: 'Prices are unavailable for this archived period. Your recorded activity is shown at its original time; holdings above reflect your current position.' })}</p>}
      {initialActivity.at!=null&&<p className="intel-analysis-caption">Opened from your recorded activity at <time dateTime={new Date(initialActivity.at).toISOString()}>{new Date(initialActivity.at).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'long'})}</time>. The chart resolves the original record and its effective time.</p>}
      {initialActivity.event&&target.loading&&<p role="status">Locating the selected activity…</p>}
      {target.error&&<p role="alert">The selected activity could not be loaded. <button type="button" onClick={target.retry}>Retry selected activity</button></p>}
      {initialActivity.event&&!target.loading&&!target.error&&!target.marker&&<p role="status">This activity is unavailable for this asset and portfolio. Other recorded history remains available.</p>}
      <TokenChart focusMarkerId={activityMarkerFor(markers,initialActivity.event)?.id||null} cursorTime={targetTime} key={`${user?.id}:${org?.id}:${portfolioId}:${key}:${historyYear}:${chartRange}`} assetKey={`${user?.id}:${org?.id}:${portfolioId}:${key}:${historyYear}`} loadCandles={loadCandles} markers={markers} showDensityToggles defaultRange={chartRange} persistence={{supabase,userId:user?.id,orgId:org?.id,asset:key}}
        onRangeChange={setChartRange} timeWindow={{ from: chartFrom, to: historyTo }}
        historyLoading={chartContext.loading || chartContext.loadingMore || thesisHistory.loading || thesisHistory.loadingMore} historyError={chartContext.error || thesisHistory.error ? t('portfolio.activity_unavailable', { defaultValue: 'Your activity could not be loaded.' }) : null}
        historyHasMore={!!(chartContext.nextCursor || thesisHistory.nextCursor)} onLoadMoreHistory={loadMoreHistory}/>

      {!pnlOk && !realizedOk && (
        <div className="border-b border-[var(--border-default)] rounded-none p-2.5 text-[12px] text-[var(--fg-4)]">
          {t('portfolio.asset.pnl_withheld', { defaultValue: 'P&L is withheld until cost basis is known — value and allocation are shown from the current price.' })}
        </div>
      )}

      {(marketCap != null || mc.liquidity != null) && (
        <dl className="intel-event-facts">
          {marketCap != null && <><dt>{t('portfolio.asset.market_cap', { defaultValue: 'Market cap' })}</dt><dd>{usd(marketCap)} <span className="text-xs text-[var(--fg-4)]">{marketCapSource || 'Source unavailable'} · {marketCapTime ? new Date(marketCapTime).toLocaleString(undefined, {timeZoneName:'short'}) : 'Observation time unavailable'}</span></dd></>}
          {mc.liquidity != null && <><dt>{t('portfolio.asset.liquidity', { defaultValue: 'Liquidity' })}</dt><dd>{usd(mc.liquidity)}</dd></>}
        </dl>
      )}

      {chartIdentity && (
        <div className="intel-investigation-controls"><Link to={`/intel/asset/${encodeURIComponent(key)}`} className="btn btn--ghost btn--sm inline-flex">
          {t('portfolio.asset.open_market', { defaultValue: 'Open full market data' })} <ExternalLink className="h-3.5 w-3.5" />
        </Link><Link to={`/intel/investigate?asset=${encodeURIComponent(key)}&portfolio=${encodeURIComponent(portfolioId)}`} className="intel-text-link">Open connected research</Link></div>
      )}

      {/* Why I own this — the thesis behind the position (or an entry point to create one) */}
      <BookCalendar asset={key} portfolioId={portfolioId} chartLane/>
      {meta.symbol && <AssetThesisModule symbol={meta.symbol} chain={holding?.chain} canonicalAssetKey={key} />}

      <section className="space-y-2">
        <span className="eyebrow">{t('portfolio.asset.history', { defaultValue: 'Transaction history' })}</span>
        <div className="flex items-center gap-4 flex-wrap text-xs text-[var(--fg-4)]"><button className="underline underline-offset-4" onClick={() => setHistoryYear((v) => v + 1)}>{t('portfolio.earlier_year', { defaultValue: 'Earlier year' })}</button><span>{new Date(historyTo - 365 * 86400000).toLocaleDateString()} – {new Date(historyTo).toLocaleDateString()}</span><button disabled={historyYear === 0} className="underline underline-offset-4 disabled:opacity-30" onClick={() => setHistoryYear((v) => Math.max(0, v - 1))}>{t('portfolio.later_year', { defaultValue: 'Later year' })}</button></div>
        {context.coverage?.hasUndatedActivity && <p className="text-xs text-[var(--fg-4)]">{t('portfolio.undated_activity', { defaultValue: 'Some records have no transaction time and cannot be placed on a chart. They remain in portfolio activity.' })}</p>}
        {!activity.length ? (
          <div className="border-b border-[var(--border-default)] rounded-none p-6 text-center text-[13px] text-[var(--fg-4)]">{loading ? t('portfolio.loading_activity', { defaultValue: 'Loading activity…' }) : error ? t('portfolio.activity_unavailable', { defaultValue: 'Your activity could not be loaded.' }) : t('portfolio.no_history_period', { defaultValue: 'No recorded activity in this period.' })}</div>
        ) : (
          <div className="space-y-1.5">
            {activity.map((it) => {
              const legs = (it.lineItems || []).filter((l) => l.canonical_asset_key === key)
              const exp = it.txRef && it.chain ? explorerTxUrl(it.chain, it.txRef) : null
              return (
                <div key={`${it.kind}:${it.id}`} className="border-b border-[var(--border-default)] rounded-none p-2.5 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] text-[var(--fg-1)] flex items-center gap-2 truncate">
                      <span className="text-[9px] uppercase">{typeLabel(it.type, t)}</span>
                      <span className="truncate">{it.title || typeLabel(it.type, t)}</span>
                      {it.kind === 'manual' && <span className="text-[9px] text-[var(--fg-5)]">{t('portfolio.manual', { defaultValue: 'manual' })}</span>}
                      {it.status !== 'success' && <span className="text-xs text-[var(--fg-4)]">{it.status}</span>}
                    </div>
                    <div className="text-[11px] text-[var(--fg-5)] mt-0.5 flex items-center gap-2">
                      {it.timestamp ? <time dateTime={it.timestamp}>{new Date(it.timestamp).toLocaleString()}</time> : ''}
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
                    {it.notes && <p className="text-sm whitespace-pre-wrap break-words text-[var(--fg-2)] leading-relaxed mt-3">{it.notes}</p>}
                  </div>
                  <div className="text-right flex-shrink-0">
                    {legs.map((leg, index) => <div key={leg.id || index}>
                      {leg.amount != null && <div className={`text-[12px] ${leg.direction === 'out' ? 'text-red-400' : 'text-[var(--ok)]'}`}>{leg.direction === 'out' ? '−' : leg.direction === 'in' ? '+' : ''}{fmtAmt(leg.amount)}</div>}
                      {leg.value_usd_at_tx != null && <div className="text-[11px] text-[var(--fg-4)]">{usd(leg.value_usd_at_tx)}{['current_price_estimate', 'zero_value_unpriced'].includes(leg.price_source_at_tx) ? ` · ${t('portfolio.estimated', { defaultValue: 'Estimated' })}` : ''}</div>}
                    </div>)}
                  </div>
                </div>
              )
            })}
          </div>
        )}
        {context.nextCursor && <button className="btn btn--ghost rounded-none" disabled={context.loadingMore} onClick={context.loadMore}>{t('portfolio.load_more_activity', { defaultValue: 'Load more activity' })}</button>}
      </section>

      <IntelDisclaimer />
    </div>
  )
}

export default function PortfolioAssetPage(){const {portfolioId,assetKey}=useParams(),location=useLocation();const {user}=useSupabase(),{org}=useProfile();return <PortfolioAssetPageBody key={`${user?.id}:${org?.id}:${portfolioId}:${assetKey}:${location.search}`}/>}
