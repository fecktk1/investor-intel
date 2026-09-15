import React, { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

const STATUSES = ['active', 'strengthening', 'weakening', 'confirmed', 'partially_confirmed', 'invalidated', 'closed']

// Compose a thesis review: a note + optional conviction/status change. The user is
// always the author of the conclusion (status_source stays 'user').
export default function ReviewComposer({ thesis, onSubmit, busy }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const [note, setNote] = useState('')
  const [newStatus, setNewStatus] = useState('')
  const [newConv, setNewConv] = useState('')
  const pendingOperation = useRef(null)

  const submit = async () => {
    if (!note.trim() && !newStatus && !newConv) return
    const signature = JSON.stringify([note, newStatus, newConv])
    if (pendingOperation.current?.signature !== signature) pendingOperation.current = { signature, id: crypto.randomUUID() }
    const saved = await onSubmit({
      idempotency_key: pendingOperation.current.id,
      review_kind: 'manual',
      note: note.trim() || null,
      prev_status: thesis?.status || null,
      new_status: newStatus || null,
      prev_conviction: thesis?.conviction ?? null,
      new_conviction: newConv === '' ? null : Number(newConv) / 5,
    })
    if (saved === false) return
    pendingOperation.current = null
    setNote(''); setNewStatus(''); setNewConv('')
  }

  return (
    <div className="card p-3 space-y-2">
      <div className="eyebrow">{t('journal.add_review', { defaultValue: 'Add a review' })}</div>
      <textarea className="textarea w-full" rows={2} placeholder={t('journal.review_ph', { defaultValue: 'What changed? What still supports or weakens the thesis?' })} value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="flex items-end gap-2 flex-wrap">
        <label className="block"><span className="text-[10px] text-[var(--fg-4)]">{t('journal.new_status', { defaultValue: 'Update status' })}</span>
          <select className="select" value={newStatus} onChange={(e) => setNewStatus(e.target.value)}>
            <option value="">{t('journal.no_change', { defaultValue: 'No change' })}</option>
            {STATUSES.map((s) => <option key={s} value={s}>{t(`journal.status.${s}`, { defaultValue: s })}</option>)}
          </select>
        </label>
        <label className="block"><span className="text-[10px] text-[var(--fg-4)]">{t('journal.new_conviction', { defaultValue: 'Conviction (1-5)' })}</span>
          <input type="number" min="1" max="5" className="input w-20" value={newConv} onChange={(e) => setNewConv(e.target.value)} /></label>
        <button onClick={submit} disabled={busy} className="btn btn--primary btn--sm disabled:opacity-50">{t('journal.save_review', { defaultValue: 'Save review' })}</button>
      </div>
    </div>
  )
}
