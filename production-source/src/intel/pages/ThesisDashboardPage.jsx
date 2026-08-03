import React, { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import { LayoutDashboard } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { listTheses } from '../lib/thesis-api'
import ThesisStatusBadge from '../components/thesis/ThesisStatusBadge'
import ThesisEmptyState from '../components/thesis/ThesisEmptyState'
import IntelDisclaimer from '../components/IntelDisclaimer'

// Dashboard rollup. E7 enriches this with since-creation deltas and conflict
// surfacing; E0 ships the status rollup + needs-review queue + recent theses.
export default function ThesisDashboardPage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase } = useSupabase()
  const [list, setList] = useState([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!org?.id) return
    setLoading(true)
    try { setList(await listTheses(supabase, org.id)) } catch { /* surfaced on list page */ } finally { setLoading(false) }
  }, [org?.id, supabase])
  useEffect(() => { load() }, [load])

  if (loading) return <div className="card p-8 grid place-items-center"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--accent)]" /></div>
  if (!list.length) return <ThesisEmptyState />

  const needsReview = list.filter((th) => th.needs_user_review || th.status === 'needs_review')
  const counts = list.reduce((a, th) => { a[th.status] = (a[th.status] || 0) + 1; return a }, {})
  const recent = list.slice(0, 6)

  return (
    <div className="space-y-4">
      <div>
        <div className="eyebrow flex items-center gap-1.5"><LayoutDashboard className="h-3.5 w-3.5" /> {t('journal.brand', { defaultValue: 'Thesis Journal' })}</div>
        <h1 className="page-title">{t('journal.nav.dashboard', { defaultValue: 'Dashboard' })}</h1>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <div className="card p-3"><div className="text-[11px] text-[var(--fg-4)]">{t('journal.total', { defaultValue: 'Total' })}</div><div className="text-xl font-semibold text-[var(--fg-1)]">{list.length}</div></div>
        <div className="card p-3"><div className="text-[11px] text-[var(--fg-4)]">{t('journal.status.active', { defaultValue: 'Active' })}</div><div className="text-xl font-semibold text-[var(--fg-1)]">{counts.active || 0}</div></div>
        <div className="card p-3"><div className="text-[11px] text-[var(--fg-4)]">{t('journal.status.needs_review', { defaultValue: 'Needs review' })}</div><div className="text-xl font-semibold text-amber-300">{needsReview.length}</div></div>
        <div className="card p-3"><div className="text-[11px] text-[var(--fg-4)]">{t('journal.status.confirmed', { defaultValue: 'Confirmed' })}</div><div className="text-xl font-semibold text-[var(--ok)]">{(counts.confirmed || 0) + (counts.partially_confirmed || 0)}</div></div>
      </div>

      {needsReview.length > 0 && (
        <div className="card--flat p-3 border-l-2 border-amber-400 space-y-1">
          <div className="eyebrow">{t('journal.needs_review_q', { defaultValue: 'Needs your review' })}</div>
          {needsReview.slice(0, 5).map((th) => (
            <Link key={th.id} to={`/intel/theses/${th.id}`} className="flex items-center justify-between text-[12px] hover:text-[var(--accent)]">
              <span className="text-[var(--fg-2)]">{th.title}</span>
              {th.engine_suggested_status && <span className="text-[var(--fg-4)]">{t(`journal.status.${th.engine_suggested_status}`, { defaultValue: th.engine_suggested_status })}</span>}
            </Link>
          ))}
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="eyebrow">{t('journal.recent', { defaultValue: 'Recent theses' })}</div>
          <Link to="/intel/theses/list" className="text-[12px] text-[var(--accent)]">{t('journal.view_all', { defaultValue: 'View all' })}</Link>
        </div>
        {recent.map((th) => (
          <Link key={th.id} to={`/intel/theses/${th.id}`} className="card p-3 flex items-center justify-between gap-2 hover:border-[var(--accent)] transition-colors">
            <span className="text-[13px] text-[var(--fg-1)]">{th.title}</span>
            <ThesisStatusBadge status={th.status} />
          </Link>
        ))}
      </div>

      <IntelDisclaimer variant="block" />
    </div>
  )
}
