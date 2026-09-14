import React from 'react'
import { Link, useLocation } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Flame, Sparkles, ArrowUpRight, Megaphone, TrendingUp, ShieldAlert } from 'lucide-react'
import MarketSignalBadge from './MarketSignalBadge'
import TokenAvatar from './TokenAvatar'
import { fmtPrice, fmtPct, fmtVol, pctClass, timeAgo } from '../lib/market-format'

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
export default function MemecoinTable({ rows = [], pageOffset = 0 }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const location = useLocation()
  if (!rows.length) return <div className="card p-6 text-center text-[13px] text-[var(--fg-4)]">{t('degen.noData', { defaultValue: 'No memecoins match these filters yet. Discovery runs continuously.' })}</div>
  return <div className="intel-table-scroll intel-market-table intel-degen-table" tabIndex={0} role="region" aria-label={t('degen.scroll_table', { defaultValue: 'Degen results, scroll for more columns' })}><table>
    <caption className="sr-only">{t('degen.title', { defaultValue: 'Degen Memecoins' })}</caption>
    <thead><tr><th scope="col">#</th><th scope="col" className="intel-identity-cell">{t('markets.asset', { defaultValue: 'Asset' })}</th>{[['price','Price'],['1h','1h'],['24h','24h'],['volume','Volume'],['liquidity','Liquidity'],['age','Age'],['risk','Risk & signals']].map(([key,label]) => <th scope="col" className="intel-number" key={key}>{t('degen.column_'+key, { defaultValue: label })}</th>)}</tr></thead>
    <tbody>{rows.map((r,i) => {
      const band=riskBand(r.riskScore), buys=r.buys24h, sells=r.sells24h
      const buyPct=buys!=null && sells!=null && Number.isFinite(Number(buys)) && Number.isFinite(Number(sells)) && Number(buys)+Number(sells)>0 ? Math.round(Number(buys)/(Number(buys)+Number(sells))*100) : null
      return <tr key={r.chain+':'+r.tokenAddress}>
        <td className="intel-number">{pageOffset+i+1}</td><td className="intel-identity-cell"><Link state={{from:location.pathname+location.search}} to={r.detailHref || '/intel/asset/'+encodeURIComponent(r.chain+':'+r.tokenAddress)} className="flex items-center gap-3"><TokenAvatar src={r.imageUrl} symbol={r.symbol} name={r.name} size="md"/><span><strong>{r.symbol || '—'}</strong><span className="block text-xs text-[var(--fg-4)]">{r.name} · {r.chain}</span><Flags r={r} t={t}/>{r.listingState === 'pre_liquidity' && <small>{t('degen.preLiquidity', {defaultValue:'pre-liquidity'})}</small>}{buyPct!=null && <small className="block" title={buys+' buys / '+sells+' sells (24h)'}>{buyPct}% {t('degen.buy', {defaultValue:'buy'})}{r.txns24h!=null ? ' · '+r.txns24h+' txns' : ''}</small>}</span></Link></td>
        <td className="intel-number">{fmtPrice(r.price)}</td><td className={'intel-number '+pctClass(r.change1hPct)}>{fmtPct(r.change1hPct)}</td><td className={'intel-number '+pctClass(r.change24hPct)}>{fmtPct(r.change24hPct)}</td><td className="intel-number">{fmtVol(r.volume24hUsd)}</td><td className="intel-number">{fmtVol(r.liquidityUsd)}</td><td className="intel-number">{r.pairCreatedAt ? <time dateTime={r.pairCreatedAt} title={new Date(r.pairCreatedAt).toLocaleString()}>{timeAgo(r.pairCreatedAt)}</time> : '—'}</td>
        <td className="intel-number">{r.signalDirection && <MarketSignalBadge direction={r.signalDirection} size="sm"/>}<span className={RISK_CLS[band]} title={(r.riskFlags||[]).map(f=>f.detail||f.flag).join(' · ')}>{t('degen.risk_'+band,{defaultValue:band})}</span></td>
      </tr>
    })}</tbody></table></div>
}
