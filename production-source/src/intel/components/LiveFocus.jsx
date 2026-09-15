import React,{useEffect,useRef,useState} from 'react'
import {value,time} from './InvestigationLenses'
export default function LiveFocus({request,onObservation}) {
  const [enabled,setEnabled]=useState(false),[result,setResult]=useState(null),[error,setError]=useState(null),[clock,setClock]=useState(Date.now)
  const requestRef=useRef(request),observationRef=useRef(onObservation);requestRef.current=request;observationRef.current=onObservation
  useEffect(()=>{const timer=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(timer)},[])
  useEffect(()=>{
    if(!enabled)return
    let alive=true,pending=false,generation=0,viewId=crypto.randomUUID()
    setResult(null);setError(null)
    const requestCurrent=requestRef.current
    const refresh=async()=>{
      if(pending||document.hidden)return;pending=true;const started=generation,currentView=viewId
      try{const data=await requestCurrent({operation:'live',enabled:true,viewId:currentView});if(alive&&started===generation&&!document.hidden){setResult(data);setError(null);if(data.observation)observationRef.current?.(data.observation)}}catch(e){if(alive&&started===generation)setError(e.message)}finally{pending=false}
    }
    const release=()=>void requestCurrent({operation:'live',enabled:false,viewId}).catch(()=>{})
    const visibility=()=>{if(document.hidden){generation++;release();setResult(null)}else{viewId=crypto.randomUUID();void refresh()}}
    void refresh();const timer=setInterval(refresh,5000);document.addEventListener('visibilitychange',visibility)
    return()=>{alive=false;clearInterval(timer);document.removeEventListener('visibilitychange',visibility);release()}
  },[enabled])
  const fresh=enabled&&result?.observation&&Date.parse(result.observation.expiresAt)>clock
  return <section aria-label="Live focus"><div className="intel-investigation-controls"><button className="btn" aria-pressed={enabled} onClick={()=>setEnabled(v=>!v)}>{enabled?'Pause live focus':'Start live focus'}</button><span role="status">{!enabled?'Paused':fresh?'Live observation':'Polling fallback'}</span></div>
    <p className="intel-analysis-caption">One server subscription serves viewers of the same asset. Focus expires when you leave; message and monthly credit limits are enforced before connecting.</p>
    {fresh&&<p className="intel-number">${value(result.observation.value)} · {time(result.observation.observedAt)} · {Math.max(0,Math.floor((clock-Date.parse(result.observation.observedAt))/1000))}s old</p>}
    {enabled&&!fresh&&<p>{result?.reason||'Waiting for fresh stream evidence. The existing chart remains available.'}</p>}{enabled&&error&&<p role="alert">{error}</p>}
  </section>
}
