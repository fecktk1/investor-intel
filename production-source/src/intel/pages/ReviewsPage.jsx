import React, { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { CalendarCheck } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { listTheses } from '../lib/thesis-api'
import ThesisStatusBadge from '../components/thesis/ThesisStatusBadge'
import IntelDisclaimer from '../components/IntelDisclaimer'

// Cross-thesis review queue: what's due, what the engine flagged. Per-thesis review
// history + composer live on each thesis's Reviews tab.
const fmtDate = (d) => d ? new Date(d).toLocaleDateString() : '—'

export default function ReviewsPage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase } = useSupabase()
  const [list, setList] = useState([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!org?.id) return
    setLoading(true)
    try { setList(await listTheses(supabase, org.id)) } catch { /* surfaced elsewhere */ } finally { setLoading(false) }
  }, [org?.id, supabase])
  useEffect(() => { load() }, [load])

  const now = Date.now()
  const due = list.filter((th) => !['archived', 'closed'].includes(th.status) &&
    (th.needs_user_review || (th.next_review_at && new Date(th.next_review_at).getTime() < now)))
  const upcoming = list.filter((th) => !due.includes(th) && !['archived', 'closed'].includes(th.status) && th.next_review_at)
    .sort((a, b) => new Date(a.next_review_at) - new Date(b.next_review_at)).slice(0, 10)

  const Row = ({ th, showEngine }) => (
    <Link to={`/intel/theses/${th.id}?tab=reviews`} className="card p-3 flex items-center justify-between gap-2 hover:border-[var(--accent)] transition-colors">
      <div className="min-w-0">
        <div className="text-[13px] text-[var(--fg-1)] truncate">{th.title}</div>
        <div className="text-[11px] text-[var(--fg-4)]">{t('journal.next_review', { defaultValue: 'Next review' })} {fmtDate(th.next_review_at)}</div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {showEngine && th.engine_suggested_status && <span className="text-[11px] text-amber-300">{t(`journal.status.${th.engine_suggested_status}`, { defaultValue: th.engine_suggested_status })}</span>}
        <ThesisStatusBadge status={th.status} />
      </div>
    </Link>
  )

  return (
    <div className="space-y-4">
      <div>
        <div className="eyebrow flex items-center gap-1.5"><CalendarCheck className="h-3.5 w-3.5" /> {t('journal.brand', { defaultValue: 'Thesis Journal' })}</div>
        <h1 className="page-title">{t('journal.nav.reviews', { defaultValue: 'Reviews' })}</h1>
        <p className="page-sub">{t('journal.reviews_sub', { defaultValue: 'Theses due for review and your review history.' })}</p>
      </div>

      {loading ? (
        <div className="card p-8 grid place-items-center"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--accent)]" /></div>
      ) : (
        <>
          <div className="space-y-2">
            <div className="eyebrow">{t('journal.due_now', { defaultValue: 'Due now' })} ({due.length})</div>
            {due.length === 0 ? <div className="card--flat p-3 text-[12px] text-[var(--ok)]">{t('journal.nothing_due', { defaultValue: 'Nothing due — all theses are current.' })}</div> : due.map((th) => <Row key={th.id} th={th} showEngine />)}
          </div>
          {upcoming.length > 0 && (
            <div className="space-y-2">
              <div className="eyebrow">{t('journal.upcoming', { defaultValue: 'Upcoming' })}</div>
              {upcoming.map((th) => <Row key={th.id} th={th} />)}
            </div>
          )}
        </>
      )}
      <IntelDisclaimer variant="block" />
    </div>
  )
}
