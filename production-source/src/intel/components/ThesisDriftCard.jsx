import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { NotebookPen, ArrowRight } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'

// Thesis drift card for asset pages — deterministic (no AI): shows whether the
// current stored data supports / weakens / does not affect the user's saved
// thesis for this asset. Renders nothing when no thesis exists. Research context
// to help users review their own reasoning — never advice.

const DRIFT_CLS = { supports: 'chip--ok', weakens: 'chip--err', no_effect: '', unknown: '' }
const DRIFT_LABEL = {
  supports: 'Current data supports this thesis',
  weakens: 'Current data weakens this thesis',
  no_effect: 'No material effect on this thesis',
  unknown: 'Not enough data to compare yet',
}

export default function ThesisDriftCard({ symbol }) {
  const { org } = useProfile()
  const { supabase } = useSupabase()
  const [theses, setTheses] = useState(null)

  useEffect(() => {
    let alive = true
    if (!org?.id || !symbol) return
    ;(async () => {
      try {
        const { data } = await supabase.from('intel_theses')
          .select('id, title, drift_state, drift_detail, needs_review, last_drift_at, entity:entities!inner(display_symbol)')
          .eq('org_id', org.id)
        const sym = String(symbol).toUpperCase().replace(/^\$/, '')
        const mine = (data || []).filter((t) => String(t.entity?.display_symbol || '').toUpperCase() === sym)
        if (alive) setTheses(mine)
      } catch { if (alive) setTheses([]) }
    })()
    return () => { alive = false }
  }, [org?.id, supabase, symbol])

  if (!theses?.length) return null
  return (
    <section className="card p-4 space-y-2">
      <div className="flex items-center justify-between">
        <div className="eyebrow flex items-center gap-1.5"><NotebookPen className="h-3.5 w-3.5" /> Your thesis on this asset</div>
        <Link to="/intel/theses" className="text-[12px] text-[var(--accent)] flex items-center gap-1">Thesis Tracker <ArrowRight className="h-3 w-3" /></Link>
      </div>
      {theses.slice(0, 2).map((th) => (
        <div key={th.id} className="card--flat p-3 space-y-1">
          <div className="text-[13px] font-medium text-[var(--fg-1)]">{th.title}</div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`chip text-[10px] ${DRIFT_CLS[th.drift_state] || ''}`}>{DRIFT_LABEL[th.drift_state] || DRIFT_LABEL.unknown}</span>
            {th.needs_review && <span className="chip chip--err text-[10px]">Needs review</span>}
            {Array.isArray(th.drift_detail?.drivers) && th.drift_detail.drivers.slice(0, 2).map((d, i) => <span key={i} className="chip text-[9px] text-[var(--fg-4)]">{d}</span>)}
          </div>
          {th.last_drift_at && <div className="text-[10px] text-[var(--fg-5)]">Compared {new Date(th.last_drift_at).toLocaleString()} · research context, not advice</div>}
        </div>
      ))}
    </section>
  )
}
