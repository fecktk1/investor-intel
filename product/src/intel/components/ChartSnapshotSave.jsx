import React,{useEffect,useRef,useState} from 'react'
import {Link} from 'react-router'
import {requestChartWorkspace} from '../lib/chart-workspace-api'
export default function ChartSnapshotSave({context,captureLayout,seriesCapture}) {
 const [preview,setPreview]=useState(null),[title,setTitle]=useState('Chart research'),[selected,setSelected]=useState([]),[busy,setBusy]=useState(false),[error,setError]=useState(null),[saved,setSaved]=useState(null)
 const dialog=useRef(null),trigger=useRef(null),operation=useRef(null),alive=useRef(true),generation=useRef(0)
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
 useEffect(()=>{if(preview)dialog.current?.showModal()},[!!preview]) // eslint-disable-line
 const close=()=>{generation.current++;setBusy(false);setPreview(null);trigger.current?.focus()}
 const open=()=>{try{setPreview({layout:captureLayout(),capture:seriesCapture});setSelected([]);setError(null);setSaved(null)}catch(e){setError(e.message==='invalid_chart_asset'?`This chart cannot save the asset identity “${context?.asset||'unresolved'}”.`:e.message)}}
 const verified=preview?.layout.comparison?preview.capture?.series?.length===preview.layout.comparison.assets.length&&preview.capture.series.every((c,i)=>c.proof&&c.asset===preview.layout.comparison.assets[i].asset):!!preview?.capture?.proof
 const save=async()=>{
  const current=++generation.current
  const body={operation:'snapshot_save',title,layout:preview.layout,capture:preview.capture,includeDrawingIds:selected}
  const signature=JSON.stringify(body);if(operation.current?.signature!==signature)operation.current={signature,id:crypto.randomUUID()}
  setBusy(true);setError(null)
  try{const result=await requestChartWorkspace(context,{...body,operationId:operation.current.id});if(alive.current&&current===generation.current){setSaved(result.id);operation.current=null}}catch(e){if(alive.current&&current===generation.current)setError(e.message)}finally{if(alive.current&&current===generation.current)setBusy(false)}
 }
 return <><button type="button" ref={trigger} onClick={open}>Save snapshot</button>{error&&!preview&&<span role="alert">{error}</span>}
 {preview&&<dialog ref={dialog} className="intel-chart-study-dialog" aria-labelledby="chart-snapshot-save-title" onCancel={e=>{e.preventDefault();close()}}>
  <div className="intel-investigation-analysis-heading"><h2 id="chart-snapshot-save-title">Preview your snapshot</h2><button type="button" onClick={close}>Close</button></div>
  <p className="intel-analysis-caption">A snapshot preserves one version of your chart in Saved Research. Sharing is a separate action.</p>
  <label>Snapshot title<input maxLength={120} value={title} disabled={busy||!!saved} onChange={e=>setTitle(e.target.value)}/></label>
  <dl className="intel-event-facts"><dt>Asset</dt><dd>{preview.layout.asset}</dd><dt>Visible period (UTC)</dt><dd><div>{new Date(preview.layout.range.from).toISOString()}</div><div>to {new Date(preview.layout.range.to).toISOString()}</div></dd><dt>Studies</dt><dd>{preview.layout.studies.length}</dd><dt>Portfolio and trade history</dt><dd>Excluded</dd></dl>
  {preview.layout.replay&&<p className="intel-analysis-caption">Replay checkpoint through {new Date(preview.layout.replay.at).toISOString()}. {preview.layout.replay.knownOnly?'Only candles recorded by that time will be retained.':'Later source corrections may be present.'} Future candles and undated drawings are excluded. Saving now does not backdate the research.</p>}
  {!preview.layout.replay&&<fieldset className="intel-snapshot-annotations"><legend>Choose drawings and notes to include</legend>{preview.layout.drawings.length===0?<p>No drawings on this chart.</p>:preview.layout.drawings.map(d=><label key={d.id}><input type="checkbox" disabled={busy||!!saved} checked={selected.includes(d.id)} onChange={e=>setSelected(ids=>e.target.checked?[...ids,d.id]:ids.filter(id=>id!==d.id))}/><span>{d.tool.replaceAll('_',' ')} · {d.text||d.anchors.map(a=>`${new Date(a.t).toISOString()} · ${a.price}`).join(' → ')}</span></label>)}</fieldset>}
  {preview.layout.comparison&&<div className="intel-compare-readings" tabIndex={0} role="region" aria-label="Comparison capture preview"><table><thead><tr><th>Asset</th><th>Original observations</th><th>Capture</th></tr></thead><tbody>{preview.layout.comparison.assets.map((a,i)=><tr key={a.asset}><th scope="row">{a.label}<small>{a.asset}</small></th><td>{preview.capture?.series?.[i]?.bars?.length??0}</td><td>{preview.capture?.series?.[i]?.proof?'Ready for source verification':'Refresh this asset before saving'}</td></tr>)}</tbody></table></div>}
  {!verified&&<p role="status">A price response has no verified capture. Refresh the comparison or asset chart before saving.</p>}
  <p className="intel-analysis-caption">Price retention depends on source permissions. Where unavailable, the snapshot keeps its source references and fingerprint with a gap notice.</p>
  {error&&<p role="alert">{error}</p>}{saved?<p role="status">Snapshot saved privately. <Link className="intel-text-link" to={`/intel/chart-snapshots/${saved}`}>Open snapshot</Link></p>:<button type="button" className="btn btn--primary" disabled={busy||!title.trim()||!verified} onClick={save}>{busy?'Saving snapshot…':'Save private snapshot'}</button>}
 </dialog>}</>
}
