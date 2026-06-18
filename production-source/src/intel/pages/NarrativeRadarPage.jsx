import React, { useEffect, useMemo, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Radar, RefreshCw, Plus, Info } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import {
  loadNarratives, followNarrative, unfollowNarrative,
  mapOrCreateCustomNarrative, listCustomNarratives,
} from '../lib/narratives-api'
import { NARRATIVE_TABS, matchesTab } from '../lib/narrative-ui'
import NarrativeCard from '../components/NarrativeCard'
import NarrativeSummaryRow from '../components/NarrativeSummaryRow'
import IntelDisclaimer from '../components/IntelDisclaimer'
import IntelErrorNotice from '../components/IntelErrorNotice'
import RelevantSignals from '../components/RelevantSignals'
import { markSurfaceSeen } from '../lib/changes-api'
import { IntelEmptyState, IntelHeroRead, IntelPageHeader, IntelPageShell, IntelSkeleton, IntelTabs } from '../components/IntelPrimitives'

// Narrative Radar — AUTOMATIC discovery by default. A new user opens this page and
// immediately sees which narratives are heating up / cooling / early / crowded /
// bullish / high-risk — no manual input. Custom (manual) narratives are demoted to
// an advanced tab that maps to a global narrative first.
export default function NarrativeRadarPage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase } = useSupabase()
  const navigate = useNavigate()

  const [data, setData] = useState({ narratives: [], summary: {}, count: 0 })
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [err, setErr] = useState(null)
  const [tab, setTab] = useState('all')
  const [chain, setChain] = useState('')
  const [category, setCategory] = useState('')
  const [followBusy, setFollowBusy] = useState(null)
  const [followErr, setFollowErr] = useState(null)

  const load = useCallback(async (soft = false) => {
    if (!org?.id) return
    soft ? setRefreshing(true) : setLoading(true); setErr(null)
    try { setData(await loadNarratives(supabase, org.id)) }
    catch (e) { setErr(e.message) }
    finally { setLoading(false); setRefreshing(false) }
  }, [org?.id, supabase])
  useEffect(() => { load() }, [load])
  useEffect(() => () => { if (org?.id) markSurfaceSeen(supabase, 'narratives') }, [org?.id, supabase])

  const onOpen = useCallback((slug) => navigate(`/intel/narratives/${slug}`), [navigate])
  const onFollow = useCallback(async (slug, next) => {
    setFollowBusy(slug)
    setFollowErr(null)
    // optimistic
    setData((d) => ({ ...d, narratives: d.narratives.map((n) => n.slug === slug ? { ...n, is_followed: next } : n) }))
    try { next ? await followNarrative(supabase, slug) : await unfollowNarrative(supabase, slug) }
    catch (e) {
      setData((d) => ({ ...d, narratives: d.narratives.map((n) => n.slug === slug ? { ...n, is_followed: !next } : n) }))
      // Surface intel_limit_reached:narrative_follows with the upgrade link.
      setFollowErr(e?.message || '')
    }
    finally { setFollowBusy(null) }
  }, [supabase])

  const chains = useMemo(() => {
    const s = new Set()
    for (const n of data.narratives) for (const c of (n.related_chains || n.chains || [])) s.add(c)
    return [...s].sort()
  }, [data.narratives])
  const categories = useMemo(() => [...new Set(data.narratives.map((n) => n.parent_category).filter(Boolean))].sort(), [data.narratives])

  const filtered = useMemo(() => {
    return data.narratives.filter((n) => matchesTab(n, tab)
      && (!chain || (n.related_chains || n.chains || []).includes(chain))
      && (!category || n.parent_category === category))
  }, [data.narratives, tab, chain, category])
  const totalCount = data.count || data.narratives.length
  const followedCount = data.narratives.filter((n) => n.is_followed).length

  return (
    <IntelPageShell>
      <IntelPageHeader
        icon={Radar}
        eyebrow={t('brand.name', { defaultValue: 'Investor Intel' })}
        title={t('nav.narratives', { defaultValue: 'Narrative Radar' })}
        subtitle={t('pages.narratives_sub', { defaultValue: 'Which crypto narratives are heating up, cooling, early, crowded, bullish or high-risk - detected automatically.' })}
        actions={(
          <button onClick={() => load(true)} disabled={refreshing} className="btn btn--quiet btn--sm flex-shrink-0">
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} /> {t('common.refresh', { defaultValue: 'Refresh' })}
          </button>
        )}
      />

      <IntelHeroRead
        eyebrow={t('narratives.radar_read', { defaultValue: 'Narrative read' })}
        title={totalCount
          ? t('narratives.radar_title', { defaultValue: `${filtered.length.toLocaleString()} narratives in view` })
          : t('narratives.radar_title_empty', { defaultValue: 'Automatic discovery is ready for the next refresh' })}
        body={t('narratives.radar_body', { defaultValue: 'Start with the stage tabs, then narrow by category or chain. Personalized labels remain on cards when a narrative touches your watchlist, portfolio, or followed interests.' })}
        meta={[
          { label: t('narratives.total', { defaultValue: 'Tracked' }), value: totalCount.toLocaleString() },
          { label: t('narratives.filtered', { defaultValue: 'Visible' }), value: filtered.length.toLocaleString() },
          { label: t('narratives.followed', { defaultValue: 'Followed' }), value: followedCount.toLocaleString() },
          { label: t('narratives.filters', { defaultValue: 'Filters' }), value: [category, chain].filter(Boolean).length || t('common.none', { defaultValue: 'None' }) },
        ]}
      />

      <div className="hidden">
        <div>
          <div className="eyebrow flex items-center gap-1.5"><Radar className="h-3.5 w-3.5" /> {t('brand.name', { defaultValue: 'Investor Intel' })}</div>
          <h1 className="page-title">{t('nav.narratives', { defaultValue: 'Narrative Radar' })}</h1>
          <p className="page-sub">{t('pages.narratives_sub', { defaultValue: 'Which crypto narratives are heating up, cooling, early, crowded, bullish or high-risk — detected automatically.' })}</p>
        </div>
        <button onClick={() => load(true)} disabled={refreshing} className="btn btn--quiet btn--sm flex-shrink-0">
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} /> {t('common.refresh', { defaultValue: 'Refresh' })}
        </button>
      </div>

      {tab !== 'custom' && <NarrativeSummaryRow summary={data.summary} onPick={setTab} />}

      {/* tabs */}
      <div className="flex items-start gap-3 flex-wrap">
        <IntelTabs
          items={NARRATIVE_TABS}
          value={tab}
          onChange={setTab}
          getLabel={(tb) => t(`narratives.tab.${tb.key}`, { defaultValue: tb.label })}
        />
        {tab !== 'custom' && (chains.length > 0 || categories.length > 0) && (
          <div className="flex items-center gap-1.5 ml-auto">
            <select value={category} onChange={(e) => setCategory(e.target.value)} className="input input--sm text-[11px]">
              <option value="">{t('narratives.all_categories', { defaultValue: 'All categories' })}</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <select value={chain} onChange={(e) => setChain(e.target.value)} className="input input--sm text-[11px]">
              <option value="">{t('narratives.all_chains', { defaultValue: 'All chains' })}</option>
              {chains.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        )}
      </div>

      {err && <div className="card--flat p-3 text-[13px] text-amber-400 flex items-center gap-2"><Info className="h-4 w-4" /> {t('narratives.degraded', { defaultValue: 'Some data is unavailable right now — showing what we have.' })}</div>}
      <IntelErrorNotice error={followErr} />

      {tab === 'custom' ? (
        <CustomNarratives onOpen={onOpen} />
      ) : loading ? (
        <div className="grid sm:grid-cols-2 gap-3">{Array.from({ length: 6 }).map((_, i) => <IntelSkeleton key={i} className="h-44" />)}</div>
      ) : filtered.length === 0 ? (
        <IntelEmptyState title={t('narratives.none_in_filter', { defaultValue: 'No narratives match this filter right now. Try another tab.' })} />
      ) : (
        <div className="grid sm:grid-cols-2 gap-3">
          {filtered.map((n) => <NarrativeCard key={n.slug} n={n} onOpen={onOpen} onFollow={onFollow} busy={followBusy === n.slug} />)}
        </div>
      )}

      <RelevantSignals title={t('narratives.relevant_signals', { defaultValue: 'Signals relevant to you' })} seeAllHref="/intel" />

      <IntelDisclaimer variant="block" />
    </IntelPageShell>
  )
}

// ── Advanced: Custom (manual) narratives. Maps to a global narrative FIRST. ──
function CustomNarratives({ onOpen }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase } = useSupabase()
  const [title, setTitle] = useState('')
  const [list, setList] = useState([])
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState(null)

  const load = useCallback(async () => { if (org?.id) setList(await listCustomNarratives(supabase, org.id)) }, [org?.id, supabase])
  useEffect(() => { load() }, [load])

  const add = useCallback(async (e) => {
    e.preventDefault()
    if (!title.trim() || !org?.id) return
    setBusy(true); setNote(null)
    try {
      const res = await mapOrCreateCustomNarrative(supabase, org.id, title.trim())
      if (res.mapped) { setNote({ kind: 'mapped', slug: res.slug, name: res.name }) }
      else { setNote({ kind: 'created' }); await load() }
      setTitle('')
    } catch (ex) { setNote({ kind: 'error', msg: ex.message }) }
    finally { setBusy(false) }
  }, [title, org?.id, supabase, load])

  return (
    <div className="space-y-4">
      <div className="card--flat p-3 text-[12px] text-[var(--fg-3)] flex items-start gap-2">
        <Info className="h-4 w-4 flex-shrink-0 mt-0.5" />
        {t('narratives.custom_hint', { defaultValue: 'Advanced. Most narratives are detected automatically — search those first. Creating a custom narrative tries to map your idea to an existing one before creating a private one.' })}
      </div>
      <form onSubmit={add} className="card p-4 flex flex-wrap items-end gap-3">
        <label className="block flex-1 min-w-[200px]">
          <span className="text-[11px] text-[var(--fg-4)]">{t('narratives.add_label', { defaultValue: 'Track a custom narrative' })}</span>
          <input className="input w-full" placeholder={t('narratives.ph', { defaultValue: 'e.g. AI agents, RWAs, Solana DeFi' })} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <button type="submit" className="btn btn--primary" disabled={busy || !title.trim()}>
          {busy ? <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-current" /> : <><Plus className="h-4 w-4" /> {t('watchlist.add', { defaultValue: 'Add' })}</>}
        </button>
      </form>

      {note?.kind === 'mapped' && (
        <div className="card--flat p-3 text-[13px] flex items-center justify-between gap-2">
          <span className="text-[var(--fg-2)]">{t('narratives.mapped_to', { defaultValue: 'That maps to an existing narrative' })}: <b>{note.name}</b></span>
          <button onClick={() => onOpen(note.slug)} className="btn btn--quiet btn--sm">{t('narratives.open', { defaultValue: 'Open' })}</button>
        </div>
      )}
      {note?.kind === 'created' && <div className="card--flat p-3 text-[13px] text-[var(--ok)]">{t('narratives.created_private', { defaultValue: 'Created a private custom narrative.' })}</div>}
      {note?.kind === 'error' && <div className="card--flat p-3 text-[13px] text-red-400">{note.msg}</div>}

      {list.length === 0 ? (
        <div className="card p-6 text-center text-[var(--fg-3)] text-sm">{t('narratives.no_custom', { defaultValue: 'No custom narratives yet.' })}</div>
      ) : (
        <div className="space-y-2">
          {list.map((n) => (
            <div key={n.id} className="card p-3 flex items-center gap-3">
              {n.status && <span className="chip text-[10px] uppercase">{n.status}</span>}
              <span className="flex-1 text-sm text-[var(--fg-1)] truncate">{n.title}</span>
              <span className="text-[10px] text-[var(--fg-4)]">{t('narratives.private', { defaultValue: 'private' })}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
