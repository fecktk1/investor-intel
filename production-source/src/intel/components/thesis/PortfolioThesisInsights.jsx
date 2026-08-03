import React, { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import { GitCompareArrows } from 'lucide-react'
import { getPortfolioThesisConflicts } from '../../lib/thesis-api'

// The 9 conflict insights — where the book and the stated theses diverge. Research
// context, never advice. Each renders only when it has items.
const CONFLICTS = [
  ['holdings_without_thesis', 'Holdings without a thesis', 'amber', (v) => (v || []).join(', ')],
  ['holdings_stale_thesis', 'Holdings with a stale thesis', 'amber', (v) => (v || []).map((x) => x.symbol).join(', ')],
  ['large_holding_weakening', 'Large holdings with a weakening thesis', 'err', (v) => (v || []).map((x) => `${x.symbol} (${x.allocation_pct}%)`).join(', ')],
  ['large_holding_invalidation_triggered', 'Large holdings with an invalidation triggered', 'err', (v) => (v || []).map((x) => `${x.symbol} (${x.allocation_pct}%)`).join(', ')],
  ['high_conviction_low_allocation', 'High conviction but low allocation', 'info', (v) => (v || []).map((x) => `${x.symbol} (${x.allocation_pct}%)`).join(', ')],
  ['low_conviction_high_allocation', 'Low conviction but high allocation', 'amber', (v) => (v || []).map((x) => `${x.symbol} (${x.allocation_pct}%)`).join(', ')],
  ['trades_without_thesis', 'Trades taken without a thesis', 'amber', (v) => (v || []).map((x) => x.symbol).join(', ')],
  ['exposure_increased_after_weakened', 'Exposure increased after the thesis weakened', 'err', (v) => (v || []).map((x) => x.symbol).join(', ')],
  ['allocation_conflicts_time_horizon', 'Allocation conflicts with the time horizon', 'amber', (v) => (v || []).map((x) => `${x.symbol} (${x.time_horizon})`).join(', ')],
]
const TONE = { amber: 'border-amber-400', err: 'border-red-400', info: 'border-[var(--accent)]' }

export default function PortfolioThesisInsights({ supabase, portfolioId }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    if (!portfolioId) { setLoading(false); return }
    getPortfolioThesisConflicts(supabase, portfolioId).then((d) => alive && setData(d)).catch(() => alive && setData(null)).finally(() => alive && setLoading(false))
    return () => { alive = false }
  }, [supabase, portfolioId])

  if (!portfolioId) return <div className="card--flat p-3 text-[12px] text-[var(--fg-4)]">{t('journal.conflicts_no_portfolio', { defaultValue: 'Link a portfolio to see where your holdings and theses diverge.' })}</div>
  if (loading) return <div className="card p-6 grid place-items-center"><div className="animate-spin rounded-full h-5 w-5 border-b-2 border-[var(--accent)]" /></div>

  const active = CONFLICTS.filter(([k]) => Array.isArray(data?.[k]) && data[k].length > 0)
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5"><GitCompareArrows className="h-3.5 w-3.5 text-[var(--accent)]" /><div className="eyebrow">{t('journal.conflicts', { defaultValue: 'Thesis ↔ portfolio conflicts' })}</div></div>
      {active.length === 0 ? (
        <div className="card--flat p-3 text-[12px] text-[var(--ok)]">{t('journal.conflicts_clear', { defaultValue: 'No conflicts detected — your book and your theses are aligned.' })}</div>
      ) : active.map(([k, label, tone, fmt]) => (
        <div key={k} className={`card--flat p-3 border-l-2 ${TONE[tone]}`}>
          <div className="text-[12px] text-[var(--fg-2)]">{t(`journal.conflict.${k}`, { defaultValue: label })}</div>
          <div className="text-[11px] text-[var(--fg-4)] mt-0.5">{fmt(data[k])}</div>
        </div>
      ))}
    </div>
  )
}
