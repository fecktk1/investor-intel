import React, { useEffect, useState } from 'react'
import { History, AlertTriangle } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { loadAssetYearInReview } from '../lib/markets-api'

// Long-memory drilldown: "what drove this asset over the last year" — built
// deterministically from rollups + event memory (migrations 224-230). Renders
// nothing until the memory layer has data (new deploys start empty and fill in).
// Research context only — historical coverage, not advice.

const EVENT_LABEL = {
  etf_decision: 'ETF decision', regulatory_action: 'Regulation', exploit: 'Exploit/hack',
  exchange_collapse: 'Exchange event', chain_outage: 'Chain outage', stablecoin_depeg: 'Depeg',
  liquidation_event: 'Liquidations', token_unlock: 'Token unlock', court_decision: 'Court ruling',
  protocol_launch: 'Launch', macro_shock: 'Macro', governance: 'Governance', other: 'Event',
}

export default function AssetYearInReview({ symbol }) {
  const { org } = useProfile()
  const { supabase } = useSupabase()
  const [data, setData] = useState(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let alive = true
    if (!org?.id || !symbol) return
    loadAssetYearInReview(supabase, symbol).then((d) => { if (alive) setData(d) }).catch(() => { if (alive) setData(null) })
    return () => { alive = false }
  }, [org?.id, supabase, symbol])

  const monthly = data?.monthly || []
  const events = data?.events || []
  const narratives = data?.top_narratives || []
  if (!monthly.length && !events.length) return null

  const maxSrc = Math.max(1, ...monthly.map((m) => m.source_count || 0))

  return (
    <section className="card p-4 space-y-3">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center justify-between w-full">
        <div className="eyebrow flex items-center gap-1.5"><History className="h-3.5 w-3.5" /> What drove {String(symbol).toUpperCase()} over the last year</div>
        <span className="text-[12px] text-[var(--accent)]">{open ? 'Hide' : 'Show'}</span>
      </button>

      {open && (
        <div className="space-y-3">
          {/* Monthly coverage + signal mix (deterministic rollups) */}
          {monthly.length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] text-[var(--fg-4)] uppercase">Coverage &amp; signal mix by month</div>
              {monthly.map((m) => (
                <div key={m.month} className="flex items-center gap-2 text-[11px]">
                  <span className="w-16 text-[var(--fg-4)]">{String(m.month).slice(0, 7)}</span>
                  <div className="flex-1 h-2 rounded bg-[var(--bg-2)] overflow-hidden flex">
                    <div className="h-full bg-emerald-500/70" style={{ width: `${(m.bullish || 0) / maxSrc * 100}%` }} title={`${m.bullish || 0} bullish`} />
                    <div className="h-full bg-red-500/70" style={{ width: `${(m.bearish || 0) / maxSrc * 100}%` }} title={`${m.bearish || 0} bearish`} />
                    <div className="h-full bg-[var(--accent)]/50" style={{ width: `${(m.mixed || 0) / maxSrc * 100}%` }} title={`${m.mixed || 0} mixed`} />
                  </div>
                  <span className="tabular-nums text-[var(--fg-4)] w-10 text-right">{m.source_count}</span>
                </div>
              ))}
            </div>
          )}

          {narratives.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] text-[var(--fg-4)] uppercase">Narratives</span>
              {narratives.slice(0, 8).map((n) => <span key={n} className="chip text-[10px]">{n}</span>)}
            </div>
          )}

          {events.length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] text-[var(--fg-4)] uppercase">Major events</div>
              {events.slice(0, 8).map((e, i) => (
                <div key={i} className="flex items-start gap-2 text-[12px]">
                  <span className="chip text-[9px] flex-shrink-0">{EVENT_LABEL[e.event_type] || e.event_type}</span>
                  <span className="text-[var(--fg-4)] tabular-nums flex-shrink-0">{String(e.occurred_at).slice(0, 10)}</span>
                  <span className="text-[var(--fg-2)]">{e.title}</span>
                </div>
              ))}
            </div>
          )}

          {data?.coverage_note && (
            <p className="text-[10px] text-[var(--fg-5)] flex items-start gap-1"><AlertTriangle className="h-3 w-3 mt-0.5 flex-shrink-0" /> {data.coverage_note}</p>
          )}
        </div>
      )}
    </section>
  )
}
