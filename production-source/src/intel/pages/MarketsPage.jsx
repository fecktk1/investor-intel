import React, { useEffect, useState, useCallback, useMemo } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Compass, Search, TrendingUp, TrendingDown, Star, ArrowRight, ExternalLink, BarChart3, Activity, AlertTriangle, ArrowLeftRight, Dices, Globe } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { CHAINS, detectAddressKind, assetRef } from '../lib/chains'
import { entityHref, listWatchlist } from '../lib/watchlist-api'
import { loadMarkets, loadDegenMarkets, locateToken, loadMarketMacro } from '../lib/markets-api'
import { fmtPrice, fmtPct, fmtVol, timeAgo, pctClass } from '../lib/market-format'
import MarketsTable from '../components/MarketsTable'
import MemecoinTable from '../components/MemecoinTable'
import ChainHeatmap from '../components/ChainHeatmap'
import MarketMoverCards from '../components/MarketMoverCards'
import CrossExchangeSpreadCard from '../components/CrossExchangeSpreadCard'
import IntelDisclaimer from '../components/IntelDisclaimer'
import RegimeBanner from '../components/RegimeBanner'

// Markets mode: canonical top-1000 by market cap + CEX/DEX enrichment.
const SORTS = ['market_cap', 'volume', 'gainers', 'losers', 'change_1h', 'change_24h', 'change_7d', 'exchange_availability', 'arbitrage', 'unusual_volume', 'multi_exchange_strength', 'recently_updated']
// Degen mode: multi-chain memecoin terminal.
const DEGEN_SORTS = ['trending', 'volume', 'gainers', 'losers', 'liquidity', 'new', 'market_cap']
const DEGEN_BUCKETS = ['hot', 'new', 'pumpfun', 'migrated', 'trending', 'takeovers', 'established', 'high_volume', 'high_liquidity', 'high_risk', 'watchlist']
const DEGEN_CHAINS = ['solana', 'ethereum', 'base', 'bnb']
const PAGE_SIZE = 50

// Investor Intel — Markets terminal. Two modes: a CMC-style top-1000 markets
// view (canonical market-cap universe + CEX/DEX enrichment) and a separate
// multi-chain Degen memecoin terminal. All data is read from cached tables via
// edge functions — never a live provider call on render.
export default function MarketsPage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase } = useSupabase()
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const mode = searchParams.get('mode') === 'degen' ? 'degen' : 'markets'
  const setMode = useCallback((m) => { const np = new URLSearchParams(searchParams); if (m === 'degen') np.set('mode', 'degen'); else np.delete('mode'); setSearchParams(np, { replace: true }) }, [searchParams, setSearchParams])

  const [perf, setPerf] = useState({})
  const [watch, setWatch] = useState([])
  const [form, setForm] = useState({ chain: '', value: '' })
  const [opening, setOpening] = useState(false)
  const [err, setErr] = useState(null)
  const [candidates, setCandidates] = useState(null)
  const [marketsData, setMarketsData] = useState(null)
  const [macro, setMacro] = useState(null)
  const [marketsLoading, setMarketsLoading] = useState(true)
  const [params, setParams] = useState({ sort: 'market_cap', search: '', category: '', signalDirection: '', watchlistOnly: false, view: '', page: 0, limit: PAGE_SIZE })

  const [degenData, setDegenData] = useState(null)
  const [degenLoading, setDegenLoading] = useState(true)
  const [degenParams, setDegenParams] = useState({ sort: 'trending', search: '', chain: '', bucket: '', riskMax: '', page: 0, limit: PAGE_SIZE })

  // front-door data (chain browser + watchlist links) — markets mode only
  useEffect(() => {
    if (!org?.id || mode !== 'markets') return
    let alive = true
    ;(async () => {
      try {
        const [{ data: cp }, wl] = await Promise.all([
          supabase.from('intel_chain_perf').select('chain_id, symbol, price, change_24h'),
          listWatchlist(supabase, org.id).catch(() => []),
        ])
        if (!alive) return
        setPerf(Object.fromEntries((cp || []).map((r) => [r.chain_id, r])))
        setWatch((wl || []).filter((i) => ['token', 'defi', 'asset'].includes(i.item_type) && i.entity?.canonical_ref_key))
      } catch { /* */ }
    })()
    return () => { alive = false }
  }, [org?.id, supabase, mode])

  // Global crypto-market macro header (markets mode) — cached table read, no edge call.
  useEffect(() => {
    if (mode !== 'markets') return
    let alive = true
    loadMarketMacro(supabase).then((m) => { if (alive) setMacro(m) }).catch(() => {})
    return () => { alive = false }
  }, [supabase, mode])

  // markets data
  const paramsKey = JSON.stringify(params)
  useEffect(() => {
    if (!org?.id || mode !== 'markets') return
    let alive = true
    const handle = setTimeout(async () => {
      setMarketsLoading(true)
      try {
        const body = { sort: params.sort, page: params.page, limit: params.limit }
        if (params.search) body.search = params.search
        if (params.category) body.category = params.category
        if (params.signalDirection) body.signalDirection = params.signalDirection
        if (params.watchlistOnly) body.watchlistOnly = true
        if (params.view) body.view = params.view
        const d = await loadMarkets(supabase, org.id, body)
        if (alive) setMarketsData(d)
      } catch { if (alive) setMarketsData(null) }
      finally { if (alive) setMarketsLoading(false) }
    }, 250)
    return () => { alive = false; clearTimeout(handle) }
  }, [org?.id, supabase, paramsKey, mode])

  // degen data
  const degenKey = JSON.stringify(degenParams)
  useEffect(() => {
    if (!org?.id || mode !== 'degen') return
    let alive = true
    const handle = setTimeout(async () => {
      setDegenLoading(true)
      try {
        const body = { sort: degenParams.sort, page: degenParams.page, limit: degenParams.limit }
        if (degenParams.search) body.search = degenParams.search
        if (degenParams.chain) body.chain = degenParams.chain
        if (degenParams.bucket) body.bucket = degenParams.bucket
        if (degenParams.riskMax) body.riskMax = Number(degenParams.riskMax)
        const d = await loadDegenMarkets(supabase, org.id, body)
        if (alive) setDegenData(d)
      } catch { if (alive) setDegenData(null) }
      finally { if (alive) setDegenLoading(false) }
    }, 250)
    return () => { alive = false; clearTimeout(handle) }
  }, [org?.id, supabase, degenKey, mode])

  const setParam = useCallback((patch, keepPage = false) => setParams((p) => ({ ...p, ...patch, page: keepPage ? (patch.page ?? p.page) : 0 })), [])
  const setDegenParam = useCallback((patch, keepPage = false) => setDegenParams((p) => ({ ...p, ...patch, page: keepPage ? (patch.page ?? p.page) : 0 })), [])

  // Open the rich token detail page for a pasted address. Navigates to the synthetic
  // app-style `chain:address` ref (NOT resolveEntity/CAIP) — same as the Degen/markets
  // drill-in — so no entities row is created until the user hits Add to watchlist, and
  // the page takes the working _contract synthetic path. assetRef lowercases EVM.
  const goToAsset = useCallback((chain, value) => navigate('/intel/asset/' + encodeURIComponent(assetRef(chain, value))), [navigate])

  const onOpen = useCallback(async (e) => {
    e.preventDefault()
    const value = form.value.trim()
    if (!value) return
    setErr(null); setCandidates(null)
    // Explicit chain selected → honor it (most explicit intent).
    if (form.chain) { goToAsset(form.chain, value); return }
    // Auto-detect from the address shape.
    const kind = detectAddressKind(value)
    if (kind === 'solana') { goToAsset('solana', value); return } // unambiguous mint
    if (kind === 'evm') { // chain-ambiguous → resolve via DexScreener multichain search
      setOpening(true)
      try {
        const cands = await locateToken(supabase, value)
        if (!cands.length) { setErr(t('markets.locate_not_found', { defaultValue: "Couldn't find that token on any supported chain. Pick a chain and try again." })); return }
        // Auto-open a single match, or the top when it clearly dominates (≥5× runner-up liquidity); else let the user choose.
        if (cands.length === 1 || cands[0].liquidityUsd >= 5 * (cands[1]?.liquidityUsd || 0)) goToAsset(cands[0].chain, value)
        else setCandidates(cands)
      } finally { setOpening(false) }
      return
    }
    setErr(t('markets.pick_chain', { defaultValue: 'Select a chain for this identifier, then try again.' }))
  }, [form, supabase, t, goToAsset])

  const snap = marketsData?.snapshot || {}
  const rows = marketsData?.rows || []
  const degraded = (marketsData?.providerStatus || []).some((p) => p.degraded)
  const spreads = marketsData?.crossExchangeSpreads || []
  const total = marketsData?.total || 0
  const maxPage = Math.max(0, Math.ceil(total / params.limit) - 1)
  const hasData = useMemo(() => rows.length > 0 || (marketsData && total > 0), [rows, marketsData, total])
  const returnState = useMemo(() => ({ from: `${location.pathname}${location.search}` }), [location.pathname, location.search])

  const dsnap = degenData?.snapshot || {}
  const drows = degenData?.rows || []
  const dtotal = degenData?.total || 0
  const dMaxPage = Math.max(0, Math.ceil(dtotal / degenParams.limit) - 1)

  // Chain browser cards: only chains with real perf data (price or 24h move).
  const chainCards = useMemo(() => CHAINS
    .map((c) => ({ chain: c, perf: perf[c.id] }))
    .filter(({ perf: p }) => p && (p.price != null || p.change_24h != null)),
  [perf])

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <div className="eyebrow flex items-center gap-1.5"><Compass className="h-3.5 w-3.5" /> {t('brand.name', { defaultValue: 'Investor Intel' })}</div>
          <h1 className="page-title">{t('nav.markets', { defaultValue: 'Markets' })}</h1>
          <p className="page-sub">{mode === 'degen'
            ? t('degen.subtitle', { defaultValue: 'Multi-chain memecoin discovery and risk context. Extremely high risk — not financial advice.' })
            : t('markets.subtitle', { defaultValue: 'Top 1000 crypto assets by market cap with exchange & DEX enrichment. Market intelligence only — not financial advice.' })}</p>
        </div>
        {/* Mode tabs (URL-persisted) */}
        <div className="flex items-center gap-1 p-0.5 rounded-lg bg-[var(--bg-2)]">
          <button type="button" onClick={() => setMode('markets')} className={`btn btn--sm ${mode === 'markets' ? 'btn--primary' : 'btn--ghost'}`}><BarChart3 className="h-3.5 w-3.5" /> {t('markets.tabMarkets', { defaultValue: 'Markets' })}</button>
          <button type="button" onClick={() => setMode('degen')} className={`btn btn--sm ${mode === 'degen' ? 'btn--primary' : 'btn--ghost'}`}><Dices className="h-3.5 w-3.5" /> {t('markets.tabDegen', { defaultValue: 'Degen' })}</button>
        </div>
      </div>

      {mode === 'markets' ? (
        <>
          <RegimeBanner />
          <MarketMacroBar macro={macro} />
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
                <Stat label={t('markets.trackedVolume', { defaultValue: 'Tracked 24h volume' })} value={fmtVol(snap.trackedVolumeQuote24h)} />
                <Stat label={t('markets.trackedMarketCap', { defaultValue: 'Tracked market cap' })} value={snap.trackedMarketCap ? fmtVol(snap.trackedMarketCap) : '—'} sub={`${snap.cexCoveragePct ?? 0}% ${t('markets.exchangeAvailability', { defaultValue: 'on CEX' })}`} />
                <Stat label={t('markets.strongestChain', { defaultValue: 'Strongest chain' })} value={snap.strongestChain || '—'} />
              </div>
            </section>
          )}

          {/* 2. Top movers */}
          {marketsData && (marketsData.topGainers?.length > 0 || marketsData.topLosers?.length > 0) && (
            <div className="grid gap-4 lg:grid-cols-2">
              <MarketMoverCards title={t('markets.topMovers', { defaultValue: 'Top movers' })} items={marketsData.topGainers} icon={TrendingUp} hrefFor={(sym) => `/intel/markets/${encodeURIComponent(sym)}`} />
              <MarketMoverCards title={t('markets.topLosers', { defaultValue: 'Top losers' })} items={marketsData.topLosers} icon={TrendingDown} hrefFor={(sym) => `/intel/markets/${encodeURIComponent(sym)}`} />
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
                <p className="text-[11px] text-amber-400">{t('markets.thin_liq_caution', { defaultValue: 'Caution: thin liquidity amplifies slippage and price impact — moves here are less reliable. Research context, not advice.' })}</p>
              )}
            </section>
          )}

          {/* 2c. Watchlist movers + Category leaders (computed server-side) */}
          {(marketsData?.watchlistMovers?.length > 0 || marketsData?.categoryLeaders?.length > 0) && (
            <div className="grid gap-4 lg:grid-cols-2">
              {marketsData?.watchlistMovers?.length > 0 && (
                <MarketMoverCards title={t('markets.watchlist_movers', { defaultValue: 'Watchlist movers' })} items={marketsData.watchlistMovers} icon={TrendingUp} hrefFor={(sym) => `/intel/markets/${encodeURIComponent(sym)}`} />
              )}
              {marketsData?.categoryLeaders?.length > 0 && (
                <section className="card p-4 space-y-2">
                  <div className="eyebrow">{t('markets.category_leaders', { defaultValue: 'Category leaders' })}</div>
                  <div className="space-y-1.5">
                    {marketsData.categoryLeaders.slice(0, 6).map((c) => (
                      <div key={c.category} className="flex items-center gap-2 text-[12px] flex-wrap">
                        <button onClick={() => setParam({ category: c.category })} className="chip text-[10px]">{c.category}</button>
                        {c.leaders.map((l) => (
                          <Link key={l.symbol} to={`/intel/markets/${encodeURIComponent(l.symbol)}`} className="inline-flex items-center gap-1 hover:text-[var(--accent)]">
                            <span className="text-[var(--fg-2)] font-medium">{l.symbol}</span>
                            <span className={`tabular-nums ${(l.change24hPct ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{(l.change24hPct ?? 0) >= 0 ? '+' : ''}{Number(l.change24hPct ?? 0).toFixed(1)}%</span>
                          </Link>
                        ))}
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
          {marketsData?.chainHeatmap?.length > 0 && <ChainHeatmap chains={marketsData.chainHeatmap} />}
          {chainCards.length > 0 && (
            <section className="space-y-2">
              <div className="eyebrow">{t('markets.chains', { defaultValue: 'Chains' })}</div>
              <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
                {chainCards.map(({ chain: c, perf: p }) => (
                  <Link key={c.id} to={`/intel/markets/${encodeURIComponent(c.nativeSymbol)}`} state={returnState} className="card p-3 block hover:bg-[var(--bg-2)] transition-colors">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-[var(--fg-1)] truncate">{c.label}</span>
                      {p.change_24h != null && <span className={`text-[12px] font-semibold flex items-center gap-0.5 ${pctClass(p.change_24h)}`}>{p.change_24h >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}{fmtPct(p.change_24h)}</span>}
                    </div>
                    <div className="text-[11px] text-[var(--fg-4)] mt-0.5">{c.nativeSymbol}{p.price != null ? ` · ${fmtPrice(p.price)}` : ''}</div>
                  </Link>
                ))}
              </div>
            </section>
          )}

          {/* 4. Crypto markets table */}
          <section className="space-y-2">
            <div className="eyebrow flex items-center gap-1.5"><BarChart3 className="h-3.5 w-3.5" /> {t('markets.title', { defaultValue: 'Crypto Markets' })}</div>
            {/* search · sort · category · watchlist — one row, search flexes to fill */}
            <div className="flex items-center gap-2 flex-wrap">
              <input className="input text-[12px] py-1 flex-1 min-w-[160px]" placeholder={t('markets.search', { defaultValue: 'Search name, symbol, contract…' })} value={params.search} onChange={(e) => setParam({ search: e.target.value })} />
              <select className="select text-[12px] py-1" value={params.sort} onChange={(e) => setParam({ sort: e.target.value })} title={t('markets.sortBy', { defaultValue: 'Sort by' })}>
                {SORTS.map((s) => <option key={s} value={s}>{t(`markets.sort_${s}`, { defaultValue: s.replace(/_/g, ' ') })}</option>)}
              </select>
              <select className="select text-[12px] py-1" value={params.category} onChange={(e) => setParam({ category: e.target.value })} title={t('markets.category', { defaultValue: 'Category' })}>
                <option value="">{t('markets.allCategories', { defaultValue: 'All categories' })}</option>
                {(marketsData?.availableCategories || []).map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <button type="button" onClick={() => setParam({ watchlistOnly: !params.watchlistOnly })} className={`btn btn--sm ${params.watchlistOnly ? 'btn--primary' : 'btn--ghost'}`}><Star className="h-3.5 w-3.5" /> {t('markets.watchlistOnly', { defaultValue: 'Watchlist' })}</button>
            </div>

            {marketsLoading && !marketsData ? (
              <div className="card p-8 grid place-items-center"><div className="animate-spin rounded-full h-5 w-5 border-b-2 border-[var(--accent)]" /></div>
            ) : !hasData ? (
              <div className="card p-6 text-center text-[13px] text-[var(--fg-4)]">{t('markets.noData', { defaultValue: 'Market data is being gathered. Check back shortly.' })}</div>
            ) : (
              <>
                <MarketsTable rows={rows} pageOffset={params.page * params.limit} />
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

          {/* Cross-Exchange Spread Watch */}
          {spreads.length > 0 && (
            <section className="space-y-2">
              <div className="eyebrow flex items-center gap-1.5"><ArrowLeftRight className="h-3.5 w-3.5" /> {t('markets.spreadWatch', { defaultValue: 'Cross-Exchange Spread Watch' })}</div>
              <div className="card--flat p-2 text-[11px] text-[var(--fg-4)]">{t('markets.spreadNote', { defaultValue: 'Spread data is informational only and may be reduced or eliminated by fees, slippage, liquidity, transfer time, exchange access, withdrawal/deposit status, and stale data.' })}</div>
              <div className="grid gap-2 sm:grid-cols-2">
                {spreads.slice(0, 8).map((s) => <CrossExchangeSpreadCard key={s.normalized_symbol} spread={s} />)}
              </div>
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
              <input className="input w-full" placeholder={t('markets.open_ph', { defaultValue: 'Paste a contract address or mint…' })} value={form.value} onChange={(e) => { setForm((f) => ({ ...f, value: e.target.value })); if (candidates) setCandidates(null); if (err) setErr(null) }} />
            </label>
            <button type="submit" className="btn btn--primary" disabled={opening || !form.value.trim()}>
              {opening ? <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-current" /> : <><Search className="h-4 w-4" /> {t('markets.open', { defaultValue: 'Open chart' })}</>}
            </button>
            <Link to="/intel/watchlist" className="btn btn--ghost btn--sm"><Star className="h-4 w-4" /> {t('markets.manage', { defaultValue: 'Manage watchlist' })}</Link>
          </form>
          {candidates && candidates.length > 0 && (
            <div className="card--flat p-3 space-y-2">
              <div className="text-[12px] text-[var(--fg-3)]">{t('markets.locate_choose', { defaultValue: 'Found on multiple chains — pick one:' })}</div>
              <div className="flex flex-wrap gap-1.5">
                {candidates.map((c) => (
                  <button key={c.chain} type="button" onClick={() => goToAsset(c.chain, form.value.trim())} className="chip text-[11px]">
                    {(c.symbol || form.value.trim().slice(0, 6))} · {(CHAINS.find((x) => x.id === c.chain)?.label) || c.chain}{c.liquidityUsd ? ` · ${fmtVol(c.liquidityUsd)}` : ''}
                  </button>
                ))}
              </div>
            </div>
          )}
          {err && <div className="card--flat p-3 text-[13px] text-red-400">{err}</div>}

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
        </>
      ) : (
        /* ── DEGEN MODE ── */
        <>
          <div className="card--flat p-2.5 text-[11px] text-amber-400 flex items-center gap-1.5"><AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {t('degen.disclaimer', { defaultValue: 'Memecoins are extremely high risk. Liquidity & security data may be incomplete. Verify the contract and official links before acting. Not financial advice.' })}</div>

          {degenData && (
            <div className="grid gap-2 grid-cols-2 sm:grid-cols-4 lg:grid-cols-5">
              <Stat label={t('degen.trackedMemecoins', { defaultValue: 'Memecoins' })} value={dsnap.trackedMemecoins ?? '—'} />
              <Stat label={t('degen.verified', { defaultValue: 'Verified' })} value={dsnap.verifiedCount ?? '—'} />
              <Stat label={t('degen.newLaunches', { defaultValue: 'New launches' })} value={dsnap.newLaunches ?? '—'} cls="text-sky-400" />
              <Stat label={t('degen.totalVolume', { defaultValue: '24h volume' })} value={fmtVol(dsnap.totalVolume24h)} />
              <Stat label={t('degen.topGainer', { defaultValue: 'Top gainer' })} value={dsnap.topGainerSymbol || '—'} sub={dsnap.topGainerChange != null ? fmtPct(dsnap.topGainerChange) : null} />
            </div>
          )}

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
              <div className="flex items-center gap-2 flex-wrap">
                <input className="input text-[12px] py-1 w-32 sm:w-44" placeholder={t('degen.search', { defaultValue: 'Symbol, name, contract…' })} value={degenParams.search} onChange={(e) => setDegenParam({ search: e.target.value })} />
                <select className="select text-[12px] py-1" value={degenParams.chain} onChange={(e) => setDegenParam({ chain: e.target.value })}>
                  <option value="">{t('degen.allChains', { defaultValue: 'All chains' })}</option>
                  {DEGEN_CHAINS.map((c) => <option key={c} value={c}>{(CHAINS.find((x) => x.id === c)?.label) || c}</option>)}
                </select>
                <select className="select text-[12px] py-1" value={degenParams.sort} onChange={(e) => setDegenParam({ sort: e.target.value })}>
                  {DEGEN_SORTS.map((s) => <option key={s} value={s}>{t(`degen.sort_${s}`, { defaultValue: s.replace(/_/g, ' ') })}</option>)}
                </select>
                <select className="select text-[12px] py-1" value={degenParams.riskMax} onChange={(e) => setDegenParam({ riskMax: e.target.value })}>
                  <option value="">{t('degen.anyRisk', { defaultValue: 'Any risk' })}</option>
                  <option value="30">{t('degen.risk_low', { defaultValue: 'Low' })}</option>
                  <option value="60">{t('degen.riskUpToMed', { defaultValue: 'Up to medium' })}</option>
                </select>
              </div>
            </div>

            {degenLoading && !degenData ? (
              <div className="card p-8 grid place-items-center"><div className="animate-spin rounded-full h-5 w-5 border-b-2 border-[var(--accent)]" /></div>
            ) : (
              <>
                <MemecoinTable rows={drows} pageOffset={degenParams.page * degenParams.limit} />
                {dMaxPage > 0 && (
                  <div className="flex items-center justify-between text-[12px] text-[var(--fg-4)]">
                    <span>{t('markets.showing', { defaultValue: 'Showing' })} {degenParams.page * degenParams.limit + 1}–{Math.min(dtotal, (degenParams.page + 1) * degenParams.limit)} {t('markets.of', { defaultValue: 'of' })} {dtotal}</span>
                    <span className="flex items-center gap-2">
                      <button type="button" className="btn btn--ghost btn--sm" disabled={degenParams.page <= 0} onClick={() => setDegenParam({ page: degenParams.page - 1 }, true)}>{t('markets.prev', { defaultValue: 'Prev' })}</button>
                      <button type="button" className="btn btn--ghost btn--sm" disabled={degenParams.page >= dMaxPage} onClick={() => setDegenParam({ page: degenParams.page + 1 }, true)}>{t('markets.next', { defaultValue: 'Next' })}</button>
                    </span>
                  </div>
                )}
                <div className="text-[10px] text-[var(--fg-5)]">{t('degen.attribution', { defaultValue: 'Memecoin data via DEX Screener & GeckoTerminal.' })}</div>
              </>
            )}
          </section>
        </>
      )}

      <IntelDisclaimer variant="block" />
    </div>
  )
}

// Global crypto-market macro header: total cap (+24h), dominance, stablecoin cap.
// All from market_macro_snapshots (cached); renders nothing until data loads.
function MarketMacroBar({ macro }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  if (!macro) return null
  const chg = macro.market_cap_change_24h_pct
  return (
    <section className="space-y-2">
      <div className="eyebrow flex items-center gap-1.5"><Globe className="h-3.5 w-3.5" /> {t('markets.macro_title', { defaultValue: 'Crypto market — global' })}</div>
      <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label={t('markets.macro_total_mcap', { defaultValue: 'Total market cap' })} value={macro.total_market_cap_usd ? fmtVol(macro.total_market_cap_usd) : '—'} sub={chg != null ? `${fmtPct(chg)} · 24h` : null} cls={chg != null ? pctClass(chg) : ''} />
        <Stat label={t('markets.macro_volume', { defaultValue: '24h volume' })} value={macro.total_volume_24h_usd ? fmtVol(macro.total_volume_24h_usd) : '—'} />
        <Stat label={t('markets.macro_btc_dom', { defaultValue: 'BTC dominance' })} value={macro.btc_dominance_pct != null ? `${Number(macro.btc_dominance_pct).toFixed(1)}%` : '—'} />
        <Stat label={t('markets.macro_eth_dom', { defaultValue: 'ETH dominance' })} value={macro.eth_dominance_pct != null ? `${Number(macro.eth_dominance_pct).toFixed(1)}%` : '—'} />
        <Stat label={t('markets.macro_stablecoin', { defaultValue: 'Stablecoin cap' })} value={macro.stablecoin_market_cap_usd ? fmtVol(macro.stablecoin_market_cap_usd) : '—'} />
      </div>
    </section>
  )
}

function Stat({ label, value, sub, cls }) {
  return (
    <div className="card p-3">
      <div className="text-[10px] text-[var(--fg-4)] uppercase">{label}</div>
      <div className={`text-sm font-semibold ${cls || 'text-[var(--fg-1)]'}`}>{value}</div>
      {sub && <div className="text-[10px] text-[var(--fg-5)]">{sub}</div>}
    </div>
  )
}
