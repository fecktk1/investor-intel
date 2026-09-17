import React from 'react'
import { useTranslation } from 'react-i18next'
import { Layers } from 'lucide-react'
import { fmtVol, timeAgo } from '../lib/market-format'

const PROVIDER_LABELS = { binance: 'Binance', coinbase: 'Coinbase', kraken: 'Kraken', kucoin: 'KuCoin' }

// Aggregated CEX order-book depth across providers (from intel-markets d.orderbook,
// already returned but never drawn). Render-only — informational, not a quote.
export default function OrderbookDepthCard({ orderbook }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  if (!orderbook || !orderbook.providers?.length) return null
  const bid = Number(orderbook.totalBidDepthUsd) || 0
  const ask = Number(orderbook.totalAskDepthUsd) || 0
  const total = bid + ask
  const bidPct = total > 0 ? Math.round((bid / total) * 100) : 50
  return (
    <section className="card p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Layers className="h-3.5 w-3.5 text-[var(--accent)]" />
        <span className="text-[13px] font-semibold text-[var(--fg-1)]">{t('markets.orderbookDepth', { defaultValue: 'Order-book depth' })}</span>
        <span className="text-[10px] text-[var(--fg-5)]">{orderbook.providerCount} {t('markets.exchanges', { defaultValue: 'exchanges' })}{orderbook.asOf ? ` · ${timeAgo(orderbook.asOf)}` : ''}</span>
      </div>
      <div className="grid gap-2 grid-cols-2 sm:grid-cols-4">
        <div className="card--flat p-2.5"><div className="text-[10px] text-[var(--fg-4)] uppercase">{t('markets.bidDepth', { defaultValue: 'Bid depth' })}</div><div className="text-sm font-semibold text-emerald-400">{fmtVol(bid)}</div></div>
        <div className="card--flat p-2.5"><div className="text-[10px] text-[var(--fg-4)] uppercase">{t('markets.askDepth', { defaultValue: 'Ask depth' })}</div><div className="text-sm font-semibold text-red-400">{fmtVol(ask)}</div></div>
        <div className="card--flat p-2.5"><div className="text-[10px] text-[var(--fg-4)] uppercase">{t('markets.minSpread', { defaultValue: 'Min spread' })}</div><div className="text-sm font-semibold text-[var(--fg-1)]">{orderbook.minSpreadPct != null ? `${Number(orderbook.minSpreadPct).toFixed(3)}%` : '—'}</div></div>
        <div className="card--flat p-2.5"><div className="text-[10px] text-[var(--fg-4)] uppercase">{t('markets.deepest', { defaultValue: 'Deepest book' })}</div><div className="text-sm font-semibold text-[var(--fg-1)] truncate">{PROVIDER_LABELS[orderbook.bestDepthProvider] || orderbook.bestDepthProvider || '—'}</div></div>
      </div>
      <div className="space-y-1">
        <div className="flex h-2 rounded overflow-hidden bg-[var(--bg-3)]">
          <div className="bg-emerald-500/70" style={{ width: `${bidPct}%` }} />
          <div className="bg-red-500/70" style={{ width: `${100 - bidPct}%` }} />
        </div>
        <div className="text-[10px] text-[var(--fg-5)]">{t('markets.bookBalance', { defaultValue: 'Book balance' })}: {bidPct}% {t('markets.bid', { defaultValue: 'bid' })} / {100 - bidPct}% {t('markets.ask', { defaultValue: 'ask' })}</div>
      </div>
      <div className="space-y-1">
        {orderbook.providers.slice(0, 6).map((p) => (
          <div key={p.provider} className="flex items-center justify-between gap-2 text-[11px]">
            <span className="chip text-[10px]">{PROVIDER_LABELS[p.provider] || p.provider}</span>
            <span className="flex items-center gap-3">
              <span className="text-emerald-400/90">{fmtVol(p.bidDepthUsd)}</span>
              <span className="text-red-400/90">{fmtVol(p.askDepthUsd)}</span>
              {p.imbalancePct != null && <span className={p.imbalancePct >= 0 ? 'text-emerald-400' : 'text-red-400'}>{p.imbalancePct >= 0 ? '+' : ''}{Number(p.imbalancePct).toFixed(0)}%</span>}
            </span>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-[var(--fg-5)]">{t('markets.orderbookNote', { defaultValue: 'Aggregated top-of-book depth. Informational, not a tradable quote.' })}</p>
    </section>
  )
}
