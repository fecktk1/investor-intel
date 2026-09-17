import React, { useState, useEffect, useCallback } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, ExternalLink, Briefcase, Check } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { CHAINS, getChain } from '../lib/chains'
import { listWatchlist, addWatchlistItem, removeWatchlistItem, setHolding, entityHref, reorderWatchlist, pinWatchlistItem } from '../lib/watchlist-api'
import { useWatchlistSelection } from '../context/WatchlistSelection'
import WatchlistManager from '../components/WatchlistManager'
import { emitTutorialSignal } from '../../help/signals'
import { ensureDefaultPortfolio, addTransaction } from '../lib/portfolio-api'
import { loadMarketContextBySymbols } from '../lib/markets-api'
import MarketSignalBadge from '../components/MarketSignalBadge'
import IntelDisclaimer from '../components/IntelDisclaimer'
import IntelErrorNotice from '../components/IntelErrorNotice'
import RelevantSignals from '../components/RelevantSignals'
import { markSurfaceSeen } from '../lib/changes-api'

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
  const [params, setParams] = useSearchParams(), selection = useWatchlistSelection(params.get('list'))
  const { org } = useProfile(), { user } = useSupabase()
  const choose = async id => { await selection.select(id); setParams(previous => { const next = new URLSearchParams(previous); id ? next.set('list', id) : next.delete('list'); return next }) }
  return <><WatchlistManager state={selection} onSelect={choose}/>{selection.invalidList ? <p role="alert">This watchlist is unavailable in the current workspace. Choose an available list.</p> : <WatchlistPageBody key={`${user?.id}:${org?.id}:${selection.selected?.id || ''}`} selection={selection}/>}</>
}

function WatchlistPageBody({ selection }) {
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
    try { setItems(await listWatchlist(supabase, org.id, selection.selected?.id)) }
    catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }, [org?.id, supabase, selection.selected?.id])

  useEffect(() => { load() }, [load])
  useEffect(() => () => { if (org?.id) markSurfaceSeen(supabase, 'watchlist', '', { orgId: org.id, userId: user?.id }) }, [org?.id, user?.id, supabase])

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
      const added = await addWatchlistItem(supabase, org.id, user?.id, {
        kind, chain: form.chain, value: form.value.trim(), itemType: form.itemType, label: form.label.trim() || null, listId: selection.selected?.id,
      })
      // Tutorial receipt: the created row id (a duplicate returns the old row,
      // whose created_at predates the run, so verification correctly fails it).
      emitTutorialSignal('watchlist.item-added', added ? { item_id: added.id } : {})
      setForm((f) => ({ ...f, value: '', label: '' }))
      await load()
      await selection.reload()
    } catch (e) {
      // Raw message on purpose — IntelErrorNotice maps intel_limit_reached:*
      // to friendly copy + the /intel/upgrade link.
      setError(e.message || '')
    }
    finally { setAdding(false) }
  }, [form, org?.id, supabase, user?.id, load, selection])

  const onRemove = useCallback(async (id) => {
    try { await removeWatchlistItem(supabase, id); setItems((p) => p.filter((i) => i.id !== id)); await selection.reload() }
    catch (e) { setError(e.message) }
  }, [supabase, selection])

  const saveHolding = useCallback(async (id, patch) => {
    try {
      await setHolding(supabase, id, patch)
      setItems((p) => p.map((i) => i.id === id ? { ...i, holding_amount: patch.amount, cost_basis_usd: patch.costBasis } : i))
      await selection.reload()
    } catch (e) { setError(e.message) }
  }, [supabase, selection])

  const [ordering, setOrdering] = useState(false)
  const pin = async item => {
    setOrdering(true); setError(null)
    try { await pinWatchlistItem(supabase, org.id, selection.selected, item.id, !item.is_pinned); await load(); await selection.reload() }
    catch (e) { setError(e.message) } finally { setOrdering(false) }
  }
  const move = async (index, offset) => {
    const next = [...items]; [next[index], next[index + offset]] = [next[index + offset], next[index]]
    setOrdering(true); setError(null)
    try { await reorderWatchlist(supabase, org.id, selection.selected, next.map(item => item.id)); setItems(next); await selection.reload() }
    catch (e) { setError(e.message) } finally { setOrdering(false) }
  }

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

      <form onSubmit={onAdd} className="card p-4 flex flex-wrap items-end gap-3" data-tutorial="intel-watchlist.add-form">
        <label className="block">
          <span className="text-[11px] text-[var(--fg-4)]">{t('watchlist.type', { defaultValue: 'Type' })}</span>
          <select className="select" data-tutorial="intel-watchlist.type-select" value={form.itemType} onChange={(e) => setForm((f) => ({ ...f, itemType: e.target.value }))}>
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
          <input className="input w-full" data-tutorial="intel-watchlist.identifier-input" placeholder={placeholder} value={form.value} onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))} />
        </label>
        <button type="submit" className="btn btn--primary" data-tutorial="intel-watchlist.add-button" disabled={adding || !form.value.trim()}>
          {adding ? <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-current" /> : <><Plus className="h-4 w-4" /> {t('watchlist.add', { defaultValue: 'Add' })}</>}
        </button>
      </form>

      <IntelErrorNotice error={error} />

      {positions.length > 0 && (
        <div className="card--flat p-3 text-[12px] text-[var(--fg-3)] flex items-center gap-2 flex-wrap">
          <span className="eyebrow">{t('watchlist.concentration', { defaultValue: 'Holdings' })}</span>
          <span>${totalCost.toLocaleString(undefined, { maximumFractionDigits: 0 })} {t('watchlist.cost_basis', { defaultValue: 'cost basis across' })} {positions.length} {t('watchlist.positions', { defaultValue: 'positions' })}</span>
          {topPos && <span>· {t('watchlist.largest', { defaultValue: 'largest' })} <b className="text-[var(--fg-1)]">{topPos.name}</b> {topPos.pct.toFixed(0)}%{topPos.pct >= 50 && <span className="text-amber-400"> · {t('watchlist.concentrated', { defaultValue: 'concentrated' })}</span>}</span>}
          <span className="text-[var(--fg-5)]">· {t('watchlist.by_basis', { defaultValue: 'by your cost basis, not live value' })}</span>
          <Link to="/intel/portfolio" className="text-[var(--accent)] hover:underline">· {t('watchlist.track_in_portfolio', { defaultValue: 'track real P&L in Portfolio' })}</Link>
        </div>
      )}

      {loading ? (
        <div className="card p-8 grid place-items-center"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--accent)]" /></div>
      ) : error && items.length === 0 ? null : items.length === 0 ? (
        <div className="card p-8 text-center text-[var(--fg-3)] text-sm">{t('watchlist.empty', { defaultValue: 'Nothing tracked yet. Add a token, wallet or narrative above.' })}</div>
      ) : (
        <div className="space-y-2">
          {items.map((it, index) => {
            const e = it.entity || {}
            const chain = e.chain_namespace ? getChain(CHAINS.find((c) => c.namespace === e.chain_namespace && c.caip2Ref === e.chain_id)?.id) : null
            const name = it.label || e.display_symbol || e.asset_id || e.canonical_ref_key
            return (
              <div key={it.id} className="intel-watchlist-row border-b border-[var(--border-default)] py-3 flex items-center gap-3 flex-wrap">
                <div className="flex gap-1"><button className="btn btn--quiet btn--sm" aria-label={`Move ${name} up`} disabled={ordering || index === 0 || !!items[index-1]?.is_pinned !== !!it.is_pinned} onClick={() => move(index, -1)}>↑</button><button className="btn btn--quiet btn--sm" aria-label={`Move ${name} down`} disabled={ordering || index === items.length - 1 || !!items[index+1]?.is_pinned !== !!it.is_pinned} onClick={() => move(index, 1)}>↓</button><button className="intel-text-link" aria-label={`${it.is_pinned ? 'Unpin' : 'Pin'} ${name}`} disabled={ordering} onClick={() => pin(it)}>{it.is_pinned ? 'Unpin' : 'Pin'}</button></div>
                <span className="text-[10px] uppercase text-[var(--fg-4)]">{t(`watchlist.types.${it.item_type}`, { defaultValue: it.item_type })}</span>
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

      <RelevantSignals title={t('watchlist.relevant_signals', { defaultValue: 'Signals on your watchlist & holdings' })} seeAllHref="/intel" />

      <IntelDisclaimer variant="block" />
    </div>
  )
}
