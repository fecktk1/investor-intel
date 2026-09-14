import React, { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import { fmtPrice, fmtVol } from '../lib/market-format'
import RwaSelectedPosition from './RwaSelectedPosition'

const amount = value => value != null && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null
export function rwaRelationships(record) {
  const tokens = (Array.isArray(record?.tokens) ? record.tokens : []).filter(token => Number.isSafeInteger(Number(token.crypto_id)) && Number(token.crypto_id) > 0)
  const issuers = new Map()
  for (const token of tokens) {
    const key = token.issuer_id || `unidentified:${token.crypto_id}`
    const issuer = issuers.get(key) || { id: token.issuer_id || null, key, name: token.issuer_name || 'Issuer not reported', value: 0, priced: 0, count: 0 }
    issuer.count++
    const value = amount(token.market_cap)
    if (value != null) { issuer.value += value; issuer.priced++ }
    issuers.set(key, issuer)
  }
  const reportedValue = tokens.reduce((sum, token) => sum + (amount(token.market_cap) || 0), 0)
  return { tokens, reportedValue, missingValue: tokens.filter(token => amount(token.market_cap) == null).length,
    issuers: [...issuers.values()].map(issuer => ({ ...issuer, share: reportedValue > 0 && issuer.priced ? issuer.value / reportedValue * 100 : null })).sort((a,b) => b.value - a.value) }
}

/** Uses the token/issuer relationships already returned in the RWA quote.
 * Market value describes the listed tokens; it is not underlying NAV or user exposure. */
export default function RwaRelationships({ record, onIssuer, showPosition=true }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const data = useMemo(() => rwaRelationships(record), [record])
  const [requestedPage, setPage] = useState(0)
  const page = Math.min(requestedPage, Math.max(0, Math.ceil(data.tokens.length / 12) - 1))
  if (!data.tokens.length) return <p className="text-sm text-[var(--fg-4)]">{t('research.rwa_relationship_empty', { defaultValue: 'No token-to-issuer relationships were reported for this asset.' })}</p>
  return <section className="space-y-4 border-y border-[var(--border-default)] py-4" aria-label={t('research.rwa_relationships', { defaultValue: 'Underlying asset, tokens and issuers' })}>
    <div><h3 className="text-lg font-medium">{record.name} <span className="text-[var(--fg-4)]">→ {data.tokens.length} {t('research.token_forms', { defaultValue: 'token representations' })}</span></h3>
      <p className="mt-1 text-sm text-[var(--fg-4)]">{t('research.rwa_relationship_explainer', { defaultValue: 'Trace each token to its reported issuer. Open the token workspace to connect your holdings and thesis history.' })}</p></div>
    <div className="grid gap-5 lg:grid-cols-[minmax(180px,1fr)_minmax(0,2fr)]">
      <div className="space-y-3"><h4 className="text-sm">{t('research.issuer_value', { defaultValue: 'Share of listed token value' })}</h4>
        {data.issuers.map(issuer => <div key={issuer.key} className="space-y-1 text-xs"><div className="flex justify-between gap-3">
          {issuer.id && onIssuer ? <button className="underline underline-offset-4 text-left" onClick={() => onIssuer(issuer.id)}>{issuer.name}</button> : <span>{issuer.name}</span>}
          <span className="intel-number">{issuer.share == null ? '—' : `${issuer.share.toFixed(1)}%`}</span></div>
          <div className="h-1 bg-[var(--border-default)]" aria-hidden="true"><div className="h-1 bg-[var(--accent)]" style={{ width: `${issuer.share || 0}%` }} /></div></div>)}
        <p className="text-xs text-[var(--fg-4)]">{t('research.reported_token_value', { defaultValue: 'Reported token value' })}: {fmtVol(data.missingValue < data.tokens.length ? data.reportedValue : null)} USD. {data.missingValue > 0 ? t('research.missing_token_value_count', { count: data.missingValue, defaultValue: 'Missing token values: {{count}}.' }) : ''}</p>
      </div>
      <div className="intel-table-scroll"><table><thead><tr><th>{t('research.token', { defaultValue: 'Token' })}</th><th>{t('research.issuer', { defaultValue: 'Issuer' })}</th><th className="intel-number">{t('research.price_usd', { defaultValue: 'Price (USD)' })}</th><th className="intel-number">{t('research.value_usd', { defaultValue: 'Value (USD)' })}</th></tr></thead>
        <tbody>{data.tokens.slice(page*12,page*12+12).map(token => <tr key={token.crypto_id}><th scope="row"><Link className="underline underline-offset-4 text-sm" to={`/intel/markets/${encodeURIComponent(token.symbol || token.name || String(token.crypto_id))}?provider=coinmarketcap&id=${token.crypto_id}`}>{token.name || token.symbol}</Link><span className="block text-xs text-[var(--fg-4)]">{token.symbol}</span></th><td>{token.issuer_name || '—'}</td><td className="intel-number">{fmtPrice(amount(token.price))}</td><td className="intel-number">{fmtVol(amount(token.market_cap))}</td></tr>)}</tbody></table></div>
    </div>
    {data.tokens.length > 12 && <div className="flex justify-between"><button className="btn" disabled={page===0} onClick={() => setPage(page-1)}>{t('common.previous', { defaultValue: 'Previous' })}</button><span className="text-xs">{page+1} / {Math.ceil(data.tokens.length/12)}</span><button className="btn" disabled={(page+1)*12>=data.tokens.length} onClick={() => setPage(page+1)}>{t('common.next', { defaultValue: 'Next' })}</button></div>}
    <p className="text-xs text-[var(--fg-4)]">{t('research.rwa_terms_context', { defaultValue: 'This compares reported token market values. Ownership rights, redemption terms and underlying net asset value require issuer evidence.' })}</p>
    {showPosition&&<RwaSelectedPosition tokens={data.tokens}/>}
    {/^[1-9][0-9]{0,11}$/.test(String(record.rwa_id))&&<Link className="intel-text-link" to={`/intel/investigate?asset=rwa%3Acoinmarketcap%3A${record.rwa_id}&lens=sessions`}>{t('research.issuer_sessions',{defaultValue:'Investigate issuer terms and trading hours'})}</Link>}
  </section>
}
