import React, { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, ExternalLink, Briefcase, Check } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { CHAINS, getChain } from '../lib/chains'
import { listWatchlist, addWatchlistItem, removeWatchlistItem, setHolding, entityHref } from '../lib/watchlist-api'
import { ensureDefaultPortfolio, addTransaction } from '../lib/portfolio-api'
import { loadMarketContextBySymbols } from '../lib/markets-api'
import MarketSignalBadge from '../components/MarketSignalBadge'
import IntelDisclaimer from '../components/IntelDisclaimer'

const ITEM_TYPES = ['token', 'wallet', 'narrative', 'protocol', 'defi']
const HAS_HOLDING = new Set(['token', 'defi'])

// Optional manual holdings — no wallet connection needed. Saves both fields
// together on blur so neither overwrites the other.
function HoldingEditor({ item, onSave }) {
  const [amt, setAmt] = useState(item.holding_amount ?? '')
  const [cb, setCb] = useState(item.cost_basis_usd ?? '')
  const save = () => onSave(item.id, { amount: amt === '' ? null : Number(amt), costBasis: cb === '' ? null : Number(cb) })
  return (
    <div className="flex items-center gap-1.5">
      <input type="number" step="any" value={amt} onChange={(e) => setAmt(e.target.value)} onBlur={save} placeholder="amt" title="Units held (optional)" className="input w-20 text-[12px] py-1" />
      <input type="number" step="any" value={cb} onChange={(e) => setCb(e.target.value)} onBlur={save} placeholder="$ cost" title="Total USD cost basis (optional)" className="input w-24 text-[12px] py-1" />
    </div>
  )
}

export default function WatchlistPage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase, user } = useSupabase()
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ itemType: 'token', chain: 'solana', value: '', label: '' })
  const [ctxMap, setCtxMap] = useState({})

  const load = useCallback(async () => {
    if (!org?.id) return
    setLoading(true); setError(null)
    try { setItems(await listWatchlist(supabase, org.id)) }
    catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }, [org?.id, supabase])

  useEffect(() => { load() }, [load])

  // Hydrate exchange market context for tracked symbols (cached tables; no live calls).
  useEffect(() => {
    const syms = items.map((i) => i.entity?.display_symbol).filter(Boolean)
    if (!syms.length) return
    let alive = true
    ;(async () => { try { const m = await loadMarketContextBySymbols(supabase, syms); if (alive) setCtxMap(m) } catch { /* */ } })()
    return () => { alive = false }
  }, [items, supabase])

  const onAdd = useCallback(async (e) => {
    e.preventDefault()
    if (!form.value.trim() || !org?.id) return
    setAdding(true); setError(null)
    try {
      const kind = form.itemType === 'wallet' ? 'wallet'
        : form.itemType === 'narrative' ? 'narrative'
        : form.itemType === 'protocol' ? 'protocol' : 'asset'
      await addWatchlistItem(supabase, org.id, user?.id, {
        kind, chain: form.chain, value: form.value.trim(), itemType: form.itemType, label: form.label.trim() || null,
      })
      setForm((f) => ({ ...f, value: '', label: '' }))
      await load()
    } catch (e) {
      const m = e.message || ''
      setError(/intel_limit_reached:tracked_wallets/.test(m) ? t('watchlist.limit_wallets', { defaultValue: 'Wallet limit reached for your plan.' })
        : /intel_limit_reached:watchlist_items/.test(m) ? t('watchlist.limit_items', { defaultValue: 'Watchlist limit reached for your plan — upgrade for more.' }) : m)
    }
    finally { setAdding(false) }
  }, [form, org?.id, supabase, user?.id, load])

  const onRemove = useCallback(async (id) => {
    try { await removeWatchlistItem(supabase, id); setItems((p) => p.filter((i) => i.id !== id)) }
    catch (e) { setError(e.message) }
  }, [supabase])

  const saveHolding = useCallback(async (id, patch) => {
    try {
      await setHolding(supabase, id, patch)
      setItems((p) => p.map((i) => i.id === id ? { ...i, holding_amount: patch.amount, cost_basis_usd: patch.costBasis } : i))
    } catch (e) { setError(e.message) }
  }, [supabase])

  // One-way, opt-in bridge: promote a watchlist holding estimate into the real
  // Portfolio (creates a manual transaction). No auto-sync; never double-counted.
  const [promoted, setPromoted] = useState({})
  const addToPortfolio = useCallback(async (item) => {
    if (!org?.id) return
    const sym = item.entity?.display_symbol
    if (!sym) return
    try {
      const qty = Number(item.holding_amount) || 0
      const price = qty > 0 && Number(item.cost_basis_usd) > 0 ? Number(item.cost_basis_usd) / qty : null
      const chain = CHAINS.find((c) => c.namespace === item.entity?.chain_namespace && c.caip2Ref === item.entity?.chain_id)?.id || 'solana'
      const pf = await ensureDefaultPortfolio(supabase, org.id, user?.id)
      await addTransaction(supabase, org.id, user?.id, pf.id, { transactionType: 'buy', symbol: sym, chain, quantity: qty, pricePerUnit: price, currency: 'USD', datetime: new Date().toISOString().slice(0, 16), source: 'watchlist' })
      setPromoted((p) => ({ ...p, [item.id]: true }))
    } catch (e) { setError(e.message) }
  }, [org?.id, supabase, user?.id])

  // Cost-basis concentration (deterministic, no live prices needed).
  const positions = items.filter((i) => Number(i.cost_basis_usd) > 0)
  const totalCost = positions.reduce((s, i) => s + Number(i.cost_basis_usd), 0)
  const topPos = positions
    .map((i) => ({ name: i.label || i.entity?.display_symbol || '?', pct: totalCost ? (Number(i.cost_basis_usd) / totalCost) * 100 : 0 }))
    .sort((a, b) => b.pct - a.pct)[0]

  const needsChain = form.itemType !== 'narrative'
  const placeholder = t(`watchlist.ph.${form.itemType}`, { defaultValue: 'Address, mint, or identifier' })

  return (
    <div className="space-y-5">
      <div>
        <div className="eyebrow">{t('brand.name', { defaultValue: 'Investor Intel' })}</div>
        <h1 className="page-title">{t('nav.watchlist', { defaultValue: 'My Watchlist' })}</h1>
        <p className="page-sub">{t('pages.watchlist_sub', { defaultValue: 'Track tokens, wallets, narratives, ecosystems, protocols and DeFi markets.' })}</p>
      </div>

      <form onSubmit={onAdd} className="card p-4 flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="text-[11px] text-[var(--fg-4)]">{t('watchlist.type', { defaultValue: 'Type' })}</span>
          <select className="select" value={form.itemType} onChange={(e) => setForm((f) => ({ ...f, itemType: e.target.value }))}>
            {ITEM_TYPES.map((tp) => <option key={tp} value={tp}>{t(`watchlist.types.${tp}`, { defaultValue: tp })}</option>)}
          </select>
        </label>
        {needsChain && (
          <label className="block">
            <span className="text-[11px] text-[var(--fg-4)]">{t('watchlist.chain', { defaultValue: 'Chain' })}</span>
            <select className="select" value={form.chain} onChange={(e) => setForm((f) => ({ ...f, chain: e.target.value }))}>
              {CHAINS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </label>
        )}
        <label className="block flex-1 min-w-[200px]">
          <span className="text-[11px] text-[var(--fg-4)]">{t('watchlist.value', { defaultValue: 'Identifier' })}</span>
          <input className="input w-full" placeholder={placeholder} value={form.value} onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))} />
        </label>
        <button type="submit" className="btn btn--primary" disabled={adding || !form.value.trim()}>
          {adding ? <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-current" /> : <><Plus className="h-4 w-4" /> {t('watchlist.add', { defaultValue: 'Add' })}</>}
        </button>
      </form>

      {error && <div className="card--flat p-3 text-[13px] text-red-400">{error}</div>}

      {positions.length > 0 && (
        <div className="card--flat p-3 text-[12px] text-[var(--fg-3)] flex items-center gap-2 flex-wrap">
          <span className="eyebrow">{t('watchlist.concentration', { defaultValue: 'Holdings' })}</span>
          <span>${totalCost.toLocaleString(undefined, { maximumFractionDigits: 0 })} {t('watchlist.cost_basis', { defaultValue: 'cost basis across' })} {positions.length} {t('watchlist.positions', { defaultValue: 'positions' })}</span>
          {topPos && <span>· {t('watchlist.largest', { defaultValue: 'largest' })} <b className="text-[var(--fg-1)]">{topPos.name}</b> {topPos.pct.toFixed(0)}%{topPos.pct >= 50 && <span className="text-amber-400"> · {t('watchlist.concentrated', { defaultValue: 'concentrated' })}</span>}</span>}
          <span className="text-[var(--fg-5)]">· {t('watchlist.by_basis', { defaultValue: 'an exposure estimate by your cost basis — not portfolio P&L' })}</span>
          <Link to="/intel/portfolio" className="text-[var(--accent)] hover:underline">· {t('watchlist.track_in_portfolio', { defaultValue: 'track real P&L in Portfolio' })}</Link>
        </div>
      )}

      {loading ? (
        <div className="card p-8 grid place-items-center"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--accent)]" /></div>
      ) : items.length === 0 ? (
        <div className="card p-8 text-center text-[var(--fg-3)] text-sm">{t('watchlist.empty', { defaultValue: 'Nothing tracked yet. Add a token, wallet or narrative above.' })}</div>
      ) : (
        <div className="space-y-2">
          {items.map((it) => {
            const e = it.entity || {}
            const chain = e.chain_namespace ? getChain(CHAINS.find((c) => c.namespace === e.chain_namespace && c.caip2Ref === e.chain_id)?.id) : null
            const name = it.label || e.display_symbol || e.asset_id || e.canonical_ref_key
            return (
              <div key={it.id} className="card p-3 flex items-center gap-3">
                <span className="chip chip--accent text-[10px] uppercase">{t(`watchlist.types.${it.item_type}`, { defaultValue: it.item_type })}</span>
                <Link to={entityHref(e, it.item_type)} className="flex-1 min-w-0">
                  <div className="text-sm text-[var(--fg-1)] truncate flex items-center gap-1.5">{name} <ExternalLink className="h-3 w-3 text-[var(--fg-5)]" /></div>
                  <div className="text-[11px] text-[var(--fg-4)] truncate font-mono">{e.canonical_ref_key}</div>
                </Link>
                {ctxMap[String(e.display_symbol || '').toUpperCase()]?.direction && <MarketSignalBadge direction={ctxMap[String(e.display_symbol || '').toUpperCase()].direction} size="sm" />}
                {HAS_HOLDING.has(it.item_type) && <HoldingEditor item={it} onSave={saveHolding} />}
                {HAS_HOLDING.has(it.item_type) && Number(it.holding_amount) > 0 && (
                  <button onClick={() => addToPortfolio(it)} title={t('watchlist.add_to_portfolio', { defaultValue: 'Add to Portfolio (creates a manual transaction)' })} className="p-1.5 rounded-lg text-[var(--fg-4)] hover:text-[var(--accent)] hover:bg-[var(--bg-2)]" aria-label="add to portfolio">
                    {promoted[it.id] ? <Check className="h-4 w-4 text-[var(--ok)]" /> : <Briefcase className="h-4 w-4" />}
                  </button>
                )}
                {chain && <span className="text-[11px] text-[var(--fg-4)]">{chain.label}</span>}
                <button onClick={() => onRemove(it.id)} className="p-1.5 rounded-lg text-[var(--fg-4)] hover:text-red-400 hover:bg-[var(--bg-2)]" aria-label="remove">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            )
          })}
        </div>
      )}

      <IntelDisclaimer variant="block" />
    </div>
  )
}
