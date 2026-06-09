import React from 'react'
import { useTranslation } from 'react-i18next'
import { Globe, FileText, BookOpen, Compass, ExternalLink, ShieldCheck, Users, Rocket } from 'lucide-react'
import TokenAvatar from './TokenAvatar'

const fmtNum = (n) => n == null ? '—' : Number(n) >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : Number(n) >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : Number(n) >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${Number(n).toLocaleString()}`

function Link2({ href, icon: Icon, label }) {
  if (!href) return null
  return <a href={href} target="_blank" rel="noopener noreferrer" className="btn btn--ghost btn--sm"><Icon className="h-3.5 w-3.5" /> {label}</a>
}

// Rich, globally-cached project profile (M5). Renders only provider-sourced
// facts — no invented tokenomics. Degrades cleanly when a profile is missing,
// incomplete, or refreshing.
export default function ProfilePanel({ profile, state }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  if (!profile && state === 'enqueued') return <div className="card--flat p-3 text-[12px] text-[var(--fg-4)]">{t('profile.refreshing', { defaultValue: 'Building this token’s profile… check back in a moment.' })}</div>
  if (!profile) return null
  const p = profile
  const socials = p.socials && typeof p.socials === 'object' ? p.socials : {}
  const links = p.links && typeof p.links === 'object' ? p.links : {}
  const supply = p.supply || {}
  const security = p.security || {}
  const holders = p.holders || {}
  const launch = p.launch_data || {}
  const cats = Array.isArray(p.categories) ? p.categories.slice(0, 8) : []

  return (
    <section className="card p-4 space-y-3">
      {p.header_image_url && <div className="h-20 -m-4 mb-1 rounded-t-lg bg-cover bg-center" style={{ backgroundImage: `url(${p.header_image_url})` }} />}
      <div className="flex items-start gap-3">
        <TokenAvatar src={p.image_url} symbol={p.symbol} name={p.name} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-semibold text-[var(--fg-1)]">{p.name || p.symbol}</h3>
            {p.symbol && <span className="text-[12px] text-[var(--fg-4)]">{p.symbol}</span>}
            {p.profile_complete === false && <span className="chip text-[9px] uppercase">{t('profile.incomplete', { defaultValue: 'Partial' })}</span>}
            {state === 'stale_refreshing' && <span className="text-[10px] text-[var(--fg-5)]">{t('profile.updating', { defaultValue: 'updating…' })}</span>}
          </div>
          {p.description && <p className="text-[13px] text-[var(--fg-3)] mt-1 line-clamp-4">{p.description}</p>}
          {cats.length > 0 && <div className="flex flex-wrap gap-1 mt-2">{cats.map((c) => <span key={c} className="chip text-[9px]">{c}</span>)}</div>}
        </div>
      </div>

      {/* links */}
      <div className="flex flex-wrap gap-1.5">
        <Link2 href={p.website_url || links.website} icon={Globe} label={t('profile.website', { defaultValue: 'Website' })} />
        <Link2 href={p.docs_url} icon={BookOpen} label={t('profile.docs', { defaultValue: 'Docs' })} />
        <Link2 href={p.whitepaper_url} icon={FileText} label={t('profile.whitepaper', { defaultValue: 'Whitepaper' })} />
        <Link2 href={p.explorer_url} icon={Compass} label={t('profile.explorer', { defaultValue: 'Explorer' })} />
        {Object.entries(socials).map(([k, v]) => <Link2 key={k} href={v} icon={ExternalLink} label={k} />)}
        <Link2 href={p.dexscreener_url} icon={ExternalLink} label="DexScreener" />
        <Link2 href={p.geckoterminal_url} icon={ExternalLink} label="GeckoTerminal" />
        <Link2 href={p.coingecko_url} icon={ExternalLink} label="CoinGecko" />
        <Link2 href={p.coinmarketcap_url} icon={ExternalLink} label="CoinMarketCap" />
        <Link2 href={p.pumpfun_url} icon={Rocket} label="Pump.fun" />
        <Link2 href={p.jupiter_url} icon={ExternalLink} label="Jupiter" />
        {Object.entries(links).filter(([k]) => !['website'].includes(String(k).toLowerCase())).map(([k, v]) => <Link2 key={`l-${k}`} href={v} icon={ExternalLink} label={k} />)}
      </div>

      {/* supply / launch / security (facts only — never invented) */}
      <div className="grid gap-2 grid-cols-2 sm:grid-cols-4">
        {supply.circulating != null && <Fact label={t('profile.circulating', { defaultValue: 'Circulating' })} value={fmtNum(supply.circulating)} />}
        {supply.total != null && <Fact label={t('profile.total_supply', { defaultValue: 'Total supply' })} value={fmtNum(supply.total)} />}
        {supply.max != null && <Fact label={t('profile.max_supply', { defaultValue: 'Max supply' })} value={fmtNum(supply.max)} />}
        {holders.count != null && <Fact label={t('breakdown.holders', { defaultValue: 'Holders' })} value={Number(holders.count).toLocaleString()} icon={Users} />}
        {(launch.pairCreatedAt) && <Fact label={t('profile.launched', { defaultValue: 'Launched' })} value={new Date(launch.pairCreatedAt).toLocaleDateString()} icon={Rocket} />}
        {security.top10HolderPercent != null && <Fact label={t('profile.top10', { defaultValue: 'Top 10 hold' })} value={`${(Number(security.top10HolderPercent) * 100).toFixed(0)}%`} icon={ShieldCheck} />}
      </div>

      {/* attribution */}
      <div className="text-[10px] text-[var(--fg-5)] flex items-center justify-between flex-wrap gap-1 pt-1 border-t border-[var(--border)]">
        <span>{p.attribution_label || (Array.isArray(p.enrichment_sources) ? `${t('profile.sources', { defaultValue: 'Sources' })}: ${p.enrichment_sources.join(', ')}` : '')}</span>
        {p.last_enriched_at && <span>{t('markets.lastUpdated', { defaultValue: 'Updated' })} {new Date(p.last_enriched_at).toLocaleString()}</span>}
      </div>
    </section>
  )
}

function Fact({ label, value, icon: Icon }) {
  return (
    <div className="card--flat p-2">
      <div className="text-[10px] text-[var(--fg-4)] uppercase flex items-center gap-1">{Icon && <Icon className="h-3 w-3" />}{label}</div>
      <div className="text-[13px] font-semibold text-[var(--fg-1)] truncate">{value}</div>
    </div>
  )
}
