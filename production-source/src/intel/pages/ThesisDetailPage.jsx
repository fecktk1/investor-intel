import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useSearchParams, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Archive, RefreshCw } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import {
  getThesis, getThesisDelta, listTrades, createReview, setThesisStatus, resolveEngineStatus, evaluateThesisNow,
} from '../lib/thesis-api'
import { loadMarketDetail, loadMarketCandles } from '../lib/markets-api'
import ThesisStatusBadge from '../components/thesis/ThesisStatusBadge'
import ThesisQualityScore from '../components/thesis/ThesisQualityScore'
import ThesisDeltaCard from '../components/thesis/ThesisDeltaCard'
import EngineSuggestionBanner from '../components/thesis/EngineSuggestionBanner'
import ReviewComposer from '../components/thesis/ReviewComposer'
import TokenChart from '../components/TokenChart'
import IntelErrorNotice from '../components/IntelErrorNotice'
import IntelDisclaimer from '../components/IntelDisclaimer'

const TABS = ['overview', 'evidence', 'chart', 'portfolio', 'trades', 'reviews', 'alerts']
const STANCE_CLS = { bullish: 'text-[var(--ok)]', bearish: 'text-red-400', neutral: 'text-[var(--fg-3)]' }
const ts = (d) => d ? Date.parse(d) : null
const fmtDate = (d) => d ? new Date(d).toLocaleDateString() : '—'

export default function ThesisDetailPage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { id } = useParams()
  const { org } = useProfile()
  const { supabase, user } = useSupabase()
  const [sp, setSp] = useSearchParams()
  const tab = TABS.includes(sp.get('tab')) ? sp.get('tab') : 'overview'

  const [th, setTh] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [delta, setDelta] = useState({ loading: true, data: null })
  const [trades, setTrades] = useState([])
  const [candles, setCandles] = useState({ loading: false, data: null })
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!org?.id || !id) return
    setLoading(true); setErr(null)
    try { setTh(await getThesis(supabase, org.id, id)) }
    catch (e) { setErr(e.message) }
    finally { setLoading(false) }
  }, [org?.id, id, supabase])
  useEffect(() => { load() }, [load])

  // delta + trades (best-effort; degrade gracefully if backend not deployed)
  useEffect(() => {
    if (!org?.id || !id) return
    let alive = true
    getThesisDelta(supabase, org.id, id).then((d) => alive && setDelta({ loading: false, data: d })).catch(() => alive && setDelta({ loading: false, data: null }))
    listTrades(supabase, org.id, { thesisId: id }).then((r) => alive && setTrades(r)).catch(() => {})
    return () => { alive = false }
  }, [org?.id, id, supabase])

  // lazy candles for chart tab
  useEffect(() => {
    if (tab !== 'chart' || candles.data || candles.loading || !th?.entity_id) return
    const sym = th.subject_canonical_key?.split(':').pop() || null
    if (!sym) return
    setCandles({ loading: true, data: null })
    loadMarketDetail(supabase, org.id, sym).then((d) => setCandles({ loading: false, data: d?.candles || [] })).catch(() => setCandles({ loading: false, data: [] }))
  }, [tab, th, candles.data, candles.loading, supabase, org?.id])

  const markers = useMemo(() => {
    if (!th) return []
    const m = []
    if (th.created_at) m.push({ t: ts(th.created_at), type: 'thesis', label: 'Thesis' })
    for (const r of th.reviews || []) m.push({ t: ts(r.created_at), type: 'review', label: 'Review' })
    for (const r of th.rules || []) if (r.status === 'triggered' && r.triggered_at) m.push({ t: ts(r.triggered_at), type: r.rule_kind === 'invalidation' ? 'invalidate' : 'confirm', label: r.rule_kind })
    for (const tr of trades) {
      if (tr.opened_at) m.push({ t: ts(tr.opened_at), type: 'entry', label: 'Entry' })
      if (tr.closed_at) m.push({ t: ts(tr.closed_at), type: 'exit', label: 'Exit' })
    }
    return m.filter((x) => x.t)
  }, [th, trades])

  const keyLevels = useMemo(() => (th?.scenarios || []).filter((s) => s.price_target != null).map((s) => ({ price: s.price_target, label: s.kind })), [th])

  const onReview = useCallback(async (review) => {
    setBusy(true)
    try {
      await createReview(supabase, org.id, user?.id, id, review)
      if (review.new_status) await setThesisStatus(supabase, id, review.new_status)
      else if (review.new_conviction != null) await setThesisStatus(supabase, id, th.status, { conviction: review.new_conviction })
      await load()
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }, [supabase, org?.id, user?.id, id, th, load])

  const onResolve = useCallback(async (decision) => {
    setBusy(true)
    try { await resolveEngineStatus(supabase, org.id, id, decision); await load() }
    catch (e) { setErr(e.message) } finally { setBusy(false) }
  }, [supabase, org?.id, id, load])

  if (loading) return <div className="card p-8 grid place-items-center"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--accent)]" /></div>
  if (err) return <div className="space-y-3"><Link to="/intel/theses/list" className="text-[12px] text-[var(--fg-4)] inline-flex items-center gap-1"><ArrowLeft className="h-3.5 w-3.5" /> {t('journal.nav.theses', { defaultValue: 'Theses' })}</Link><IntelErrorNotice error={err} /></div>
  if (!th) return null

  const sym = th.subject_canonical_key?.split(':').pop()

  return (
    <div className="space-y-4">
      <Link to="/intel/theses/list" className="text-[12px] text-[var(--fg-4)] inline-flex items-center gap-1 hover:text-[var(--accent)]"><ArrowLeft className="h-3.5 w-3.5" /> {t('journal.nav.theses', { defaultValue: 'Theses' })}</Link>

      {/* header */}
      <div className="card p-4 space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="eyebrow">{sym || th.thesis_type}</div>
            <h1 className="page-title">{th.title}</h1>
          </div>
          <div className="flex items-center gap-1.5">
            <ThesisStatusBadge status={th.status} />
            <button onClick={async () => { setBusy(true); try { await evaluateThesisNow(supabase, org.id, id); await load() } catch (e) { setErr(e.message) } finally { setBusy(false) } }} disabled={busy} className="btn btn--quiet btn--sm disabled:opacity-50" title={t('journal.reevaluate', { defaultValue: 'Re-evaluate now' })}><RefreshCw className="h-3.5 w-3.5" /></button>
            {!['closed', 'archived'].includes(th.status) && (
              <button onClick={() => setThesisStatus(supabase, id, 'archived').then(load)} className="btn btn--quiet btn--sm" title={t('journal.archive', { defaultValue: 'Archive' })}><Archive className="h-3.5 w-3.5" /></button>
            )}
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-[12px]">
          <div><div className="text-[11px] text-[var(--fg-4)]">{t('journal.f.stance', { defaultValue: 'Stance' })}</div><div className={STANCE_CLS[th.stance] || ''}>{th.stance || '—'}</div></div>
          <div><div className="text-[11px] text-[var(--fg-4)]">{t('journal.f.conviction', { defaultValue: 'Conviction' })}</div><div>{th.conviction != null ? `${Math.round(th.conviction * 5)}/5` : '—'}</div></div>
          <div><div className="text-[11px] text-[var(--fg-4)]">{t('journal.f.horizon', { defaultValue: 'Horizon' })}</div><div>{th.time_horizon || '—'}</div></div>
          <div><div className="text-[11px] text-[var(--fg-4)]">{t('journal.created', { defaultValue: 'Created' })}</div><div>{fmtDate(th.created_at)}</div></div>
          <div><div className="text-[11px] text-[var(--fg-4)]">{t('journal.last_reviewed', { defaultValue: 'Last reviewed' })}</div><div>{fmtDate(th.last_reviewed_at || (th.reviews?.[0]?.created_at))}</div></div>
          <div><div className="text-[11px] text-[var(--fg-4)]">{t('journal.next_review', { defaultValue: 'Next review' })}</div><div>{fmtDate(th.next_review_at)}</div></div>
        </div>
        {typeof th.quality_score === 'number' && <ThesisQualityScore quality={{ score: th.quality_score, missing: th.quality_missing }} compact />}
      </div>

      <EngineSuggestionBanner thesis={th} onResolve={onResolve} busy={busy} />

      {/* tabs */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {TABS.map((x) => (
          <button key={x} onClick={() => setSp(x === 'overview' ? {} : { tab: x })}
            className={`chip text-[11px] ${tab === x ? 'bg-[var(--accent)] text-black' : 'text-[var(--fg-4)]'}`}>{t(`journal.tab.${x}`, { defaultValue: x })}</button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="space-y-3">
          <ThesisDeltaCard delta={delta.data} loading={delta.loading} />
          {th.bull_thesis && <div className="card p-4"><div className="eyebrow text-[var(--ok)]">{t('journal.scenario.bull', { defaultValue: 'Bull case' })}</div><p className="text-[13px] text-[var(--fg-2)] mt-1">{th.bull_thesis}</p></div>}
          {th.neutral_thesis && <div className="card p-4"><div className="eyebrow">{t('journal.scenario.base', { defaultValue: 'Base case' })}</div><p className="text-[13px] text-[var(--fg-2)] mt-1">{th.neutral_thesis}</p></div>}
          {th.bear_thesis && <div className="card p-4"><div className="eyebrow text-red-400">{t('journal.scenario.bear', { defaultValue: 'Bear case' })}</div><p className="text-[13px] text-[var(--fg-2)] mt-1">{th.bear_thesis}</p></div>}
        </div>
      )}

      {tab === 'evidence' && (
        <div className="space-y-2">
          {(th.evidence || []).length === 0 ? <div className="card p-6 text-center text-[13px] text-[var(--fg-4)]">{t('journal.no_evidence', { defaultValue: 'No evidence attached yet.' })}</div> : (th.evidence || []).map((e) => {
            const snap = e.event_snapshot || {}
            return (
              <div key={e.id} className="card p-3 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[13px] text-[var(--fg-1)]">{snap.title || e.event_type}</div>
                  {e.user_label && <span className="chip text-[10px]">{e.user_label}</span>}
                </div>
                {snap.summary && <p className="text-[12px] text-[var(--fg-3)]">{snap.summary}</p>}
                <div className="flex items-center gap-1.5 flex-wrap text-[10px] text-[var(--fg-5)]">
                  {e.impact && <span className={`chip ${e.impact === 'supports' || e.impact === 'confirms' ? 'chip--ok' : e.impact === 'weakens' || e.impact === 'invalidates' ? 'chip--err' : ''}`}>{e.impact}</span>}
                  <span>{e.event_type}</span>{e.is_baseline && <span className="chip chip--info">baseline</span>}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {tab === 'chart' && (
        <TokenChart candles={candles.data} loading={candles.loading} markers={markers} keyLevels={keyLevels} showDensityToggles
          defaultRange="7D" loadCandles={sym ? (tf) => loadMarketCandles(supabase, org.id, sym, tf) : null} />
      )}

      {tab === 'portfolio' && (
        <div className="card p-4 text-[13px] text-[var(--fg-3)] space-y-2">
          {th.portfolio_id ? <div>{t('journal.linked_portfolio', { defaultValue: 'Linked to a portfolio position.' })}</div> : <div className="text-[var(--fg-4)]">{t('journal.no_portfolio', { defaultValue: 'Not linked to a portfolio holding.' })}</div>}
          {th.baseline?.portfolio_snapshot && Object.keys(th.baseline.portfolio_snapshot).length > 0 && <pre className="text-[11px] text-[var(--fg-4)] overflow-auto">{JSON.stringify(th.baseline.portfolio_snapshot, null, 2).slice(0, 600)}</pre>}
        </div>
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
          <ReviewComposer thesis={th} onSubmit={onReview} busy={busy} />
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
        <div className="space-y-2">
          {(th.rules || []).length === 0 ? <div className="card p-6 text-center text-[13px] text-[var(--fg-4)]">{t('journal.no_rules', { defaultValue: 'No confirmation or invalidation rules.' })}</div> : (th.rules || []).map((r) => (
            <div key={r.id} className="card p-3 flex items-center justify-between gap-2 text-[12px]">
              <div className="flex items-center gap-2">
                <span className={`chip text-[10px] ${r.rule_kind === 'invalidation' ? 'chip--err' : 'chip--ok'}`}>{r.rule_kind}</span>
                <span className="text-[var(--fg-2)]">{r.description}</span>
              </div>
              <span className="chip text-[10px] text-[var(--fg-4)]">{r.status}{r.alert_rule_id ? ' · alert' : ''}</span>
            </div>
          ))}
        </div>
      )}

      <IntelDisclaimer variant="block" />
    </div>
  )
}
