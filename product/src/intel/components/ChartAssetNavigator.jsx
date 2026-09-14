import React,{useEffect,useRef,useState} from 'react'
import {Link} from 'react-router'
import {requestChartWorkspace} from '../lib/chart-workspace-api'
import TokenAvatar from './TokenAvatar'
import {CHAINS} from '../lib/chains'
import {useWatchlistSelection} from '../context/WatchlistSelection'
import {watchlistAssetPage} from '../lib/watchlist-api'

export function chartAssetHref(row){
 const market=/^(?:market|rwa):(coinmarketcap|coingecko):(.+)$/.exec(row.asset||'')
 if(market)return `/intel/markets/${encodeURIComponent(row.symbol||'asset')}?${new URLSearchParams({provider:market[1],id:market[2]})}`
 return row.asset?`/intel/asset/${encodeURIComponent(row.asset)}`:null
}
export function chartAssetCaption(asset){
 const market=/^(?:market|rwa):(coinmarketcap|coingecko):(.+)$/.exec(asset||'')
 if(market)return `${market[1]==='coinmarketcap'?'CoinMarketCap':'CoinGecko'} · ${market[2]}`
 const evm=/^eip155:(\d+)(?:\/erc20:|:)(.+)$/.exec(asset||'')
 if(evm){const chain=CHAINS.find(c=>String(c.evmChainId)===evm[1]);return `${chain?.label||`Chain ${evm[1]}`} · ${evm[2]==='native'?'Native asset':`${evm[2].slice(0,8)}…${evm[2].slice(-6)}`}`}
 const native=CHAINS.find(c=>asset===`native:${c.id}`)
 return native?`${native.label} · Native asset`:asset?.startsWith('solana:')?`Solana · ${asset.slice(7,15)}…${asset.slice(-6)}`:asset||'Chart identity unavailable'
}
function ChartAssetNavigatorBody({context}){
 const watchlists=useWatchlistSelection()
 const [open,setOpen]=useState(false),[tab,setTab]=useState('recent'),[page,setPage]=useState(0),[rows,setRows]=useState([]),[hasMore,setHasMore]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState(null),[refresh,setRefresh]=useState(0),[clearing,setClearing]=useState(false)
 const dialog=useRef(null),trigger=useRef(null),sequence=useRef(0),alive=useRef(true),visit=useRef(null)
 const {userId,orgId,asset,supabase}=context
 useEffect(()=>{
  alive.current=true
  if(!visit.current)visit.current=requestChartWorkspace(context,{operation:'navigation_visit',asset}).then(()=>null,error=>error)
  return()=>{alive.current=false;sequence.current++}
 },[userId,orgId,asset,supabase]) // eslint-disable-line react-hooks/exhaustive-deps
 useEffect(()=>{
  if(!open)return
  dialog.current?.showModal();const request=++sequence.current;setRows([]);setLoading(true);setError(null)
  if(tab==='watchlist'&&!watchlists.unavailable&&watchlists.loading)return
  void (async()=>{
   try{if(tab==='watchlist'&&watchlists.error)throw Error(watchlists.error);const visitError=await visit.current;const result=tab==='watchlist'&&!watchlists.unavailable?await watchlistAssetPage(supabase,orgId,watchlists.selected?.id,page):await requestChartWorkspace(context,{operation:'navigation_list',tab,page});if(alive.current&&request===sequence.current){setRows(result.assets);setHasMore(result.hasMore);if(visitError&&tab==='recent')setError('This chart could not be added to recent assets. Your saved history is shown below.')}}
   catch(e){if(alive.current&&request===sequence.current)setError(e.message)}finally{if(alive.current&&request===sequence.current)setLoading(false)}
  })()
  return()=>{sequence.current++}
 },[open,tab,page,refresh,userId,orgId,asset,supabase,watchlists.selected?.id,watchlists.loading,watchlists.error]) // eslint-disable-line react-hooks/exhaustive-deps
 const close=()=>{setOpen(false);sequence.current++;trigger.current?.focus()}
 const clear=async()=>{
  setClearing(true);setError(null)
  try{await visit.current;await requestChartWorkspace(context,{operation:'navigation_clear'});if(alive.current){setRows([]);setHasMore(false);setPage(0);setRefresh(n=>n+1)}}catch(e){if(alive.current)setError(e.message)}finally{if(alive.current)setClearing(false)}
 }
 return <><button type="button" ref={trigger} onClick={()=>setOpen(true)}>Assets</button>{open&&<dialog ref={dialog} className="intel-chart-study-dialog intel-chart-asset-navigator" aria-labelledby="chart-assets-title" onCancel={e=>{e.preventDefault();close()}}>
  <div className="intel-investigation-analysis-heading"><h2 id="chart-assets-title">Move between assets</h2><button type="button" onClick={close}>Close</button></div>
  <nav aria-label="Asset list" className="intel-chart-asset-tabs">{['recent','watchlist'].map(value=><button key={value} type="button" aria-pressed={tab===value} onClick={()=>{setTab(value);setPage(0)}}>{value==='recent'?'Recent':'Your watchlist'}</button>)}</nav>
  <p className="intel-analysis-caption">{tab==='recent'?'Your 30 most recent chart assets, kept for up to 90 days.':`Selected workspace list: ${watchlists.selected?.name || 'Default watchlist'}`}</p>
  {tab==='watchlist'&&!watchlists.unavailable&&<label>Watchlist <select value={watchlists.selected?.id||''} onChange={e=>{setPage(0);watchlists.select(e.target.value).catch(e=>setError(e.message))}}>{watchlists.lists.map(list=><option key={list.id} value={list.id}>{list.name}</option>)}</select></label>}
  {error&&<p role="alert">{error} <button type="button" onClick={()=>setRefresh(n=>n+1)}>Retry</button></p>}
  {loading?<p role="status">Loading assets…</p>:rows.length?<ul className="intel-chart-asset-list">{rows.map((row,index)=><li key={row.asset||index}><TokenAvatar src={row.logo} symbol={row.symbol} name={row.name} size="sm"/><div>{chartAssetHref(row)?<Link to={chartAssetHref(row)} onClick={close} aria-current={row.asset===asset?'page':undefined}>{row.name}{row.symbol&&row.symbol!==row.name?` (${row.symbol})`:''}</Link>:<span>{row.name} · Open from Watchlist</span>}<p title={row.asset||undefined}>{chartAssetCaption(row.asset)}</p></div></li>)}</ul>:!error&&<p>{tab==='recent'?'No recent chart assets.':'No assets in your watchlist yet.'}</p>}
  <div className="intel-chart-navigation"><button type="button" disabled={loading||clearing||page===0} onClick={()=>setPage(n=>n-1)}>Previous</button><span>Page {page+1}</span><button type="button" disabled={loading||clearing||!hasMore} onClick={()=>setPage(n=>n+1)}>Next</button></div>
  <div className="intel-chart-asset-footer"><Link to="/intel/watchlist" onClick={close}>Manage watchlist</Link>{tab==='recent'&&<button type="button" disabled={loading||clearing||!rows.length} onClick={clear}>{clearing?'Clearing…':'Clear recent assets'}</button>}</div>
 </dialog>}</>
}
export default function ChartAssetNavigator({context}){return context?.userId&&context?.orgId&&context?.asset?<ChartAssetNavigatorBody key={`${context.userId}:${context.orgId}:${context.asset}`} context={context}/>:null}
