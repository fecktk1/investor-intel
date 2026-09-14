import React,{useState,useRef,useEffect} from 'react'
import {requestChartWorkspace} from '../lib/chart-workspace-api'
export const MARKET_TRIGGERS=['price_move','volume_spike','liquidity_drop']
const thresholdFields={price_move:['threshold_pct','Rolling 24-hour change (%)'],volume_spike:['threshold_pct','Rolling 24-hour volume change (%)'],liquidity_drop:['min_liquidity_usd','Liquidity below (USD)'],wallet_activity:['min_usd','Recorded activity minimum (USD)'],narrative_heat:['momentum_delta','Narrative momentum increase (points)'],holder_shift:['threshold_pct','Holder change (%)'],unlock:['window_days','Upcoming unlock window (days)'],supply_shock:['threshold_pct','Supply change (%)']}
export const marketAlertForm=config=>({title:config?.title||'',note:config?.note||'',condition:config?.condition||'crossing',direction:config?.direction||'either',repeat:config?.repeat||'rearm',hysteresis:config?.hysteresis_pct??0,sustain:config?.sustain_minutes??15,threshold:config?.min_liquidity_usd??config?.threshold_pct??10})
export function marketAlertConfig(form){
 const threshold=Number(form.threshold),hysteresis=Number(form.hysteresis),sustain=Number(form.sustain)
 if(form.threshold===''||!Number.isFinite(threshold)||threshold<0||threshold>1e18)throw Error('Enter a threshold of zero or greater.')
 if(!['up','down','either'].includes(form.direction)||!['crossing','sustained','legacy_level'].includes(form.condition)||!['once','rearm'].includes(form.repeat)||!Number.isFinite(hysteresis)||hysteresis<0||hysteresis>50||form.condition==='sustained'&&(!Number.isInteger(sustain)||sustain<15||sustain>1440))throw Error('Check the condition, reset margin and duration.')
 return {title:form.title,note:form.note,visibility:'private',condition:form.condition,direction:form.direction,repeat:form.repeat,hysteresis_pct:hysteresis,sustain_minutes:form.condition==='sustained'?sustain:0}
}
export function MarketAlertFields({form,setForm,trigger,disabled=false}){
 const set=(key,value)=>setForm(f=>({...f,[key]:value}))
 return <><div className="intel-chart-alert-fields">
  <label>Evaluation<select disabled={disabled} value={form.condition} onChange={e=>set('condition',e.target.value)}><option value="crossing">Crossing between samples</option><option value="sustained">Sustained across samples</option><option value="legacy_level">Threshold match at a check</option></select></label>
  {trigger==='price_move'&&<label>Change direction<select disabled={disabled} value={form.direction} onChange={e=>set('direction',e.target.value)}><option value="either">Either direction</option><option value="up">Up</option><option value="down">Down</option></select></label>}
  <label>Repeat<select disabled={disabled} value={form.repeat} onChange={e=>set('repeat',e.target.value)}><option value="rearm">{form.condition==='legacy_level'?'Repeat after cooldown':'Rearm after reset'}</option><option value="once">Only once, then pause</option></select></label>
  {form.condition!=='legacy_level'&&<label>Reset margin (%)<input disabled={disabled} type="number" min="0" max="50" step="any" value={form.hysteresis} onChange={e=>set('hysteresis',e.target.value)}/></label>}
  {form.condition==='sustained'&&<label>Observed duration (minutes)<input disabled={disabled} type="number" min="15" max="1440" step="1" required value={form.sustain} onChange={e=>set('sustain',e.target.value)}/></label>}
 </div><p className="intel-analysis-caption">{trigger==='liquidity_drop'?'Absolute reported liquidity below your level; this is not executable order-book depth.':'Reported rolling 24-hour change; the baseline is the source’s rolling window, not your entry or activation price.'} Checks run every 15 minutes. Crossings need two compatible samples; a gap over 20 minutes establishes a new baseline. The path between samples is unknown.</p></>
}
export default function MarketAlertControls({rule,context,onChanged}){
 const market=MARKET_TRIGGERS.includes(rule.trigger_type),thresholdField=thresholdFields[rule.trigger_type]
 const [form,setForm]=useState(()=>({...marketAlertForm(rule.config),threshold:thresholdField?rule.config?.[thresholdField[0]]??0:0,condition:rule.config?.condition||'legacy_level',active:rule.is_active,cooldown:rule.cooldown_minutes??720})),[busy,setBusy]=useState(false),[error,setError]=useState(null)
 const operation=useRef(null),alive=useRef(true)
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
 const save=async e=>{e.preventDefault();setBusy(true);setError(null);try{if(thresholdField&&(form.threshold===''||!Number.isFinite(Number(form.threshold))||Number(form.threshold)<0))throw Error('Enter a threshold of zero or greater.');const config={...rule.config,...(market?marketAlertConfig(form):{title:form.title,note:form.note,visibility:'private'}),...(thresholdField?{[thresholdField[0]]:Number(form.threshold)}:{})},body={operation:'alert_general_save',id:rule.id,revision:rule.chart_revision,entityId:rule.entity_id,trigger:rule.trigger_type,config,active:form.active,cooldownMinutes:Number(form.cooldown)},signature=JSON.stringify(body);if(operation.current?.signature!==signature)operation.current={signature,id:crypto.randomUUID()};await requestChartWorkspace(context,{...body,operationId:operation.current.id});if(alive.current){operation.current=null;onChanged?.()}}catch(e){if(alive.current)setError(e.message)}finally{if(alive.current)setBusy(false)}}
 return <details className="intel-alert-rule-editor"><summary>Edit condition and activation</summary><form onSubmit={save}>
  <label>Alert name<input maxLength={120} value={form.title} onChange={e=>setForm(f=>({...f,title:e.target.value}))}/></label>
  {thresholdField&&<label>{thresholdField[1]}<input required type="number" min="0" max={rule.trigger_type==='unlock'?90:rule.trigger_type==='narrative_heat'?100:1e18} step="any" value={form.threshold} onChange={e=>setForm(f=>({...f,threshold:e.target.value}))}/></label>}
  {market?<MarketAlertFields form={form} setForm={setForm} trigger={rule.trigger_type} disabled={busy}/>:<p className="intel-analysis-caption">Source events are checked on the existing 15-minute schedule, with cooldown and duplicate suppression. Retained history may be incomplete. {rule.trigger_type==='holder_shift'?'Comparable holder population and source observation clocks are unavailable; this rule cannot currently evaluate.':''}</p>}
  <label>Your note<textarea rows={2} maxLength={2000} value={form.note} onChange={e=>setForm(f=>({...f,note:e.target.value}))}/></label>
  <label>Cooldown<select value={form.cooldown} onChange={e=>setForm(f=>({...f,cooldown:e.target.value}))}>{[15,60,360,720,1440,2880].map(n=><option key={n} value={n}>{n} minutes</option>)}</select></label>
  <label className="intel-workstation-check"><input type="checkbox" checked={form.active} onChange={e=>setForm(f=>({...f,active:e.target.checked}))}/>Active in-app</label>
  <p className="intel-analysis-caption">An edit saves a new rule revision and resets its baseline. Original firing receipts retain their saved words and source version.</p>
  {error&&<p role="alert">{error}</p>}<button disabled={busy} className="btn btn--primary">{busy?'Saving…':'Save rule revision'}</button>
 </form></details>
}
