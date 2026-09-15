import React,{useEffect,useRef,useState} from 'react'
import {ResponsiveContainer,LineChart,Line,XAxis,YAxis,CartesianGrid,Tooltip} from 'recharts'
import {InvestigationTable,time,value} from './InvestigationTable'
export default function BenchmarkComparison({comparison,onSelect,onPrepareReceipt}){
 const [selected,setSelected]=useState(null),[source,setSource]=useState(null)
 const sourcePane=useRef(null)
 useEffect(()=>{if(!source)return;const previous=document.activeElement;sourcePane.current?.focus();const escape=e=>{if(e.key==='Escape')setSource(null)};document.addEventListener('keydown',escape);return()=>{document.removeEventListener('keydown',escape);previous?.focus?.()}},[source])
 const rows=comparison.rows,focused=rows.find(r=>r.t===selected)||rows.at(-1)
 const sources=[...new Map(rows.flatMap(r=>[r.asset,r.benchmark].filter(Boolean)).map(o=>[o.id,o])).values()]
 const select=o=>onSelect?onSelect(o):setSource(o)
 const chartRows=rows.flatMap((r,i)=>i&&r.t-rows[i-1].t>36*3600000?[{t:rows[i-1].t+86400000,assetReturn:null,benchmarkReturn:null},r]:[r])
 return <><p className="intel-analysis-caption">{comparison.note}</p><p>{comparison.pairedCount} matching observations · {comparison.missingCount} gaps. {comparison.status==='zero_baseline'?'A zero starting value has no return denominator.':comparison.status==='insufficient_matching_times'?'At least two matching observations are needed.':''}</p>
  {comparison.status==='comparable'&&<>
   <ResponsiveContainer width="100%" height={220}><LineChart data={chartRows} margin={{top:8,right:12,left:0,bottom:0}} onMouseMove={e=>{if(rows.some(r=>r.t===Number(e?.activeLabel)))setSelected(Number(e.activeLabel))}}>
    <CartesianGrid stroke="var(--border-default)" vertical={false}/><XAxis type="number" scale="time" dataKey="t" domain={['dataMin','dataMax']} tickFormatter={v=>new Date(v).toISOString().slice(5,10)} axisLine={false} tickLine={false}/><YAxis tickFormatter={v=>`${Number(v).toFixed(1)}%`} axisLine={false} tickLine={false}/><Tooltip content={()=>null}/>
    <Line dataKey="assetReturn" name="Asset price change" stroke="var(--accent)" type="linear" dot={false} connectNulls={false} isAnimationActive={false}/><Line dataKey="benchmarkReturn" name={comparison.label} stroke="var(--signal-blue)" type="linear" dot={false} connectNulls={false} isAnimationActive={false}/>
   </LineChart></ResponsiveContainer>
   <label>Benchmark observation<input type="range" min="0" max={rows.length-1} value={Math.max(0,rows.indexOf(focused))} aria-valuetext={focused?time(focused.t):''} onChange={e=>setSelected(rows[Number(e.target.value)].t)}/></label>
   {focused&&<p>{time(focused.t)} · Asset price change {value(focused.assetReturn)}% · {comparison.label} {value(focused.benchmarkReturn)}% · Difference {value(focused.difference)} percentage points.</p>}
  </>}
  <InvestigationTable pageSize={5} rows={rows} caption={`Asset and ${comparison.label} at identical reported times`} columns={[
   ['Observed (UTC)',r=>time(r.t)],['Asset price (USD)',r=>r.asset?<button className="intel-text-link" onClick={()=>select(r.asset)}>{value(r.asset.value)}</button>:'No matching observation'],['Index points',r=>r.benchmark?<button className="intel-text-link" onClick={()=>select(r.benchmark)}>{value(r.benchmark.value)}</button>:'No matching observation'],['Price change',r=>r.assetReturn==null?'—':`${value(r.assetReturn)}%`],['Index change',r=>r.benchmarkReturn==null?'—':`${value(r.benchmarkReturn)}%`],['Known (UTC)',r=>`${time(r.asset?.recordedAt)} / ${time(r.benchmark?.recordedAt)}`],
  ]}/>
  {onPrepareReceipt&&<button className="btn" disabled={!sources.length} onClick={()=>onPrepareReceipt(sources)}>Keep this comparison's source references</button>}
  {source&&<aside ref={sourcePane} tabIndex={-1} className="intel-source-record" aria-label="Original benchmark source"><button className="intel-text-link" onClick={()=>setSource(null)}>Close source</button><p>{source.value} {source.unit} · {source.subject}</p><p>Observed {time(source.observedAt)}; recorded {time(source.recordedAt)}</p><p className="break-all">{source.sourceRef}</p><p className="break-all">{source.id}</p></aside>}
 </>
}
