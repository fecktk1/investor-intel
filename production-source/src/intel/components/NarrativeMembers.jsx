import React, { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useSupabase } from '../../lib/useSupabase'
import { loadNarrativeMembers } from '../lib/narratives-api'
import { narrativeMemberIdentity, narrativeMemberPath } from '../lib/narrative-members'
import { ResolvedCmcPosition } from './CmcAssetPosition'
import TokenAvatar from './TokenAvatar'
import { fmtPrice, fmtPct } from '../lib/market-format'

export default function NarrativeMembers({ narrativeId }) {
  const { supabase } = useSupabase(), [params, setParams] = useSearchParams()
  const rawPage = Number(params.get('members_page') || 0), page = Number.isInteger(rawPage) && rawPage >= 0 && rawPage <= 499 ? rawPage : 0
  let selected
  try { selected = JSON.parse(params.get('members_selection') || '[]') } catch { selected = [] }
  selected = Array.isArray(selected) ? selected.slice(0, 4).map(row => narrativeMemberIdentity({ asset_provider: row?.sourceProvider, asset_provider_id: row?.providerId, symbol: typeof row?.symbol === 'string' ? row.symbol.slice(0, 40) : null })).filter(Boolean) : []
  selected = [...new Map(selected.map(row => [`${row.sourceProvider}:${row.providerId}`, row])).values()]
  const [state, setState] = useState(null), [retry, setRetry] = useState(0), [position, setPosition] = useState(null)
  const scope = `${narrativeId}:${page}`
  useEffect(() => {
    let active = true; setState(null); setPosition(null)
    loadNarrativeMembers(supabase, narrativeId, page).then(data => { if (active) setState({ scope, ...data }) })
      .catch(error => { if (active) setState({ scope, error }) })
    return () => { active = false }
  }, [supabase, narrativeId, page, retry])
  const visible = state?.scope === scope ? state : null
  const change = (key, value) => setParams(current => { const next = new URLSearchParams(current); next.set(key, value); return next }, { replace: true })
  const toggle = identity => {
    const exists = selected.some(row => row.canonicalAssetKey === identity.canonicalAssetKey)
    change('members_selection', JSON.stringify(exists ? selected.filter(row => row.canonicalAssetKey !== identity.canonicalAssetKey) : [...selected, identity].slice(0, 4)))
  }
  return <section className="intel-narrative-members" aria-label="Narrative member assets">
    <div className="flex items-center justify-between flex-wrap gap-2"><h2 className="intel-section-title">Member assets</h2>
      {selected.length >= 2 && <Link className="btn btn--quiet btn--sm" to={`/intel/compare?assets=${encodeURIComponent(JSON.stringify(selected))}`}>Compare {selected.length} selected assets</Link>}
    </div>
    <p className="intel-analysis-caption">These are Investor Intel’s current narrative members. CMC sector classifications are separate. Select up to four assets to compare; historical membership is not inferred.</p>
    {!visible ? <p role="status">Reading narrative members…</p> : visible.error ? <p role="alert">Member assets could not be read. <button className="intel-text-link" onClick={() => setRetry(n => n + 1)}>Retry members</button></p> : <>
      {!visible.rows.length ? <p>No member records are available on this page.</p> : <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Member assets table"><table className="intel-evidence-table w-full">
        <thead><tr><th scope="col">Compare</th><th scope="col">Asset</th><th scope="col">Recorded price · USD</th><th scope="col">24h change</th><th scope="col">Identity & membership</th><th scope="col">Open</th></tr></thead>
        <tbody>{visible.rows.map(row => {
          const identity = narrativeMemberIdentity(row), path = narrativeMemberPath(row), checked = identity && selected.some(member => member.canonicalAssetKey === identity.canonicalAssetKey)
          return <tr key={row.id}><td><input type="checkbox" aria-label={`Compare ${row.symbol || row.asset_provider_id || 'unresolved member'} ${row.asset_provider || ''} ${row.asset_provider_id || ''}`} disabled={!identity || !checked && selected.length >= 4} checked={!!checked} onChange={() => toggle(identity)}/></td>
            <th scope="row"><span className="flex gap-2 items-center"><TokenAvatar src={row.market?.imageUrl} symbol={row.symbol} name={row.market?.name} size="sm"/><span>{path ? <Link className="intel-text-link" to={path}>{row.symbol || row.asset_provider_id}</Link> : row.symbol || 'Unresolved member'}{row.market?.name && <small className="block">{row.market.name}</small>}{row.is_leader && <small className="block">Narrative leader</small>}</span></span></th>
            <td className="intel-narrative-number">{row.marketState === 'error' ? 'Quote read failed' : row.market ? <>{fmtPrice(row.market.price)}<small className="block">{row.market.observedAt ? <time dateTime={row.market.observedAt} title={`Observed ${row.market.observedAt}; retrieved ${row.market.retrievedAt || 'unreported'}`}>{new Date(row.market.observedAt).toLocaleString(undefined, {timeZoneName:'short'})}</time> : 'Observation time unreported'}</small></> : 'No cached quote'}</td>
            <td className="intel-narrative-number">{fmtPct(row.market?.change24hPct)}</td>
            <td>{identity ? `${identity.sourceProvider === 'coinmarketcap' ? 'CoinMarketCap' : 'CoinGecko'} · ${identity.providerId}` : 'Identity not verified'}<small className="block">{row.membership_source || 'Membership source unreported'} · updated {row.updated_at && Number.isFinite(Date.parse(row.updated_at)) ? <time dateTime={row.updated_at} title={new Date(row.updated_at).toISOString()}>{new Date(row.updated_at).toLocaleString(undefined, {timeZoneName:'short'})}</time> : 'time unreported'}</small></td>
            <td>{identity && <div className="flex gap-3 flex-wrap"><Link className="intel-text-link" to={path}>Chart & thesis</Link><Link className="intel-text-link" to={`/intel/investigate?asset=${encodeURIComponent(identity.canonicalAssetKey)}`}>Investigate</Link>{identity.sourceProvider === 'coinmarketcap' && <button className="intel-text-link" onClick={() => setPosition(position?.id === row.id ? null : { id: row.id, assetId: identity.providerId, symbol: row.symbol })}>{position?.id === row.id ? 'Close position' : 'Your position'}</button>}</div>}</td>
          </tr>
        })}</tbody>
      </table></div>}
      {visible.rows.some(row => row.marketState === 'error') && <p role="alert">Some cached member quotes could not be read. Membership and links remain available. <button className="intel-text-link" onClick={() => setRetry(n => n + 1)}>Retry member quotes</button></p>}
      {position && <aside className="py-3" aria-label={`Position for ${position.symbol || position.assetId}`}><h3>Your {position.symbol || position.assetId} position</h3><ResolvedCmcPosition key={position.assetId} assetId={position.assetId} portfolioId={params.get('portfolio') || undefined}/></aside>}
      <div className="flex items-center gap-3 mt-2"><button className="btn btn--quiet btn--sm" disabled={page === 0} onClick={() => change('members_page', String(page - 1))}>Previous members</button><span>Page {page + 1}</span><button className="btn btn--quiet btn--sm" disabled={!visible.hasMore || page >= 499} onClick={() => change('members_page', String(page + 1))}>Next members</button>
        {!!selected.length && <button className="intel-text-link" onClick={() => change('members_selection', '[]')}>Clear selection</button>}
      </div>
    </>}
  </section>
}
