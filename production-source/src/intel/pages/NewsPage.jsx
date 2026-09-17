import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router'
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
import { NEWS_CATEGORIES } from '../../../supabase/functions/_shared/intel-categories'
import { IntelEmptyState, IntelPageHeader, IntelPageShell, IntelSkeleton } from '../components/IntelPrimitives'

const SOURCE_TYPES = ['x_account', 'keyword', 'rss', 'website']
const SENT_CLS = { bullish: 'chip--ok', bearish: 'chip--err', mixed: 'chip--info', neutral: '' }
const SIGNAL_OPTS = ['bullish', 'bearish', 'caution', 'neutral']
const PAGE_SIZE = 12
const itemCategory = (x) => x.news_category || ''

// News & source following — track X accounts / keywords / outlets and get
// news around followed tokens and the broader space (not only on-chain).
export default function NewsPage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase, user } = useSupabase()
  const [sourceRows, setSources] = useState([])
  const [loadedOwner, setLoadedOwner] = useState(null)
  const owner = [org?.id, user?.id].join(':')
  const sources = loadedOwner === owner ? sourceRows : []
  const [news, setNews] = useState([])
  const [curated, setCurated] = useState([])
  const [usageRow, setUsage] = useState(null)
  const usage = loadedOwner === owner ? usageRow : null
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [form, setForm] = useState({ sourceType: 'x_account', value: '' })
  const [err, setErr] = useState(null)
  const [readError, setReadError] = useState(null)
  const [newsSearch, setNewsSearch] = useSearchParams()
  const q = (newsSearch.get('search') || '').slice(0, 300)
  const [qInput, setQInput] = useState(q)
  const setQ = useCallback(value => setNewsSearch(previous => { const next = new URLSearchParams(previous); if (value) next.set('search', value); else next.delete('search'); next.delete('page'); return next }), [setNewsSearch])
  useEffect(() => { setQInput(q) }, [q])
  const setParam = useCallback((key, value) => setNewsSearch(previous => {
    const next = new URLSearchParams(previous)
    value ? next.set(key, String(value)) : next.delete(key)
    if (key !== 'page') next.delete('page')
    if (key === 'feed' && value === 'sources') next.delete('category')
    return next
  }), [setNewsSearch])
  const fCat = (newsSearch.get('category') || '').slice(0, 80), setFCat = value => setParam('category', value)
  const fSig = SIGNAL_OPTS.includes(newsSearch.get('signal')) ? newsSearch.get('signal') : '', setFSig = value => setParam('signal', value)
  const since = newsSearch.get('from') || '', setSince = value => setParam('from', value)
  const until = newsSearch.get('to') || '', setUntil = value => setParam('to', value)
  const page = Math.min(100000, Math.max(0, Math.floor(Number(newsSearch.get('page')) || 0)))
  const setPage = useCallback(value => setParam('page', value), [setParam])
  const feed = ['analyzed','headlines','sources'].includes(newsSearch.get('feed')) ? newsSearch.get('feed') : 'analyzed'
  const sequence = useRef(0)
  const [loadedScope, setLoadedScope] = useState(null)
  const scope = [org?.id, user?.id, feed, q, fCat, fSig, since, until, page].join(':')
  const [globalCount, setGlobalCount] = useState(0)

  const load = useCallback(async () => {
    const request = ++sequence.current
    if (!org?.id || !user?.id) return
    setLoading(true); setErr(null); setReadError(null)
    try {
      const prof = await getIntelProfile(supabase, org.id).catch(() => null)
      const chains = prof?.chains_of_interest || null
      const sopts = { chains, search: q || null, since: since || null, until: until || null, signal: fSig || null, category: fCat || null, page, pageSize: PAGE_SIZE, limit: PAGE_SIZE, paginated: true }
      const [s, data, u] = await Promise.all([
        listSources(supabase, org.id),
        feed === 'analyzed' ? listCuratedNews(supabase, sopts) : feed === 'sources' ? listNews(supabase, org.id, sopts) : pageGlobalNews(supabase, sopts),
        usageSummary(supabase),
      ])
      if (request !== sequence.current) return
      setSources(s); setUsage(u); setLoadedOwner(owner); setGlobalCount(data.count); setLoadedScope(scope)
      setCurated(feed === 'analyzed' ? data.rows : []); setNews(feed === 'analyzed' ? [] : data.rows)
    } catch (e) { if (request === sequence.current) { setReadError(e.message || 'News could not be loaded.'); setCurated([]); setNews([]) } }
    finally { if (request === sequence.current) setLoading(false) }
  }, [org?.id, user?.id, supabase, q, since, until, fSig, fCat, page, feed, scope, owner])
  useEffect(() => { setSources([]); setUsage(null) }, [org?.id, user?.id])
  useEffect(() => { load(); return () => { sequence.current++ } }, [load])
  useEffect(() => () => { if (org?.id) markSurfaceSeen(supabase, 'news', '', { orgId: org.id, userId: user?.id }) }, [org?.id, user?.id, supabase])

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
  const filterOpts = useMemo(() => ({
    categories: [...new Set([...NEWS_CATEGORIES, ...curated.map(itemCategory), ...news.map(itemCategory)].filter(Boolean))].sort((x, y) => x.localeCompare(y)),
  }), [curated, news])
  const curatedShown = loadedScope === scope ? curated : []
  const newsShown = loadedScope === scope ? news : []
  const pageCount = Math.max(1, Math.ceil(globalCount / PAGE_SIZE))
  const goPage = useCallback((p) => setPage(Math.min(Math.max(0, p), pageCount - 1)), [pageCount, setPage])
  const clearFilters = useCallback(() => { setQInput(''); setNewsSearch(previous => { const next = new URLSearchParams(previous); ['search','category','signal','from','to','page'].forEach(key => next.delete(key)); return next }) }, [setNewsSearch])
  const srcLimit = usage?.news_sources
  const sourceLimitText = srcLimit?.limit != null ? `${usage?.news_sources?.used ?? sources.length}/${srcLimit.limit}` : String(sources.length)

  return (
    <IntelPageShell className="intel-news-page">
      <IntelPageHeader
        icon={Rss}
        eyebrow={t('brand.name', { defaultValue: 'Investor Intel' })}
        title={t('nav.news', { defaultValue: 'News' })}

        actions={(
          <button onClick={onRefresh} disabled={refreshing} className="btn btn--primary btn--sm disabled:opacity-50">
            {refreshing ? <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-current" /> : <><RefreshCw className="h-4 w-4" /> {t('news.refresh', { defaultValue: 'Fetch news' })}</>}
          </button>
        )}
      />

      <details className="border-y border-[var(--border-default)] py-3">
        <summary className="cursor-pointer text-sm font-medium">{t('news.manage_sources', { defaultValue: 'Manage sources' })} ({sourceLimitText})</summary>
      <p className="text-sm text-[var(--fg-4)] mt-3">{t('news.sub', { defaultValue: 'Follow X accounts, outlets and keywords to get news around your tokens and the broader market.' })}</p>
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
              <button aria-label={t('news.remove_source', { defaultValue: 'Remove source' }) + ': ' + s.value} onClick={() => removeSource(supabase, s.id).then(load).catch(e => setErr(e.message))} className="text-[var(--fg-4)] hover:text-red-400"><Trash2 className="h-3 w-3" /></button>
            </span>
          ))}
        </div>
      )}

      </details>
      <nav aria-label={t('news.feeds', { defaultValue: 'News feeds' })} className="flex flex-wrap gap-5 border-b border-[var(--border-default)]">
        {[['analyzed','Analyzed stories'],['headlines','All headlines'],['sources','Your sources']].map(([key,label]) => <button key={key} onClick={() => setParam('feed', key)} aria-current={feed === key ? 'page' : undefined} className={'py-3 border-b-2 text-sm ' + (feed === key ? 'border-[var(--accent)] text-[var(--fg-1)]' : 'border-transparent text-[var(--fg-4)]')}>{t('news.feeds_' + key, { defaultValue: label })}</button>)}
      </nav>
      <IntelErrorNotice error={err} />

      {(
        <div className="card p-3 space-y-3">
          <form onSubmit={(e) => { e.preventDefault(); setQ(qInput.trim()) }} className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--fg-5)]" />
              <input className="input w-full pl-8" placeholder={t('news.search_ph', { defaultValue: 'Search all news: stories, tokens, narratives…' })} value={qInput} onChange={(e) => setQInput(e.target.value)} />
            </div>
            <button type="submit" className="btn btn--primary btn--sm">{t('news.search', { defaultValue: 'Search' })}</button>
          </form>
          <div className="intel-news-filters flex flex-wrap items-center gap-2">
            <select aria-label={t('news.f_signal', { defaultValue: 'Signal' })} className="select text-[12px]" value={fSig} onChange={(e) => setFSig(e.target.value)}>
              <option value="">{t('news.f_signal_any', { defaultValue: 'Any signal' })}</option>
              {SIGNAL_OPTS.map((s) => <option key={s} value={s}>{t(`market.signal.${s}`, { defaultValue: s[0].toUpperCase() + s.slice(1) })}</option>)}
            </select>
            {feed !== 'sources' && (
              <select aria-label={t('news.f_category', { defaultValue: 'Category' })} className="select text-[12px]" value={fCat} onChange={(e) => setFCat(e.target.value)}>
                <option value="">{t('news.f_category_any', { defaultValue: 'Any category' })}</option>
                {[...new Set([fCat, ...filterOpts.categories].filter(Boolean))].map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}
              </select>
            )}
            <span className="inline-flex items-center gap-1 text-[11px] text-[var(--fg-4)]">
              <CalendarRange className="h-3.5 w-3.5" />
              <input type="date" className="select text-[12px]" value={since} max={until || undefined} onChange={(e) => setSince(e.target.value)} aria-label={t('news.from', { defaultValue: 'From date' })} />
              <span className="text-[var(--fg-5)]">–</span>
              <input type="date" className="select text-[12px]" value={until} min={since || undefined} onChange={(e) => setUntil(e.target.value)} aria-label={t('news.to', { defaultValue: 'To date' })} />
            </span>
            {anyActive && <button type="button" onClick={clearFilters} className="text-[11px] text-[var(--fg-4)] hover:text-[var(--fg-1)] inline-flex items-center gap-1"><X className="h-3 w-3" />{t('news.clear', { defaultValue: 'Clear' })}</button>}
          </div>
          {searchMode && <p className="text-[11px] text-[var(--fg-5)]">{t('news.search_scope', { defaultValue: 'Searching the full history, newest first.' })}</p>}
        </div>
      )}

      <section className="intel-news-results" aria-label={t('news.results', { defaultValue: 'News results' })} aria-busy={loading}>
      {!loading && !readError && curatedShown.length > 0 && (
        <section className="space-y-2">
          <div className="eyebrow flex items-center gap-1.5"><Sparkles className="h-3.5 w-3.5" /> {searchMode ? t('news.results_title', { defaultValue: 'Matching stories' }) : t('news.curated_title', { defaultValue: 'Top stories, analyzed' })}</div>
          {!searchMode && <p className="text-xs text-[var(--fg-4)]">{t('news.recent_ranked', { defaultValue: 'Past 7 days, ranked by importance. Search or choose dates for older analysis.' })}</p>}
          <div className="divide-y divide-[var(--border-default)]">{curatedShown.map((c) => <details key={c.id} className="py-3 group">
            <summary className="cursor-pointer grid gap-1 sm:gap-4 sm:grid-cols-[90px_minmax(0,1fr)_100px] items-baseline">
              <time dateTime={c.published_at || c.created_at} className="text-xs text-[var(--fg-4)]">{new Date(c.published_at || c.created_at).toLocaleDateString()}</time>
              <span className="text-sm font-medium leading-relaxed group-open:text-[var(--accent)]">{c.cleaned_title || c.title}<span className="ml-2 text-xs font-normal text-[var(--fg-4)]">{t('news.expand', { defaultValue: 'Read analysis' })}</span></span>
              <span className="text-xs text-[var(--fg-4)] sm:text-right">{c.news_category?.replaceAll('_',' ')}</span>
            </summary>
            <div className="pt-3 sm:pl-[106px]"><CuratedNewsCard c={c} /></div>
          </details>)}</div>
        </section>
      )}

      {loading ? (
        <IntelSkeleton className="h-40" />
      ) : readError ? (
        <div role="alert">
          <IntelErrorNotice error={readError} />
          <button type="button" className="btn btn--quiet btn--sm" onClick={load}>{t('common.retry', { defaultValue: 'Retry' })}</button>
        </div>
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
            {globalCount > 0 && <span className="text-[11px] text-[var(--fg-5)]">{globalCount.toLocaleString()} {t('news.in_history', { defaultValue: 'in history' })}{pageCount > 1 ? ` · ${t('news.page_inline', { defaultValue: 'page' })} ${page + 1}/${pageCount}` : ''}</span>}
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
                        {showSummary && <details className="text-xs text-[var(--fg-3)] mt-1"><summary className="cursor-pointer text-[var(--fg-4)] py-1">{t('news.read_summary', { defaultValue: 'Read summary' })}</summary><p className="leading-relaxed mt-1">{summary}</p></details>}
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
        </div>
      ) : null}
      {!loading && !readError && (pageCount > 1 || page > 0) && <nav aria-label={t('news.pagination', { defaultValue: 'News pages' })} className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border-default)] pt-3">
        <button className="btn" disabled={page === 0} onClick={() => goPage(page - 1)}>{t('news.previous', { defaultValue: 'Previous' })}</button>
        <label className="flex items-center gap-2 text-sm">{t('news.page', { defaultValue: 'Page' })}<input className="input w-20" type="number" min="1" max={pageCount} aria-label={t('news.jump', { defaultValue: 'Jump to page' })} value={page + 1} onChange={e => { if (e.target.value) goPage(Number(e.target.value) - 1) }} /><span>/ {pageCount.toLocaleString()}</span></label>
        <button className="btn" disabled={page + 1 >= pageCount} onClick={() => goPage(page + 1)}>{t('news.next', { defaultValue: 'Next' })}</button>
      </nav>}
      </section>

      <details className="border-t border-[var(--border-default)] py-3"><summary className="cursor-pointer text-sm">{t('news.relevant_signals', { defaultValue: 'Signals relevant to you' })}</summary><RelevantSignals title={t('news.relevant_signals', { defaultValue: 'Signals relevant to you' })} seeAllHref="/intel" /></details>

      <IntelDisclaimer variant="block" />
    </IntelPageShell>
  )
}
