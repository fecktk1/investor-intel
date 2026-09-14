import React,{useEffect,useRef,useState} from 'react'
import {useLocation,useSearchParams} from 'react-router'
import {getPortfolioPage,exportPortfolioHoldings,downloadCsv,HOLDINGS_CSV_COLUMNS} from '../lib/portfolio-api'

export function PortfolioPageControls({page,total,hasMore,onPage,label,busy}) {
 return <nav className="intel-page-controls" aria-label={label}><span>{total==null?'':`${total.toLocaleString()} records · `}Page {page+1}</span><button className="btn btn--ghost btn--sm" disabled={busy||page===0} onClick={()=>onPage(page-1)}>Previous</button><button className="btn btn--ghost btn--sm" disabled={busy||!hasMore} onClick={()=>onPage(page+1)}>Next</button></nav>
}

function HoldingPage({supabase,orgId,userId,portfolioId,initial,view,hideDust,Table,t}) {
 const [params,setParams]=useSearchParams(),location=useLocation(),prefix=view==='closed'?'closed':'holdings'
 const page=Math.max(0,Math.min(1000000,Math.trunc(Number(params.get(prefix+'Page'))||0))),search=(params.get(prefix+'Search')||'').slice(0,160),sort=['value','asset','pnl'].includes(params.get(prefix+'Sort'))?params.get(prefix+'Sort'):'value'
 const limit=view==='closed'?10:25,scope=JSON.stringify([orgId,userId,portfolioId,view,page,search,sort,hideDust]),latest=useRef(scope);latest.current=scope
 const [state,setState]=useState(null),[retry,setRetry]=useState(0),[draft,setDraft]=useState(search)
 const useInitial=page===0&&!search&&sort==='value'&&initial&&(view==='closed'||initial.hideDust===hideDust)
 useEffect(()=>setDraft(search),[search])
 useEffect(()=>{
  const controller=new AbortController();let canceled=false
  if(useInitial){setState({scope,data:initial});return()=>{canceled=true;controller.abort()}}
  setState({scope,loading:true})
  getPortfolioPage(supabase,orgId,portfolioId,{view,page,limit,search,sort,hideDust,signal:controller.signal}).then(data=>{if(!canceled&&latest.current===scope)setState({scope,data})},error=>{if(!canceled&&latest.current===scope)setState({scope,error:error.message})})
  return()=>{canceled=true;controller.abort()}
 },[supabase,scope,initial,retry]) // eslint-disable-line react-hooks/exhaustive-deps
 const current=state?.scope===scope?state:null,data=useInitial?initial:current?.data,busy=!data&&!current?.error
 const change=(key,value)=>setParams(previous=>{const next=new URLSearchParams(previous);value?next.set(prefix+key,String(value)):next.delete(prefix+key);if(key!=='Page')next.delete(prefix+'Page');return next},{replace:true})
 const returnState={portfolioReturn:{url:location.pathname+location.search,orgId,userId,portfolioId}}
 return <div className="intel-holding-page">
  <form className="intel-holdings-filter" onSubmit={e=>{e.preventDefault();change('Search',draft.trim())}}><label>Search {view==='closed'?'realized positions':'holdings'}<input className="input" maxLength={160} type="search" value={draft} onChange={e=>setDraft(e.target.value)}/></label><button className="btn" type="submit">Search</button><label>Sort by<select className="select" value={sort} onChange={e=>change('Sort',e.target.value)}><option value="value">Value</option><option value="asset">Asset</option><option value="pnl">{view==='closed'?'Realized':'Unrealized'} P&amp;L</option></select></label></form>
  {busy?<p role="status">Loading {view==='closed'?'realized positions':'holdings'}…</p>:current?.error?<div role="alert">{current.error} <button className="btn" onClick={()=>setRetry(n=>n+1)}>Retry</button></div>:data?.rows?.length?<Table holdings={data.rows} ctxMap={{}} portfolioId={portfolioId} returnState={returnState} closed={view==='closed'} t={t}/>:<p>{search?'No positions match this search.':view==='closed'?'No closed positions recorded.':'No open holdings in this view. Your recorded history remains available.'}</p>}
  <PortfolioPageControls page={page} total={data?.total} hasMore={data?.hasMore} busy={busy} onPage={n=>change('Page',n)} label={view==='closed'?'Realized position pages':'Holding pages'}/>
 </div>
}

export default function PortfolioHoldingsSection({supabase,orgId,userId,portfolioId,open,closed,hideDust,dustCount,onToggleDust,Table,t}) {
 const [exportState,setExportState]=useState(null),controller=useRef(null),scope=JSON.stringify([orgId,userId,portfolioId]),latest=useRef(scope);latest.current=scope
 useEffect(()=>()=>controller.current?.abort(),[scope])
 const exportAll=async()=>{
  const operation=new AbortController();controller.current?.abort();controller.current=operation
  setExportState({scope,busy:true,done:0})
  try{const rows=await exportPortfolioHoldings(supabase,orgId,portfolioId,{signal:operation.signal,onProgress:(done,total)=>{if(latest.current===scope&&!operation.signal.aborted)setExportState({scope,busy:true,done,total})}});if(latest.current===scope&&!operation.signal.aborted){downloadCsv(`holdings-${portfolioId}.csv`,rows,HOLDINGS_CSV_COLUMNS);setExportState({scope,message:`Exported ${rows.length} holdings, including closed positions.`})}}
  catch(error){if(latest.current===scope)setExportState({scope,message:operation.signal.aborted?'Export canceled.':error.message})}
 }
 const status=exportState?.scope===scope?exportState:null
 return <section className="space-y-3" aria-label="Portfolio holdings">
  <div className="intel-holdings-toolbar"><h2>Holdings</h2><div>{(dustCount>0||hideDust)&&<button className="btn btn--ghost btn--sm" aria-pressed={hideDust} onClick={onToggleDust}>{hideDust?`Show dust (${dustCount})`:'Hide dust'}</button>}<button className="btn btn--ghost btn--sm" disabled={status?.busy} onClick={exportAll}>Export all holdings</button>{status?.busy&&<button className="btn btn--ghost btn--sm" onClick={()=>controller.current?.abort()}>Cancel export</button>}</div></div>
  {status&&<p role="status">{status.busy?`Preparing export · ${status.done} of ${status.total??'…'} holdings`:status.message}</p>}
  <HoldingPage key={scope+':open'} {...{supabase,orgId,userId,portfolioId,hideDust,Table,t}} initial={open} view="open"/>
  {(closed?.total>0)&&<details className="intel-realized-positions"><summary>Realized positions · {closed.total}</summary><HoldingPage key={scope+':closed'} {...{supabase,orgId,userId,portfolioId,Table,t}} initial={closed} view="closed" hideDust={false}/></details>}
 </section>
}
