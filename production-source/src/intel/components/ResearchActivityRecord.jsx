import React from 'react'
import { chartEventChanges } from '../lib/chart-event-changes'

const label = value => String(value).replaceAll('_', ' ')
const words = value => value == null || value === '' ? '—' : Array.isArray(value) ? value.map(words).join(', ') : typeof value === 'object' ? Object.entries(value).map(([key, item]) => `${label(key)}: ${words(item)}`).join('\n') : String(value)

export function ResearchActivityWords({ event }) {
  const text = typeof event.textSnapshot === 'string' ? event.textSnapshot : Object.keys(event.textSnapshot || {}).length ? words(event.textSnapshot) : words(event.notes || event.note || 'No original words recorded')
  return <div className="intel-research-activity-words">
    {text.length > 140 ? <details><summary>{text.slice(0, 120).trimEnd()}… <span className="intel-text-link">Read note</span></summary><blockquote>{text}</blockquote></details> : <span>{text}</span>}
    {event.linkedResearch?.length > 0 && <details><summary>{event.linkedResearch.length} linked journal {event.linkedResearch.length === 1 ? 'record' : 'records'}</summary>{event.linkedResearch.map(record => <section key={record.id}><p>{record.label}</p><ResearchActivityWords event={record}/></section>)}</details>}
  </div>
}

export function ResearchActivityChanges({ changes }) {
  const entries = Object.entries(chartEventChanges(changes))
  if (!entries.length) return '—'
  const isDelta = value => value && typeof value === 'object' && ('before' in value || 'after' in value)
  const describe = change => isDelta(change) ? `${words(change.before)} → ${words(change.after)}` : words(change)
  const status = entries.find(([key]) => key === 'status')
  return <details className="intel-research-activity-changes"><summary>{status ? describe(status[1]) : `${entries.length} recorded ${entries.length === 1 ? 'change' : 'changes'}`}</summary><dl>{entries.map(([key, change]) => <div key={key}><dt>{label(key)}</dt><dd>{describe(change)}</dd></div>)}</dl></details>
}
