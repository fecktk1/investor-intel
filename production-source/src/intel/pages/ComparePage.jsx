import ComparisonThread from '../components/ComparisonThread'
import ComparisonActivity from '../components/ComparisonActivity'
import {useLiveHistoryEnd} from '../lib/useLiveHistoryEnd'
import React, { useState, useMemo, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'
import { Scale } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { CHAINS } from '../lib/chains'
import { resolveEntity } from '../lib/watchlist-api'
import { canonicalPortfolioKey } from '../lib/asset-identity'
import {portfolioAssetChartRef} from '../lib/portfolio-markers'
import {portfolioMarketDisplay} from '../lib/portfolio-asset-display'
import { loadThesisChart } from '../lib/thesis-chart'
import { loadMarketCandleSnapshot } from '../lib/markets-api'
import {requestChartWorkspace} from '../lib/chart-workspace-api'
import { useArtifact } from '../lib/useArtifact'
import { chartAsset, validateChartLayout } from '../../../supabase/functions/_shared/intel/chart-workspace-contract'
import { comparisonTimeline } from '../lib/chart-comparison'
import ArtifactView from '../components/ArtifactView'
import MultiTokenChart from '../components/MultiTokenChart'
import ChartLayoutLibrary from '../components/ChartLayoutLibrary'
import ChartSnapshotSave from '../components/ChartSnapshotSave'
import IntelDisclaimer from '../components/IntelDisclaimer'
import ConnectedAssetSources from '../components/ConnectedAssetSources'

export function comparisonLinkAssets(raw) {
  try {
    const items = JSON.parse(raw || '[]')
    if (!Array.isArray(items) || items.length > 4) return []
    const seen = new Set()
    return items.map(item => {
      const asset = chartAsset(item.sourceProvider && item.providerId ? `market:${item.sourceProvider}:${item.providerId}` : item.canonicalAssetKey)
      const label = String(item.displayName || item.symbol || asset).slice(0, 120)
      if (seen.has(asset)) throw Error('Duplicate comparison asset')
      seen.add(asset)
      return { asset, label, symbol: item.symbol || null }
    })
  } catch { return [] }
}
export function comparisonChartResult(asset,result){
  const ref=portfolioAssetChartRef(canonicalPortfolioKey(asset.asset))?.ref
  const metadata=portfolioMarketDisplay(result,ref)
  const labelKey=canonicalPortfolioKey(asset.label),automatic=!asset.label||asset.label===asset.asset||labelKey&&labelKey===canonicalPortfolioKey(asset.asset)
  return {...result,...asset,label:automatic?(metadata?.entity?.name||metadata?.entity?.symbol||asset.label||asset.asset):asset.label,logo:metadata?.overview?.image_url||null}
}
function AssetInput({ label, val, set, t }) {
  return <fieldset><legend>{label}</legend><label>Chain<select className="select" value={val.chain} onChange={e => set({ ...val, chain: e.target.value })}>{CHAINS.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label><label>Asset address<input className="input" placeholder={t('compare.ph', { defaultValue: 'Token mint / contract address' })} value={val.value} onChange={e => set({ ...val, value: e.target.value })} /></label></fieldset>
}
function CompareWorkspace({ threadId, initialAssets, initialView, initialPeriod, initialLayoutId, onOpenLayout, onSelectAssets, supabase, userId, orgId }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const [a, setA] = useState({ chain: 'solana', value: '' }), [b, setB] = useState({ chain: 'ethereum', value: '' })
  const [assets, setAssets] = useState(initialAssets), [series, setSeries] = useState([]), [period, setPeriod] = useState(initialPeriod)
  const [view, setView] = useState(initialView), [resolving, setResolving] = useState(Boolean(initialLayoutId||initialAssets.length>=2)), [err, setErr] = useState(null), [notice, setNotice] = useState(null)
  const [restoredLayout,setRestoredLayout]=useState(null)
  const [eventTime,setEventTime]=useState(null)
  const historyEnd=useLiveHistoryEnd(orgId)
  const activityFrom=view.range?.from??historyEnd-({'24H':1,'7D':7,'1M':30,'3M':90,'1Y':365}[period]||7)*86400000,activityTo=view.range?.to??historyEnd
  const cmp = useArtifact(assets.map(a=>a.asset).join('|')), generation = useRef(0), alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false; ++generation.current } }, [])
  const load = async (selected, window = period) => {
    if (!orgId || selected.length < 2) return
    const request = ++generation.current
    setEventTime(null); setAssets(selected); setSeries([]); setResolving(true); setErr(null); setNotice(null); cmp.setResult(null)
    const results = await Promise.allSettled(selected.map(async asset => {
      const match = /^market:(coinmarketcap|coingecko):(.+)$/.exec(asset.asset)
      const result = match ? await loadMarketCandleSnapshot(supabase, orgId, asset.symbol, window, { sourceProvider: match[1], providerId: match[2] })
        : await loadThesisChart(supabase, orgId, { subject_canonical_key: asset.asset }, window)
      return comparisonChartResult(asset,result)
    }))
    if (!alive.current || generation.current !== request) return
    setAssets(selected.map((asset,i)=>results[i].status==='fulfilled'?{...asset,label:results[i].value.label}:asset))
    setSeries(results.map((r, i) => r.status === 'fulfilled' ? r.value : { ...selected[i], candles: [], error: r.reason?.message || 'Price history is unavailable. Retry this comparison.' }))
    setResolving(false)
  }
  useEffect(() => {
    if(initialLayoutId){
      setResolving(true)
      void requestChartWorkspace({supabase,userId,orgId},{operation:'get',id:initialLayoutId}).then(async ({layout:full})=>{
        if(!alive.current)return
        await restore(full.state)
        if(alive.current)setRestoredLayout(full)
      }).catch(error=>{if(alive.current){setErr(error.message);setResolving(false)}})
    }else if(initialAssets.length>=2)void load(initialAssets,initialPeriod)
  },[]) // eslint-disable-line react-hooks/exhaustive-deps
  const manual = async () => {
    const request = ++generation.current; setResolving(true); setErr(null); cmp.setResult(null)
    try {
      const entities = await Promise.all([a, b].map(v => resolveEntity(supabase, orgId, { kind: 'asset', chain: v.chain, value: v.value.trim() })))
      if (!alive.current || generation.current !== request) return
      const next = entities.map(e => ({ asset: chartAsset(canonicalPortfolioKey(e.canonical_ref_key) || e.canonical_ref_key), label: e.display_symbol || e.canonical_ref_key, symbol: e.display_symbol, entity: e }))
      if (next[0].asset === next[1].asset) throw Error('Choose two different asset identities.')
      // Route restoration performs the one chart read. Do not start a second
      // transient read just before the new identity-scoped workspace mounts.
      onSelectAssets(next,{...view,range:null},period)
    } catch (error) { if (alive.current && generation.current === request) { setErr(error.message); setResolving(false) } }
  }
  const explain = () => cmp.generate({ artifactType: 'token_comparison', entityId: assets[0]?.entity?.id || null,
    context: { assets: assets.map(a => a.entity ? { ref: a.asset, symbol: a.symbol, chain: a.entity.chain_namespace, asset_id: a.entity.asset_id } : { canonicalKey: a.asset, symbol: a.symbol, ...(/^market:/.test(a.asset) ? { sourceProvider: a.asset.split(':')[1], providerId: a.asset.split(':').slice(2).join(':') } : {}) }) },
    extra: { title: assets.map(a => a.label).join(' vs '), symbols: assets.map(a => a.symbol).filter(Boolean) } })
  const capture = () => {
    const model = comparisonTimeline(series)
    if (model.times.length < 2) throw Error('Load at least two price observations before saving a comparison view.')
    return validateChartLayout({ schemaVersion: 1, asset: assets[0].asset, range: view.range || { from: activityFrom, to: activityTo }, studies: [], drawings: [], timezone: view.timezone,
      comparison: { assets: assets.map(({ asset, label }) => ({ asset, label })), arrangement: view.arrangement, priceScale: view.priceScale, period } })
  }
  const restore = async input => {
    const layout = validateChartLayout(input)
    if (!layout.comparison) throw Error('Open this single-asset layout from its asset chart.')
    setPeriod(layout.comparison.period); setView({ ...layout.comparison, range: layout.range, timezone: layout.timezone }); await load(layout.comparison.assets, layout.comparison.period)
  }
  const copyView = async () => {
    try {
      const layout = capture(), params = new URLSearchParams()
      // Share only public asset identities and view controls, never annotations or holdings.
      params.set('assets', JSON.stringify(assets.map(a => ({ canonicalAssetKey: a.asset }))))
      params.set('view', JSON.stringify({ arrangement: view.arrangement, priceScale: view.priceScale, range: layout.range, timezone: layout.timezone }))
      params.set('period', period)
      await navigator.clipboard.writeText(`${location.origin}/intel/compare?${params}`)
      if (alive.current) setNotice('Comparison view copied. It contains asset identities and chart controls; recipients load the available market history in their own workspace.')
    } catch (error) { if (alive.current) setErr(error.message || 'Copy failed. Save the layout and retry.') }
  }
  return <div className="space-y-5">
    <ComparisonThread id={threadId} assets={assets} period={period} view={view}/>
    <div className="intel-compare-heading"><div><div className="eyebrow flex items-center gap-1.5"><Scale className="h-3.5 w-3.5" />{t('brand.name', { defaultValue: 'Investor Intel' })}</div><h1 className="page-title">{t('nav.compare', { defaultValue: 'Compare' })}</h1><p className="page-sub">{assets.length ? assets.map(a => a.label).join(" / ") : initialLayoutId ? t("compare.opening_saved",{defaultValue:"Opening saved comparison…"}) : "Read price movement together, then compare the evidence behind each asset."}</p></div><ChartLayoutLibrary context={{ supabase, userId, orgId }} comparisons canSave={!resolving && series.length > 1 && series.every(s => s.candles?.length)} capture={capture} onLoad={onOpenLayout} restoredLayout={restoredLayout} /></div>
    {!assets.length && (!initialLayoutId||err) && <><div className="intel-compare-inputs"><AssetInput label="Asset A" val={a} set={setA} t={t} /><AssetInput label="Asset B" val={b} set={setB} t={t} /></div><button className="btn btn--primary" disabled={resolving || !orgId || !a.value.trim() || !b.value.trim()} onClick={manual}>{resolving ? 'Resolving assets…' : 'Compare'}</button><p className="intel-analysis-caption">You can also select up to four assets in Markets and choose Compare selected.</p></>}

    {err && <p role="alert">{err}</p>}{notice && <p role="status">{notice}</p>}
    {(series.length > 0 || resolving) && <MultiTokenChart timeWindow={{from:activityFrom,to:activityTo}} eventTime={eventTime} series={series} loading={resolving} view={view} onViewChange={setView} controls={<><label>History period<select value={period} onChange={e => { setPeriod(e.target.value); setView(v => ({ ...v, range: null })); void load(assets, e.target.value) }}>{['24H', '7D', '1M', '3M', '1Y'].map(p => <option key={p}>{p}</option>)}</select></label><button type="button" disabled={resolving} onClick={() => load(assets)}>Refresh comparison</button></>} actions={<><ChartSnapshotSave key={`snapshot:${userId}:${orgId}:${assets.map(a=>a.asset).join(",")}`} context={{supabase,userId,orgId,asset:assets[0]?.asset}} captureLayout={capture} seriesCapture={{series:series.map(s=>({asset:s.asset,...s.capture}))}} /><button type="button" onClick={copyView}>Copy comparison view</button></>} />}
    {series.length > 1 && <ComparisonActivity timezone={view.timezone} assets={assets} from={activityFrom} to={activityTo} onEventTime={setEventTime}/>}
    {series.length > 1 && <button className="btn btn--quiet" disabled={cmp.loading || resolving || series.some(s => s.error || !s.candles.length)} onClick={explain}>{cmp.loading?'Comparing the evidence…':t('compare.explain_tradeoffs', { defaultValue: 'Explain tradeoffs' })}</button>}
    <ConnectedAssetSources key={assets.map(a=>a.asset).join('|')} assets={assets} label="Compare underlying market evidence"/>
    {assets.length > 0 && <details><summary>Choose two assets by address</summary><div className="intel-compare-inputs"><AssetInput label="Asset A" val={a} set={setA} t={t} /><AssetInput label="Asset B" val={b} set={setB} t={t} /></div><button className="btn" disabled={resolving || !a.value.trim() || !b.value.trim()} onClick={manual}>Compare addresses</button></details>}
    {cmp.error && <p role="alert">{cmp.error}</p>}<ArtifactView result={cmp.result} loading={cmp.loading} /><IntelDisclaimer variant="block" />
  </div>
}
export default function ComparePage() {
  const { org } = useProfile(), { supabase, user } = useSupabase(), [params,setParams] = useSearchParams()
  const raw = params.get('assets') || '[]', assets = useMemo(() => comparisonLinkAssets(raw), [raw])
  const period = ['24H', '7D', '1M', '3M', '1Y'].includes(params.get('period')) ? params.get('period') : '7D'
  let view = { arrangement: 'overlay', priceScale: 'independent', timezone: 'UTC' }
  try { const parsed = JSON.parse(params.get('view') || '{}'); const checked = validateChartLayout({ schemaVersion: 1, asset: assets[0]?.asset, range: parsed.range, timezone: parsed.timezone, studies: [], drawings: [], comparison: { assets, period, arrangement: parsed.arrangement, priceScale: parsed.priceScale } }); view = { ...checked.comparison, range: checked.range, timezone: checked.timezone } } catch { /* malformed view cannot change the identities or request bounds */ }
  const returnTo=params.get('returnTo')||''
  const validReturn=returnTo.length<=2000&&/^\/intel\/investigate(?:\?[^#\\\r\n]*)?$/.test(returnTo)
  const layoutId=params.get('layout')||null
  const openLayout=(_state,full)=>{const next=new URLSearchParams();next.set('layout',full.id);if(validReturn)next.set('returnTo',returnTo);if(params.get('thread'))next.set('thread',params.get('thread'));setParams(next)}
  const selectAssets=(selected,selectedView,selectedPeriod)=>{const next=new URLSearchParams(params);next.delete('layout');next.set('assets',JSON.stringify(selected.map(a=>({canonicalAssetKey:a.asset,displayName:a.label,symbol:a.symbol}))));next.set('period',selectedPeriod);next.set('view',JSON.stringify({arrangement:selectedView.arrangement,priceScale:selectedView.priceScale,timezone:selectedView.timezone}));setParams(next)}
  return <>{validReturn&&<a className="intel-text-link" href={returnTo}>Return to cohort</a>}<CompareWorkspace threadId={params.get('thread')} key={`${user?.id}:${org?.id}:${raw}:${layoutId}`} initialLayoutId={layoutId} onOpenLayout={openLayout} onSelectAssets={selectAssets} initialAssets={assets} initialView={view} initialPeriod={period} supabase={supabase} userId={user?.id} orgId={org?.id} /></>
}
