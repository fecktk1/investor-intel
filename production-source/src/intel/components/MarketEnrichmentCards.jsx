import React from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, Layers, Newspaper, Star, TrendingUp, TrendingDown, ExternalLink, CalendarClock } from 'lucide-react'
import { fmtVol, fmtNum, fmtPct, pctClass } from '../lib/market-format'

// Always-visible Markets enrichment cards. They render from the intel-markets
// detail payload (no AI call) and surface the SAME ecosystem-narrative, catalyst
// and on-chain data that also grounds the "Explain why" AI read. Each card returns
// null when its slice is missing, so the page stays clean for thin assets.

const CLASS_TONE = {
  bullish: 'text-[var(--ok)]',
  bearish: 'text-red-400',
  mixed: 'text-amber-400',
  neutral: 'text-[var(--fg-4)]',
}
const toneFor = (cls) => CLASS_TONE[String(cls || '').toLowerCase()] || 'text-[var(--fg-4)]'

function StageChip({ stage, signalClass }) {
  if (!stage && !signalClass) return null
  return (
    <span className="inline-flex items-center gap-1 chip text-[10px]">
      {signalClass && <span className={`h-1.5 w-1.5 rounded-full ${toneFor(signalClass).replace('text-', 'bg-')}`} />}
      {String(stage || signalClass).replace(/_/g, ' ')}
    </span>
  )
}

function shortDate(iso) {
  if (!iso) return null
  try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) } catch { return null }
}

// ── On-chain activity (holders / active wallets / volume) ────────────────────
export function OnchainActivityCard({ onchain }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  if (!onchain || onchain.status !== 'available') return null
  const stats = [
    [t('markets.onchainHolders', { defaultValue: 'Holders' }), onchain.holders != null ? fmtNum(onchain.holders) : null],
    [t('markets.onchainActiveWallets', { defaultValue: 'Active wallets 24h' }), onchain.unique_wallets_24h != null ? fmtNum(onchain.unique_wallets_24h) : null],
    [t('markets.onchainVolume', { defaultValue: 'On-chain vol 24h' }), onchain.volume_24h_usd != null ? fmtVol(onchain.volume_24h_usd) : null],
    [t('markets.onchainVolChange', { defaultValue: 'Vol Δ 24h' }), onchain.volume_change_24h_pct != null ? fmtPct(onchain.volume_change_24h_pct) : null, pctClass(onchain.volume_change_24h_pct)],
    [t('markets.onchainLiquidity', { defaultValue: 'Liquidity' }), onchain.liquidity_usd != null ? fmtVol(onchain.liquidity_usd) : null],
  ].filter(([, v]) => v != null)
  if (!stats.length) return null
  return (
    <section className="card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Activity className="h-3.5 w-3.5 text-[var(--accent)]" />
        <span className="text-[13px] font-semibold text-[var(--fg-1)]">{t('markets.onchainActivity', { defaultValue: 'On-chain activity' })}</span>
        {onchain.source && <span className="text-[10px] text-[var(--fg-5)]">{onchain.source}</span>}
      </div>
      <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
        {stats.map(([label, val, cls], i) => (
          <div key={i} className="card--flat p-2.5"><div className="text-[10px] text-[var(--fg-4)] uppercase">{label}</div><div className={`text-sm font-semibold ${cls || 'text-[var(--fg-1)]'} truncate`}>{val}</div></div>
        ))}
      </div>
    </section>
  )
}

// ── Ecosystem narratives (chain rotation + this-asset membership) ────────────
export function EcosystemNarrativesCard({ data }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  if (!data || data.status !== 'available') return null
  const mine = (data.asset_narratives || []).filter((n) => n.slug || n.name).slice(0, 5)
  const eco = (data.ecosystem_narratives || []).filter((n) => n.slug || n.name).slice(0, 6)
  if (!mine.length && !eco.length) return null
  return (
    <section className="card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Layers className="h-3.5 w-3.5 text-[var(--accent)]" />
        <span className="text-[13px] font-semibold text-[var(--fg-1)]">{t('markets.ecosystemNarratives', { defaultValue: 'Ecosystem narratives driving this' })}</span>
      </div>

      {mine.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-wide text-[var(--fg-5)]">{t('markets.assetNarratives', { defaultValue: 'This asset belongs to' })}</div>
          <div className="flex flex-wrap gap-1.5">
            {mine.map((n, i) => (
              <span key={i} className="inline-flex items-center gap-1.5 card--flat px-2 py-1 text-[11px] text-[var(--fg-2)]">
                {n.is_leader && <Star className="h-3 w-3 text-amber-400" />}
                <span className="font-medium">{n.name || n.slug}</span>
                <StageChip stage={n.lifecycle_stage} signalClass={n.signal_class} />
              </span>
            ))}
          </div>
        </div>
      )}

      {eco.length > 0 && (
        <div className="space-y-1.5 pt-1">
          <div className="text-[10px] uppercase tracking-wide text-[var(--fg-5)]">{t('markets.hotInEcosystem', { defaultValue: 'Hot in the ecosystem' })} {data.chain ? `· ${data.chain}` : ''}</div>
          <ul className="space-y-1">
            {eco.map((n, i) => (
              <li key={i} className="flex items-center justify-between gap-2 text-[12px]">
                <span className="text-[var(--fg-2)] truncate">{n.name || n.slug}</span>
                <span className="flex items-center gap-2 shrink-0">
                  <StageChip stage={n.lifecycle_stage} signalClass={n.signal_class} />
                  {n.global_priority_score != null && <span className="text-[10px] text-[var(--fg-5)]">{Math.round(n.global_priority_score)}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

// ── Recent catalysts & curated news ──────────────────────────────────────────
export function CatalystsNewsCard({ data, historical = false }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  if (!data) return null
  const news = (data.curated_news || []).filter((n) => n.title).slice(0, 4)
  const events = (data.catalysts || []).filter((e) => e.title).slice(0, 4)
  if (!news.length && !events.length && !['error', 'partial'].includes(data.status)) return null
  return (
    <section className="card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Newspaper className="h-3.5 w-3.5 text-[var(--accent)]" />
        <span className="text-[13px] font-semibold text-[var(--fg-1)]">{historical ? t('asset_news.saved_coverage', { defaultValue: 'Recorded coverage & notable events' }) : t('markets.catalystsNews', { defaultValue: 'Recent catalysts & news' })}</span>
      </div>

      {['error', 'partial'].includes(data.status) && <p role="alert">{t('markets.catalystReadFailed', { defaultValue: 'Some catalyst sources could not be loaded. Event coverage is incomplete.' })}</p>}
      {news.length > 0 && (
        <ul className="space-y-2">
          {news.map((n, i) => (
            <li key={i} className="space-y-0.5">
              <div className="flex items-start gap-2">
                {n.signal && <span className={`mt-0.5 h-1.5 w-1.5 rounded-full shrink-0 ${toneFor(n.signal).replace('text-', 'bg-')}`} />}
                {n.url
                  ? <a href={n.url} target="_blank" rel="noreferrer" className="text-[12px] text-[var(--fg-1)] hover:text-[var(--accent)] flex items-center gap-1">{n.title}<ExternalLink className="h-3 w-3 opacity-60" /></a>
                  : <span className="text-[12px] text-[var(--fg-1)]">{n.title}</span>}
              </div>
              {n.published_at && <time dateTime={n.published_at} className="block text-[11px] text-[var(--fg-4)]">{new Date(n.published_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</time>}
              {n.why_it_matters && <p className="text-[11px] text-[var(--fg-4)] leading-snug pl-3.5">{n.why_it_matters}</p>}
            </li>
          ))}
        </ul>
      )}

      {events.length > 0 && (
        <div className="space-y-1.5 pt-1">
          <div className="text-[10px] uppercase tracking-wide text-[var(--fg-5)]">{t('markets.historicCatalysts', { defaultValue: 'Notable events' })}</div>
          <ul className="space-y-1">
            {events.map((e, i) => (
              <li key={i} className="flex items-start justify-between gap-2 text-[12px]">
                <span className="text-[var(--fg-2)]">
                  {e.event_type && <span className="chip text-[10px] mr-1.5">{String(e.event_type).replace(/_/g, ' ')}</span>}
                  {e.title}
                </span>
                {shortDate(e.occurred_at) && <span className="text-[10px] text-[var(--fg-5)] shrink-0">{shortDate(e.occurred_at)}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

// ── Upcoming token unlocks (forward emissions / dilution catalyst) ───────────
// Always-visible (no AI run): renders the cached token_unlocks calendar that
// also feeds the "Explain why" read + risk flags. pct_supply's unit is
// provider-ambiguous, so it's shown as an approximate percent and absurd values
// are dropped; the unlock DATE/timing is the unambiguous headline.
export function UpcomingUnlocksCard({ data }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const upcoming = (data && data.status === 'available' && Array.isArray(data.upcoming)) ? data.upcoming : []
  if (!upcoming.length) return null
  const next = data.next_unlock || upcoming[0]
  const pctSupply = v => v == null || !Number.isFinite(Number(v)) ? null : `${Number(v).toLocaleString()} (unit unspecified)`
  return (
    <section className={`card p-4 space-y-3 ${data.material ? 'border border-amber-400/30' : ''}`}>
      <div className="flex items-center gap-2">
        <CalendarClock className="h-3.5 w-3.5 text-[var(--accent)]" />
        <span className="text-[13px] font-semibold text-[var(--fg-1)]">{t('markets.unlocksTitle', { defaultValue: 'Upcoming token unlocks' })}</span>
        {data.material && <span className="chip text-[9px] text-amber-400">{t('markets.unlocksDilution', { defaultValue: 'Forward dilution' })}</span>}
      </div>
      {next && (
        <div className="card--flat p-2.5 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[10px] text-[var(--fg-4)] uppercase">{t('markets.unlocksNext', { defaultValue: 'Next unlock' })}</div>
            <div className="text-sm font-semibold text-[var(--fg-1)]">{shortDate(next.unlock_date)}{next.days_until != null ? ` · ${t('markets.unlocksIn', { defaultValue: 'in' })} ${next.days_until}d` : ''}</div>
          </div>
          <div className="text-right shrink-0">
            {pctSupply(next.pct_supply) && <div className="text-sm font-semibold text-amber-400">{pctSupply(next.pct_supply)}</div>}
            {next.amount != null && <div className="text-[10px] text-[var(--fg-5)]">{fmtNum(next.amount)} {t('markets.unlocksTokens', { defaultValue: 'tokens' })}</div>}
          </div>
        </div>
      )}
      {upcoming.length > 1 && (
        <ul className="space-y-1">
          {upcoming.slice(1, 5).map((u, i) => (
            <li key={i} className="flex items-center justify-between gap-2 text-[12px]">
              <span className="text-[var(--fg-2)]">{shortDate(u.unlock_date)}{u.days_until != null ? ` · ${u.days_until}d` : ''}</span>
              <span className="text-[var(--fg-4)]">{pctSupply(u.pct_supply) || (u.amount != null ? fmtNum(u.amount) : '—')}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[10px] text-[var(--fg-5)] leading-snug">Stored symbol schedule · asset match and supply units are unverified. Use the book calendar for verified identity and source versions.</p>
    </section>
  )
}
