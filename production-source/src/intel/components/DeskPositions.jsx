import { portfolioQuoteStatus } from '../../../supabase/functions/_shared/intel/portfolio-quote'
import React, { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { useSupabase } from '../../lib/useSupabase'
import { useProfile } from '../../lib/profile-context'
import { usePortfolioSelection } from '../lib/PortfolioSelectionContext'
import { useWorkspacePreference } from '../context/PersonalWorkspace'
import TokenAvatar from './TokenAvatar'
const money = v => v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString(undefined,{style:'currency',currency:'USD'})
export default function DeskPositions() {
  const { supabase, user } = useSupabase(), { org } = useProfile(), selection = usePortfolioSelection(), prefs = useWorkspacePreference('desk')
  const [page,setPage] = useState(0), [state,setState] = useState({}), [attempt,setAttempt] = useState(0), [error,setError] = useState(null)
  const pinned = Array.isArray(prefs.value.pinnedAssets)?prefs.value.pinnedAssets:[], hideDust=!!prefs.value.hideDust
  const identity = `${user?.id}:${org?.id}:${selection.portfolioId}:${hideDust}:${JSON.stringify(pinned)}`, scope=`${identity}:${page}`
  useEffect(()=>setPage(0),[identity])
  useEffect(()=>{
    if (!org?.id || !user?.id || !selection.portfolioId || prefs.loading || prefs.error) return
    let alive=true;setState({scope,loading:true})
    supabase.rpc('intel_desk_positions',{p_org_id:org.id,p_portfolio_id:selection.portfolioId,p_hide_dust:hideDust,p_pinned:pinned,p_page:page}).then(({data,error})=>{
      if (alive) setState({scope,data,error:error?.message || (!data?.portfolio || !Array.isArray(data.rows)?'Your positions could not be read.':null)})
    }).catch(e=>{if(alive)setState({scope,error:e.message})})
    return()=>{alive=false}
  },[supabase,scope,attempt,prefs.loading,prefs.error]) // scoped identity includes every private query input
  const current=state.scope===scope?state:{loading:true}, data=current.data
  const save=patch=>prefs.save(patch).then(()=>setError(null)).catch(e=>setError(e.message))
  const pin=key=>save({pinnedAssets:pinned.includes(key)?pinned.filter(k=>k!==key):[...pinned,key]})
  return <section aria-label="Your desk positions" className="space-y-3"><div className="flex gap-4 flex-wrap items-center"><h2>Your positions</h2><label className="text-xs">Portfolio<select className="select ml-2" value={selection.portfolioId||''} disabled={selection.loading} onChange={e=>selection.selectPortfolio(e.target.value)}>{selection.portfolios.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label className="text-xs flex gap-2 items-center"><input type="checkbox" checked={hideDust} disabled={prefs.loading||!!prefs.error} onChange={e=>save({hideDust:e.target.checked})}/>Hide token balances below $1</label></div>
    {(error||prefs.error||selection.error||current.error)?<p role="alert">{error||prefs.error||selection.error?.message||current.error} <button className="intel-text-link" onClick={()=>{setAttempt(n=>n+1);if(prefs.error) prefs.reload()}}>Retry</button></p>:selection.loading||prefs.loading?<p role="status">Loading portfolio selection…</p>:!selection.portfolioId?<p>No portfolio selected. <Link className="intel-text-link" to="/intel/portfolio">Open Portfolio</Link></p>:current.loading?<p role="status">Loading your positions…</p>:data?<>
    <p className="text-sm">Book value <strong>{money(data.portfolio.value)}</strong> · {data.total} open positions · {data.hidden} hidden · {data.unpriced} unpriced{data.portfolio.incomplete?' · Incomplete history':''}</p><p className="text-xs text-[var(--fg-4)]">Display only. Hidden balances remain in totals and risk. Unpriced, native, stablecoin and pinned positions stay visible.</p>
    {data.rows.length?<div className="intel-table-scroll"><table aria-label="Desk positions"><thead><tr><th>Asset</th><th>Quantity</th><th>Value</th><th>Allocation</th>{prefs.value.advanced&&<><th>Cost / P&amp;L</th><th>Quote evidence</th></>}<th>Pin</th></tr></thead><tbody>{data.rows.map(h=><tr key={h.id}><th scope="row"><div className="flex gap-2 items-center"><TokenAvatar src={h.logo_url} symbol={h.asset_symbol}/>{h.canonical_asset_key?<Link className="intel-text-link" to={`/intel/portfolio/${selection.portfolioId}/asset/${encodeURIComponent(h.canonical_asset_key)}`}>{h.asset_symbol||h.name||h.canonical_asset_key}</Link>:<span>{h.asset_symbol||h.name||'Identity unavailable'}</span>}</div></th><td>{h.quantity==null?'—':Number(h.quantity).toLocaleString(undefined,{maximumSignificantDigits:8})}</td><td>{money(h.current_value)}</td><td>{h.allocation_pct==null?'—':`${Number(h.allocation_pct).toFixed(2)}%`}</td>{prefs.value.advanced&&<><td>{money(h.cost_basis_usd)} / {money(h.unrealized_pnl)}<small className="block">{h.cost_basis_status||h.pnl_state||'Basis coverage unknown'}</small></td><td>{h.price_source||'Source unavailable'} · {portfolioQuoteStatus(h)}<small className="block">{h.last_priced_at?new Date(h.last_priced_at).toLocaleString(undefined,{timeZoneName:'short'}):'Observation unavailable'}</small></td></>}<td><button className="intel-text-link" disabled={!h.canonical_asset_key||(!pinned.includes(h.canonical_asset_key)&&pinned.length>=200)} aria-label={`${pinned.includes(h.canonical_asset_key)?'Unpin':'Pin'} ${h.asset_symbol||h.name}`} onClick={()=>pin(h.canonical_asset_key)}>{pinned.includes(h.canonical_asset_key)?'Unpin':'Pin'}</button></td></tr>)}</tbody></table></div>:<p>No visible open positions. {data.hidden>0&&<button className="intel-text-link" onClick={()=>save({hideDust:false})}>Show hidden positions</button>}</p>}
    <nav aria-label="Desk position pages" className="flex gap-4"><button className="intel-text-link" disabled={!page} onClick={()=>setPage(n=>n-1)}>Previous</button><span className="text-xs">Page {page+1}</span><button className="intel-text-link" disabled={!data.hasMore} onClick={()=>setPage(n=>n+1)}>Next</button><Link className="intel-text-link" to="/intel/portfolio">Open full portfolio</Link></nav></>:null}
  </section>
}
