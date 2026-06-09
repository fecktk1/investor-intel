import React, { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { NotebookPen, Plus, Trash2 } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { listTheses, createThesis, deleteThesis } from '../lib/intel-data'
import { resolveEntity } from '../lib/watchlist-api'
import { useArtifact } from '../lib/useArtifact'
import ArtifactView from '../components/ArtifactView'
import { CHAINS } from '../lib/chains'
import { Sparkles } from 'lucide-react'
import IntelDisclaimer from '../components/IntelDisclaimer'

const EMPTY = { title: '', bull_thesis: '', bear_thesis: '', neutral_thesis: '', what_would_confirm: '', what_would_invalidate: '' }

// P13 — Thesis Tracker. Captures bull/bear/neutral + confirm/invalidate + a
// baseline (so the post-launch drift worker can compare later).
export default function ThesisPage() {
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
            <label className="block flex-1 min-w-[180px]"><span className="text-[11px] text-[var(--fg-4)]">{t('theses.entity', { defaultValue: 'Token address (optional — enables drift review)' })}</span>
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
              <div className="text-[11px] text-[var(--fg-4)]">{th.thesis_date}</div>
              <div className="grid gap-2 sm:grid-cols-3 text-[12px]">
                {th.bull_thesis && <div><b className="text-[var(--ok)]">Bull:</b> <span className="text-[var(--fg-3)]">{th.bull_thesis}</span></div>}
                {th.neutral_thesis && <div><b className="text-[var(--fg-2)]">Neutral:</b> <span className="text-[var(--fg-3)]">{th.neutral_thesis}</span></div>}
                {th.bear_thesis && <div><b className="text-red-400">Bear:</b> <span className="text-[var(--fg-3)]">{th.bear_thesis}</span></div>}
              </div>
              {reviewId === th.id && review.result && <ArtifactView result={review.result} loading={review.loading} />}
            </div>
          ))}
        </div>
      )}

      <IntelDisclaimer variant="block" />
    </div>
  )
}
