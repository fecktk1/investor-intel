import React, { useEffect, useState } from 'react'
import { ShieldCheck, ShieldAlert, ShieldX } from 'lucide-react'
import { useSupabase } from '../../lib/useSupabase'

// v3.1 Batch 6 UI: token risk badge. Self-fetches the latest deterministic risk
// score (Birdeye token_security + CoinGecko GT cross-check) from
// token_risk_scores (global-read RLS) by symbol. Renders nothing if unscored.
export default function TokenRiskBadge({ symbol, chain }) {
  const { supabase } = useSupabase()
  const [row, setRow] = useState(null)

  useEffect(() => {
    let alive = true
    const sym = String(symbol || '').toUpperCase()
    if (!sym || !supabase) return
    ;(async () => {
      try {
        const { data } = await supabase
          .from('token_risk_scores')
          .select('score, hard_fail, hard_fail_flags, penalties, cross_provider_confidence, symbol, computed_at')
          .eq('symbol', sym)
          .order('computed_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        if (alive) setRow(data || null)
      } catch { /* global-read; absent table/row → no badge */ }
    })()
    return () => { alive = false }
  }, [supabase, symbol, chain])

  if (!row || typeof row.score !== 'number') return null
  const danger = row.hard_fail || row.score < 40
  const warn = !danger && row.score < 70
  const cls = danger ? 'chip chip--err' : warn ? 'chip chip--info' : 'chip chip--ok'
  const Icon = danger ? ShieldX : warn ? ShieldAlert : ShieldCheck
  const flags = (row.hard_fail_flags || []).join(', ')
  const concerns = Object.keys(row.penalties || {}).join(', ')
  const conf = row.cross_provider_confidence != null ? ` · confidence ${row.cross_provider_confidence}` : ''
  const title = `Token risk ${row.score}/100${row.hard_fail && flags ? ` — HIGH RISK: ${flags}` : ''}${concerns ? ` · concerns: ${concerns}` : ''}${conf}. Deterministic (Birdeye security + CoinGecko GT). Not advice.`

  return (
    <span className={`${cls} text-[11px] inline-flex items-center`} title={title}>
      <Icon className="h-3.5 w-3.5 mr-1" />
      {row.hard_fail ? 'High risk' : `Risk ${row.score}/100`}
    </span>
  )
}
