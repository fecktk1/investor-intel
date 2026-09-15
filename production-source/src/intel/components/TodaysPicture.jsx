import React from 'react'
import { useTranslation } from 'react-i18next'
import { Compass, Waves, AlertTriangle } from 'lucide-react'
import { formatUsd } from '../lib/market-format'

// Unreadable values must stay null (not an em dash) so the strip can tell a
// missing fact from a zero one and hide the row entirely.
const fmtUsd = (n) => {
  if(n==null||n===''||typeof n==='boolean')return null
  const v = Number(n); if (!Number.isFinite(v)) return null
  return formatUsd(v)
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
  const warn = (cov?.material_gaps || [])[0] || null
  const newsCount = (grounding.news_that_matters || []).length
  const failures=Object.keys(grounding.read_states||{}).filter(k=>grounding.read_states[k].state==='error')
  if (!totalMcap && btcDom == null && !flows.length && !warn && !failures.length) return null
  return (
    <section className="border-y border-[var(--border-default)] py-4 space-y-2">
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
      {macro?.as_of&&Number.isFinite(Date.parse(macro.as_of))&&<p className="text-xs text-[var(--fg-4)]">{t('pulse.macro_observed',{defaultValue:'Macro observed'})} <time dateTime={macro.as_of}>{new Date(macro.as_of).toLocaleString(undefined,{timeZoneName:'short'})}</time></p>}
      {failures.includes('flows')&&<p role="alert" className="text-xs">{t('pulse.flows_read_failed',{defaultValue:'Transfer highlights could not be read. This does not mean there were no transfers.'})}</p>}
      {failures.includes('news')&&<p role="alert" className="text-xs">{t('pulse.picture_news_failed',{defaultValue:'Recent story context could not be read.'})}</p>}
      {!!flows.length&&<details className="text-xs"><summary>{t('pulse.flow_source_times',{defaultValue:'Transfer source times'})}</summary>{flows.map((f,i)=><p key={i}>{f.symbol||f.chain} · {f.observed_at&&Number.isFinite(Date.parse(f.observed_at))?<time dateTime={f.observed_at}>{new Date(f.observed_at).toLocaleString(undefined,{timeZoneName:'short'})}</time>:t('pulse.time_unavailable',{defaultValue:'Observation time unavailable'})}</p>)}</details>}
      {warn && <div className="text-[11px] text-amber-400 inline-flex items-center gap-1"><AlertTriangle className="h-3 w-3" />{warn}</div>}
    </section>
  )
}
