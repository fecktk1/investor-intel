import React,{useEffect,useRef,useState} from 'react'
import {Link} from 'react-router'
import {requestChartWorkspace} from '../lib/chart-workspace-api'
const date=value=>value?new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'long'}):'—'
const labels={queued:'Queued',sending:'Attempt in progress',provider_accepted:'Provider accepted',failed:'Failed',expired:'Expired',cancelled:'Cancelled',unknown:'Outcome unknown',retry:'Rate limited · retry scheduled'}
export default function AlertDelivery(props){return <Delivery key={`${props.context.userId}:${props.context.orgId}:${props.ruleId}`} {...props}/>}
function Delivery({ruleId,context}){
 const [open,setOpen]=useState(false),[data,setData]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(null),[consent,setConsent]=useState(false),alive=useRef(true)
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
 const load=async(page=0)=>{setBusy(true);setError(null);try{const result=await requestChartWorkspace(context,{operation:'alert_delivery_status',id:ruleId,page});if(alive.current){setData(result);setConsent(result.enabled)}}catch(e){if(alive.current)setError(e.message)}finally{if(alive.current)setBusy(false)}}
 const save=async()=>{setBusy(true);setError(null);try{await requestChartWorkspace(context,{operation:'alert_delivery_preference',id:ruleId,enabled:consent});if(alive.current)await load()}catch(e){if(alive.current)setError(e.message)}finally{if(alive.current)setBusy(false)}}
 return <section aria-label="Delivery preferences and attempts"><button className="intel-text-link" aria-expanded={open} onClick={()=>{setOpen(!open);if(!open)load()}}>Delivery & receipts</button>{open&&<>
  {busy&&<p role="status">Loading delivery state…</p>}{error&&<><p role="alert">{error}</p><button className="btn" onClick={()=>load()}>Retry delivery read</button></>}
  {data&&<><p className="intel-analysis-caption">In-app alerts stay in this workspace. Telegram acceptance does not confirm delivery or reading; marking an alert read is a separate action.</p>
   {!data.workerEnabled&&<p role="status">External delivery is not enabled on the service. No message will be sent until release is authorized.</p>}
   {data.linked?<><label className="intel-workstation-check"><input type="checkbox" checked={consent} disabled={busy} onChange={e=>setConsent(e.target.checked)}/>Send future firings of this rule to my linked private Intel Telegram chat</label><p className="intel-analysis-caption">Includes the saved alert title, firing time and a private workspace link. Market data and trade notes stay in Investor Intel. Three attempts maximum; expires after 24 hours. You can opt out here or revoke the connection in Settings.</p><button className="btn" disabled={busy||consent===data.enabled} onClick={save}>Save delivery preference</button></>:<p>Private Telegram alerts are unavailable. <Link to="/intel/settings" className="intel-text-link">Review your Intel Telegram connection</Link></p>}
   {data.enabled&&<p>Consent recorded {date(data.consentAt)}</p>}
   {data.rows.length===0?<p>No delivery records on this page. In-app firing history remains above.</p>:<ol className="intel-study-list">{data.rows.map(row=><li key={row.id}><strong>{labels[row.state]||row.state}</strong><time>{date(row.created_at)}</time><p>Private Telegram · {row.attempt_count} attempts · expires {date(row.expires_at)}</p>{row.reason&&<p>{row.reason.replaceAll('_',' ')}</p>}<details><summary>Attempts and source event</summary><p className="break-all">Event {row.event_id}</p><ol>{[...(row.intel_alert_delivery_attempts||[])].sort((a,b)=>a.attempt-b.attempt).map(attempt=><li key={attempt.attempt}>Attempt {attempt.attempt} · {labels[attempt.outcome]||attempt.outcome} · {date(attempt.started_at)}{attempt.http_status!=null?` · HTTP ${attempt.http_status}`:''}{attempt.provider_message_id?` · Provider reference ${attempt.provider_message_id}`:''}</li>)}</ol></details></li>)}</ol>}
   {(data.hasOlder||data.page>0)&&<nav aria-label="Delivery pages"><button disabled={busy||data.page===0} onClick={()=>load(data.page-1)}>Newer attempts</button><span> Page {data.page+1} </span><button disabled={busy||!data.hasOlder} onClick={()=>load(data.page+1)}>Older attempts</button></nav>}
  </>}
 </>}</section>
}
