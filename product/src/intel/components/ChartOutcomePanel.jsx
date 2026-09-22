import React,{useState} from 'react'
import {useChartStructure} from '../lib/useChartStructure'
import {chartOutcomeDrawing,validateOutcomeSpec} from '../../../supabase/functions/_shared/intel/chart-outcome'
import {validateSavedOutcome} from '../../../supabase/functions/_shared/intel/chart-outcome-contract'
import {InvestigationTable,value} from './InvestigationTable'

const labels={pending:'Trigger pending',open:'Condition active',target:'Target reached',stopped:'Stop reached',ambiguous:'Order unresolved',incomplete:'Missing source periods',unavailable:'No eligible candles',missed:'Entry bracket missed'}
export default function ChartOutcomePanel({bars,at,intervalMs,knownOnly,timezone='UTC',source='Source unavailable',onKeep,readOnly,savedNotes=[]}){
 const initial={direction:'long',trigger:'close_above',entry:'',stop:'',target:'',quantity:'1',feeBps:'0',slippageBps:'0',start:bars[0]?new Date(bars[0].t).toISOString().slice(0,-1):''}
 const [form,setForm]=useState(initial),[submitted,setSubmitted]=useState(null),[formError,setFormError]=useState(null),[notice,setNotice]=useState(null)
 const options=submitted?{...submitted.options,analysis:'outcome',spec:submitted.spec,enabled:true}:{analysis:'outcome',enabled:false}
 const {result,loading,error}=useChartStructure(submitted?.bars??bars,options)
 // A backward replay cursor must hide every result that used future bars.
 const changedBasis=submitted&&(submitted.options.knownOnly!==knownOnly||submitted.options.intervalMs!==intervalMs||submitted.source!==source)
 const visible=submitted&&!changedBasis&&submitted.options.at<=at?result?.outcome:null
 const dirty=submitted&&JSON.stringify(form)!==submitted.signature
 const update=key=>event=>{setForm(f=>({...f,[key]:event.target.value}));setNotice(null)}
 const evaluate=event=>{
  event.preventDefault();setFormError(null);setNotice(null)
  try{const spec=validateOutcomeSpec({...form,entry:Number(form.entry),stop:Number(form.stop),target:form.target.trim()===''?null:Number(form.target),quantity:Number(form.quantity),feeBps:Number(form.feeBps),slippageBps:Number(form.slippageBps),start:Date.parse(form.start+'Z')});if(spec.start>at)throw Error('Start must be on or before the chart evaluation cutoff.');setSubmitted({spec,bars:bars.map(b=>({...b})),options:{at,intervalMs,knownOnly},signature:JSON.stringify(form),source})}
  catch(e){setFormError(e.message)}
 }
 const time=t=>new Date(t).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'medium',timeZone:timezone})
 const restore=id=>{
  if(!id)return
  try{const saved=validateSavedOutcome(savedNotes.find(note=>note.id===id)?.outcome),spec=saved.spec
   setForm({...spec,entry:String(spec.entry),stop:String(spec.stop),target:spec.target==null?'':String(spec.target),quantity:String(spec.quantity),feeBps:String(spec.feeBps),slippageBps:String(spec.slippageBps),start:new Date(spec.start).toISOString().slice(0,-1)})
   setSubmitted(null);setFormError(null);setNotice(`Saved assumptions restored. Original source: ${saved.source}; interval ${saved.intervalMs/1000} seconds; evaluated through ${new Date(saved.at).toISOString()}; recorded-only ${saved.knownOnly}. Evaluate explicitly against the currently loaded evidence. The original outcome note stays unchanged.`)
  }catch(e){setFormError(e.message)}
 }
 const save=()=>{try{if(onKeep?.(chartOutcomeDrawing(visible,crypto.randomUUID(),submitted.source))===false)throw Error('The annotation could not be added. Check the drawing limit and retry.');setNotice('Outcome note added. Save the chart layout to keep the exact assumptions and result.')}catch(e){setNotice(e.message)}}
 const eventRows=visible?[...visible.entry?[{id:'entry',label:'Modeled entry',...visible.entry}]:[],...visible.exit?[{id:'exit',label:'Modeled exit',...visible.exit}]:[]]:[]
 return <section aria-label="Chart outcome sandbox">
  <p>Test your own conditions against completed candles. This is retrospective research; it does not record a trade or change your thesis.</p>
  {savedNotes.some(note=>note.outcome)&&<label className="intel-inline-field intel-outcome-saved">Saved outcome assumptions<select value="" onChange={e=>restore(e.target.value)}><option value="">Choose a saved scenario</option>{savedNotes.filter(note=>note.outcome).map(note=><option key={note.id} value={note.id}>{note.outcome.spec.direction} · {new Date(note.outcome.at).toLocaleString()} · {note.text.slice(0,80)}</option>)}</select></label>}
  <form onSubmit={evaluate} className="intel-outcome-form">
   <label>Direction<select value={form.direction} onChange={update('direction')}><option value="long">Long hypothesis</option><option value="short">Short hypothesis</option></select></label>
   <label>Trigger<select value={form.trigger} onChange={update('trigger')}><option value="close_above">Close above entry</option><option value="close_below">Close below entry</option><option value="touch">Touch entry price</option></select></label>
   <label>Start (UTC)<input type="datetime-local" step="0.001" required value={form.start} onChange={update('start')}/></label>
   {[['entry','Entry threshold'],['stop','Stop price'],['target','Target price (optional)'],['quantity','Asset quantity'],['feeBps','Fee per side (bps)'],['slippageBps','Slippage per side (bps)']].map(([key,label])=><label key={key}>{label}<input type="number" min="0" max={['feeBps','slippageBps'].includes(key)?1000:undefined} step="any" required={key!=='target'} value={form[key]} onChange={update(key)}/></label>)}
   <div className="intel-outcome-actions"><button type="submit" className="btn" disabled={!intervalMs||!bars.length}>Evaluate conditions</button><button type="button" onClick={()=>{setForm(initial);setSubmitted(null);setNotice(null);setFormError(null)}}>Reset assumptions</button></div>
  </form>
  {formError&&<p role="alert">{formError}</p>}{error&&<p role="alert">{error}</p>}{submitted&&loading&&<p role="status">Evaluating completed candles…</p>}
  {changedBasis&&<p role="status">Source or replay assumptions changed. Evaluate again before keeping a result.</p>}
  {dirty&&<p role="status">Assumptions changed. Evaluate again before keeping a result.</p>}
  {submitted&&submitted.options.at>at&&<p role="status">This result used later candles. Evaluate again at the current replay time.</p>}
  {visible&&<div className="intel-outcome-result" aria-label="Outcome evidence"><h4>{labels[visible.status]}</h4><p>{visible.reason}</p><p className="intel-analysis-caption">{submitted.source} · {visible.bars} eligible candles · evaluated through {time(visible.at)} ({timezone}) · inputs captured by {visible.knownAt==null?'unknown':time(visible.knownAt)}. Frozen until you evaluate again.</p>
   {eventRows.length>0&&<InvestigationTable rows={eventRows} pageSize={2} caption="Modeled event sequence" columns={[
    ['Event',r=>r.label],['Time or containing candle',r=>r.exactTime?time(r.id==='entry'?r.closedAt:r.t):`${time(r.t)} – ${time(r.closedAt)}`],['Price before costs',r=>value(r.price)],
   ]}/>}
   {visible.pnl&&<p>Gross after slippage {value(visible.pnl.gross)} · fees {value(visible.pnl.fees)} · net modeled result {value(visible.pnl.net)} in the chart quote currency.</p>}
   {visible.possibilities.length>0&&<InvestigationTable rows={visible.possibilities.map((p,i)=>({...p,id:String(i)}))} pageSize={2} caption="Possible outcomes; no ordering assumed" columns={[
    ['Sequence',r=>r.label],['Net after modeled costs',r=>value(r.net)],
   ]}/>}
   {!readOnly&&onKeep&&!dirty&&<button type="button" className="btn" onClick={save}>Keep outcome note</button>}
  </div>}
  {notice&&<p role="status">{notice}</p>}
  <details className="intel-chart-readings"><summary>Execution assumptions and limits</summary><p>Close triggers enter at that completed close. Touch triggers use the threshold; a candle does not reveal the exact touch time. Stops crossed at the next candle open use the opening price; targets use their threshold without favorable gap improvement. Fees and adverse slippage apply on each side; 1 basis point is 0.01%. Borrowing, funding, taxes, order-book liquidity, partial fills and actual execution are not modeled. Missing periods or uncertain intrabar order remain unresolved. No unrealized gain is treated as a realized outcome.</p></details>
 </section>
}
