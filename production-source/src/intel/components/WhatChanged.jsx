import React from 'react'
import { History } from 'lucide-react'

// "What changed since your last visit" — deterministic, stored-data-only summaries
// (from the what_changed RPC). Research context, never advice. Renders nothing when
// there's nothing new.

const SEV_CLS = { high: 'chip--err', medium: 'chip--info', low: '' }
const KIND_LABEL = { alert: 'Alert', narrative: 'Narrative', signal: 'Signal', portfolio: 'Portfolio', wallet: 'Wallet' }

export default function WhatChanged({ items, title = 'What changed since your last visit', max = 6 }) {
  const list = Array.isArray(items) ? items.filter(Boolean) : []
  if (!list.length) return null
  return (
    <section className="card--flat p-3 space-y-2 border-l-2 border-[var(--accent)]">
      <div className="eyebrow flex items-center gap-1.5"><History className="h-3.5 w-3.5" /> {title}</div>
      <ul className="space-y-1">
        {list.slice(0, max).map((c, i) => (
          <li key={i} className="flex items-start gap-2 text-[12px] leading-snug">
            <span className={`chip text-[9px] ${SEV_CLS[c.severity] || ''} flex-shrink-0`}>{KIND_LABEL[c.kind] || c.kind}</span>
            <span className="text-[var(--fg-2)]"><b className="text-[var(--fg-1)]">{c.subject}</b>{c.summary ? ` — ${c.summary}` : ''}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
