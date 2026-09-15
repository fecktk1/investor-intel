import React from 'react'
import { Link, useLocation } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Flame, Sparkles, ArrowUpRight, Megaphone, TrendingUp, ShieldAlert } from 'lucide-react'
import MarketSignalBadge from './MarketSignalBadge'
import TokenAvatar from './TokenAvatar'
import SortableHeader, { StaticHeader } from './SortableHeader'
import { formatPrice, formatPct, formatUsd, formatCompact, pctClass, timeAgo } from '../lib/market-format'

// Column order is the reading order of a screener: identity, price, movement,
// the two liquidity-side numbers, then the two valuation numbers the API has
// always returned and this table used to throw away, then activity, age, risk.
// `sortKey` is the server's key — the page owns the sort, this table only
// renders the header and reports the click.
const COLUMNS = [
  { sortKey: 'price', i18nKey: 'column_price', label: 'Price' },
  { sortKey: 'change_1h', i18nKey: 'column_1h', label: '1h' },
  { sortKey: 'change_24h', i18nKey: 'column_24h', label: '24h' },
  { sortKey: 'volume', i18nKey: 'column_volume', label: 'Volume' },
  { sortKey: 'liquidity', i18nKey: 'column_liquidity', label: 'Liquidity' },
  { sortKey: 'market_cap', i18nKey: 'column_market_cap', label: 'Market cap' },
  { sortKey: 'fdv', i18nKey: 'column_fdv', label: 'FDV' },
  { sortKey: 'buys', i18nKey: 'column_buys', label: 'Buys' },
  { sortKey: 'sells', i18nKey: 'column_sells', label: 'Sells' },
  { sortKey: 'age', i18nKey: 'column_age', label: 'Age' },
  { sortKey: 'risk', i18nKey: 'column_risk', label: 'Risk & signals' },
]

const EXCLUDED_LABELS = {
  stablecoin: 'Stablecoin',
  major: 'Major asset',
  wrapped_or_staked: 'Wrapped or staked',
  impersonation: 'Impersonation',
  implausible_cap: 'Implausible market cap',
}

function riskBand(score) {
  if (score == null || score === '') return 'unknown'
  const r = Number(score)
  if (!Number.isFinite(r)) return 'unknown'
  return r >= 60 ? 'high' : r >= 30 ? 'medium' : 'low'
}
const RISK_CLS = { low: 'text-[var(--ok)]', medium: 'text-[var(--signal-yellow)]', high: 'text-[var(--signal-red)]', unknown: 'text-[var(--fg-4)]' }

function Flags({ r, t }) {
  const flags = []
  if (r.isNew || r.listingState === 'pre_liquidity') flags.push({ k: 'new', icon: Sparkles, cls: 'text-sky-400', label: t('degen.flag_new', { defaultValue: 'New' }) })
  if (r.isPumpfun) flags.push({ k: 'pumpfun', icon: Flame, cls: 'text-orange-400', label: t('degen.flag_pumpfun', { defaultValue: 'Pump.fun' }) })
  if (r.isMigrated) flags.push({ k: 'migrated', icon: ArrowUpRight, cls: 'text-violet-400', label: t('degen.flag_migrated', { defaultValue: 'Migrated' }) })
  if (r.isBoosted) flags.push({ k: 'boosted', icon: TrendingUp, cls: 'text-emerald-400', label: t('degen.flag_boosted', { defaultValue: 'Boosted' }) })
  if (r.isTrending) flags.push({ k: 'trending', icon: Flame, cls: 'text-pink-400', label: t('degen.flag_trending', { defaultValue: 'Trending' }) })
  if (r.isTakeover) flags.push({ k: 'takeover', icon: Megaphone, cls: 'text-teal-400', label: t('degen.flag_takeover', { defaultValue: 'CTO' }) })
  if (!flags.length) return null
  return (
    <span className="flex flex-wrap items-center gap-1">
      {flags.map((f) => (
        <span key={f.k} className="inline-flex items-center gap-0.5 text-[10px] text-[var(--fg-4)]" title={f.label}>{f.label}</span>
      ))}
    </span>
  )
}

// Degen memecoin terminal rows (multi-chain). Quality/buckets/sorting are
// server-side (intel-degen); this is presentation only. Logos via TokenAvatar.
export default function MemecoinTable({ rows = [], pageOffset = 0, sort = null, dir = 'desc', onSort }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const location = useLocation()
  if (!rows.length) return <div className="p-6 text-center text-[13px] text-[var(--fg-4)]">{t('degen.noData', { defaultValue: 'No memecoins match these filters yet. Discovery runs continuously.' })}</div>
  return <div className="intel-table-scroll intel-market-table intel-degen-table" tabIndex={0} role="region" aria-label={t('degen.scroll_table', { defaultValue: 'Degen results, scroll for more columns' })}><table>
    <caption className="sr-only">{t('degen.title', { defaultValue: 'Degen Memecoins' })}</caption>
    <thead><tr>
      <StaticHeader label="#" align="right"/>
      <StaticHeader label={t('markets.asset', { defaultValue: 'Asset' })} className="intel-identity-cell"/>
      {COLUMNS.map((column) => <SortableHeader key={column.sortKey} sortKey={column.sortKey} label={t('degen.'+column.i18nKey, { defaultValue: column.label })} sort={sort} dir={dir} onToggle={onSort} align="right"/>)}
    </tr></thead>
    <tbody>{rows.map((r,i) => {
      const band=riskBand(r.riskScore), buys=r.buys24h, sells=r.sells24h
      const buyPct=buys!=null && sells!=null && Number.isFinite(Number(buys)) && Number.isFinite(Number(sells)) && Number(buys)+Number(sells)>0 ? Math.round(Number(buys)/(Number(buys)+Number(sells))*100) : null
      return <tr key={r.chain+':'+r.tokenAddress}>
        <td className="intel-number">{pageOffset+i+1}</td><td className="intel-identity-cell"><Link state={{from:location.pathname+location.search}} to={r.detailHref || '/intel/asset/'+encodeURIComponent(r.chain+':'+r.tokenAddress)} className="flex items-center gap-3"><TokenAvatar src={r.imageUrl} fallbackSrc={r.imageSourceUrl} symbol={r.symbol} name={r.name} size="md"/><span><strong>{r.symbol || '—'}</strong><span className="block text-xs text-[var(--fg-4)]">{r.name} · {r.chain}</span>{r.excludedReason && <span className="block text-xs text-[var(--signal-yellow)]" title={r.excludedDetail || undefined}>{t('degen.excluded_'+r.excludedReason, { defaultValue: EXCLUDED_LABELS[r.excludedReason] || r.excludedReason })}</span>}<Flags r={r} t={t}/>{r.listingState === 'pre_liquidity' && <small>{t('degen.preLiquidity', {defaultValue:'pre-liquidity'})}</small>}{buyPct!=null && <small className="block" title={buys+' buys / '+sells+' sells (24h)'}>{buyPct}% {t('degen.buy', {defaultValue:'buy'})}{r.txns24h!=null ? ' · '+r.txns24h+' txns' : ''}</small>}</span></Link></td>
        <td className="intel-number">{formatPrice(r.price)}</td><td className={'intel-number '+pctClass(r.change1hPct)}>{formatPct(r.change1hPct)}</td><td className={'intel-number '+pctClass(r.change24hPct)}>{formatPct(r.change24hPct)}</td><td className="intel-number">{formatUsd(r.volume24hUsd)}</td><td className="intel-number">{formatUsd(r.liquidityUsd)}</td><td className="intel-number">{formatUsd(r.marketCap)}</td><td className="intel-number">{formatUsd(r.fdv)}</td><td className="intel-number">{formatCompact(r.buys24h)}</td><td className="intel-number">{formatCompact(r.sells24h)}</td><td className="intel-number">{r.pairCreatedAt ? <time dateTime={r.pairCreatedAt} title={new Date(r.pairCreatedAt).toLocaleString()}>{timeAgo(r.pairCreatedAt)}</time> : '—'}</td>
        <td className="intel-number">{r.signalDirection && <MarketSignalBadge direction={r.signalDirection} size="sm"/>}<span className={RISK_CLS[band]} title={(r.riskFlags||[]).map(f=>f.detail||f.flag).join(' · ')}>{t('degen.risk_'+band,{defaultValue:band})}</span></td>
      </tr>
    })}</tbody></table></div>
}
