import React,{useEffect,useRef,useState} from 'react'
import {markChartAlertRead} from '../lib/intel-data'

export default function ChartAlertReadControl({event,context,onRead}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState(null)
  const scope=`${context?.userId}:${context?.orgId}:${event.id}`
  const current=useRef(scope),alive=useRef(true)
  current.current=scope
  useEffect(()=>{alive.current=true;setBusy(false);setError(null);return()=>{alive.current=false}},[scope])
  const read=async()=>{
    setBusy(true);setError(null)
    try {
      const result=await markChartAlertRead(context.supabase,context.orgId,event.id)
      if(alive.current&&current.current===scope)onRead?.(result)
    } catch(e) {if(alive.current&&current.current===scope)setError(e.message)}
    finally {if(alive.current&&current.current===scope)setBusy(false)}
  }
  if(!context?.userId||!context?.orgId)return null
  return <div className="intel-alert-read-control">
    {event.read_at?<span>Read · {new Date(event.read_at).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'})}</span>:<><span>Unread</span><button className="btn btn--quiet" disabled={busy} onClick={read}>{busy?'Saving…':'Mark as read'}</button></>}
    {error&&<p role="alert">{error}</p>}
  </div>
}
