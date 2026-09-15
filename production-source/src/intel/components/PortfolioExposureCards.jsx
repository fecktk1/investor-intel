import React, { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { PieChart, ArrowRight } from 'lucide-react'
import { useSupabase } from '../../lib/useSupabase'
import { useProfile } from '../../lib/profile-context'
import { clarityMeta } from '../lib/narrative-ui'

// Portfolio exposure intelligence — DETERMINISTIC research context computed by the
// portfolio_exposure RPC (mig 221) from stored data only. Describes the book as it
// is (narrative exposure, chain concentration, watchlist vs holdings, biggest
// concentration, signals/alerts touching holdings). NEVER scores decisions, never
// suggests buying/selling/rebalancing.

const fmtUsd = (v) => v == null ? '—' : `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
const SIG_CLS = { bullish: 'text-[var(--signal-green)]', bearish: 'text-[var(--signal-red)]', mixed: 'text-[var(--fg-3)]' }

export default function PortfolioExposureCards({ portfolioId, revision }) {
  const { supabase, user } = useSupabase()
  const { org } = useProfile()
  const scope=`${user?.id}:${org?.id}:${portfolioId}`
  const [result, setResult] = useState(null)
  const [attempt,setAttempt]=useState(0)
  const current=result?.scope===scope&&result.revision===revision?result:null
  const exp=current?.data

  useEffect(() => {
    let alive = true
    if (!portfolioId || !org?.id || !user?.id) { setResult(null); return }
    supabase.rpc('portfolio_exposure', { p_portfolio_id: portfolioId })
      .then(({ data, error }) => { if (alive) setResult({scope,revision,data:error?null:data,error:!!error}) })
      .catch(() => { if (alive) setResult({scope,revision,data:null,error:true}) })
    return () => { alive = false }
  }, [scope, portfolioId, supabase, revision, attempt])

  if (!portfolioId) return null
  if (!current) return <p role="status" className="text-sm text-[var(--fg-4)]">Updating portfolio exposure…</p>
  if (current.error) return <p role="status" className="text-sm text-[var(--fg-4)]">Portfolio exposure could not be loaded. <button className="intel-text-link" onClick={()=>setAttempt(n=>n+1)}>Retry</button></p>
  if (!exp) return null
  const chains = exp.chain_concentration || []
  const narratives = exp.narrative_exposure || []
  const wvh = exp.watchlist_vs_holdings || {}
  const hr = exp.highest_risk_holding
  const bc = exp.biggest_changed_exposure
  const signals = exp.portfolio_signals || []
  const alerts = exp.portfolio_alerts || []

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="eyebrow flex items-center gap-1.5"><PieChart className="h-3.5 w-3.5" /> Exposure context</div>
        <span className="text-[11px] text-[var(--fg-5)]">Research context only — not a recommendation</span>
      </div>

      {exp.total_value_usd===0&&<p className="text-sm text-[var(--fg-4)]">No priced holdings currently contribute to exposure. Closed positions remain in your history.</p>}
      {exp.identity_coverage?.unmapped_research_holdings>0&&<p className="text-xs text-[var(--fg-4)]">{exp.identity_coverage.unmapped_research_holdings} holdings have no verified market identity for related research yet. Their value and chain exposure are included.</p>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {/* Chain concentration */}
        {chains.length > 0 && (
          <div className="border-t border-[var(--border-default)] pt-3 space-y-1.5">
            <div className="text-[10px] text-[var(--fg-4)] uppercase">Chain concentration</div>
            {chains.slice(0, 5).map((c) => (
              <div key={c.chain} className="flex items-center gap-2 text-[12px]">
                <span className="w-20 truncate text-[var(--fg-2)]">{c.chain}</span>
                <div className="flex-1 h-1 bg-[var(--bg-2)] overflow-hidden"><div className="h-full bg-[var(--accent)]" style={{ width: `${Math.min(100, c.pct || 0)}%` }} /></div>
                <span className="tabular-nums text-[var(--fg-3)] w-12 text-right">{c.pct != null ? `${c.pct}%` : '—'}</span>
              </div>
            ))}
            {exp.top_chain_pct >= 70 && <div className="text-[11px] text-amber-400">High single-chain concentration ({exp.top_chain_pct}%) — descriptive note, not advice.</div>}
          </div>
        )}

        {/* Narrative exposure */}
        {narratives.length > 0 && (
          <div className="border-t border-[var(--border-default)] pt-3 space-y-1.5">
            <div className="text-[10px] text-[var(--fg-4)] uppercase">Narratives linked to held assets</div>
            <p className="text-xs text-[var(--fg-4)]">Share of the book in assets associated with each narrative. Issuer-wide links can span networks; these percentages overlap and do not measure holdings on those networks.</p>
            {narratives.slice(0, 5).map((n) => (
              <div key={n.slug} className="text-[12px] space-y-0.5">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <Link to={`/intel/narratives/${n.slug}`} className="text-[var(--fg-1)] font-medium hover:text-[var(--accent)]">{n.name}</Link>
                  {n.signal_class && <span className={`text-xs ${SIG_CLS[n.signal_class] || ''}`}>{n.signal_class}</span>}
                  <span className="ml-auto tabular-nums text-[var(--fg-3)]">{n.pct_of_book != null ? `${n.pct_of_book}%` : '—'}</span>
                </div>
                {Array.isArray(n.clarity_labels) && n.clarity_labels.slice(0, 1).map((l) => {
                  const m = clarityMeta(l.key); return <span key={l.key} className="text-xs text-[var(--fg-3)]" title={m.why}>{m.label}</span>
                })}
              </div>
            ))}
          </div>
        )}

        {/* Watchlist vs holdings + concentration + biggest change */}
        <div className="border-t border-[var(--border-default)] pt-3 space-y-2 text-[12px]">
          <div className="text-[10px] text-[var(--fg-4)] uppercase">Watchlist vs holdings</div>
          {(wvh.held_not_watched || []).length > 0 && <div><span className="text-[var(--fg-5)]">Held but not watched: </span><span className="text-[var(--fg-2)]">{wvh.held_not_watched.slice(0, 6).join(', ')}</span></div>}
          {(wvh.watched_not_held || []).length > 0 && <div><span className="text-[var(--fg-5)]">Watched but not held: </span><span className="text-[var(--fg-2)]">{wvh.watched_not_held.slice(0, 6).join(', ')}</span></div>}
          {hr?.symbol && (
            <div className="pt-1 border-t border-[var(--border-subtle)]">
              <span className="text-[var(--fg-5)]">Largest concentration: </span>
              <b className="text-[var(--fg-1)]">{hr.symbol}</b> <span className="text-[var(--fg-3)]">({hr.allocation_pct}%)</span>
              {Array.isArray(hr.reasons) && hr.reasons.slice(1, 3).map((r, i) => <div key={i} className="text-[11px] text-amber-400">{r}</div>)}
            </div>
          )}
          {bc?.symbol && (
            <div><span className="text-[var(--fg-5)]">Biggest move since last sync: </span>
              <b className="text-[var(--fg-1)]">{bc.symbol}</b>{' '}
              <span className={bc.day_change_usd >= 0 ? 'text-emerald-400' : 'text-red-400'}>{bc.day_change_usd == null ? '' : bc.day_change_usd >= 0 ? '+' : '−'}{fmtUsd(bc.day_change_usd==null?null:Math.abs(bc.day_change_usd))} ({bc.day_change_pct != null ? `${bc.day_change_pct > 0 ? '+' : ''}${bc.day_change_pct}%` : '—'})</span>
            </div>
          )}
        </div>
      </div>

      {/* Signals + alerts affecting holdings */}
      {(signals.length > 0 || alerts.length > 0) && (
        <div className="grid gap-3 lg:grid-cols-2">
          {signals.length > 0 && (
            <div className="border-t border-[var(--border-default)] pt-3 space-y-1.5">
              <div className="flex items-center justify-between">
                <div className="text-[10px] text-[var(--fg-4)] uppercase">Signals affecting your holdings</div>
                <Link to="/intel" className="text-[11px] text-[var(--accent)] flex items-center gap-1">Pulse <ArrowRight className="h-3 w-3" /></Link>
              </div>
              {signals.slice(0, 4).map((s, i) => (
                <div key={i} className="text-[12px] leading-snug">
                  <b className="text-[var(--fg-1)]">{s.subject}</b>
                  <span className={`text-xs ml-1.5 ${SIG_CLS[s.direction] || ''}`}>{s.direction}</span>
                  {s.why_it_matters && <div className="text-[var(--fg-3)]">{s.why_it_matters}</div>}
                </div>
              ))}
            </div>
          )}
          {alerts.length > 0 && (
            <div className="border-t border-[var(--border-default)] pt-3 space-y-1.5">
              <div className="flex items-center justify-between">
                <div className="text-[10px] text-[var(--fg-4)] uppercase">Alerts touching your holdings (7d)</div>
                <Link to="/intel/alerts" className="text-[11px] text-[var(--accent)] flex items-center gap-1">Alerts <ArrowRight className="h-3 w-3" /></Link>
              </div>
              {alerts.slice(0, 5).map((a, i) => (
                <div key={i} className="text-[12px] text-[var(--fg-2)]">
                  {a.payload?.symbol && <b>{a.payload.symbol} </b>}{(a.payload?.trigger_type || 'alert').replace(/_/g, ' ')}
                  <span className="text-[11px] text-[var(--fg-5)]"> · {new Date(a.fired_at).toLocaleDateString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
