import React from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRight } from 'lucide-react'
import ConfidenceChip from './ConfidenceChip'
import { fmtPrice, bucketConfidence } from '../lib/market-format'
import { spreadReadState } from '../lib/spread-quality'

const LABELS = { binance: 'Binance', coinbase: 'Coinbase', kraken: 'Kraken', kucoin: 'KuCoin' }

// One cross-exchange spread row. INFORMATIONAL ONLY — never buy/sell, never
// "arbitrage", never a profit promise. Shows the discrepancy + estimated net
// (labeled estimate) + caution flags. Accepts the snake_case DB row shape.
export default function CrossExchangeSpreadCard({ spread }) {
  if (!spread) return null
  const status = spreadReadState(spread)
  return status ? <details className="intel-evidence-expand border-b border-[var(--border-default)] py-3">
    <summary>{spread.normalized_symbol} · {status}</summary>
    <SpreadObservation spread={spread} />
  </details> : <SpreadObservation spread={spread} />
}

function SpreadObservation({ spread }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  if (!spread) return null
  const net = spread.estimated_net_spread_pct
  const gross = spread.gross_spread_pct
  const flags = Array.isArray(spread.caution_flags) ? spread.caution_flags : []
  return (
    <div className="card--flat p-2.5 space-y-1.5">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-[13px] font-medium text-[var(--fg-1)]">{spread.normalized_symbol}</span>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-[var(--fg-5)]">{t('market.spread.gross', { defaultValue: 'Gross' })} {gross != null ? `${Number(gross).toFixed(2)}%` : '—'}</span>
          <span className="chip text-[10px] chip--info">{t('market.spread.net_est', { defaultValue: 'Est. net' })} {net != null ? `${Number(net).toFixed(2)}%` : '—'}</span>
          {spread.confidence_score != null && <ConfidenceChip value={bucketConfidence(spread.confidence_score)} />}
        </div>
      </div>
      <div className="flex items-center gap-2 text-[11px] text-[var(--fg-3)] flex-wrap">
        <span>{t('market.spread.lower_on', { defaultValue: 'Lower on' })} <strong>{LABELS[spread.buy_provider] || spread.buy_provider}</strong> {spread.buy_provider_symbol} · {fmtPrice(spread.lowest_ask_price)}</span>
        <ArrowRight className="h-3 w-3 text-[var(--fg-5)]" />
        <span>{t('market.spread.higher_on', { defaultValue: 'Higher on' })} <strong>{LABELS[spread.sell_provider] || spread.sell_provider}</strong> {spread.sell_provider_symbol} · {fmtPrice(spread.highest_bid_price)}</span>
      </div>
      {flags.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap">
          {flags.map((f) => <span key={f} className="text-[10px] text-[var(--fg-4)]">{f}</span>)}
        </div>
      )}
      {spread.as_of && <p className="text-[10px] text-[var(--fg-4)]">Observed <time dateTime={spread.as_of}>{new Date(spread.as_of).toLocaleString(undefined, { timeZoneName: 'short' })}</time></p>}
    </div>
  )
}
