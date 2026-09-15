import React,{useEffect,useState} from 'react'
import {Link,useParams} from 'react-router'
import {useSupabase} from '../../lib/useSupabase'
import {useProfile} from '../../lib/profile-context'
import {requestChartWorkspace} from '../lib/chart-workspace-api'
import TokenChart from '../components/TokenChart'
import ChartShareControls from '../components/ChartShareControls'
import ChartExportControls from '../components/ChartExportControls'
import SavedComparisonChart from '../components/SavedComparisonChart'
import {restrictExpiredSnapshot} from '../lib/chart-snapshot-view'
export default function ChartSnapshotPage(){const {user}=useSupabase(),{org}=useProfile(),{id}=useParams();return <SnapshotBody key={`${user?.id}:${org?.id}:${id}`} id={id}/>}
function SnapshotBody({id}) {
 const {supabase,user}=useSupabase(),{org}=useProfile(),[snapshot,setSnapshot]=useState(null),[error,setError]=useState(null),[revision,setRevision]=useState(0),[deleted,setDeleted]=useState(false),[busy,setBusy]=useState(false)
 const context={supabase,userId:user?.id,orgId:org?.id}
 useEffect(()=>{
  if(!user?.id||!org?.id||deleted)return
  let alive=true,pending=false,expiry
  const refresh=async()=>{if(pending||document.visibilityState==='hidden')return;pending=true
   try{const r=await requestChartWorkspace(context,{operation:'snapshot_get',id});if(!alive)return;const checked=restrictExpiredSnapshot(r.snapshot);setSnapshot(checked);setError(null);clearTimeout(expiry)
    const until=checked.availability?.retainUntil
    if(until)expiry=setTimeout(()=>{if(alive){setSnapshot(s=>s?restrictExpiredSnapshot(s):s);void refresh()}},Math.max(0,Math.min(until-Date.now(),2147483647)))
   }catch(e){if(alive){setSnapshot(null);setError(e.message)}}finally{pending=false}}
  const visible=()=>{if(document.visibilityState==='visible'){setSnapshot(null);void refresh()}}
  void refresh();const timer=setInterval(refresh,60000);document.addEventListener('visibilitychange',visible)
  return()=>{alive=false;clearInterval(timer);clearTimeout(expiry);document.removeEventListener('visibilitychange',visible)}
 },[id,user?.id,org?.id,supabase,revision,deleted]) // eslint-disable-line
 const remove=async()=>{setBusy(true);setError(null);try{await requestChartWorkspace(context,{operation:'snapshot_delete',id});setSnapshot(null);setDeleted(true)}catch(e){setError(e.message)}finally{setBusy(false)}}
 const state=snapshot?.state
 return <div className="space-y-4"><Link className="intel-text-link" to="/intel/research">Saved Research</Link><header><p className="eyebrow">Private chart snapshot</p><h1 className="page-title">{snapshot?.title||'Chart snapshot'}</h1></header>
  {error&&<p role="alert">{error} <button className="intel-text-link" onClick={()=>setRevision(r=>r+1)}>Retry</button></p>}{!state&&!error&&!deleted&&<p role="status">Loading your snapshot…</p>}{deleted&&<p role="status">Snapshot and its Saved Research item deleted.</p>}
  {state&&<><p className="intel-analysis-caption">Captured {new Date(state.capturedAt).toLocaleString()} · saved {new Date(snapshot.created_at).toLocaleString()} · {state.layout.timezone} · calculation {state.calculationVersion}</p>
   {state.layout.comparison?<SavedComparisonChart key={id} state={state}/>:state.bars?.length?<TokenChart key={id} candles={state.bars} assetKey={state.layout.asset} initialLayout={state.layout} readOnly priceCoverage={{chartSource:state.source}}/>:<p className="intel-analysis-caption">The original price series is unavailable. Its verified source reference remains saved.</p>}
   {snapshot.availability?.retainUntil&&<p className="intel-analysis-caption">Saved prices available through {new Date(snapshot.availability.retainUntil).toLocaleString()}. Your notes and source references remain saved after that date.</p>}
   {state.gaps?.map((gap,i)=><p key={i} role="status">{gap}</p>)}
   {snapshot.viewRestrictions?.map((gap,i)=><p key={i} role="status">{gap}</p>)}
   {!state.bars?.length&&state.layout.drawings.length>0&&<section><h2>Selected annotations</h2><ul className="intel-study-list">{state.layout.drawings.map(d=><li key={d.id}>{d.text||d.tool.replaceAll('_',' ')}</li>)}</ul></section>}
   <details className="intel-chart-readings"><summary>Source and snapshot integrity</summary><dl className="intel-event-facts"><dt>Asset</dt><dd>{state.layout.asset}</dd><dt>Provider</dt><dd>{state.source.provider}</dd><dt>Currency</dt><dd>{state.source.currency}</dd><dt>Original observations</dt><dd>{state.barCount}</dd><dt>Series SHA-256</dt><dd className="break-all">{state.sourceHash}</dd><dt>Snapshot SHA-256</dt><dd className="break-all">{state.hash}</dd></dl></details>
   <div className="intel-investigation-controls"><ChartExportControls key={`export:${user?.id}:${org?.id}:${id}`} context={context} snapshot={snapshot}/><ChartShareControls key={`${user?.id}:${org?.id}:${id}`} context={context} snapshot={snapshot}/><Link className="intel-text-link" to={state.layout.comparison?`/intel/compare?assets=${encodeURIComponent(JSON.stringify(state.layout.comparison.assets.map(a=>({canonicalAssetKey:a.asset,displayName:a.label}))))}&period=${state.layout.comparison.period}`:`/intel/asset/${encodeURIComponent(state.layout.asset)}`}>{state.layout.comparison?'Open current comparison':'Open current asset workspace'}</Link><button className="intel-text-link" type="button" disabled={busy} onClick={remove}>Delete snapshot</button></div>
  </>}
 </div>
}
