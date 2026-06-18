import React, { useEffect, useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Rss, Plus, Trash2, RefreshCw, ExternalLink, Sparkles, Search, X, CalendarRange } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { listSources, addSource, removeSource, listNews, refreshNews, usageSummary, pageGlobalNews, listCuratedNews } from '../lib/news-api'
import { getIntelProfile } from '../lib/intel-api'
import { toPlainText, cleanNewsTitle } from '../lib/text-clean'
import IntelDisclaimer from '../components/IntelDisclaimer'
import IntelErrorNotice from '../components/IntelErrorNotice'
import RelevantSignals from '../components/RelevantSignals'
import CuratedNewsCard from '../components/CuratedNewsCard'
import { markSurfaceSeen } from '../lib/changes-api'
import { IntelEmptyState, IntelHeroRead, IntelPageHeader, IntelPageShell, IntelSkeleton } from '../components/IntelPrimitives'

const SOURCE_TYPES = ['x_account', 'keyword', 'rss', 'website']
const SENT_CLS = { bullish: 'chip--ok', bearish: 'chip--err', mixed: 'chip--info', neutral: '' }
const SIGNAL_OPTS = ['bullish', 'bearish', 'caution', 'neutral']
const PAGE_SIZE = 20
// Signal/category refine the loaded set client-side; they (plus search + date)
// also drive the server-side paginated query so page counts stay accurate.
const normSig = (s) => { const v = String(s || '').toLowerCase(); if (SIGNAL_OPTS.includes(v)) return v; if (v === 'mixed') return 'caution'; return '' }
const itemCategory = (x) => x.news_category || ''

// Windowed page list with ellipsis gaps (1-based): 1 … 4 5 [6] 7 8 … 50
const pageWindow = (cur, total) => {
  const set = []
  const add = (n) => { if (n >= 1 && n <= total && !set.includes(n)) set.push(n) }
  add(1); add(2); add(cur - 1); add(cur); add(cur + 1); add(total - 1); add(total)
  set.sort((a, b) => a - b)
  const out = []
  set.forEach((n, i) => { if (i && n - set[i - 1] > 1) out.push('…'); out.push(n) })
  return out
}

// News & source following — track X accounts / keywords / outlets and get
// news around followed tokens and the broader space (not only on-chain).
export default function NewsPage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase, user } = useSupabase()
  const [sources, setSources] = useState([])
  const [news, setNews] = useState([])
  const [curated, setCurated] = useState([])
  const [usage, setUsage] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [form, setForm] = useState({ sourceType: 'x_account', value: '' })
  const [err, setErr] = useState(null)
  const [qInput, setQInput] = useState('')
  const [q, setQ] = useState('')
  const [fCat, setFCat] = useState('')
  const [fSig, setFSig] = useState('')
  const [since, setSince] = useState('')
  const [until, setUntil] = useState('')
  const [page, setPage] = useState(0)
  const [globalCount, setGlobalCount] = useState(0)

  const load = useCallback(async () => {
    if (!org?.id) return
    setLoading(true); setErr(null)
    try {
      const prof = await getIntelProfile(supabase, org.id).catch(() => null)
      const chains = prof?.chains_of_interest || null
      const sopts = { search: q || null, since: since || null, until: until || null }
      const onP1 = page === 0
      const [s, custom, global, cur, u] = await Promise.all([
        listSources(supabase, org.id),
        onP1 ? listNews(supabase, org.id, sopts) : Promise.resolve([]),
        pageGlobalNews(supabase, { chains, ...sopts, signal: fSig || null, category: fCat || null, page, pageSize: PAGE_SIZE }),
        onP1 ? listCuratedNews(supabase, { chains, limit: 40, ...sopts }).catch(() => []) : Promise.resolve([]),
        usageSummary(supabase),
      ])
      setSources(s); setUsage(u); setCurated(cur); setGlobalCount(global.count)
      // Page 1 also carries the user's own tracked-source items on top; deeper
      // pages are pure global history so 20-per-page stays exact.
      const feed = onP1
        ? [...global.rows, ...custom].sort((a, b) => new Date(b.published_at || b.created_at || 0) - new Date(a.published_at || a.created_at || 0))
        : global.rows
      setNews(feed)
    } catch (e) { setErr(e.message) } finally { setLoading(false) }
  }, [org?.id, supabase, q, since, until, fSig, fCat, page])
  useEffect(() => { load() }, [load])
  useEffect(() => () => { if (org?.id) markSurfaceSeen(supabase, 'news') }, [org?.id, supabase])

  const onAdd = useCallback(async (e) => {
    e.preventDefault()
    if (!form.value.trim() || !org?.id) return
    setErr(null)
    try {
      await addSource(supabase, org.id, user?.id, { sourceType: form.sourceType, value: form.value })
      setForm((f) => ({ ...f, value: '' })); await load()
    } catch (e2) {
      // Limit tokens stay raw — IntelErrorNotice maps them to friendly copy
      // plus the /intel/upgrade link.
      setErr(e2.message === 'DUPLICATE' ? t('news.dup', { defaultValue: 'Already tracking that source.' }) : e2.message)
    }
  }, [form, org?.id, supabase, user?.id, load, t])

  const onRefresh = useCallback(async () => {
    if (!org?.id) return
    setRefreshing(true); setErr(null)
    try { await refreshNews(supabase, org.id); await load() }
    catch (e) { setErr(e.message) }
    finally { setRefreshing(false) }
  }, [org?.id, supabase, load, t])

  const searchMode = !!(q || since || until)
  const dropdownActive = !!(fCat || fSig)
  const anyActive = searchMode || dropdownActive
  // Search, date and the signal/category dropdowns all run server-side (in load).
  // This predicate just keeps the page-1 custom items consistent with them.
  const matchesFilter = useCallback((x) => {
    if (fCat && itemCategory(x) !== fCat) return false
    if (fSig && normSig(x.signal || x.signal_bias || x.sentiment) !== fSig) return false
    return true
  }, [fCat, fSig])
  const filterOpts = useMemo(() => ({
    categories: [...new Set(curated.map(itemCategory).filter(Boolean))].sort((x, y) => x.localeCompare(y)),
  }), [curated])
  const curatedShown = useMemo(() => { const f = curated.filter(matchesFilter); return anyActive ? f : f.slice(0, 12) }, [curated, matchesFilter, anyActive])
  const newsShown = useMemo(() => news.filter(matchesFilter), [news, matchesFilter])
  const pageCount = Math.max(1, Math.ceil(globalCount / PAGE_SIZE))
  const goPage = useCallback((p) => setPage(Math.min(Math.max(0, p), pageCount - 1)), [pageCount])
  const clearFilters = useCallback(() => { setQ(''); setQInput(''); setFCat(''); setFSig(''); setSince(''); setUntil(''); setPage(0) }, [])
  const srcLimit = usage?.news_sources
  const sourceLimitText = srcLimit?.limit != null ? `${usage?.news_sources?.used ?? sources.length}/${srcLimit.limit}` : String(sources.length)

  return (
    <IntelPageShell>
      <IntelPageHeader
        icon={Rss}
        eyebrow={t('brand.name', { defaultValue: 'Investor Intel' })}
        title={t('nav.news', { defaultValue: 'News' })}
        subtitle={t('news.sub', { defaultValue: 'Follow X accounts, outlets and keywords to get news around your tokens and the broader market.' })}
        actions={(
          <button onClick={onRefresh} disabled={refreshing} className="btn btn--primary btn--sm disabled:opacity-50">
            {refreshing ? <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-current" /> : <><RefreshCw className="h-4 w-4" /> {t('news.refresh', { defaultValue: 'Fetch news' })}</>}
          </button>
        )}
      />

      <IntelHeroRead
        eyebrow={t('news.feed_read', { defaultValue: 'Feed read' })}
        title={anyActive
          ? t('news.feed_title_filtered', { defaultValue: `${curatedShown.length + newsShown.length} matching stories` })
          : t('news.feed_title', { defaultValue: 'Top stories first, full history underneath' })}
        body={t('news.feed_body', { defaultValue: 'Curated stories surface the highest-signal items first. The source manager, search, date range, signal filter, category filter, and pagination remain available for deeper review.' })}
        meta={[
          { label: t('news.sources_label', { defaultValue: 'Sources' }), value: sourceLimitText },
          { label: t('news.curated', { defaultValue: 'Curated' }), value: curatedShown.length.toLocaleString() },
          { label: t('news.headlines', { defaultValue: 'Headlines' }), value: newsShown.length.toLocaleString() },
          { label: t('news.history', { defaultValue: 'History' }), value: globalCount.toLocaleString() },
        ]}
      />

      <div className="hidden">
        <div>
          <div className="eyebrow flex items-center gap-1.5"><Rss className="h-3.5 w-3.5" /> {t('brand.name', { defaultValue: 'Investor Intel' })}</div>
          <h1 className="page-title">{t('nav.news', { defaultValue: 'News' })}</h1>
          <p className="page-sub">{t('news.sub', { defaultValue: 'Follow X accounts, outlets and keywords to get news around your tokens and the broader market.' })}</p>
        </div>
        <button onClick={onRefresh} disabled={refreshing} className="btn btn--primary btn--sm disabled:opacity-50">
          {refreshing ? <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-current" /> : <><RefreshCw className="h-4 w-4" /> {t('news.refresh', { defaultValue: 'Fetch news' })}</>}
        </button>
      </div>

      <form onSubmit={onAdd} className="card p-4 flex flex-wrap items-end gap-3">
        <label className="block"><span className="text-[11px] text-[var(--fg-4)]">{t('news.source_type', { defaultValue: 'Source' })}</span>
          <select className="select" value={form.sourceType} onChange={(e) => setForm((f) => ({ ...f, sourceType: e.target.value }))}>
            {SOURCE_TYPES.map((s) => <option key={s} value={s}>{t(`news.types.${s}`, { defaultValue: s })}</option>)}
          </select>
        </label>
        <label className="block flex-1 min-w-[200px]"><span className="text-[11px] text-[var(--fg-4)]">{t('news.value', { defaultValue: 'Value' })}</span>
          <input className="input w-full" placeholder={t(`news.ph.${form.sourceType}`, { defaultValue: form.sourceType === 'x_account' ? '@handle' : form.sourceType === 'keyword' ? 'e.g. restaking' : 'https://…' })} value={form.value} onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))} />
        </label>
        <button type="submit" className="btn btn--primary" disabled={!form.value.trim()}><Plus className="h-4 w-4" /> {t('watchlist.add', { defaultValue: 'Add' })}</button>
        {usage && <span className="text-[11px] text-[var(--fg-4)] pb-2">{usage.news_sources?.used ?? sources.length}{srcLimit?.limit != null ? ` / ${srcLimit.limit}` : ''} {t('news.sources_label', { defaultValue: 'sources' })}</span>}
      </form>

      {sources.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {sources.map((s) => (
            <span key={s.id} className="chip flex items-center gap-1.5">
              <span className="text-[10px] uppercase text-[var(--fg-4)]">{t(`news.types.${s.source_type}`, { defaultValue: s.source_type })}</span>
              {s.source_type === 'x_account' ? '@' : ''}{s.value}
              <button onClick={() => removeSource(supabase, s.id).then(load)} className="text-[var(--fg-4)] hover:text-red-400"><Trash2 className="h-3 w-3" /></button>
            </span>
          ))}
        </div>
      )}

      <IntelErrorNotice error={err} />

      {!loading && (curated.length > 0 || news.length > 0 || searchMode) && (
        <div className="card p-3 space-y-3">
          <form onSubmit={(e) => { e.preventDefault(); setQ(qInput.trim()); setPage(0) }} className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--fg-5)]" />
              <input className="input w-full pl-8" placeholder={t('news.search_ph', { defaultValue: 'Search all news — stories, tokens, narratives…' })} value={qInput} onChange={(e) => setQInput(e.target.value)} />
            </div>
            <button type="submit" className="btn btn--primary btn--sm">{t('news.search', { defaultValue: 'Search' })}</button>
          </form>
          <div className="flex flex-wrap items-center gap-2">
            <select className="select text-[12px]" value={fSig} onChange={(e) => { setFSig(e.target.value); setPage(0) }}>
              <option value="">{t('news.f_signal', { defaultValue: 'Any signal' })}</option>
              {SIGNAL_OPTS.map((s) => <option key={s} value={s}>{t(`market.signal.${s}`, { defaultValue: s[0].toUpperCase() + s.slice(1) })}</option>)}
            </select>
            {filterOpts.categories.length > 0 && (
              <select className="select text-[12px]" value={fCat} onChange={(e) => { setFCat(e.target.value); setPage(0) }}>
                <option value="">{t('news.f_category', { defaultValue: 'Any category' })}</option>
                {filterOpts.categories.map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}
              </select>
            )}
            <span className="inline-flex items-center gap-1 text-[11px] text-[var(--fg-4)]">
              <CalendarRange className="h-3.5 w-3.5" />
              <input type="date" className="select text-[12px]" value={since} max={until || undefined} onChange={(e) => { setSince(e.target.value); setPage(0) }} aria-label={t('news.from', { defaultValue: 'From date' })} />
              <span className="text-[var(--fg-5)]">–</span>
              <input type="date" className="select text-[12px]" value={until} min={since || undefined} onChange={(e) => { setUntil(e.target.value); setPage(0) }} aria-label={t('news.to', { defaultValue: 'To date' })} />
            </span>
            {anyActive && <button type="button" onClick={clearFilters} className="text-[11px] text-[var(--fg-4)] hover:text-[var(--fg-1)] inline-flex items-center gap-1"><X className="h-3 w-3" />{t('news.clear', { defaultValue: 'Clear' })}</button>}
          </div>
          {searchMode && <p className="text-[11px] text-[var(--fg-5)]">{t('news.search_scope', { defaultValue: 'Searching the full history — newest first.' })}</p>}
        </div>
      )}

      {!loading && page === 0 && curatedShown.length > 0 && (
        <section className="space-y-2">
          <div className="eyebrow flex items-center gap-1.5"><Sparkles className="h-3.5 w-3.5" /> {searchMode ? t('news.results_title', { defaultValue: 'Matching stories' }) : t('news.curated_title', { defaultValue: 'Top stories, analyzed' })}</div>
          {!searchMode && <p className="text-[11px] text-[var(--fg-4)] -mt-1">{t('news.curated_sub', { defaultValue: 'The highest-signal stories across the space, scored and explained.' })}</p>}
          <div className="space-y-2">{curatedShown.map((c) => <CuratedNewsCard key={c.id} c={c} />)}</div>
        </section>
      )}

      {loading ? (
        <IntelSkeleton className="h-40" />
      ) : (curatedShown.length === 0 && newsShown.length === 0) ? (
        <IntelEmptyState
          title={anyActive ? t('news.no_match', { defaultValue: 'No stories match your search.' }) : t('news.empty', { defaultValue: 'No news yet. Add sources or tokens to your watchlist, then Fetch news.' })}
          action={anyActive ? <button type="button" onClick={clearFilters} className="btn btn--quiet btn--sm"><X className="h-3 w-3" />{t('news.clear', { defaultValue: 'Clear' })}</button> : null}
        />
      ) : newsShown.length > 0 ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            {page === 0 && curatedShown.length > 0
              ? <div className="eyebrow flex items-center gap-1.5"><Rss className="h-3.5 w-3.5" /> {t('news.all_headlines', { defaultValue: 'More headlines' })}</div>
              : <span />}
            {globalCount > 0 && <span className="text-[11px] text-[var(--fg-5)]">{globalCount.toLocaleString()} {t('news.in_history', { defaultValue: 'in history' })}{pageCount > 1 ? ` · ${t('news.page', { defaultValue: 'page' })} ${page + 1}/${pageCount}` : ''}</span>}
          </div>
          {newsShown.map((n) => (
            <div key={n.id} className="card p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  {(() => {
                    const summary = toPlainText(n.summary)
                    const title = cleanNewsTitle(n.title, summary)
                    const showSummary = summary && summary.toLowerCase() !== title.toLowerCase()
                      && !title.toLowerCase().startsWith(summary.slice(0, 36).toLowerCase())
                      && !summary.toLowerCase().startsWith(title.slice(0, 36).toLowerCase())
                    return (
                      <>
                        {n.url
                          ? <a href={n.url} target="_blank" rel="noopener noreferrer" className="text-sm text-[var(--fg-1)] hover:text-[var(--accent)] flex items-start gap-1.5 leading-snug">{title} <ExternalLink className="h-3 w-3 flex-shrink-0 text-[var(--fg-5)] mt-0.5" /></a>
                          : <span className="text-sm text-[var(--fg-1)] leading-snug">{title}</span>}
                        {showSummary && <p className="text-[12px] text-[var(--fg-3)] mt-1 line-clamp-3 leading-snug">{summary}</p>}
                      </>
                    )
                  })()}
                  <div className="flex items-center gap-2 mt-1.5 text-[11px] text-[var(--fg-4)] flex-wrap">
                    {n.curated && <span className="chip text-[10px]">{t('news.curated', { defaultValue: 'Curated' })}</span>}
                    {n.source_name && <span>{n.source_name}</span>}
                    {(n.entity?.display_symbol || n.entity_symbol) && <span className="chip chip--accent text-[10px]">{n.entity?.display_symbol || n.entity_symbol}</span>}
                    {n.published_at && <span>{new Date(n.published_at).toLocaleDateString()}</span>}
                  </div>
                </div>
                {n.sentiment && <span className={`chip ${SENT_CLS[n.sentiment] || ''} text-[10px] uppercase flex-shrink-0`}>{n.sentiment}</span>}
              </div>
            </div>
          ))}
          {pageCount > 1 && (
            <div className="flex items-center justify-center gap-1 flex-wrap pt-3">
              <button type="button" disabled={page <= 0} onClick={() => goPage(0)} className="btn btn--sm disabled:opacity-40" aria-label={t('news.first', { defaultValue: 'First page' })}>«</button>
              <button type="button" disabled={page <= 0} onClick={() => goPage(page - 1)} className="btn btn--sm disabled:opacity-40" aria-label={t('news.prev', { defaultValue: 'Previous page' })}>‹</button>
              {pageWindow(page + 1, pageCount).map((n, i) => n === '…'
                ? <span key={`g${i}`} className="px-1.5 text-[var(--fg-5)]">…</span>
                : <button key={n} type="button" onClick={() => goPage(n - 1)} className={`min-w-[28px] px-2 py-1 rounded text-[12px] ${n - 1 === page ? 'bg-[var(--accent)] text-white' : 'text-[var(--fg-3)] hover:bg-[var(--bg-3)]'}`}>{n}</button>)}
              <button type="button" disabled={page >= pageCount - 1} onClick={() => goPage(page + 1)} className="btn btn--sm disabled:opacity-40" aria-label={t('news.next', { defaultValue: 'Next page' })}>›</button>
              <button type="button" disabled={page >= pageCount - 1} onClick={() => goPage(pageCount - 1)} className="btn btn--sm disabled:opacity-40" aria-label={t('news.last', { defaultValue: 'Last page' })}>»</button>
              <select value={page} onChange={(e) => goPage(Number(e.target.value))} className="select text-[12px] ml-1" aria-label={t('news.jump', { defaultValue: 'Jump to page' })}>
                {Array.from({ length: pageCount }, (_, i) => <option key={i} value={i}>{t('news.page', { defaultValue: 'Page' })} {i + 1}</option>)}
              </select>
            </div>
          )}
        </div>
      ) : null}

      <RelevantSignals title={t('news.relevant_signals', { defaultValue: 'Signals relevant to you' })} seeAllHref="/intel" />

      <IntelDisclaimer variant="block" />
    </IntelPageShell>
  )
}
