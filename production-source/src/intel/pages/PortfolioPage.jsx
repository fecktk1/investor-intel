import {portfolioReadingHistoryEnabled} from '../lib/portfolio-research-rollout'
import {usePortfolioResearch} from '../lib/usePortfolioResearch'
import {portfolioSyncChangesActivity} from '../lib/portfolio-refresh'
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import {
  Briefcase, Plus, Trash2, Download, RefreshCw, AlertTriangle, Bell, Loader2, X, Clock,
} from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { CHAINS, explorerTxUrl } from '../lib/chains'
import { shortenId } from '../lib/canonical'
import { fmtPrice, fmtPct, fmtVol, pctClass, timeAgo } from '../lib/market-format'
import MarketSignalBadge from '../components/MarketSignalBadge'
import IntelDisclaimer from '../components/IntelDisclaimer'
import IntelErrorNotice from '../components/IntelErrorNotice'
import IntelSurfaceGate from '../components/IntelSurfaceGate'
import RelevantSignals from '../components/RelevantSignals'
import PortfolioExposureCards from '../components/PortfolioExposureCards'
import { markSurfaceSeen } from '../lib/changes-api'
const WalletSyncPanel = React.lazy(() => import('../components/WalletSyncPanel'))
// Recharts is about 110 KB gzipped; the summary and holdings render without it.
const PortfolioPerformanceChart = React.lazy(() => import('../components/PortfolioPerformanceChart'))
const PortfolioHistoricalPerformance=React.lazy(()=>import('../components/PortfolioHistoricalPerformance'))
import * as api from '../lib/portfolio-api'
import { usePortfolioSelection } from '../lib/PortfolioSelectionContext'
import { localDateTimeValue } from '../lib/portfolio-markers'
import PortfolioNameDialog from '../components/PortfolioNameDialog'
import PortfolioResearchPanel from '../components/PortfolioResearchPanel'
import PortfolioHoldingsSection,{PortfolioPageControls} from '../components/PortfolioHoldingsSection'
import PortfolioIdentityCoverage from '../components/PortfolioIdentityCoverage'
import PortfolioActivitySection from '../components/PortfolioActivitySection'
import PortfolioActivityLegs from '../components/PortfolioActivityLegs'
import {portfolioActivityRoute} from '../lib/portfolio-activity-route'
import {assetLogoUrl} from '../lib/asset-identity'
import TokenAvatar from '../components/TokenAvatar'
import SourceCallReceipt from '../components/SourceCallReceipt'

/** What answered each position's valuation. Read only when the reader opens it,
 * from intel-portfolio after its surface gate. The valuation uses stored prices,
 * so every receipt says no provider call was made for this view. */
export function PortfolioValuationReceipts({supabase,orgId,portfolioId,t}){
  const [open,setOpen]=useState(false),[state,setState]=useState({loading:false,error:null,receipts:null})
  useEffect(()=>{
    if(!open||!supabase||!orgId||!portfolioId)return
    let alive=true
    setState({loading:true,error:null,receipts:null})
    supabase.functions.invoke('intel-portfolio',{body:{orgId,portfolioId,operation:'valuation_receipts'}})
      .then(({data,error})=>{if(!alive)return;if(error||!Array.isArray(data?.receipts))throw new Error('read_failed');setState({loading:false,error:null,receipts:data.receipts})})
      .catch(()=>{if(alive)setState({loading:false,error:true,receipts:null})})
    return()=>{alive=false}
  },[open,supabase,orgId,portfolioId])
  const scope=t('portfolio.valuation_receipts_scope',{defaultValue:'This position is valued from the stored price, so no provider call was made for this view.'})
  return <details className="intel-open-section" onToggle={e=>setOpen(e.currentTarget.open)}>
    <summary>{t('portfolio.valuation_receipts',{defaultValue:'Valuation source receipts'})}</summary>
    {state.loading?<p role="status">{t('portfolio.valuation_receipts_loading',{defaultValue:'Loading valuation receipts…'})}</p>
      :state.error?<p role="alert">{t('portfolio.valuation_receipts_error',{defaultValue:'Valuation receipts could not be read. Your holdings are unchanged.'})}</p>
      :state.receipts&&(state.receipts.length?state.receipts.map(r=><section key={r.canonicalAssetKey} className="py-2"><p className="intel-analysis-caption break-all">{r.symbol||r.canonicalAssetKey}</p><SourceCallReceipt receipt={r.receipt} scope={scope} observedAt={r.observedAt}/></section>)
        :<p>{t('portfolio.valuation_receipts_none',{defaultValue:'No open position is valued from a stored CoinMarketCap price.'})}</p>)}
  </details>
}

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
  return <span className={`text-[9px] ${cls}`}>{t(`portfolio.support.${level}`, { defaultValue: def })}</span>
}

// Token logo with a monogram fallback (never a broken image).
function TokenLogo({ url, symbol, assetKey }) {
  const src = typeof url === 'string' && /^https:\/\//.test(url) ? url : assetLogoUrl(assetKey)
  return <TokenAvatar src={src} symbol={symbol} size="sm" />
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
  else if (cb === 'estimated') chips.push(['cbe', t('portfolio.cost_basis_status.estimated', { defaultValue: 'Estimated cost basis' }), 'text-[var(--accent)]'])
  else if (cb === 'none') chips.push(['cbn', t('portfolio.cost_basis_status.none', { defaultValue: 'Balance only, no P&L' }), 'text-[var(--fg-4)]'])
  else if (cb === 'incomplete' || cb === 'partial' || (!cb && h.pnl_state === 'incomplete_history')) chips.push(['inc', t('portfolio.cost_basis_status.incomplete', { defaultValue: 'Cost basis incomplete' }), 'text-[var(--fg-4)]'])
  if (h.reconciliation_status === 'wallet_only') chips.push(['wo', t('portfolio.states.wallet_only', { defaultValue: 'Wallet synced, tx history incomplete' }), 'text-[var(--fg-5)]'])
  else if (h.reconciliation_status === 'wallet_higher' || h.reconciliation_status === 'wallet_lower') chips.push(['drift', cb === 'estimated'
    ? t('portfolio.states.wallet_reconciled', { defaultValue: 'Basis reconciled to wallet balance' })
    : t('portfolio.states.wallet_mismatch', { defaultValue: 'Wallet and transaction history do not match' }), cb === 'estimated' ? 'text-[var(--fg-4)]' : 'text-amber-400'])
  return chips.length ? <span className="flex flex-wrap gap-1">{chips.map(([k, label, cls]) => <span key={k} title={k === 'stale' ? t('portfolio.states.quote_stale_hint', { defaultValue: 'This quote is past its source refresh window. See the recorded observation time above.' }) : undefined} className={`text-[9px] ${cls}`}>{label}</span>)}</span> : null
}

// ── Overview ────────────────────────────────────────────────────────────────
function Overview({ portfolio, holdings, warnHoldings, summary, hideDust, t }) {
  const total = portfolio?.total_value_usd ?? 0
  const stats = [
    [(summary?.missingValueCount??holdings.filter(h=>!h.is_closed&&h.current_value==null).length)>0?'Priced subtotal':t('portfolio.total_value', { defaultValue: 'Total value' }), (summary?summary.openCount>0&&summary.missingValueCount===summary.openCount:holdings.some(h=>!h.is_closed)&&holdings.every(h=>h.is_closed||h.current_value==null))?'Unavailable':usd(total), ''],
    [t('portfolio.change_24h', { defaultValue: '24h change' }), fmtPct(portfolio?.day_pnl_pct), pctClass(portfolio?.day_pnl_pct)],
    [t('portfolio.unrealized_pnl', { defaultValue: 'Unrealized P&L' }), usd(portfolio?.unrealized_pnl_usd), pctClass(portfolio?.unrealized_pnl_usd)],
    [t('portfolio.realized_pnl', { defaultValue: 'Realized P&L' }), usd(portfolio?.realized_pnl_usd), pctClass(portfolio?.realized_pnl_usd)],
  ]
  const byChain = useMemo(() => {
    if(summary)return (summary.byChain||[]).map(c=>({label:c.label,pct:total>0?c.value/total*100:0})).slice(0,5)
    const m = new Map()
    for (const h of holdings) m.set(h.chain || 'unknown', (m.get(h.chain || 'unknown') || 0) + (h.current_value || 0))
    return [...m.entries()].map(([label, v]) => ({ label, pct: total > 0 ? (v / total) * 100 : 0 })).sort((a, b) => b.pct - a.pct).slice(0, 5)
  }, [holdings, total, summary])
  // Price-freshness warning reflects what the user is actually viewing: when dust
  // is hidden, its unpriced rows no longer raise an alarm.
  const warn = warnHoldings || holdings
  const unpriced = summary?(hideDust?summary.visibleUnpriced:summary.unpriced):warn.filter((h) => h.price_status === 'unpriced').length
  const stale = summary?(hideDust?summary.visibleStale:summary.stale):warn.filter((h) => h.price_status === 'stale').length
  const quoteTimes=warn.map(h=>Date.parse(h.last_priced_at||'')).filter(Number.isFinite)
  const oldestQuote=summary?(hideDust?summary.visibleOldestQuote:summary.oldestQuote):quoteTimes.length?new Date(Math.min(...quoteTimes)).toISOString():null

  return (
    <div className="space-y-3">
      {portfolio?.market_data_available === false && (
        <div className="border-b border-[var(--border-default)] rounded-none p-2.5 text-[12px] text-amber-400 flex items-center gap-2"><AlertTriangle className="h-3.5 w-3.5" />{t('portfolio.market_unavailable', { defaultValue: 'Market pricing unavailable until exchange market data is initialized.' })}</div>
      )}
      {(unpriced > 0 || stale > 0) && (
        <div className="border-b border-[var(--border-default)] rounded-none p-2.5 text-[12px] text-[var(--fg-3)] flex items-start gap-2">
          <Clock className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 text-amber-400" />
          <div className="leading-relaxed">
            <span className="text-amber-400">{t('portfolio.states.pnl_incomplete', { defaultValue: 'Market pricing has gaps' })}</span>: {unpriced} {t('portfolio.unpriced_n', { defaultValue: 'unpriced' })}, {stale} {t('portfolio.stale_n', { defaultValue: 'stale' })}.{' '}
            {oldestQuote&&<>Oldest quote <time dateTime={oldestQuote}>{new Date(oldestQuote).toLocaleString(undefined,{timeZoneName:'short'})}</time>. </>}
            Use Sync now to request shared quote refreshes; missing provider coverage stays visible.
          </div>
        </div>
      )}
      {summary?.observedAt&&<p className="text-xs text-[var(--fg-4)]">Positions valued <time dateTime={summary.observedAt}>{new Date(summary.observedAt).toLocaleTimeString()}</time> · updated here every minute</p>}
      <dl className="intel-portfolio-summary">
        {stats.map(([label, val, cls]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd className={cls}>{val}</dd>
          </div>
        ))}
      </dl>
      <div className="intel-portfolio-allocation">
        <div className="min-w-0">
          <div className="text-xs text-[var(--fg-4)] mb-2">{t('portfolio.by_chain', { defaultValue: 'By chain' })}</div>
          {byChain.map((c) => (
            <div key={c.label} className="flex items-center gap-2 mb-1.5">
              <span className="text-[12px] text-[var(--fg-2)] w-20 truncate">{c.label}</span>
              <div className="flex-1 h-1.5 rounded-full bg-[var(--bg-3)] overflow-hidden"><div className="h-full bg-[var(--accent)]" style={{ width: `${c.pct}%` }} /></div>
              <span className="text-[11px] text-[var(--fg-4)] w-10 text-right">{c.pct.toFixed(0)}%</span>
            </div>
          ))}
        </div>
        <div className="flex flex-col justify-center gap-2">
          <div className="flex items-center justify-between"><span className="text-[12px] text-[var(--fg-3)]">{t('portfolio.stablecoin_pct', { defaultValue: 'Stablecoins' })}</span><span className="text-[13px] text-[var(--fg-1)]">{(portfolio?.stablecoin_pct ?? 0).toFixed(1)}%</span></div>
          <div className="flex items-center justify-between"><span className="text-[12px] text-[var(--fg-3)]">{t('portfolio.recorded_risk_score', { defaultValue: 'Recorded risk score' })}</span><span className="text-[13px] text-[var(--fg-1)]">{portfolio?.risk_score == null ? '—' : `${Math.round(portfolio.risk_score)}/100`}</span></div>
          <div className="flex items-center justify-between"><span className="text-[12px] text-[var(--fg-3)]">{t('portfolio.holdings', { defaultValue: 'Holdings' })}</span><span className="text-[13px] text-[var(--fg-1)]">{summary?.openCount??holdings.length}</span></div>
        </div>
      </div>
    </div>
  )
}

// ── Holdings table ──────────────────────────────────────────────────────────
export function HoldingsTable({holdings,portfolioId,returnState,closed=false,t}) {
 return <div className="intel-holding-scroll" tabIndex={0} role="region" aria-label={closed?'Realized positions table':'Holdings table'}><table className="intel-holding-table"><thead><tr>{['Asset','Quantity','Price','24h','Value','Allocation',closed?'Realized P&L':'Unrealized P&L','Signal'].map(label=><th scope="col" key={label}>{label}</th>)}</tr></thead><tbody>{holdings.map(h=>{
  const sym=h.asset_symbol||h.normalized_symbol||'Unknown',ctx=h.market_context?.canonicalAssetKey===h.canonical_asset_key?h.market_context:null
  return <tr key={h.id}><td><div className="flex items-center gap-2"><TokenLogo url={h.logo_url} symbol={sym} assetKey={h.canonical_asset_key}/><div>{h.canonical_asset_key?<Link state={returnState} to={'/intel/portfolio/'+portfolioId+'/asset/'+encodeURIComponent(h.canonical_asset_key)}>{sym}</Link>:sym}<span className="ml-2 text-[var(--fg-4)]">{h.chain}</span>{h.name&&<div className="text-[var(--fg-4)]">{h.name}</div>}</div></div><StateChips h={h} t={t}/><details><summary>Basis and source</summary><p>Cost basis {usd(h.cost_basis_usd)} · {h.asset_class||'Asset class unavailable'}</p><SupportBadge level={h.support_level} t={t}/><p>{h.price_source||'Price source unavailable'} · {h.last_priced_at?new Date(h.last_priced_at).toLocaleString(undefined,{timeZoneName:'short'}):'Observation time unavailable'}</p></details></td><td>{fmtAmt(h.quantity)}</td><td>{fmtPrice(h.current_price)}</td><td className={pctClass(h.day_pnl_pct)}>{fmtPct(h.day_pnl_pct)}</td><td>{usd(h.current_value)}</td><td>{h.allocation_pct==null?'—':Number(h.allocation_pct).toFixed(1)+'%'}</td><td className={pctClass(closed?h.realized_pnl:h.unrealized_pnl)}>{usd(closed?h.realized_pnl:h.unrealized_pnl)}</td><td>{ctx?.signalDirection?<MarketSignalBadge direction={ctx.signalDirection} size="sm" title={[ctx.signalConfidence,ctx.providerCount?String(ctx.confirmingProviders??'?')+'/'+ctx.providerCount+' sources confirm':null,ctx.whyItMatters||ctx.title||ctx.summary].filter(Boolean).join(' · ')}/>: '—'}</td></tr>
 })}</tbody></table></div>
}

// ── Manual transaction form ─────────────────────────────────────────────────
function ManualAssetInputs({ value, onChange, prefix='', needsPrice,t }) {
  const set=(key)=>(event)=>onChange({...value,[key]:event.target.value})
  return <div className="grid grid-cols-2 gap-3">
    <label><span className="text-xs text-[var(--fg-4)]">{prefix}{t('portfolio.asset_kind',{defaultValue:'Asset type'})}</span><select className="select w-full" value={value.assetKind} onChange={e=>onChange({...value,assetKind:e.target.value,contractAddress:'',symbol:e.target.value==='native'?CHAINS.find(c=>c.id===value.chain)?.nativeSymbol||'':''})}><option value="native">Native asset</option><option value="token">Token</option></select></label>
    <label><span className="text-xs text-[var(--fg-4)]">{prefix}{t('portfolio.cols.chain',{defaultValue:'Chain'})}</span><select className="select w-full" value={value.chain} onChange={e=>onChange({...value,chain:e.target.value,contractAddress:'',symbol:value.assetKind==='native'?CHAINS.find(c=>c.id===e.target.value)?.nativeSymbol||'':value.symbol})}>{CHAINS.map(c=><option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
    <label><span className="text-xs text-[var(--fg-4)]">{prefix}{t('portfolio.cols.asset',{defaultValue:'Asset'})}</span><input className="input w-full" required readOnly={value.assetKind==='native'} value={value.symbol} onChange={set('symbol')}/></label>
    <label><span className="text-xs text-[var(--fg-4)]">{prefix}{t('portfolio.cols.qty',{defaultValue:'Quantity'})}</span><input className="input w-full" type="number" min="0" step="any" required value={value.quantity} onChange={set('quantity')}/></label>
    {value.assetKind==='token'&&<label className="col-span-2"><span className="text-xs text-[var(--fg-4)]">{prefix}{t('portfolio.contract_or_mint',{defaultValue:'Contract or mint'})}</span><input className="input w-full font-mono" required spellCheck={false} autoComplete="off" maxLength={240} value={value.contractAddress} onChange={set('contractAddress')}/></label>}
    <label className="col-span-2"><span className="text-xs text-[var(--fg-4)]">{prefix}{t('portfolio.price_per_unit_usd',{defaultValue:'Price / unit (USD)'})}</span><input className="input w-full" type="number" min="0" step="any" required={needsPrice} value={value.pricePerUnit} onChange={set('pricePerUnit')}/></label>
  </div>
}
export function ManualTxnForm({ onSubmit, onClose, t }) {
  const [f,setF]=useState({transactionType:'buy',direction:'',assetKind:'native',contractAddress:'',symbol:'SOL',chain:'solana',quantity:'',pricePerUnit:'',currency:'USD',fees:'',datetime:localDateTimeValue(),source:'',notes:'',pairedSwap:true,
    received:{assetKind:'native',contractAddress:'',symbol:'ETH',chain:'base',quantity:'',pricePerUnit:''}})
  const [busy,setBusy]=useState(false),[error,setError]=useState(null)
  const operationId=useRef(crypto.randomUUID()),saving=useRef(false)
  const set=key=>event=>setF(prev=>({...prev,[key]:event.target.value}))
  const paired=f.transactionType==='swap'&&f.pairedSwap
  const submit=async(event)=>{
    event.preventDefault();if(saving.current)return;saving.current=true;setBusy(true);setError(null)
    const datetime=new FormData(event.currentTarget).get('datetime')||f.datetime
    try{await onSubmit({...f,datetime,operationId:operationId.current});onClose()}
    catch(error){setError(error.message)}finally{saving.current=false;setBusy(false)}
  }
  return <form onSubmit={submit} className="border-y border-[var(--border-default)] py-4 space-y-4">
    <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">{t('portfolio.add_txn',{defaultValue:'Add transaction'})}</h2><button type="button" aria-label="Close transaction form" onClick={onClose} className="btn btn--ghost btn--sm"><X className="h-4 w-4"/></button></div>
    <div className="flex items-end gap-5 flex-wrap">
      <label><span className="block text-xs text-[var(--fg-4)]">{t('portfolio.cols.type',{defaultValue:'Type'})}</span><select className="select" value={f.transactionType} onChange={set('transactionType')}>{TX_TYPES.map(type=><option key={type} value={type}>{t('portfolio.txn_type.'+type,{defaultValue:type.replace(/_/g,' ')})}</option>)}</select></label>
      {f.transactionType==='swap'&&<label className="flex items-center gap-2 text-sm py-2"><input type="checkbox" checked={f.pairedSwap} onChange={e=>setF(p=>({...p,pairedSwap:e.target.checked}))}/>Record both assets together</label>}
      {f.transactionType==='swap'&&!paired&&<label><span className="block text-xs text-[var(--fg-4)]">Swap leg</span><select className="select" required value={f.direction} onChange={set('direction')}><option value="">Choose direction</option><option value="out">Asset sent</option><option value="in">Asset received</option></select></label>}
    </div>
    <div className={paired?'grid md:grid-cols-2 gap-6':'max-w-2xl'}>
      <fieldset className="min-w-0"><legend className="text-sm font-semibold mb-3">{paired?'Asset sent':'Asset and amount'}</legend><ManualAssetInputs value={f} onChange={value=>setF(p=>({...p,...value}))} prefix={paired?'Sent ':''} needsPrice={['buy','sell','swap'].includes(f.transactionType)} t={t}/></fieldset>
      {paired&&<fieldset className="min-w-0"><legend className="text-sm font-semibold mb-3">Asset received</legend><ManualAssetInputs value={f.received} onChange={received=>setF(p=>({...p,received}))} prefix="Received " needsPrice t={t}/></fieldset>}
    </div>
    <div className="grid sm:grid-cols-3 gap-3">
      <label><span className="text-xs text-[var(--fg-4)]">Fees (USD)</span><input className="input w-full" type="number" min="0" step="any" value={f.fees} onChange={set('fees')}/></label>
      <label><span className="text-xs text-[var(--fg-4)]">{t('portfolio.datetime',{defaultValue:'Date / time'})}</span><input className="input w-full" name="datetime" type="datetime-local" required value={f.datetime} onInput={set('datetime')} onChange={set('datetime')}/></label>
      <label><span className="text-xs text-[var(--fg-4)]">{t('portfolio.source',{defaultValue:'Exchange / wallet'})}</span><input className="input w-full" maxLength={200} value={f.source} onChange={set('source')}/></label>
    </div>
    <label className="block"><span className="text-xs text-[var(--fg-4)]">{t('portfolio.notes',{defaultValue:'Your notes'})}</span><textarea className="input w-full min-h-24 rounded-none mt-1.5" maxLength={20000} value={f.notes} onChange={set('notes')} placeholder={t('portfolio.notes_placeholder',{defaultValue:'What led to this decision?'})}/></label>
    <p className="text-xs text-[var(--fg-4)]">Time zone: {Intl.DateTimeFormat().resolvedOptions().timeZone}{paired?' · Both assets share this time and note. The fee is recorded once against the asset sent.':''}</p>
    {error&&<p role="alert">{error}</p>}
    <button type="submit" disabled={busy||!f.symbol.trim()} className="btn btn--primary">{busy?'Saving…':paired?'Record swap':t('portfolio.record_txn',{defaultValue:'Record transaction'})}</button>
  </form>
}

function TxnTypeChip({ type, status, classification, t }) {
  const failed = status === 'failed'
  const unknown = type === 'unknown'
  const needsReview = classification === 'unclassified'
  const cls = failed || unknown || needsReview ? 'text-amber-400' : 'text-[var(--fg-2)]'
  const label = failed ? t('portfolio.tx_state.failed', { defaultValue: 'Failed' }) : unknown ? t('portfolio.tx_state.unknown', { defaultValue: 'Unknown' }) : typeLabel(type, t)
  return <span className={`text-[10px] ${cls}`}>{label}</span>
}

export function ActivityRow({ item, onReclassify, onDelete, t, supabase, orgId, userId, portfolioId, returnState }) {
  const [open, setOpen] = useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(null)
  const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
  const change=async action=>{if(busy)return;setBusy(true);setError(null);try{await action()}catch(e){if(alive.current)setError(e.message||'The activity could not be updated.')}finally{if(alive.current)setBusy(false)}}
  const types=item.manualGroupId?RECLASSIFY_TYPES.filter(type=>['buy','sell','swap','transfer_in','transfer_out','bridge','wrap','unwrap','lp_add','lp_remove','stake','unstake','unknown'].includes(type)):RECLASSIFY_TYPES
  const exp = explorerTxUrl(item.chain, item.txRef)
  const lowConf = item.confidence != null && item.confidence < 0.4 && item.classification_status !== 'user_corrected'
  return (
    <div className="border-b border-[var(--border-default)] rounded-none">
      <button aria-expanded={open} onClick={() => setOpen((o) => !o)} className="w-full p-2.5 flex items-center gap-2.5 text-[12px] text-left">
        <span className="text-[9px] uppercase">{item.isManual ? t('portfolio.manual', { defaultValue: 'manual' }) : t('portfolio.imported', { defaultValue: 'imported' })}</span>
        <TxnTypeChip type={item.type} status={item.status} classification={item.classification_status} t={t} />
        <span className="text-[var(--fg-1)] font-medium truncate min-w-0">{item.title}</span>
        {item.protocol && <span className="text-[9px] text-[var(--fg-4)] hidden sm:inline">{item.protocol}</span>}
        {item.classification_status === 'user_corrected' && <span className="text-[var(--accent)] text-[9px]">{t('portfolio.corrected', { defaultValue: 'corrected' })}</span>}
        {lowConf && <AlertTriangle className="h-3 w-3 text-amber-400 flex-shrink-0" />}
        <span className="ml-auto text-[10px] text-[var(--fg-5)] flex-shrink-0">{item.timestamp ? timeAgo(item.timestamp) : 'Time not recorded'}</span>
      </button>
      {open && (
        <div className="px-2.5 pb-2.5 space-y-2 text-[12px] border-t border-[var(--border)] pt-2">
          <div className="intel-activity-clock"><span>{item.timestamp&&Number.isFinite(Date.parse(item.timestamp))?new Date(item.timestamp).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'long'}):'Effective time not recorded'}</span>{item.timestamp&&Number.isFinite(Date.parse(item.timestamp))&&<time dateTime={item.timestamp}>{new Date(item.timestamp).toISOString()}</time>}<span>{item.source||'Source not recorded'} · {item.status||'Status not recorded'}</span>{item.recordedAt&&<span>Recorded {new Date(item.recordedAt).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'long'})}</span>}</div>
          {item.status&&item.status!=='success'&&<p className="intel-analysis-caption">{item.status==='failed'?'Failed transaction':item.status==='pending'?'Pending transaction':'Unconfirmed transaction'} · Recorded legs do not establish completed transfers.</p>}
          <PortfolioActivityLegs {...{item,supabase,orgId,userId,portfolioId}} render={legs=>legs.length?<div className="intel-activity-legs">{legs.map((li,i)=><div key={li.id||i} className="intel-activity-leg"><TokenLogo url={li.logo_url} symbol={li.symbol} assetKey={li.canonical_asset_key}/><span className="intel-activity-leg-amount">{li.direction==='in'?'+':li.direction==='out'?'−':''}{fmtAmt(li.amount)}</span><span>{li.canonical_asset_key&&portfolioId?<Link className="underline underline-offset-2" to={portfolioActivityRoute(portfolioId,li.canonical_asset_key,item)} state={returnState}>{liName(li)}</Link>:liName(li)}</span><span className="intel-activity-leg-value">{li.value_usd_at_tx!=null?usd(li.value_usd_at_tx):li.recorded_value!=null?fmtAmt(li.recorded_value)+' '+(li.quote_currency||'currency not recorded'):'Value not recorded'}</span><small>{li.canonical_asset_key||'Asset identity not recorded'}{li.price_usd_at_tx!=null?(['current_price_estimate','zero_value_unpriced'].includes(li.price_source_at_tx)?' · Estimated reference price ':' · Recorded price ')+fmtPrice(li.price_usd_at_tx)+' USD':li.recorded_price!=null?' · Recorded price '+fmtAmt(li.recorded_price)+' '+(li.quote_currency||'currency not recorded'):''}{li.price_source_at_tx?' · '+li.price_source_at_tx:''}</small></div>)}</div>:<p>{item.summary||'No asset legs recorded.'}</p>}/>
          {item.feeAmount != null && <div className="flex items-center justify-between text-[11px] text-[var(--fg-4)]">
            <span>{item.isManual?t('portfolio.fees',{defaultValue:'Fees'}):t('portfolio.network_fee', { defaultValue: 'Network fee' })}</span>
            <span>{fmtAmt(item.feeAmount)} {item.feeAsset || ''}{item.feeUsd != null ? ` · ${usd(item.feeUsd)}` : ''}</span>
          </div>}
          {item.notes && <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-[var(--fg-2)]">{item.notes}</p>}
          {error&&<p role="alert">{error}</p>}{busy&&<p role="status">Updating activity…</p>}
          {item.manualGroupId&&<p className="intel-analysis-caption">Both legs stay together. Buy/sell classifications preserve the recorded exchange; movement classifications preserve the sent and received directions. Original notes and fees remain recorded.</p>}
          <div className="flex items-center gap-3 flex-wrap text-[11px] text-[var(--fg-5)]">
            {exp && <a href={exp} target="_blank" rel="noreferrer" className="hover:text-[var(--accent)]">{t('portfolio.tx.view_explorer', { defaultValue: 'View on explorer' })}</a>}
            {item.txRef && <span className="font-mono">{shortenId(item.txRef)}</span>}
            <label className="flex items-center gap-1">
              <span>{t('portfolio.tx.set_type', { defaultValue: 'Set type' })}:</span>
              <select className="select text-[11px] py-0.5" value="" disabled={busy} onChange={(e) => e.target.value && change(()=>onReclassify(item, e.target.value))}>
                <option value="">{typeLabel(item.type, t)}</option>
                {types.map((ty) => <option key={ty} value={ty}>{typeLabel(ty, t)}</option>)}
              </select>
            </label>
            {item.isManual && <button disabled={busy} onClick={() => change(()=>onDelete(item))} className="text-[var(--fg-5)] hover:text-red-400 flex items-center gap-1"><Trash2 className="h-3 w-3" /> {t('portfolio.tx.delete', { defaultValue: 'Delete' })}</button>}
          </div>
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
  const { portfolios, portfolioId: activeId, selectPortfolio: setActiveId, refreshPortfolios, loading: selectionLoading, error: selectionError } = usePortfolioSelection()
  const [walletsOpen, setWalletsOpen] = useState(false)
  const [portfolio, setPortfolio] = useState(null)
  const [holdings, setHoldings] = useState([])
  const [sources, setSources] = useState([])
  const [workspace,setWorkspace]=useState(null),[sourcePage,setSourcePage]=useState(null),[sourceLoading,setSourceLoading]=useState(false)
  const [activityRevision,setActivityRevision]=useState(0)
  const [researchRevision,setResearchRevision]=useState(0)
  const research = usePortfolioResearch({supabase,orgId:org?.id,userId:user?.id,portfolioId:activeId,revision:researchRevision})
  const [snapshots, setSnapshots] = useState([])
  const [hasEarlierSnapshots, setHasEarlierSnapshots] = useState(false)
  const [loadingEarlierSnapshots, setLoadingEarlierSnapshots] = useState(false)
  const [benchmarks, setBenchmarks] = useState({})
  const [loading, setLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [clearingScope,setClearingScope]=useState(null)
  const historyEnabled=portfolioReadingHistoryEnabled()
  const [error, setError] = useState(null)
  const [showForm, setShowForm] = useState(false)
  const [nameAction, setNameAction] = useState(null)
  const nameTrigger = useRef(null)
  const [hideDust, setHideDustState] = useState(false)
  const openedPortfolioIds = useRef(new Set())
  const latestActiveId = useRef(null)
  latestActiveId.current = activeId
  const activeScope = JSON.stringify([user?.id, org?.id, activeId])
  const latestScope = useRef(activeScope)
  latestScope.current = activeScope
  const loadGeneration = useRef(0)
  const fullReadBusy=useRef(false)

  async function onClearResearch(){
    if(clearingScope===activeScope||!window.confirm(historyEnabled?t('portfolio.clear_readings_confirm',{defaultValue:'Delete every retained reading and clear AI memory for this portfolio? This permanently removes their saved words and evidence.'}):t('portfolio.clear_memory_confirm',{defaultValue:'Clear the stored AI memory for this portfolio?'})))return
    setClearingScope(activeScope)
    try{
      await api.clearPortfolioMemory(supabase,activeId)
      if(latestScope.current===activeScope){setError(null);setResearchRevision(value=>value+1)}
    }catch{
      if(latestScope.current===activeScope)setError(t('portfolio.clear_readings_failed',{defaultValue:'Portfolio readings could not be cleared. Please try again.'}))
    }finally{setClearingScope(value=>value===activeScope?null:value)}
  }

  // Display filter (persisted per portfolio). Totals/allocation/P&L/AI all still
  // use the full holdings set — this only changes what the table renders.
  const openHoldings = useMemo(() => holdings.filter((h) => !h.is_closed), [holdings])
  const visibleHoldings = useMemo(() => hideDust ? openHoldings.filter((h) => !isHiddenDust(h)) : openHoldings, [hideDust, openHoldings])
  const dustHiddenCount = useMemo(() => openHoldings.filter(isHiddenDust).length, [openHoldings])

  const onToggleDust = useCallback(async () => {
    const next = !hideDust
    setHideDustState(next)
    setWorkspace(w=>w?{...w,open:null}:w)
    setPortfolio((p) => p ? { ...p, hide_dust: next } : p)   // optimistic
    try { await api.setHideDust(supabase, activeId, next);if(latestScope.current===activeScope)await loadPortfolio(activeId,{activityChanged:false}) }
    catch (e) { if (latestScope.current === activeScope) { setError(e.message); setHideDustState(!next); setPortfolio((p) => p ? { ...p, hide_dust: !next } : p) } }
  }, [hideDust, supabase, activeId, activeScope])

  const loadList = useCallback(async () => {
    if (!org?.id) return
    setLoading(true); setError(null)
    try {
      await refreshPortfolios()
    } catch (e) { setError(e.message) } finally { setLoading(false) }
  }, [org?.id, refreshPortfolios])

  const loadPortfolio = useCallback(async (id,{activityChanged=true}={}) => {
    if (!id || !org?.id || latestActiveId.current !== id || latestScope.current !== activeScope) return
    const generation = ++loadGeneration.current
    fullReadBusy.current=true
    // Recheck deleted/private source text immediately, independently of positions.
    if(activityChanged){setActivityRevision(value=>value+1);setResearchRevision(value=>value+1)}
    try {
      const result = await api.getPortfolio(supabase, org.id, id)
      const { portfolio, holdings, sources } = result
      if (generation !== loadGeneration.current || latestActiveId.current !== id || latestScope.current !== activeScope) return
      setWorkspace({...result,scope:activeScope});setSourcePage(result.sourcePage);setPortfolio(portfolio); setHoldings(holdings); setSources(sources); setHideDustState(!!portfolio?.hide_dust)
      const [snaps, bench] = await Promise.all([
        api.getSnapshots(supabase, org.id, id), api.getBenchmarkSeries(supabase),
      ])
      if (generation !== loadGeneration.current || latestActiveId.current !== id || latestScope.current !== activeScope) return
      setSnapshots(snaps); setBenchmarks(bench || {})
      setHasEarlierSnapshots(snaps.length === 365)
    } catch (e) { if (generation === loadGeneration.current && latestActiveId.current === id && latestScope.current === activeScope) setError(e.message) }
    finally{if(generation===loadGeneration.current)fullReadBusy.current=false}
  }, [org?.id, user?.id, activeScope, supabase])

  // Read shared stored values; this clock never invokes sync, AI or a provider.
  useEffect(()=>{
    if(!activeId||!org?.id||!user?.id)return
    let stopped=false,busy=false
    const refresh=async()=>{
      if(stopped||busy||document.hidden||fullReadBusy.current)return
      busy=true;const generation=loadGeneration.current
      try{const result=await api.getPortfolio(supabase,org.id,activeId)
        if(stopped||latestScope.current!==activeScope||generation!==loadGeneration.current)return
        setWorkspace({...result,scope:activeScope});setPortfolio(result.portfolio);setHoldings(result.holdings);setHideDustState(!!result.portfolio?.hide_dust)
        if(!sourcePage?.page){setSources(result.sources);setSourcePage(result.sourcePage)}
      }catch(e){if(!stopped&&latestScope.current===activeScope)setError(e.message)}finally{busy=false}
    }
    const timer=setInterval(refresh,60000);document.addEventListener('visibilitychange',refresh)
    return()=>{stopped=true;clearInterval(timer);document.removeEventListener('visibilitychange',refresh)}
  },[activeScope,activeId,org?.id,user?.id,supabase,sourcePage?.page])
  const sourceSequence=useRef(0)
  const loadSources = async page => {
    const seq=++sourceSequence.current;setSourceLoading(true)
    try{const result=await api.getPortfolioPage(supabase,org.id,activeId,{kind:'sources',page});if(latestScope.current===activeScope&&seq===sourceSequence.current){setSourcePage(result);setSources(result.rows)}}catch(e){if(latestScope.current===activeScope)setError(e.message)}finally{if(latestScope.current===activeScope&&seq===sourceSequence.current)setSourceLoading(false)}
  }
  const loadEarlierSnapshots = useCallback(async () => {
    if (loadingEarlierSnapshots || !hasEarlierSnapshots || !snapshots.length) return
    setLoadingEarlierSnapshots(true)
    try {
      const rows = await api.getSnapshots(supabase, org.id, activeId, { before: snapshots[0].t })
      if (latestScope.current !== activeScope) return
      setSnapshots(current => [...new Map([...rows, ...current].map(row => [row.t, row])).values()].sort((a, b) => a.t - b.t))
      setHasEarlierSnapshots(rows.length === 365)
    } catch (e) { if (latestScope.current === activeScope) setError(e.message) }
    finally { if (latestScope.current === activeScope) setLoadingEarlierSnapshots(false) }
  }, [loadingEarlierSnapshots, hasEarlierSnapshots, snapshots, supabase, org?.id, activeId, activeScope])

  useEffect(() => {
    setWorkspace(null);setSourcePage(null);setSourceLoading(false);setPortfolio(null); setHoldings([]); setSources([]); setSnapshots([])
    setBenchmarks({}); setHideDustState(false); setError(null); setSyncing(false)
    setShowForm(false); setWalletsOpen(false)
    setHasEarlierSnapshots(false); setLoadingEarlierSnapshots(false)
    if (activeId) void loadPortfolio(activeId,{activityChanged:false})
    return () => { loadGeneration.current += 1 }
  }, [activeId, loadPortfolio])
  useEffect(() => {
    if (!activeId || !org?.id || !user?.id || openedPortfolioIds.current.has(activeScope)) return
    openedPortfolioIds.current.add(activeScope)
    void (async () => {
      await markSurfaceSeen(supabase, 'portfolio', activeId, { orgId: org.id, userId: user?.id })
      if (latestScope.current !== activeScope) { openedPortfolioIds.current.delete(activeScope); return }
      setSyncing(true)
      try {
        const result=await api.syncPortfolio(supabase, org.id, activeId, { mode: 'open' })
        if (latestScope.current === activeScope) await loadPortfolio(activeId,{activityChanged:portfolioSyncChangesActivity(result)})
      } catch (e) {
        if (latestScope.current === activeScope) setError(e.message)
      } finally {
        if (latestScope.current === activeScope) setSyncing(false)
      }
    })()
  }, [activeId, org?.id, user?.id, supabase, loadPortfolio, activeScope])
  useEffect(() => () => { if (org?.id) markSurfaceSeen(supabase, 'portfolio', '', { orgId: org.id, userId: user?.id }) }, [org?.id, user?.id, supabase])

  const openName = (event, renaming = false) => {
    nameTrigger.current = event.currentTarget
    setNameAction({ scope: activeScope, id: renaming ? activeId : null, name: renaming ? portfolio?.name || '' : '' })
  }
  const closeName = () => { setNameAction(null); nameTrigger.current?.focus() }
  const saveName = async name => {
    const scope = activeScope, id = nameAction?.id
    const result = id
      ? await api.renamePortfolio(supabase, id, name)
      : await api.createPortfolio(supabase, org.id, user?.id, { name, isDefault: portfolios.length === 0 })
    if (latestScope.current !== scope) return
    await loadList()
    if (latestScope.current !== scope) return
    if (id) setPortfolio(p => p?.id === id ? { ...p, name } : p)
    else setActiveId(result.id)
  }

  const onSync = useCallback(async () => {
    if (!activeId) return
    setSyncing(true); setError(null)
    // An explicit sync must refresh wallet balances even when a recent reprice
    // made the quotes fresh. The server still enforces its provider budgets.
    try { const result=await api.syncPortfolio(supabase, org.id, activeId, { force: true }); await loadPortfolio(activeId,{activityChanged:portfolioSyncChangesActivity(result)}) }
    catch (e) { if (latestScope.current === activeScope) setError(e.message) } finally { if (latestScope.current === activeScope) setSyncing(false) }
  }, [activeId, supabase, org?.id, loadPortfolio, activeScope])

  const addTxn = useCallback(async (f) => { const result = await api.addTransaction(supabase, org.id, user?.id, activeId, f); await loadPortfolio(activeId); if (latestScope.current === activeScope && result.recomputeError) setError(result.recomputeError) }, [supabase, org?.id, user?.id, activeId, activeScope, loadPortfolio])
  const reclassify = useCallback(async (item, type) => { await api.reclassifyActivity(supabase, org.id, activeId, item, type); await loadPortfolio(activeId) }, [supabase, org?.id, activeId, loadPortfolio])
  const delTxn = useCallback(async (item) => { await api.deleteActivity(supabase, org.id, activeId, item); await loadPortfolio(activeId) }, [supabase, org?.id, activeId, loadPortfolio])
  const onDeletePortfolio = useCallback(async () => {
    if (!window.confirm(t('portfolio.confirm_delete', { defaultValue: 'Delete this portfolio and all its private data (holdings, transactions, snapshots, AI memory)? This cannot be undone.' }))) return
    try { await api.deletePortfolio(supabase, activeId); setActiveId(null); await loadList() } catch (e) { setError(e.message) }
  }, [supabase, activeId, loadList, t])

  const waitingForSelection=loading||selectionLoading
  const waitingForPortfolio=waitingForSelection||!!activeId&&workspace?.scope!==activeScope

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="eyebrow flex items-center gap-1.5"><Briefcase className="h-3.5 w-3.5" /> {t('brand.name', { defaultValue: 'Investor Intel' })}</div>
          <h1 className="page-title">{t('nav.portfolio', { defaultValue: 'Portfolio' })}</h1>
          <p className="page-sub">{t('pages.portfolio_sub', { defaultValue: 'Your holdings, P&L, performance, and grounded AI context. Read-only, not financial or tax advice.' })}</p>
        </div>
          <div className="flex items-center gap-2 flex-wrap">
            {waitingForSelection?<select className="select" aria-label={t('portfolio.select', { defaultValue: 'Select portfolio' })} disabled><option>Loading portfolios…</option></select>:portfolios.length > 1 && (
              <select className="select" aria-label={t('portfolio.select', { defaultValue: 'Select portfolio' })} value={activeId || ''} onChange={(e) => setActiveId(e.target.value)}>{portfolios.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            )}
            <button onClick={event => openName(event)} className="btn btn--ghost btn--sm"><Plus className="h-4 w-4" />{t('portfolio.new', { defaultValue: 'New portfolio' })}</button>
            {activeId && <><button onClick={event => openName(event, true)} className="btn btn--ghost btn--sm">{t('portfolio.rename', { defaultValue: 'Rename portfolio' })}</button><button onClick={onSync} disabled={syncing} className="btn btn--ghost btn--sm" title={t('portfolio.sync_now', { defaultValue: 'Sync now' })}><RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} /></button></>}
          </div>
      </div>
      {nameAction?.scope === activeScope && <PortfolioNameDialog key={`${activeScope}:${nameAction.id || 'new'}`} initialName={nameAction.name} renaming={!!nameAction.id} onSave={saveName} onClose={closeName} t={t} />}

      <IntelErrorNotice error={error || selectionError?.message} />

      {/* Valuing a portfolio reprices this member's own positions and then
          synthesises over them, which spends per reader. The page keeps its
          heading and its portfolio controls; only the valuation itself is
          locked, in the place where it would have been. */}
      <IntelSurfaceGate surface="portfolio_valuation" title={t('access.surface_portfolio_valuation', { defaultValue: 'Portfolio valuation' })}>
      <div className={`space-y-5${waitingForPortfolio?' intel-portfolio-pending':''}`} aria-busy={waitingForPortfolio}>
      {waitingForSelection?<p role="status">Loading portfolios…</p>:portfolios.length === 0 ? (
        <div className="border-b border-[var(--border-default)] rounded-none p-10 text-center space-y-3">
          <Briefcase className="h-8 w-8 mx-auto text-[var(--fg-4)]" />
          <p className="text-[14px] text-[var(--fg-2)]">{t('portfolio.empty', { defaultValue: 'No portfolio yet. Create one, then connect a wallet or add a transaction.' })}</p>
          <button onClick={event => openName(event)} className="btn btn--primary mx-auto"><Plus className="h-4 w-4" /> {t('portfolio.create', { defaultValue: 'Create portfolio' })}</button>
        </div>
      ) : workspace?.scope!==activeScope ? (<p role="status">{error?'Portfolio could not be loaded.':'Loading portfolio…'} {error&&<button className="btn" onClick={()=>loadPortfolio(activeId)}>Retry</button>}</p>) : (
        <>
          <Overview portfolio={portfolio} holdings={openHoldings} warnHoldings={visibleHoldings} summary={workspace?.summary} hideDust={hideDust} t={t} />

          <section className="border-y border-[var(--border-default)] py-4 space-y-3">
            <button className="text-sm underline underline-offset-4" aria-expanded={walletsOpen} aria-controls="portfolio-wallet-sync" onClick={() => setWalletsOpen(open => !open)}>{t('portfolio.wallets_and_sync', { defaultValue: 'Wallets and sync' })} · {sourcePage?.total??sources.length}</button>
            {walletsOpen && <div id="portfolio-wallet-sync"><React.Suspense fallback={<p role="status" className="text-xs text-[var(--fg-4)]">{t('portfolio.loading_wallet_tools', { defaultValue: 'Loading wallet tools…' })}</p>}><WalletSyncPanel supabase={supabase} orgId={org.id} userId={user?.id} portfolioId={activeId} sources={sources} onChange={() => loadPortfolio(activeId)} t={t}/></React.Suspense>{sourcePage&&<PortfolioPageControls label="Wallet source pages" page={sourcePage.page} total={sourcePage.total} hasMore={sourcePage.hasMore} busy={sourceLoading} onPage={loadSources}/>}</div>}
          </section>

          <React.Suspense fallback={<div className="py-3"><div className="h-[272px] grid place-items-center"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--accent)]" /></div></div>}>
            <PortfolioPerformanceChart series={snapshots} compare={benchmarks} loading={false} hasEarlier={hasEarlierSnapshots} loadingEarlier={loadingEarlierSnapshots} onLoadEarlier={loadEarlierSnapshots} />
          </React.Suspense>
          <React.Suspense fallback={null}><PortfolioHistoricalPerformance key={activeScope} supabase={supabase} orgId={org.id} portfolioId={activeId}/></React.Suspense>

          {/* Which holdings carry a contract identity a provider can price, and
              the on-demand run that asks. Coverage is rows only; a run spends
              provider credits and is started by hand. */}
          <PortfolioIdentityCoverage key={activeScope} portfolioId={activeId} />

          <PortfolioValuationReceipts key={`receipts:${activeScope}`} supabase={supabase} orgId={org?.id} portfolioId={activeId} t={t}/>

          <PortfolioHoldingsSection supabase={supabase} orgId={org?.id} userId={user?.id} portfolioId={activeId} open={workspace?.open} closed={workspace?.closed} hideDust={hideDust} dustCount={workspace?.summary?.dustCount??dustHiddenCount} onToggleDust={onToggleDust} Table={HoldingsTable} t={t}/>

          <PortfolioResearchPanel key={activeScope} intel={research.intel} loading={research.generating} reading={research.reading} error={research.error} onRetry={research.reload} onGenerate={research.generate} history={historyEnabled?{supabase,orgId:org.id,userId:user?.id,onSelect:research.reload}:null} portfolioId={activeId} t={t} />

                      <PortfolioActivitySection supabase={supabase} orgId={org.id} userId={user?.id} portfolioId={activeId} reloadKey={activityRevision} Row={ActivityRow} onReclassify={reclassify} onDelete={delTxn} onAdd={()=>setShowForm(v=>!v)} processing={syncing} t={t}>
              {showForm&&<ManualTxnForm onSubmit={addTxn} onClose={()=>setShowForm(false)} t={t}/>}
            </PortfolioActivitySection>

          <section className="border-b border-[var(--border-default)] rounded-none p-3 flex items-center justify-between flex-wrap gap-2">
            <span className="text-[12px] text-[var(--fg-3)] flex items-center gap-1.5"><Bell className="h-3.5 w-3.5" /> {t('portfolio.alerts_hint', { defaultValue: 'Set price, value and risk alerts on your holdings.' })}</span>
            <Link to="/intel/alerts" className="btn btn--ghost btn--sm">{t('nav.alerts', { defaultValue: 'Alerts' })}</Link>
          </section>

          <div className="flex items-center justify-between flex-wrap gap-2 pt-1">
            <button onClick={onDeletePortfolio} className="text-[12px] text-[var(--fg-5)] hover:text-red-400 flex items-center gap-1.5"><Trash2 className="h-3.5 w-3.5" /> {t('portfolio.delete_portfolio', { defaultValue: 'Delete portfolio' })}</button>
            <button onClick={onClearResearch} disabled={clearingScope===activeScope} className="text-[12px] text-[var(--fg-5)] hover:text-[var(--fg-2)]">{clearingScope===activeScope?t('portfolio.clearing_readings',{defaultValue:'Clearing readings…'}):historyEnabled?t('portfolio.clear_readings',{defaultValue:'Clear readings and AI memory'}):t('portfolio.clear_memory',{defaultValue:'Clear AI memory'})}</button>
          </div>
        </>
      )}
      </div>
      </IntelSurfaceGate>

      {activeId && workspace?.scope===activeScope && <PortfolioExposureCards portfolioId={activeId} revision={holdings} />}

      {!waitingForSelection&&<RelevantSignals portfolioId={activeId} title={t('signals.relevant_to_you', { defaultValue: 'Signals relevant to you' })} seeAllHref="/intel" />}

      <IntelDisclaimer variant="block" />
      <div className="border-b border-[var(--border-default)] rounded-none p-3 text-[11px] text-[var(--fg-5)] leading-relaxed">{t('portfolio.disclaimer', { defaultValue: 'Portfolio calculations are informational only and are not tax, accounting, investment, or financial advice. Cost basis and P&L may be incomplete when transaction history is missing, unclassified, or manually edited.' })}</div>
    </div>
  )
}
