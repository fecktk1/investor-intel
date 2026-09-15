import React,{useEffect,useRef,useState} from 'react'
import {requestChartWorkspace,saveChartLayout} from '../lib/chart-workspace-api'
export default function ChartLayoutLibrary({context,capture,onLoad,onStudies,disabled=false,comparisons=false,canSave=true,restoredLayout=null}) {
 const [open,setOpen]=useState(false),[rows,setRows]=useState([]),[page,setPage]=useState(0),[hasMore,setHasMore]=useState(false),[allAssets,setAllAssets]=useState(false)
 const [templates,setTemplates]=useState(false)
 const [selected,setSelected]=useState(null),[renaming,setRenaming]=useState(false),[title,setTitle]=useState('Research layout'),[busy,setBusy]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState(null),[notice,setNotice]=useState(null)
 const dialog=useRef(null),trigger=useRef(null),operation=useRef(null),generation=useRef(0),alive=useRef(true)
 const scope=`${context?.userId}:${context?.orgId}:${context?.asset}`,active=useRef(scope);active.current=scope
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++}},[])
 useEffect(()=>{if(restoredLayout){setSelected(restoredLayout);setTitle(restoredLayout.title);setRenaming(false)}},[restoredLayout])
 const current=()=>alive.current&&active.current===scope
 const load=async()=>{
  const request=++generation.current;setLoading(true);setError(null)
  try{const result=await requestChartWorkspace(context,{operation:'list',page,...(comparisons?{comparisons:true}:templates?{templates:true}:!allAssets?{asset:context.asset}:{})});if(current()&&request===generation.current){setRows(result.layouts);setHasMore(result.hasMore)}}
  catch(e){if(current()&&request===generation.current)setError(e.message)}finally{if(current()&&request===generation.current)setLoading(false)}
 }
 useEffect(()=>{if(open){dialog.current?.showModal();void load()}},[open,page,allAssets,templates]) // eslint-disable-line react-hooks/exhaustive-deps
 const close=()=>{setOpen(false);generation.current++;trigger.current?.focus()}
 const perform=async work=>{setBusy(true);setError(null);setNotice(null);try{await work()}catch(e){if(current())setError(e.message)}finally{if(current())setBusy(false)}}
 const save=asNew=>perform(async()=>{
  const captured=renaming?selected.state:capture(),layout=!renaming&&templates?{...captured,purpose:'study_template',comparison:undefined,replay:undefined,drawings:[],visibility:{}}:captured,id=asNew?null:selected?.id||null,revision=asNew?0:selected?.revision||0
  if(templates&&!layout.studies.length)throw new Error('Add at least one indicator before saving an indicator template.')
  const signature=JSON.stringify({id,revision,title,layout})
  if(operation.current?.signature!==signature)operation.current={signature,id:crypto.randomUUID()}
  const result=await saveChartLayout(context,{id,revision,title,layout,operationId:operation.current.id})
  if(!current())return
  if(renaming){setSelected(null);setTitle('Research layout');setRenaming(false)}else setSelected({...result,state:layout,title})
  operation.current=null;setNotice(`Layout saved privately. Revision ${result.revision}.`);await load()
 })
 const readLayout=async row=>(await requestChartWorkspace(context,{operation:'get',id:row.id})).layout
 const openLayout=row=>perform(async()=>{const full=await readLayout(row);if(!current())return;await onLoad(full.state,full);if(!current())return;setSelected(full);setRenaming(false);setTitle(full.title);setNotice(`Opened ${full.title}.`);close()})
 const remove=row=>perform(async()=>{await requestChartWorkspace(context,{operation:'delete',id:row.id,revision:row.revision});if(!current())return;if(selected?.id===row.id){setSelected(null);setTitle('Research layout')}setNotice(`Deleted ${row.title}.`);await load()})
 const start=(template,opener)=>{trigger.current=opener;if(template!==templates){setSelected(null);setRenaming(false);setTitle(template?'My indicator template':'Research layout');operation.current=null}setTemplates(template);setPage(0);setRows([]);setNotice(null);setError(null);setOpen(true)}
 return <><button type="button" onClick={e=>start(false,e.currentTarget)} disabled={disabled||!context?.userId}>{comparisons&&!canSave?'Open saved comparison':'Save layout'}</button>{onStudies&&<button type="button" onClick={e=>start(true,e.currentTarget)} disabled={disabled||!context?.userId}>Indicator templates</button>}
  {open&&<dialog ref={dialog} className="intel-chart-study-dialog intel-layout-library" aria-labelledby="chart-layout-library-title" onCancel={e=>{e.preventDefault();close()}}>
   <div className="intel-investigation-analysis-heading"><h2 id="chart-layout-library-title">{comparisons?'Your saved comparisons':templates?'Your indicator templates':'Your chart layouts'}</h2><button type="button" onClick={close}>Close</button></div>
   <p className="intel-analysis-caption">{templates?'Name the current indicators and their parameters, then apply them to another chart. Drawings and portfolio context stay with their original asset.':'Save your indicators, view and drawings privately. Saving a layout does not publish research or alter your portfolio.'}</p>
   {(canSave||renaming)&&<><label>{templates?'Template name':'Layout name'}<input maxLength={120} value={title} onChange={e=>setTitle(e.target.value)}/></label>
   <div className="intel-investigation-controls"><button className="btn btn--primary" type="button" disabled={busy||!title.trim()} onClick={()=>save(false)}>{renaming?'Save name':selected?'Save changes':templates?'Save indicator template':'Save new layout'}</button>{selected&&!renaming&&<button className="btn" type="button" disabled={busy||!title.trim()} onClick={()=>save(true)}>Save as new</button>}</div>
   </>}
   {error&&<p role="alert">{error} <button type="button" className="intel-text-link" onClick={load}>Retry</button></p>}{notice&&<p role="status">{notice}</p>}
   {!templates&&!comparisons&&<label className="intel-workstation-check"><input type="checkbox" checked={allAssets} onChange={e=>{setAllAssets(e.target.checked);setPage(0)}}/>Show layouts for every asset</label>}
   {loading?<p role="status">{templates?'Loading indicator templates…':'Loading layouts…'}</p>:rows.length===0?<p className="intel-analysis-caption">{templates?'No saved indicator templates yet.':'No saved layouts in this view.'}</p>:<ul className="intel-layout-list">{rows.map(row=><li key={row.id}><div><strong>{row.title}</strong><p>{row.purpose==='study_template'?'Indicator template':row.asset} · revision {row.revision}</p></div><div className="intel-layout-actions">
    {!templates&&row.purpose!=='study_template'&&(comparisons||row.asset===context.asset)&&<button type="button" disabled={busy} onClick={()=>openLayout(row)}>Open</button>}
    {onStudies&&<button type="button" disabled={busy} onClick={()=>perform(async()=>{const full=await readLayout(row);if(current()){onStudies(full.state.studies);setNotice(`Applied indicators from ${full.title}.`)}})}>Apply indicators</button>}
    <button type="button" disabled={busy} onClick={()=>perform(async()=>{const full=await readLayout(row);if(current()){setSelected(full);setTitle(full.title);setRenaming(true);setNotice('Edit the layout name, then save it. Drawings and indicators stay as saved.')}})}>Rename</button>
    <button type="button" disabled={busy} onClick={()=>perform(async()=>{const full=await readLayout(row);if(!current())return;const signature=`duplicate:${full.id}:${full.revision}`;if(operation.current?.signature!==signature)operation.current={signature,id:crypto.randomUUID()};const result=await saveChartLayout(context,{operationId:operation.current.id,title:`${full.title.slice(0,110)} copy`,layout:full.state});if(current()){operation.current=null;setNotice(`Duplicated ${full.title}. Revision ${result.revision}.`);await load()}})}>Duplicate</button>
    <button type="button" disabled={busy} aria-label={`Delete layout ${row.title}`} onClick={()=>remove(row)}>Delete</button>
   </div></li>)}</ul>}
   <div className="intel-chart-navigation"><button type="button" disabled={busy||loading||page===0} onClick={()=>setPage(p=>p-1)}>Previous</button><span>Page {page+1}</span><button type="button" disabled={busy||loading||!hasMore} onClick={()=>setPage(p=>p+1)}>Next</button></div>
  </dialog>}
 </>
}
