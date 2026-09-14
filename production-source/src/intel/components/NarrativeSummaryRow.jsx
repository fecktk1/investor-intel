import React from 'react'
import { Flame, Sprout, Users, Snowflake, TrendingUp, AlertTriangle } from 'lucide-react'
import { matchesTab } from '../lib/narrative-ui'

// Top summary row — the at-a-glance "what's happening" counts. Clicking a stat
// jumps to the matching tab.
const STATS = [
  { key: 'heating_up', tab: 'heating_up', label: 'Heating Up', Icon: Flame, cls: 'text-emerald-400' },
  { key: 'early', tab: 'early', label: 'Early', Icon: Sprout, cls: 'text-sky-400' },
  { key: 'crowded', tab: 'crowded', label: 'Crowded', Icon: Users, cls: 'text-amber-400' },
  { key: 'cooling', tab: 'cooling', label: 'Cooling', Icon: Snowflake, cls: 'text-amber-400' },
  { key: 'bullish', tab: 'bullish', label: 'Bullish', Icon: TrendingUp, cls: 'text-emerald-400' },
  { key: 'high_risk', tab: 'all', label: 'High Risk', Icon: AlertTriangle, cls: 'text-red-400' },
]

export default function NarrativeSummaryRow({ summary, narratives, onPick }) {
  const s = summary || {}
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-3 border-y border-[var(--border-default)] py-3" aria-label="Narrative counts in the loaded feed">
      {STATS.map(({ key, tab, label, Icon, cls }) => (
        <button key={key} onClick={() => onPick?.(tab)} disabled={key === 'high_risk'}
          className="flex items-center gap-2 text-left">
          <div className={`flex items-center gap-1.5 ${cls}`}><Icon className="h-3.5 w-3.5" /><span className="text-[10px] uppercase tracking-wide">{label}</span></div>
          <span className="font-semibold text-[var(--fg-1)] tabular-nums">{key !== 'high_risk' && Array.isArray(narratives) ? narratives.filter(row => matchesTab(row, tab)).length : (s[key] ?? '—')}</span>
        </button>
      ))}
    </div>
  )
}
