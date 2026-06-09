import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, ChevronDown, ChevronUp } from 'lucide-react'
import { useSupabase } from '../../lib/useSupabase'
import { loadRegime } from '../lib/regime-api'

const LABEL = { risk_on: 'Risk-on', risk_off: 'Risk-off', btc_led: 'BTC-led', altcoin_rotation: 'Altcoin rotation', chop: 'No clear regime' }
const TONE = { risk_on: 'text-emerald-400', risk_off: 'text-red-400', btc_led: 'text-amber-400', altcoin_rotation: 'text-[var(--accent)]', chop: 'text-[var(--fg-3)]' }

// Shared market-regime context: what regime the market appears to be in, why,
// and what would confirm/invalidate it. One global read; expands for detail.
export default function RegimeBanner() {
  const { t } = useTranslation('intel')
  const { supabase } = useSupabase()
  const [r, setR] = useState(null)
  const [open, setOpen] = useState(false)
  useEffect(() => { let a = true; (async () => { try { const x = await loadRegime(supabase); if (a) setR(x) } catch { /* */ } })(); return () => { a = false } }, [supabase])
  if (!r) return null
  const m = r.majors || {}
  const pct = (v) => v == null ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(1)}%`
  return (
    <div className="card p-3">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-2 text-left flex-wrap">
        <Activity className="h-4 w-4 text-[var(--fg-4)]" />
        <span className="text-[10px] text-[var(--fg-4)] uppercase tracking-wide">{t('regime.eyebrow', { defaultValue: 'Market regime' })}</span>
        <span className={`text-[13px] font-semibold ${TONE[r.regime] || 'text-[var(--fg-1)]'}`}>{t(`regime.${r.regime}`, { defaultValue: LABEL[r.regime] || r.regime })}{r.flavor ? ` · ${r.flavor}` : ''}</span>
        <span className="chip">{r.confidence}</span>
        <span className="ml-auto text-[11px] text-[var(--fg-4)]">BTC {pct(m.btc)} · ETH {pct(m.eth)} · SOL {pct(m.sol)}{m.btc_dominance != null ? ` · ${t('regime.dominance', { defaultValue: 'dom' })} ${Number(m.btc_dominance).toFixed(1)}%` : ''}</span>
        {open ? <ChevronUp className="h-3.5 w-3.5 text-[var(--fg-4)]" /> : <ChevronDown className="h-3.5 w-3.5 text-[var(--fg-4)]" />}
      </button>
      {open && (
        <div className="mt-2 pt-2 border-t border-[color:var(--border-default)] space-y-2 text-[12px] text-[var(--fg-3)]">
          <p className="leading-relaxed">{r.rationale}</p>
          <div className="grid sm:grid-cols-2 gap-2">
            {r.what_confirms && <div><div className="text-[var(--ok)] text-[10px] uppercase">{t('regime.confirm', { defaultValue: 'Would confirm' })}</div><p>{r.what_confirms}</p></div>}
            {r.what_invalidates && <div><div className="text-red-400 text-[10px] uppercase">{t('regime.invalidate', { defaultValue: 'Would invalidate' })}</div><p>{r.what_invalidates}</p></div>}
          </div>
        </div>
      )}
    </div>
  )
}
