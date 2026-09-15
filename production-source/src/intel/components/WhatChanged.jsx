import React, { useState } from 'react'
import { Link } from 'react-router'
import { History } from 'lucide-react'

const KIND_LABEL = { alert: 'Alert', narrative: 'Narrative', signal: 'Signal', portfolio: 'Portfolio', wallet: 'Wallet' }
const linkFor = item => item.kind === 'alert' ? '/intel/alerts' : item.kind === 'narrative' && item.ref ? `/intel/narratives/${encodeURIComponent(item.ref)}` : item.kind === 'signal' && item.ref ? `/intel/asset/${encodeURIComponent(item.ref)}` : null
const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : null

export default function WhatChanged({ items, context, loading = false, title = 'What changed since your last visit', max = 6 }) {
  const [expanded, setExpanded] = useState(false)
  const list = Array.isArray(items) ? items.filter(Boolean) : []
  if (!context && !loading && !list.length) return null
  const firstVisit = context?.firstVisit === true
  return (
    <section className="border-y border-[var(--border-default)] py-5 space-y-3" aria-busy={loading}>
      <div className="eyebrow flex items-center gap-2"><History className="h-3.5 w-3.5" />{firstVisit ? 'Your first reading baseline' : title}</div>
      {loading ? <p className="text-[13px] text-[var(--fg-4)]" role="status">Loading recorded changes…</p>
        : firstVisit ? <p className="text-[13px] text-[var(--fg-3)]">This is your first recorded visit in this workspace. Future visits will compare with this read{date(context.observedAt) ? ` from ${date(context.observedAt)}` : ''}.</p>
          : context?.coverage === 'unavailable' ? <p className="text-[13px] text-[var(--fg-3)]">Your previous reading baseline is unavailable. Current market sections remain available below.</p>
            : <>
              {context?.since && <p className="text-[11px] text-[var(--fg-4)]">Latest stored changes since {date(context.since)}. Includes alerts, followed narratives, and asset signal changes.</p>}
              {!list.length && <p className="text-[13px] text-[var(--fg-3)]">No new changes in the stored sources checked for this read.</p>}
              <ul className="divide-y divide-[var(--border-subtle)]">
                {list.slice(0, expanded ? list.length : max).map((c, i) => {
                  const href = linkFor(c)
                  return <li key={`${c.kind}:${c.ref || c.subject}:${c.at}:${i}`} className="grid gap-1 py-3 sm:grid-cols-[80px_1fr_auto] text-[13px] leading-relaxed">
                    <span className={`text-[10px] uppercase tracking-wider ${c.severity === 'high' ? 'text-[var(--signal-red)]' : 'text-[var(--fg-4)]'}`}>{KIND_LABEL[c.kind] || c.kind}</span>
                    <div>{href ? <Link className="font-medium text-[var(--fg-1)] hover:text-[var(--accent)]" to={href}>{c.subject}</Link> : <b className="text-[var(--fg-1)]">{c.subject}</b>}{c.summary && <p className="text-[var(--fg-3)]">{c.summary}</p>}</div>
                    {date(c.at) && <time dateTime={c.at} className="text-[11px] text-[var(--fg-4)]">{date(c.at)}</time>}
                  </li>
                })}
              </ul>
              {list.length > max && <button className="btn btn--quiet btn--sm" onClick={() => setExpanded(v => !v)}>{expanded ? 'Show less' : `Show all ${list.length} changes`}</button>}
            </>}
    </section>
  )
}
