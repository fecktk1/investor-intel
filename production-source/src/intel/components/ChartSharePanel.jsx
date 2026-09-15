import React,{useEffect,useId,useRef,useState} from 'react'
import {useTranslation} from 'react-i18next'
import {requestChartWorkspace} from '../lib/chart-workspace-api'
import ChartShareControls from './ChartShareControls'
import ChartShareCard from './ChartShareCard'

/** The share flow itself: the brand card, the save, and the audience, expiry
 * and revocation controls.
 *
 * This module is loaded on demand by ChartShareLaunch, which keeps only the
 * trigger button in the asset route's static graph. Everything here, including
 * the link-management dialog, arrives with the first press of Share.
 *
 * `autoStart` opens the flow as soon as the code lands, so the press that
 * loaded this module is the press that opened it. */
export default function ChartSharePanel({context,captureLayout,seriesCapture=null,chartSource=null,latestObservation=null,disabled=false,autoStart=false}) {
 const {t}=useTranslation('intel',{useSuspense:false})
 const [open,setOpen]=useState(false),[preview,setPreview]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(null),[snapshot,setSnapshot]=useState(null)
 const [title,setTitle]=useState(()=>t('chart.share.default_title',{defaultValue:'Shared chart research'}))
 const dialog=useRef(null),trigger=useRef(null),operation=useRef(null),alive=useRef(true),generation=useRef(0),heading=useId()
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++}},[])
 const started=useRef(false)
 useEffect(()=>{if(open)dialog.current?.showModal()},[open])
 useEffect(()=>{if(autoStart&&!started.current){started.current=true;start()}},[autoStart]) // eslint-disable-line react-hooks/exhaustive-deps
 const current=id=>alive.current&&generation.current===id
 const close=()=>{generation.current++;setBusy(false);setOpen(false);setPreview(null);trigger.current?.focus?.()}
 const start=()=>{
  setError(null);setSnapshot(null)
  try{setPreview(captureLayout());setOpen(true)}
  catch(e){setPreview(null);setError(e.message)}
 }
 // The capture proof is what lets a reader verify the prices later. Without it
 // the link would carry unverifiable numbers, so the reason is said up front.
 const verified=!!seriesCapture?.proof
 const save=async()=>{
  const id=++generation.current
  // The saved version keeps every drawing on the chart, because the link is
  // meant to open the chart the member made. Leaving this empty saved a version
  // with no drawings at all, so no note could ever be offered on the next step.
  // A replay capture has no drawings by construction, which the service checks.
  const body={operation:'snapshot_save',title,layout:preview,capture:seriesCapture,includeDrawingIds:(preview.drawings||[]).map(d=>d.id)}
  const signature=JSON.stringify(body);if(operation.current?.signature!==signature)operation.current={signature,id:crypto.randomUUID()}
  setBusy(true);setError(null)
  try{
   const saved=await requestChartWorkspace(context,{...body,operationId:operation.current.id})
   const read=await requestChartWorkspace(context,{operation:'snapshot_get',id:saved.id})
   if(!current(id))return
   operation.current=null;setSnapshot(read.snapshot);setOpen(false);setPreview(null)
  }catch(e){if(current(id))setError(e.message)}
  finally{if(current(id))setBusy(false)}
 }
 if(snapshot)return <ChartShareControls key={snapshot.id} context={context} snapshot={snapshot} autoOpen/>
 return <><button type="button" ref={trigger} disabled={disabled} onClick={start}>{t('chart.share.open',{defaultValue:'Share'})}</button>
 {error&&!open&&<span role="alert">{error}</span>}
 {open&&preview&&<dialog ref={dialog} className="intel-chart-study-dialog" aria-labelledby={heading} onCancel={e=>{e.preventDefault();close()}}>
  <div className="intel-investigation-analysis-heading"><h2 id={heading}>{t('chart.share.dialog_title',{defaultValue:'Share this chart'})}</h2><button type="button" onClick={close}>{t('common.close',{defaultValue:'Close'})}</button></div>
  <p className="intel-analysis-caption">{t('chart.share.intro',{defaultValue:'A link points at a saved version of this chart, so a reader sees exactly what you saw, drawings and indicators included, and cannot change it. Save that version first, then choose an audience, an expiry and the notes to include.'})}</p>
  <ChartShareCard layout={preview} source={chartSource} capturedAt={seriesCapture?.proof?.issuedAt??null} latestObservation={latestObservation}/>
  <label>{t('chart.share.title_label',{defaultValue:'Saved version title'})}<input maxLength={120} value={title} disabled={busy} onChange={e=>setTitle(e.target.value)}/></label>
  {!verified&&<p role="status">{t('chart.share.unverified_capture',{defaultValue:'This price response has no verified capture yet, so it cannot be saved or shared. Reload the chart period to refresh it.'})}</p>}
  {error&&<p role="alert">{error}</p>}
  <button type="button" className="btn btn--primary" disabled={busy||!title.trim()||!verified} onClick={save}>{busy?t('chart.share.saving',{defaultValue:'Saving this version…'}):t('chart.share.save_and_choose',{defaultValue:'Save this version and choose an audience'})}</button>
 </dialog>}</>
}
