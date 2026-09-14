import React from 'react'

const text = value => typeof value === 'string' ? value : ''
function sourceUrl(value) {
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null
  } catch { return null }
}

export default function EvidenceMarkerContext({ snapshot, t }) {
  if (!snapshot || typeof snapshot !== 'object' || !Object.keys(snapshot).length) return null
  const title = text(snapshot.title), summary = text(snapshot.summary)
  const url = sourceUrl(snapshot.url), published = Date.parse(snapshot.published_at)
  if (!title && !summary && !url) return null
  return <section className="intel-evidence-marker-context" aria-label={t('chart.saved_evidence', { defaultValue: 'Saved evidence' })}>
    <p className="intel-event-meta">{t('chart.saved_source_context', { defaultValue: 'Source context saved with this event' })}</p>
    {title && <h4>{title}</h4>}
    {text(snapshot.source) && <p className="intel-event-meta">{snapshot.source}</p>}
    {Number.isFinite(published) && <p className="intel-event-meta">{t('chart.source_published', { defaultValue: 'Source published' })}: <time dateTime={new Date(published).toISOString()}>{new Date(published).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'long' })}</time></p>}
    {summary && <details><summary>{t('chart.saved_source_summary', { defaultValue: 'Read saved source summary' })}</summary><p className="whitespace-pre-wrap break-words">{summary}{snapshot.summary_truncated ? '…' : ''}</p>{snapshot.summary_truncated && <p className="intel-event-meta">{t('chart.source_excerpt', { defaultValue: 'Saved excerpt. Open the source for its full text.' })}</p>}</details>}
    {url && <a className="intel-evidence-source-link" href={url} target="_blank" rel="noopener noreferrer">{t('chart.open_source', { defaultValue: 'Open source' })}</a>}
  </section>
}
