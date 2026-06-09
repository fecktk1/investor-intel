import React, { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Newspaper, Sparkles } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { useArtifact } from '../lib/useArtifact'
import { listBriefs, upsertBrief } from '../lib/intel-data'
import { listWatchlist } from '../lib/watchlist-api'
import ArtifactView from '../components/ArtifactView'
import IntelDisclaimer from '../components/IntelDisclaimer'

// P9 — Daily Investor Brief (in-app). On-demand generation now; a scheduled
// worker job per workspace is the production cadence path.
export default function BriefsPage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase } = useSupabase()
  const [briefs, setBriefs] = useState([])
  const [loading, setLoading] = useState(true)
  const brief = useArtifact()

  const load = useCallback(async () => {
    if (!org?.id) return
    setLoading(true)
    try { setBriefs(await listBriefs(supabase, org.id)) } catch { /* ignore */ } finally { setLoading(false) }
  }, [org?.id, supabase])
  useEffect(() => { load() }, [load])

  const generate = useCallback(async () => {
    if (!org?.id) return
    const items = await listWatchlist(supabase, org.id).catch(() => [])
    const res = await brief.generate({
      artifactType: 'daily_brief', staleMinutes: 720,
      extra: { title: t('briefs.today', { defaultValue: "Today's brief" }) },
      context: { watchlist: items.map((i) => ({ type: i.item_type, ref: i.entity?.canonical_ref_key, label: i.label || i.entity?.display_symbol })) },
    })
    if (res?.artifact) { await upsertBrief(supabase, org.id, { briefType: 'daily', artifactId: res.artifact.id }).catch(() => {}); load() }
  }, [org?.id, supabase, brief, t, load])

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="eyebrow flex items-center gap-1.5"><Newspaper className="h-3.5 w-3.5" /> {t('brand.name', { defaultValue: 'Investor Intel' })}</div>
          <h1 className="page-title">{t('nav.briefs', { defaultValue: 'Daily Brief' })}</h1>
          <p className="page-sub">{t('pages.briefs_sub', { defaultValue: 'Your personalized daily investor brief.' })}</p>
        </div>
        <button onClick={generate} disabled={brief.loading} className="btn btn--primary btn--sm disabled:opacity-50">
          {brief.loading ? <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-current" /> : <><Sparkles className="h-4 w-4" /> {t('briefs.generate', { defaultValue: "Generate today's brief" })}</>}
        </button>
      </div>

      {brief.result && <ArtifactView result={brief.result} loading={brief.loading} />}
      {brief.error && <div className="card--flat p-3 text-[13px] text-red-400">{brief.error}</div>}

      {loading ? (
        <div className="card p-8 grid place-items-center"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--accent)]" /></div>
      ) : briefs.length === 0 ? (
        <div className="card p-8 text-center text-[var(--fg-3)] text-sm">{t('briefs.empty', { defaultValue: 'No briefs yet. Generate your first one above.' })}</div>
      ) : (
        <div className="space-y-2">
          {briefs.map((b) => (
            <div key={b.id} className="card p-3">
              <div className="flex items-center justify-between">
                <span className="text-[12px] text-[var(--fg-4)]">{b.period_date} · {b.brief_type}</span>
              </div>
              {b.artifact?.structured?.summary && <p className="text-[13px] text-[var(--fg-2)] mt-1 line-clamp-3">{b.artifact.structured.summary}</p>}
            </div>
          ))}
        </div>
      )}

      <IntelDisclaimer variant="block" />
    </div>
  )
}
