import React,{useEffect,useRef,useState} from 'react'
import {requestChartWorkspace} from '../lib/chart-workspace-api'
const time=value=>value?new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'long'}):'Unavailable'
export default function AlertRehearsal(props){return <Rehearsal key={`${props.context?.userId}:${props.context?.orgId}:${props.rule.id}:${props.rule.chart_revision}`} {...props}/>}
function Rehearsal({rule,context,operation='alert_rehearsal'}){
 const [result,setResult]=useState(null),[error,setError]=useState(null),[busy,setBusy]=useState(false),alive=useRef(true)
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
 const load=async()=>{setBusy(true);setError(null);try{const value=await requestChartWorkspace(context,{operation,id:rule.id});if(value?.previewOnly!==true||!Array.isArray(value.examples))throw Error('Preview could not be read. Try again.');if(alive.current)setResult(value)}catch(e){if(alive.current)setError(e.message)}finally{if(alive.current)setBusy(false)}}
 return <section className="intel-alert-rehearsal" aria-label={`History preview for ${rule.config.title||rule.trigger_type||'rule'}`}>
  <div className="intel-investigation-controls"><button className="btn btn--ghost" disabled={busy} onClick={load}>{busy?'Checking retained history…':'Preview retained history'}</button>{result&&<button className="intel-text-link" onClick={()=>setResult(null)}>Hide preview</button>}</div>
  {error&&<p role="alert">{error}</p>}
  {result&&<div role="region" aria-label="Retained-history preview">
   <h4>Preview only · revision {result.ruleRevision}</h4>
   <p className="intel-analysis-caption">{time(result.requestedFrom)} — {time(result.requestedTo)}</p>
   {result.state!=='unavailable'&&<dl className="intel-event-facts"><dt>Evaluated schedule</dt><dd>Every {result.cadenceMinutes} minutes · {result.checks} checks</dd><dt>Retained observations used</dt><dd>{result.observations} · {result.missingChecks} checks missing usable evidence</dd><dt>Coverage</dt><dd>{result.firstObservationAt?`${time(result.firstObservationAt)} — ${time(result.lastObservationAt)}`:'No usable retained observations in this window.'}</dd><dt>Would fire</dt><dd>{result.crossings} · {result.cooldownSuppressed} suppressed by cooldown · {result.baselines} baselines</dd></dl>}
   <p className="intel-analysis-caption">{result.notice} No alert was activated or sent.</p>
   {result.examples.length>0&&<details><summary>Example trigger payloads ({result.examples.length} of {result.crossings})</summary><ol className="intel-study-list">{result.examples.map((item,i)=><li key={`${item.observationId}:${i}`}><strong>{item.metric?`Would match ${item.config.direction||'either'} rolling 24-hour change of ${item.config.threshold_pct}%`:`Would ${item.config.condition==='sustained'?`remain ${item.config.sustain_minutes} minutes`:'cross'} ${item.config.direction} ${Number(item.config.threshold_usd).toLocaleString(undefined,{maximumFractionDigits:8})}`} · revision {item.ruleRevision}</strong><dl className="intel-event-facts"><dt>Source observed</dt><dd>{time(item.observedAt)}</dd><dt>Known to Investor Intel</dt><dd>{time(item.knownAt)}</dd><dt>Scheduled check</dt><dd>{time(item.evaluationAt)}</dd><dt>Source / venue</dt><dd>{item.source} · shared asset quote; no specific execution venue</dd><dt>Observation reference</dt><dd className="break-all">{item.observationId}</dd></dl><blockquote className="whitespace-pre-wrap break-words">{item.config.note||'No note recorded.'}</blockquote></li>)}</ol></details>}
  </div>}
 </section>
}
