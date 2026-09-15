import {useCallback,useEffect,useRef,useState} from 'react'
import {useTranslation} from 'react-i18next'

import {validateChartLayout} from '../../../supabase/functions/_shared/intel/chart-workspace-contract'
import {saveChartWorkingState} from '../lib/chart-workspace-api'
import {usableChartContext} from '../lib/chart-working-state'

// Writing the chart back is NOT first content. Reading it is: the asset page
// waits on the read so the workstation is built already restored. Nothing has to
// be saved until the member changes something, so this arrives after the chart
// the way the drawing toolbar, the indicator dialog and the snapshot tools do,
// and the draft store holds whatever they did in the meantime.

/** How long the chart stays quiet before its working state is written back. */
export const WORKING_STATE_DEBOUNCE_MS=2000

const usable=usableChartContext
const fingerprint=state=>{try{return state?JSON.stringify(validateChartLayout(state)):null}catch{return null}}

/**
 * Writes the working state back a couple of seconds after the last change, and
 * immediately when the tab is hidden or the page is going away. Nothing is written
 * for a draft that matches what is already stored, so a re-render costs nothing and
 * a chart nobody touched is never written. A refused save leaves the draft pending
 * and never blocks the chart: the next change retries it.
 */
export function useChartWorkingSave({store,context,revision:initialRevision=0,initial=null,delay=WORKING_STATE_DEBOUNCE_MS,save=saveChartWorkingState}) {
 const [status,setStatus]=useState(null)
 const revision=useRef(initialRevision)
 const stored=useRef(null);if(stored.current===null)stored.current=fingerprint(initial)
 const pending=useRef(null),timer=useRef(null),busy=useRef(false)
 const live=useRef(null);live.current={context,save,delay}
 const flush=useCallback(function run() {
  clearTimeout(timer.current)
  const {context:current,save:write,delay:wait}=live.current
  const next=pending.current
  if(!next||busy.current||!usable(current))return
  busy.current=true
  Promise.resolve(write(current,{asset:current.asset,revision:revision.current,state:next.state}))
   .then(result=>{
    revision.current=Number.isInteger(result?.revision)?result.revision:revision.current+1
    stored.current=next.print
    if(pending.current?.print===next.print)pending.current=null
    setStatus(pending.current?'saving':'saved')
   })
   // The chart keeps working. The draft stays pending and rides out on the next change.
   .catch(error=>{console.warn('[intel-chart] working state not saved',error);setStatus(null)})
   .finally(()=>{busy.current=false;if(pending.current)timer.current=setTimeout(run,wait)})
 },[])
 const record=useCallback(draft=>{
  const {context:current,delay:wait}=live.current
  if(!draft||!usable(current))return
  let state=null
  try{state=validateChartLayout(draft)}catch{return}
  if(state.asset!==current.asset)return
  const print=JSON.stringify(state)
  if(print===stored.current||print===pending.current?.print)return
  pending.current={state,print}
  setStatus('saving')
  clearTimeout(timer.current)
  timer.current=setTimeout(flush,wait)
 },[flush])
 useEffect(()=>{
  // Whatever the chart did before this arrived is still in the store.
  record(store.get())
  return store.subscribe(record)
 },[store,record])
 useEffect(()=>{
  const hidden=()=>{if(document.visibilityState==='hidden')flush()}
  document.addEventListener('visibilitychange',hidden)
  window.addEventListener('pagehide',flush)
  return()=>{document.removeEventListener('visibilitychange',hidden);window.removeEventListener('pagehide',flush);clearTimeout(timer.current)}
 },[flush])
 return status
}

/** A quiet line beside the chart tools. No card, no badge, no colour. */
export default function ChartWorkingState(props) {
 const {t}=useTranslation('intel',{useSuspense:false})
 const status=useChartWorkingSave(props)
 if(!status)return null
 return <span className="intel-event-meta" role="status">{status==='saving'?t('chart.working.saving',{defaultValue:'Saving'}):t('chart.working.saved',{defaultValue:'Saved'})}</span>
}
