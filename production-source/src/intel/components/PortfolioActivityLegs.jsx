import React,{useEffect,useRef,useState} from 'react'
import {getActivityLegs} from '../lib/portfolio-api'

export default function PortfolioActivityLegs({item,supabase,orgId,userId,portfolioId,render}) {
 const scope=JSON.stringify([orgId,userId,portfolioId,item.id]),latest=useRef(scope);latest.current=scope
 const [page,setPage]=useState(null),[state,setState]=useState(null),[retry,setRetry]=useState(0),revision=useRef(null)
 useEffect(()=>{revision.current=null;setPage(null)},[scope])
 useEffect(()=>{
  if(page===null)return
  const controller=new AbortController();let stopped=false;setState({scope,page,loading:true})
  getActivityLegs(supabase,orgId,portfolioId,item.id,{page,revision:revision.current,signal:controller.signal}).then(data=>{if(!stopped&&latest.current===scope){revision.current=data.revision;setState({scope,page,data})}},error=>{if(!stopped&&latest.current===scope)setState({scope,page,error:error.message})})
  return()=>{stopped=true;controller.abort()}
 },[supabase,scope,page,retry]) // eslint-disable-line react-hooks/exhaustive-deps
 const current=state?.scope===scope&&state?.page===page?state:null
 if(page===null)return <>{render(item.lineItems||[])}{item.lineItemCount>item.lineItems.length&&<button className="btn btn--ghost btn--sm" onClick={()=>setPage(0)}>View all {item.lineItemCount} transaction legs</button>}</>
 return <div>{current?.data?render(current.data.rows):current?.error?<p role="alert">{current.error} <button className="btn" onClick={()=>{revision.current=null;setPage(0);setRetry(n=>n+1)}}>Reload legs</button></p>:<p role="status">Loading transaction legs…</p>}<nav className="intel-page-controls" aria-label="Transaction leg pages"><span>Legs {page*50+1}–{page*50+(current?.data?.rows.length||0)} of {current?.data?.total??item.lineItemCount}</span><button className="btn btn--ghost btn--sm" disabled={!current?.data||page===0} onClick={()=>setPage(n=>n-1)}>Previous legs</button><button className="btn btn--ghost btn--sm" disabled={!current?.data?.hasMore} onClick={()=>setPage(n=>n+1)}>Next legs</button></nav></div>
}
