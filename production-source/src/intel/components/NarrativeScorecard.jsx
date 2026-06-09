import React from 'react'
import { SCORE_FIELDS, scoreColor, riskColor } from '../lib/narrative-ui'

// A labeled 0–100 mini-bar. Risk/crowding are inverted (high = bad → red).
function Bar({ label, value, invert }) {
  const v = typeof value === 'number' ? Math.max(0, Math.min(100, value)) : null
  const color = invert ? riskColor(v) : scoreColor(v)
  return (
    <div>
      <div className="flex items-center justify-between text-[10px] text-[var(--fg-4)] mb-0.5">
        <span>{label}</span>
        <span className="tabular-nums text-[var(--fg-3)]">{v == null ? '—' : Math.round(v)}</span>
      </div>
      <div className="h-1.5 rounded-full bg-[var(--bg-3,#1c1c1c)] overflow-hidden">
        {v != null && <div className={`h-full ${color}`} style={{ width: `${v}%` }} />}
      </div>
    </div>
  )
}

// Full 9-score grid (detail page). `compact` shows only the headline four (cards).
export default function NarrativeScorecard({ n, compact = false }) {
  const fields = compact
    ? SCORE_FIELDS.filter((f) => ['momentum_score', 'chatter_score', 'confidence_score', 'risk_score'].includes(f.key))
    : SCORE_FIELDS
  return (
    <div className={`grid gap-x-4 gap-y-2 ${compact ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-2 sm:grid-cols-3'}`}>
      {fields.map((f) => <Bar key={f.key} label={f.label} value={n?.[f.key]} invert={f.invert} />)}
    </div>
  )
}
