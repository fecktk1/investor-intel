import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Briefcase, Plus, Trash2, Download, RefreshCw, Sparkles, AlertTriangle, Bell, Loader2, X, Eye, EyeOff, Clock, ChevronRight,
} from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { CHAINS, explorerTxUrl } from '../lib/chains'
import { shortenId } from '../lib/canonical'
import { fmtPrice, fmtPct, fmtVol, pctClass, timeAgo } from '../lib/market-format'
import MarketSignalBadge from '../components/MarketSignalBadge'
import IntelDisclaimer from '../components/IntelDisclaimer'
import IntelErrorNotice from '../components/IntelErrorNotice'
import RelevantSignals from '../components/RelevantSignals'
import PortfolioExposureCards from '../components/PortfolioExposureCards'
import { markSurfaceSeen } from '../lib/changes-api'
import WalletSyncPanel from '../components/WalletSyncPanel'
import PortfolioPerformanceChart from '../components/PortfolioPerformanceChart'
import * as api from '../lib/portfolio-api'

const TX_TYPES = ['buy', 'sell', 'transfer_in', 'transfer_out', 'swap', 'fee', 'airdrop', 'staking_reward', 'deposit', 'withdrawal']
// Full vocab offered when reclassifying (manual + synced).
const RECLASSIFY_TYPES = ['buy', 'sell', 'swap', 'transfer_in', 'transfer_out', 'airdrop', 'stake', 'unstake', 'reward', 'bridge', 'lp_add', 'lp_remove', 'approval', 'wrap', 'unwrap', 'mint', 'burn', 'fee', 'unknown']
const usd = (v) => v == null ? '—' : `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
// "Hide dust" target: anything that is NOT the chain's native/L1 coin and NOT a
// stablecoin, that is either unpriced (long-tail / spam airdrops with no market
// price) or worth under $1. Native coins + stablecoins are always kept. Class
// check is by exclusion so a null asset_class still counts as a hideable token.
// Display-only filter; totals/allocation/P&L use the full set.
const isHiddenDust = (h) =>
  h.asset_class !== 'native' && h.asset_class !== 'stablecoin' &&
  (h.current_value == null || h.current_value < 1)

// Automatic price refresh cadence = the daily snapshot cron (04:30 UTC). Used to
// tell the user when prices will next refresh on their own (they can also sync).
function msUntilNextDailyRefresh() {
  const now = new Date(); const next = new Date(now)
  next.setUTCHours(4, 30, 0, 0)
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1)
  return next.getTime() - now.getTime()
}
function fmtDuration(ms) {
  const totalMin = Math.max(1, Math.round(ms / 60000))
  const h = Math.floor(totalMin / 60), m = totalMin % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}
const fmtAmt = (n) => n == null ? '' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 6 })

// Support-level badge (only shown when NOT full). Reads runtime levels seeded by
// migration 184 + refined by the capability probe.
const SUPPORT_LABELS = {
  beta_history: ['Beta history', 'text-sky-400'],
  balance_only: ['Balance only', 'text-[var(--fg-4)]'],
  coming_soon: ['Coming soon', 'text-[var(--fg-5)]'],
  unsupported: ['Unsupported', 'text-[var(--fg-5)]'],
}
function SupportBadge({ level, t }) {
  if (!level || level === 'full_history_pnl') return null
  const [def, cls] = SUPPORT_LABELS[level] || [level, 'text-[var(--fg-5)]']
  return <span className={`chip text-[9px] ${cls}`}>{t(`portfolio.support.${level}`, { defaultValue: def })}</span>
}

// Token logo with a monogram fallback (never a broken image).
function TokenLogo({ url, symbol }) {
  const [err, setErr] = useState(false)
  const initial = (symbol || '?').slice(0, 1).toUpperCase()
  if (!url || err) return <span className="h-5 w-5 rounded-full bg-[var(--bg-3)] grid place-items-center text-[9px] text-[var(--fg-4)] flex-shrink-0">{initial}</span>
  return <img src={url} alt="" onError={() => setErr(true)} className="h-5 w-5 rounded-full flex-shrink-0 object-cover" loading="lazy" />
}

function typeLabel(type, t) { return t(`portfolio.txn_type.${type}`, { defaultValue: String(type || 'unknown').replace(/_/g, ' ') }) }
// Display name for a line item — never blank.
function liName(li) { return li.symbol || li.name || (li.mint_or_contract ? `Unknown Token (${shortenId(li.mint_or_contract)})` : 'Unknown Token') }

// ── tri-state P&L / pricing labels (rev 7) ──────────────────────────────────
function StateChips({ h, t }) {
  const chips = []
  if (h.price_status === 'unpriced') chips.push(['unpriced', t('portfolio.states.unpriced', { defaultValue: 'Price unavailable' }), 'text-amber-400'])
  else if (h.price_status === 'stale') chips.push(['stale', t('portfolio.states.stale', { defaultValue: 'Price stale' }), 'text-amber-400'])
  if (h.market_context?.marketCapIsEstimated) chips.push(['est', t('portfolio.states.estimated_mcap', { defaultValue: 'Est. market cap' }), 'text-[var(--fg-4)]'])
  // Prefer the explicit cost_basis_status; fall back to the legacy pnl_state.
  const cb = h.cost_basis_status
  if (cb === 'manual_override') chips.push(['cbm', t('portfolio.cost_basis_status.manual_override', { defaultValue: 'Manual cost basis' }), 'text-[var(--accent)]'])
  else if (cb === 'none') chips.push(['cbn', t('portfolio.cost_basis_status.none', { defaultValue: 'Balance only — no P&L' }), 'text-[var(--fg-4)]'])
  else if (cb === 'incomplete' || cb === 'partial' || (!cb && h.pnl_state === 'incomplete_history')) chips.push(['inc', t('portfolio.cost_basis_status.incomplete', { defaultValue: 'Cost basis incomplete' }), 'text-[var(--fg-4)]'])
  if (h.reconciliation_status === 'wallet_only') chips.push(['wo', t('portfolio.states.wallet_only', { defaultValue: 'Wallet synced, tx history incomplete' }), 'text-[var(--fg-5)]'])
  return chips.length ? <span className="flex flex-wrap gap-1">{chips.map(([k, label, cls]) => <span key={k} className={`chip text-[9px] ${cls}`}>{label}</span>)}</span> : null
}

// ── Overview ────────────────────────────────────────────────────────────────
function Overview({ portfolio, holdings, warnHoldings, t }) {
  const total = portfolio?.total_value_usd ?? 0
  const stats = [
    [t('portfolio.total_value', { defaultValue: 'Total value' }), usd(total), ''],
    [t('portfolio.change_24h', { defaultValue: '24h change' }), fmtPct(portfolio?.day_pnl_pct), pctClass(portfolio?.day_pnl_pct)],
    [t('portfolio.unrealized_pnl', { defaultValue: 'Unrealized P&L' }), usd(portfolio?.unrealized_pnl_usd), pctClass(portfolio?.unrealized_pnl_usd)],
    [t('portfolio.realized_pnl', { defaultValue: 'Realized P&L' }), usd(portfolio?.realized_pnl_usd), pctClass(portfolio?.realized_pnl_usd)],
  ]
  const byChain = useMemo(() => {
    const m = new Map()
    for (const h of holdings) m.set(h.chain || 'unknown', (m.get(h.chain || 'unknown') || 0) + (h.current_value || 0))
    return [...m.entries()].map(([label, v]) => ({ label, pct: total > 0 ? (v / total) * 100 : 0 })).sort((a, b) => b.pct - a.pct).slice(0, 5)
  }, [holdings, total])
  // Price-freshness warning reflects what the user is actually viewing: when dust
  // is hidden, its unpriced rows no longer raise an alarm.
  const warn = warnHoldings || holdings
  const unpriced = warn.filter((h) => h.price_status === 'unpriced').length
  const stale = warn.filter((h) => h.price_status === 'stale').length
  const nextRefresh = fmtDuration(msUntilNextDailyRefresh())
  const updatedAgo = portfolio?.last_synced_at ? timeAgo(portfolio.last_synced_at) : null

  return (
    <div className="space-y-3">
      {portfolio?.market_data_available === false && (
        <div className="card--flat p-2.5 text-[12px] text-amber-400 flex items-center gap-2"><AlertTriangle className="h-3.5 w-3.5" />{t('portfolio.market_unavailable', { defaultValue: 'Market pricing unavailable until exchange market data is initialized.' })}</div>
      )}
      {(unpriced > 0 || stale > 0) && (
        <div className="card--flat p-2.5 text-[12px] text-[var(--fg-3)] flex items-start gap-2">
          <Clock className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 text-amber-400" />
          <div className="leading-relaxed">
            <span className="text-amber-400">{t('portfolio.states.pnl_incomplete', { defaultValue: 'P&L may be incomplete' })}</span> — {unpriced} {t('portfolio.unpriced_n', { defaultValue: 'unpriced' })}, {stale} {t('portfolio.stale_n', { defaultValue: 'stale' })}.{' '}
            {updatedAgo ? `${t('portfolio.states.prices_updated', { defaultValue: 'Prices updated' })} ${updatedAgo} · ` : ''}
            {t('portfolio.states.next_update_in', { defaultValue: 'next automatic update in' })} ~{nextRefresh} ({t('portfolio.states.or_sync_now', { defaultValue: 'or sync now' })}).
          </div>
        </div>
      )}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {stats.map(([label, val, cls]) => (
          <div key={label} className="card p-3">
            <div className="text-[10px] uppercase text-[var(--fg-5)]">{label}</div>
            <div className={`text-[18px] font-semibold mt-1 ${cls}`}>{val}</div>
          </div>
        ))}
      </div>
      <div className="grid md:grid-cols-2 gap-3">
        <div className="card p-3">
          <div className="eyebrow mb-2">{t('portfolio.by_chain', { defaultValue: 'By chain' })}</div>
          {byChain.map((c) => (
            <div key={c.label} className="flex items-center gap-2 mb-1.5">
              <span className="text-[12px] text-[var(--fg-2)] w-20 truncate">{c.label}</span>
              <div className="flex-1 h-1.5 rounded-full bg-[var(--bg-3)] overflow-hidden"><div className="h-full bg-[var(--accent)]" style={{ width: `${c.pct}%` }} /></div>
              <span className="text-[11px] text-[var(--fg-4)] w-10 text-right">{c.pct.toFixed(0)}%</span>
            </div>
          ))}
        </div>
        <div className="card p-3 flex flex-col justify-center gap-2">
          <div className="flex items-center justify-between"><span className="text-[12px] text-[var(--fg-3)]">{t('portfolio.stablecoin_pct', { defaultValue: 'Stablecoins' })}</span><span className="text-[13px] text-[var(--fg-1)]">{(portfolio?.stablecoin_pct ?? 0).toFixed(1)}%</span></div>
          <div className="flex items-center justify-between"><span className="text-[12px] text-[var(--fg-3)]">{t('portfolio.risk_score', { defaultValue: 'Risk score' })}</span><span className="text-[13px] text-[var(--fg-1)]">{portfolio?.risk_score == null ? '—' : `${Math.round(portfolio.risk_score)}/100`}</span></div>
          <div className="flex items-center justify-between"><span className="text-[12px] text-[var(--fg-3)]">{t('portfolio.holdings', { defaultValue: 'Holdings' })}</span><span className="text-[13px] text-[var(--fg-1)]">{holdings.length}</span></div>
        </div>
      </div>
    </div>
  )
}

// ── Holdings table ──────────────────────────────────────────────────────────
function HoldingsTable({ holdings, ctxMap, portfolioId, t }) {
  if (!holdings.length) return <div className="card p-6 text-center text-[13px] text-[var(--fg-4)]">{t('portfolio.no_holdings', { defaultValue: 'No holdings yet — connect a wallet or add a transaction.' })}</div>
  return (
    <div className="space-y-1.5">
      <div className="hidden md:flex items-center gap-3 px-2.5 text-[10px] uppercase text-[var(--fg-5)]">
        <span className="flex-1">{t('portfolio.cols.asset', { defaultValue: 'Asset' })}</span>
        <span className="w-20 text-right">{t('portfolio.cols.price', { defaultValue: 'Price' })}</span>
        <span className="w-16 text-right">{t('portfolio.cols.change_24h', { defaultValue: '24h' })}</span>
        <span className="w-24 text-right">{t('portfolio.cols.value', { defaultValue: 'Value' })}</span>
        <span className="w-14 text-right">{t('portfolio.cols.allocation', { defaultValue: 'Alloc' })}</span>
        <span className="w-24 text-right">{t('portfolio.cols.unrealized', { defaultValue: 'Unreal. P&L' })}</span>
        <span className="w-28 text-right">{t('portfolio.cols.signal', { defaultValue: 'Signal' })}</span>
        <span className="w-4" />
      </div>
      {holdings.map((h) => {
        const sym = (h.normalized_symbol || h.asset_symbol || '').toUpperCase()
        const sig = h.market_context?.signalDirection || ctxMap[sym]?.direction
        // Surface the richer per-holding signal context already fetched into ctxMap
        // (confidence + cross-provider corroboration + why) as a hover tooltip.
        const ctx = ctxMap[sym]
        const sigTip = ctx ? [
          ctx.confidence ? `${ctx.confidence} confidence` : null,
          (ctx.confirmingProviders != null && ctx.providerCount != null)
            ? `${ctx.confirmingProviders}/${ctx.providerCount} sources confirm`
            : (ctx.providerCount ? `${ctx.providerCount} sources` : null),
          ctx.whyItMatters || ctx.title || ctx.summary,
        ].filter(Boolean).join(' · ') : null
        const cbStatus = h.cost_basis_status
        const to = h.canonical_asset_key && portfolioId ? `/intel/portfolio/${portfolioId}/asset/${encodeURIComponent(h.canonical_asset_key)}` : null
        const inner = (
          <>
            <div className="flex-1 min-w-0 flex items-center gap-2">
              <TokenLogo url={h.logo_url} symbol={h.asset_symbol || sym} />
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-[var(--fg-1)] truncate flex items-center gap-1.5">
                  {h.asset_symbol || sym} {h.chain && <span className="text-[10px] text-[var(--fg-5)]">{h.chain}</span>}
                  <SupportBadge level={h.support_level} t={t} />
                  {h.asset_class === 'stablecoin' && <span className="chip text-[9px] text-[var(--fg-4)]">{t('portfolio.stable', { defaultValue: 'stable' })}</span>}
                </div>
                {h.name && <div className="text-[10px] text-[var(--fg-5)] truncate">{h.name}</div>}
                <div className="text-[11px] text-[var(--fg-4)]">
                  {fmtAmt(h.quantity)}
                  {cbStatus === 'none' ? '' : ` · ${t('portfolio.cost_basis', { defaultValue: 'cost' })} ${usd(h.cost_basis_usd)}`}
                </div>
                <StateChips h={h} t={t} />
              </div>
            </div>
            <span className="w-20 text-right text-[12px] text-[var(--fg-2)]">{fmtPrice(h.current_price)}</span>
            <span className={`w-16 text-right text-[12px] ${pctClass(h.day_pnl_pct)}`}>{fmtPct(h.day_pnl_pct)}</span>
            <span className="w-24 text-right text-[12px] text-[var(--fg-1)]">{h.current_value == null ? '—' : usd(h.current_value)}</span>
            <span className="w-14 text-right text-[11px] text-[var(--fg-4)]">{h.allocation_pct == null ? '—' : `${h.allocation_pct.toFixed(0)}%`}</span>
            <span className={`w-24 text-right text-[12px] ${pctClass(h.unrealized_pnl)}`}>{h.unrealized_pnl == null ? '—' : usd(h.unrealized_pnl)}</span>
            <span className="w-28 flex items-center justify-end gap-1.5">{sig && <MarketSignalBadge direction={sig} size="sm" title={sigTip} />}</span>
            <ChevronRight className={`w-4 h-3.5 flex-shrink-0 ${to ? 'text-[var(--fg-5)] group-hover:text-[var(--accent)]' : 'opacity-0'}`} />
          </>
        )
        return to ? (
          <Link key={h.id} to={to} className="group card--flat p-2.5 flex flex-wrap md:flex-nowrap items-center gap-x-3 gap-y-1 hover:border-[var(--accent)] transition-colors">{inner}</Link>
        ) : (
          <div key={h.id} className="card--flat p-2.5 flex flex-wrap md:flex-nowrap items-center gap-x-3 gap-y-1">{inner}</div>
        )
      })}
    </div>
  )
}

// ── Manual transaction form ─────────────────────────────────────────────────
function ManualTxnForm({ onSubmit, onClose, t }) {
  const [f, setF] = useState({ transactionType: 'buy', symbol: '', chain: 'solana', quantity: '', pricePerUnit: '', currency: 'USD', fees: '', datetime: new Date().toISOString().slice(0, 16), source: '', notes: '' })
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }))
  const submit = async (e) => {
    e.preventDefault(); setBusy(true)
    try { await onSubmit(f); onClose() } finally { setBusy(false) }
  }
  const needsPrice = ['buy', 'sell', 'swap'].includes(f.transactionType)
  return (
    <form onSubmit={submit} className="card p-4 space-y-3">
      <div className="flex items-center justify-between"><span className="eyebrow">{t('portfolio.add_txn', { defaultValue: 'Add transaction' })}</span><button type="button" onClick={onClose} className="text-[var(--fg-4)] hover:text-[var(--fg-1)]"><X className="h-4 w-4" /></button></div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <label className="block"><span className="text-[11px] text-[var(--fg-4)]">{t('portfolio.cols.type', { defaultValue: 'Type' })}</span>
          <select className="select w-full" value={f.transactionType} onChange={set('transactionType')}>{TX_TYPES.map((ty) => <option key={ty} value={ty}>{t(`portfolio.txn_type.${ty}`, { defaultValue: ty })}</option>)}</select></label>
        <label className="block"><span className="text-[11px] text-[var(--fg-4)]">{t('portfolio.cols.asset', { defaultValue: 'Asset' })}</span><input className="input w-full" required placeholder="SOL" value={f.symbol} onChange={set('symbol')} /></label>
        <label className="block"><span className="text-[11px] text-[var(--fg-4)]">{t('portfolio.cols.chain', { defaultValue: 'Chain' })}</span>
          <select className="select w-full" value={f.chain} onChange={set('chain')}>{CHAINS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
        <label className="block"><span className="text-[11px] text-[var(--fg-4)]">{t('portfolio.cols.qty', { defaultValue: 'Quantity' })}</span><input className="input w-full" type="number" step="any" required value={f.quantity} onChange={set('quantity')} /></label>
        <label className="block"><span className="text-[11px] text-[var(--fg-4)]">{t('portfolio.price_per_unit', { defaultValue: 'Price / unit' })}</span><input className="input w-full" type="number" step="any" required={needsPrice} value={f.pricePerUnit} onChange={set('pricePerUnit')} /></label>
        <label className="block"><span className="text-[11px] text-[var(--fg-4)]">{t('portfolio.fees', { defaultValue: 'Fees' })}</span><input className="input w-full" type="number" step="any" value={f.fees} onChange={set('fees')} /></label>
        <label className="block"><span className="text-[11px] text-[var(--fg-4)]">{t('portfolio.datetime', { defaultValue: 'Date / time' })}</span><input className="input w-full" type="datetime-local" value={f.datetime} onChange={set('datetime')} /></label>
        <label className="block"><span className="text-[11px] text-[var(--fg-4)]">{t('portfolio.source', { defaultValue: 'Exchange / wallet' })}</span><input className="input w-full" placeholder={t('portfolio.optional', { defaultValue: 'optional' })} value={f.source} onChange={set('source')} /></label>
      </div>
      <button type="submit" disabled={busy || !f.symbol.trim()} className="btn btn--primary">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : t('portfolio.record_txn', { defaultValue: 'Record transaction' })}</button>
    </form>
  )
}

// ── Transactions (grouped activity; one row per signature/hash) ──────────────
function TxnTypeChip({ type, status, classification, t }) {
  const failed = status === 'failed'
  const unknown = type === 'unknown'
  const needsReview = classification === 'unclassified'
  const cls = failed || unknown || needsReview ? 'text-amber-400' : 'text-[var(--fg-2)]'
  const label = failed ? t('portfolio.tx_state.failed', { defaultValue: 'Failed' }) : unknown ? t('portfolio.tx_state.unknown', { defaultValue: 'Unknown' }) : typeLabel(type, t)
  return <span className={`chip text-[10px] ${cls}`}>{label}</span>
}

function ActivityRow({ item, onReclassify, onDelete, t }) {
  const [open, setOpen] = useState(false)
  const exp = explorerTxUrl(item.chain, item.txRef)
  const lowConf = item.confidence != null && item.confidence < 0.4 && item.classification_status !== 'user_corrected'
  return (
    <div className="card--flat">
      <button onClick={() => setOpen((o) => !o)} className="w-full p-2.5 flex items-center gap-2.5 text-[12px] text-left">
        <span className="chip text-[9px] uppercase">{item.isManual ? t('portfolio.manual', { defaultValue: 'manual' }) : t('portfolio.imported', { defaultValue: 'imported' })}</span>
        <TxnTypeChip type={item.type} status={item.status} classification={item.classification_status} t={t} />
        <span className="text-[var(--fg-1)] font-medium truncate min-w-0">{item.title}</span>
        {item.protocol && <span className="chip text-[9px] text-[var(--fg-4)] hidden sm:inline">{item.protocol}</span>}
        {item.classification_status === 'user_corrected' && <span className="chip chip--accent text-[9px]">{t('portfolio.corrected', { defaultValue: 'corrected' })}</span>}
        {lowConf && <AlertTriangle className="h-3 w-3 text-amber-400 flex-shrink-0" />}
        <span className="ml-auto text-[10px] text-[var(--fg-5)] flex-shrink-0">{item.timestamp ? timeAgo(item.timestamp) : ''}</span>
      </button>
      {open && (
        <div className="px-2.5 pb-2.5 space-y-2 text-[12px] border-t border-[var(--border)] pt-2">
          {item.lineItems?.length ? (
            <div className="space-y-1">
              {item.lineItems.map((li, i) => (
                <div key={i} className="flex items-center gap-2">
                  <TokenLogo url={li.logo_url} symbol={li.symbol} />
                  <span className={li.direction === 'in' ? 'text-emerald-400' : 'text-[var(--fg-3)]'}>{li.direction === 'in' ? '+' : '−'}{fmtAmt(li.amount)}</span>
                  <span className="text-[var(--fg-1)] truncate">{liName(li)}</span>
                  {li.value_usd_at_tx != null && <span className="text-[var(--fg-5)] ml-auto">{usd(li.value_usd_at_tx)}</span>}
                </div>
              ))}
            </div>
          ) : <div className="text-[var(--fg-5)]">{item.summary || '—'}</div>}
          <div className="flex items-center gap-3 flex-wrap text-[11px] text-[var(--fg-5)]">
            {exp && <a href={exp} target="_blank" rel="noreferrer" className="hover:text-[var(--accent)]">{t('portfolio.tx.view_explorer', { defaultValue: 'View on explorer' })}</a>}
            {item.txRef && <span className="font-mono">{shortenId(item.txRef)}</span>}
            <label className="flex items-center gap-1">
              <span>{t('portfolio.tx.set_type', { defaultValue: 'Set type' })}:</span>
              <select className="select text-[11px] py-0.5" value="" onChange={(e) => e.target.value && onReclassify(item, e.target.value)}>
                <option value="">{typeLabel(item.type, t)}</option>
                {RECLASSIFY_TYPES.map((ty) => <option key={ty} value={ty}>{typeLabel(ty, t)}</option>)}
              </select>
            </label>
            {item.isManual && <button onClick={() => onDelete(item)} className="text-[var(--fg-5)] hover:text-red-400 flex items-center gap-1"><Trash2 className="h-3 w-3" /> {t('portfolio.tx.delete', { defaultValue: 'Delete' })}</button>}
          </div>
        </div>
      )}
    </div>
  )
}

function Transactions({ items, onReclassify, onDelete, processing, t }) {
  if (processing && !items.length) return <div className="card p-4 text-center text-[12px] text-[var(--fg-4)] flex items-center justify-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('portfolio.tx_state.processing', { defaultValue: 'Processing transaction history…' })}</div>
  if (!items.length) return <div className="card p-6 text-center text-[13px] text-[var(--fg-4)] leading-relaxed max-w-2xl mx-auto">{t('portfolio.no_txns', { defaultValue: 'No transactions yet. Balances sync immediately; transaction history (used for cost basis and P&L) imports in the background and may take a few minutes.' })}</div>
  return <div className="space-y-1.5">{items.map((x) => <ActivityRow key={`${x.kind}:${x.id}`} item={x} onReclassify={onReclassify} onDelete={onDelete} t={t} />)}</div>
}

// ── Portfolio intelligence ──────────────────────────────────────────────────
function IntelPanel({ intel, loading, onGenerate, t }) {
  const s = intel?.artifact?.structured
  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="eyebrow flex items-center gap-1.5"><Sparkles className="h-3.5 w-3.5 text-[var(--accent)]" /> {t('portfolio.intel', { defaultValue: 'Portfolio intelligence' })}</span>
        <button onClick={onGenerate} disabled={loading} className="btn btn--primary btn--sm">{loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : (s ? t('portfolio.refresh', { defaultValue: 'Refresh' }) : t('portfolio.generate', { defaultValue: 'Generate' }))}</button>
      </div>
      {intel?.blocked && <div className="card--flat p-3 text-[12px] text-amber-400">{s?.summary}</div>}
      {!intel && !loading && <p className="text-[13px] text-[var(--fg-4)]">{t('portfolio.intel_prompt', { defaultValue: 'Generate grounded, easy-to-understand context on what changed, what is driving it, signal exposure, and risks — based only on your real holdings and market data.' })}</p>}
      {s && !intel.blocked && (
        <div className="space-y-2.5 text-[13px] text-[var(--fg-2)] leading-relaxed">
          {s.summary && <p>{s.summary}</p>}
          {[['what_changed', 'portfolio.what_changed', 'What changed'], ['contributors', 'portfolio.contributors', 'Top contributors'], ['signal_exposure', 'portfolio.signal_exposure', 'Signal exposure'], ['risks', 'portfolio.risks', 'Risks'], ['news_that_matters', 'portfolio.news', 'News that matters']].map(([k, kk, def]) =>
            s[k] ? <div key={k}><div className="eyebrow mt-1">{t(kk, { defaultValue: def })}</div><p className="text-[var(--fg-3)]">{s[k]}</p></div> : null)}
        </div>
      )}
    </div>
  )
}

// ── Page ────────────────────────────────────────────────────────────────────
export default function PortfolioPage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase, user } = useSupabase()
  const [portfolios, setPortfolios] = useState([])
  const [activeId, setActiveId] = useState(null)
  const [portfolio, setPortfolio] = useState(null)
  const [holdings, setHoldings] = useState([])
  const [sources, setSources] = useState([])
  const [txns, setTxns] = useState([])
  const [snapshots, setSnapshots] = useState([])
  const [benchmarks, setBenchmarks] = useState({})
  const [ctxMap, setCtxMap] = useState({})
  const [intel, setIntel] = useState(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [intelLoading, setIntelLoading] = useState(false)
  const [error, setError] = useState(null)
  const [showForm, setShowForm] = useState(false)
  const [hideDust, setHideDustState] = useState(false)

  // Display filter (persisted per portfolio). Totals/allocation/P&L/AI all still
  // use the full holdings set — this only changes what the table renders.
  const visibleHoldings = useMemo(() => hideDust ? holdings.filter((h) => !isHiddenDust(h)) : holdings, [hideDust, holdings])
  const dustHiddenCount = useMemo(() => holdings.filter(isHiddenDust).length, [holdings])

  const onToggleDust = useCallback(async () => {
    const next = !hideDust
    setHideDustState(next)
    setPortfolio((p) => p ? { ...p, hide_dust: next } : p)   // optimistic
    try { await api.setHideDust(supabase, activeId, next) }
    catch (e) { setError(e.message); setHideDustState(!next); setPortfolio((p) => p ? { ...p, hide_dust: !next } : p) }
  }, [hideDust, supabase, activeId])

  const loadList = useCallback(async () => {
    if (!org?.id) return
    setLoading(true); setError(null)
    try {
      const list = await api.listPortfolios(supabase, org.id)
      setPortfolios(list)
      setActiveId((cur) => cur && list.find((p) => p.id === cur) ? cur : (list.find((p) => p.is_default) || list[0])?.id || null)
    } catch (e) { setError(e.message) } finally { setLoading(false) }
  }, [org?.id, supabase])

  const loadPortfolio = useCallback(async (id) => {
    if (!id || !org?.id) return
    try {
      const { portfolio, holdings, sources } = await api.getPortfolio(supabase, org.id, id)
      setPortfolio(portfolio); setHoldings(holdings); setSources(sources); setHideDustState(!!portfolio?.hide_dust)
      const [tx, snaps, ctx, bench] = await Promise.all([
        api.listActivity(supabase, org.id, id), api.getSnapshots(supabase, org.id, id), api.hydrateHoldingsContext(supabase, holdings), api.getBenchmarkSeries(supabase),
      ])
      setTxns(tx); setSnapshots(snaps); setCtxMap(ctx); setBenchmarks(bench || {}); setIntel(null)
    } catch (e) { setError(e.message) }
  }, [org?.id, supabase])

  useEffect(() => { loadList() }, [loadList])
  useEffect(() => { if (activeId) loadPortfolio(activeId) }, [activeId, loadPortfolio])
  useEffect(() => () => { if (org?.id) markSurfaceSeen(supabase, 'portfolio') }, [org?.id, supabase])

  const createPortfolio = useCallback(async () => {
    try { const p = await api.createPortfolio(supabase, org.id, user?.id, { name: 'My Portfolio', isDefault: portfolios.length === 0 }); await loadList(); setActiveId(p.id) }
    catch (e) { setError(e.message) }
  }, [supabase, org?.id, user?.id, portfolios.length, loadList])

  const onSync = useCallback(async () => {
    if (!activeId) return
    setSyncing(true); setError(null)
    try { await api.syncPortfolio(supabase, org.id, activeId, {}); await loadPortfolio(activeId) }
    catch (e) { setError(e.message) } finally { setSyncing(false) }
  }, [activeId, supabase, org?.id, loadPortfolio])

  const onGenerate = useCallback(async () => {
    if (!activeId) return
    setIntelLoading(true); setError(null)
    try { setIntel(await api.getPortfolioIntel(supabase, org.id, activeId)) }
    catch (e) { setError(e.message) } finally { setIntelLoading(false) }
  }, [activeId, supabase, org?.id])

  const addTxn = useCallback(async (f) => { await api.addTransaction(supabase, org.id, user?.id, activeId, f); await loadPortfolio(activeId) }, [supabase, org?.id, user?.id, activeId, loadPortfolio])
  const reclassify = useCallback(async (item, type) => { await api.reclassifyActivity(supabase, org.id, activeId, item, type); await loadPortfolio(activeId) }, [supabase, org?.id, activeId, loadPortfolio])
  const delTxn = useCallback(async (item) => { await api.deleteActivity(supabase, org.id, activeId, item); await loadPortfolio(activeId) }, [supabase, org?.id, activeId, loadPortfolio])
  const onDeletePortfolio = useCallback(async () => {
    if (!window.confirm(t('portfolio.confirm_delete', { defaultValue: 'Delete this portfolio and all its private data (holdings, transactions, snapshots, AI memory)? This cannot be undone.' }))) return
    try { await api.deletePortfolio(supabase, activeId); setActiveId(null); await loadList() } catch (e) { setError(e.message) }
  }, [supabase, activeId, loadList, t])

  if (loading) return <div className="min-h-[60vh] grid place-items-center"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--accent)]" /></div>

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="eyebrow flex items-center gap-1.5"><Briefcase className="h-3.5 w-3.5" /> {t('brand.name', { defaultValue: 'Investor Intel' })}</div>
          <h1 className="page-title">{t('nav.portfolio', { defaultValue: 'Portfolio' })}</h1>
          <p className="page-sub">{t('pages.portfolio_sub', { defaultValue: 'Your holdings, P&L, performance, and grounded AI context — read-only, not financial or tax advice.' })}</p>
        </div>
        {portfolios.length > 0 && (
          <div className="flex items-center gap-2">
            {portfolios.length > 1 && (
              <select className="select" value={activeId || ''} onChange={(e) => setActiveId(e.target.value)}>{portfolios.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            )}
            <button onClick={onSync} disabled={syncing} className="btn btn--ghost btn--sm" title={t('portfolio.sync_now', { defaultValue: 'Sync now' })}><RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} /></button>
          </div>
        )}
      </div>

      <IntelErrorNotice error={error} />

      {portfolios.length === 0 ? (
        <div className="card p-10 text-center space-y-3">
          <Briefcase className="h-8 w-8 mx-auto text-[var(--fg-4)]" />
          <p className="text-[14px] text-[var(--fg-2)]">{t('portfolio.empty', { defaultValue: 'No portfolio yet. Create one, then connect a wallet or add a transaction.' })}</p>
          <button onClick={createPortfolio} className="btn btn--primary mx-auto"><Plus className="h-4 w-4" /> {t('portfolio.create', { defaultValue: 'Create portfolio' })}</button>
        </div>
      ) : (
        <>
          <Overview portfolio={portfolio} holdings={holdings} warnHoldings={visibleHoldings} t={t} />

          <WalletSyncPanel supabase={supabase} orgId={org.id} userId={user?.id} portfolioId={activeId} sources={sources} onChange={() => loadPortfolio(activeId)} t={t} />

          <PortfolioPerformanceChart series={snapshots} compare={benchmarks} loading={false} />

          <section className="space-y-2">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <span className="eyebrow">{t('portfolio.holdings', { defaultValue: 'Holdings' })}</span>
              <div className="flex items-center gap-2">
                {(dustHiddenCount > 0 || hideDust) && (
                  <button
                    onClick={onToggleDust}
                    className={`btn btn--ghost btn--sm ${hideDust ? 'text-[var(--accent)]' : ''}`}
                    title={t('portfolio.hide_dust_hint', { defaultValue: 'Hide non-stablecoin, non-Layer-1 tokens worth under $1.' })}
                  >
                    {hideDust ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    {t('portfolio.hide_dust', { defaultValue: 'Hide dust' })}
                    {hideDust && dustHiddenCount > 0 ? ` · ${dustHiddenCount} ${t('portfolio.dust_hidden', { defaultValue: 'hidden' })}` : ''}
                  </button>
                )}
                <button onClick={() => api.downloadCsv(`holdings-${activeId}.csv`, holdings, api.HOLDINGS_CSV_COLUMNS)} className="btn btn--ghost btn--sm"><Download className="h-3.5 w-3.5" /> CSV</button>
              </div>
            </div>
            <HoldingsTable holdings={visibleHoldings} ctxMap={ctxMap} portfolioId={activeId} t={t} />
          </section>

          <IntelPanel intel={intel} loading={intelLoading} onGenerate={onGenerate} t={t} />

          <section className="space-y-2">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <span className="eyebrow">{t('portfolio.transactions', { defaultValue: 'Transactions' })}</span>
              <div className="flex gap-2">
                <button onClick={() => api.downloadCsv(`transactions-${activeId}.csv`, txns, api.ACTIVITY_CSV_COLUMNS)} className="btn btn--ghost btn--sm"><Download className="h-3.5 w-3.5" /> CSV</button>
                <button onClick={() => setShowForm((v) => !v)} className="btn btn--primary btn--sm"><Plus className="h-3.5 w-3.5" /> {t('portfolio.add_txn', { defaultValue: 'Add transaction' })}</button>
              </div>
            </div>
            {showForm && <ManualTxnForm onSubmit={addTxn} onClose={() => setShowForm(false)} t={t} />}
            <Transactions items={txns} onReclassify={reclassify} onDelete={delTxn} processing={syncing} t={t} />
          </section>

          <section className="card--flat p-3 flex items-center justify-between flex-wrap gap-2">
            <span className="text-[12px] text-[var(--fg-3)] flex items-center gap-1.5"><Bell className="h-3.5 w-3.5" /> {t('portfolio.alerts_hint', { defaultValue: 'Set price, value and risk alerts on your holdings.' })}</span>
            <Link to="/intel/alerts" className="btn btn--ghost btn--sm">{t('nav.alerts', { defaultValue: 'Alerts' })}</Link>
          </section>

          <div className="flex items-center justify-between flex-wrap gap-2 pt-1">
            <button onClick={onDeletePortfolio} className="text-[12px] text-[var(--fg-5)] hover:text-red-400 flex items-center gap-1.5"><Trash2 className="h-3.5 w-3.5" /> {t('portfolio.delete_portfolio', { defaultValue: 'Delete portfolio' })}</button>
            <button onClick={() => api.clearPortfolioMemory(supabase, activeId).then(() => loadPortfolio(activeId))} className="text-[12px] text-[var(--fg-5)] hover:text-[var(--fg-2)]">{t('portfolio.clear_memory', { defaultValue: 'Clear AI memory' })}</button>
          </div>
        </>
      )}

      {activeId && <PortfolioExposureCards portfolioId={activeId} />}

      <RelevantSignals title={t('portfolio.relevant_signals', { defaultValue: 'Signals affecting your holdings' })} seeAllHref="/intel" />

      <IntelDisclaimer variant="block" />
      <div className="card--flat p-3 text-[11px] text-[var(--fg-5)] leading-relaxed">{t('portfolio.disclaimer', { defaultValue: 'Portfolio calculations are informational only and are not tax, accounting, investment, or financial advice. Cost basis and P&L may be incomplete when transaction history is missing, unclassified, or manually edited.' })}</div>
    </div>
  )
}
