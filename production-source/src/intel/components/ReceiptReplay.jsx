import React,{useEffect,useMemo,useState} from 'react'
import {verifyReceipt,evidenceAt,observationState} from '../../../supabase/functions/_shared/intel/investigation-evidence.ts'
import TokenChart from './TokenChart'
import {InvestigationTable,time,value} from './InvestigationTable'
import {interpretStressRules,thesisStress} from '../../../supabase/functions/_shared/intel/investigation-calculations'
import StressSensitivity from './StressSensitivity'
import RwaSessions from './RwaSessions'
/** A receipt replays its own retained evidence, with no provider or current-state reads. */
export default function ReceiptReplay({receipt}){
 const [state,setState]=useState({input:null,result:null,error:null}),[cursor,setCursor]=useState(receipt.cursor),[scenarioFocus,setScenarioFocus]=useState(null)
 useEffect(()=>{let alive=true;setState({input:receipt,result:null,error:null});setCursor(receipt.cursor);setScenarioFocus(null);verifyReceipt(receipt).then(r=>{if(alive)setState({input:receipt,result:r,error:null})}).catch(()=>{if(alive)setState({input:receipt,result:null,error:'This receipt failed its integrity check. Its evidence cannot be replayed.'})});return()=>{alive=false}},[receipt])
 const verification=state.input===receipt?state.result:null,error=state.input===receipt?state.error:null,observations=verification?.receipt?.observations||[]
 const from=observations.length?Math.min(receipt.cursor,...observations.map(o=>Date.parse(o.observedAt))):receipt.cursor
 const at=Math.max(from,Math.min(receipt.cursor,cursor)),known=useMemo(()=>evidenceAt(observations,at),[observations,at])
 const priceObservations=observations.filter(o=>o.subject===receipt.subject&&o.metric==='price'&&o.unit==='USD'&&typeof o.value==='number'&&o.value>0)
 const prices=priceObservations.filter(o=>Date.parse(o.recordedAt)<=at&&Date.parse(o.observedAt)<=at).map(o=>({t:Date.parse(o.observedAt),c:o.value,closedAt:Date.parse(o.observedAt),recordedAt:Date.parse(o.recordedAt)}))
 if(error)return <p role="alert">{error}</p>
 if(!verification)return <p role="status">Checking saved evidence…</p>
 const scenario=receipt.scenario,scenarioRows=scenario?thesisStress(interpretStressRules(scenario.rules,scenario.bases),observations,receipt.subject,scenario.overrides,at):[]
 return <section className="intel-receipt-replay"><p className="intel-analysis-caption">Replaying the evidence included in this receipt. Current market data and private account activity are not loaded. {verification.unavailableObservations} references have no embedded observations.</p>
  {from<receipt.cursor&&<label className="intel-replay-cursor">Evidence known by {time(at)}<input aria-label="Saved evidence time" type="range" min={from} max={receipt.cursor} step="1" value={at} onChange={e=>setCursor(Number(e.target.value))}/></label>}
  {priceObservations.length>0?<TokenChart assetKey={`receipt:${receipt.fingerprint}`} candles={prices} height={230} workstation={false} readOnly timeWindow={{from:Math.min(from,at-1000),to:receipt.cursor}} cursorTime={at} onCursorChange={setCursor} priceCoverage={{coverage:'Retained USD price observations only. Missing candles, volume and execution prices are not reconstructed.'}}/>:<p className="intel-analysis-caption">No permitted USD price observations are included in this receipt. Other saved evidence remains below.</p>}
  {receipt.subject.startsWith('rwa:')&&observations.some(o=>o.provider==='investor-intel-editorial')&&<RwaSessions subject={receipt.subject} observations={observations} at={at}/>}
  <InvestigationTable rows={known} caption="Evidence known at the replay cursor" columns={[
   ['Observation',o=>o.metric.replaceAll('_',' ')],['Value',o=>`${value(o.value)} ${o.unit}`],['Asset',o=>o.subject],['Observed',o=>time(o.observedAt)],['Recorded',o=>time(o.recordedAt)],['State',o=>observationState(o,at)],
  ]}/>
  {scenario&&<section aria-label="Saved stress scenario"><h3>Saved stress scenario</h3><p className="intel-analysis-caption">Numeric conditions and your hypothetical inputs captured {time(scenario.capturedAt)} · {scenario.methodVersion}. This is a retrospective rehearsal against the saved evidence; it is not a claim that these conditions were authored at the replay cursor. Today's thesis and holdings are not read or changed.</p><InvestigationTable rows={scenarioRows} caption="Original saved conditions and inputs" columns={[
   ['Condition',r=><button type="button" className="intel-text-link" onClick={()=>setScenarioFocus(r.rule.id)}>{r.rule.label||r.rule.metric.replaceAll('_',' ')} {({lt:'<',gt:'>',lte:'≤',gte:'≥',eq:'=',neq:'≠'})[r.rule.comparator]||r.rule.comparator} {value(r.rule.threshold)} {r.rule.unit||''}</button>],['Evidence value',r=>value(r.current)],['Saved scenario value',r=>value(r.hypothetical)],['Evidence / scenario',r=>`${r.currentlyMet==null?'Unknown':r.currentlyMet?'Met':'Not met'} / ${r.scenarioMet==null?'Unknown':r.scenarioMet?'Met':'Not met'}`],['Coverage',r=>r.reason||'Embedded dated evidence'],
  ]}/><StressSensitivity row={scenarioRows.find(r=>r.rule.id===(scenarioFocus||scenario.focusRule))||scenarioRows[0]}/></section>}
 </section>
}
