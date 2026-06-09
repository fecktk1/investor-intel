import React from 'react'
import { useTranslation } from 'react-i18next'
import { Flame, Sparkles, ArrowUpRight, Megaphone, TrendingUp, ShieldAlert } from 'lucide-react'
import MarketSignalBadge from './MarketSignalBadge'
import { fmtVol, timeAgo } from '../lib/market-format'

// Free, cached Degen risk & quality signals from memecoin_latest_tokens — shown
// on the detail page BEFORE the user adds the token to a watchlist. No AI, no
// paid calls; pure cached data. Mirrors MemecoinTable's risk/flag vocabulary.

function riskBand(score) {
  const r = Number(score)
  if (!Number.isFinite(r)) return 'medium'
  return r >= 60 ? 'high' : r >= 30 ? 'medium' : 'low'
}
const RISK_CLS = { low: 'text-[var(--ok)]', medium: 'text-amber-400', high: 'text-red-400' }

export default function DegenSignalsCard({ token }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  if (!token) return null
  const band = riskBand(token.risk_score)
  const reasons = Array.isArray(token.discovery_reasons) ? token.discovery_reasons : []
  const riskFlags = Array.isArray(token.risk_flags) ? token.risk_flags : []
  const flags = []
  if (token.is_new || token.listing_state === 'pre_liquidity') flags.push({ k: 'new', icon: Sparkles, cls: 'text-sky-400', label: t('degen.flag_new', { defaultValue: 'New' }) })
  if (token.is_pumpfun) flags.push({ k: 'pumpfun', icon: Flame, cls: 'text-orange-400', label: t('degen.flag_pumpfun', { defaultValue: 'Pump.fun' }) })
  if (token.is_migrated) flags.push({ k: 'migrated', icon: ArrowUpRight, cls: 'text-violet-400', label: t('degen.flag_migrated', { defaultValue: 'Migrated' }) })
  if (token.is_boosted) flags.push({ k: 'boosted', icon: TrendingUp, cls: 'text-emerald-400', label: t('degen.flag_boosted', { defaultValue: 'Boosted' }) })
  if (token.is_trending) flags.push({ k: 'trending', icon: Flame, cls: 'text-pink-400', label: t('degen.flag_trending', { defaultValue: 'Trending' }) })
  if (token.is_takeover) flags.push({ k: 'takeover', icon: Megaphone, cls: 'text-teal-400', label: t('degen.flag_takeover', { defaultValue: 'CTO' }) })

  const Fact = ({ label, value }) => (
    <div className="card--flat p-2"><div className="text-[10px] text-[var(--fg-4)] uppercase">{label}</div><div className="text-[13px] font-semibold text-[var(--fg-1)] truncate">{value}</div></div>
  )

  return (
    <section className="card p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="eyebrow flex items-center gap-1.5"><ShieldAlert className="h-3.5 w-3.5" /> {t('degen.signalsTitle', { defaultValue: 'Degen signals' })}</div>
        <div className="flex items-center gap-2">
          {token.signal_direction && <MarketSignalBadge direction={token.signal_direction} size="sm" />}
          <span className={`text-[11px] font-semibold ${RISK_CLS[band]}`}>{t('degen.risk', { defaultValue: 'Risk' })}: {t(`degen.risk_${band}`, { defaultValue: band })}{token.risk_score != null ? ` (${Math.round(token.risk_score)})` : ''}</span>
          {token.listing_state === 'pre_liquidity' && <span className="chip text-[9px] uppercase text-amber-400">{t('degen.preLiquidity', { defaultValue: 'pre-liquidity' })}</span>}
          {token.liquidity_verified && <span className="chip text-[9px] uppercase chip--ok">{t('degen.verified', { defaultValue: 'Verified' })}</span>}
        </div>
      </div>

      {flags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {flags.map((f) => <span key={f.k} className={`inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-3)] ${f.cls}`}><f.icon className="h-3 w-3" />{f.label}</span>)}
        </div>
      )}

      <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
        <Fact label={t('degen.liquidity', { defaultValue: 'Liquidity' })} value={token.liquidity_usd != null ? fmtVol(token.liquidity_usd) : '—'} />
        <Fact label={t('degen.totalVolume', { defaultValue: '24h volume' })} value={token.volume_24h_usd != null ? fmtVol(token.volume_24h_usd) : '—'} />
        <Fact label={t('markets.fdv', { defaultValue: 'FDV' })} value={token.fdv != null ? fmtVol(token.fdv) : (token.market_cap != null ? fmtVol(token.market_cap) : '—')} />
        <Fact label={t('degen.age', { defaultValue: 'Age' })} value={token.pair_created_at ? timeAgo(token.pair_created_at) : '—'} />
        <Fact label={t('degen.buysSells', { defaultValue: 'Buys / Sells' })} value={`${token.buys_24h ?? '—'} / ${token.sells_24h ?? '—'}`} />
        <Fact label={t('degen.txns', { defaultValue: 'Txns 24h' })} value={token.txns_24h != null ? Number(token.txns_24h).toLocaleString() : '—'} />
      </div>

      {riskFlags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {riskFlags.map((f, i) => <span key={i} className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-3)] text-amber-400" title={f.detail || ''}>{String(f.flag || '').replace(/_/g, ' ')}</span>)}
        </div>
      )}

      {reasons.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {reasons.map((r) => <span key={r} className="chip text-[9px]">{String(r).replace(/_/g, ' ')}</span>)}
        </div>
      )}

      <div className="text-[10px] text-[var(--fg-5)] flex items-center justify-between flex-wrap gap-1 pt-1 border-t border-[var(--border)]">
        <span>{token.attribution_label || (token.source ? `${t('degen.source', { defaultValue: 'Source' })}: ${token.source}` : '')}</span>
        {token.as_of && <span>{t('markets.lastUpdated', { defaultValue: 'Updated' })} {timeAgo(token.as_of)}</span>}
      </div>
    </section>
  )
}
