import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { THESIS_DRAFT_FIELDS, thesisDraftPayload } from '../../lib/thesis-draft'

export default function ThesisAuthoredDraft({ thesis, onSave, editable = false }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(() => thesisDraftPayload(thesis.authored_draft))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  useEffect(() => { setDraft(thesisDraftPayload(thesis.authored_draft)); setEditing(false); setError(null) }, [thesis.id, thesis.authored_draft, editable])
  const save = async event => {
    event.preventDefault(); if (!editable) return; setSaving(true); setError(null)
    try { await onSave({ authored_draft: thesisDraftPayload(draft) }); setEditing(false) }
    catch (e) { setError(e.message) }
    finally { setSaving(false) }
  }
  return <section className="border-y border-[var(--border-default)] py-4 space-y-4" aria-label={t('journal.authored.title', { defaultValue: 'Your reasoning' })}>
    <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-medium">{t('journal.authored.title', { defaultValue: 'Your reasoning' })}</h2>
      {editable && !editing && <button className="btn btn--quiet btn--sm" onClick={() => setEditing(true)}>{t('journal.authored.edit', { defaultValue: 'Edit reasoning' })}</button>}
    </div>
    {editing && editable ? <form onSubmit={save} className="space-y-4">
      <div className="grid gap-x-6 gap-y-4 md:grid-cols-2">{THESIS_DRAFT_FIELDS.map(([key, label]) => <label key={key} className={key === 'statement' ? 'md:col-span-2 space-y-1' : 'space-y-1'}>
        <span className="block text-sm text-[var(--fg-3)]">{t(`journal.authored.${key}`, { defaultValue: label })}</span>
        <textarea className="input w-full min-h-24" value={draft[key]} maxLength={16000} disabled={saving} onChange={e => setDraft(current => ({ ...current, [key]: e.target.value }))}/>
      </label>)}</div>
      {error && <p role="alert" className="text-sm text-[var(--signal-red)]">{error}</p>}
      <div className="flex gap-2"><button className="btn btn--primary" disabled={saving}>{t('journal.authored.save', { defaultValue: 'Save reasoning' })}</button><button type="button" className="btn btn--quiet" disabled={saving} onClick={() => { setDraft(thesisDraftPayload(thesis.authored_draft)); setEditing(false) }}>{t('common.cancel', { defaultValue: 'Cancel' })}</button></div>
    </form> : <dl className="grid gap-x-6 gap-y-4 md:grid-cols-2">{THESIS_DRAFT_FIELDS.filter(([key]) => draft[key]).map(([key, label]) => <div key={key} className={key === 'statement' ? 'md:col-span-2' : ''}><dt className="text-xs text-[var(--fg-4)]">{t(`journal.authored.${key}`, { defaultValue: label })}</dt><dd className="mt-1 text-sm whitespace-pre-wrap break-words">{draft[key]}</dd></div>)}
      {!Object.values(draft).some(Boolean) && <p className="text-sm text-[var(--fg-4)]">{t('journal.authored.empty', { defaultValue: 'No authored reasoning was saved for this thesis.' })}</p>}
    </dl>}
  </section>
}
