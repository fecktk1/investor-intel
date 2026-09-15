import React,{useEffect,useRef,useState} from 'react'
import {requestChartWorkspace} from '../lib/chart-workspace-api'
import {InvestigationTable,time} from './InvestigationTable'
function RevisionFields({record}){
 const c=record.config||{},fields=[['Name',c.title],['Trigger',record.trigger_type],['Evaluation',c.condition==='legacy_level'?'Threshold match at a check':c.condition],['Direction',c.direction],['Change threshold (%)',c.threshold_pct],['Liquidity minimum (USD)',c.min_liquidity_usd],['Activity minimum (USD)',c.min_usd],['Unlock window (days)',c.window_days],['Momentum increase (points)',c.momentum_delta],['Repeat',c.repeat],['Reset margin (%)',c.hysteresis_pct],['Sustained minutes',c.sustain_minutes],['Cooldown minutes',record.cooldown_minutes],['State',record.is_active?'Active':'Paused'],['Asset reference',record.entity_id],['Narrative',c.slug]]
 return <dl className="intel-alert-revision-fields">{fields.filter(([,v])=>v!=null&&v!=='').map(([label,v])=><div key={label}><dt>{label}</dt><dd>{String(v).replaceAll('_',' ')}</dd></div>)}</dl>
}
export default function AlertRuleHistory({ruleId,context}){
 const [result,setResult]=useState(null),[error,setError]=useState(null),[busy,setBusy]=useState(false),alive=useRef(true)
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
 const read=async page=>{setBusy(true);setError(null);try{const next=await requestChartWorkspace(context,{operation:'alert_audit',id:ruleId,page});if(alive.current)setResult({...next,page})}catch(e){if(alive.current)setError(e.message)}finally{if(alive.current)setBusy(false)}}
 return <div><button className="intel-text-link" aria-expanded={!!result} disabled={busy} onClick={()=>result?setResult(null):read(0)}>Rule revision history</button>{error&&<p role="alert">{error}</p>}{result&&<section aria-label="Rule revision history"><p className="intel-analysis-caption">Captured actions only. Earlier edits are not reconstructed from the current rule.</p><InvestigationTable rows={result.rows} pageSize={20} columns={[
  ['Action',r=>`${r.action} · revision ${r.revision}`],['Server time',r=>time(r.recorded_at)],['Recorded change',r=><details><summary>Original fields and words</summary><div className="intel-alert-revision-comparison">{['before','after'].map(side=>r.detail?.[side]&&<div key={side}><h4>{side==='before'?'Before':'After'}</h4><blockquote className="whitespace-pre-wrap break-words">{r.detail[side].config?.note||'No note recorded.'}</blockquote><RevisionFields record={r.detail[side]}/></div>)}</div></details>],
 ]}/>{!result.rows.length&&<p>No captured rule revisions yet.</p>}<div className="intel-investigation-controls"><button className="btn" disabled={busy||!result.page} onClick={()=>read(result.page-1)}>Newer records</button><span>Page {result.page+1}</span><button className="btn" disabled={busy||!result.hasMore} onClick={()=>read(result.page+1)}>Older records</button></div></section>}</div>
}
