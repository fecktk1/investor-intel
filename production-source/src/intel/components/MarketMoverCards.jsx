import React from 'react'
import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import MarketSignalBadge from './MarketSignalBadge'
import { fmtPct, fmtVol, pctClass } from '../lib/market-format'

// Quality-ranked movers (the page ranks them by volume+liquidity+quality, NOT
// raw %). Clickable into the asset detail when `hrefFor` is provided.
export default function MarketMoverCards({ title, items = [], icon: Icon, hrefFor = null, returnState }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  return (
    <section className="space-y-2">
      <div className="eyebrow flex items-center gap-1.5">{Icon && <Icon className="h-3.5 w-3.5" />} {title}</div>
      {items.length === 0 ? (
        <div className="card--flat p-3 text-[12px] text-[var(--fg-4)]">{t('markets.noMovers', { defaultValue: 'No confirmed movers right now.' })}</div>
      ) : (
        <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
          {items.slice(0, 10).map((r, index) => {
            const href = hrefFor?.(r.symbol, r)
            const key = r.providerId != null ? `${r.sourceProvider}:${r.providerId}` : r.canonicalAssetKey || `unidentified:${index}`
            const inner = (
              <div className="card p-2.5 hover:bg-[var(--bg-2)] transition-colors h-full">
                <div className="flex items-center justify-between gap-1">
                  <span className="text-[13px] font-medium text-[var(--fg-1)]">{r.symbol}</span>
                  {r.signalDirection && <MarketSignalBadge direction={r.signalDirection} size="sm" />}
                </div>
                <div className={`text-[12px] font-semibold ${pctClass(r.change24hPct)}`}>{fmtPct(r.change24hPct)}</div>
                <div className="text-[10px] text-[var(--fg-5)]">{fmtVol(r.volumeQuote24h)}</div>
              </div>
            )
            return href ? <Link key={key} to={href} state={returnState} className="block">{inner}</Link> : <div key={key}>{inner}</div>
          })}
        </div>
      )}
    </section>
  )
}
