import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, Copy, Check, ExternalLink, RefreshCw, ArrowLeft, Layers, DollarSign, TrendingUp, Percent } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { getChain } from '../lib/chains'
import { resolveEntity } from '../lib/watchlist-api'
import { loadDefiMetrics } from '../lib/chart-api'
import { fetchAllKaminoVaults, fetchKaminoMarkets, fetchKaminoVaultHistory, formatUsd, shortenAddress } from '../../lib/defi-intelligence'
import { fetchLlamaPools, fetchLlamaLending, fetchLlamaPoolChart } from '../lib/defillama'
import { listEntityNews } from '../lib/news-api'
import { useArtifact } from '../lib/useArtifact'
import ArtifactView from '../components/ArtifactView'
import PoolDetailCharts from '../components/PoolDetailCharts'
import IntelDisclaimer from '../components/IntelDisclaimer'

// Chains we have a live data source for: Solana → Kamino, the rest → DeFiLlama.
const CHAIN_TABS = ['solana', 'ethereum', 'base', 'arbitrum', 'bnb', 'polygon', 'avalanche', 'sui', 'sei']
const LEVERAGE_HINTS = ['multiply', 'loop', 'leverage', 'leveraged']

const fmtUsd = (v) => formatUsd(v)
// Every APY/ratio fed to this page is normalized to a FRACTION (0.12 = 12%) at
// its source (Kamino native; DeFiLlama ÷100), so formatting is a plain ×100 —
// no unit-guessing, which keeps high-yield (>200%) pools rendering correctly.
const fmtPct = (v) => (v == null || Number.isNaN(Number(v)) ? '—' : `${(Number(v) * 100).toFixed(2)}%`)
const apyClass = (v) => { const p = Number(v) * 100; return p >= 20 ? 'text-emerald-400' : p >= 5 ? 'text-[var(--accent)]' : 'text-[var(--fg-2)]' }

// Normalize a live Kamino vault (fetchAllKaminoVaults) into the shared row shape.
function normKaminoVault(v) {
  const isLev = LEVERAGE_HINTS.some((h) => String(v.strategyType || '').toLowerCase().includes(h))
  const productType = v.productType === 'earn' ? 'single' : isLev ? 'multiply' : 'lp'
  const apy = Number(v.apy || 0)
  const apyBase = Number(v.feeApy || 0)
  return {
    key: v.address,
    address: v.address,
    name: v.strategyName || [v.tokenASymbol, v.tokenBSymbol].filter(Boolean).join('/') || shortenAddress(v.address),
    productType,
    tvl_usd: Number(v.totalValueLocked || 0),
    apy,
    apyBase,
    apyReward: Math.max(0, apy - apyBase),
    protocol: 'Kamino',
    chain: 'solana',
    tokenA: v.tokenASymbol || null,
    tokenB: v.tokenBSymbol || null,
    stable: String(v.strategyType || '').toLowerCase().includes('stable'),
    url: productType === 'single'
      ? `https://app.kamino.finance/earn/vaults/${v.address}`
      : `https://app.kamino.finance/liquidity/${v.address}`,
  }
}

// Normalize a live Kamino reserve (fetchKaminoMarkets) into the lending row shape.
function normKaminoReserve(r) {
  return {
    key: `${r.marketAddress}:${r.reserveAddress}`,
    address: r.mint,
    symbol: r.symbol,
    market: r.marketName,
    primary: r.marketIsPrimary,
    protocol: 'Kamino',
    chain: 'solana',
    supplyApy: Number(r.supplyApy || 0),
    borrowApy: Number(r.borrowApy || 0),
    tvl_usd: Number(r.totalSupplyUsd || 0),
    totalBorrowUsd: Number(r.totalBorrowUsd || 0),
    utilization: Number(r.utilization || 0),
    ltv: Number(r.ltv || 0),
  }
}

// Top-5 yield-arbitrage spreads (vault APY − lending supply APY), Solana/Kamino.
function computeArb(vaults, reserves) {
  const supplyBySymbol = new Map()
  for (const r of reserves) {
    const s = (r.symbol || '').toUpperCase()
    if (!s) continue
    if (!supplyBySymbol.has(s) || r.supplyApy > supplyBySymbol.get(s).supplyApy) supplyBySymbol.set(s, r)
  }
  const out = []
  for (const v of vaults) {
    if (v.productType !== 'lp') continue
    for (const tok of [v.tokenA, v.tokenB]) {
      const s = (tok || '').toUpperCase()
      const res = supplyBySymbol.get(s)
      if (!res) continue
      const spread = v.apy - res.supplyApy
      if (spread > 0) out.push({ symbol: s, vaultName: v.name, vaultApy: v.apy, supplyApy: res.supplyApy, spread })
    }
  }
  return out.sort((a, b) => b.spread - a.spread).slice(0, 5)
}

function CopyBtn({ text }) {
  const [done, setDone] = useState(false)
  return (
    <button
      onClick={(e) => { e.stopPropagation(); navigator.clipboard?.writeText(text); setDone(true); setTimeout(() => setDone(false), 1200) }}
      className="text-[var(--fg-5)] hover:text-[var(--fg-2)] transition-colors" title="Copy address">
      {done ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  )
}

// DeFi Intelligence — multichain. Browse vaults/pools + lending markets per chain
// (Solana via Kamino, others via DeFiLlama), or deep-dive any address for the AI
// report + TVL/APY history. Chain tabs → product/view tabs → filterable table.
export default function DefiPage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase } = useSupabase()

  const [chain, setChain] = useState('solana')
  const [view, setView] = useState('vaults')      // 'vaults' | 'lending'
  const [product, setProduct] = useState('all')   // vaults: all | lp | single | stable
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState({ key: 'tvl_usd', dir: 'desc' })

  const [rows, setRows] = useState([])
  const [arb, setArb] = useState([])
  const [loadingRows, setLoadingRows] = useState(false)
  const [rowsErr, setRowsErr] = useState(null)
  const cacheRef = useRef(new Map())

  // Deep-dive (custom address or row click) → rich pool detail + AI + news.
  const [addrInput, setAddrInput] = useState('')
  const [resolving, setResolving] = useState(false)
  const [ddErr, setDdErr] = useState(null)
  const [metrics, setMetrics] = useState(null)
  const [news, setNews] = useState([])
  const [selected, setSelected] = useState(null)   // the clicked row (rich source)
  const [richChart, setRichChart] = useState([])   // DeFiLlama /chart history
  const [loadingChart, setLoadingChart] = useState(false)
  const art = useArtifact()
  const deepActive = !!(selected || metrics || art.result || art.loading || resolving)

  const chainLabel = getChain(chain)?.label || chain

  const loadRows = useCallback(async (ch, vw, force = false) => {
    const cacheKey = `${ch}:${vw}`
    if (!force && cacheRef.current.has(cacheKey)) {
      const c = cacheRef.current.get(cacheKey); setRows(c.rows); setArb(c.arb || []); return
    }
    setLoadingRows(true); setRowsErr(null); setRows([]); setArb([])
    try {
      let out = []; let arbOut = []
      if (ch === 'solana' && vw === 'vaults') {
        out = (await fetchAllKaminoVaults()).map(normKaminoVault)
      } else if (ch === 'solana' && vw === 'lending') {
        const [reserves, vaults] = await Promise.all([fetchKaminoMarkets(), fetchAllKaminoVaults()])
        out = reserves.map(normKaminoReserve)
        arbOut = computeArb(vaults.map(normKaminoVault), out)
      } else if (vw === 'vaults') {
        out = await fetchLlamaPools(ch)
      } else {
        out = await fetchLlamaLending(ch)
      }
      cacheRef.current.set(cacheKey, { rows: out, arb: arbOut })
      setRows(out); setArb(arbOut)
    } catch (e) {
      setRowsErr(e?.message || 'load_failed')
    } finally { setLoadingRows(false) }
  }, [])

  useEffect(() => { loadRows(chain, view) }, [chain, view, loadRows])

  // ── Deep-dive ───────────────────────────────────────────────────────────────
  // `poolContext` (when a row is clicked) is the exact pool's data, passed to the
  // AI so it analyzes THIS pool — not the underlying token.
  const runDeepDive = useCallback(async (ch, value, poolContext = null) => {
    const v = (value || '').trim()
    if (!v || !org?.id) return
    setResolving(true); setDdErr(null); setMetrics(null); setNews([])
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' })
    try {
      const e = await resolveEntity(supabase, org.id, { kind: 'asset', chain: ch, value: v })
      const ctx = poolContext ? { pool_detail: poolContext } : undefined
      const [, m] = await Promise.all([
        art.generate({ artifactType: 'defi_report', entityId: e.id, ...(ctx ? { context: ctx } : {}) }),
        loadDefiMetrics(supabase, org.id, { entityId: e.id }).catch((ex) => ({ _error: ex?.message || 'metrics_unavailable' })),
      ])
      setMetrics(m)
      try { setNews(await listEntityNews(supabase, org.id, e.id, e.display_symbol)) } catch { /* */ }
    } catch (ex) { setDdErr(ex.message) } finally { setResolving(false) }
  }, [org?.id, supabase, art])

  const closeDeepDive = useCallback(() => { setSelected(null); setRichChart([]); setMetrics(null); setNews([]); setDdErr(null); art.setResult(null) }, [art])

  const onRowDeepDive = useCallback(async (row) => {
    setSelected(row); setAddrInput(row.address); setRichChart([])
    // Rich history chart: DeFiLlama (pool UUID) for non-Solana, Kamino native
    // history for Solana vaults. Skip for Kamino lending reserves (no series).
    setLoadingChart(true)
    try {
      if (row.poolId) setRichChart(await fetchLlamaPoolChart(row.poolId))
      else if (row.chain === 'solana' && row.supplyApy == null) setRichChart(await fetchKaminoVaultHistory(row.address, row.productType === 'single'))
    } catch { /* */ } finally { setLoadingChart(false) }
    const poolContext = {
      kind: row.supplyApy != null ? 'lending_market' : row.productType,
      name: row.name || row.symbol, protocol: row.protocol, chain: row.chain,
      apy: row.apy, apy_base: row.apyBase, apy_reward: row.apyReward, apy_mean_30d: row.apyMean30d,
      supply_apy: row.supplyApy, borrow_apy: row.borrowApy, utilization: row.utilization, ltv: row.ltv,
      tvl_usd: row.tvl_usd, il_7d: row.il_7d, tokens: [row.tokenA, row.tokenB].filter(Boolean),
      stable: row.stable, outlook: row.prediction,
    }
    runDeepDive(row.chain, row.address, poolContext)
  }, [runDeepDive])

  // Typed-address analyze: clear any row context so the chart falls back to the
  // resolved metrics history rather than reusing a previously clicked pool.
  const analyzeAddress = useCallback(() => { setSelected(null); setRichChart([]); runDeepDive(chain, addrInput) }, [chain, addrInput, runDeepDive])

  const pickChain = (c) => { setChain(c); setProduct('all'); setSearch('') }
  const pickView = (v) => { setView(v); setSearch(''); setSort({ key: 'tvl_usd', dir: 'desc' }) }

  // ── Filtered + sorted rows ───────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    let r = rows
    if (view === 'vaults' && product !== 'all') {
      r = r.filter((x) => product === 'stable' ? x.stable : x.productType === product)
    }
    if (q) {
      r = r.filter((x) => [x.name, x.symbol, x.protocol, x.market, x.address, x.tokenA, x.tokenB]
        .filter(Boolean).some((f) => String(f).toLowerCase().includes(q)))
    }
    const { key, dir } = sort
    const sgn = dir === 'desc' ? -1 : 1
    return [...r].sort((a, b) => sgn * ((Number(a[key]) || 0) - (Number(b[key]) || 0)))
  }, [rows, view, product, search, sort])

  const stats = useMemo(() => {
    if (!rows.length) return null
    if (view === 'lending') {
      const tvl = rows.reduce((s, r) => s + (r.tvl_usd || 0), 0)
      const topSupply = Math.max(...rows.map((r) => r.supplyApy || 0))
      const avgUtil = rows.reduce((s, r) => s + (r.utilization || 0), 0) / rows.length
      return [
        { label: t('defi.stat_reserves', { defaultValue: 'Reserves' }), value: String(rows.length), icon: Layers },
        { label: t('defi.stat_top_supply', { defaultValue: 'Top Supply APY' }), value: fmtPct(topSupply), icon: Percent, accent: true },
        { label: t('defi.stat_total_supplied', { defaultValue: 'Total Supplied' }), value: fmtUsd(tvl), icon: DollarSign },
        { label: t('defi.stat_avg_util', { defaultValue: 'Avg Utilization' }), value: fmtPct(avgUtil), icon: TrendingUp },
      ]
    }
    const tvl = rows.reduce((s, r) => s + (r.tvl_usd || 0), 0)
    const topApy = Math.max(...rows.map((r) => r.apy || 0))
    const twApy = tvl > 0 ? rows.reduce((s, r) => s + (r.apy || 0) * (r.tvl_usd || 0), 0) / tvl : 0
    return [
      { label: t('defi.stat_pools', { defaultValue: 'Pools' }), value: String(rows.length), icon: Layers },
      { label: t('defi.stat_top_apy', { defaultValue: 'Top APY' }), value: fmtPct(topApy), icon: Percent, accent: true },
      { label: t('defi.stat_total_tvl', { defaultValue: 'Total TVL' }), value: fmtUsd(tvl), icon: DollarSign },
      { label: t('defi.stat_twapy', { defaultValue: 'TVL-Wtd APY' }), value: fmtPct(twApy), icon: TrendingUp },
    ]
  }, [rows, view, t])

  const toggleSort = (key) => setSort((s) => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }))
  const sortArrow = (key) => sort.key === key ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : ''

  // Unified header source for the pool detail: the clicked row (rich) or, for a
  // raw-address analyze, what intel-defi-metrics resolved.
  const detail = useMemo(() => {
    if (selected) {
      const lending = selected.supplyApy != null
      return {
        lending, name: selected.name || selected.symbol, productType: lending ? 'lending' : selected.productType,
        protocol: selected.protocol, chain: selected.chain,
        apy: selected.apy, apyBase: selected.apyBase, apyReward: selected.apyReward, apyMean30d: selected.apyMean30d,
        supplyApy: selected.supplyApy, borrowApy: selected.borrowApy, utilization: selected.utilization, ltv: selected.ltv,
        tvl_usd: selected.tvl_usd, il_7d: selected.il_7d,
        tokens: [selected.tokenA, selected.tokenB].filter(Boolean), outlook: selected.prediction,
      }
    }
    const cur = metrics?.current
    if (cur) {
      const lending = cur.type === 'lending_market'
      return {
        lending, name: metrics.entity?.symbol || addrInput, protocol: cur.protocol,
        productType: cur.type === 'earn_vault' ? 'single' : lending ? 'lending' : cur.tokenB ? 'lp' : 'single',
        chain: metrics.entity?.chain || chain, apy: cur.apy, apyBase: null, apyReward: null, apyMean30d: null,
        tvl_usd: cur.tvl_usd, il_7d: cur.il_7d, tokens: [cur.tokenA, cur.tokenB].filter(Boolean), outlook: null,
      }
    }
    return null
  }, [selected, metrics, addrInput, chain])

  // Chart series: prefer the rich DeFiLlama /chart history; else accumulated snapshots.
  const chartData = useMemo(() => richChart.length ? richChart : (metrics?.history || []), [richChart, metrics])

  const productChips = [
    ['all', t('defi.f_all', { defaultValue: 'All' })],
    ['lp', t('defi.f_lp', { defaultValue: 'LP pairs' })],
    ['single', t('defi.f_single', { defaultValue: 'Single-asset' })],
    ['stable', t('defi.f_stable', { defaultValue: 'Stables' })],
  ]

  return (
    <div className="space-y-5">
      <div>
        <div className="eyebrow">{t('brand.name', { defaultValue: 'Investor Intel' })}</div>
        <h1 className="page-title">{t('nav.defi', { defaultValue: 'DeFi Intelligence' })}</h1>
        <p className="page-sub">{t('pages.defi_sub', { defaultValue: 'Vaults, pools, yields and collateral risk across chains — with AI analysis and TVL/APY history.' })}</p>
      </div>

      {/* Stat cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {stats.map((s) => (
            <div key={s.label} className="card p-3">
              <div className="flex items-center gap-1.5 text-[11px] text-[var(--fg-4)]"><s.icon className="h-3.5 w-3.5" /> {s.label}</div>
              <div className={`text-lg font-semibold mt-0.5 ${s.accent ? 'text-[var(--accent)]' : 'text-[var(--fg-1)]'}`}>{s.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Deep-dive custom address bar */}
      <div className="card p-4 space-y-2">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block flex-1 min-w-[220px]">
            <span className="text-[11px] text-[var(--fg-4)]">{t('defi.analyze_on', { defaultValue: 'Analyze any address on' })} <span className="text-[var(--accent)]">{chainLabel}</span></span>
            <input className="input w-full mt-1" placeholder={t('defi.ph', { defaultValue: 'Vault / pool / token / market address' })}
              value={addrInput} onChange={(e) => setAddrInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') analyzeAddress() }} />
          </label>
          <button onClick={analyzeAddress} disabled={resolving || art.loading || !addrInput.trim()} className="btn btn--primary disabled:opacity-50">
            {(resolving || art.loading) ? <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-current" /> : <><Search className="h-4 w-4" /> {t('analyze.run', { defaultValue: 'Analyze' })}</>}
          </button>
        </div>
        {/* Chain tabs */}
        <div className="flex items-center gap-1.5 flex-wrap pt-1">
          {CHAIN_TABS.map((c) => (
            <button key={c} onClick={() => pickChain(c)} className={`btn btn--sm ${chain === c ? 'btn--primary' : 'btn--ghost'}`}>
              {getChain(c)?.label || c}
            </button>
          ))}
        </div>
      </div>

      {/* Pool detail (deep dive) */}
      {deepActive && (
        <section className="card--accent p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="eyebrow">{t('defi.deep_dive', { defaultValue: 'Pool detail' })}</div>
              {detail && (
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-[17px] font-semibold text-[var(--fg-1)] truncate">{detail.name}</h2>
                  <ProductPill type={detail.productType} />
                  <span className="text-[12px] text-[var(--fg-4)]">{detail.protocol ? `${detail.protocol} · ` : ''}{getChain(detail.chain)?.label || detail.chain}</span>
                </div>
              )}
            </div>
            <button onClick={closeDeepDive} className="btn btn--sm btn--ghost shrink-0"><ArrowLeft className="h-3.5 w-3.5" /> {t('defi.back', { defaultValue: 'Back to explorer' })}</button>
          </div>

          {ddErr && <div className="card--flat p-3 text-[13px] text-red-400">{ddErr}</div>}
          {metrics?._error && !detail && <div className="card--flat p-3 text-[13px] text-[var(--fg-4)]">{t('defi.metrics_unavailable', { defaultValue: 'Live metrics unavailable — verify the address and chain.' })}</div>}

          {/* Key stats */}
          {detail && (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              <Stat label={detail.lending ? t('defi.col_supply', { defaultValue: 'Supply APY' }) : t('defi.apy', { defaultValue: 'APY' })} value={fmtPct(detail.lending ? detail.supplyApy : detail.apy)} accent
                sub={detail.apyBase != null || detail.apyReward != null ? `${t('defi.base', { defaultValue: 'base' })} ${fmtPct(detail.apyBase)} · ${t('defi.reward', { defaultValue: 'reward' })} ${fmtPct(detail.apyReward)}` : null} />
              {detail.lending
                ? <Stat label={t('defi.col_borrow', { defaultValue: 'Borrow APY' })} value={fmtPct(detail.borrowApy)} />
                : detail.apyMean30d != null && <Stat label={t('defi.avg30', { defaultValue: '30d Avg APY' })} value={fmtPct(detail.apyMean30d)} />}
              <Stat label={detail.lending ? t('defi.col_supplied', { defaultValue: 'Supplied' }) : t('defi.tvl', { defaultValue: 'TVL' })} value={fmtUsd(detail.tvl_usd)} />
              {detail.lending && detail.utilization != null && <Stat label={t('defi.col_util', { defaultValue: 'Utilization' })} value={fmtPct(detail.utilization)} />}
              {detail.ltv != null && detail.ltv > 0 && <Stat label={t('defi.ltv', { defaultValue: 'Max LTV' })} value={fmtPct(detail.ltv)} />}
              {detail.il_7d != null && <Stat label={t('defi.il7d', { defaultValue: 'IL 7d' })} value={fmtPct(detail.il_7d)} />}
              {detail.tokens?.length > 0 && <Stat label={t('defi.pair', { defaultValue: 'Assets' })} value={detail.tokens.join(' / ')} />}
              {detail.outlook && <Stat label={t('defi.outlook', { defaultValue: 'Outlook' })} value={`${detail.outlook.class}`} sub={detail.outlook.prob != null ? `${detail.outlook.prob}% ${t('defi.confidence', { defaultValue: 'confidence' })}` : null} />}
            </div>
          )}

          {/* Charts: DeFiLlama rich history, else accumulated snapshots */}
          {(loadingChart || chartData.length > 0) && <PoolDetailCharts history={chartData} loading={loadingChart} />}

          {/* AI analysis (pool-framed) */}
          <ArtifactView result={art.result} loading={art.loading} />

          {news.length > 0 && (
            <div className="space-y-1.5">
              <div className="eyebrow">{t('breakdown.news', { defaultValue: 'Related news' })}</div>
              {news.map((n) => (
                <a key={n.id} href={n.url} target="_blank" rel="noopener noreferrer" className="card--flat p-2.5 block hover:border-[var(--accent)] transition-colors">
                  <div className="text-[13px] text-[var(--fg-1)] leading-snug">{n.title}</div>
                  <div className="text-[11px] text-[var(--fg-4)] mt-0.5">{n.source_name}{n.published_at ? ` · ${new Date(n.published_at).toLocaleDateString()}` : ''}</div>
                </a>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Explorer controls */}
      <div className="space-y-3">
        <div className="flex items-center gap-1.5 flex-wrap">
          <button onClick={() => pickView('vaults')} className={`btn btn--sm ${view === 'vaults' ? 'btn--primary' : 'btn--ghost'}`}><Layers className="h-3.5 w-3.5" /> {t('defi.view_vaults', { defaultValue: 'Vault Explorer' })}</button>
          <button onClick={() => pickView('lending')} className={`btn btn--sm ${view === 'lending' ? 'btn--primary' : 'btn--ghost'}`}><DollarSign className="h-3.5 w-3.5" /> {t('defi.view_lending', { defaultValue: 'Lending Markets' })}</button>
          {view === 'vaults' && (
            <div className="flex items-center gap-1.5 flex-wrap ml-1 pl-2 border-l border-[var(--border-subtle)]">
              {productChips.map(([id, label]) => (
                <button key={id} onClick={() => setProduct(id)} className={product === id ? 'chip chip--accent' : 'chip'}>{label}</button>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--fg-5)]" />
            <input className="input w-full pl-9" placeholder={t('defi.search_ph', { defaultValue: 'Search by name, token, protocol, address…' })} value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <button onClick={() => loadRows(chain, view, true)} disabled={loadingRows} className="btn btn--ghost btn--sm disabled:opacity-50">
            <RefreshCw className={`h-3.5 w-3.5 ${loadingRows ? 'animate-spin' : ''}`} /> {t('defi.refresh', { defaultValue: 'Refresh' })}
          </button>
        </div>

        {/* Yield arbitrage (Solana lending) */}
        {view === 'lending' && arb.length > 0 && (
          <div className="card--flat p-3 space-y-1.5">
            <div className="eyebrow">{t('defi.arb', { defaultValue: 'Yield arbitrage' })} <span className="text-[var(--fg-5)] normal-case">{t('defi.arb_hint', { defaultValue: 'vault APY − lending supply APY (top 5)' })}</span></div>
            {arb.map((a, i) => (
              <div key={i} className="flex items-center justify-between gap-3 text-[12px]">
                <div className="min-w-0"><span className="font-semibold text-[var(--fg-1)]">{a.symbol}</span> <span className="text-[var(--fg-4)] truncate">{a.vaultName}</span></div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-emerald-400">{fmtPct(a.vaultApy)}</span>
                  <span className="text-[var(--fg-4)]">vs {fmtPct(a.supplyApy)}</span>
                  <span className="text-[var(--accent)] font-semibold">+{(a.spread * 10000).toFixed(0)} bps</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {rowsErr && <div className="card--flat p-3 text-[13px] text-red-400">{t('defi.load_error', { defaultValue: 'Could not load data' })}: {rowsErr}</div>}

        {/* Table */}
        {loadingRows ? (
          <div className="card p-10 grid place-items-center"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--accent)]" /></div>
        ) : filtered.length === 0 ? (
          <div className="card p-8 text-center text-[var(--fg-4)] text-sm">{t('defi.no_rows', { defaultValue: 'No results for this chain / filter.' })}</div>
        ) : view === 'vaults' ? (
          <div className="card overflow-hidden">
            <div className="grid grid-cols-[2fr_1fr_1fr_1fr_auto] gap-2 px-3 py-2 text-[10px] uppercase tracking-wide text-[var(--fg-5)] border-b border-[var(--border-subtle)]">
              <button onClick={() => toggleSort('name')} className="text-left">{t('defi.col_vault', { defaultValue: 'Vault / Pool' })}{sortArrow('name')}</button>
              <button onClick={() => toggleSort('tvl_usd')} className="text-right">{t('defi.tvl', { defaultValue: 'TVL' })}{sortArrow('tvl_usd')}</button>
              <button onClick={() => toggleSort('apy')} className="text-right">{t('defi.apy', { defaultValue: 'APY' })}{sortArrow('apy')}</button>
              <button onClick={() => toggleSort('apyReward')} className="text-right">{t('defi.col_reward', { defaultValue: 'Reward' })}{sortArrow('apyReward')}</button>
              <span className="text-right">{t('defi.col_actions', { defaultValue: '' })}</span>
            </div>
            <div className="divide-y divide-[var(--border-subtle)]">
              {filtered.slice(0, 100).map((r) => (
                <button key={r.key} onClick={() => onRowDeepDive(r)} className="w-full grid grid-cols-[2fr_1fr_1fr_1fr_auto] gap-2 px-3 py-2.5 items-center text-left hover:bg-[var(--bg-2)] transition-colors">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[13px] text-[var(--fg-1)] truncate">{r.name}</span>
                      <ProductPill type={r.productType} />
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px] text-[var(--fg-5)]">
                      <span className="font-mono truncate">{shortenAddress(r.address, 4)}</span>
                      <CopyBtn text={r.address} />
                      {r.protocol && r.protocol !== 'Kamino' && <span className="truncate">· {r.protocol}</span>}
                    </div>
                  </div>
                  <div className="text-right text-[13px] text-[var(--fg-2)]">{fmtUsd(r.tvl_usd)}</div>
                  <div className={`text-right text-[13px] font-medium ${apyClass(r.apy)}`}>{fmtPct(r.apy)}</div>
                  <div className="text-right text-[12px] text-[var(--fg-3)]">{r.apyReward ? fmtPct(r.apyReward) : '—'}</div>
                  <a href={r.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="text-[var(--fg-5)] hover:text-[var(--accent)] justify-self-end" title="Open"><ExternalLink className="h-3.5 w-3.5" /></a>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="card overflow-hidden">
            <div className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr] gap-2 px-3 py-2 text-[10px] uppercase tracking-wide text-[var(--fg-5)] border-b border-[var(--border-subtle)]">
              <button onClick={() => toggleSort('symbol')} className="text-left">{t('defi.col_reserve', { defaultValue: 'Reserve' })}{sortArrow('symbol')}</button>
              <button onClick={() => toggleSort('supplyApy')} className="text-right">{t('defi.col_supply', { defaultValue: 'Supply APY' })}{sortArrow('supplyApy')}</button>
              <button onClick={() => toggleSort('borrowApy')} className="text-right">{t('defi.col_borrow', { defaultValue: 'Borrow APY' })}{sortArrow('borrowApy')}</button>
              <button onClick={() => toggleSort('tvl_usd')} className="text-right">{t('defi.col_supplied', { defaultValue: 'Supplied' })}{sortArrow('tvl_usd')}</button>
              <button onClick={() => toggleSort('utilization')} className="text-right">{t('defi.col_util', { defaultValue: 'Utilization' })}{sortArrow('utilization')}</button>
            </div>
            <div className="divide-y divide-[var(--border-subtle)]">
              {filtered.slice(0, 100).map((r) => {
                const util = Number(r.utilization) * 100
                const utilCls = util >= 90 ? 'bg-red-500' : util >= 70 ? 'bg-yellow-500' : 'bg-emerald-500'
                return (
                  <button key={r.key} onClick={() => onRowDeepDive(r)} className="w-full grid grid-cols-[2fr_1fr_1fr_1fr_1fr] gap-2 px-3 py-2.5 items-center text-left hover:bg-[var(--bg-2)] transition-colors">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5"><span className="text-[13px] text-[var(--fg-1)] truncate">{r.symbol}</span>{r.primary && <span className="chip chip--accent text-[9px]">Main</span>}</div>
                      <div className="text-[10px] text-[var(--fg-5)] truncate">{r.market}{r.ltv ? ` · LTV ${fmtPct(r.ltv)}` : ''}</div>
                    </div>
                    <div className="text-right text-[13px] font-medium text-emerald-400">{fmtPct(r.supplyApy)}</div>
                    <div className="text-right text-[13px] text-red-400/90">{fmtPct(r.borrowApy)}</div>
                    <div className="text-right text-[13px] text-[var(--fg-2)]">{fmtUsd(r.tvl_usd)}</div>
                    <div className="text-right">
                      <div className="text-[12px] text-[var(--fg-3)]">{util.toFixed(0)}%</div>
                      <div className="h-1 w-full bg-[var(--bg-3)] rounded mt-0.5 overflow-hidden"><div className={`h-full ${utilCls}`} style={{ width: `${Math.min(100, util)}%` }} /></div>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        )}
        {filtered.length > 100 && <div className="text-center text-[11px] text-[var(--fg-5)]">{t('defi.showing_top', { defaultValue: 'Showing top 100 by' })} {sort.key === 'tvl_usd' ? 'TVL' : 'APY'}.</div>}
      </div>

      <IntelDisclaimer variant="block" />
    </div>
  )
}

function Stat({ label, value, sub, accent }) {
  return (
    <div className="card p-3">
      <div className="text-[11px] text-[var(--fg-4)]">{label}</div>
      <div className={`text-lg font-semibold ${accent ? 'text-[var(--accent)]' : 'text-[var(--fg-1)]'}`}>{value}</div>
      {sub && <div className="text-[10px] text-[var(--fg-5)] mt-0.5">{sub}</div>}
    </div>
  )
}

function ProductPill({ type }) {
  const map = {
    lp: ['LP', 'bg-blue-500/15 text-blue-300'],
    single: ['EARN', 'bg-emerald-500/15 text-emerald-300'],
    multiply: ['LOOP', 'bg-orange-500/15 text-orange-300'],
    lending: ['LEND', 'bg-purple-500/15 text-purple-300'],
  }
  const [label, cls] = map[type] || [type?.toUpperCase?.() || '', 'bg-[var(--bg-3)] text-[var(--fg-4)]']
  return <span className={`shrink-0 text-[9px] font-semibold px-1.5 py-0.5 rounded uppercase tracking-wide ${cls}`}>{label}</span>
}
