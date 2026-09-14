import React,{useEffect,useId,useRef,useState} from 'react'
import {requestChartWorkspace} from '../lib/chart-workspace-api'
import {chartShareUrl} from '../lib/chart-share-url'
const audienceNames={owner:'Only me',org:'Current organization',unlisted:'Anyone with the link',public:'Public'}
const shareUrl=share=>chartShareUrl(share,window.location.origin,import.meta.env.VITE_INTEL_CHART_LINK_PREVIEW==='true')
function ChartShareControlsBody({context,snapshot}){
 const [open,setOpen]=useState(false),[audience,setAudience]=useState('owner'),[days,setDays]=useState(7),[selected,setSelected]=useState([]),[shares,setShares]=useState([]),[page,setPage]=useState(0),[hasMore,setHasMore]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(null),[result,setResult]=useState(null),[copied,setCopied]=useState(false)
 const modal=useRef(null),trigger=useRef(null),operation=useRef(null),alive=useRef(true),generation=useRef(0),listing=useRef(0),heading=useId()
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
 const refresh=async(next=0)=>{const current=generation.current,request=++listing.current;try{const r=await requestChartWorkspace(context,{operation:'share_list',snapshotId:snapshot.id,page:next});if(alive.current&&current===generation.current&&request===listing.current){setShares(r.shares||[]);setPage(next);setHasMore(!!r.hasMore)}}catch(e){if(alive.current&&current===generation.current&&request===listing.current)setError(e.message)}}
 useEffect(()=>{if(!open)return;modal.current?.showModal();refresh()},[open]) // eslint-disable-line
 const close=()=>{generation.current++;setBusy(false);setOpen(false);trigger.current?.focus()}
 const create=async()=>{
  const current=++generation.current
  const signature=JSON.stringify({audience,days,selected});if(operation.current?.signature!==signature)operation.current={signature,id:crypto.randomUUID(),expiresAt:Date.now()+days*86400000}
  setBusy(true);setError(null)
  try{const r=await requestChartWorkspace(context,{operation:'share_create',snapshotId:snapshot.id,operationId:operation.current.id,audience,expiresAt:operation.current.expiresAt,includeDrawingIds:selected});if(alive.current&&current===generation.current){setResult(r.share);operation.current=null;await refresh()}}
  catch(e){if(alive.current&&current===generation.current)setError(e.message)}finally{if(alive.current&&current===generation.current)setBusy(false)}
 }
 const revoke=async id=>{const current=++generation.current;setBusy(true);setError(null);try{await requestChartWorkspace(context,{operation:'share_revoke',id});if(alive.current&&current===generation.current){setResult(r=>r?.id===id?null:r);await refresh(page)}}catch(e){if(alive.current&&current===generation.current)setError(e.message)}finally{if(alive.current&&current===generation.current)setBusy(false)}}
 const copy=async()=>{const current=generation.current;try{await navigator.clipboard.writeText(shareUrl(result));if(alive.current&&current===generation.current)setCopied(true)}catch{if(alive.current&&current===generation.current)setError('Select and copy the link below. Clipboard access is unavailable.')}}
 return <><button className="intel-text-link" ref={trigger} type="button" onClick={()=>{setOpen(true);setResult(null);setCopied(false);setAudience('owner');setSelected([]);setError(null)}}>Share snapshot</button>
 {open&&<dialog ref={modal} className="intel-chart-study-dialog" aria-labelledby={heading} onCancel={e=>{e.preventDefault();close()}}>
  <div className="intel-investigation-analysis-heading"><h2 id={heading}>Choose who can read this chart</h2><button type="button" onClick={close}>Close</button></div>
  <p>{snapshot.title}</p><p className="intel-analysis-caption">The link opens this saved version. Only the notes selected below are included.</p>
  <div className="intel-investigation-controls"><label>Audience<select value={audience} disabled={busy||!!result} onChange={e=>setAudience(e.target.value)}>{Object.entries(audienceNames).map(([value,name])=><option key={value} value={value}>{name}</option>)}</select></label><label>Link expires<select value={days} disabled={busy||!!result} onChange={e=>setDays(Number(e.target.value))}><option value={1}>In 1 day</option><option value={7}>In 7 days</option><option value={30}>In 30 days</option></select></label></div>
  {audience==='org'&&<p className="intel-analysis-caption">Readers must be current members of this organization with Investor Intel access.</p>}
  {['unlisted','public'].includes(audience)&&<p className="intel-analysis-caption">Anyone who receives this link can read the selected content. A reader can keep a copy. Revoking a link blocks later reads, but cannot erase copies.</p>}
  {['unlisted','public'].includes(audience)&&import.meta.env.VITE_INTEL_CHART_LINK_PREVIEW==='true'&&<p className="intel-analysis-caption">Social previews show Investor Intel branding only. Your chart title, prices and selected notes appear after opening the chart.</p>}
  <fieldset className="intel-snapshot-annotations"><legend>Notes and drawings to include</legend>{snapshot.state.layout.drawings.map(d=><label key={d.id}><input type="checkbox" checked={selected.includes(d.id)} disabled={busy||!!result} onChange={e=>setSelected(ids=>e.target.checked?[...ids,d.id]:ids.filter(id=>id!==d.id))}/><span>{d.text||d.tool.replaceAll('_',' ')}</span></label>)}{snapshot.state.layout.drawings.length===0&&<p>No annotations in this snapshot.</p>}</fieldset>
  <p className="intel-analysis-caption">Portfolio holdings and trade history are excluded. Source permissions are checked before creating a link and when it is opened.</p>
  {error&&<p role="alert">{error}</p>}{result?<div role="status"><label className="intel-research-field">Your chart link<input readOnly value={shareUrl(result)} onFocus={e=>e.target.select()}/></label><button type="button" onClick={copy}>{copied?'Link copied':'Copy link'}</button><p>Expires {new Date(result.expires_at).toLocaleString()} · {audienceNames[result.audience]}</p></div>:<button type="button" className="btn btn--primary" disabled={busy} onClick={create}>{busy?'Creating link…':'Create chart link'}</button>}
  {shares.length>0&&<section className="intel-investigation-analysis"><h3>Existing links</h3><ul className="intel-study-list">{shares.map(s=><li key={s.id}><span>{audienceNames[s.audience]} · {s.revoked_at?'Revoked':Date.parse(s.expires_at)<=Date.now()?'Expired':`Expires ${new Date(s.expires_at).toLocaleDateString()}`}</span>{!s.revoked_at&&Date.parse(s.expires_at)>Date.now()&&<button type="button" disabled={busy} onClick={()=>revoke(s.id)}>Revoke link</button>}</li>)}</ul><div className="intel-investigation-pagination"><button type="button" disabled={busy||page===0} onClick={()=>refresh(page-1)}>Previous</button><span>Page {page+1}</span><button type="button" disabled={busy||!hasMore} onClick={()=>refresh(page+1)}>Next</button></div></section>}
 </dialog>}</>
}

export default function ChartShareControls(props){return <ChartShareControlsBody key={`${props.context.userId}:${props.context.orgId}:${props.snapshot.id}`} {...props}/>}
