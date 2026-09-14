import React, { useState } from 'react'
import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useAssetNews } from '../lib/useAssetNews'
import { cleanNewsTitle } from '../lib/text-clean'

export default function AssetNewsPanel({ identity }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const news = useAssetNews(identity)
  const [expandedKey, setExpandedKey] = useState(null)
  const expanded = expandedKey === identity?.key
  return <section id="asset-news" className="intel-asset-news" aria-labelledby="asset-news-title">
    <div className="flex items-center justify-between gap-3 flex-wrap">
      <h2 id="asset-news-title" className="text-base font-semibold">{t('asset_news.title', { defaultValue: 'Recent asset news' })}</h2>
      <div className="flex items-center gap-4 text-xs">
        <button disabled={news.loading} onClick={news.refresh} className="underline underline-offset-4">{t('common.refresh', { defaultValue: 'Refresh' })}</button>
        <Link to={`/intel/news?${new URLSearchParams({ search: identity?.name || identity?.symbol || '' })}`} className="underline underline-offset-4">{t('asset_news.history', { defaultValue: 'Search news history' })}</Link>
      </div>
    </div>
    <p className="text-xs text-[var(--fg-4)] mt-1">{t('asset_news.window', { defaultValue: 'Past 7 days · newest first · refreshes automatically while you are here' })}</p>
    {news.loading && !news.rows.length && <p role="status" className="py-3 text-sm">{t('asset_news.loading', { defaultValue: 'Loading recent coverage…' })}</p>}
    {(news.error || news.partial) && <p role="status" className="py-3 text-sm text-[var(--fg-4)]">{news.rows.length ? t('asset_news.partial', { defaultValue: 'Some news sources could not be refreshed. Available coverage is shown below.' }) : t('asset_news.error', { defaultValue: 'Recent news could not be loaded. Try Refresh.' })}</p>}
    {!news.loading && !news.error && !news.rows.length && <p className="py-3 text-sm text-[var(--fg-4)]">{t('asset_news.empty', { defaultValue: 'No matching coverage was published in the past 7 days. Older stories remain in news history.' })}</p>}
    <ul className="intel-asset-news-list">{news.rows.slice(0, expanded ? 15 : 6).map(row => <li key={`${row.workspace ? 'private' : 'shared'}:${row.id}`}>
      <div className="intel-asset-news-meta"><time dateTime={row.published_at} title={new Date(row.published_at).toLocaleString()}>{new Date(row.published_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</time><span>{row.source_name}</span>{row.sentiment && <span>{row.sentiment}</span>}</div>
      {row.url ? <a href={row.url} target="_blank" rel="noopener noreferrer" className="intel-asset-news-title">{cleanNewsTitle(row.title)}</a> : <p className="intel-asset-news-title">{cleanNewsTitle(row.title)}</p>}
      {(row.why_it_matters || row.summary) && <details><summary>{t('asset_news.context', { defaultValue: 'Read context' })}</summary><p className="text-sm text-[var(--fg-3)] mt-2">{row.why_it_matters || row.summary}</p></details>}
    </li>)}</ul>
    {news.rows.length > 6 && <button className="text-xs underline underline-offset-4 py-3" onClick={() => setExpandedKey(expanded ? null : identity.key)}>{expanded ? t('asset_news.less', { defaultValue: 'Show fewer stories' }) : t('asset_news.more', { defaultValue: 'Show {{count}} more stories', count: news.rows.length - 6 })}</button>}
    {news.checkedAt && <p className="text-xs text-[var(--fg-4)] pt-2">{t('asset_news.checked', { defaultValue: 'Coverage checked' })} <time dateTime={news.checkedAt}>{new Date(news.checkedAt).toLocaleTimeString()}</time></p>}
  </section>
}
