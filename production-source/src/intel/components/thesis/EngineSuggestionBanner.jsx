import React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import ThesisStatusBadge from './ThesisStatusBadge'

// Surfaces the engine's SUGGESTION without ever changing the user's conclusion.
// The badge stays user-authoritative; this banner makes the warning impossible to
// miss and hands the decision back to the user.
export default function EngineSuggestionBanner({ thesis, onResolve, busy }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  if (!thesis?.needs_user_review || !thesis?.engine_suggested_status) return null
  const drivers = Array.isArray(thesis.status_reason?.drivers) ? thesis.status_reason.drivers : []
  const suggested = thesis.engine_suggested_status

  return (
    <div className="card--flat p-3 border-l-2 border-amber-400 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <AlertTriangle className="h-4 w-4 text-amber-400" />
        <span className="text-[12px] text-[var(--fg-2)]">{t('journal.engine_signal', { defaultValue: 'Engine signal' })}:</span>
        <ThesisStatusBadge status={suggested} />
        <span className="text-[12px] text-[var(--fg-4)]">{t('journal.review_suggested', { defaultValue: 'review suggested' })}</span>
      </div>
      {drivers.length > 0 && <div className="text-[11px] text-[var(--fg-4)]">{t('journal.reason', { defaultValue: 'Reason' })}: {drivers.join(' · ')}</div>}
      <div className="flex items-center gap-1.5 flex-wrap">
        <button disabled={busy} onClick={() => onResolve('accept')} className="btn btn--quiet btn--sm disabled:opacity-50">
          {t('journal.mark_as', { defaultValue: 'Mark' })} {t(`journal.status.${suggested}`, { defaultValue: suggested })}
        </button>
        <button disabled={busy} onClick={() => onResolve('keep')} className="btn btn--quiet btn--sm disabled:opacity-50">{t('journal.keep_active', { defaultValue: 'Keep as is' })}</button>
        <button disabled={busy} onClick={() => onResolve('revise')} className="btn btn--quiet btn--sm disabled:opacity-50">{t('journal.revise', { defaultValue: 'Revise thesis' })}</button>
      </div>
      <div className="text-[10px] text-[var(--fg-5)]">{t('journal.engine_note', { defaultValue: 'The app never changes your conclusion. It only flags what your own criteria suggest.' })}</div>
    </div>
  )
}
