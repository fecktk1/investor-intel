import React from 'react'
import { Link, useLocation } from 'react-router'
import { useTranslation } from 'react-i18next'
import MarketSignalBadge from './MarketSignalBadge'
import ProviderCoveragePill from './ProviderCoveragePill'
import TokenAvatar from './TokenAvatar'
import SortableHeader, { StaticHeader } from './SortableHeader'
import { formatPrice, formatPct, formatUsd, formatCompact, pctClass } from '../lib/market-format'
import { marketIdentityParams } from '../lib/asset-identity'
import { useTableScrollRestoration } from '../lib/useTableScrollRestoration'

// Column registry: [key, English label]. Everything here is offered by
// DisplayOptions, so a column that is not in the default visible set below is
// still one checkbox away rather than absent from the product.
export const MARKET_COLUMNS = [['price', 'Price'], ['1h', '1h'], ['24h', '24h'], ['7d', '7d'], ['volume', 'Volume'], ['cap', 'Market cap'], ['fdv', 'FDV'], ['circulating', 'Circulating supply'], ['max_supply', 'Max supply'], ['pairs', 'Market pairs'], ['dominance', 'Share of tracked cap'], ['exchanges', 'Exchange coverage']]

// What a reader sees before they choose anything — unchanged by the columns
// added above, so an existing screen keeps the shape it had.
export const DEFAULT_MARKET_COLUMNS = ['price', '1h', '24h', '7d', 'volume', 'cap', 'fdv', 'exchanges']

// Column key -> server sort key. Sorting is server-side over the whole screen,
// never over the loaded page, so page 7 of "price ascending" is real. Dominance
// is a strictly increasing function of market cap against one shared tracked
// total, so it orders rows by `market_cap` rather than needing its own key.
export const MARKET_SORT_KEYS = { rank: 'rank', price: 'price', '1h': 'change_1h', '24h': 'change_24h', '7d': 'change_7d', volume: 'volume', cap: 'market_cap', fdv: 'fdv', circulating: 'circulating_supply', max_supply: 'max_supply', pairs: 'market_pairs', dominance: 'market_cap', exchanges: 'exchange_availability' }

const DASH = '—'
// null / '' / booleans / NaN never become 0: a missing supply is unknown, and a
// reported zero supply stays a zero.
const num = value => { if (value == null || value === '' || typeof value === 'boolean') return null; const n = Number(value); return Number.isFinite(n) ? n : null }
const plainInteger = value => { const n = num(value); return n == null ? DASH : Math.round(n).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

// Share of the tracked market cap this screen reports. Unsigned by design: a
// dominance reading is a share, never a move, so "+58.9%" would be wrong.
export const dominancePct = (marketCap, trackedMarketCap) => {
  const cap = num(marketCap), tracked = num(trackedMarketCap)
  if (cap == null || tracked == null || tracked <= 0) return null
  return (cap / tracked) * 100
}
const formatDominance = value => value == null ? DASH : formatPct(value).replace(/^\+/, '')

export const marketRowKey = row => `${row.sourceProvider || 'unknown'}:${row.providerId || row.canonicalAssetKey || row.symbol}`
export default function MarketsTable({ rows = [], pageOffset = 0, linkBase = '/intel', assetPath = null, columns = DEFAULT_MARKET_COLUMNS, selected = [], onSelect, onInspect, sort, dir = 'desc', onSort, snapshot = null, scrollScope }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const location = useLocation()
  const returnState = { from: `${location.pathname}${location.search}` }
  const tableRef = useTableScrollRestoration(scrollScope, returnState.from)
  const orderedColumns = [...new Set(columns)].map(key => MARKET_COLUMNS.find(column => column[0] === key)).filter(Boolean)
  if (!rows.length) return <p className="py-8 text-sm text-[var(--fg-4)]">{t('markets.noData', { defaultValue: 'No assets match this screen.' })}</p>
  const sortable = typeof onSort === 'function'
  // A header only becomes a control where the caller can actually reorder the
  // screen; a demo or embedded table renders the same header as plain text
  // rather than a button that answers nothing.
  const header = (key, label, align = 'right', title) => sortable && MARKET_SORT_KEYS[key]
    ? <SortableHeader key={key} sortKey={MARKET_SORT_KEYS[key]} label={label} title={title} align={align} sort={sort} dir={dir} onToggle={onSort}/>
    : <StaticHeader key={key} label={label} align={align} title={title}/>
  return <div ref={tableRef} className={`intel-table-scroll intel-market-table ${onSelect ? 'has-selection' : ''}`} tabIndex={0} role="region" aria-label={t('markets.scroll_table', { defaultValue: 'Market results, scroll for more columns' })}><table>
    <caption className="sr-only">{t('markets.title', { defaultValue: 'Crypto markets' })}</caption>
    {/* "#" is a symbol, not a word: passing it as a node keeps the visible
        header short while the button announces "Sort by Rank". */}
    <thead><tr>{onSelect && <StaticHeader className="intel-select-cell" label={t('markets.select', { defaultValue: 'Select' })}/>}{header('rank', <span>#</span>, 'right', t('markets.column_rank', { defaultValue: 'Rank' }))}<StaticHeader className="intel-identity-cell" label={t('markets.asset', { defaultValue: 'Asset' })}/>{orderedColumns.map(([key, label]) => header(key, t(`markets.column_${key}`, { defaultValue: label })))}{onInspect && <StaticHeader label={t('inspector.preview_short', { defaultValue: 'Preview' })}/>}</tr></thead>
    <tbody>{rows.map((row, index) => {
      const key = marketRowKey(row)
      const symbol = row.symbol || row.normalizedSymbol || row.normalized_symbol || row.providerId
      const href = row.detailHref || (assetPath ? assetPath(row) : symbol ? `${linkBase}/markets/${encodeURIComponent(symbol)}${marketIdentityParams(row)}` : null)
      const values = { price: formatPrice(row.price), '1h': formatPct(row.change1hPct), '24h': formatPct(row.change24hPct), '7d': formatPct(row.change7dPct), volume: formatUsd(row.volumeQuote24h), cap: formatUsd(row.marketCap), fdv: formatUsd(row.fdv), circulating: formatCompact(row.circulatingSupply), max_supply: formatCompact(row.maxSupply), pairs: plainInteger(row.numMarketPairs), dominance: formatDominance(dominancePct(row.marketCap, snapshot?.trackedMarketCap)) }
      const changes = { '1h': row.change1hPct, '24h': row.change24hPct, '7d': row.change7dPct }
      const asset = <span className="intel-market-asset-label flex items-center gap-3"><TokenAvatar src={row.imageUrl} fallbackSrc={row.imageSourceUrl} symbol={symbol} name={row.displayName} size="md"/><span><strong className="font-medium">{row.displayName || symbol}</strong><span className="block text-xs text-[var(--fg-4)]">{symbol}{row.chain ? ` · ${row.chain}` : ''}</span></span></span>
      return <tr key={key} data-selected={selected.includes(key) || undefined}>{onSelect && <td className="intel-select-cell"><input type="checkbox" aria-label={`${t('markets.select', { defaultValue: 'Select' })} ${row.displayName || symbol}`} checked={selected.includes(key)} onChange={() => onSelect(row)}/></td>}<td className="intel-number">{row.rank ?? pageOffset + index + 1}</td><td className="intel-identity-cell">{href ? <Link to={href} state={returnState}>{asset}</Link> : asset}</td>
        {orderedColumns.map(([column]) => <td key={column} className={`intel-number ${Object.hasOwn(changes, column) ? pctClass(changes[column]) : ''}`}>
          {column !== 'exchanges' ? values[column] : <span className="flex gap-3 justify-end items-center">{row.signalDirection && <MarketSignalBadge direction={row.signalDirection} size="sm"/>}{row.cex?.availableCount > 0 ? <ProviderCoveragePill providers={row.providers} confirming={row.confirmingProviders} size="sm"/> : <span className="text-xs text-[var(--fg-4)]">{row.cex?.coverageState === 'verified_absent' ? t('markets.no_verified_venue', { defaultValue: 'No covered venue' }) : t('markets.coverage_unknown', { defaultValue: 'Not verified' })}</span>}</span>}
        </td>)}
        {onInspect && <td><button type="button" className="intel-inspect-button" aria-label={`${t('inspector.inspect', { defaultValue: 'Inspect' })} ${row.displayName || symbol}`} onClick={() => onInspect(row)}>{t('inspector.inspect', { defaultValue: 'Inspect' })}</button></td>}
      </tr>
    })}</tbody>
  </table></div>
}
