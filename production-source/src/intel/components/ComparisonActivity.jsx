import React,{useEffect,useMemo,useRef,useState} from 'react'
import {useTranslation} from 'react-i18next'
import {useProfile} from '../../lib/profile-context'
import {useSupabase} from '../../lib/useSupabase'
import {canonicalPortfolioKey} from '../lib/asset-identity'
import {useAssetPortfolioContext} from '../lib/useAssetPortfolioContext'
import {useAssetThesisHistory} from '../lib/useAssetThesisHistory'
import {useContractChartEvidence} from '../lib/useContractChartEvidence'
import {mergeLinkedAssetMarkers,markerWindow,clusterMarkers} from '../lib/chart-history'
import AssetPortfolioPosition from './AssetPortfolioPosition'
import ContractChartEvidenceStatus from './ContractChartEvidenceStatus'
import {MarkerDetails} from './TokenChart'

/** One selected asset, bounded retained readers. Comparison URLs and captures
 * contain no positions, private words or selected event. */
export default function ComparisonActivity({assets=[],from,to,onEventTime,timezone='UTC'}){
 const {user}=useSupabase(),{org}=useProfile(),[selected,setSelected]=useState(null)
 const asset=assets.find(a=>a.asset===selected)||assets[0]
 if(!asset||!Number.isFinite(from)||!Number.isFinite(to)||from>=to)return null
 return <section className="intel-open-section" aria-label="Comparison position and activity">
  <label className="intel-inline-field">Activity for<select className="select" value={asset.asset} onChange={e=>{setSelected(e.target.value);onEventTime?.(null)}}>{assets.slice(0,4).map(a=><option key={a.asset} value={a.asset}>{a.label||a.asset}</option>)}</select></label>
  <Activity key={`${user?.id}:${org?.id}:${asset.asset}`} asset={asset} from={from} to={to} onEventTime={onEventTime} timezone={timezone}/>
 </section>
}
function Activity({asset,from,to,onEventTime,timezone}){
 const {t}=useTranslation('intel',{useSuspense:false}),key=canonicalPortfolioKey(asset.asset)
 const position=useAssetPortfolioContext({canonicalAssetKey:key,from,to})
 const research=useAssetThesisHistory({canonicalKey:key||asset.asset,entityId:asset.entity?.id,from,to})
 const publicEvidence=useContractChartEvidence({canonicalKey:key,from,to,portfolioId:position.portfolioId})
 const [selection,setSelection]=useState(null),[showPublic,setShowPublic]=useState(true),[history,setHistory]=useState(false)
 const pinned=useRef(false),timer=useRef(null),origin=useRef(null)
 // A moving window is a read range, not a new owner or asset. Retain pinned
 // original words through that refresh, but clear them on a portfolio switch.
 const scope=position.portfolioId
 const markers=useMemo(()=>[...mergeLinkedAssetMarkers(position.markers,research.markers),...(showPublic?publicEvidence.markers:[])],[position.markers,research.markers,publicEvidence.markers,showPublic])
 const visible=markerWindow(markers,from,to).visible,clusters=clusterMarkers(visible,from,to)
 const current=selection?.scope===scope?selection.events.filter(e=>e.t>=from&&e.t<=to&&((research.loading||position.loading||publicEvidence.loading)?true:visible.some(v=>v.id===e.id))):[]
 const date=time=>new Date(time).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'long',timeZone:timezone})
 const close=()=>{clearTimeout(timer.current);pinned.current=false;setSelection(null);onEventTime?.(null)}
 useEffect(()=>{const esc=e=>{if(e.key==='Escape'){origin.current?.focus();close()}};document.addEventListener('keydown',esc);return()=>{clearTimeout(timer.current);document.removeEventListener('keydown',esc)}},[onEventTime]) // eslint-disable-line
 useEffect(()=>{close()},[scope]) // eslint-disable-line
 const open=(events,target,pin=false)=>{clearTimeout(timer.current);if(pinned.current&&!pin)return;origin.current=target;pinned.current=pin;setSelection({scope,events});onEventTime?.(events[0].t)}
 const leave=()=>{if(!pinned.current)timer.current=setTimeout(close,160)}
 return <>
  {key?<AssetPortfolioPosition context={position} compact/>:<p className="intel-analysis-caption">Open this asset and choose an exact network to inspect holdings and public contract activity. Its own thesis history remains available here.</p>}
  <p className="intel-analysis-caption">{date(from)} – {date(to)}. Event positions use the comparison's continuous time range; they are not execution prices. Current holdings are separate from this historical window.</p>
  {publicEvidence.enabled&&<label className="intel-inline-field"><input type="checkbox" checked={showPublic} onChange={e=>{setShowPublic(e.target.checked);close()}}/>Show public market events</label>}
  {research.error&&<p role="alert">{research.error} <button className="intel-text-link" onClick={research.refresh}>Retry thesis history</button></p>}
  {(research.loading||position.loading)&&<p role="status">Reading position and research history…</p>}
  <ContractChartEvidenceStatus evidence={publicEvidence}/>
  <div className="intel-event-lane" aria-label="Comparison activity timeline">{clusters.map(cluster=><button key={cluster.events[0].id} type="button" style={{left:`${(cluster.t-from)/(to-from)*100}%`}} aria-label={`${date(cluster.t)} · ${cluster.events.length} events · ${[...new Set(cluster.events.map(e=>e.action||e.label||e.type))].join(', ')}`} onMouseEnter={e=>open(cluster.events,e.currentTarget)} onFocus={e=>open(cluster.events,e.currentTarget)} onMouseLeave={leave} onBlur={leave} onClick={e=>open(cluster.events,e.currentTarget,true)}>│<span>{cluster.events.length>1?cluster.events.length:'◆'}</span></button>)}</div>
  {!visible.length&&!research.loading&&!position.loading&&!research.error&&!position.error&&!publicEvidence.error&&<p role="status">No loaded events in this comparison window.</p>}
  {visible.length>0&&<><button className="intel-text-link" aria-expanded={history} onClick={()=>setHistory(!history)}>{history?'Hide comparison events':'Read comparison events'} ({visible.length})</button>{history&&<ol className="intel-event-list">{visible.map(e=><li key={e.id}><button onClick={event=>open([e],event.currentTarget,true)}><time>{date(e.t)}</time><span>{e.action||e.label||e.type}</span><span>{e.title||''}</span></button></li>)}</ol>}</>}
  {(research.nextCursor||position.nextCursor)&&<button className="btn" disabled={research.loadingMore||position.loadingMore} onClick={()=>Promise.allSettled([research.loadMore(),position.loadMore()])}>Load more personal activity</button>}
  {!!current?.length&&<MarkerDetails timezone={timezone} events={current} onClose={close} t={t} onMouseEnter={()=>clearTimeout(timer.current)} onMouseLeave={leave} onSelect={e=>onEventTime?.(e.t)}/>}
 </>
}
