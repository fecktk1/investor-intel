import React, { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Bookmark, Trash2 } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { listSavedResearch, deleteSavedResearch } from '../lib/intel-data'
import ConfidenceChip from '../components/ConfidenceChip'
import IntelDisclaimer from '../components/IntelDisclaimer'

export default function SavedResearchPage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase } = useSupabase()
  const [list, setList] = useState([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!org?.id) return
    setLoading(true)
    try { setList(await listSavedResearch(supabase, org.id)) } catch { /* ignore */ } finally { setLoading(false) }
  }, [org?.id, supabase])
  useEffect(() => { load() }, [load])

  return (
    <div className="space-y-5">
      <div>
        <div className="eyebrow flex items-center gap-1.5"><Bookmark className="h-3.5 w-3.5" /> {t('brand.name', { defaultValue: 'Investor Intel' })}</div>
        <h1 className="page-title">{t('nav.research', { defaultValue: 'Saved Research' })}</h1>
        <p className="page-sub">{t('pages.research_sub', { defaultValue: 'Your saved breakdowns, briefs, comparisons and explanations.' })}</p>
      </div>

      {loading ? (
        <div className="card p-8 grid place-items-center"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--accent)]" /></div>
      ) : list.length === 0 ? (
        <div className="card p-8 text-center text-[var(--fg-3)] text-sm">{t('research.empty', { defaultValue: 'No saved research yet. Save a breakdown or brief to keep it here.' })}</div>
      ) : (
        <div className="space-y-2">
          {list.map((r) => {
            const a = r.artifact || {}
            const s = a.structured || r.snapshot || {}
            return (
              <div key={r.id} className="card p-4 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="chip chip--accent text-[10px] uppercase">{a.artifact_type || r.tags?.[0] || 'note'}</span>
                    <span className="text-sm text-[var(--fg-1)] truncate">{r.title || a.title}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {a.confidence && <ConfidenceChip value={a.confidence} />}
                    <button onClick={() => deleteSavedResearch(supabase, r.id).then(load)} className="p-1.5 rounded-lg text-[var(--fg-4)] hover:text-red-400"><Trash2 className="h-4 w-4" /></button>
                  </div>
                </div>
                {s.summary && <p className="text-[13px] text-[var(--fg-3)] line-clamp-4">{s.summary}</p>}
              </div>
            )
          })}
        </div>
      )}

      <IntelDisclaimer variant="block" />
    </div>
  )
}
