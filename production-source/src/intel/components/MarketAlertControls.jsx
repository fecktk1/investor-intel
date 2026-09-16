import React,{useState,useRef,useEffect} from 'react'
import {useTranslation} from 'react-i18next'
import {requestChartWorkspace} from '../lib/chart-workspace-api'
export const MARKET_TRIGGERS=['price_move','volume_spike','liquidity_drop']
// Triggers whose value is an oscillating LEVEL and which therefore now reach the
// same armed/re-arm machine the market triggers use (migration 20260916093000).
// They are NOT market triggers: they keep their own threshold field and their
// own explanatory caption, and only the behaviour controls are shared.
export const CONDITION_TRIGGERS=[...MARKET_TRIGGERS,'supply_shock','narrative_heat']
const thresholdFields={price_move:['threshold_pct','Rolling 24-hour change (%)'],volume_spike:['threshold_pct','Rolling 24-hour volume change (%)'],liquidity_drop:['min_liquidity_usd','Liquidity below (USD)'],wallet_activity:['min_usd','Recorded activity minimum (USD)'],narrative_heat:['momentum_delta','Narrative momentum increase (points)'],holder_shift:['threshold_pct','Holder change (%)'],unlock:['window_days','Upcoming unlock window (days)'],supply_shock:['threshold_pct','Supply change (%)']}
export const marketAlertForm=config=>({title:config?.title||'',note:config?.note||'',condition:config?.condition||'crossing',direction:config?.direction||'either',repeat:config?.repeat||'rearm',hysteresis:config?.hysteresis_pct??0,sustain:config?.sustain_minutes??15,threshold:config?.min_liquidity_usd??config?.threshold_pct??10})
export function marketAlertConfig(form){
 const threshold=Number(form.threshold),hysteresis=Number(form.hysteresis),sustain=Number(form.sustain)
 if(form.threshold===''||!Number.isFinite(threshold)||threshold<0||threshold>1e18)throw Error('Enter a threshold of zero or greater.')
 if(!['up','down','either'].includes(form.direction)||!['crossing','sustained','legacy_level'].includes(form.condition)||!['once','rearm'].includes(form.repeat)||!Number.isFinite(hysteresis)||hysteresis<0||hysteresis>50||form.condition==='sustained'&&(!Number.isInteger(sustain)||sustain<15||sustain>1440))throw Error('Check the condition, reset margin and duration.')
 return {title:form.title,note:form.note,visibility:'private',condition:form.condition,direction:form.direction,repeat:form.repeat,hysteresis_pct:hysteresis,sustain_minutes:form.condition==='sustained'?sustain:0}
}
// Wallet and unlock rules fire on DISCRETE records, so hysteresis does not apply
// to them (migration 20260916093000). Their repeat problem is different: one
// transaction's several transfer legs, a burst of split transfers, or one unlock
// revised several times. Migration 20260916204000 adds two opt-in keys the
// bridge reads for exactly these two triggers. The defaults are today's
// behaviour, and a rule that has never set a key keeps not setting it.
export const REPEAT_TRIGGERS=['wallet_activity','unlock']
export const REPEAT_DEFAULTS={wallet_activity:'transfer',unlock:'version'}
export const REPEAT_DISTINCT={wallet_activity:['transfer','transaction'],unlock:['version','event']}
export const MAX_REPEAT_WINDOW_MINUTES=10080
export const bridgeRepeatForm=(trigger,config)=>({distinctBy:config?.distinct_by??REPEAT_DEFAULTS[trigger]??'',repeatWindow:config?.repeat_window_minutes??0})
/** The config keys to save. A key is written only when the rule already had it
 *  or the owner chose something other than the default, so opening and saving
 *  an existing rule never adds keys it did not have. */
const defaultText=(key,options)=>String(options?.defaultValue??key).replace(/\{\{(\w+)\}\}/g,(_,name)=>String(options?.[name]??''))
export function bridgeRepeatConfig(trigger,form,previous={},t=defaultText){
 if(!REPEAT_TRIGGERS.includes(trigger))return {}
 const minutes=Number(form.repeatWindow)
 if(!REPEAT_DISTINCT[trigger].includes(form.distinctBy))throw Error(t('alerts.repeat_distinct_invalid',{defaultValue:'Choose what counts as one alert.'}))
 if(form.repeatWindow===''||!Number.isInteger(minutes)||minutes<0||minutes>MAX_REPEAT_WINDOW_MINUTES)throw Error(t('alerts.repeat_window_invalid',{max:MAX_REPEAT_WINDOW_MINUTES,defaultValue:'Enter a repeat window between 0 and {{max}} whole minutes.'}))
 const out={}
 if(Object.hasOwn(previous||{},'distinct_by')||form.distinctBy!==REPEAT_DEFAULTS[trigger])out.distinct_by=form.distinctBy
 if(Object.hasOwn(previous||{},'repeat_window_minutes')||minutes!==0)out.repeat_window_minutes=minutes
 return out
}
export function BridgeRepeatFields({form,setForm,trigger,disabled=false}){
 const {t}=useTranslation('intel',{useSuspense:false})
 if(!REPEAT_TRIGGERS.includes(trigger))return null
 const set=(key,value)=>setForm(f=>({...f,[key]:value}))
 const wallet=trigger==='wallet_activity'
 return <><div className="intel-chart-alert-fields">
  <label>{t('alerts.repeat_distinct_label',{defaultValue:'One alert per'})}<select disabled={disabled} value={form.distinctBy} onChange={e=>set('distinctBy',e.target.value)}>
   {wallet?<><option value="transfer">{t('alerts.repeat_distinct_transfer',{defaultValue:'Qualifying transfer'})}</option><option value="transaction">{t('alerts.repeat_distinct_transaction',{defaultValue:'Transaction'})}</option></>
    :<><option value="version">{t('alerts.repeat_distinct_version',{defaultValue:'Schedule revision'})}</option><option value="event">{t('alerts.repeat_distinct_event',{defaultValue:'Scheduled unlock'})}</option></>}
  </select></label>
  <label>{wallet?t('alerts.repeat_window_wallet_label',{defaultValue:'Fold transfers within (minutes)'}):t('alerts.repeat_window_unlock_label',{defaultValue:'Re-alert a revised unlock after (minutes)'})}<input disabled={disabled} type="number" min="0" max={MAX_REPEAT_WINDOW_MINUTES} step="1" value={form.repeatWindow} onChange={e=>set('repeatWindow',e.target.value)}/></label>
 </div><p className="intel-analysis-caption">{wallet
  ?t('alerts.repeat_wallet_explanation',{defaultValue:'Each transfer is a separate recorded event, so a reset margin does not apply. "Transaction" sends one alert for all transfer legs that share a transaction hash. A fold window above 0 treats a transfer of the same asset in the same direction, recorded within that many minutes of an alerted transfer by its source time, as part of that alert. Leaving "Qualifying transfer" and 0 keeps this rule\'s existing behaviour exactly.'})
  :t('alerts.repeat_unlock_explanation',{defaultValue:'An unlock is a dated schedule entry, not a level, so a reset margin does not apply. A provider revising the schedule records a new version, which alerts again by default. "Scheduled unlock" sends one alert per unlock however often it is revised. A window above 0 lets a revision alert again only once that many minutes have passed since the last alert for the same unlock. Leaving "Schedule revision" and 0 keeps this rule\'s existing behaviour exactly.'})}</p></>
}
export function MarketAlertFields({form,setForm,trigger,disabled=false}){
 const set=(key,value)=>setForm(f=>({...f,[key]:value}))
 return <><div className="intel-chart-alert-fields">
  <label>Evaluation<select disabled={disabled} value={form.condition} onChange={e=>set('condition',e.target.value)}><option value="crossing">Crossing between samples</option><option value="sustained">Sustained across samples</option><option value="legacy_level">Threshold match at a check</option></select></label>
  {trigger==='price_move'&&<label>Change direction<select disabled={disabled} value={form.direction} onChange={e=>set('direction',e.target.value)}><option value="either">Either direction</option><option value="up">Up</option><option value="down">Down</option></select></label>}
  <label>Repeat<select disabled={disabled} value={form.repeat} onChange={e=>set('repeat',e.target.value)}><option value="rearm">{form.condition==='legacy_level'?'Repeat after cooldown':'Rearm after reset'}</option><option value="once">Only once, then pause</option></select></label>
  {form.condition!=='legacy_level'&&<label>Reset margin (%)<input disabled={disabled} type="number" min="0" max="50" step="any" value={form.hysteresis} onChange={e=>set('hysteresis',e.target.value)}/></label>}
  {form.condition==='sustained'&&<label>Observed duration (minutes)<input disabled={disabled} type="number" min="15" max="1440" step="1" required value={form.sustain} onChange={e=>set('sustain',e.target.value)}/></label>}
 </div><p className="intel-analysis-caption">{trigger==='liquidity_drop'?'Absolute reported liquidity below your level; this is not executable order-book depth.':trigger==='supply_shock'?'Signed supply change between consecutive retained snapshots, compared on its size, so a contraction and an expansion of the same size both match. The reset margin is a margin on that size.':trigger==='narrative_heat'?'Narrative momentum and risk are scores recalculated on their own cadence, not market observations. A stage change stays a one-off transition and is never debounced by the reset margin.':'Reported rolling 24-hour change; the baseline is the source’s rolling window, not your entry or activation price.'} {trigger==='supply_shock'?'Consecutive snapshots up to 48 hours apart stay comparable.':trigger==='narrative_heat'?'Calculations up to 6 hours apart stay comparable.':'Checks run every 15 minutes. Crossings need two compatible samples; a gap over 20 minutes establishes a new baseline.'} Leaving the evaluation on “Threshold match at a check” keeps this rule’s existing behaviour exactly. The path between samples is unknown.</p></>
}
export default function MarketAlertControls({rule,context,onChanged}){
 const {t}=useTranslation('intel',{useSuspense:false})
 const market=CONDITION_TRIGGERS.includes(rule.trigger_type),thresholdField=thresholdFields[rule.trigger_type]
 const [form,setForm]=useState(()=>({...marketAlertForm(rule.config),...bridgeRepeatForm(rule.trigger_type,rule.config),threshold:thresholdField?rule.config?.[thresholdField[0]]??0:0,condition:rule.config?.condition||'legacy_level',active:rule.is_active,cooldown:rule.cooldown_minutes??720})),[busy,setBusy]=useState(false),[error,setError]=useState(null)
 const operation=useRef(null),alive=useRef(true)
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
 const save=async e=>{e.preventDefault();setBusy(true);setError(null);try{if(thresholdField&&(form.threshold===''||!Number.isFinite(Number(form.threshold))||Number(form.threshold)<0))throw Error('Enter a threshold of zero or greater.');const config={...rule.config,...(market?marketAlertConfig(form):{title:form.title,note:form.note,visibility:'private'}),...bridgeRepeatConfig(rule.trigger_type,form,rule.config,t),...(thresholdField?{[thresholdField[0]]:Number(form.threshold)}:{})},body={operation:'alert_general_save',id:rule.id,revision:rule.chart_revision,entityId:rule.entity_id,trigger:rule.trigger_type,config,active:form.active,cooldownMinutes:Number(form.cooldown)},signature=JSON.stringify(body);if(operation.current?.signature!==signature)operation.current={signature,id:crypto.randomUUID()};await requestChartWorkspace(context,{...body,operationId:operation.current.id});if(alive.current){operation.current=null;onChanged?.()}}catch(e){if(alive.current)setError(e.message)}finally{if(alive.current)setBusy(false)}}
 return <details className="intel-alert-rule-editor"><summary>Edit condition and activation</summary><form onSubmit={save}>
  <label>Alert name<input maxLength={120} value={form.title} onChange={e=>setForm(f=>({...f,title:e.target.value}))}/></label>
  {thresholdField&&<label>{thresholdField[1]}<input required type="number" min="0" max={rule.trigger_type==='unlock'?90:rule.trigger_type==='narrative_heat'?100:1e18} step="any" value={form.threshold} onChange={e=>setForm(f=>({...f,threshold:e.target.value}))}/></label>}
  {REPEAT_TRIGGERS.includes(rule.trigger_type)&&<BridgeRepeatFields form={form} setForm={setForm} trigger={rule.trigger_type} disabled={busy}/>}
  {market?<MarketAlertFields form={form} setForm={setForm} trigger={rule.trigger_type} disabled={busy}/>:<p className="intel-analysis-caption">Source events are checked on the existing 15-minute schedule, with cooldown and duplicate suppression. Retained history may be incomplete. {rule.trigger_type==='holder_shift'?'Comparable holder population and source observation clocks are unavailable; this rule cannot currently evaluate.':''}</p>}
  <label>Your note<textarea rows={2} maxLength={2000} value={form.note} onChange={e=>setForm(f=>({...f,note:e.target.value}))}/></label>
  <label>Cooldown<select value={form.cooldown} onChange={e=>setForm(f=>({...f,cooldown:e.target.value}))}>{[15,60,360,720,1440,2880].map(n=><option key={n} value={n}>{n} minutes</option>)}</select></label>
  <label className="intel-workstation-check"><input type="checkbox" checked={form.active} onChange={e=>setForm(f=>({...f,active:e.target.checked}))}/>Active in-app</label>
  <p className="intel-analysis-caption">An edit saves a new rule revision and resets its baseline. Original firing receipts retain their saved words and source version.</p>
  {error&&<p role="alert">{error}</p>}<button disabled={busy} className="btn btn--primary">{busy?'Saving…':'Save rule revision'}</button>
 </form></details>
}
