import React from 'react'
import { useTranslation } from 'react-i18next'

// Living thesis status badge. status is USER-authoritative; the engine only
// SUGGESTS (engine_suggested_status + needs_user_review), surfaced as a separate
// hint, never by silently flipping this badge. Mirrors the chip styling used by
// ThesisDriftCard (chip--ok / chip--err / neutral).
const STATUS_CLS = {
  draft: 'text-[var(--fg-4)]',
  active: 'chip--info',
  strengthening: 'chip--ok',
  weakening: 'chip--err',
  needs_review: 'text-amber-300',
  confirmed: 'chip--ok',
  partially_confirmed: 'chip--ok',
  invalidated: 'chip--err',
  closed: 'text-[var(--fg-4)]',
  archived: 'text-[var(--fg-5)]',
}
const STATUS_LABEL = {
  draft: 'Draft',
  active: 'Active',
  strengthening: 'Strengthening',
  weakening: 'Weakening',
  needs_review: 'Needs review',
  confirmed: 'Confirmed',
  partially_confirmed: 'Partially confirmed',
  invalidated: 'Invalidated',
  closed: 'Closed',
  archived: 'Archived',
}

export default function ThesisStatusBadge({ status, size = '11', className = '' }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const key = STATUS_LABEL[status] ? status : 'active'
  return (
    <span className={`chip text-[${size}px] ${STATUS_CLS[key] || ''} ${className}`}>
      {t(`journal.status.${key}`, { defaultValue: STATUS_LABEL[key] })}
    </span>
  )
}
