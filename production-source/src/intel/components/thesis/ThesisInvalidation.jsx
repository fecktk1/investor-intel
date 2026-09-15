import ChartAlertEditor from '../ChartAlertEditor'
import { useSupabase } from '../../../lib/useSupabase'
import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { hasInvalidationCondition } from '../../lib/thesis-activation'

export default function ThesisInvalidation({ thesis, editable, onSave }) {
  const {supabase,user}=useSupabase()
  const { t } = useTranslation('intel', { useSuspense: false })
  const [text, setText] = useState(thesis.what_would_invalidate || '')
  const [editing, setEditing] = useState(false), [error, setError] = useState(null), [busy, setBusy] = useState(false)
  useEffect(() => { setText(thesis.what_would_invalidate || ''); setEditing(false); setError(null) }, [thesis.id, thesis.what_would_invalidate])
  const incomplete = !hasInvalidationCondition(thesis.what_would_invalidate)
  const save = async event => {
    event.preventDefault(); if (!editable) return
    if (thesis.status !== 'draft' && !hasInvalidationCondition(text)) { setError(t('journal.invalidated_if_required', { defaultValue: 'Describe a specific condition of at least 12 characters.' })); return }
    setBusy(true); setError(null)
    try { await onSave({ what_would_invalidate: text }); setEditing(false) } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  return <section className="border-y border-[var(--border-default)] py-4 space-y-3" aria-label={t('journal.invalidated_if', { defaultValue: 'Invalidated if' })}>
    <div className="flex justify-between items-center gap-3"><h2>{t('journal.invalidated_if', { defaultValue: 'Invalidated if' })}</h2>{editable && !editing && <button className="btn btn--quiet btn--sm" onClick={() => setEditing(true)}>{t('journal.edit_condition', { defaultValue: 'Edit condition' })}</button>}</div>
    {incomplete && <p role="status">{thesis.status === 'draft' ? t('journal.draft_condition', { defaultValue: 'Draft — add an invalidation condition before activation.' }) : t('journal.legacy_condition', { defaultValue: 'Review needed — this existing thesis has no specific invalidation condition. Its original history is preserved.' })}</p>}
    {editing ? <form onSubmit={save} className="space-y-2"><label className="block"><span>{t('journal.invalidated_if', { defaultValue: 'Invalidated if' })}</span><textarea className="textarea w-full" rows={3} value={text} onChange={e => setText(e.target.value)} maxLength={16000}/></label>{error && <p role="alert">{error}</p>}<div className="flex gap-2"><button className="btn btn--primary" disabled={busy}>{t('common.save', { defaultValue: 'Save' })}</button><button type="button" className="btn btn--quiet" onClick={() => { setText(thesis.what_would_invalidate || ''); setEditing(false) }}>{t('common.cancel', { defaultValue: 'Cancel' })}</button></div></form> : <p className="whitespace-pre-wrap">{thesis.what_would_invalidate}</p>}
    {editable && !incomplete && thesis.subject_canonical_key && <ChartAlertEditor context={{supabase,userId:user?.id,orgId:thesis.org_id,asset:thesis.subject_canonical_key}} label="Draft a price-crossing alert" draftOnly initialDraft={{title:`Invalidation: ${thesis.title}`.slice(0,120),note:thesis.what_would_invalidate.length<1800?`Thesis ${thesis.id}\n${thesis.what_would_invalidate}`:`Review the original invalidation condition in thesis ${thesis.id}.`}}/>}
    <p className="text-xs text-[var(--fg-4)]">{t('journal.manual_condition', { defaultValue: 'This text is reviewed manually. Automation requires a separately reviewed, supported structured rule.' })}</p>
  </section>
}
