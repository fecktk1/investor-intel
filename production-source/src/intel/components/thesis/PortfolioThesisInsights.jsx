import React, { useEffect, useState } from 'react'
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
  ['exposure_increased_after_weakened', 'Recorded journal additions after weakening', 'err', (v) => (v || []).map((x) => x.symbol).join(', ')],
  ['allocation_conflicts_time_horizon', 'Allocation conflicts with the time horizon', 'amber', (v) => (v || []).map((x) => `${x.symbol} (${x.time_horizon})`).join(', ')],
]
const TONE = { amber: 'border-amber-400', err: 'border-red-400', info: 'border-[var(--accent)]' }

export default function PortfolioThesisInsights(props) {return <Insights key={props.portfolioId||'none'} {...props}/>}
function Insights({ supabase, portfolioId }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,setError]=useState(null),[revision,setRevision]=useState(0)

  useEffect(() => {
    let alive = true
    if (!portfolioId) { setLoading(false); return }
    setLoading(true);setError(null)
    getPortfolioThesisConflicts(supabase, portfolioId).then((d) => {if(!d||!CONFLICTS.every(([key])=>Array.isArray(d[key])))throw Error('Portfolio conflict coverage could not be loaded.');if(alive)setData(d)}).catch(e=>{if(alive)setError(e.message)}).finally(() => alive && setLoading(false))
    return () => { alive = false }
  }, [supabase, portfolioId,revision])

  if (!portfolioId) return <p className="intel-analysis-caption">{t('journal.conflicts_no_portfolio', { defaultValue: 'Link a portfolio to see where your holdings and theses diverge.' })}</p>
  if (loading) return <p role="status">Loading portfolio insights…</p>
  if(error)return <div><p role="alert">{error}</p><button className="btn" onClick={()=>setRevision(v=>v+1)}>Retry portfolio insights</button></div>

  const active = CONFLICTS.filter(([k]) => Array.isArray(data?.[k]) && data[k].length > 0)
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5"><GitCompareArrows className="h-3.5 w-3.5 text-[var(--accent)]" /><div className="eyebrow">{t('journal.conflicts', { defaultValue: 'Thesis ↔ portfolio conflicts' })}</div></div>
      {data?.coverage&&<p className="intel-analysis-caption">{data.coverage.holdings} holdings checked · {data.coverage.unresolved_identity} unresolved identities · {data.coverage.missing_value} missing values · {data.coverage.missing_allocation} missing allocations. Journal additions describe recorded research activity; they do not verify portfolio balance changes.</p>}
      {active.length === 0 ? (
        <p className="intel-analysis-caption">No conflicts found in the available, matched records.</p>
      ) : active.map(([k, label, tone, fmt]) => (
        <div key={k} className="border-t border-[var(--border-default)] py-2">
          <div className="text-[12px] text-[var(--fg-2)]">{k==='exposure_increased_after_weakened'?label:t(`journal.conflict.${k}`, { defaultValue: label })}</div>
          <div className="text-[11px] text-[var(--fg-4)] mt-0.5">{fmt(data[k])}</div>
        </div>
      ))}
    </div>
  )
}
