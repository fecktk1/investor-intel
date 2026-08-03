import React from 'react'
import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Flame, Sparkles, ArrowUpRight, Megaphone, TrendingUp, ShieldAlert } from 'lucide-react'
import MarketSignalBadge from './MarketSignalBadge'
import TokenAvatar from './TokenAvatar'
import { fmtPrice, fmtPct, fmtVol, pctClass, timeAgo } from '../lib/market-format'

function riskBand(score) {
  const r = Number(score)
  if (!Number.isFinite(r)) return 'medium'
  return r >= 60 ? 'high' : r >= 30 ? 'medium' : 'low'
}
const RISK_CLS = { low: 'text-[var(--ok)]', medium: 'text-amber-400', high: 'text-red-400' }

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
      {flags.slice(0, 3).map((f) => (
        <span key={f.k} className={`inline-flex items-center gap-0.5 text-[9px] px-1 rounded bg-[var(--bg-3)] ${f.cls}`} title={f.label}><f.icon className="h-2.5 w-2.5" />{f.label}</span>
      ))}
    </span>
  )
}

// Degen memecoin terminal rows (multi-chain). Quality/buckets/sorting are
// server-side (intel-degen); this is presentation only. Logos via TokenAvatar.
export default function MemecoinTable({ rows = [], pageOffset = 0 }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  if (!rows.length) return <div className="card p-6 text-center text-[13px] text-[var(--fg-4)]">{t('degen.noData', { defaultValue: 'No memecoins match these filters yet. Discovery runs continuously.' })}</div>
  return (
    <div className="space-y-1.5">
      <div className="hidden md:flex items-center gap-3 px-2.5 text-[10px] uppercase text-[var(--fg-5)]">
        <span className="w-8 text-right">#</span>
        <span className="flex-1">{t('markets.asset', { defaultValue: 'Asset' })}</span>
        <span className="w-20 text-right">{t('markets.priceLabel', { defaultValue: 'Price' })}</span>
        <span className="hidden lg:block w-14 text-right">1h</span>
        <span className="w-14 text-right">24h</span>
        <span className="w-20 text-right">{t('markets.volLabel', { defaultValue: 'Volume' })}</span>
        <span className="w-20 text-right">{t('degen.liquidity', { defaultValue: 'Liquidity' })}</span>
        <span className="hidden xl:block w-16 text-right">{t('degen.age', { defaultValue: 'Age' })}</span>
        <span className="w-28 text-right">{t('degen.risk', { defaultValue: 'Risk' })}</span>
      </div>
      {rows.map((r, i) => {
        const band = riskBand(r.riskScore)
        const inner = (
          <div className="card--flat p-2.5 w-full flex items-center gap-3 hover:bg-[var(--bg-2)] transition-colors">
            <span className="w-8 text-right text-[11px] text-[var(--fg-5)]">{pageOffset + i + 1}</span>
            <div className="flex-1 min-w-0 flex items-center gap-2">
              <TokenAvatar src={r.imageUrl} symbol={r.symbol} name={r.name} size="md" />
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-[var(--fg-1)] truncate flex items-center gap-1.5">
                  {r.symbol || '—'}
                  {r.name ? <span className="text-[11px] text-[var(--fg-4)] truncate hidden sm:inline">{r.name}</span> : null}
                  <span className="text-[9px] text-[var(--fg-5)] px-1 rounded bg-[var(--bg-3)]">{r.chain}</span>
                </div>
                <div className="mt-0.5 flex items-center gap-1.5"><Flags r={r} t={t} />{r.listingState === 'pre_liquidity' && <span className="text-[9px] text-amber-400">{t('degen.preLiquidity', { defaultValue: 'pre-liquidity' })}</span>}{(() => { const b = Number(r.buys24h) || 0, sl = Number(r.sells24h) || 0, tot = b + sl; if (!tot) return null; const bp = Math.round((b / tot) * 100); return <span className={`text-[9px] ${bp >= 55 ? 'text-emerald-400' : bp <= 45 ? 'text-red-400' : 'text-[var(--fg-5)]'}`} title={`${b} buys / ${sl} sells${r.txns24h ? ` · ${r.txns24h} txns` : ''} (24h)`}>{bp}% {t('degen.buy', { defaultValue: 'buy' })}</span> })()}</div>
              </div>
            </div>
            <span className="hidden md:block w-20 text-right text-[12px] text-[var(--fg-2)]">{fmtPrice(r.price)}</span>
            <span className={`hidden lg:block w-14 text-right text-[12px] ${pctClass(r.change1hPct)}`}>{fmtPct(r.change1hPct)}</span>
            <span className={`hidden md:block w-14 text-right text-[12px] ${pctClass(r.change24hPct)}`}>{fmtPct(r.change24hPct)}</span>
            <span className="hidden md:block w-20 text-right text-[12px] text-[var(--fg-2)]">{fmtVol(r.volume24hUsd)}</span>
            <span className="hidden md:block w-20 text-right text-[12px] text-[var(--fg-2)]">{r.liquidityUsd != null ? fmtVol(r.liquidityUsd) : <span className="text-[var(--fg-5)]">—</span>}</span>
            <span className="hidden xl:block w-16 text-right text-[11px] text-[var(--fg-4)]">{r.pairCreatedAt ? timeAgo(r.pairCreatedAt) : '—'}</span>
            <span className="w-28 flex items-center justify-end gap-1.5">
              {r.signalDirection && <MarketSignalBadge direction={r.signalDirection} size="sm" />}
              <span className={`text-[10px] font-semibold flex items-center gap-0.5 ${RISK_CLS[band]}`} title={(r.riskFlags || []).map((f) => f.detail || f.flag).join(' · ')}>
                {band === 'high' && <ShieldAlert className="h-3 w-3" />}{t(`degen.risk_${band}`, { defaultValue: band })}
              </span>
            </span>
          </div>
        )
        return (
          <Link key={`${r.chain}:${r.tokenAddress}`} to={r.detailHref || `/intel/asset/${encodeURIComponent(`${r.chain}:${r.tokenAddress}`)}`} className="block">{inner}</Link>
        )
      })}
    </div>
  )
}
