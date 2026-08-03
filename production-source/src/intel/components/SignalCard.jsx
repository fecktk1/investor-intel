import React from 'react'
import { Link } from 'react-router'
import { ArrowRight, TrendingUp, TrendingDown, Layers, AlertTriangle } from 'lucide-react'
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

// Momentum from the stored score_delta. Prefers the 24h window (computed from
// snapshot history) over the single 45-min prev-tick; values are 0..1 so the
// threshold is fractional — NOT the 0..100 narrative-subdelta scale (never fires).
// A multi-cron run appends the streak ("Strengthening · 3 cycles"). New signals
// and fallback-radar cards ({} / undefined score_delta) get no badge; a direction
// change reads as "Flipped".
const MOMENTUM_D = 0.03
function momentum(scoreDelta, direction) {
  if (!scoreDelta || typeof scoreDelta !== 'object') return null
  const prev = scoreDelta.prev_direction
  if (prev && direction && prev !== direction) return { label: 'Flipped', cls: 'chip--info' }
  const d24 = Number(scoreDelta.d_24h)
  const d = Number.isFinite(d24) ? d24 : Number(scoreDelta.d_global_score)
  if (!Number.isFinite(d)) return null
  const streak = Number(scoreDelta.streak) || 0
  const tail = streak >= 2 ? ` · ${streak} cycles` : ''
  if (d >= MOMENTUM_D) return { label: `Strengthening${tail}`, cls: 'chip--ok', up: true }
  if (d <= -MOMENTUM_D) return { label: `Weakening${tail}`, cls: 'chip--err', up: false }
  return null
}

// Freshness dot from stale_after (= generated_at + ~90min). Missing on fallback
// cards → no dot. Past stale_after → aging (amber), else fresh (green).
function freshnessDot(staleAfter) {
  if (!staleAfter) return null
  const ts = new Date(staleAfter).getTime()
  if (!Number.isFinite(ts)) return null
  return Date.now() < ts ? 'fresh' : 'aging'
}

export default function SignalCard({ s }) {
  const reasons = s.reasons || []
  const mom = momentum(s.score_delta, s.direction)
  const fresh = freshnessDot(s.stale_after)
  return (
    <div className="card--flat p-3 space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[13px] font-semibold text-[var(--fg-1)]">{s.asset_symbol ? `$${s.asset_symbol}` : s.name}</span>
        {s.kind === 'chain' && <span className="text-[11px] text-[var(--fg-4)]">chain</span>}
        {s.kind === 'narrative' && <span className="text-[11px] text-[var(--fg-4)]">narrative</span>}
        <span className={`chip text-[10px] ${SIG_CLS[s.direction] || ''}`}>{SIG_LABEL[s.direction] || s.direction}</span>
        {mom && (
          <span className={`chip text-[10px] inline-flex items-center gap-0.5 ${mom.cls}`} title="Change vs the previous reading">
            {mom.up === true && <TrendingUp className="h-3 w-3" />}{mom.up === false && <TrendingDown className="h-3 w-3" />}{mom.label}
          </span>
        )}
        {s.corroboration && (s.corroboration.count >= 2 || s.corroboration.divergence) && (
          <span className={`chip text-[10px] inline-flex items-center gap-0.5 ${s.corroboration.divergence ? 'text-amber-400' : 'chip--info'}`}
            title={Object.entries(s.corroboration.layers || {}).map(([k, v]) => `${k}: ${v}`).join(' · ')}>
            {s.corroboration.divergence ? <AlertTriangle className="h-3 w-3" /> : <Layers className="h-3 w-3" />}{s.corroboration.divergence ? 'Layers disagree' : `${s.corroboration.count} layers agree`}
          </span>
        )}
        {fresh && <span title={fresh === 'fresh' ? 'Fresh signal' : 'Aging — past its refresh window'} className={`h-2 w-2 rounded-full ${fresh === 'fresh' ? 'bg-emerald-400' : 'bg-amber-400/80'}`} />}
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
