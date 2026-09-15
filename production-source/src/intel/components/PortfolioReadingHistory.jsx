import React,{useEffect,useRef,useState} from 'react'
import {listPortfolioReadings} from '../lib/stored-portfolio-research'
const date=value=>new Date(value).toLocaleString(undefined,{timeZoneName:'short'})
export default function PortfolioReadingHistory({supabase,orgId,userId,portfolioId,selectedId,onSelect,onClose,t}){
 const dialog=useRef(null),abort=useRef(null),alive=useRef(true)
 const [page,setPage]=useState(null),[cursor,setCursor]=useState(null),[busy,setBusy]=useState(true),[error,setError]=useState(null)
 async function load(before){
  abort.current?.abort();const controller=new AbortController();abort.current=controller
  setBusy(true);setError(null);setCursor(before)
  try{const result=await listPortfolioReadings(supabase,{orgId,userId,portfolioId,before,signal:controller.signal});if(alive.current&&!controller.signal.aborted){setPage(result);setCursor(before)}}
  catch(e){if(alive.current&&!controller.signal.aborted)setError(t('portfolio.history_failed',{defaultValue:'Earlier readings could not be loaded.'}))}
  finally{if(alive.current&&!controller.signal.aborted)setBusy(false)}
 }
 useEffect(()=>{alive.current=true;dialog.current?.showModal();void load(null);return()=>{alive.current=false;abort.current?.abort()}},[supabase,orgId,userId,portfolioId])
 return <dialog ref={dialog} aria-labelledby="portfolio-reading-history-title" className="intel-thread-inspector" onCancel={event=>{event.preventDefault();onClose()}}>
  <header className="flex items-start justify-between gap-4"><h2 id="portfolio-reading-history-title">{t('portfolio.history_title',{defaultValue:'Portfolio readings'})}</h2><button className="intel-text-link" onClick={onClose}>{t('portfolio.history_close',{defaultValue:'Close'})}</button></header>
  <p className="text-sm my-4">{t('portfolio.history_hint',{defaultValue:'Each reading keeps the evidence and words recorded when it was prepared. Prices here are historical; open Holdings for current values.'})}</p>
  {busy&&<p role="status">{t('portfolio.history_loading',{defaultValue:'Loading reading history…'})}</p>}
  {error&&<p role="alert">{error} <button className="intel-text-link" onClick={()=>load(cursor)}>{t('portfolio.retry_read',{defaultValue:'Retry reading'})}</button></p>}
  {!busy&&!error&&page?.rows.length===0&&<p>{t('portfolio.history_empty',{defaultValue:'No retained readings yet. Preparing a portfolio reading starts this history.'})}</p>}
  {!error&&page&&<ol className="divide-y divide-[var(--border-default)]">{page.rows.map(row=><li key={row.id} className="py-3 flex justify-between items-center gap-3"><time dateTime={row.generated_at}>{date(row.generated_at)}</time><button className="intel-text-link" disabled={busy||row.id===selectedId} onClick={()=>{onSelect(row.id);onClose()}}>{t(row.id===selectedId?'portfolio.history_current':'portfolio.history_open',{defaultValue:row.id===selectedId?'Open reading':'Read this version'})}</button></li>)}</ol>}
  <footer className="flex justify-between gap-4 mt-4">{cursor&&<button className="intel-text-link" disabled={busy} onClick={()=>load(null)}>{t('portfolio.history_latest',{defaultValue:'Newest readings'})}</button>}{page?.hasMore&&<button className="intel-text-link" disabled={busy} onClick={()=>load(page.next)}>{t('portfolio.history_older',{defaultValue:'Older readings'})}</button>}</footer>
 </dialog>
}
