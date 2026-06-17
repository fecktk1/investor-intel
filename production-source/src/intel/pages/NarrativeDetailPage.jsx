import React, { useEffect, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Radar, ArrowLeft, Star, Bell, BellOff, ChevronDown, Bug } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import {
  loadNarrativeDetail, loadNarrativeHistory, loadNarrativeXVelocity, followNarrative, unfollowNarrative,
  setNarrativeAlert, clearNarrativeAlert, logNarrativeInteraction, loadNarrativeDebug,
} from '../lib/narratives-api'
import { displayStatus, displayStatusMeta, stageMeta, signalMeta, onchainMeta, confirmationMeta } from '../lib/narrative-ui'
import NarrativeScorecard from '../components/NarrativeScorecard'
import ArtifactView from '../components/ArtifactView'
import IntelDisclaimer from '../components/IntelDisclaimer'
import IntelErrorNotice from '../components/IntelErrorNotice'

const pct = (v) => (typeof v === 'number' ? `${v > 0 ? '+' : ''}${v.toFixed(1)}%` : '—')
const chgCls = (v) => (typeof v !== 'number' ? 'text-[var(--fg-4)]' : v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-[var(--fg-3)]')

// Lightweight SVG sparkline of global_priority over the score history.
function Sparkline({ points }) {
  if (!points || points.length < 2) return <div className="text-[12px] text-[var(--fg-4)] italic">Not enough history yet.</div>
  const vals = points.map((p) => (typeof p.global_priority_score === 'number' ? p.global_priority_score : 0))
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1
  const W = 320, H = 48
  const d = vals.map((v, i) => `${(i / (vals.length - 1)) * W},${H - ((v - min) / span) * H}`).join(' ')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-12" preserveAspectRatio="none">
      <polyline points={d} fill="none" stroke="var(--accent)" strokeWidth="1.5" />
    </svg>
  )
}

// Two-series trend: attention (chatter_score) vs confirmation (avg of price/volume
// confirmation), shared 0..100 scale — reads "is the crowd ahead of price?".
function TrendLines({ points }) {
  const rows = (points || []).filter(Boolean)
  if (rows.length < 2) return <div className="text-[12px] text-[var(--fg-4)] italic">Not enough history yet.</div>
  const W = 320, H = 48
  const clamp = (v) => Math.max(0, Math.min(100, v))
  const attn = rows.map((p) => clamp(Number(p.chatter_score) || 0))
  const conf = rows.map((p) => {
    const vals = [Number(p.price_confirmation_score), Number(p.volume_confirmation_score)].filter((x) => Number.isFinite(x))
    return clamp(vals.length ? vals.reduce((s, x) => s + x, 0) / vals.length : 0)
  })
  const line = (vals) => vals.map((v, i) => `${(i / (vals.length - 1)) * W},${(H - (v / 100) * H).toFixed(1)}`).join(' ')
  return (
    <div className="space-y-1">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-12" preserveAspectRatio="none">
        <polyline points={line(attn)} fill="none" stroke="var(--accent)" strokeWidth="1.5" />
        <polyline points={line(conf)} fill="none" stroke="#34d399" strokeWidth="1.5" />
      </svg>
      <div className="flex items-center gap-3 text-[10px] text-[var(--fg-4)]">
        <span className="inline-flex items-center gap-1"><span className="inline-block h-1 w-3 rounded" style={{ background: 'var(--accent)' }} />Attention</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block h-1 w-3 rounded" style={{ background: '#34d399' }} />Confirmation</span>
      </div>
    </div>
  )
}

export default function NarrativeDetailPage() {
  const { slug } = useParams()
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org, isSuperAdmin } = useProfile()
  const { supabase } = useSupabase()
  const navigate = useNavigate()

  const [detail, setDetail] = useState(null)
  const [history, setHistory] = useState([])
  const [xvel, setXvel] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const [debug, setDebug] = useState(null)
  const [showDebug, setShowDebug] = useState(false)

  const load = useCallback(async () => {
    if (!org?.id || !slug) return
    setLoading(true); setErr(null)
    try {
      const [d, h, xv] = await Promise.all([loadNarrativeDetail(supabase, org.id, slug), loadNarrativeHistory(supabase, slug, 30), loadNarrativeXVelocity(supabase, slug)])
      setDetail(d); setHistory(h); setXvel(xv)
      logNarrativeInteraction(supabase, slug, 'open')
    } catch (e) { setErr(e.message) } finally { setLoading(false) }
  }, [org?.id, slug, supabase])
  useEffect(() => { load() }, [load])

  // Action errors (follow/alert limits) render inline — they must NOT feed
  // `err`, which replaces the whole page with the not-found view.
  const [actionErr, setActionErr] = useState(null)
  const toggleFollow = useCallback(async () => {
    setBusy(true)
    setActionErr(null)
    const next = !detail?.is_followed
    setDetail((d) => ({ ...d, is_followed: next }))
    try { next ? await followNarrative(supabase, slug) : await unfollowNarrative(supabase, slug) }
    catch (e) {
      setDetail((d) => ({ ...d, is_followed: !next }))
      setActionErr(e?.message || '')
    } finally { setBusy(false) }
  }, [detail?.is_followed, slug, supabase])

  const [alertOn, setAlertOn] = useState(false)
  useEffect(() => { setAlertOn(false) }, [slug])
  const toggleAlert = useCallback(async () => {
    setBusy(true)
    setActionErr(null)
    try {
      if (!alertOn) { await setNarrativeAlert(supabase, slug, { stage_change: true, momentum_delta: 10, risk_spike: true }); setAlertOn(true); setDetail((d) => ({ ...d, is_followed: true })) }
      else { await clearNarrativeAlert(supabase, slug); setAlertOn(false) }
    } catch (e) { setActionErr(e.message) } finally { setBusy(false) }
  }, [alertOn, slug, supabase])

  const openDebug = useCallback(async () => {
    setShowDebug((v) => !v)
    if (!debug) setDebug(await loadNarrativeDebug(supabase, slug))
  }, [debug, slug, supabase])

  if (loading) return <div className="card p-10 grid place-items-center"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--accent)]" /></div>
  if (err || !detail) return <div className="space-y-4"><button onClick={() => navigate('/intel/narratives')} className="btn btn--quiet btn--sm"><ArrowLeft className="h-4 w-4" /> {t('common.back', { defaultValue: 'Back' })}</button><div className="card--flat p-4 text-amber-400">{err || t('narratives.not_found', { defaultValue: 'Narrative not found.' })}</div></div>

  const tax = detail.taxonomy || {}
  const st = detail.state || {}
  const drivers = detail.drivers || []
  const sources = detail.sources || []
  const chatter = detail.chatter || null
  const stage = displayStatusMeta(displayStatus(st))
  const sig = signalMeta(st.signal_class)
  const oc = onchainMeta(st.onchain_status)
  const mkt = confirmationMeta(st.market_confirmation)
  const leaders = Array.isArray(st.leaders) ? st.leaders : []
  const laggards = Array.isArray(st.laggards) ? st.laggards : []
  const briefResult = detail.brief?.structured ? { artifact: { artifact_type: 'narrative_brief', structured: detail.brief.structured, id: null, title: tax.name, confidence: detail.brief.confidence, sources: detail.brief.structured?.sources, data_freshness: detail.brief.structured?.data_freshness } } : null

  return (
    <div className="space-y-5">
      <button onClick={() => navigate('/intel/narratives')} className="btn btn--quiet btn--sm"><ArrowLeft className="h-4 w-4" /> {t('nav.narratives', { defaultValue: 'Narrative Radar' })}</button>

      {/* header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="eyebrow flex items-center gap-1.5"><Radar className="h-3.5 w-3.5" /> {tax.parent_category} · {tax.origin === 'dynamic' ? t('narratives.dynamic', { defaultValue: 'Dynamic' }) : t('narratives.seeded', { defaultValue: 'Seeded' })}</div>
          <h1 className="page-title">{tax.name}</h1>
          <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
            <span className={`chip text-[10px] uppercase ${stage.cls}`}>{stage.label}</span>
            <span className={`chip text-[10px] ${sig.cls}`}>{sig.label}</span>
            <span className={`inline-flex items-center gap-1 text-[11px] ${oc.text}`}><span className={`h-2 w-2 rounded-full ${oc.dot}`} /> {oc.label}</span>
            {(st.related_chains || tax.chains || []).slice(0, 5).map((c) => <span key={c} className="text-[10px] text-[var(--fg-4)]">#{c}</span>)}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={toggleFollow} disabled={busy} className={`btn btn--quiet btn--sm ${detail.is_followed ? 'text-amber-400' : ''}`}>
            <Star className={`h-4 w-4 ${detail.is_followed ? 'fill-amber-400' : ''}`} /> {detail.is_followed ? t('narratives.following', { defaultValue: 'Following' }) : t('narratives.follow', { defaultValue: 'Follow' })}
          </button>
          <button onClick={toggleAlert} disabled={busy} className={`btn btn--quiet btn--sm ${alertOn ? 'text-[var(--accent)]' : ''}`}>
            {alertOn ? <BellOff className="h-4 w-4" /> : <Bell className="h-4 w-4" />} {alertOn ? t('narratives.alert_off', { defaultValue: 'Alerts on' }) : t('narratives.alert_on', { defaultValue: 'Alert me' })}
          </button>
        </div>
      </div>

      <IntelErrorNotice error={actionErr} />

      {tax.description && <p className="text-[13px] text-[var(--fg-3)] -mt-2">{tax.description}</p>}

      {/* scorecard */}
      <div className="card p-4 space-y-3">
        <div className="eyebrow">{t('narratives.scorecard', { defaultValue: 'Scorecard' })}</div>
        <NarrativeScorecard n={st} />
      </div>

      {/* confirmation & signals (a narrative is "strong" only when chatter is confirmed) */}
      <div className="card p-4 space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="eyebrow">{t('narratives.confirmation', { defaultValue: 'Confirmation & signals' })}</div>
          <span className={`inline-flex items-center gap-1 text-[11px] ${mkt.text}`}><span className={`h-2 w-2 rounded-full ${mkt.dot}`} /> {t('narratives.market', { defaultValue: 'Market' })}: {mkt.label}</span>
          <span className={`inline-flex items-center gap-1 text-[11px] ${oc.text}`}><span className={`h-2 w-2 rounded-full ${oc.dot}`} /> {oc.label}</span>
        </div>
        {xvel && xvel.velocity_pct != null && (
          <div className="card--flat p-2 flex items-center gap-2 flex-wrap text-[12px]">
            <span className="text-[var(--fg-5)]">{t('narratives.x_chatter', { defaultValue: 'X mentions' })}</span>
            {xvel.counts_today != null && <span className="font-semibold text-[var(--fg-1)]">~{Math.round(xvel.counts_today)}/day</span>}
            <span className={`font-semibold ${xvel.velocity_pct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{xvel.velocity_pct >= 0 ? '+' : ''}{Math.round(xvel.velocity_pct)}% {t('narratives.vs_7d', { defaultValue: 'vs 7d avg' })}</span>
            {xvel.total_7d != null && <span className="text-[10px] text-[var(--fg-5)]">· {Math.round(xvel.total_7d)} {t('narratives.in_7d', { defaultValue: 'in 7d' })}</span>}
          </div>
        )}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2">
          <ConfBar label="Market" value={st.market_confirmation} />
          <ConfBar label="On-chain" value={st.onchain_confirmation} />
          <ConfBar label="Social" value={st.social_confirmation} />
          <ConfBar label="News" value={st.news_confirmation} />
          <ConfBar label="Bull" value={st.bull_signal_score} />
          <ConfBar label="Bear" value={st.bear_signal_score} invert />
          <ConfBar label="Early" value={st.early_signal_score} />
          <ConfBar label="Chatter vel." value={st.chatter_velocity} signed />
        </div>
      </div>

      {/* attention vs confirmation — is the crowd ahead of price? */}
      <div className="card p-4 space-y-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="eyebrow">{t('narratives.attn_vs_conf', { defaultValue: 'Attention vs confirmation (30d)' })}</div>
          <span className="text-[10px] text-[var(--fg-5)]">{t('narratives.attn_vs_conf_hint', { defaultValue: 'Crowd ahead of price when blue leads green' })}</span>
        </div>
        <TrendLines points={history} />
      </div>

      {/* history */}
      <div className="grid sm:grid-cols-2 gap-3">
        <div className="card p-4 space-y-2">
          <div className="eyebrow">{t('narratives.priority_history', { defaultValue: 'Priority history (30d)' })}</div>
          <Sparkline points={history} />
        </div>
        <div className="card p-4 space-y-2">
          <div className="eyebrow">{t('narratives.stage_history', { defaultValue: 'Stage history' })}</div>
          <StageHistory history={history} />
        </div>
      </div>

      {/* leaders / laggards */}
      {(leaders.length > 0 || laggards.length > 0) && (
        <div className="grid sm:grid-cols-2 gap-3">
          <MoversCard title={t('narratives.leaders', { defaultValue: 'Top leaders' })} rows={leaders} />
          <MoversCard title={t('narratives.laggards', { defaultValue: 'Top laggards' })} rows={laggards} />
        </div>
      )}

      {/* why chatter is rising */}
      {chatter?.raw?.why && (
        <div className="card--flat p-3 text-[13px] text-[var(--fg-2)]">
          <span className="text-[var(--fg-4)] text-[11px] uppercase tracking-wide">{t('narratives.why_chatter', { defaultValue: 'Why it’s being discussed' })}: </span>
          {chatter.raw.why}{chatter.raw.what_changed ? ` — ${chatter.raw.what_changed}` : ''}
        </div>
      )}

      {/* top posts & sources (normalized, clickable evidence) */}
      {(sources.length > 0 || drivers.length > 0) && (
        <div className="card p-4 space-y-2">
          <div className="eyebrow">{t('narratives.top_sources', { defaultValue: 'Top posts & sources' })}</div>
          <div className="space-y-2">
            {(sources.length > 0 ? sources : drivers).slice(0, 16).map((d, i) => {
              const url = d.url
              const kind = d.signal_kind || (d.cluster_id ? 'source_cluster' : 'news')
              const bias = d.bias || d.signal_bias
              const handle = d.author_handle
              const label = d.title || (handle ? `@${handle}` : null) || d.domain || url || t('narratives.signal_cluster', { defaultValue: 'Signal cluster' })
              return (
                <div key={i} className="flex items-start gap-2 text-[13px]">
                  <span className="chip text-[9px] uppercase mt-0.5">{String(kind).replace(/_/g, ' ')}</span>
                  {bias && <span className={`chip text-[9px] mt-0.5 ${bias === 'bullish' ? 'chip--ok' : bias === 'bearish' ? 'chip--err' : ''}`}>{bias}</span>}
                  <div className="min-w-0 flex-1">
                    {url ? <a href={url} target="_blank" rel="noreferrer" className="text-[var(--fg-2)] hover:text-[var(--accent)] block truncate">{label}</a> : <span className="text-[var(--fg-2)] block truncate">{label}</span>}
                    <div className="flex items-center gap-2 text-[10px] text-[var(--fg-4)]">
                      {handle && <span>@{handle}</span>}
                      {d.domain && <span>{d.domain}</span>}
                      {(d.observed_at || d.last_seen_at) && <span>{new Date(d.observed_at || d.last_seen_at).toLocaleDateString()}</span>}
                      {d.provider === 'user_source' && <span className="text-[var(--accent)]">{t('narratives.your_source', { defaultValue: 'your source' })}</span>}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* AI brief — bull/bear/what-to-watch/confirm/invalidate */}
      {briefResult ? (
        <div className="space-y-2">
          <div className="eyebrow">{t('narratives.ai_read', { defaultValue: 'AI read — why it matters, what changed, what to watch' })}</div>
          <ArtifactView result={briefResult} loading={false} />
        </div>
      ) : (
        <div className="card--flat p-3 text-[12px] text-[var(--fg-4)] italic">{t('narratives.brief_pending', { defaultValue: 'A deeper AI read is generated for the most active narratives — check back shortly.' })}</div>
      )}

      {/* super-admin debug */}
      {isSuperAdmin && (
        <div className="card--flat p-3">
          <button onClick={openDebug} className="flex items-center gap-1.5 text-[12px] text-[var(--fg-3)]"><Bug className="h-3.5 w-3.5" /> {t('narratives.debug', { defaultValue: 'Debug (super-admin)' })} <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showDebug ? 'rotate-180' : ''}`} /></button>
          {showDebug && <pre className="mt-2 text-[10px] text-[var(--fg-4)] overflow-auto max-h-96 whitespace-pre-wrap">{debug ? JSON.stringify(debug, null, 2) : '…'}</pre>}
        </div>
      )}

      <IntelDisclaimer variant="block" />
    </div>
  )
}

function ConfBar({ label, value, invert, signed }) {
  const has = typeof value === 'number'
  const pct = has ? Math.max(0, Math.min(100, signed ? 50 + value : value)) : null
  const color = !has ? '' : signed
    ? (value > 0 ? 'bg-emerald-400' : value < 0 ? 'bg-red-400' : 'bg-[var(--fg-5,#555)]')
    : invert
      ? (value >= 66 ? 'bg-red-400' : value >= 45 ? 'bg-amber-400' : 'bg-emerald-400')
      : (value >= 66 ? 'bg-emerald-400' : value >= 45 ? 'bg-amber-400' : 'bg-red-400')
  return (
    <div>
      <div className="flex items-center justify-between text-[10px] text-[var(--fg-4)] mb-0.5">
        <span>{label}</span>
        <span className="tabular-nums text-[var(--fg-3)]">{!has ? '—' : signed ? `${value > 0 ? '+' : ''}${Math.round(value)}` : Math.round(value)}</span>
      </div>
      <div className="h-1.5 rounded-full bg-[var(--bg-3,#1c1c1c)] overflow-hidden">
        {pct != null && <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />}
      </div>
    </div>
  )
}

function MoversCard({ title, rows }) {
  return (
    <div className="card p-4 space-y-2">
      <div className="eyebrow">{title}</div>
      <div className="space-y-1">
        {rows.slice(0, 6).map((r, i) => (
          <div key={i} className="flex items-center justify-between text-[13px]">
            <span className="text-[var(--fg-2)] font-medium">{r.symbol}</span>
            <span className="flex items-center gap-3">
              <span className={`tabular-nums ${chgCls(r.change_24h)}`}>{pct(r.change_24h)}</span>
              {r.chain && <span className="text-[10px] text-[var(--fg-4)]">{r.chain}</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// Collapse the history into stage-change rows.
function StageHistory({ history }) {
  const changes = []
  let prev = null
  for (const p of history) { if (p.lifecycle_stage && p.lifecycle_stage !== prev) { changes.push({ at: p.snapshot_at, stage: p.lifecycle_stage }); prev = p.lifecycle_stage } }
  const recent = changes.slice(-6).reverse()
  if (!recent.length) return <div className="text-[12px] text-[var(--fg-4)] italic">No stage changes recorded yet.</div>
  return (
    <div className="space-y-1">
      {recent.map((c, i) => {
        const m = stageMeta(c.stage)
        return <div key={i} className="flex items-center justify-between text-[12px]"><span className={`chip text-[10px] uppercase ${m.cls}`}>{m.label}</span><span className="text-[var(--fg-4)] tabular-nums">{new Date(c.at).toLocaleDateString()}</span></div>
      })}
    </div>
  )
}
