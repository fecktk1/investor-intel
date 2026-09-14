import React from 'react'
import { useTranslation } from 'react-i18next'
import TokenAvatar from './TokenAvatar'

const finite = value => value != null && value !== '' && Number.isFinite(Number(value))
const fmtNum = value => !finite(value) ? '—' : Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })
function safeUrl(value) {
  if (typeof value !== 'string') return false
  try { return ['https:', 'http:'].includes(new URL(value).protocol) } catch { return false }
}

// Provider facts retain their source clock. Missing data is an explicit state,
// not an empty identity heading or an invented positive security assessment.
export default function ProfilePanel({ profile, state, error, reason, onRetry }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  if (!profile && !state && !error) return null
  const p = profile || {}
  const title = p.name || p.symbol || t('profile.title', { defaultValue: 'Project profile' })
  const description = typeof p.description === 'string' ? p.description : ''
  const supply = p.supply || {}, holders = p.holders || {}, security = p.security || {}
  const categories = Array.isArray(p.categories) ? p.categories.filter(v => typeof v === 'string') : []
  const links = [
    [t('profile.website', { defaultValue: 'Website' }), p.website_url || p.links?.website],
    [t('profile.docs', { defaultValue: 'Docs' }), p.docs_url],
    [t('profile.whitepaper', { defaultValue: 'Whitepaper' }), p.whitepaper_url],
    [t('profile.explorer', { defaultValue: 'Explorer' }), p.explorer_url],
    ...Object.entries(p.socials || {}),
    ['DexScreener', p.dexscreener_url], ['GeckoTerminal', p.geckoterminal_url],
    ['CoinGecko', p.coingecko_url], ['CoinMarketCap', p.coinmarketcap_url],
    ['Pump.fun', p.pumpfun_url], ['Jupiter', p.jupiter_url],
    ...Object.entries(p.links || {}).filter(([key]) => key.toLowerCase() !== 'website'),
  ].filter(([, href]) => safeUrl(href))
  const facts = [
    [t('profile.circulating', { defaultValue: 'Circulating' }), supply.circulating],
    [t('profile.total_supply', { defaultValue: 'Total supply' }), supply.total],
    [t('profile.max_supply', { defaultValue: 'Max supply' }), supply.max],
    [t('breakdown.holders', { defaultValue: 'Holders' }), holders.count],
  ].filter(([,value]) => finite(value)).map(([label,value]) => [label,fmtNum(value)])
  const launched = p.launch_data?.pairCreatedAt
  if (launched != null && Number.isFinite(new Date(launched).getTime())) facts.push([t('profile.launched', { defaultValue: 'Launched' }), new Date(launched).toLocaleDateString()])
  if (finite(security.top10HolderPercent)) facts.push([t('profile.top10', { defaultValue: 'Top 10 hold' }), (Number(security.top10HolderPercent) * 100).toFixed(0) + '%'])
  const sources = Array.isArray(p.enrichment_sources) ? p.enrichment_sources.filter(Boolean) : []
  const sourceLabel = p.attribution_label || (sources.length ? t('profile.sources', { defaultValue: 'Sources' }) + ': ' + sources.join(', ') : null)
  const hasFacts = Boolean(p.name || p.symbol || description || facts.length || links.length)
  const busy = state === 'loading' || state === 'enqueued'
  const unavailable = state === 'unavailable' || state === 'unsupported'
  const failure = error || (!profile && unavailable && reason && !['missing_coverage','refresh_required','insufficient_entitlement'].includes(reason) ? t('profile.source_error', { defaultValue: 'Project details are temporarily unavailable from the shared source. Retry to check again.' }) : null)
  const stale = state === 'stale' || state === 'stale_refreshing'
  const fetched = p.last_enriched_at && Number.isFinite(Date.parse(p.last_enriched_at)) ? p.last_enriched_at : null
  return (
    <section aria-label={t('profile.title', { defaultValue: 'Project profile' })} className="intel-project-profile py-4 space-y-3 border-y border-[var(--border)]">
      {safeUrl(p.header_image_url) && <img src={p.header_image_url} alt="" className="w-full h-20 object-cover" />}
      <div className="flex items-start gap-3">
        {(p.name || p.symbol) && <TokenAvatar src={p.image_url} symbol={p.symbol} name={p.name} size="lg" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-3 flex-wrap">
            <h3 className="text-base font-semibold text-[var(--fg-1)]">{title}</h3>
            {p.symbol && p.name && <span className="text-xs text-[var(--fg-4)]">{p.symbol}</span>}
            {p.profile_complete === false && hasFacts && <span className="text-xs text-[var(--fg-4)]">{t('profile.incomplete', { defaultValue: 'Partial' })}</span>}
            {stale && <span className="text-xs text-[var(--fg-4)]">{t('profile.stale', { defaultValue: 'Stale' })}</span>}
          </div>
          {description && <><p className="text-xs text-[var(--fg-4)] mt-2">{t('profile.description_context', { defaultValue: 'Provider description. Figures reflect the retrieved metadata snapshot.' })}</p><p className="text-sm text-[var(--fg-3)] mt-2 break-words">{description.length > 280 ? description.slice(0,280).replace(/\s+\S*$/, '') + '…' : description}</p>
            {description.length > 280 && <details className="intel-evidence-expand mt-2"><summary>{t('profile.read_full', { defaultValue: 'Read full profile' })}</summary><p className="text-sm text-[var(--fg-3)] mt-2 break-words">{description}</p></details>}</>}
          {categories.length > 0 && <p className="text-xs text-[var(--fg-4)] mt-2 break-words">{categories.slice(0,8).join(' · ')}</p>}
          {categories.length > 8 && <details className="intel-evidence-expand mt-2"><summary>{t('profile.all_categories', { defaultValue: 'All classifications' })}</summary><p className="text-xs mt-2">{categories.join(' · ')}</p></details>}
        </div>
      </div>
      {busy && <p role="status" className="text-sm text-[var(--fg-4)]">{state === 'enqueued' ? t('profile.refreshing', { defaultValue: 'Building this token’s profile… check back in a moment.' }) : t('profile.loading', { defaultValue: 'Loading project details…' })}</p>}
      {failure && <p role="alert" className="text-sm text-[var(--fg-3)]">{failure}</p>}
      {!busy && !failure && !hasFacts && <p className="text-sm text-[var(--fg-4)]">{t('profile.missing_details', { defaultValue: 'No verified project details are available in the shared cache.' })}</p>}
      {unavailable && reason === 'insufficient_entitlement' && <p className="text-sm text-[var(--fg-4)]">{t('profile.no_access', { defaultValue: 'The current provider plan does not include these details.' })}</p>}
      {links.length > 0 && <nav aria-label={t('profile.links', { defaultValue: 'Project source links' })} className="flex flex-wrap gap-x-4 gap-y-2 text-sm">{links.map(([label,href],index) => <a key={index} href={href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4 break-all">{label}</a>)}</nav>}
      {facts.length > 0 && <dl className="flex flex-wrap gap-x-8 gap-y-3">{facts.map(([label,value]) => <div key={label}><dt className="text-xs text-[var(--fg-4)]">{label}</dt><dd className="text-sm text-[var(--fg-1)] font-mono">{value}</dd></div>)}</dl>}
      {(sourceLabel || fetched || onRetry) && <footer className="text-xs text-[var(--fg-4)] flex items-center flex-wrap gap-x-4 gap-y-2">
        {sourceLabel && <span>{sourceLabel}</span>}
        {fetched && <span>{t('profile.retrieved', { defaultValue: 'Metadata retrieved' })} <time dateTime={fetched}>{new Date(fetched).toLocaleString()}</time></span>}
        {onRetry && <button type="button" disabled={busy} onClick={onRetry} className="btn btn--ghost btn--sm">{t('profile.retry', { defaultValue: 'Refresh project details' })}</button>}
      </footer>}
    </section>
  )
}
