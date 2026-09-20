import React, { useEffect, useState, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Radar, ArrowLeft, Star, Bell, BellOff, ChevronDown, Bug } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import {
  loadNarrativeDetail, loadNarrativeHistory, loadNarrativeXVelocity, followNarrative, unfollowNarrative,
  setNarrativeAlert, clearNarrativeAlert, logNarrativeInteraction, loadNarrativeDebug, loadNarrativeAlertState,
} from '../lib/narratives-api'
import { displayStatus, displayStatusMeta, stageMeta, signalMeta, onchainMeta, confirmationMeta } from '../lib/narrative-ui'
import NarrativeScorecard from '../components/NarrativeScorecard'
import FigureSourceLine from '../components/FigureSourceLine'
import ArtifactView from '../components/ArtifactView'
import IntelDisclaimer from '../components/IntelDisclaimer'
import IntelErrorNotice from '../components/IntelErrorNotice'
import { IntelPageShell } from '../components/IntelPrimitives'
import NarrativeMembers from '../components/NarrativeMembers'
import NarrativeResearch from '../components/NarrativeResearch'
import { narrativeHistorySeries, narrativeSeriesPath, narrativeScore } from '../lib/narrative-members'
import '../narrative-dossier.css'

const pct = (v) => (typeof v === 'number' ? `${v > 0 ? '+' : ''}${v.toFixed(1)}%` : '—')
const chgCls = (v) => (typeof v !== 'number' ? 'text-[var(--fg-4)]' : v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-[var(--fg-3)]')

// Lightweight SVG sparkline of global_priority over the score history.
function Sparkline({ points }) {
  const series = narrativeHistorySeries(points, 'global_priority_score')
  const vals = series.map(row => row.value).filter(value => value != null)
  if (vals.length < 2) return <div className="text-[12px] text-[var(--fg-4)]">Not enough recorded priority scores yet.</div>
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1
  const W = 320, H = 48
  const d = narrativeSeriesPath(series, W, H, [min, min + span])
  return (
    <svg role="img" aria-label="Priority history; gaps are missing observations" viewBox={`0 0 ${W} ${H}`} className="w-full h-12" preserveAspectRatio="none">
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth="1.5" />
    </svg>
  )
}

// Two-series trend: attention (chatter_score) vs confirmation (avg of price/volume
// confirmation), shared 0..100 scale — reads "is the crowd ahead of price?".
function TrendLines({ points }) {
  const attn = narrativeHistorySeries(points, 'chatter_score'), conf = narrativeHistorySeries(points, 'confirmation')
  if (Math.max(attn.filter(row => row.value != null).length, conf.filter(row => row.value != null).length) < 2) return <div className="text-[12px] text-[var(--fg-4)]">Not enough recorded scores yet.</div>
  const W = 320, H = 48
  return (
    <div className="space-y-1">
      <svg role="img" aria-label="Attention and confirmation history; gaps are missing observations" viewBox={`0 0 ${W} ${H}`} className="w-full h-12" preserveAspectRatio="none">
        <path d={narrativeSeriesPath(attn, W, H)} fill="none" stroke="var(--accent)" strokeWidth="1.5" />
        <path d={narrativeSeriesPath(conf, W, H)} fill="none" stroke="var(--ok)" strokeWidth="1.5" />
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
  const { org, isSuperAdmin } = useProfile()
  const { supabase, user } = useSupabase()
  if (!org?.id || !user?.id) return <IntelPageShell><p role="status">Waiting for your workspace…</p></IntelPageShell>
  return <NarrativeDossier key={`${user.id}:${org.id}:${slug}`} slug={slug} org={org} user={user} isSuperAdmin={isSuperAdmin} supabase={supabase}/>
}

function NarrativeDossier({slug, org, user, isSuperAdmin, supabase}) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const navigate = useNavigate()

  const [detail, setDetail] = useState(null)
  const [history, setHistory] = useState([])
  const [historyCoverage, setHistoryCoverage] = useState(null)
  const [historyMore, setHistoryMore] = useState({ loading: false, error: null })
  const historyLock = useRef(false)
  const [allSources, setAllSources] = useState(false)
  const [xvel, setXvel] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const [debug, setDebug] = useState(null)
  const [showDebug, setShowDebug] = useState(false)
  const [sourceErrors, setSourceErrors] = useState({})
  const [alertOn, setAlertOn] = useState(null)
  const generation = useRef(0), alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++ } }, [])

  const load = useCallback(async () => {
    if (!org?.id || !slug) return
    const request = ++generation.current
    setLoading(true); setErr(null); setSourceErrors({})
    try {
      const [d, h, xv, alert] = await Promise.allSettled([loadNarrativeDetail(supabase, org.id, slug), loadNarrativeHistory(supabase, slug, 30, { withCoverage: true }), loadNarrativeXVelocity(supabase, slug), loadNarrativeAlertState(supabase, org.id, user.id, slug)])
      if (!alive.current || request !== generation.current) return
      if (d.status === 'rejected') throw d.reason
      setDetail(d.value); setHistory(h.status === 'fulfilled' ? h.value.rows : []); setHistoryCoverage(h.status === 'fulfilled' ? h.value.coverage : null); setHistoryMore({loading:false,error:null}); setXvel(xv.status === 'fulfilled' ? xv.value : null)
      setAlertOn(alert.status === 'fulfilled' ? alert.value : null)
      setSourceErrors({ history: h.status === 'rejected', attention: xv.status === 'rejected', alert: alert.status === 'rejected', brief: d.value?.briefState === 'error' })
      void logNarrativeInteraction(supabase, slug, 'open')
    } catch (e) { if (alive.current && request === generation.current) setErr(e.message) }
    finally { if (alive.current && request === generation.current) setLoading(false) }
  }, [org.id, user.id, slug, supabase])
  useEffect(() => { load() }, [load])
  const loadOlder = async () => {
    if (historyLock.current || !historyCoverage?.nextCursor) return
    historyLock.current = true; setHistoryMore({loading:true,error:null})
    const request = generation.current
    try {
      const result = await loadNarrativeHistory(supabase, slug, 30, {withCoverage:true,before:historyCoverage.nextCursor})
      if (!alive.current || request !== generation.current) return
      setHistory(current => [...new Map([...result.rows,...current].map(row => [row.id || row.snapshot_at,row])).values()].sort((a,b)=>Date.parse(a.snapshot_at)-Date.parse(b.snapshot_at)))
      setHistoryCoverage(result.coverage); setHistoryMore({loading:false,error:null})
    } catch (error) { if(alive.current && request === generation.current) setHistoryMore({loading:false,error:'Older narrative history could not be read. Existing observations remain visible.'}) }
    finally { historyLock.current = false }
  }

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
      if (alive.current) { setDetail((d) => ({ ...d, is_followed: !next })); setActionErr(e?.message || '') }
    } finally { if (alive.current) setBusy(false) }
  }, [detail?.is_followed, slug, supabase])

  const toggleAlert = useCallback(async () => {
    if (alertOn == null) return
    setBusy(true)
    setActionErr(null)
    try {
      if (!alertOn) { await setNarrativeAlert(supabase, slug, { stage_change: true, momentum_delta: 10, risk_spike: true }); if (alive.current) { setAlertOn(true); setDetail((d) => ({ ...d, is_followed: true })) } }
      else { await clearNarrativeAlert(supabase, slug); if (alive.current) setAlertOn(false) }
    } catch (e) { if (alive.current) setActionErr(e.message) } finally { if (alive.current) setBusy(false) }
  }, [alertOn, slug, supabase])

  const openDebug = useCallback(async () => {
    setShowDebug((v) => !v)
    if (!debug) { const result = await loadNarrativeDebug(supabase, slug); if (alive.current) setDebug(result) }
  }, [debug, slug, supabase])

  if (loading) return <IntelPageShell><p role="status">Reading narrative evidence…</p></IntelPageShell>
  if (err || !detail) return <IntelPageShell><button onClick={() => navigate('/intel/narratives')} className="btn btn--quiet btn--sm"><ArrowLeft className="h-4 w-4" /> {t('common.back', { defaultValue: 'Back' })}</button><div className="intel-narrative-note p-4 text-amber-400">{err || t('narratives.not_found', { defaultValue: 'Narrative not found.' })}</div></IntelPageShell>

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
    <IntelPageShell className="intel-narrative-dossier">
      <button onClick={() => navigate('/intel/narratives')} className="btn btn--quiet btn--sm"><ArrowLeft className="h-4 w-4" /> {t('nav.narratives', { defaultValue: 'Narrative Radar' })}</button>

      {/* header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="eyebrow flex items-center gap-1.5"><Radar className="h-3.5 w-3.5" /> {tax.parent_category} · {tax.origin === 'dynamic' ? t('narratives.dynamic', { defaultValue: 'Dynamic' }) : t('narratives.seeded', { defaultValue: 'Seeded' })}</div>
          <h1 className="page-title">{tax.name}</h1>
          <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
            <span className={`text-[10px] uppercase `}>{stage.label}</span>
            <span className={`text-[10px] `}>{sig.label}</span>
            <span className={`inline-flex items-center gap-1 text-[11px] ${oc.text}`}><span className={`h-2 w-2 ${oc.dot}`} /> {oc.label}</span>
            {(st.related_chains || tax.chains || []).slice(0, 5).map((c) => <span key={c} className="text-[10px] text-[var(--fg-4)]">#{c}</span>)}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={toggleFollow} disabled={busy} className={`btn btn--quiet btn--sm ${detail.is_followed ? 'text-amber-400' : ''}`}>
            <Star className={`h-4 w-4 ${detail.is_followed ? 'fill-amber-400' : ''}`} /> {detail.is_followed ? t('narratives.following', { defaultValue: 'Following' }) : t('narratives.follow', { defaultValue: 'Follow' })}
          </button>
          <button onClick={toggleAlert} disabled={busy || alertOn == null} className={`btn btn--quiet btn--sm ${alertOn ? 'text-[var(--accent)]' : ''}`}>
            {alertOn ? <BellOff className="h-4 w-4" /> : <Bell className="h-4 w-4" />} {alertOn == null ? 'Alert status unavailable' : alertOn ? t('narratives.alert_off', { defaultValue: 'Alerts on' }) : t('narratives.alert_on', { defaultValue: 'Alert me' })}
          </button>
        </div>
      </div>

      <IntelErrorNotice error={actionErr} />

      <p className="page-sub">{tax.description || 'Review confirmation, member assets and the evidence behind this narrative.'}</p>
      <dl className="intel-narrative-summary">{['momentum','chatter','confidence','risk'].map(name=><div key={name}><dt>{t(`narratives.${name}`,{defaultValue:name[0].toUpperCase()+name.slice(1)})}</dt><dd>{narrativeScore(st[`${name}_score`]) == null ? 'Unreported' : Math.round(st[`${name}_score`])}</dd></div>)}</dl>
      <p className="intel-analysis-caption">Scores recorded: {st.scored_at && Number.isFinite(Date.parse(st.scored_at)) ? new Date(st.scored_at).toLocaleString(undefined,{timeZoneName:'short'}) : 'Time unreported'}. Member updates and analyst research have separate source times.</p>
      {sourceErrors.alert && <p role="alert">Alert status could not be read. <button className="intel-text-link" onClick={load}>Retry narrative</button></p>}
      <nav aria-label="Narrative sections" className="flex gap-4 flex-wrap">{['Members','Signals','History','Sources','Research'].map(label => <a className="intel-text-link" key={label} href={`#narrative-${label.toLowerCase()}`}>{label}</a>)}</nav>
      <div id="narrative-members"><NarrativeMembers narrativeId={tax.id}/></div>

      {/* scorecard */}
      <details id="narrative-signals" className="py-3 space-y-3">
        <summary>{t('narratives.scorecard', { defaultValue: 'Scorecard' })}</summary>
        <NarrativeScorecard n={st} />
        {/* The scorecard's readings are ours, computed from recorded signals, not
            a provider's figures, so the line says so and carries the scoring run's
            own clock. Same inputs string as the radar, which scores the same way. */}
        <FigureSourceLine
          ourCalculation
          inputs={t('narratives.score_inputs', { defaultValue: 'recorded market, on-chain and social signals' })}
          capturedAt={st.scored_at || null}
        />
      </details>

      {/* confirmation & signals (a narrative is "strong" only when chatter is confirmed) */}
      <div className="intel-narrative-section py-3 space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="eyebrow">{t('narratives.confirmation', { defaultValue: 'Confirmation & signals' })}</div>
          <span className={`inline-flex items-center gap-1 text-[11px] ${mkt.text}`}><span className={`h-2 w-2 ${mkt.dot}`} /> {t('narratives.market', { defaultValue: 'Market' })}: {mkt.label}</span>
          <span className={`inline-flex items-center gap-1 text-[11px] ${oc.text}`}><span className={`h-2 w-2 ${oc.dot}`} /> {oc.label}</span>
        </div>
        {xvel && xvel.velocity_pct != null && (
          <div className="intel-narrative-note p-2 flex items-center gap-2 flex-wrap text-[12px]">
            <span className="text-[var(--fg-5)]">{t('narratives.x_chatter', { defaultValue: 'X mentions' })}</span>
            {xvel.counts_today != null && <span className="font-semibold text-[var(--fg-1)]">~{Math.round(xvel.counts_today)}/day</span>}
            <span className={`font-semibold ${xvel.velocity_pct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{xvel.velocity_pct >= 0 ? '+' : ''}{Math.round(xvel.velocity_pct)}% {t('narratives.vs_7d', { defaultValue: 'vs 7d avg' })}</span>
            {xvel.total_7d != null && <span className="text-[10px] text-[var(--fg-5)]">· {Math.round(xvel.total_7d)} {t('narratives.in_7d', { defaultValue: 'in 7d' })}</span>}
          </div>
        )}
        {sourceErrors.attention && <p role="alert">X mention history could not be read. <button className="intel-text-link" onClick={load}>Retry sources</button></p>}
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
      <div id="narrative-history" className="intel-narrative-section py-3 space-y-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="eyebrow">{t('narratives.attn_vs_conf', { defaultValue: 'Attention vs confirmation (30d)' })}</div>
          <span className="text-[10px] text-[var(--fg-5)]">Gaps indicate missing scores. Confirmation averages both price and volume.</span>
        </div>
        {sourceErrors.history ? <p role="alert">Narrative history could not be read. <button className="intel-text-link" onClick={load}>Retry history</button></p> : <><TrendLines points={history}/>
          {history.length > 0 && <p className="intel-analysis-caption">{history.length} observations · {new Date(history[0].snapshot_at).toLocaleString(undefined,{timeZoneName:'short'})} – {new Date(history.at(-1).snapshot_at).toLocaleString(undefined,{timeZoneName:'short'})}{historyCoverage?.hasMore ? ' · Older records are available within the requested 30 days.' : ' · End of available history in the requested 30 days.'}</p>}
          {historyMore.error && <p role="alert">{historyMore.error}</p>}
          {historyCoverage?.hasMore && <button className="btn btn--quiet btn--sm" disabled={historyMore.loading} onClick={loadOlder}>{historyMore.loading?'Reading older history…':'Load older history'}</button>}
          <HistoryValues history={history}/>
        </>}
      </div>

      {/* history */}
      {!sourceErrors.history && <div className="grid sm:grid-cols-2 gap-3">
        <div className="intel-narrative-section py-3 space-y-2">
          <div className="eyebrow">{t('narratives.priority_history', { defaultValue: 'Priority history (30d)' })}</div>
          <Sparkline points={history} />
        </div>
        <div className="intel-narrative-section py-3 space-y-2">
          <div className="eyebrow">{t('narratives.stage_history', { defaultValue: 'Stage history' })}</div>
          <StageHistory history={history} />
        </div>
      </div>}

      {/* leaders / laggards */}
      {(leaders.length > 0 || laggards.length > 0) && (
        <div className="grid sm:grid-cols-2 gap-3">
          <MoversCard title={t('narratives.leaders', { defaultValue: 'Top leaders' })} rows={leaders} />
          <MoversCard title={t('narratives.laggards', { defaultValue: 'Top laggards' })} rows={laggards} />
        </div>
      )}

      {/* why chatter is rising */}
      {chatter?.raw?.why && (
        <div className="intel-narrative-note p-3 text-[13px] text-[var(--fg-2)]">
          <span className="text-[var(--fg-4)] text-[11px] uppercase tracking-wide">{t('narratives.why_chatter', { defaultValue: 'Why it’s being discussed' })}: </span>
          {chatter.raw.why}{chatter.raw.what_changed ? ` · ${chatter.raw.what_changed}` : ''}
        </div>
      )}

      {/* top posts & sources (normalized, clickable evidence) */}
      {(sources.length > 0 || drivers.length > 0) && (
        <div id="narrative-sources" className="intel-narrative-section py-3 space-y-2">
          <div className="eyebrow">{t('narratives.top_sources', { defaultValue: 'Top posts & sources' })}</div>
          <div className="space-y-2">
            {(sources.length > 0 ? sources : drivers).slice(0, allSources ? undefined : 6).map((d, i) => {
              const url = d.url
              const kind = d.signal_kind || (d.cluster_id ? 'source_cluster' : 'news')
              const bias = d.bias || d.signal_bias
              const handle = d.author_handle
              const label = d.title || (handle ? `@${handle}` : null) || d.domain || url || t('narratives.signal_cluster', { defaultValue: 'Signal cluster' })
              return (
                <div key={i} className="flex items-start gap-2 text-[13px]">
                  <span className="text-[9px] uppercase mt-0.5">{String(kind).replace(/_/g, ' ')}</span>
                  {bias && <span className={`text-[9px] mt-0.5 ${bias === 'bullish' ? 'text-[var(--ok)]' : bias === 'bearish' ? 'text-[var(--danger)]' : ''}`}>{bias}</span>}
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
          {Math.max(sources.length,drivers.length)>6 && <button className="intel-text-link" onClick={()=>setAllSources(value=>!value)}>{allSources?'Show fewer sources':`Show all ${sources.length || drivers.length} sources`}</button>}
        </div>
      )}

      {/* Analyst brief - bull/bear/what-to-watch/confirm/invalidate */}
      <section id="narrative-research">
      <NarrativeResearch slug={slug} name={tax.name}/>
      {sourceErrors.brief ? <p role="alert">The saved analyst brief could not be read. <button className="intel-text-link" onClick={load}>Retry brief</button></p> : briefResult ? (
        <details className="space-y-2">
          <summary>{t('narratives.ai_read', { defaultValue: 'Analyst brief - why it matters, what changed, what to watch' })}</summary>
          <p className="intel-analysis-caption">Saved brief: {detail.brief.created_at ? new Date(detail.brief.created_at).toLocaleString() : 'Creation time unreported'}{detail.brief.evidence_hash ? ` · Evidence ${detail.brief.evidence_hash}` : ''}{detail.brief.stale_after && Date.parse(detail.brief.stale_after) <= Date.now() ? ' · Outside its freshness window' : ''}. This is its original saved evidence.</p>
          <ArtifactView result={briefResult} loading={false} />
        </details>
      ) : (
        <div className="intel-narrative-note p-3 text-[12px] text-[var(--fg-4)]">No shared analyst brief is currently retained for this narrative.</div>
      )}
      </section>

      {/* super-admin debug */}
      {isSuperAdmin && (
        <div className="intel-narrative-note p-3">
          <button onClick={openDebug} className="flex items-center gap-1.5 text-[12px] text-[var(--fg-3)]"><Bug className="h-3.5 w-3.5" /> {t('narratives.debug', { defaultValue: 'Debug (super-admin)' })} <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showDebug ? 'rotate-180' : ''}`} /></button>
          {showDebug && <pre className="mt-2 text-[10px] text-[var(--fg-4)] overflow-auto max-h-96 whitespace-pre-wrap">{debug ? JSON.stringify(debug, null, 2) : '…'}</pre>}
        </div>
      )}

      <IntelDisclaimer variant="block" />
    </IntelPageShell>
  )
}

function HistoryValues({history}) {
  const [page,setPage]=useState(0),rows=history.slice().reverse(),shown=rows.slice(page*50,page*50+50)
  return <details><summary>Recorded score values</summary>{!rows.length?<p>No scores were recorded in this period.</p>:<>
    <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Recorded narrative scores"><table className="intel-evidence-table w-full"><thead><tr><th scope="col">Time</th><th scope="col">Priority</th><th scope="col">Chatter</th><th scope="col">Price confirmation</th><th scope="col">Volume confirmation</th><th scope="col">Stage</th></tr></thead><tbody>{shown.map((row,index)=><tr key={`${row.snapshot_at}:${index}`}><th scope="row">{new Date(row.snapshot_at).toLocaleString(undefined,{timeZoneName:'short'})}</th>{['global_priority_score','chatter_score','price_confirmation_score','volume_confirmation_score'].map(key=><td key={key}>{narrativeScore(row[key]) ?? 'Not recorded'}</td>)}<td>{stageMeta(row.lifecycle_stage).label}</td></tr>)}</tbody></table></div>
    <div className="flex items-center gap-3"><button className="btn btn--quiet btn--sm" disabled={!page} onClick={()=>setPage(value=>value-1)}>Newer scores</button><span>Page {page+1}</span><button className="btn btn--quiet btn--sm" disabled={(page+1)*50>=rows.length} onClick={()=>setPage(value=>value+1)}>Older scores</button></div>
  </>}</details>
}

function ConfBar({ label, value, invert, signed }) {
  const has = narrativeScore(value) != null
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
      <div className="h-1.5 bg-[var(--bg-3,#1c1c1c)] overflow-hidden">
        {pct != null && <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />}
      </div>
    </div>
  )
}

function MoversCard({ title, rows }) {
  return (
    <div className="intel-narrative-section py-3 space-y-2">
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
        return <div key={i} className="flex items-center justify-between text-[12px]"><span className={`text-[10px] uppercase `}>{m.label}</span><span className="text-[var(--fg-4)] tabular-nums">{new Date(c.at).toLocaleDateString()}</span></div>
      })}
    </div>
  )
}
