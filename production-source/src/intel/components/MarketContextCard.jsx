import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, ChevronDown, ChevronUp, Database } from 'lucide-react'
import MarketSignalBadge from './MarketSignalBadge'
import ProviderCoveragePill from './ProviderCoveragePill'
import ConfidenceChip from './ConfidenceChip'
import { fmtPct, fmtVol, bucketConfidence, pctClass } from '../lib/market-format'

// Exchange-backed market context, modeled on RegimeBanner: a collapsed one-liner
// that expands to metrics + "why it matters". Market signal only — never advice.
// Renders nothing when there's no usable exchange data (no pair), so callers can
// drop it in unconditionally.
export default function MarketContextCard({ ctx, variant = 'flat', compact = false }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const [open, setOpen] = useState(false)
  if (!ctx || !ctx.rawMetrics?.pair) return null

  const m = ctx.rawMetrics || {}
  const dir = ctx.direction || 'neutral'
  const confirming = ctx.confirmingProviders || []

  if (compact) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <MarketSignalBadge direction={dir} size="sm" />
        <span className={`text-[11px] ${pctClass(m.priceChangePercent24h)}`}>{fmtPct(m.priceChangePercent24h)}</span>
      </span>
    )
  }

  const frame = variant === 'card' ? 'card p-3' : 'card--flat p-2.5'
  return (
    <div className={`${frame} space-y-1.5`}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between gap-2 text-left">
        <span className="flex items-center gap-1.5 min-w-0">
          <Database className="h-3 w-3 text-[var(--fg-5)] shrink-0" />
          <span className="text-[10px] uppercase tracking-wide text-[var(--fg-5)]">{t('market.source', { defaultValue: 'Exchange' })}</span>
          <span className="text-[11px] font-mono text-[var(--fg-3)] truncate">{m.pair}</span>
          <MarketSignalBadge direction={dir} size="sm" />
        </span>
        <span className="flex items-center gap-2 shrink-0">
          <span className={`text-[11px] font-medium ${pctClass(m.priceChangePercent24h)}`}>{fmtPct(m.priceChangePercent24h)}</span>
          {open ? <ChevronUp className="h-3.5 w-3.5 text-[var(--fg-5)]" /> : <ChevronDown className="h-3.5 w-3.5 text-[var(--fg-5)]" />}
        </span>
      </button>

      {open && (
        <div className="border-t border-[var(--border)] pt-2 space-y-2">
          <div className="grid grid-cols-3 gap-2">
            <Metric label={t('market.change_24h', { defaultValue: '24h change' })} value={fmtPct(m.priceChangePercent24h)} cls={pctClass(m.priceChangePercent24h)} />
            <Metric label={t('market.quote_volume', { defaultValue: 'Quote volume' })} value={fmtVol(m.quoteVolume24h)} />
            <Metric label={t('market.spread', { defaultValue: 'Spread' })} value={m.spreadPercent != null ? `${Number(m.spreadPercent).toFixed(3)}%` : '—'} />
          </div>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-1.5">
              <Activity className="h-3 w-3 text-[var(--fg-5)]" />
              <span className="text-[10px] text-[var(--fg-5)]">{t('market.strength', { defaultValue: 'Strength' })} {Math.round(ctx.strength ?? 0)}</span>
              <span className="inline-block h-1.5 w-16 rounded-full bg-[var(--bg-3)] overflow-hidden align-middle"><span className="block h-full" style={{ width: `${Math.max(0, Math.min(100, ctx.strength ?? 0))}%`, background: dir === 'caution' ? 'var(--warn, #f59e0b)' : dir === 'bearish' ? 'var(--err, #f87171)' : 'var(--ok)' }} /></span>
            </div>
            {ctx.confidence != null && <ConfidenceChip value={bucketConfidence(ctx.confidence)} />}
          </div>
          {confirming.length > 0 && <ProviderCoveragePill providers={confirming} confirming={confirming} size="sm" />}
          {(ctx.whyItMatters || ctx.summary) && <p className="text-[11px] text-[var(--fg-3)] leading-relaxed">{ctx.whyItMatters || ctx.summary}</p>}
        </div>
      )}
    </div>
  )
}

function Metric({ label, value, cls }) {
  return (
    <div>
      <div className="text-[9px] uppercase text-[var(--fg-5)]">{label}</div>
      <div className={`text-[12px] ${cls || 'text-[var(--fg-2)]'}`}>{value}</div>
    </div>
  )
}
