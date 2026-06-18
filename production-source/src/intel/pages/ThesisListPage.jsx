import React, { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { NotebookPen } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { listTheses } from '../lib/thesis-api'
import ThesisStatusBadge from '../components/thesis/ThesisStatusBadge'
import ThesisEmptyState from '../components/thesis/ThesisEmptyState'
import IntelErrorNotice from '../components/IntelErrorNotice'

const STANCE_CLS = { bullish: 'text-[var(--ok)]', bearish: 'text-red-400', neutral: 'text-[var(--fg-3)]' }

export default function ThesisListPage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase } = useSupabase()
  const [list, setList] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [filter, setFilter] = useState('')

  const load = useCallback(async () => {
    if (!org?.id) return
    setLoading(true); setErr(null)
    try { setList(await listTheses(supabase, org.id)) }
    catch (e) { setErr(e.message) }
    finally { setLoading(false) }
  }, [org?.id, supabase])
  useEffect(() => { load() }, [load])

  const shown = filter ? list.filter((th) => th.status === filter) : list

  return (
    <div className="space-y-4">
      <div>
        <div className="eyebrow flex items-center gap-1.5"><NotebookPen className="h-3.5 w-3.5" /> {t('journal.brand', { defaultValue: 'Thesis Journal' })}</div>
        <h1 className="page-title">{t('journal.nav.theses', { defaultValue: 'Theses' })}</h1>
        <p className="page-sub">{t('journal.list_sub', { defaultValue: 'Every call you have made — with the evidence, baseline and review history behind it.' })}</p>
      </div>

      {err && <IntelErrorNotice error={err} />}

      {!loading && list.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {['', 'active', 'strengthening', 'weakening', 'needs_review', 'confirmed', 'invalidated', 'closed'].map((s) => (
            <button key={s || 'all'} onClick={() => setFilter(s)}
              className={`chip text-[11px] ${filter === s ? 'chip--active bg-[var(--accent)] text-black' : 'text-[var(--fg-4)]'}`}>
              {s ? t(`journal.status.${s}`, { defaultValue: s }) : t('journal.filter_all', { defaultValue: 'All' })}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="card p-8 grid place-items-center"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--accent)]" /></div>
      ) : list.length === 0 ? (
        <ThesisEmptyState />
      ) : (
        <div className="space-y-2">
          {shown.map((th) => (
            <Link key={th.id} to={`/intel/theses/${th.id}`} className="card p-4 block hover:border-[var(--accent)] transition-colors">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-medium text-[var(--fg-1)]">{th.title}</div>
                <div className="flex items-center gap-1.5">
                  {th.needs_user_review && <span className="chip text-[10px] text-amber-300">{t('journal.review_due', { defaultValue: 'Review' })}</span>}
                  <ThesisStatusBadge status={th.status} />
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap mt-1.5 text-[11px]">
                <span className={STANCE_CLS[th.stance] || 'text-[var(--fg-4)]'}>{th.stance || '—'}</span>
                <span className="text-[var(--fg-5)]">·</span>
                <span className="text-[var(--fg-4)]">{th.thesis_type || 'asset'}</span>
                {th.time_horizon && <><span className="text-[var(--fg-5)]">·</span><span className="text-[var(--fg-4)]">{th.time_horizon}</span></>}
                <span className="text-[var(--fg-5)]">·</span>
                <span className="text-[var(--fg-5)]">{th.thesis_date || (th.created_at || '').slice(0, 10)}</span>
                {typeof th.quality_score === 'number' && <><span className="text-[var(--fg-5)]">·</span><span className="text-[var(--fg-4)]">{t('journal.quality', { defaultValue: 'Quality' })} {th.quality_score}/100</span></>}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
