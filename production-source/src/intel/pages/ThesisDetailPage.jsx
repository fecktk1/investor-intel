import ThesisEvidenceRecord from '../components/thesis/ThesisEvidenceRecord'
import ThesisBaselineEvidence from '../components/thesis/ThesisBaselineEvidence'
import ThesisEvaluationPreview from '../components/thesis/ThesisEvaluationPreview'
import ThesisAuthoredDraft from '../components/thesis/ThesisAuthoredDraft'
import ThesisInvalidation from '../components/thesis/ThesisInvalidation'
import ThesisPortfolioWorkspace from '../components/thesis/ThesisPortfolioWorkspace'
import ThesisConditions from '../components/thesis/ThesisConditions'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useSearchParams, useLocation, Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Archive, RefreshCw } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import {
  getThesis, updateThesis, getThesisDelta, getAssetThesisMarkers, listTrades, createReview, setThesisStatus, resolveEngineStatus, evaluateThesisNow, previewThesisEvaluation,
} from '../lib/thesis-api'
import { loadThesisChart } from '../lib/thesis-chart'
import { thesisAssetLabel } from '../lib/thesis-identity'
import { useLiveHistoryEnd } from '../lib/useLiveHistoryEnd'
import ThesisStatusBadge from '../components/thesis/ThesisStatusBadge'
import ThesisQualityScore from '../components/thesis/ThesisQualityScore'
import ThesisDeltaCard from '../components/thesis/ThesisDeltaCard'
import EngineSuggestionBanner from '../components/thesis/EngineSuggestionBanner'
import MetricAgreementChip from '../components/MetricAgreementChip'
import ReviewComposer from '../components/thesis/ReviewComposer'
import { CHART_RANGE_MS } from '../components/TokenChart'
import IntelErrorNotice from '../components/IntelErrorNotice'
import IntelDisclaimer from '../components/IntelDisclaimer'

const TABS = ['overview', 'evidence', 'chart', 'portfolio', 'trades', 'reviews', 'alerts']
const fmtDate = (d) => d ? new Date(d).toLocaleDateString() : '—'
const ThesisFacts=({items})=><dl className="intel-thesis-facts text-[12px]">{items.map(([label,value])=><div key={label}><dt className="text-[11px] text-[var(--fg-4)]">{label}</dt><dd>{value}</dd></div>)}</dl>

export default function ThesisDetailPage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { id } = useParams()
  const { org } = useProfile()
  const { supabase, user } = useSupabase()
  const [sp, setSp] = useSearchParams()
  const location=useLocation(),returnState=location.state?.journalReturn
  const journalReturn=returnState?.orgId===org?.id&&returnState?.userId===user?.id&&typeof returnState?.url==='string'&&returnState.url.length<=3000&&/^\/intel\/theses\/list(?:\?[^#]*)?$/.test(returnState.url)?returnState.url:'/intel/theses/list'
  const tab = TABS.includes(sp.get('tab')) ? sp.get('tab') : 'overview'

  const [th, setTh] = useState(null)
  const [loadedScope,setLoadedScope]=useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [delta, setDelta] = useState({ loading: true, data: null })
  const [trades, setTrades] = useState([])
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState(null)
  const [activity, setActivity] = useState({ markers: [], nextCursor: null, loading: true, error: null })
  const activityRequest = useRef(0)
  const thesisRequest = useRef(0)
  const [chartWindow, setChartWindow] = useState(() => ({ range: '7D', to: Date.now() }))
  const liveHistoryTo=useLiveHistoryEnd(org?.id)
  useEffect(()=>setChartWindow(previous=>({...previous,to:liveHistoryTo})),[liveHistoryTo])
  const chartFrom = chartWindow.to - CHART_RANGE_MS[chartWindow.range]
  const activityScope = `${org?.id}:${user?.id}:${id}:${chartFrom}:${chartWindow.to}`
  const onChartRange = useCallback(range => setChartWindow(previous => previous.range === range ? previous : { range, to: Date.now() }), [])
  const [allActivityOpen, setAllActivityOpen] = useState(false)
  const [allActivity, setAllActivity] = useState({ scope: null, markers: [], nextCursor: null, loading: false, error: null })
  const allRequest = useRef(0)
  const ownerScope = `${org?.id}:${user?.id}:${id}`
  const activeOwnerScope=useRef(ownerScope);activeOwnerScope.current=ownerScope

  const load = useCallback(async () => {
    if (!org?.id || !id || activeOwnerScope.current!==ownerScope) return
    const request = ++thesisRequest.current
    setLoading(true); setErr(null)
    try { const result = await getThesis(supabase, org.id, id); if (request === thesisRequest.current&&activeOwnerScope.current===ownerScope) {setTh(result);setLoadedScope(ownerScope)} }
    catch (e) { if (request === thesisRequest.current) setErr(e.message) }
    finally { if (request === thesisRequest.current) setLoading(false) }
  }, [org?.id, user?.id, id, supabase, ownerScope])
  useEffect(() => { setTh(null); load(); return () => { thesisRequest.current++ } }, [load])

  const loadActivity = useCallback(async (cursor = null) => {
    if (!org?.id || !id || tab !== 'chart') return
    const request = ++activityRequest.current
    setActivity((s) => ({ ...s, loading: true, error: null }))
    try {
      const result = await getAssetThesisMarkers(supabase, org.id, { thesisId: id, cursor, from: chartFrom, to: chartWindow.to })
      if (request !== activityRequest.current) return
      setActivity((s) => ({ ...result, scope: activityScope, markers: cursor && s.scope === activityScope ? [...new Map([...s.markers, ...result.markers].map((m) => [m.id, m])).values()] : result.markers, loading: false, error: null }))
    } catch (e) { if (request === activityRequest.current) setActivity((s) => ({ ...s, loading: false, error: e.message })) }
  }, [org?.id, id, supabase, activityScope, chartFrom, chartWindow.to, tab])
  const loadAllActivity = useCallback(async (cursor = null) => {
    if (!org?.id || !id || !allActivityOpen) return
    const seq = ++allRequest.current
    setAllActivity(s => ({ ...s, loading: true, error: null }))
    try {
      const result = await getAssetThesisMarkers(supabase, org.id, { thesisId: id, cursor })
      if (allRequest.current !== seq) return
      setAllActivity(s => ({ ...result, scope: ownerScope, markers: cursor && s.scope === ownerScope ? [...new Map([...s.markers, ...result.markers].map(m => [m.id, m])).values()] : result.markers, loading: false, error: null }))
    } catch (e) { if (allRequest.current === seq) setAllActivity(s => ({ ...s, loading: false, error: e.message })) }
  }, [org?.id, id, supabase, ownerScope, allActivityOpen])
  useEffect(() => { loadAllActivity(); return () => { allRequest.current++ } }, [loadAllActivity])
  useEffect(() => {
    setActivity({ markers: [], nextCursor: null, loading: true, error: null })
    loadActivity()
    const refresh = (event) => {
      if (event.detail?.orgId === org?.id && (!event.detail?.thesisId || event.detail.thesisId === id)) { setChartWindow(previous => ({ ...previous, to: Date.now() })); loadAllActivity() }
    }
    window.addEventListener('intel:thesis-activity-changed', refresh)
    return () => { activityRequest.current++; window.removeEventListener('intel:thesis-activity-changed', refresh) }
  }, [loadActivity, loadAllActivity, org?.id, id])

  // delta + trades (best-effort; degrade gracefully if backend not deployed)
  useEffect(() => {
    if (!org?.id || !id) return
    setDelta({loading:true,data:null});setTrades([]);setBusy(false);setActionError(null)
    let alive = true
    getThesisDelta(supabase, org.id, id).then((d) => alive && setDelta({ loading: false, data: d })).catch((error) => alive && setDelta({ loading: false, data: null, error: error.message || 'Read failed' }))
    listTrades(supabase, org.id, { thesisId: id }).then((r) => alive && setTrades(r)).catch(() => {})
    return () => { alive = false }
  }, [org?.id, user?.id, id, supabase])

  const loadChart = useCallback((range) => loadThesisChart(supabase, org?.id, th, range, chartWindow.to), [supabase, org?.id, th, chartWindow.to])

  const markers = activity.scope === activityScope ? activity.markers : []

  const keyLevels = useMemo(() => (th?.scenarios || []).filter((s) => s.price_target != null).map((s) => ({ price: s.price_target, label: s.kind })), [th])

  const onReview = useCallback(async (review) => {
    setBusy(true); setActionError(null)
    try {
      await createReview(supabase, org.id, user?.id, id, review)
      await load()
      return true
    } catch (e) { if(activeOwnerScope.current===ownerScope)setActionError(e.message); return false } finally { if(activeOwnerScope.current===ownerScope)setBusy(false) }
  }, [supabase, org?.id, user?.id, id, load,ownerScope])

  const onResolve = useCallback(async (decision) => {
    setBusy(true)
    try { await resolveEngineStatus(supabase, org.id, id, decision); await load() }
    catch (e) { if(activeOwnerScope.current===ownerScope)setActionError(e.message) } finally { if(activeOwnerScope.current===ownerScope)setBusy(false) }
  }, [supabase, org?.id, id, load,ownerScope])

  const onStatus=async status=>{
    setBusy(true);setActionError(null)
    try{await setThesisStatus(supabase,id,status);if(activeOwnerScope.current===ownerScope)await load()}
    catch(error){if(activeOwnerScope.current===ownerScope)setActionError(error.message)}
    finally{if(activeOwnerScope.current===ownerScope)setBusy(false)}
  }

  if (loading) return <section className="intel-thesis-loading" aria-busy="true" role="status"><p>Loading thesis and its recorded evidence…</p></section>
  if (err) return <div className="space-y-3"><Link to={journalReturn} className="text-[12px] text-[var(--fg-4)] inline-flex items-center gap-1"><ArrowLeft className="h-3.5 w-3.5" /> {t('journal.nav.theses', { defaultValue: 'Theses' })}</Link><IntelErrorNotice error={err} /></div>
  if (loadedScope!==ownerScope || !th || th.id !== id || th.org_id !== org?.id || (th.user_id !== user?.id && th.visibility !== 'org')) return null

  const sym = thesisAssetLabel(th)
  const isOwner=th.user_id===user?.id
  const facts=[
    [t('journal.f.stance',{defaultValue:'Stance'}),th.stance||'—'],
    [t('journal.f.conviction_short',{defaultValue:'Conviction'}),th.conviction!=null?`${Math.round(th.conviction*5)}/5`:'—'],
    [t('journal.f.horizon_short',{defaultValue:'Horizon'}),th.time_horizon||'—'],
    [t('journal.created',{defaultValue:'Created'}),fmtDate(th.created_at)],
    [t('journal.last_reviewed',{defaultValue:'Last reviewed'}),fmtDate(th.last_reviewed_at||th.reviews?.[0]?.created_at)],
    [t('journal.next_review',{defaultValue:'Next review'}),fmtDate(th.next_review_at)],
  ]

  return (
    <div className="intel-thesis-workspace space-y-3">
      {actionError && <IntelErrorNotice error={actionError} />}
      <Link to={journalReturn} className="text-[12px] text-[var(--fg-4)] inline-flex items-center gap-1 hover:text-[var(--accent)]"><ArrowLeft className="h-3.5 w-3.5" /> {t('journal.nav.theses', { defaultValue: 'Theses' })}</Link>

      {/* header */}
      <header className="intel-thesis-heading border-b border-[var(--border-default)] pb-3 space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="eyebrow">{sym || th.thesis_type}</div>
            <h1 className="page-title">{th.title}</h1>
            {(th.entity?.canonical_ref_key||th.subject_canonical_key) && <Link className="intel-text-link text-sm" to={`/intel/investigate?${new URLSearchParams({asset:th.entity?.canonical_ref_key||th.subject_canonical_key,thesis:th.id,lens:'replay'})}`}>{t('investigation.replay',{defaultValue:'Replay this decision with its evidence'})}</Link>}
          </div>
          <div className="flex items-center gap-1.5">
            <ThesisStatusBadge status={th.status} />
            {isOwner&&<button onClick={async () => { setBusy(true); try { await evaluateThesisNow(supabase, org.id, id); await load() } catch (e) { setActionError(e.message) } finally { setBusy(false) } }} disabled={busy} className="btn btn--quiet btn--sm disabled:opacity-50" title={t('journal.reevaluate', { defaultValue: 'Re-evaluate now' })}><RefreshCw className="h-3.5 w-3.5" /></button>}
            {isOwner&&(th.status==='archived'?<button disabled={busy} onClick={()=>onStatus('active')} className="btn btn--quiet btn--sm">{t('journal.restore_active',{defaultValue:'Restore as active'})}</button>:
              <button disabled={busy} onClick={()=>onStatus('archived')} className="btn btn--quiet btn--sm" aria-label={t('journal.archive', { defaultValue: 'Archive' })}><Archive className="h-3.5 w-3.5" /></button>)}
          </div>
        </div>
        <div className={tab==='chart'?'hidden sm:block':''}><ThesisFacts items={facts}/></div>
        {tab==='chart'&&<details className="sm:hidden text-sm"><summary className="cursor-pointer py-1">{facts[0][1]} · {facts[1][1]} · {t('journal.decision_details',{defaultValue:'Decision details'})}</summary><div className="pt-3"><ThesisFacts items={facts}/></div></details>}
        {typeof th.quality_score === 'number' && <ThesisQualityScore quality={{ score: th.quality_score, missing: th.quality_missing }} compact />}
      </header>

      {isOwner&&<EngineSuggestionBanner thesis={th} onResolve={onResolve} busy={busy} />}
      {/* The verdict the monitor stored with its last evaluation, shown whenever
          one was computed, not only when a confirmation rule fired. */}
      {th.status_reason?.metric_agreement&&<section aria-label={t('journal.evidence_standard',{defaultValue:'Evidentiary standard'})} className="space-y-1">
        <p className="text-[11px] text-[var(--fg-4)]">{t('journal.evidence_standard_measured',{defaultValue:'Evidentiary standard for this asset, measured {{date}}',date:th.status_reason.computed_at&&Number.isFinite(Date.parse(th.status_reason.computed_at))?new Date(th.status_reason.computed_at).toLocaleString():t('journal.conditions.not_available',{defaultValue:'not available'})})}</p>
        <MetricAgreementChip agreement={{metric_agreement:th.status_reason.metric_agreement,reasons:th.status_reason.metric_agreement_reasons}}/>
      </section>}

      {/* tabs */}
      <nav aria-label="Thesis sections" className="intel-thesis-tabs">
        {TABS.map((x) => (
          <button key={x} onClick={() => setSp(x === 'overview' ? {} : { tab: x },{state:location.state})}
            aria-current={tab===x?'page':undefined} className="intel-thesis-tab">{t(`journal.tab.${x}`, { defaultValue: x })}</button>
        ))}
      </nav>

      {tab === 'overview' && (
        <div className="space-y-3">
          <ThesisDeltaCard delta={delta.data} loading={delta.loading} error={delta.error} />
          <ThesisInvalidation thesis={th} editable={isOwner} onSave={async patch => { await updateThesis(supabase, id, patch); await load() }}/>
          <ThesisAuthoredDraft thesis={th} editable={th.user_id === user?.id} onSave={async patch => { await updateThesis(supabase, id, patch); await load() }}/>
          {th.bull_thesis && <div className="card p-4"><div className="eyebrow text-[var(--ok)]">{t('journal.scenario.bull', { defaultValue: 'Bull case' })}</div><p className="text-[13px] text-[var(--fg-2)] mt-1">{th.bull_thesis}</p></div>}
          {th.neutral_thesis && <div className="card p-4"><div className="eyebrow">{t('journal.scenario.base', { defaultValue: 'Base case' })}</div><p className="text-[13px] text-[var(--fg-2)] mt-1">{th.neutral_thesis}</p></div>}
          {th.bear_thesis && <div className="card p-4"><div className="eyebrow text-red-400">{t('journal.scenario.bear', { defaultValue: 'Bear case' })}</div><p className="text-[13px] text-[var(--fg-2)] mt-1">{th.bear_thesis}</p></div>}
        </div>
      )}

      {tab === 'evidence' && (
        <div className="space-y-2">
          <ThesisBaselineEvidence key={ownerScope} supabase={supabase} orgId={org.id} thesisId={id}/>
          {isOwner && <ThesisEvaluationPreview key={ownerScope} onPreview={() => previewThesisEvaluation(supabase, org.id, id)} />}
          {(th.evidence || []).length === 0 ? <div className="card p-6 text-center text-[13px] text-[var(--fg-4)]">{t('journal.no_evidence', { defaultValue: 'No evidence attached yet.' })}</div> : (th.evidence || []).map(e => <ThesisEvidenceRecord key={e.id} evidence={e} />)}
        </div>
      )}

      {tab === 'chart' && (
        <div className="space-y-3">
        <ThesisPortfolioWorkspace thesis={th} from={chartFrom} to={chartWindow.to} chartProps={{markers,keyLevels,showDensityToggles:true,assetKey:`${org.id}:${user?.id}:${id}:${th.subject_canonical_key || th.entity_id}`,
          persistence:{supabase,userId:user?.id,orgId:org?.id,asset:th.subject_canonical_key||th.entity?.canonical_ref_key},defaultRange:'7D',loadCandles:loadChart,historyLoading:activity.loading,historyError:activity.error,
          onRangeChange:onChartRange,timeWindow:{from:chartFrom,to:chartWindow.to},historyHasMore:!!activity.nextCursor,onLoadMoreHistory:()=>loadActivity(activity.nextCursor)}}/>
        <details open={allActivityOpen} onToggle={event => setAllActivityOpen(event.currentTarget.open)}>
          <summary className="cursor-pointer text-sm py-3">All thesis activity</summary>
          {allActivity.error && <p role="alert" className="text-sm text-red-400">{allActivity.error} <button onClick={() => loadAllActivity()}>Retry</button></p>}
          {allActivity.scope === ownerScope && allActivity.markers.map(event => <article key={event.id} className="border-b border-[var(--border-default)] py-3 text-sm space-y-1">
            <p><b>{event.label}</b> <time className="text-[var(--fg-4)]" dateTime={event.occurredAt}>{new Date(event.t).toLocaleString()}</time></p>
            {Object.entries(event.textSnapshot || {}).filter(([, value]) => typeof value === 'string' && value.trim()).map(([key, value]) => <p key={key} className="whitespace-pre-wrap"><span className="text-[var(--fg-4)]">{key.replaceAll('_', ' ')}: </span>{value}</p>)}
            {event.historicalCompleteness !== 'complete' && <p className="text-[var(--fg-4)]">Historical wording was not recorded at this time.</p>}
          </article>)}
          {allActivity.loading && <p role="status" className="text-sm">Loading activity…</p>}
          {allActivity.scope === ownerScope && allActivity.nextCursor && <button className="btn btn--quiet btn--sm" disabled={allActivity.loading} onClick={() => loadAllActivity(allActivity.nextCursor)}>Load older activity</button>}
        </details>
        </div>
      )}

      {tab === 'portfolio' && (
        <ThesisPortfolioWorkspace thesis={th} from={chartFrom} to={chartWindow.to}/>
      )}

      {tab === 'trades' && (
        <div className="space-y-2">
          <div className="card--flat p-2 text-[11px] text-[var(--fg-4)]">{t('journal.trades_no_exec', { defaultValue: 'Trade Journal is for planning and review only. Investor Intel does not execute trades.' })}</div>
          {trades.length === 0 ? <div className="card p-6 text-center text-[13px] text-[var(--fg-4)]">{t('journal.no_trades', { defaultValue: 'No trades linked to this thesis yet.' })} <Link to="/intel/theses/trades" className="text-[var(--accent)]">{t('journal.nav.trades', { defaultValue: 'Trades' })}</Link></div> : trades.map((tr) => (
            <div key={tr.id} className="card p-3 flex items-center justify-between text-[12px]">
              <span className="text-[var(--fg-1)]">{tr.direction} {tr.symbol}</span>
              <span className="chip text-[10px]">{tr.status}</span>
            </div>
          ))}
        </div>
      )}

      {tab === 'reviews' && (
        <div className="space-y-3">
          {isOwner&&<ReviewComposer thesis={th} onSubmit={onReview} busy={busy} />}
          {(th.reviews || []).map((r) => (
            <div key={r.id} className="card p-3 space-y-1">
              <div className="flex items-center justify-between text-[11px] text-[var(--fg-4)]">
                <span>{fmtDate(r.created_at)} · {r.review_kind}</span>
                {r.new_status && <span>→ {t(`journal.status.${r.new_status}`, { defaultValue: r.new_status })}</span>}
              </div>
              {r.note && <p className="text-[13px] text-[var(--fg-2)]">{r.note}</p>}
            </div>
          ))}
        </div>
      )}

      {tab === 'alerts' && (
        <ThesisConditions supabase={supabase} userId={user?.id} thesis={th} editable={isOwner} onChanged={load}/>
      )}

      <IntelDisclaimer variant="block" />
    </div>
  )
}
