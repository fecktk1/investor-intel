import {useMarketScreen} from '../lib/useMarketScreen'
import React, { useEffect, useState, useCallback, useMemo, lazy, Suspense } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Compass, Search, TrendingUp, TrendingDown, Star, ArrowRight, ExternalLink, BarChart3, Activity, AlertTriangle, ArrowLeftRight, Dices, Globe } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { CHAINS, detectAddressKind, assetRef } from '../lib/chains'
import { entityHref, listWatchlist } from '../lib/watchlist-api'
import { loadMarkets, loadDegenMarkets, locateToken, loadMarketMacro, suggestMarketAssets } from '../lib/markets-api'
import MarketSearchTypeahead from '../components/MarketSearchTypeahead'
import { DemoNotTracked, DemoOutsideScreen } from '../demo/DemoNotInSnapshot'
import { isIntelDemoActive } from '../demo/demo-mode'
import { formatPrice, formatPct, formatUsd, timeAgo, pctClass } from '../lib/market-format'
import { marketPanelHref } from '../lib/market-links'
import AssetInspector from '../components/AssetInspector'
import MarketMacroBar from '../components/MarketMacroBar'
import MarketsTable, { MARKET_COLUMNS, DEFAULT_MARKET_COLUMNS, marketRowKey } from '../components/MarketsTable'
import DisplayOptions, { orderedKeys } from '../components/DisplayOptions'
import { useWorkspacePreference } from '../context/PersonalWorkspace'
import { useScreenParams } from '../lib/useScreenParams'
import { useColumnSort } from '../lib/useColumnSort'
import MemecoinTable from '../components/MemecoinTable'
import ChainHeatmap from '../components/ChainHeatmap'
import MarketMoverCards from '../components/MarketMoverCards'
import CrossExchangeSpreadCard from '../components/CrossExchangeSpreadCard'
import IntelDisclaimer from '../components/IntelDisclaimer'
import RegimeBanner from '../components/RegimeBanner'
import RankMovers from '../components/RankMovers'
import RecentlyDiscovered from '../components/RecentlyDiscovered'
// Movers ranked against each asset's OWN trailing distribution, beside (never
// instead of) the fixed top movers and top losers lists further down the page.
import UnusualForThisAsset from '../components/UnusualForThisAsset'
import FigureProvenance from '../components/FigureProvenance'
import FigureSourceLine from '../components/FigureSourceLine'
import { IntelMetricCard, IntelPageHeader, IntelPageShell, IntelTabs } from '../components/IntelPrimitives'

// Markets mode: canonical top-1000 by market cap + CEX/DEX enrichment.
const SORTS = ['market_cap', 'volume', 'gainers', 'losers', 'change_1h', 'change_24h', 'change_7d', 'exchange_availability', 'arbitrage', 'unusual_volume', 'multi_exchange_strength', 'recently_updated']
// Degen mode: multi-chain memecoin terminal.
// Mirrors DEGEN_SORT_KEYS in supabase/functions/_shared/memecoin/degen-query.ts.
// The drawer offers every order the table headers can also produce, so the two
// controls never disagree about what the screen is showing.
const DEGEN_SORTS = ['trending', 'volume', 'gainers', 'losers', 'liquidity', 'new', 'market_cap', 'price', 'change_1h', 'change_24h', 'fdv', 'buys', 'sells', 'txns', 'risk', 'age']
const DEGEN_BUCKETS = ['hot', 'new', 'pumpfun', 'migrated', 'trending', 'takeovers', 'established', 'high_volume', 'high_liquidity', 'high_risk', 'watchlist']
const DEGEN_CHAINS = ['solana', 'ethereum', 'base', 'bnb']
const PAGE_SIZE = 50
/** The newest clock across a list of rows that each carry their own. Returns
 *  null when no row reported one, which the source line states in words rather
 *  than filling with the time the page was opened. */
export const newestStamp = (rows, key) => {
  const stamps = (Array.isArray(rows) ? rows : []).map(row => Date.parse(String(row?.[key] ?? ''))).filter(Number.isFinite)
  return stamps.length ? new Date(Math.max(...stamps)).toISOString() : null
}
const ScreenVerification=import.meta.env.DEV?lazy(()=>import('../dev/ScreenVerification')):null
// Route-level split: the chart kit is only paid for by readers who open the
// market context rail or the Degen screen.
const MarketsCharts = lazy(() => import('../components/MarketsCharts'))
const RegimeRibbon = lazy(() => import('../components/RegimeRibbon'))
// INTEGRATION POINTS. DegenCharts (Degen screen / intel-degen contract) and
// AssetResolveResult (asset resolver) are owned by other work in flight. A bare
// dynamic import of a file that does not exist yet fails at transform time, so
// they are looked up through a build-time glob instead: absent, the screen
// renders without the figure; present, it is code-split and mounted with no
// further change here.
const OPTIONAL_COMPONENTS = { ...import.meta.glob('../components/DegenCharts.jsx'), ...import.meta.glob('../components/AssetResolveResult.jsx') }
const optionalComponent = name => lazy(async () => {
  const load = OPTIONAL_COMPONENTS[`../components/${name}.jsx`]
  if (!load) return { default: () => null }
  try { const mod = await load(); return { default: mod?.default || (() => null) } } catch { return { default: () => null } }
})
const DegenCharts = optionalComponent('DegenCharts')
const AssetResolveResult = optionalComponent('AssetResolveResult')
// Returns markets-api.resolveAsset once that export exists, else null so the
// caller keeps the behaviour it has today.
const loadResolver = async () => {
  try { const api = await import('../lib/markets-api'); return typeof api.resolveAsset === 'function' ? api.resolveAsset : null } catch { return null }
}

// Investor Intel — Markets terminal. Two modes: a CMC-style top-1000 markets
// view (canonical market-cap universe + CEX/DEX enrichment) and a separate
// multi-chain Degen memecoin terminal. All data is read from cached tables via
// edge functions — never a live provider call on render.
export default function MarketsPage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase, user } = useSupabase()
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const mode = searchParams.get('mode') === 'degen' ? 'degen' : 'markets'
  const setMode = useCallback((m) => { const np = new URLSearchParams(searchParams); if (m === 'degen') np.set('mode', 'degen'); else np.delete('mode'); setSearchParams(np, { replace: true }) }, [searchParams, setSearchParams])

  const [watchState, setWatchState] = useState(null)
  const ownerScope = `${user?.id}:${org?.id}`
  const watch = watchState?.scope === ownerScope ? watchState.rows : []
  const [inspected, setInspected] = useState(null)
  const contextOpen = searchParams.get('context') === '1'
  const [contextRetry, setContextRetry] = useState(0)
  const [macroError, setMacroError] = useState(null)
  const [macroLoading, setMacroLoading] = useState(false)
  const [form, setForm] = useState({ chain: '', value: '' })
  const [opening, setOpening] = useState(false)
  const [err, setErr] = useState(null)
  const [candidates, setCandidates] = useState(null)
  const [resolution, setResolution] = useState(null)
  const [macro, setMacro] = useState(null)
  const [params, setParams] = useScreenParams('m_', { provider: 'auto', sort: 'market_cap', dir: '', chain: '', search: '', category: '', signalDirection: '', watchlistOnly: false, view: '', page: 0, limit: PAGE_SIZE })

  const [degenState, setDegenState] = useState(null)
  const [degenFailure, setDegenError] = useState(null)
  const [degenRetry, setDegenRetry] = useState(0)
  const [degenLoading, setDegenLoading] = useState(true)
  // d_dir and d_showExcluded are the Degen screen's half of the shared contract
  // (see the intel-degen request body below): direction is explicit so a Degen
  // link reproduces its order, and excluded rows stay a deliberate choice.
  const [degenParams, setDegenParams] = useScreenParams('d_', { sort: 'trending', dir: 'desc', search: '', chain: '', bucket: '', riskMax: '', minLiquidity: '', showExcluded: false, page: 0, limit: PAGE_SIZE })
  const degenScope = `${ownerScope}:${JSON.stringify(degenParams)}`
  const degenData = degenState?.scope === degenScope ? degenState.data : null
  const degenError = degenFailure?.scope === degenScope ? degenFailure.message : null

  const selectionKey = `intel:screen:${user?.id || ''}:${org?.id || ''}`
  const [screenStore, setScreenStore] = useState({ key: null, selected: [], saved: [] })
  const [screenName, setScreenName] = useState('')
  const display = useWorkspacePreference('markets')
  const columnOrder = orderedKeys(MARKET_COLUMNS, display.value.columnOrder)
  // Without a saved preference the screen shows the default set, not every
  // registered column: the supply/pairs/dominance columns are opt-in through
  // Display options rather than a wider table for readers who never asked.
  const columns = searchParams.has('columns') ? searchParams.get('columns').split(',').filter(Boolean) : columnOrder.filter(key => Array.isArray(display.value.columns) ? display.value.columns.includes(key) : DEFAULT_MARKET_COLUMNS.includes(key))
  const changeColumns = (order, visible) => {
    const next = new URLSearchParams(searchParams); next.set('columns', visible.join(',')); setSearchParams(next, { replace: true })
    display.save({ columnOrder: order, columns: visible }).catch(error => setErr(error.message))
  }
  const selected = screenStore.key === selectionKey ? screenStore.selected : []
  const savedScreens = screenStore.key === selectionKey ? screenStore.saved : []
  useEffect(() => {
    try { const stored = JSON.parse(localStorage.getItem(selectionKey) || '{}'); setScreenStore({ key: selectionKey, selected: Array.isArray(stored.selected) ? stored.selected.slice(0, 4) : [], saved: Array.isArray(stored.saved) ? stored.saved.slice(0, 20) : [] }) }
    catch { setScreenStore({ key: selectionKey, selected: [], saved: [] }) }
  }, [selectionKey])
  const saveScreenStore = next => { const value = { ...next, key: selectionKey }; setScreenStore(value); try { localStorage.setItem(selectionKey, JSON.stringify(value)) } catch { setErr(t('markets.storage_failed', { defaultValue: 'Browser storage is unavailable. Keep this screen open to retain your selection.' })) } }
  const toggleSelection = row => {
    const key = marketRowKey(row)
    saveScreenStore({ saved: savedScreens, selected: selected.some(r => marketRowKey(r) === key) ? selected.filter(r => marketRowKey(r) !== key) : [...selected.slice(-3), { sourceProvider: row.sourceProvider, providerId: row.providerId, symbol: row.symbol, displayName: row.displayName, canonicalAssetKey: row.canonicalAssetKey }] })
  }
  const screenControls = <div className="intel-screen-tools py-2">
      <label className="text-xs text-[var(--fg-4)]">{t('markets.saved_screens', { defaultValue: 'Saved screens' })} <select className="select ml-2" defaultValue="" onChange={e => { if (e.target.value) setSearchParams(new URLSearchParams(e.target.value)) }}><option value="">{t('markets.choose_screen', { defaultValue: 'Choose a screen' })}</option>{savedScreens.map(item => <option key={item.name} value={item.query}>{item.name}</option>)}</select></label>
      <details className="intel-screen-editor"><summary>{t('markets.manage_screen', { defaultValue: 'Save or manage screen' })}</summary><div className="intel-screen-editor-fields">
      <input aria-label={t('markets.screen_name', { defaultValue: 'Screen name' })} className="input text-xs" placeholder={t('markets.screen_name', { defaultValue: 'Screen name' })} maxLength={60} value={screenName} onChange={e => setScreenName(e.target.value)}/>
      <button className="btn btn--quiet text-xs" disabled={!screenName.trim()} onClick={() => { saveScreenStore({ selected, saved: [...savedScreens.filter(x => x.name !== screenName.trim()).slice(-19), { name: screenName.trim(), query: searchParams.toString() }] }); setScreenName('') }}>{t('markets.save_screen', { defaultValue: 'Save screen' })}</button>
      {screenName && savedScreens.some(s => s.name === screenName) && <button className="btn btn--quiet" onClick={() => saveScreenStore({ selected, saved: savedScreens.filter(s => s.name !== screenName) })}>{t('common.delete', { defaultValue: 'Delete' })}</button>}
      <span className="intel-event-meta">{t('markets.browser_saved', { defaultValue: 'Saved in this browser' })}</span>
      </div></details>
    {mode === 'markets' && <DisplayOptions label={t('markets.columns', { defaultValue: 'Columns' })} items={MARKET_COLUMNS.map(([key,label]) => [key,t(`markets.column_${key}`, { defaultValue: label })])} order={columnOrder} visible={columns} onChange={changeColumns} disabled={display.loading || !!display.error}/>}
    {display.error && <p role="alert">{display.error} <button onClick={display.reload}>{t('common.reload', { defaultValue: 'Reload' })}</button></p>}
{!!selected.length && <div className="intel-selection-summary">{selected.length >= 2 && <Link className="btn btn--primary text-xs" to={`/intel/compare?assets=${encodeURIComponent(JSON.stringify(selected))}`}>{t('markets.compare_selection', { defaultValue: 'Compare selected' })} ({selected.length})</Link>}{selected.length < 2 && <span>{selected.length} {t('markets.selected', { defaultValue: 'selected for comparison' })}</span>}<button onClick={() => saveScreenStore({ saved: savedScreens, selected: [] })}>{t('markets.clear_selection', { defaultValue: 'Clear selection' })}</button></div>}
  </div>

  // front-door data (chain browser + watchlist links) — markets mode only
  useEffect(() => {
    if (!org?.id || mode !== 'markets' || !contextOpen) return
    let alive = true
    ;(async () => {
      try {
        setWatchState({ scope: ownerScope, rows: [], loading: true })
        const wl = await listWatchlist(supabase, org.id)
        if (!alive) return
        setWatchState({ scope: ownerScope, rows: (wl || []).filter((i) => ['token', 'defi', 'asset'].includes(i.item_type) && i.entity?.canonical_ref_key) })
      } catch { if (alive) setWatchState({ scope: ownerScope, rows: [], error: true }) }
    })()
    return () => { alive = false }
  }, [org?.id, supabase, mode, ownerScope, contextOpen, contextRetry])

  // Global crypto-market macro header (markets mode) — cached table read, no edge call.
  useEffect(() => {
    if (mode !== 'markets' || !contextOpen) return
    let alive = true
    setMacroLoading(true); setMacroError(null)
    // The reported reason is retained, not flattened to a boolean: the charts
    // and the macro bar both have to say why the read failed.
    loadMarketMacro(supabase).then(m => { if (alive) setMacro(m) }).catch(error => { if (alive) setMacroError(error?.message || t('markets.macro_failed', { defaultValue: 'Global observations could not be read.' })) }).finally(() => { if (alive) setMacroLoading(false) })
    return () => { alive = false }
  }, [supabase, mode, contextOpen, contextRetry])

  // Column order lives in the URL (m_sort / m_dir) so a shared or restored
  // screen reproduces the exact order its reader was looking at. Reordering
  // returns to page 1: page 7 of the previous order describes nothing.
  const setSort = useCallback(({ sort, dir }) => setParams(p => ({ ...p, sort, dir, page: 0 })), [setParams])
  // Rank reads naturally from 1 upward and a drawdown from its deepest (most
  // negative) end, so both start ascending — the same two directions the
  // database defaults them to. Every other column starts descending.
  const ASCENDING_FIRST = ['rank', 'drawdown']
  const columnSort = useColumnSort({ sort: params.sort, dir: params.dir, setSort, defaultSort: 'market_cap', defaultDir: ASCENDING_FIRST.includes(params.sort) ? 'asc' : 'desc', initialDir: key => ASCENDING_FIRST.includes(key) ? 'asc' : 'desc' })

  // The screen is read with the clamped order, never the raw URL text: an
  // `m_dir=sideways` in a pasted link falls back to the default direction
  // instead of reaching the server.
  const screenParams = useMemo(() => ({ ...params, sort: columnSort.sort, dir: columnSort.dir }), [params, columnSort.sort, columnSort.dir])
  const {data:marketsData,pending:marketsLoading,error:marketError,refresh:refreshMarkets}=useMarketScreen({supabase,userId:user?.id,orgId:org?.id,params:screenParams,enabled:mode==='markets'})

  // degen data
  const degenKey = JSON.stringify(degenParams)
  useEffect(() => {
    if (!org?.id || mode !== 'degen') return
    let alive = true
    const handle = setTimeout(async () => {
      setDegenLoading(true); setDegenError(null)
      try {
        const body = { sort: degenParams.sort, dir: degenParams.dir === 'asc' ? 'asc' : 'desc', showExcluded: !!degenParams.showExcluded, page: degenParams.page, limit: degenParams.limit }
        if (degenParams.search) body.search = degenParams.search
        if (degenParams.chain) body.chain = degenParams.chain
        if (degenParams.bucket) body.bucket = degenParams.bucket
        if (degenParams.minLiquidity !== '') body.minLiquidity = Number(degenParams.minLiquidity)
        if (degenParams.riskMax) body.riskMax = Number(degenParams.riskMax)
        const d = await loadDegenMarkets(supabase, org.id, body)
        if (alive) setDegenState({ scope: degenScope, data: d })
      } catch { if (alive) { setDegenError({ scope: degenScope, message: t('markets.load_failed', { defaultValue: 'Market data is unavailable. Refresh this screen to retry.' }) }) } }
      finally { if (alive) setDegenLoading(false) }
    }, degenParams.search ? 200 : 0)
    return () => { alive = false; clearTimeout(handle) }
  }, [org?.id, supabase, degenKey, mode, ownerScope, degenRetry])

  const setParam = useCallback((patch, keepPage = false) => setParams((p) => ({ ...p, ...patch, page: keepPage ? (patch.page ?? p.page) : 0 })), [setParams])
  // The search box hands its text over on a trailing pause, so this writes the
  // screen filter once per pause rather than once per keystroke. Stable, so the
  // field is never handed a new writer mid-word.
  const setSearchText = useCallback(search => setParam({ search }), [setParam])
  const setDegenParam = useCallback((patch, keepPage = false) => setDegenParams((p) => ({ ...p, ...patch, page: keepPage ? (patch.page ?? p.page) : 0 })), [setDegenParams])
  // The Degen table headers and the drawer select write the same two params, so
  // d_dir is a control a reader can actually reach rather than a URL-only value.
  const setDegenSort = useCallback(({ sort, dir }) => setDegenParams(p => ({ ...p, sort, dir, page: 0 })), [setDegenParams])
  const degenSort = useColumnSort({ sort: degenParams.sort, dir: degenParams.dir, setSort: setDegenSort, defaultSort: 'trending', defaultDir: 'desc' })

  // Open the rich token detail page for a pasted address. Navigates to the synthetic
  // app-style `chain:address` ref (NOT resolveEntity/CAIP) — same as the Degen/markets
  // drill-in — so no entities row is created until the user hits Add to watchlist, and
  // the page takes the working _contract synthetic path. assetRef lowercases EVM.
  const goToAsset = useCallback((chain, value) => navigate('/intel/asset/' + encodeURIComponent(assetRef(chain, value))), [navigate])

  // The Markets search box asks the shared catalogue what the typed text names.
  // One cached-table read on the free market_boards surface: it never reaches a
  // provider, so a keystroke costs nothing and a free member may search.
  const suggestAssets = useCallback((query, signal) => suggestMarketAssets(supabase, org?.id, query, { limit: 8, signal }), [supabase, org?.id])
  // A chosen suggestion opens the asset at its EXACT identity, the same address
  // the table rows link to, so a shared ticker is never resolved by guess.
  const openSuggestion = useCallback(row => { if (row?.href) navigate(row.href, { state: { from: `${location.pathname}${location.search}` } }) }, [navigate, location.pathname, location.search])

  const onOpen = useCallback(async (e) => {
    e.preventDefault()
    const value = form.value.trim()
    if (!value) return
    setErr(null); setCandidates(null); setResolution(null)
    // Explicit chain selected → honor it (most explicit intent).
    if (form.chain) { goToAsset(form.chain, value); return }
    // Auto-detect from the address shape.
    const kind = detectAddressKind(value)
    if (kind === 'solana') { goToAsset('solana', value); return } // unambiguous mint
    if (kind === 'evm') { // chain-ambiguous → resolve the asset identity
      setOpening(true)
      try {
        // INTEGRATION POINT: the shared asset resolver (markets-api.resolveAsset,
        // written alongside this screen) replaces the DexScreener-only lookup.
        // It is imported at call time and the existing locate path stays as the
        // fallback, so the form keeps working while that export lands.
        const resolve = await loadResolver()
        if (resolve) {
          const result = await resolve(supabase, value, form.chain || null)
          if (result?.status === 'resolved' && result.identity?.route) { navigate(result.identity.route); return }
          // An identity-only asset IS resolved: the chain named it and no market
          // source prices it. It keeps its route, so the read-out is shown with
          // its own label and its own way in, rather than the form reporting
          // "couldn't find that token" about an asset it just identified.
          if (result?.status === 'identity_only') { setResolution(result); return }
          if (result?.status === 'ambiguous' && result.candidates?.length) { setResolution(result); return }
          setErr(result?.reason || t('markets.locate_not_found', { defaultValue: "Couldn't find that token on any supported chain. Pick a chain and try again." }))
          return
        }
        const cands = await locateToken(supabase, value)
        if (!cands.length) { setErr(t('markets.locate_not_found', { defaultValue: "Couldn't find that token on any supported chain. Pick a chain and try again." })); return }
        // Auto-open a single match, or the top when it clearly dominates (≥5× runner-up liquidity); else let the user choose.
        if (cands.length === 1) goToAsset(cands[0].chain, value)
        else setCandidates(cands)
      } catch { setErr(t('markets.locate_failed', { defaultValue: 'The token lookup failed. Choose a chain or retry.' })) } finally { setOpening(false) }
      return
    }
    setErr(t('markets.pick_chain', { defaultValue: 'Select a chain for this identifier, then try again.' }))
  }, [form, supabase, t, goToAsset, navigate])

  const snap = marketsData?.snapshot || {}
  const rows = marketsData?.rows || []
  const degraded = (marketsData?.providerStatus || []).some((p) => p.degraded)
  const spreads = marketsData?.crossExchangeSpreads || []
  const total = marketsData?.total || 0
  const maxPage = Math.max(0, Math.ceil(total / params.limit) - 1)
  const hasData = useMemo(() => rows.length > 0 || (marketsData && total > 0), [rows, marketsData, total])
  // Public demo: typed text that names no tracked asset gets the calm sentence,
  // never an error; a tracked asset outside this screen is named as a link.
  const demoSearchNote = isIntelDemoActive() && params.search
    ? (marketsData?.demoReason === 'demo_untracked' ? <DemoNotTracked/> : marketsData?.demoSuggestions?.length ? <DemoOutsideScreen rows={marketsData.demoSuggestions}/> : null)
    : null
  const returnState = useMemo(() => ({ from: `${location.pathname}${location.search}` }), [location.pathname, location.search])

  const dsnap = degenData?.snapshot || {}
  const drows = degenData?.rows || []
  const dtotal = degenData?.total || 0
  const dMaxPage = Math.max(0, Math.ceil(dtotal / degenParams.limit) - 1)

  const chainRows = (marketsData?.nativeChains || []).map(p => ({chain: CHAINS.find(c => c.id === p.chain_id),perf:p})).filter(r => r.chain)

  return (
    <IntelPageShell className="intel-markets-workspace">
      {inspected?.scope === ownerScope && <AssetInspector key={`${ownerScope}:${marketRowKey(inspected.row)}`} row={inspected.row} onClose={() => setInspected(null)}/>}
      {ScreenVerification&&searchParams.get('verifyBackend')==='1'&&<Suspense fallback={null}><ScreenVerification/></Suspense>}
      <IntelPageHeader
        icon={Compass}
        title={t('nav.markets', { defaultValue: 'Markets' })}
        subtitle={mode === 'degen'
          ? t('degen.subtitle', { defaultValue: 'Multi-chain memecoin discovery and risk context. Extremely high risk - not financial advice.' })
          : t('markets.desk_subtitle', { defaultValue: 'Screen assets, compare markets and open your research and holdings.' })}
        actions={(
          <>
          <IntelTabs
            value={mode}
            onChange={setMode}
            items={[
              { value: 'markets', label: t('markets.tabMarkets', { defaultValue: 'Markets' }), icon: BarChart3 },
              { value: 'degen', label: t('markets.tabDegen', { defaultValue: 'Degen' }), icon: Dices },
            ]}
          />
      <button className="intel-context-toggle" aria-expanded={contextOpen} onClick={() => { const next = new URLSearchParams(searchParams); if (contextOpen) next.delete('context'); else next.set('context', '1'); setSearchParams(next, { replace: true }) }}>{t('markets.context_toggle', { defaultValue: 'Market context & chain overview' })} {contextOpen ? '−' : '+'}</button>
          </>
        )}
      />

      {mode === 'markets' ? (
        <>
          {/* 4. Crypto markets table */}
          <section className="space-y-2">
            {screenControls}
            {marketError && <p role="alert" className="text-sm text-[var(--fg-3)]">{t('markets.refreshFailed', {error: marketError, defaultValue: 'The market snapshot could not be refreshed: {{error}}'})} {marketsData && t('markets.lastSnapshot', {defaultValue:'Showing the last loaded snapshot.'})}</p>}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-[var(--fg-4)]">
              <button type="button" className="btn btn--ghost btn--sm" disabled={marketsLoading} onClick={refreshMarkets}>{t('common.refresh', {defaultValue:'Refresh'})}</button>
              {marketsData?.catalog && <span>{marketsData.catalog.provider==='coinmarketcap'?'CoinMarketCap':'CoinGecko'} · {t('markets.sharedSnapshot', {defaultValue:'Shared market snapshot'})}{marketsData.catalog.fallback ? ' · '+t('markets.catalogueFallback', {defaultValue:'CMC catalogue is not current; showing CoinGecko'}) : ''}</span>}
            </div>
            {/* search · sort · category · watchlist — one row, search flexes to fill */}
            <div className="intel-market-filter-toolbar">
              <MarketSearchTypeahead value={params.search} onChange={setSearchText} suggest={suggestAssets} onOpen={openSuggestion} disabled={!org?.id}/>
              <details className="intel-market-filter-options"><summary>{t('markets.filter_and_sort', { defaultValue: 'Filters & sort' })}{(params.category || params.chain || params.watchlistOnly || params.provider !== 'auto' || params.sort !== 'market_cap' || columnSort.dir !== 'desc') ? ' · ' + t('markets.custom_screen', { defaultValue: 'Custom' }) : ''}</summary><div className="intel-market-filters">
              <label className="flex items-center gap-2"><span>{t('markets.catalogue', {defaultValue:'Catalogue'})}</span><select className="select text-[12px] py-1" aria-label="Market catalogue" value={params.provider} onChange={e=>setParam({provider:e.target.value})}><option value="auto">{t('markets.cmcPreferred', {defaultValue:'CoinMarketCap preferred'})}</option><option value="coinmarketcap">CoinMarketCap</option><option value="coingecko">CoinGecko</option></select></label>
              {/* Picking an order here keeps the current direction — the header
                  glyph is the one control that flips it, so the two never
                  disagree about what the table is showing. */}
              <select className="select text-[12px] py-1" aria-label={t('markets.sortBy', { defaultValue: 'Sort by' })} value={columnSort.sort} onChange={(e) => setParam({ sort: e.target.value })} title={t('markets.sortBy', { defaultValue: 'Sort by' })}>
                {SORTS.map((s) => <option key={s} value={s}>{t(`markets.sort_${s}`, { defaultValue: s.replace(/_/g, ' ') })}</option>)}
              </select>
              <select className="select text-[12px] py-1" aria-label={t('markets.chain_filter', { defaultValue: 'Chain' })} value={params.chain} onChange={(e) => setParam({ chain: e.target.value })} title={t('markets.chain_filter', { defaultValue: 'Chain' })}>
                <option value="">{t('markets.allChains', { defaultValue: 'All chains' })}</option>
                {CHAINS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
              <select className="select text-[12px] py-1" value={params.category} onChange={(e) => setParam({ category: e.target.value })} title={t('markets.category', { defaultValue: 'Category' })}>
                <option value="">{t('markets.allCategories', { defaultValue: 'All categories' })}</option>
                {(marketsData?.availableCategories || []).map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <button type="button" onClick={() => setParam({ watchlistOnly: !params.watchlistOnly })} className={`btn btn--sm ${params.watchlistOnly ? 'btn--primary' : 'btn--ghost'}`}><Star className="h-3.5 w-3.5" /> {t('markets.watchlistOnly', { defaultValue: 'Watchlist' })}</button>
              </div></details>
            </div>

            {marketsLoading && !marketsData ? (
              <p role="status" className="py-8 min-h-[60vh] text-sm text-[var(--fg-4)]">{t('markets.loading', { defaultValue: 'Loading market observations…' })}</p>
            ) : !hasData ? (
              <p className="py-6 text-[13px] text-[var(--fg-4)]">{marketError ? t('markets.screen_read_failed', { defaultValue: 'The market screen could not be loaded. Use Refresh to retry.' }) : demoSearchNote || t('markets.screen_no_matches', { defaultValue: 'No assets match this screen. Adjust or clear the filters.' })}</p>
            ) : (
              <>
                <MarketsTable scrollScope={ownerScope} onInspect={row => setInspected({ scope: ownerScope, row })} sort={columnSort.sort} dir={columnSort.dir} onSort={columnSort.toggle} snapshot={snap} rows={rows} columns={columns} selected={selected.map(marketRowKey)} onSelect={toggleSelection} pageOffset={params.page * params.limit} />
                {maxPage > 0 && (
                  <div className="flex items-center justify-between text-[12px] text-[var(--fg-4)]">
                    <span>{t('markets.showing', { defaultValue: 'Showing' })} {params.page * params.limit + 1}–{Math.min(total, (params.page + 1) * params.limit)} {t('markets.of', { defaultValue: 'of' })} {total}</span>
                    <span className="flex items-center gap-2">
                      <button type="button" className="btn btn--ghost btn--sm" disabled={params.page <= 0} onClick={() => setParam({ page: params.page - 1 }, true)}>{t('markets.prev', { defaultValue: 'Prev' })}</button>
                      <button type="button" className="btn btn--ghost btn--sm" disabled={params.page >= maxPage} onClick={() => setParam({ page: params.page + 1 }, true)}>{t('markets.next', { defaultValue: 'Next' })}</button>
                    </span>
                  </div>
                )}
              </>
            )}
          </section>
          <RecentlyDiscovered />
          <UnusualForThisAsset />
          {contextOpen && <div className="intel-expanded-context">
          <Suspense fallback={<p role="status" className="py-6 text-sm text-[var(--fg-4)]">{t('markets.charts_loading', { defaultValue: 'Loading market figures…' })}</p>}>
            <RegimeRibbon compact />
            <MarketsCharts
              snapshot={snap}
              macro={macro}
              macroError={macroError}
              macroLoading={macroLoading}
              rows={rows}
              chains={marketsData?.chainHeatmap || []}
              categories={marketsData?.availableCategories || []}
              onChain={chain => setParam({ chain })}
              onCategory={category => setParam({ category })}
              onOpenAsset={href => navigate(href, { state: returnState })}
            />
          </Suspense>
          <RegimeBanner />
          <MarketMacroBar macro={macro} loading={macroLoading} error={macroError} onRetry={() => setContextRetry(value => value + 1)}/>
          <RankMovers />
          {/* 1. Global market snapshot */}
          {marketsData && (
            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="eyebrow flex items-center gap-1.5"><BarChart3 className="h-3.5 w-3.5" /> {t('markets.globalSnapshot', { defaultValue: 'Global market snapshot' })}</div>
                {snap.lastUpdated && <span className="text-[10px] text-[var(--fg-5)] flex items-center gap-1"><Activity className="h-3 w-3" /> {t('markets.lastUpdated', { defaultValue: 'Updated' })} {timeAgo(snap.lastUpdated)}</span>}
              </div>
              {degraded && <div className="card--flat p-2 text-[11px] text-amber-400 flex items-center gap-1.5"><AlertTriangle className="h-3.5 w-3.5" /> {t('markets.providerDegraded', { defaultValue: 'Some exchange data is delayed or unavailable; showing the latest cached values.' })}</div>}
              <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
                <Stat label={t('markets.trackedAssets', { defaultValue: 'Tracked assets' })} value={snap.trackedAssets ?? '—'} />
                <Stat label={t('markets.up24h', { defaultValue: 'Up (24h)' })} value={snap.up24h ?? '—'} cls="text-[var(--ok)]" />
                <Stat label={t('markets.down24h', { defaultValue: 'Down (24h)' })} value={snap.down24h ?? '—'} cls="text-red-400" />
                <Stat label={t('markets.trackedVolume', { defaultValue: 'Tracked 24h volume' })} value={formatUsd(snap.trackedVolumeQuote24h)} />
                <Stat label={t('markets.trackedMarketCap', { defaultValue: 'Tracked market cap' })} value={formatUsd(snap.trackedMarketCap)} sub={`${snap.cexCoveragePct ?? '—'}% ${t('markets.exchangeAvailability', { defaultValue: 'on CEX' })}`} />
                <Stat label={t('markets.strongestChain', { defaultValue: 'Strongest chain' })} value={snap.strongestChain || '—'} />
              </div>
              {/* Play 1 and 7: the screen reads the stored catalogue, so its receipt
                  describes that stored snapshot rather than a provider call. */}
              <FigureProvenance envelope={marketsData.figureProvenance?.catalogue} receipts={[marketsData.receipt]} />
            </section>
          )}

          {/* 2. Top movers */}
          {marketsData && (marketsData.topGainers?.length > 0 || marketsData.topLosers?.length > 0) && (
            <div className="grid gap-4 lg:grid-cols-2">
              <MarketMoverCards title={t('markets.topMovers', { defaultValue: 'Top movers' })} items={marketsData.topGainers} icon={TrendingUp} hrefFor={(_, row) => marketPanelHref(row)} returnState={returnState} />
              <MarketMoverCards title={t('markets.topLosers', { defaultValue: 'Top losers' })} items={marketsData.topLosers} icon={TrendingDown} hrefFor={(_, row) => marketPanelHref(row)} returnState={returnState} />
              {/* The percentage on every card is the provider's 24 hour change,
                  read back from the stored catalogue snapshot; the ORDER is ours
                  and the cards say so themselves. The provider named here is the
                  one the screen's own provenance reports for that figure, so a
                  screen served from a different source cannot be mislabelled. */}
              <div className="lg:col-span-2">
                <FigureSourceLine source={marketsData.figureProvenance?.price_change?.source || null} capturedAt={snap.lastUpdated || null} />
              </div>
            </div>
          )}

          {/* 2b. Derived views — deterministic computed sections over cached data.
              Counts come from the server; selecting a chip filters the table. */}
          {marketsData?.derivedCounts && (
            <section className="space-y-2">
              <div className="eyebrow">{t('markets.derived_views', { defaultValue: 'Derived views' })}</div>
              <div className="flex items-center gap-2 flex-wrap">
                <button onClick={() => setParam({ view: '' })} className={!params.view ? 'chip chip--accent text-[11px]' : 'chip text-[11px]'}>{t('markets.view_all', { defaultValue: 'All' })}</button>
                {[
                  ['unusual_volume', t('markets.view_unusual_volume', { defaultValue: 'Unusual volume' }), 'unusual_volume'],
                  ['vol_up_price_flat', t('markets.view_vol_up_price_flat', { defaultValue: 'Volume up · price flat' }), null],
                  ['price_up_liq_weak', t('markets.view_price_up_liq_weak', { defaultValue: 'Price up · thin liquidity ⚠' }), null],
                  ['multi_exchange', t('markets.view_multi_exchange', { defaultValue: 'Multi-exchange strength' }), 'multi_exchange_strength'],
                  ['thin_liquidity', t('markets.view_thin_liquidity', { defaultValue: 'Thin liquidity ⚠' }), null],
                ].map(([key, label, sortKey]) => (
                  <button key={key}
                    onClick={() => setParam(params.view === key ? { view: '' } : { view: key, ...(sortKey ? { sort: sortKey } : {}) })}
                    className={params.view === key ? 'chip chip--accent text-[11px]' : 'chip text-[11px]'}
                    disabled={!marketsData.derivedCounts[key]}>
                    {label} · {marketsData.derivedCounts[key] ?? 0}
                  </button>
                ))}
              </div>
              {(params.view === 'thin_liquidity' || params.view === 'price_up_liq_weak') && (
                <p className="text-[11px] text-amber-400">{t('markets.thin_liq_caution', { defaultValue: 'Caution: thin liquidity amplifies slippage and price impact, so moves here are less reliable. Research context, not advice.' })}</p>
              )}
            </section>
          )}

          {/* 2c. Watchlist movers + Category leaders (computed server-side) */}
          {(marketsData?.watchlistMovers?.length > 0 || marketsData?.categoryLeaders?.length > 0) && (
            <div className="grid gap-4 lg:grid-cols-2">
              {marketsData?.watchlistMovers?.length > 0 && (
                <MarketMoverCards title={t('markets.watchlist_movers', { defaultValue: 'Watchlist movers' })} items={marketsData.watchlistMovers} icon={TrendingUp} hrefFor={(_, row) => marketPanelHref(row)} returnState={returnState} />
              )}
              {marketsData?.categoryLeaders?.length > 0 && (
                <section className="card p-4 space-y-2">
                  <div className="eyebrow">{t('markets.category_leaders', { defaultValue: 'Category leaders' })}</div>
                  <div className="space-y-1.5">
                    {marketsData.categoryLeaders.slice(0, 6).map((c) => (
                      <div key={c.category} className="flex items-center gap-2 text-[12px] flex-wrap">
                        <button onClick={() => setParam({ category: c.category })} className="chip text-[10px]">{c.category}</button>
                        {c.leaders.map((l) => {
                          const href = marketPanelHref(l)
                          const content = <>
                            <span className="text-[var(--fg-2)] font-medium">{l.symbol}</span>
                            <span className={`tabular-nums ${l.change24hPct == null ? 'text-[var(--fg-4)]' : pctClass(l.change24hPct)}`}>{formatPct(l.change24hPct)}</span>
                          </>
                          return href ? <Link key={marketRowKey(l)} to={href} state={returnState} className="inline-flex items-center gap-1 hover:text-[var(--accent)]">{content}</Link> : <span key={marketRowKey(l)} className="inline-flex items-center gap-1">{content}</span>
                        })}
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}

          {/* 3. Chains — only chains with tracked native performance. The full
              CHAINS registry includes chains without an intel_chain_perf row,
              which would render as empty shells (no price, no 24h change). */}
          {/* The heatmap is a rollup of centralized exchange readings, each chain
              row carrying its own `as_of`; the line quotes the newest of them
              rather than the time this page was opened. */}
          {marketsData?.chainHeatmap?.length > 0 && <>
            <ChainHeatmap chains={marketsData.chainHeatmap} />
            <FigureSourceLine source="exchange" observedAt={newestStamp(marketsData.chainHeatmap, 'as_of')} scopeKey="exchange_signal" />
          </>}
          {chainRows.length > 0 && (
            <section className="space-y-2">
              <div className="eyebrow">{t('markets.chains', { defaultValue: 'Chains' })}</div>
              <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
                {chainRows.map(({ chain: c, perf: p }) => (
                  <Link key={c.id} to={`/intel/asset/${encodeURIComponent(`native:${c.id}`)}`} state={returnState} className="py-2 block border-b border-[var(--border)] hover:bg-[var(--bg-2)] transition-colors">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-[var(--fg-1)] truncate">{c.label}</span>
                      {p.change_24h != null && <span className={`text-[12px] font-semibold flex items-center gap-0.5 ${pctClass(p.change_24h)}`}>{p.change_24h >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}{formatPct(p.change_24h)}</span>}
                    </div>
                    <div className="text-[11px] text-[var(--fg-4)] mt-0.5">{p.symbol}{p.price != null ? ` · ${formatPrice(p.price)}` : ''}</div>
                    <div className="text-[10px] text-[var(--fg-4)]">{p.source === 'coinmarketcap' ? 'CoinMarketCap' : 'CoinGecko'} · <time dateTime={p.as_of}>{new Date(p.as_of).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}</time>{p.stale ? ' · '+t('market.stale', {defaultValue:'stale'}) : ''}</div>
                  </Link>
                ))}
              </div>
            </section>
          )}



          {/* Cross-Exchange Spread Watch */}
          {spreads.length > 0 && (
            <section className="space-y-2">
              <div className="eyebrow flex items-center gap-1.5"><ArrowLeftRight className="h-3.5 w-3.5" /> {t('markets.spreadWatch', { defaultValue: 'Cross-Exchange Spread Watch' })}</div>
              <div className="card--flat p-2 text-[11px] text-[var(--fg-4)]">{t('markets.spreadNote', { defaultValue: 'Spread data is informational only and may be reduced or eliminated by fees, slippage, liquidity, transfer time, exchange access, withdrawal/deposit status, and stale data.' })}</div>
              <div className="grid gap-2 sm:grid-cols-2">
                {spreads.slice(0, 8).map((s) => <CrossExchangeSpreadCard key={s.normalized_symbol} spread={s} />)}
              </div>
              {/* Both sides of every spread are venue-reported prices; the net
                  estimate on each card is ours and is labelled on the card. The
                  clock is the newest of the pairs shown. */}
              <FigureSourceLine source="exchange" observedAt={newestStamp(spreads.slice(0, 8), 'as_of')} scopeKey="exchange_signal" />
            </section>
          )}

          {/* Front-door tools — paste any EVM/SOL token address */}
          <form onSubmit={onOpen} className="card p-4 flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="text-[11px] text-[var(--fg-4)]">{t('watchlist.chain', { defaultValue: 'Chain' })}</span>
              <select className="select" value={form.chain} onChange={(e) => { setForm((f) => ({ ...f, chain: e.target.value })); setCandidates(null) }}>
                <option value="">{t('markets.auto_detect', { defaultValue: 'Auto-detect chain' })}</option>
                {CHAINS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </label>
            <label className="block flex-1 min-w-[220px]">
              <span className="text-[11px] text-[var(--fg-4)]">{t('markets.open_label', { defaultValue: 'Token address / mint' })}</span>
              <input className="input w-full" placeholder={t('markets.open_ph', { defaultValue: 'Paste a contract address or mint…' })} value={form.value} onChange={(e) => { setForm((f) => ({ ...f, value: e.target.value })); if (candidates) setCandidates(null); if (resolution) setResolution(null); if (err) setErr(null) }} />
            </label>
            <button type="submit" className="btn btn--primary" disabled={opening || !form.value.trim()}>
              {opening ? <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-current" /> : <><Search className="h-4 w-4" /> {t('markets.open', { defaultValue: 'Open chart' })}</>}
            </button>
            <Link to="/intel/watchlist" className="btn btn--ghost btn--sm"><Star className="h-4 w-4" /> {t('markets.manage', { defaultValue: 'Manage watchlist' })}</Link>
          </form>
          {candidates && candidates.length > 0 && (
            <div className="card--flat p-3 space-y-2">
              <div className="text-[12px] text-[var(--fg-3)]">{t('markets.locate_choose', { defaultValue: 'Found on multiple chains. Pick one:' })}</div>
              <div className="flex flex-wrap gap-1.5">
                {candidates.map((c) => (
                  <button key={c.chain} type="button" onClick={() => goToAsset(c.chain, form.value.trim())} className="chip text-[11px]">
                    {(c.symbol || form.value.trim().slice(0, 6))} · {(CHAINS.find((x) => x.id === c.chain)?.label) || c.chain}{c.liquidityUsd ? ` · ${formatUsd(c.liquidityUsd)}` : ''}
                  </button>
                ))}
              </div>
            </div>
          )}
          {resolution && <Suspense fallback={<p role="status" className="text-[12px] text-[var(--fg-4)]">{t('markets.locate_resolving', { defaultValue: 'Reading the asset identity…' })}</p>}>
            <AssetResolveResult result={resolution} onPick={route => { setResolution(null); navigate(route) }}/>
          </Suspense>}
          {err && <div className="card--flat p-3 text-[13px] text-red-400">{err}</div>}

          {watchState?.scope === ownerScope && watchState.loading && <p role="status">{t('markets.watch_loading', { defaultValue: 'Loading watchlist…' })}</p>}
          {watchState?.scope === ownerScope && watchState.error && <p role="alert">{t('markets.watch_failed', { defaultValue: 'Your watchlist could not be read.' })} <button onClick={() => setContextRetry(value => value + 1)}>{t('common.retry', { defaultValue: 'Retry' })}</button></p>}
          {watch.length > 0 && (
            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="eyebrow">{t('markets.your_watchlist', { defaultValue: 'Your watchlist' })}</div>
                <Link to="/intel/watchlist" className="text-[12px] text-[var(--accent)] flex items-center gap-1">{t('pulse.all', { defaultValue: 'All' })} <ArrowRight className="h-3 w-3" /></Link>
              </div>
              <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
                {watch.map((it) => (
                  <Link key={it.id} to={entityHref(it.entity, it.item_type)} className="card p-3 block hover:bg-[var(--bg-2)] transition-colors">
                    <div className="text-sm font-medium text-[var(--fg-1)] truncate flex items-center gap-1">{it.label || it.entity?.display_symbol || '—'} <ExternalLink className="h-3 w-3 text-[var(--fg-5)]" /></div>
                    <div className="text-[11px] text-[var(--fg-4)] truncate font-mono">{it.entity?.canonical_ref_key}</div>
                  </Link>
                ))}
              </div>
            </section>
          )}
          </div>}
        </>
      ) : (
        /* ── DEGEN MODE ── */
        <>
          <div className="card--flat p-2.5 text-[11px] text-[var(--signal-yellow)] flex items-center gap-1.5"><AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {t('degen.disclaimer', { defaultValue: 'Memecoins are extremely high risk. Liquidity & security data may be incomplete. Verify the contract and official links before acting. Not financial advice.' })}</div>

          {degenData && (
            <div className="grid gap-2 grid-cols-2 sm:grid-cols-4 lg:grid-cols-5">
              <Stat label={t('degen.trackedMemecoins', { defaultValue: 'Memecoins' })} value={dsnap.trackedMemecoins ?? '—'} />
              <Stat label={t('degen.verified', { defaultValue: 'Verified' })} value={dsnap.verifiedCount ?? '—'} />
              <Stat label={t('degen.newLaunches', { defaultValue: 'New launches' })} value={dsnap.newLaunches ?? '—'} cls="text-sky-400" />
              <Stat label={t('degen.totalVolume', { defaultValue: '24h volume' })} value={formatUsd(dsnap.totalVolume24h)} />
              <Stat label={t('degen.topGainer', { defaultValue: 'Top gainer' })} value={dsnap.topGainerSymbol || '—'} sub={dsnap.topGainerChange != null ? formatPct(dsnap.topGainerChange) : null} />
            </div>
          )}

          {/* INTEGRATION POINT: Degen figures. `data` is the whole intel-degen
              response; onFilter receives a partial screen patch ({ chain },
              { bucket }, { riskMax }…) and applies it to the same URL params
              the tables below already read. */}
          <Suspense fallback={<p role="status" className="py-6 text-sm text-[var(--fg-4)]">{t('markets.charts_loading', { defaultValue: 'Loading market figures…' })}</p>}>
            <DegenCharts data={degenData} onFilter={patch => setDegenParam(patch)}/>
          </Suspense>

          {/* bucket chips */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <button type="button" onClick={() => setDegenParam({ bucket: '' })} className={`btn btn--sm ${!degenParams.bucket ? 'btn--primary' : 'btn--ghost'}`}>{t('degen.bucket_all', { defaultValue: 'All' })}</button>
            {DEGEN_BUCKETS.map((b) => (
              <button key={b} type="button" onClick={() => setDegenParam({ bucket: degenParams.bucket === b ? '' : b })} className={`btn btn--sm ${degenParams.bucket === b ? 'btn--primary' : 'btn--ghost'}`}>{t(`degen.bucket_${b}`, { defaultValue: b.replace(/_/g, ' ') })}</button>
            ))}
          </div>

          <section className="space-y-2">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="eyebrow flex items-center gap-1.5"><Dices className="h-3.5 w-3.5" /> {t('degen.title', { defaultValue: 'Degen Memecoins' })}</div>
              <div className="intel-degen-filters">
                <input aria-label={t('degen.search', { defaultValue: 'Symbol, name, contract…' })} className="input text-[12px] py-1" placeholder={t('degen.search', { defaultValue: 'Symbol, name, contract…' })} value={degenParams.search} onChange={(e) => setDegenParam({ search: e.target.value })} />
                <select aria-label="Memecoin chain" className="select text-[12px] py-1" value={degenParams.chain} onChange={(e) => setDegenParam({ chain: e.target.value })}>
                  <option value="">{t('degen.allChains', { defaultValue: 'All chains' })}</option>
                  {DEGEN_CHAINS.map((c) => <option key={c} value={c}>{(CHAINS.find((x) => x.id === c)?.label) || c}</option>)}
                </select>
                <select aria-label="Sort memecoins" className="select text-[12px] py-1" value={degenSort.sort} onChange={(e) => setDegenParam({ sort: e.target.value })}>
                  {DEGEN_SORTS.map((s) => <option key={s} value={s}>{t(`degen.sort_${s}`, { defaultValue: s.replace(/_/g, ' ') })}</option>)}
                </select>
                <label className="text-xs">{t('degen.minimum_liquidity', { defaultValue: 'Minimum liquidity · USD' })}<input type="number" min="0" step="1000" className="input" value={degenParams.minLiquidity} onChange={event => setDegenParam({ minLiquidity: event.target.value })}/></label>
                <select aria-label="Memecoin risk" className="select text-[12px] py-1" value={degenParams.riskMax} onChange={(e) => setDegenParam({ riskMax: e.target.value })}>
                  <option value="">{t('degen.anyRisk', { defaultValue: 'Any risk' })}</option>
                  <option value="30">{t('degen.risk_low', { defaultValue: 'Low' })}</option>
                  <option value="60">{t('degen.riskUpToMed', { defaultValue: 'Up to medium' })}</option>
                </select>
              </div>
            </div>

            {degenError && <p role="alert">{degenError} <button onClick={() => setDegenRetry(value => value + 1)}>{t('common.retry', { defaultValue: 'Retry' })}</button></p>}
            {!degenData && !degenError ? (
              <p role="status" className="py-8 min-h-[60vh] text-sm text-[var(--fg-4)]">{t('markets.loading', { defaultValue: 'Loading market observations…' })}</p>
            ) : (
              <>
                {!degenError && <MemecoinTable rows={drows} sort={degenSort.sort} dir={degenSort.dir} onSort={degenSort.toggle} pageOffset={degenParams.page * degenParams.limit} />}
                {dMaxPage > 0 && (
                  <div className="flex items-center justify-between text-[12px] text-[var(--fg-4)]">
                    <span>{t('markets.showing', { defaultValue: 'Showing' })} {degenParams.page * degenParams.limit + 1}–{Math.min(dtotal, (degenParams.page + 1) * degenParams.limit)} {t('markets.of', { defaultValue: 'of' })} {dtotal}</span>
                    <span className="flex items-center gap-2">
                      <button type="button" className="btn btn--ghost btn--sm" disabled={degenParams.page <= 0} onClick={() => setDegenParam({ page: degenParams.page - 1 }, true)}>{t('markets.prev', { defaultValue: 'Prev' })}</button>
                      <button type="button" className="btn btn--ghost btn--sm" disabled={degenParams.page >= dMaxPage} onClick={() => setDegenParam({ page: degenParams.page + 1 }, true)}>{t('markets.next', { defaultValue: 'Next' })}</button>
                    </span>
                  </div>
                )}
                {/* The two sources behind every row, named through the shared
                    provider labels rather than in a hardcoded English sentence,
                    with the snapshot clock the screener was built at. The risk
                    and quality scores on the table are ours and the table says
                    so in its own column headers. */}
                <FigureSourceLine source="dexscreener+geckoterminal" capturedAt={dsnap.lastUpdated || null} />
              </>
            )}
          </section>
        </>
      )}

      <IntelDisclaimer variant="block" />
    </IntelPageShell>
  )
}

function Stat({ label, value, sub, cls }) {
  const tone = cls?.includes('red') ? 'negative' : cls?.includes('ok') || cls?.includes('emerald') ? 'positive' : cls?.includes('sky') ? 'info' : cls?.includes('amber') || cls?.includes('accent') ? 'warning' : 'default'
  return (
    <IntelMetricCard label={label} value={<span className={cls || ''}>{value}</span>} sub={sub} tone={tone} />
  )
}
