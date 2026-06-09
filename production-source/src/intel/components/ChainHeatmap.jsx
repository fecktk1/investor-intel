import React from 'react'
import { useTranslation } from 'react-i18next'
import { Flame } from 'lucide-react'
import { fmtPct, fmtVol, pctClass } from '../lib/market-format'

// Ecosystem heat from exchange-listed assets (snake_case rows from
// exchange_latest_chain_rollups).
export default function ChainHeatmap({ chains = [] }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  if (!chains?.length) return null
  const sorted = [...chains].sort((a, b) => (b.avg_change_24h_pct ?? -999) - (a.avg_change_24h_pct ?? -999))
  return (
    <section className="space-y-2">
      <div className="eyebrow flex items-center gap-1.5"><Flame className="h-3.5 w-3.5" /> {t('markets.chainHeat', { defaultValue: 'Chain / ecosystem heat' })}</div>
      <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
        {sorted.map((c) => (
          <div key={c.chain} className="card p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-[var(--fg-1)] capitalize truncate">{c.chain}</span>
              {c.avg_change_24h_pct != null && <span className={`text-[12px] font-semibold ${pctClass(c.avg_change_24h_pct)}`}>{fmtPct(c.avg_change_24h_pct)}</span>}
            </div>
            <div className="text-[10px] text-[var(--fg-4)] mt-0.5">{t('markets.trackedVolume', { defaultValue: 'Vol' })} {fmtVol(c.total_volume_quote_24h)}</div>
            <div className="flex items-center gap-1 mt-1 flex-wrap">
              {c.bullish_count > 0 && <span className="chip text-[9px] chip--ok">{c.bullish_count}↑</span>}
              {c.bearish_count > 0 && <span className="chip text-[9px] chip--err">{c.bearish_count}↓</span>}
              {c.caution_count > 0 && <span className="chip text-[9px] text-amber-400">{c.caution_count}!</span>}
            </div>
            {c.top_mover_symbol && <div className="text-[10px] text-[var(--fg-5)] mt-1">{t('markets.topMover', { defaultValue: 'Top' })}: {c.top_mover_symbol} <span className={pctClass(c.top_mover_change_pct)}>{fmtPct(c.top_mover_change_pct)}</span></div>}
          </div>
        ))}
      </div>
    </section>
  )
}
