import React, { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Rss, Plus, Trash2, RefreshCw, ExternalLink } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { listSources, addSource, removeSource, listNews, refreshNews, usageSummary, listGlobalNews } from '../lib/news-api'
import { getIntelProfile } from '../lib/intel-api'
import { toPlainText, cleanNewsTitle } from '../lib/text-clean'
import IntelDisclaimer from '../components/IntelDisclaimer'

const SOURCE_TYPES = ['x_account', 'keyword', 'rss', 'website']
const SENT_CLS = { bullish: 'chip--ok', bearish: 'chip--err', mixed: 'chip--info', neutral: '' }

// News & source following — track X accounts / keywords / outlets and get
// news around followed tokens and the broader space (not only on-chain).
export default function NewsPage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase, user } = useSupabase()
  const [sources, setSources] = useState([])
  const [news, setNews] = useState([])
  const [usage, setUsage] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [form, setForm] = useState({ sourceType: 'x_account', value: '' })
  const [err, setErr] = useState(null)

  const load = useCallback(async () => {
    if (!org?.id) return
    setLoading(true); setErr(null)
    try {
      const prof = await getIntelProfile(supabase, org.id).catch(() => null)
      const chains = prof?.chains_of_interest || null
      const [s, custom, global, u] = await Promise.all([
        listSources(supabase, org.id), listNews(supabase, org.id), listGlobalNews(supabase, { chains }), usageSummary(supabase),
      ])
      setSources(s); setUsage(u)
      const merged = [...global, ...custom].sort((a, b) => new Date(b.published_at || b.created_at || 0) - new Date(a.published_at || a.created_at || 0))
      setNews(merged)
    } catch (e) { setErr(e.message) } finally { setLoading(false) }
  }, [org?.id, supabase])
  useEffect(() => { load() }, [load])

  const onAdd = useCallback(async (e) => {
    e.preventDefault()
    if (!form.value.trim() || !org?.id) return
    setErr(null)
    try {
      await addSource(supabase, org.id, user?.id, { sourceType: form.sourceType, value: form.value })
      setForm((f) => ({ ...f, value: '' })); await load()
    } catch (e2) {
      setErr(e2.message === 'LIMIT_NEWS_SOURCES' ? t('news.limit', { defaultValue: 'Source limit reached for your plan — upgrade for more.' })
        : e2.message === 'DUPLICATE' ? t('news.dup', { defaultValue: 'Already tracking that source.' }) : e2.message)
    }
  }, [form, org?.id, supabase, user?.id, load, t])

  const onRefresh = useCallback(async () => {
    if (!org?.id) return
    setRefreshing(true); setErr(null)
    try { await refreshNews(supabase, org.id); await load() }
    catch (e) { setErr(e.message === 'news_refreshes_per_day' ? t('news.rate', { defaultValue: 'Daily news refresh limit reached for your plan.' }) : e.message) }
    finally { setRefreshing(false) }
  }, [org?.id, supabase, load, t])

  const srcLimit = usage?.news_sources

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
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

      {err && <div className="card--flat p-3 text-[13px] text-red-400">{err}</div>}

      {loading ? (
        <div className="card p-8 grid place-items-center"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--accent)]" /></div>
      ) : news.length === 0 ? (
        <div className="card p-8 text-center text-[var(--fg-3)] text-sm">{t('news.empty', { defaultValue: 'No news yet. Add sources or tokens to your watchlist, then Fetch news.' })}</div>
      ) : (
        <div className="space-y-2">
          {news.map((n) => (
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
        </div>
      )}

      <IntelDisclaimer variant="block" />
    </div>
  )
}
