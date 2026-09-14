import React from 'react'
import { Link, useLocation } from 'react-router'
import { useTranslation } from 'react-i18next'
import MarketSignalBadge from './MarketSignalBadge'
import ProviderCoveragePill from './ProviderCoveragePill'
import TokenAvatar from './TokenAvatar'
import { fmtPrice, fmtPct, fmtVol, pctClass } from '../lib/market-format'
import { marketIdentityParams } from '../lib/asset-identity'
import { useTableScrollRestoration } from '../lib/useTableScrollRestoration'
export const MARKET_COLUMNS = [['price', 'Price'], ['1h', '1h'], ['24h', '24h'], ['7d', '7d'], ['volume', 'Volume'], ['cap', 'Market cap'], ['fdv', 'FDV'], ['exchanges', 'Exchange coverage']]
export const marketRowKey = row => `${row.sourceProvider || 'unknown'}:${row.providerId || row.canonicalAssetKey || row.symbol}`
export default function MarketsTable({ rows = [], pageOffset = 0, linkBase = '/intel', assetPath = null, columns = MARKET_COLUMNS.map(c => c[0]), selected = [], onSelect, onInspect, sort, onSort, scrollScope }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const location = useLocation()
  const returnState = { from: `${location.pathname}${location.search}` }
  const tableRef = useTableScrollRestoration(scrollScope, returnState.from)
  const orderedColumns = [...new Set(columns)].map(key => MARKET_COLUMNS.find(column => column[0] === key)).filter(Boolean)
  if (!rows.length) return <p className="py-8 text-sm text-[var(--fg-4)]">{t('markets.noData', { defaultValue: 'No assets match this screen.' })}</p>
  const sortKeys = { '1h': 'change_1h', '24h': 'change_24h', '7d': 'change_7d', volume: 'volume', cap: 'market_cap', exchanges: 'exchange_availability' }
  return <div ref={tableRef} className={`intel-table-scroll intel-market-table ${onSelect ? 'has-selection' : ''}`} tabIndex={0} role="region" aria-label={t('markets.scroll_table', { defaultValue: 'Market results, scroll for more columns' })}><table>
    <caption className="sr-only">{t('markets.title', { defaultValue: 'Crypto markets' })}</caption>
    <thead><tr>{onSelect && <th scope="col" className="intel-select-cell">{t('markets.select', { defaultValue: 'Select' })}</th>}<th scope="col">#</th><th scope="col" className="intel-identity-cell">{t('markets.asset', { defaultValue: 'Asset' })}</th>{orderedColumns.map(([key, label]) => <th className="intel-number" scope="col" key={key} aria-sort={sortKeys[key] === sort ? 'descending' : undefined}>{onSort && sortKeys[key] ? <button type="button" onClick={() => onSort(sortKeys[key])}>{t(`markets.column_${key}`, { defaultValue: label })}{sortKeys[key] === sort && <span aria-hidden="true"> ↓</span>}</button> : t(`markets.column_${key}`, { defaultValue: label })}</th>)}{onInspect && <th scope="col">{t('inspector.preview_short', { defaultValue: 'Preview' })}</th>}</tr></thead>
    <tbody>{rows.map((row, index) => {
      const key = marketRowKey(row)
      const symbol = row.symbol || row.normalizedSymbol || row.normalized_symbol || row.providerId
      const href = row.detailHref || (assetPath ? assetPath(row) : symbol ? `${linkBase}/markets/${encodeURIComponent(symbol)}${marketIdentityParams(row)}` : null)
      const values = { price: fmtPrice(row.price), '1h': fmtPct(row.change1hPct), '24h': fmtPct(row.change24hPct), '7d': fmtPct(row.change7dPct), volume: fmtVol(row.volumeQuote24h), cap: fmtVol(row.marketCap), fdv: fmtVol(row.fdv) }
      const changes = { '1h': row.change1hPct, '24h': row.change24hPct, '7d': row.change7dPct }
      const asset = <span className="intel-market-asset-label flex items-center gap-3"><TokenAvatar src={row.imageUrl} symbol={symbol} name={row.displayName} size="md"/><span><strong className="font-medium">{row.displayName || symbol}</strong><span className="block text-xs text-[var(--fg-4)]">{symbol}{row.chain ? ` · ${row.chain}` : ''}</span></span></span>
      return <tr key={key} data-selected={selected.includes(key) || undefined}>{onSelect && <td className="intel-select-cell"><input type="checkbox" aria-label={`${t('markets.select', { defaultValue: 'Select' })} ${row.displayName || symbol}`} checked={selected.includes(key)} onChange={() => onSelect(row)}/></td>}<td className="intel-number">{row.rank ?? pageOffset + index + 1}</td><td className="intel-identity-cell">{href ? <Link to={href} state={returnState}>{asset}</Link> : asset}</td>
        {orderedColumns.map(([column]) => <td key={column} className={`intel-number ${Object.hasOwn(changes, column) ? pctClass(changes[column]) : ''}`}>
          {column !== 'exchanges' ? values[column] : <span className="flex gap-3 justify-end items-center">{row.signalDirection && <MarketSignalBadge direction={row.signalDirection} size="sm"/>}{row.cex?.availableCount > 0 ? <ProviderCoveragePill providers={row.providers} confirming={row.confirmingProviders} size="sm"/> : <span className="text-xs text-[var(--fg-4)]">{row.cex?.coverageState === 'verified_absent' ? t('markets.no_verified_venue', { defaultValue: 'No covered venue' }) : t('markets.coverage_unknown', { defaultValue: 'Not verified' })}</span>}</span>}
        </td>)}
        {onInspect && <td><button type="button" className="intel-inspect-button" aria-label={`${t('inspector.inspect', { defaultValue: 'Inspect' })} ${row.displayName || symbol}`} onClick={() => onInspect(row)}>{t('inspector.inspect', { defaultValue: 'Inspect' })}</button></td>}
      </tr>
    })}</tbody>
  </table></div>
}
