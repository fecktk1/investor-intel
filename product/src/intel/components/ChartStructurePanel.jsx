import ChartOutcomePanel from './ChartOutcomePanel'
import ChartReadPanel from './ChartReadPanel'
import ChartPatternPanel from './ChartPatternPanel'
import ChartTimeframePanel from './ChartTimeframePanel'
import React,{useEffect,useState} from 'react'
import {useTranslation} from 'react-i18next'
import {useChartStructure} from '../lib/useChartStructure'
import {structureDrawing} from '../../../supabase/functions/_shared/intel/chart-structure'
import {InvestigationTable,value} from './InvestigationTable'
export default function ChartStructurePanel({bars,at,intervalMs,timezone='UTC',source='Source unavailable',readOnly=false,knownOnly=false,onInspect,onKeep,savedNotes=[]}){
 const {t}=useTranslation('intel',{useSuspense:false})
 const [window,setWindow]=useState(2),[view,setView]=useState('levels'),[readMode,setReadMode]=useState('neutral'),[selectedId,setSelectedId]=useState(null),[notice,setNotice]=useState(null)
 const {result,loading,error}=useChartStructure(bars,{at,intervalMs,window,knownOnly,enabled:view!=='outcome',analysis:view==='read'?'read':view==='alignment'?'alignment':['patterns','impulse','profile','week'].includes(view)?'patterns':'structure'})
 const rows=result&&!result.alignment&&!result.patternRead&&!result.researchRead?(view==='levels'?result.pivots:view==='events'?result.events:view==='zones'?(result.levels||[]):result.gaps).slice():[]
 if(view!=='zones')rows.reverse()
 useEffect(()=>{setSelectedId(null);setNotice(null);onInspect?.(null)},[bars,at,intervalMs,window,view]) // eslint-disable-line react-hooks/exhaustive-deps
 const selected=rows.find(r=>r.id===selectedId),time=n=>new Date(n).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'medium',timeZone:timezone})
 const inspect=row=>{setSelectedId(row.id);setNotice(null);onInspect?.(row)}
 const keep=()=>{if(!selected)return;try{const drawing=structureDrawing(selected,crypto.randomUUID(),source);if(onKeep?.(drawing)===false)throw new Error('The annotation could not be added. Check the drawing limit and try again.');setNotice('Annotation added. Save the layout to keep it across visits, or include it in a permitted snapshot.')}catch(e){setNotice(e.message)}}
 return <section className="intel-chart-structure" aria-label={t('chart.structure',{defaultValue:'Chart structure'})}>
  <div className="intel-investigation-analysis-heading"><h3>{t('chart.structure',{defaultValue:'Chart structure'})}</h3><div className="intel-structure-controls"><label>Read<select value={view} onChange={e=>{setView(e.target.value);setSelectedId(null);setNotice(null)}}><option value="read">Annotated research</option><option value="outcome">Outcome sandbox</option><option value="levels">Confirmed levels</option><option value="zones">Support / resistance tiers</option><option value="alignment">Timeframe alignment</option><option value="patterns">Pattern candidates</option><option value="impulse">Impulse Fibonacci</option><option value="profile">Volume by price</option><option value="week">Weekly description</option><option value="events">Breaks, retests and sweeps</option><option value="gaps">Wick-gap candidates</option></select></label>{!['alignment','profile','week','outcome'].includes(view)&&<label>Pivot window<select value={window} onChange={e=>{setWindow(Number(e.target.value));setSelectedId(null);setNotice(null)}}>{[1,2,3,5,10].map(n=><option value={n} key={n}>{n} bars each side</option>)}</select></label>}</div></div>
  <p className="intel-analysis-caption">{source} · {timezone} · Analysis cutoff <time dateTime={new Date(at).toISOString()}>{time(at)}</time>.</p><details className="intel-chart-readings"><summary>Observation timing</summary><p>{knownOnly?'Only captures recorded by this time are included.':'Retrospective bar analysis; original availability is shown separately when retained.'} A source bar time, its completed close and its first recorded availability can differ.</p></details>
  {view!=='outcome'&&loading&&<p role="status">Calculating chart structure…</p>}{error&&<p role="alert">{error}</p>}
  {view==='outcome'&&<ChartOutcomePanel bars={bars} at={at} intervalMs={intervalMs} knownOnly={knownOnly} timezone={timezone} source={source} onKeep={onKeep} readOnly={readOnly} savedNotes={savedNotes}/>}
  {view==='read'&&<ChartReadPanel result={result?.researchRead} readingMode={readMode} onReadingModeChange={setReadMode} timezone={timezone} source={source} onKeep={onKeep} onInspect={onInspect} readOnly={readOnly}/>}
  {['patterns','impulse','profile','week'].includes(view)&&<ChartPatternPanel result={result?.patternRead} view={view} timezone={timezone} source={source} onKeep={onKeep} onInspect={onInspect} readOnly={readOnly}/>}
  {view==='alignment'&&<ChartTimeframePanel result={result?.alignment} timezone={timezone} source={source} onKeep={onKeep} readOnly={readOnly}/>}
  {result&&!result.alignment&&!result.patternRead&&!result.researchRead&&<><p className="intel-analysis-caption">{(view==='zones'?result.levelsReason:result.reason)||`${view==='zones'?result.levelsVersion:result.version} · ATR (14): ${value(result.atr)} · ${result.omitted} incomplete or unavailable bars excluded.`}</p>
   {rows.length>0&&<p className="intel-structure-scroll-hint">Scroll the table horizontally for confirmation times and state.</p>}
   {!rows.length?<p>No {view==='levels'?'confirmed levels':view==='zones'?'confirmed zones':view==='events'?'structure events':'wick-gap candidates'} in the eligible bars. Change the period or confirmation window.</p>:<InvestigationTable key={`${view}:${window}`} pageSize={6} rows={rows} columns={[
    ['Finding',r=><button type="button" className="intel-text-link" aria-pressed={selectedId===r.id} onClick={()=>inspect(r)}>{r.label}{r.tier?` · ${r.tier}`:""}{r.classification?` · ${r.classification}`:''}</button>],
    ['Level',r=>r.lower!=null?`${value(r.lower)} – ${value(r.upper)}`:value(r.price)],
    ['Confirmed',r=><time dateTime={new Date(r.confirmedAt).toISOString()}>{time(r.confirmedAt)}</time>],
    [['levels','zones'].includes(view)?'Distance / ATR':'State',r=>['levels','zones'].includes(view)?value(r.distanceAtr):r.kind.startsWith('gap')?(r.filledAt?'Far edge reached':'Unfilled in these bars'):r.kind],
   ]}/>}
   {selected&&<div className="intel-structure-evidence" aria-label="Selected structure evidence"><h4>{selected.label}</h4><p>{selected.definition}</p>{selected.confirmations&&<InvestigationTable pageSize={5} caption="Zone confirmation evidence" rows={selected.confirmations} columns={[["Pivot",r=>r.label],["Price",r=>value(r.price)],["Window",r=>`${r.window} bars each side`],["Confirmed",r=>time(r.confirmedAt)]]}/>}<dl><div><dt>Source bar</dt><dd>{time(selected.t)}</dd></div><div><dt>Confirmed after close</dt><dd>{time(selected.confirmedAt)}</dd></div><div><dt>Inputs captured by</dt><dd>{selected.knownAt==null?'Capture time unavailable':time(selected.knownAt)}</dd></div>{selected.brokenAt&&<div><dt>First close break</dt><dd>{time(selected.brokenAt)}</dd></div>}{selected.filledAt&&<div><dt>Far edge reached</dt><dd>{time(selected.filledAt)}</dd></div>}</dl>{!readOnly&&onKeep&&<button type="button" className="btn" onClick={keep}>Keep annotation</button>}</div>}
   {notice&&<p role="status">{notice}</p>}<details className="intel-chart-readings"><summary>Method and coverage</summary><p>{result.coverage}</p><p>H/L: first high/low in a continuous segment. HH/HL: higher high/low; LH/LL: lower high/low; EH/EL: equal to the previous confirmed pivot. Distance is (level − last completed close) / Wilder ATR(14), using the latest continuous segment. Positive values are above the last close. A wider window changes sensitivity; it is not a confidence score.</p></details>
  </>}
 </section>
}
