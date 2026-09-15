import React,{useEffect,useRef,useState} from 'react'
import {useSearchParams,useLocation} from 'react-router'
import {getActivityPage,exportPortfolioActivity,downloadCsv,ACTIVITY_CSV_COLUMNS} from '../lib/portfolio-api'

const TYPES=['buy','sell','swap','transfer_in','transfer_out','fee','airdrop','stake','unstake','reward','bridge','lp_add','lp_remove','approval','wrap','unwrap','mint','burn','unknown','staking_reward','deposit','withdrawal','nft']
function readCursor(value){try{const v=JSON.parse(value);return v&&typeof v.key==='string'&&v.key.length<=100&&Object.hasOwn(v,'time')?v:null}catch{return null}}

export default function PortfolioActivitySection({supabase,orgId,userId,portfolioId,reloadKey,Row,onReclassify,onDelete,onAdd,processing,t,children}) {
 const location=useLocation(),section=useRef(null),navigationPending=useRef(false)
 const [params,setParams]=useSearchParams(),search=(params.get('activitySearch')||'').slice(0,160),type=TYPES.includes(params.get('activityType'))?params.get('activityType'):null,status=['success','pending','failed','unclassified'].includes(params.get('activityStatus'))?params.get('activityStatus'):null
 // URL state survives the workspace unmount while a new portfolio loads. Bind
 // cursors to their book before making a read or building a detail return link.
 const scopedParams=new URLSearchParams(params)
 const cursorScopeMatches=params.get('activityPortfolio')===portfolioId
 if(!cursorScopeMatches){scopedParams.delete('activityBefore');scopedParams.delete('activityAfter');scopedParams.delete('activityPortfolio')}
 const direction=scopedParams.has('activityAfter')?'newer':'older',cursor=readCursor(scopedParams.get(direction==='newer'?'activityAfter':'activityBefore'))
 const scope=JSON.stringify([orgId,userId,portfolioId]),requestScope=JSON.stringify([scope,search,type,status,cursor,direction,reloadKey]),latest=useRef({scope,requestScope});latest.current={scope,requestScope}
 useEffect(()=>{if(!cursorScopeMatches&&(params.has('activityBefore')||params.has('activityAfter')||params.has('activityPortfolio'))){setParams(old=>{const next=new URLSearchParams(old);next.delete('activityBefore');next.delete('activityAfter');next.delete('activityPortfolio');return next},{replace:true})}},[cursorScopeMatches,params,setParams])
 const [state,setState]=useState(null),[draft,setDraft]=useState(search),[retry,setRetry]=useState(0),[exportState,setExportState]=useState(null),exportController=useRef(null)
 useEffect(()=>setDraft(search),[search])
 useEffect(()=>()=>exportController.current?.abort(),[scope])
 useEffect(()=>{
  const controller=new AbortController();let stopped=false;setState({requestScope,loading:true})
  getActivityPage(supabase,orgId,portfolioId,{search,type,status,cursor,direction,signal:controller.signal}).then(data=>{if(!stopped&&latest.current.requestScope===requestScope)setState({requestScope,data})},error=>{if(!stopped&&latest.current.requestScope===requestScope)setState({requestScope,error:error.message})})
  return()=>{stopped=true;controller.abort()}
 },[supabase,requestScope,retry]) // eslint-disable-line react-hooks/exhaustive-deps
 const current=state?.requestScope===requestScope?state:null,data=current?.data,busy=!data&&!current?.error
 useEffect(()=>{if(data&&navigationPending.current){navigationPending.current=false;section.current?.scrollIntoView?.({block:'start'});section.current?.querySelector('h2')?.focus({preventScroll:true})}},[data])
 const returnSearch=scopedParams.toString()
 const returnState={portfolioReturn:{url:location.pathname+(returnSearch?'?'+returnSearch:''),orgId,userId,portfolioId}}
 const change=(key,value)=>{navigationPending.current=true;setParams(old=>{const next=new URLSearchParams(old);next.delete('activityBefore');next.delete('activityAfter');next.delete('activityPortfolio');value?next.set(key,typeof value==='object'?JSON.stringify(value):value):next.delete(key);if(value&&(key==='activityBefore'||key==='activityAfter'))next.set('activityPortfolio',portfolioId);return next},{replace:true})}
 const exportAll=async()=>{
  const controller=new AbortController();exportController.current?.abort();exportController.current=controller;setExportState({scope,busy:true,done:0})
  try{const rows=await exportPortfolioActivity(supabase,orgId,portfolioId,{signal:controller.signal,onProgress:(done,total)=>{if(latest.current.scope===scope&&!controller.signal.aborted)setExportState({scope,busy:true,done,total})}});if(latest.current.scope===scope&&!controller.signal.aborted){downloadCsv(`activity-${portfolioId}.csv`,rows,ACTIVITY_CSV_COLUMNS);setExportState({scope,message:`Exported ${rows.length} activity events with their recorded legs and notes.`})}}
  catch(error){if(latest.current.scope===scope)setExportState({scope,message:controller.signal.aborted?'Export canceled.':error.message})}
 }
 const exportStatus=exportState?.scope===scope?exportState:null
 return <section ref={section} className="intel-activity-section space-y-3" aria-label="Portfolio activity">
  <div className="intel-holdings-toolbar"><h2 tabIndex={-1}>{t('portfolio.transactions',{defaultValue:'Transactions'})}</h2><div><button className="btn btn--ghost btn--sm" onClick={exportAll} disabled={exportStatus?.busy}>Export all activity</button>{exportStatus?.busy&&<button className="btn btn--ghost btn--sm" onClick={()=>exportController.current?.abort()}>Cancel export</button>}<button className="btn btn--primary btn--sm" onClick={onAdd}>{t('portfolio.add_txn',{defaultValue:'Add transaction'})}</button></div></div>
  {children}
  <form className="intel-holdings-filter" onSubmit={e=>{e.preventDefault();change('activitySearch',draft.trim())}}><div className="intel-activity-search"><label>Search activity<input className="input" type="search" maxLength={160} value={draft} onChange={e=>setDraft(e.target.value)}/></label><button type="submit" className="btn">Search</button></div><label>Action<select className="select" value={type||''} onChange={e=>change('activityType',e.target.value)}><option value="">All actions</option>{TYPES.map(value=><option key={value} value={value}>{value.replaceAll('_',' ')}</option>)}</select></label><label>Recorded status<select className="select" value={status||''} onChange={e=>change('activityStatus',e.target.value)}><option value="">All statuses</option><option value="success">Successful / recorded</option><option value="pending">Pending</option><option value="failed">Failed</option><option value="unclassified">Unclassified</option></select></label></form>
  {exportStatus&&<p role="status">{exportStatus.busy?`Preparing export · ${exportStatus.done} of ${exportStatus.total??'…'} events`:exportStatus.message}</p>}
  {busy?<p role="status">Loading activity…</p>:current?.error?<p role="alert">{current.error} <button className="btn" onClick={()=>setRetry(n=>n+1)}>Retry</button></p>:data?.rows?.length?<div>{data.rows.map(item=><Row key={scope+':'+item.eventKey} {...{item,onReclassify,onDelete,t,supabase,orgId,userId,portfolioId,returnState}}/>)}</div>:<p>{processing?'Processing transaction history…':search||type||status?'No activity matches these filters.':cursor?'No activity remains in this window. Return to latest activity.':'No transactions recorded. Synced history can arrive after balances; you can also add a manual transaction.'}</p>}
  <nav className="intel-page-controls" aria-label="Activity pages"><span>{data?`${data.rows.length} of ${data.total.toLocaleString()} events`:''}</span>{cursor&&<button className="btn btn--ghost btn--sm" onClick={()=>change('activityBefore',null)}>Latest</button>}<button className="btn btn--ghost btn--sm" disabled={busy||!data?.hasNewer} onClick={()=>change('activityAfter',data.newerCursor)}>Newer</button><button className="btn btn--ghost btn--sm" disabled={busy||!data?.hasOlder} onClick={()=>change('activityBefore',data.olderCursor)}>Older</button></nav>
 </section>
}
