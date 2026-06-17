import React from 'react'
import { useTranslation } from 'react-i18next'
import { Compass, Waves, AlertTriangle } from 'lucide-react'

const fmtUsd = (n) => {
  const v = Number(n); if (!Number.isFinite(v) || v === 0) return null
  const a = Math.abs(v)
  if (a >= 1e12) return `$${(v / 1e12).toFixed(2)}T`
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}K`
  return `$${v.toFixed(0)}`
}

// "Today's picture" — a compact deterministic strip from the dashboard's already
// assembled intelligence_grounding (BriefEvidencePack), which shipped to the client
// 100% unread. Renders only the cleanly-typed fields (macro pulse, whale flows,
// coverage honesty); narrative_heat (raw rows, no titles) and regime (shown by
// RegimeBanner) are intentionally skipped. Render-only, no new fetch.
export default function TodaysPicture({ grounding }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  if (!grounding) return null
  const macro = (grounding.macro_rotation?.macro || [])[0] || null
  const totalMcap = macro ? fmtUsd(macro.total_market_cap_usd) : null
  const btcDom = macro && macro.btc_dominance_pct != null ? Number(macro.btc_dominance_pct) : null
  const mcapChg = macro && macro.market_cap_change_24h_pct != null ? Number(macro.market_cap_change_24h_pct) : null
  const flows = (grounding.flow_highlights || []).filter((f) => f && f.usd_value != null).slice(0, 3)
  const cov = grounding.data_coverage || null
  const warn = cov?.should_show_warning ? (cov.material_gaps || [])[0] : null
  const newsCount = (grounding.news_that_matters || []).length
  if (!totalMcap && btcDom == null && !flows.length && !warn) return null
  return (
    <section className="card p-3 space-y-2">
      <div className="eyebrow flex items-center gap-1.5"><Compass className="h-3.5 w-3.5" /> {t('pulse.todays_picture', { defaultValue: "Today's picture" })}</div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px]">
        {totalMcap && (
          <span><span className="text-[var(--fg-5)]">{t('pulse.total_mcap', { defaultValue: 'Total mcap' })} </span><span className="font-semibold text-[var(--fg-1)]">{totalMcap}</span>
            {mcapChg != null && <span className={`ml-1 ${mcapChg >= 0 ? 'text-[var(--ok)]' : 'text-red-400'}`}>{mcapChg >= 0 ? '+' : ''}{mcapChg.toFixed(1)}%</span>}
          </span>
        )}
        {btcDom != null && <span><span className="text-[var(--fg-5)]">{t('pulse.btc_dom', { defaultValue: 'BTC dom' })} </span><span className="font-semibold text-[var(--fg-1)]">{btcDom.toFixed(1)}%</span></span>}
        {newsCount > 0 && <span className="text-[var(--fg-4)]">{newsCount} {t('pulse.curated_stories', { defaultValue: 'curated stories' })}</span>}
        {flows.map((f, i) => (
          <span key={i} className="inline-flex items-center gap-1 text-[var(--fg-3)]" title={f.label || f.provider || ''}>
            <Waves className="h-3 w-3 text-[var(--accent)]" />
            {fmtUsd(f.usd_value)}{f.symbol ? ` ${f.symbol}` : ''}{f.direction ? ` ${String(f.direction).replace(/_/g, ' ')}` : ''}
          </span>
        ))}
      </div>
      {warn && <div className="text-[11px] text-amber-400 inline-flex items-center gap-1"><AlertTriangle className="h-3 w-3" />{warn}</div>}
    </section>
  )
}
