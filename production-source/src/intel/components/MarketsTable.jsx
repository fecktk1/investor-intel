import React from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import MarketSignalBadge from './MarketSignalBadge'
import ProviderCoveragePill from './ProviderCoveragePill'
import TokenAvatar from './TokenAvatar'
import { fmtPrice, fmtPct, fmtVol, pctClass } from '../lib/market-format'

// CMC-style markets terminal row (responsive flex rows — no table lib, matching
// the app idiom). Canonical fields (rank/price/mcap/FDV/changes) come from
// market_assets; CEX availability + spread/arb come from enrichment. Sorting is
// server-side; this is presentation only. Logos via TokenAvatar (clean fallback).
export default function MarketsTable({ rows = [], pageOffset = 0, linkBase = '/intel', assetPath = null }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const location = useLocation()
  const returnState = { from: `${location.pathname}${location.search}` }
  if (!rows.length) return <div className="card p-6 text-center text-[13px] text-[var(--fg-4)]">{t('markets.noData', { defaultValue: 'Market data is being gathered. Check back shortly.' })}</div>
  return (
    <div className="space-y-1.5">
      <div className="hidden md:flex items-center gap-3 px-2.5 text-[10px] uppercase text-[var(--fg-5)]">
        <span className="w-8 text-right">#</span>
        <span className="flex-1">{t('markets.asset', { defaultValue: 'Asset' })}</span>
        <span className="w-20 text-right">{t('markets.priceLabel', { defaultValue: 'Price' })}</span>
        <span className="hidden lg:block w-14 text-right">1h</span>
        <span className="w-14 text-right">24h</span>
        <span className="hidden lg:block w-14 text-right">7d</span>
        <span className="w-20 text-right">{t('markets.volLabel', { defaultValue: 'Volume' })}</span>
        <span className="w-20 text-right">{t('markets.marketCap', { defaultValue: 'Mkt cap' })}</span>
        <span className="hidden xl:block w-20 text-right">{t('markets.fdv', { defaultValue: 'FDV' })}</span>
        <span className="w-40 text-right">{t('markets.exchanges', { defaultValue: 'Exchanges' })}</span>
      </div>
      {rows.map((r, i) => {
        const rank = r.rank != null ? r.rank : pageOffset + i + 1
        const cex = r.cex || null
        const availCount = cex ? (cex.availableCount || 0) : 0
        const inner = (
          <div className="card--flat p-2.5 w-full flex items-center gap-3 hover:bg-[var(--bg-2)] transition-colors">
            <span className="w-8 text-right text-[11px] text-[var(--fg-5)]">{rank}</span>
            <div className="flex-1 min-w-0 flex items-center gap-2">
              <TokenAvatar src={r.imageUrl} symbol={r.symbol} name={r.displayName} size="md" />
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-[var(--fg-1)] truncate flex items-center gap-1.5">
                  {r.symbol}
                  {r.displayName ? <span className="text-[11px] text-[var(--fg-4)] truncate hidden sm:inline">{r.displayName}</span> : null}
                  {r.chain ? <span className="text-[9px] text-[var(--fg-5)] px-1 rounded bg-[var(--bg-3)]">{r.chain}</span> : null}
                </div>
                <div className="md:hidden text-[11px] text-[var(--fg-4)]">{fmtPrice(r.price)} · <span className={pctClass(r.change24hPct)}>{fmtPct(r.change24hPct)}</span></div>
              </div>
            </div>
            <span className="hidden md:block w-20 text-right text-[12px] text-[var(--fg-2)]">{fmtPrice(r.price)}</span>
            <span className={`hidden lg:block w-14 text-right text-[12px] ${pctClass(r.change1hPct)}`}>{fmtPct(r.change1hPct)}</span>
            <span className={`hidden md:block w-14 text-right text-[12px] ${pctClass(r.change24hPct)}`}>{fmtPct(r.change24hPct)}</span>
            <span className={`hidden lg:block w-14 text-right text-[12px] ${pctClass(r.change7dPct)}`}>{fmtPct(r.change7dPct)}</span>
            <span className="hidden md:block w-20 text-right text-[12px] text-[var(--fg-2)]">{fmtVol(r.volumeQuote24h)}</span>
            <span className="hidden md:block w-20 text-right text-[12px] text-[var(--fg-2)]">{r.marketCap != null ? fmtVol(r.marketCap) : <span className="text-[var(--fg-5)]">{t('markets.marketCapUnavailable', { defaultValue: 'N/A' })}</span>}</span>
            <span className="hidden xl:block w-20 text-right text-[12px] text-[var(--fg-3)]">{r.fdv != null ? fmtVol(r.fdv) : <span className="text-[var(--fg-5)]">—</span>}</span>
            <span className="w-40 flex items-center justify-end gap-1.5">
              {r.signalDirection && <MarketSignalBadge direction={r.signalDirection} size="sm" />}
              {availCount > 0
                ? <span className="hidden lg:inline"><ProviderCoveragePill providers={r.providers} confirming={r.confirmingProviders} size="sm" /></span>
                : <span className="hidden lg:inline text-[10px] text-[var(--fg-5)]">{t('markets.noCexCoverage', { defaultValue: 'No CEX' })}</span>}
            </span>
          </div>
        )
        const marketSymbol = r.symbol || r.normalizedSymbol || r.normalized_symbol || r.providerId
        const href = r.detailHref || (assetPath ? assetPath(r) : (marketSymbol ? `${linkBase}/markets/${encodeURIComponent(marketSymbol)}` : null))
        return href
          ? <Link key={`${r.sourceProvider || ''}:${r.providerId || r.symbol}`} to={href} state={returnState} className="block">{inner}</Link>
          : <div key={`${r.sourceProvider || ''}:${r.providerId || r.symbol}`}>{inner}</div>
      })}
    </div>
  )
}
