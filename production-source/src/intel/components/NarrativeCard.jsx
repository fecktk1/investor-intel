import React from 'react'
import { Star, ArrowRight, Sparkles } from 'lucide-react'
import NarrativeScorecard from './NarrativeScorecard'
import { displayStatus, displayStatusMeta, signalMeta, onchainMeta, confirmationMeta, mergeLabels, clarityMeta } from '../lib/narrative-ui'

const pct = (v) => (typeof v === 'number' ? `${v > 0 ? '+' : ''}${v.toFixed(1)}%` : '—')
const chgCls = (v) => (typeof v !== 'number' ? 'text-[var(--fg-4)]' : v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-[var(--fg-3)]')

// Derive a one-line "what changed" from the deterministic score deltas.
function whatChanged(delta) {
  if (!delta) return null
  const entries = Object.entries(delta).filter(([, v]) => typeof v === 'number' && Math.abs(v) >= 3)
  if (!entries.length) return null
  entries.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
  return entries.slice(0, 2).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v > 0 ? '+' : ''}${Math.round(v)}`).join(' · ')
}

export default function NarrativeCard({ n, onOpen, onFollow, busy, followAnchor }) {
  const stage = displayStatusMeta(displayStatus(n))
  const sig = signalMeta(n.signal_class)
  const oc = onchainMeta(n.onchain_status)
  const v2 = n.v2 || {}
  const mkt = confirmationMeta(v2.market_confirmation)
  const velocity = typeof v2.chatter_velocity === 'number' ? v2.chatter_velocity : null
  const leaders = Array.isArray(n.leaders) ? n.leaders.slice(0, 4) : []
  const changed = whatChanged(n.score_delta)
  const isDynamic = n.origin === 'dynamic'
  const labels = mergeLabels(n, 2)   // derived clarity + per-user relevance, capped on the card

  return (
    <div className="card p-4 space-y-3">
      {/* header */}
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={() => onOpen(n.slug)} className="text-[15px] font-semibold text-[var(--fg-1)] hover:text-[var(--accent)] truncate text-left">{n.name}</button>
            <span className="chip text-[10px]">{n.parent_category}</span>
            <span className={`chip text-[10px] ${isDynamic ? 'chip--info' : 'text-[var(--fg-4)]'}`}>{isDynamic ? 'Dynamic' : 'Seeded'}</span>
            {n.is_followed && <Star className="h-3.5 w-3.5 text-amber-400 fill-amber-400" />}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
            <span className={`chip text-[10px] uppercase ${stage.cls}`}>{stage.label}</span>
            <span className={`chip text-[10px] ${sig.cls}`}>{sig.label}</span>
            <span className={`inline-flex items-center gap-1 text-[10px] ${mkt.text}`} title="Market confirmation">
              <span className={`h-2 w-2 rounded-full ${mkt.dot}`} /> mkt
            </span>
            <span className={`inline-flex items-center gap-1 text-[10px] ${oc.text}`} title="On-chain confirmation coverage">
              <span className={`h-2 w-2 rounded-full ${oc.dot}`} /> {oc.label}
            </span>
            {velocity != null && Math.abs(velocity) >= 1 && (
              <span className={`text-[10px] ${velocity > 0 ? 'text-emerald-400' : 'text-red-400'}`} title="Chatter velocity (vs last cycle)">
                chatter {velocity > 0 ? '▲' : '▼'}{Math.abs(Math.round(velocity))}
              </span>
            )}
            {(n.related_chains || n.chains || []).slice(0, 3).map((c) => <span key={c} className="text-[10px] text-[var(--fg-4)]">#{c}</span>)}
          </div>
          {labels.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
              {labels.map((l) => { const m = clarityMeta(l.key); return <span key={l.key} className={`chip text-[10px] ${m.cls}`} title={m.why}>{m.label}</span> })}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button onClick={() => onFollow(n.slug, !n.is_followed)} disabled={busy} data-tutorial={followAnchor}
            className={`btn btn--quiet btn--sm ${n.is_followed ? 'text-amber-400' : ''}`} title={n.is_followed ? 'Unfollow' : 'Follow'}>
            <Star className={`h-4 w-4 ${n.is_followed ? 'fill-amber-400' : ''}`} />
          </button>
          <button onClick={() => onOpen(n.slug)} className="btn btn--quiet btn--sm" title="Open detail"><ArrowRight className="h-4 w-4" /></button>
        </div>
      </div>

      {/* headline scores */}
      <NarrativeScorecard n={n} compact />

      {/* leaders */}
      {leaders.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap text-[11px]">
          <span className="text-[var(--fg-4)] uppercase tracking-wide text-[9px]">Leaders</span>
          {leaders.map((l, i) => (
            <span key={i} className="inline-flex items-center gap-1">
              <span className="text-[var(--fg-2)] font-medium">{l.symbol}</span>
              <span className={`tabular-nums ${chgCls(l.change_24h)}`}>{pct(l.change_24h)}</span>
            </span>
          ))}
        </div>
      )}

      {/* what changed */}
      {changed && (
        <div className="flex items-center gap-1.5 text-[11px] text-[var(--fg-3)]">
          <Sparkles className="h-3 w-3 text-[var(--accent)]" /> <span>What changed: {changed}</span>
        </div>
      )}
    </div>
  )
}
