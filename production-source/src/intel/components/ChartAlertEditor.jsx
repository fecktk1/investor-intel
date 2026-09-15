import React,{useEffect,useId,useRef,useState} from 'react'
import {Link} from 'react-router'
import {requestChartWorkspace} from '../lib/chart-workspace-api'
const time=t=>new Date(t).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'long'})
export default function ChartAlertEditor(props){return <Editor key={`${props.context?.userId}:${props.context?.orgId}:${props.context?.asset}:${props.rule?.id}`} {...props}/>}
function Editor({context,getAnchors=()=>[],rule=null,onSaved,label='Create alert',initialDraft=null,draftOnly=false,autoOpen=false}) {
 const [open,setOpen]=useState(false),[sources,setSources]=useState([]),[sourceIndex,setSourceIndex]=useState('0'),[form,setForm]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(null),[saved,setSaved]=useState(null)
 const dialog=useRef(null),trigger=useRef(null),operation=useRef(null),generation=useRef(0),alive=useRef(true),heading=useId()
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++}},[])
 useEffect(()=>{if(open)dialog.current?.showModal()},[open])
 // Loaded on demand from the chart tools: the press that fetched this opens it.
 const started=useRef(false)
 useEffect(()=>{if(autoOpen&&!started.current){started.current=true;begin()}},[autoOpen]) // eslint-disable-line react-hooks/exhaustive-deps
 const close=()=>{generation.current++;dialog.current?.close?.();setOpen(false);setBusy(false);trigger.current?.focus()}
 const begin=()=>{
  const list=rule?.config.anchor?[{label:'Original chart reference',...rule.config.anchor}]:getAnchors().filter(a=>Number.isFinite(a.t)&&Number.isFinite(a.price)&&a.price>0).slice(0,201)
  setSources(list);setSourceIndex('0');setSaved(null);setError(null);setOpen(true)
  setForm({title:rule?.config.title||initialDraft?.title||'Chart price crossing',note:rule?.config.note||initialDraft?.note||list[0]?.note||'',threshold:rule?.config.threshold_usd??list[0]?.price??'',direction:rule?.config.direction||'above',active:rule?.is_active??false,cooldown:rule?.cooldown_minutes??720,condition:rule?.config.condition||'crossing',repeat:rule?.config.repeat||'rearm',hysteresis:rule?.config.hysteresis_pct??0,sustain:rule?.config.sustain_minutes||15})
 }
 const set=(key,value)=>setForm(f=>({...f,[key]:value}))
 const save=async e=>{
  e.preventDefault();const threshold=Number(form.threshold)
  if(!Number.isFinite(threshold)||threshold<=0||threshold>1e18){setError('Enter a positive USD level.');return}
  const selected=sources[Number(sourceIndex)],config={asset:rule?.config.asset||context.asset,title:form.title,note:form.note,direction:form.direction,threshold_usd:threshold,anchor:selected?{t:selected.t,price:selected.price}:null,condition:form.condition,repeat:form.repeat,hysteresis_pct:Number(form.hysteresis),sustain_minutes:form.condition==='sustained'?Number(form.sustain):0}
  const body={operation:'alert_save',id:rule?.id??null,revision:rule?.chart_revision??0,active:draftOnly?false:form.active,cooldownMinutes:Number(form.cooldown),config}
  const signature=JSON.stringify(body);if(operation.current?.signature!==signature)operation.current={signature,id:crypto.randomUUID()}
  const current=++generation.current;setBusy(true);setError(null)
  try{const result=await requestChartWorkspace(context,{...body,operationId:operation.current.id});if(alive.current&&current===generation.current){setSaved(result);operation.current=null;window.dispatchEvent(new CustomEvent("intel:chart-alert-changed",{detail:{orgId:context.orgId}}));onSaved?.(result)}}catch(e){if(alive.current&&current===generation.current)setError(e.message)}finally{if(alive.current&&current===generation.current)setBusy(false)}
 }
 return <><button ref={trigger} type="button" onClick={begin}>{label}</button>{open&&<dialog ref={dialog} className="intel-chart-study-dialog intel-chart-alert-editor" aria-labelledby={heading} onCancel={e=>{e.preventDefault();close()}}>
  <div className="intel-investigation-analysis-heading"><h2 id={heading}>{rule?'Edit chart alert':'Keep a chart condition'}</h2><button type="button" onClick={close}>Close</button></div>
  <form onSubmit={save}>
   <label>Alert name<input maxLength={120} required value={form.title} disabled={busy||!!saved} onChange={e=>set('title',e.target.value)}/></label>
   {sources.length>0&&<><label>Chart reference<select value={sourceIndex} disabled={busy||!!saved} onChange={e=>{setSourceIndex(e.target.value);const source=sources[Number(e.target.value)];setForm(f=>({...f,threshold:source.price,note:source.note??f.note}))}}>{sources.map((source,i)=><option value={i} key={i}>{source.label} · ${source.price.toLocaleString(undefined,{maximumFractionDigits:8})}</option>)}</select></label><p className="intel-analysis-caption">Selected on the chart at {time(sources[Number(sourceIndex)].t)}. This reference is a chart price, not a recorded trade.</p></>}
   <div className="intel-chart-alert-fields"><label>Condition<select value={form.direction} disabled={busy||!!saved} onChange={e=>set('direction',e.target.value)}><option value="above">Crosses above</option><option value="below">Crosses below</option></select></label><label>USD level<input type="number" min="0" max="1000000000000000000" step="any" required value={form.threshold} disabled={busy||!!saved} onChange={e=>set('threshold',e.target.value)}/></label><label>Cooldown<select value={form.cooldown} disabled={busy||!!saved} onChange={e=>set('cooldown',e.target.value)}>{[[15,'15 minutes'],[60,'1 hour'],[360,'6 hours'],[720,'12 hours'],[1440,'24 hours'],[2880,'48 hours']].map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label></div>
   <label>Your note<textarea maxLength={2000} rows={3} value={form.note} disabled={busy||!!saved} onChange={e=>set('note',e.target.value)}/></label>
   <div className="intel-chart-alert-fields"><label>Evaluation<select value={form.condition} disabled={busy||!!saved} onChange={e=>set('condition',e.target.value)}><option value="crossing">Crossing between observations</option><option value="sustained">Remains beyond the level</option></select></label><label>Repeat<select value={form.repeat} disabled={busy||!!saved} onChange={e=>set('repeat',e.target.value)}><option value="rearm">Rearm after reset</option><option value="once">Only once, then pause</option></select></label><label>Reset margin (%)<input type="number" min="0" max="50" step="any" value={form.hysteresis} disabled={busy||!!saved} onChange={e=>set('hysteresis',e.target.value)}/></label></div>
   {form.condition==='sustained'&&<label>Minimum observed duration (minutes)<input type="number" min="15" max="1440" step="1" required value={form.sustain} disabled={busy||!!saved} onChange={e=>set('sustain',e.target.value)}/></label>}
   <p className="intel-analysis-caption">The reset margin requires a return {form.direction==='above'?'below':'above'} the level by that percentage before another firing. A sustained condition requires consecutive usable checks; the path between observations is unknown. Save a draft to preview retained history before activation.</p>
   {!draftOnly&&<label className="intel-workstation-check"><input type="checkbox" checked={form.active} disabled={busy||!!saved} onChange={e=>set('active',e.target.checked)}/>Activate in-app alerts</label>}{draftOnly&&<p className="intel-analysis-caption">Choose an explicit USD crossing to monitor. Saving keeps this alert inactive; review it in Alerts before activation. The original thesis condition remains unchanged.</p>}
   <p className="intel-analysis-caption">Checked every 15 minutes against fresh shared USD quotes. The first observation sets a baseline; moves between checks can be missed. A gap over 20 minutes starts a new baseline. Manage existing notification channels in Settings.</p>
   {error&&<p role="alert">{error}</p>}{saved?<p role="status">{saved.active?'Chart alert active. Waiting for fresh observations.':'Chart alert saved as a draft.'} <Link className="intel-text-link" to="/intel/alerts">Open Alerts</Link></p>:<button type="submit" className="btn btn--primary" disabled={busy||!form.title.trim()}>{busy?'Saving…':!draftOnly&&form.active?'Save active alert':'Save draft'}</button>}
  </form>
 </dialog>}</>
}
