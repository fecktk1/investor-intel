import React from 'react'
import { useTranslation } from 'react-i18next'
import SourceCallReceipt from './SourceCallReceipt'
import ProviderText from './ProviderText'
import { hasProviderMarkdown } from '../lib/provider-text'
import DemoNotInSnapshot from '../demo/DemoNotInSnapshot'
import { DEMO_MISS_CODE, DEMO_MISS_TEXT } from '../demo/demo-fetch'

export function sourceHref(value) { try { const url = new URL(value); return url.protocol === 'https:' ? url.href : null } catch { return null } }
const title = key => key.replace(/_/g, ' ').replace(/\busd\b/gi, 'USD')
export function SharedResearchRefresh({query}){
  if(!query.liveEnabled)return null
  return <p className="intel-analysis-caption">{query.livePaused?'Automatic shared-cache reads paused.':'Reading shared updates while this view is visible.'} <button className="intel-text-link" onClick={()=>query.setLivePaused(!query.livePaused)}>{query.livePaused?'Resume updates':'Pause updates'}</button></p>
}
export function EvidenceRecord({ record, depth = 0 }) {
  if (!record || typeof record !== 'object' || depth > 4) return null
  return <dl className="intel-evidence-facts">{Object.entries(record).filter(([key, value]) => value != null && key !== 'quote').map(([key, value]) => <div key={key}>
    <dt>{title(key)}</dt><dd>{typeof value === 'object'
      ? <details><summary>{Array.isArray(value) ? `${value.length} records` : title(key)}</summary>{Array.isArray(value) ? value.slice(0, 100).map((item, i) => typeof item === 'object' ? <EvidenceRecord key={i} record={item} depth={depth + 1}/> : <p key={i}>{String(item)}</p>) : <EvidenceRecord record={value} depth={depth + 1}/>}</details>
      : sourceHref(String(value)) ? <a href={sourceHref(String(value))} target="_blank" rel="noopener noreferrer">{String(value)}</a>
      // Provider prose with markdown markers ("### ") renders as headings and lists, never with its markers.
      : typeof value === 'string' && hasProviderMarkdown(value) ? <ProviderText text={value}/> : typeof value === 'number' ? value.toLocaleString(undefined, { maximumFractionDigits: 8 }) : String(value)}</dd>
  </div>)}{record.quote && <div><dt>USD quote</dt><dd><EvidenceRecord record={record.quote} depth={depth + 1}/></dd></div>}</dl>
}
export function ResearchStatus({ query, showObserved=true, quietEmpty=false }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { result, loading, error, refresh } = query
  if (loading) return <p role="status" className="intel-event-meta py-4">{t('research.loading_evidence', { defaultValue: 'Loading market evidence…' })}</p>
  // Public demo: a read today's snapshot does not hold. No retry: it cannot answer differently.
  if (result?.reason === DEMO_MISS_CODE || error === DEMO_MISS_CODE || error === DEMO_MISS_TEXT) return <p role="status" className="py-4 text-sm text-[var(--fg-4)]"><DemoNotInSnapshot/></p>
  const unavailableReason = result?.reason === 'insufficient_entitlement' && result?.capability === 'rwaPairs' ? 'RWA market pairs require CMC Growth or above. Token prices and issuer research remain available.' : null
  if (error || ['unavailable', 'unsupported', 'refreshing'].includes(result?.state)) return <div role="status" className="py-4 text-sm text-[var(--fg-4)]">
    {error&&result&&<p role="alert">The latest read failed. Previously loaded evidence keeps its original source time.</p>}
    <p>{unavailableReason || (error === 'read_timeout' && !result
      ? t('research.read_timeout', { defaultValue: 'This read did not answer within 30 seconds, so it was stopped.' })
      : t(`research.reason_${result?.reason || 'unavailable'}`, { defaultValue: result?.reason ? title(result.reason) : 'This source is unavailable.' }))}</p>
    {!unavailableReason && <button className="underline underline-offset-4 mt-2" onClick={refresh}>{t('common.retry', { defaultValue: 'Retry' })}</button>}
    {/* A refused or failed call still has a receipt, and that is exactly when a reader wants it. */}
    <SourceCallReceipt receipt={result?.receipt} scope={result?.scope} observedAt={result?.provenance?.observedAt}/>
  </div>
  const p = result?.provenance
  return <>
    <div className="intel-source-strip py-3">
      <a href="https://coinmarketcap.com" target="_blank" rel="noopener noreferrer">CoinMarketCap</a>
      {result?.state === 'stale' && <strong>{t('research.stale', { defaultValue: 'Delayed data' })}</strong>}
      {showObserved && p?.observedAt && <span>{t('research.observed', { defaultValue: 'Observed' })} <time dateTime={p.observedAt}>{new Date(p.observedAt).toLocaleString()}</time></span>}
      {p?.fetchedAt && <span>{t('research.fetched', { defaultValue: 'Retrieved' })} <time dateTime={p.fetchedAt}>{new Date(p.fetchedAt).toLocaleString()}</time></span>}
      {/* A page that explains an empty answer itself (quietEmpty) says it once, in its own words. */}
      {!loading && !quietEmpty && !result?.data?.rows?.length && <span>{t('research.no_coverage', { defaultValue: 'No records returned for this selection.' })}</span>}
    </div>
    <SourceCallReceipt receipt={result?.receipt} scope={result?.scope} observedAt={showObserved ? p?.observedAt : null}/>
  </>
}
