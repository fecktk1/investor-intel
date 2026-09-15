import React,{useEffect,useRef,useState} from 'react'
import {Link} from 'react-router'
import {requestChartWorkspace} from '../lib/chart-workspace-api'
import ChartAlertEditor from './ChartAlertEditor'
import ChartAlertReadControl from './ChartAlertReadControl'
import AlertRehearsal from './AlertRehearsal'
import AlertDelivery from './AlertDelivery'
const date=t=>t?new Date(t).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'long'}):'Not checked yet'
const status={baseline:'Baseline',watching:'Watching',holding:'Sustained condition in progress',unchanged:'No new observation',crossed:'Condition detected',cooldown:'Condition suppressed by cooldown',fresh_price_unavailable:'Waiting for a fresh price',access_unavailable:'Access unavailable',draft_crossing:'Draft would have fired'}
export default function ChartAlertRow({rule,context,onChanged,onDelete}) {
 const [preview,setPreview]=useState(null),[audit,setAudit]=useState(null),[page,setPage]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState(null),alive=useRef(true)
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
 const run=async fn=>{setBusy(true);setError(null);try{await fn()}catch(e){if(alive.current)setError(e.message)}finally{if(alive.current)setBusy(false)}}
 const readAudit=next=>run(async()=>{const result=await requestChartWorkspace(context,{operation:'alert_audit',id:rule.id,page:next});if(alive.current){setAudit(result);setPage(next)}})
 return <article className="intel-chart-alert-row">
  <div className="intel-holdings-toolbar"><h3>{rule.config.title}</h3><span>{rule.is_active?'Active':'Draft / paused'} · revision {rule.chart_revision}</span></div>
  <p>{rule.config.condition==='sustained'?`Remains ${rule.config.sustain_minutes} minutes`:'Crosses'} {rule.config.direction} <strong>${Number(rule.config.threshold_usd).toLocaleString(undefined,{maximumFractionDigits:8})}</strong> · USD · {rule.cooldown_minutes} minute cooldown · {rule.config.repeat==='once'?'Only once':'Rearm after reset'}{rule.config.hysteresis_pct>0?` · ${rule.config.hysteresis_pct}% reset margin`:''}</p>
  <p className="intel-analysis-caption">{rule.is_active?status[rule.chart_state?.status]||'Waiting for the first fresh observation':'Activate from the editor when ready.'} · {date(rule.chart_state?.checkedAt)}</p>
  <div className="intel-investigation-controls"><ChartAlertEditor context={context} rule={rule} label="Edit condition" onSaved={onChanged}/><button className="btn btn--ghost" disabled={busy} onClick={()=>run(async()=>{const r=await requestChartWorkspace(context,{operation:'alert_preview',id:rule.id});if(alive.current)setPreview(r.results[0])})}>Check current evidence</button><button className="btn btn--ghost" disabled={busy} onClick={()=>audit?setAudit(null):readAudit(0)} aria-expanded={!!audit}>Audit trail</button><Link className="intel-text-link" to={`/intel/asset/${encodeURIComponent(rule.config.asset)}`}>Open asset chart</Link><button className="intel-text-link" disabled={busy} onClick={onDelete}>Delete condition</button></div>
  {error&&<p role="alert">{error}</p>}{preview&&<p role="status">Preview only · {status[preview.state]||preview.state}{preview.value!=null?` · $${Number(preview.value).toLocaleString(undefined,{maximumFractionDigits:8})} · ${preview.source} · ${date(preview.observedAt)}`:''}. No alert was recorded by this check.</p>}
  <details className="intel-alert-history-controls"><summary>History preview and delivery</summary><AlertRehearsal rule={rule} context={context}/><AlertDelivery ruleId={rule.id} context={context}/></details>
  {audit&&<section aria-label="Chart alert audit trail"><ol className="intel-study-list">{audit.rows.map(row=><li key={row.id}><time>{date(row.recorded_at)}</time><strong>{row.action.replaceAll('_',' ')} · revision {row.revision}</strong>{row.detail.config&&<><p>Crosses {row.detail.config.direction} ${row.detail.config.threshold_usd}</p><blockquote className="whitespace-pre-wrap break-words">{row.detail.config.note||'No note recorded.'}</blockquote></>}{row.detail.checkpoint&&<p>{row.detail.checkpoint.gapNotice} Source: {row.detail.checkpoint.source} · {date(row.detail.checkpoint.observedAt)}</p>}</li>)}</ol><div className="intel-chart-navigation"><button className="btn" disabled={busy||page===0} onClick={()=>readAudit(page-1)}>Newer records</button><span>Page {page+1}</span><button className="btn" disabled={busy||!audit.hasMore} onClick={()=>readAudit(page+1)}>Older records</button></div></section>}
 </article>
}
export function ChartAlertEvent({event,context,onRead}) {
 const config=event.payload.config||{},checkpoint=event.payload.checkpoint||{}
 return <section className="intel-chart-alert-row">
  <div className="intel-holdings-toolbar"><h3>{event.payload.title||'Chart condition crossed'}</h3><ChartAlertReadControl event={event} context={context} onRead={onRead}/></div>
  <p>{config.condition==='sustained'?`Remained ${config.sustain_minutes} minutes`:'Crossed'} {config.direction} ${Number(config.threshold_usd).toLocaleString(undefined,{maximumFractionDigits:8})} · observed {date(checkpoint.observedAt)}</p>
  <blockquote className="whitespace-pre-wrap break-words">{config.note||'No note recorded.'}</blockquote>
  <p className="intel-analysis-caption">{checkpoint.gapNotice}</p>
  <details><summary>Trigger checkpoint</summary><dl className="intel-event-facts">
   <dt>Source</dt><dd>{checkpoint.source}</dd><dt>Recorded</dt><dd>{date(event.fired_at)}</dd>
   <dt>Observation reference</dt><dd className="break-all">{checkpoint.observationId}</dd>
   <dt>Previous reference</dt><dd className="break-all">{checkpoint.previousObservationId}</dd>
   <dt>Original price path</dt><dd>Source references retained; raw historical prices were not copied into this alert.</dd>
  </dl></details>
  <Link className="intel-text-link" to={'/intel/asset/'+encodeURIComponent(config.asset||'')}>Review asset chart</Link>
 </section>
}
