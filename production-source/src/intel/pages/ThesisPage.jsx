import React, { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { NotebookPen, Plus, Trash2 } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { listTheses, createThesis, deleteThesis, createAlertRule } from '../lib/intel-data'
import { resolveEntity } from '../lib/watchlist-api'
import { useArtifact } from '../lib/useArtifact'
import ArtifactView from '../components/ArtifactView'
import { CHAINS } from '../lib/chains'
import { Sparkles } from 'lucide-react'
import IntelDisclaimer from '../components/IntelDisclaimer'
import IntelLockedSurface from '../components/IntelLockedSurface'
import { useIntelSurfaceLock } from '../context/IntelAccess'

const EMPTY = { title: '', bull_thesis: '', bear_thesis: '', neutral_thesis: '', what_would_confirm: '', what_would_invalidate: '' }

// The flag-off fallback for the Thesis Journal. A membership that does not
// carry the journal keeps this page's header and gets the lock that names the
// plan which opens it, with none of the tracker's reads mounted: the refusal
// has already been made, so there is nothing here to withhold.
export default function ThesisPage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const lock = useIntelSurfaceLock('thesis_journal')
  if (!lock) return <ThesisWorkspace />
  return (
    <div className="space-y-5">
      <div>
        <div className="eyebrow flex items-center gap-1.5"><NotebookPen className="h-3.5 w-3.5" /> {t('brand.name', { defaultValue: 'Investor Intel' })}</div>
        <h1 className="page-title">{t('nav.theses', { defaultValue: 'Thesis Tracker' })}</h1>
        <p className="page-sub">{t('pages.theses_sub', { defaultValue: 'Save bull, bear and neutral cases with baselines to track later.' })}</p>
      </div>
      <IntelLockedSurface surface={lock.surface} minTier={lock.minTier} title={t('journal.title', { defaultValue: 'Thesis Journal' })} />
    </div>
  )
}

// P13 — Thesis Tracker. Captures bull/bear/neutral + confirm/invalidate + a
// baseline (so the post-launch drift worker can compare later).
function ThesisWorkspace() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase, user } = useSupabase()
  const [list, setList] = useState([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState(EMPTY)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)
  const [ent, setEnt] = useState({ chain: 'solana', value: '' })
  const review = useArtifact()
  const [reviewId, setReviewId] = useState(null)

  const load = useCallback(async () => {
    if (!org?.id) return
    setLoading(true)
    try { setList(await listTheses(supabase, org.id)) } catch (e) { setErr(e.message) } finally { setLoading(false) }
  }, [org?.id, supabase])
  useEffect(() => { load() }, [load])

  const save = useCallback(async (e) => {
    e.preventDefault()
    if (!form.title.trim() || !org?.id) return
    setSaving(true); setErr(null)
    try {
      let entity_id = null, subject_kind = 'general'
      if (ent.value.trim()) { const r = await resolveEntity(supabase, org.id, { kind: 'asset', chain: ent.chain, value: ent.value.trim() }); entity_id = r.id; subject_kind = 'token' }
      await createThesis(supabase, org.id, user?.id, { ...form, entity_id, subject_kind })
      setForm(EMPTY); setEnt({ chain: 'solana', value: '' }); setOpen(false); await load()
    } catch (ex) { setErr(ex.message) } finally { setSaving(false) }
  }, [form, ent, org?.id, supabase, user?.id, load])

  const field = (k, label, rows = 2) => (
    <label className="block">
      <span className="text-[11px] text-[var(--fg-4)]">{label}</span>
      {rows === 1
        ? <input className="input w-full" value={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} />
        : <textarea className="textarea w-full" rows={rows} value={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} />}
    </label>
  )

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="eyebrow flex items-center gap-1.5"><NotebookPen className="h-3.5 w-3.5" /> {t('brand.name', { defaultValue: 'Investor Intel' })}</div>
          <h1 className="page-title">{t('nav.theses', { defaultValue: 'Thesis Tracker' })}</h1>
          <p className="page-sub">{t('pages.theses_sub', { defaultValue: 'Save bull, bear and neutral cases with baselines to track later.' })}</p>
        </div>
        <button onClick={() => setOpen((o) => !o)} className="btn btn--primary btn--sm"><Plus className="h-4 w-4" /> {t('theses.new', { defaultValue: 'New thesis' })}</button>
      </div>

      {open && (
        <form onSubmit={save} className="card p-4 space-y-3">
          {field('title', t('theses.title', { defaultValue: 'Title' }), 1)}
          <div className="flex flex-wrap items-end gap-3">
            <label className="block"><span className="text-[11px] text-[var(--fg-4)]">{t('theses.chain', { defaultValue: 'Chain (optional)' })}</span>
              <select className="select" value={ent.chain} onChange={(e) => setEnt((s) => ({ ...s, chain: e.target.value }))}>{CHAINS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
            </label>
            <label className="block flex-1 min-w-[180px]"><span className="text-[11px] text-[var(--fg-4)]">{t('theses.entity', { defaultValue: 'Token address (optional, enables drift review)' })}</span>
              <input className="input w-full" value={ent.value} onChange={(e) => setEnt((s) => ({ ...s, value: e.target.value }))} />
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {field('bull_thesis', t('artifact.bull', { defaultValue: 'Bull case' }))}
            {field('neutral_thesis', t('artifact.neutral', { defaultValue: 'Neutral case' }))}
            {field('bear_thesis', t('artifact.bear', { defaultValue: 'Bear case' }))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {field('what_would_confirm', t('artifact.confirm', { defaultValue: 'Would confirm the thesis' }))}
            {field('what_would_invalidate', t('artifact.invalidate', { defaultValue: 'Would invalidate the thesis' }))}
          </div>
          {err && <div className="text-[13px] text-red-400">{err}</div>}
          <div className="flex justify-end"><button type="submit" disabled={saving || !form.title.trim()} className="btn btn--primary btn--sm disabled:opacity-50">{saving ? '…' : t('theses.save', { defaultValue: 'Save thesis' })}</button></div>
        </form>
      )}

      {/* Theses needing review — deterministic drift flagged by the alerts cron */}
      {!loading && list.some((th) => th.needs_review) && (
        <div className="card--flat p-3 border-l-2 border-amber-400 space-y-1">
          <div className="eyebrow">{t('theses.needs_review', { defaultValue: 'Theses needing review' })}</div>
          {list.filter((th) => th.needs_review).map((th) => (
            <div key={th.id} className="text-[12px] text-[var(--fg-2)]">
              <b>{th.title}</b>: {t('theses.drift_' + (th.drift_state || 'unknown'), { defaultValue: th.drift_state === 'weakens' ? 'current data weakens this thesis' : th.drift_state === 'supports' ? 'current data supports this thesis' : 'data shifted materially' })}
            </div>
          ))}
          <div className="text-[11px] text-[var(--fg-5)]">{t('theses.review_note', { defaultValue: 'Research context to help you review your own reasoning, not advice.' })}</div>
        </div>
      )}

      {loading ? (
        <div className="card p-8 grid place-items-center"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--accent)]" /></div>
      ) : list.length === 0 ? (
        <div className="card p-8 text-center text-[var(--fg-3)] text-sm">{t('theses.empty', { defaultValue: 'No theses yet. Capture your first one.' })}</div>
      ) : (
        <div className="space-y-2">
          {list.map((th) => (
            <div key={th.id} className="card p-4 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-medium text-[var(--fg-1)]">{th.title}</div>
                <div className="flex items-center gap-1.5">
                  {th.entity_id && (
                    <button onClick={() => { setReviewId(th.id); review.generate({ artifactType: 'thesis_review', entityId: th.entity_id, extra: { title: 'Thesis review', baseline: th.baseline_metrics, thesis: { bull_thesis: th.bull_thesis, bear_thesis: th.bear_thesis, neutral_thesis: th.neutral_thesis, what_would_confirm: th.what_would_confirm, what_would_invalidate: th.what_would_invalidate } } }) }} disabled={review.loading && reviewId === th.id} className="btn btn--quiet btn--sm">
                      {review.loading && reviewId === th.id ? <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-current" /> : <><Sparkles className="h-4 w-4" /> {t('theses.review', { defaultValue: 'Review' })}</>}
                    </button>
                  )}
                  <button onClick={() => deleteThesis(supabase, th.id).then(load)} className="p-1.5 rounded-lg text-[var(--fg-4)] hover:text-red-400"><Trash2 className="h-4 w-4" /></button>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <div className="text-[11px] text-[var(--fg-4)]">{th.thesis_date}</div>
                {th.drift_state && (
                  <span className={`chip text-[10px] ${th.drift_state === 'supports' ? 'chip--ok' : th.drift_state === 'weakens' ? 'chip--err' : ''}`}
                    title={t('theses.drift_tip', { defaultValue: 'Deterministic comparison of current stored signals vs your thesis. Research context, not advice.' })}>
                    {t(`theses.drift_chip_${th.drift_state}`, { defaultValue: th.drift_state === 'supports' ? 'Data currently supports' : th.drift_state === 'weakens' ? 'Data currently weakens' : th.drift_state === 'no_effect' ? 'No material effect' : 'Drift unknown' })}
                  </span>
                )}
                {Array.isArray(th.drift_detail?.drivers) && th.drift_detail.drivers.slice(0, 2).map((d, i) => <span key={i} className="chip text-[9px] text-[var(--fg-4)]">{d}</span>)}
              </div>
              <div className="grid gap-2 sm:grid-cols-3 text-[12px]">
                {th.bull_thesis && <div><b className="text-[var(--ok)]">Bull:</b> <span className="text-[var(--fg-3)]">{th.bull_thesis}</span></div>}
                {th.neutral_thesis && <div><b className="text-[var(--fg-2)]">Neutral:</b> <span className="text-[var(--fg-3)]">{th.neutral_thesis}</span></div>}
                {th.bear_thesis && <div><b className="text-red-400">Bear:</b> <span className="text-[var(--fg-3)]">{th.bear_thesis}</span></div>}
              </div>
              {/* Suggested alert rules parsed from confirm/invalidate — created ONLY on accept */}
              {th.entity_id && Array.isArray(th.suggested_rules) && th.suggested_rules.length > 0 && (
                <div className="flex items-center gap-2 flex-wrap text-[12px] text-[var(--fg-3)]">
                  <span className="text-[var(--fg-5)]">{t('theses.suggested_alerts', { defaultValue: 'Suggested alerts from your conditions' })}:</span>
                  {th.suggested_rules.map((sr, i) => (
                    <button key={i} className="chip text-[11px] hover:bg-[var(--bg-2)]"
                      title={sr.phrase}
                      onClick={() => createAlertRule(supabase, org.id, user?.id, { entity_id: th.entity_id, trigger_type: sr.trigger_type, config: sr.config }).then(load).catch((e) => setErr(e.message))}>
                      + {t(`alerts.triggers.${sr.trigger_type}`, { defaultValue: sr.trigger_type.replace(/_/g, ' ') })}{sr.config?.threshold_pct ? ` ${sr.config.threshold_pct}%` : ''}
                    </button>
                  ))}
                </div>
              )}
              {reviewId === th.id && review.result && <ArtifactView result={review.result} loading={review.loading} onRefresh={() => review.refresh({ artifactType: 'thesis_review', entityId: th.entity_id, extra: { title: 'Thesis review', baseline: th.baseline_metrics, thesis: { bull_thesis: th.bull_thesis, bear_thesis: th.bear_thesis, neutral_thesis: th.neutral_thesis, what_would_confirm: th.what_would_confirm, what_would_invalidate: th.what_would_invalidate } } })} />}
            </div>
          ))}
        </div>
      )}

      <IntelDisclaimer variant="block" />
    </div>
  )
}
