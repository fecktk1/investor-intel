import React from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, TrendingUp, TrendingDown } from 'lucide-react'
import MarketContextCard from './MarketContextCard'

// One ranked Signal Radar card — the stories driving it, why it's emerging, what to
// watch, and a jump to the chart. Now sourced from the reusable Intel Signal store,
// so it carries personalization `reasons` ("why you're seeing this"). Never a bare
// token + "multiple sources". Bullish/bearish/mixed is always shown.

const SIG_CLS = { bullish: 'chip--ok', bearish: 'chip--err', mixed: 'chip--info', neutral: '', unclear: 'text-[var(--fg-4)]', data_limited: 'text-[var(--fg-4)]' }
const SIG_LABEL = { bullish: 'Leans bullish', bearish: 'Leans bearish', mixed: 'Mixed', neutral: 'Neutral', unclear: 'Unclear', data_limited: 'Data-limited' }
const PSCOPE_LABEL = { token_specific: 'Asset-specific', chain_specific: 'Chain-specific', narrative: 'Narrative', news: 'News', market_wide: 'Market-wide', asset_specific: 'Asset-specific', sector_specific: 'Sector-specific', narrative_specific: 'Narrative-specific', local: 'Asset-specific', unclear: 'Scope unclear' }
const SIG_CONF = { high: 'High confidence', medium: 'Medium confidence', low: 'Lower confidence', thin: 'Thin coverage' }
const REASON_LABEL = {
  'watchlist match': 'On your watchlist',
  'affects a holding': 'Affects a holding',
  'followed narrative': 'Followed narrative',
  'on a chain you follow': 'Your chain',
  'a topic you follow': 'Your topic',
}

const assetHref = (ref) => `/intel/asset/${encodeURIComponent(ref || '')}`
const fmtPct = (v) => `${v >= 0 ? '+' : ''}${Number(v).toFixed(1)}%`

export default function SignalCard({ s }) {
  const reasons = s.reasons || []
  return (
    <div className="card--flat p-3 space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[13px] font-semibold text-[var(--fg-1)]">{s.asset_symbol ? `$${s.asset_symbol}` : s.name}</span>
        {s.kind === 'chain' && <span className="text-[11px] text-[var(--fg-4)]">chain</span>}
        {s.kind === 'narrative' && <span className="text-[11px] text-[var(--fg-4)]">narrative</span>}
        <span className={`chip text-[10px] ${SIG_CLS[s.direction] || ''}`}>{SIG_LABEL[s.direction] || s.direction}</span>
        {s.has_official && <span className="chip text-[9px] chip--ok uppercase">Official</span>}
        {typeof s.change_24h === 'number' && <span className={`text-[11px] font-semibold flex items-center gap-0.5 ${s.change_24h >= 0 ? 'text-[var(--ok)]' : 'text-red-400'}`}>{s.change_24h >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}{fmtPct(s.change_24h)}</span>}
        {s.ref && <Link to={assetHref(s.ref)} className="ml-auto text-[11px] text-[var(--accent)] flex items-center gap-0.5">Chart <ArrowRight className="h-3 w-3" /></Link>}
      </div>
      {/* Why you're seeing this (personalization reasons) */}
      {reasons.length > 0 && (
        <div className="flex flex-wrap gap-1">{reasons.map((r, i) => <span key={i} className="chip text-[9px] chip--accent">{REASON_LABEL[r] || r}</span>)}</div>
      )}
      <div className="text-[11px]"><span className="text-[var(--accent)]">{s.signal_type}</span><span className="text-[var(--fg-4)]"> · {PSCOPE_LABEL[s.signal_scope] || s.signal_scope} · {s.time_window || 'last 24h'} · {SIG_CONF[s.confidence] || s.confidence}</span></div>
      {s.categories?.length > 0 && <div className="flex flex-wrap gap-1">{s.categories.map((c, i) => <span key={i} className="chip text-[9px] uppercase text-[var(--fg-4)]">{c}</span>)}</div>}
      <MarketContextCard ctx={s.market_context} variant="flat" />
      {s.headlines?.length > 0 && (
        <div className="text-[11px]">
          <span className="text-[var(--fg-5)]">Driven by: </span>
          <ul className="space-y-0.5 mt-0.5">{s.headlines.slice(0, 3).map((h, i) => <li key={i} className="text-[var(--fg-2)] leading-snug">· {h}</li>)}</ul>
        </div>
      )}
      <div className="text-[11px] text-[var(--fg-4)]">{s.mention_count} mention{s.mention_count > 1 ? 's' : ''} · {s.source_diversity} source type{s.source_diversity > 1 ? 's' : ''}{s.custom ? ' · incl. a source you added' : ''}</div>
      {s.why_it_matters && <p className="text-[12px] text-[var(--fg-2)] leading-snug"><span className="text-[var(--fg-5)]">Why it matters: </span>{s.why_it_matters}</p>}
      {s.what_to_watch_next && <p className="text-[12px] text-[var(--fg-3)] leading-snug"><span className="text-[var(--fg-5)]">Watch next: </span>{s.what_to_watch_next}</p>}
    </div>
  )
}
