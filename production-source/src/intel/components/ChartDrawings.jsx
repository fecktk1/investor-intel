import React,{useEffect,useReducer,useRef,useState} from 'react'
import {validateDrawing} from '../../../supabase/functions/_shared/intel/chart-workspace-contract'
import {drawingHistory,drawingReducer,drawingGeometry,translateDrawing} from '../lib/chart-drawings'
const tools=[['select','Select / move'],['trendline','Trend line'],['arrow','Arrow'],['horizontal','Horizontal level'],['ray','Ray'],['rectangle','Price zone'],['price_range','Price range'],['fibonacci','Fibonacci'],['text','Text note']]
const countFor=tool=>['horizontal','text'].includes(tool)?1:2
const stamp=t=>Number.isFinite(t)?new Date(t).toISOString().slice(0,23):''
const make=(tool,anchor,end=anchor)=>({id:crypto.randomUUID(),tool,anchors:countFor(tool)===1?[anchor]:[anchor,end],text:'',color:'#DFA647',width:2,...(tool==='fibonacci'?{ratios:[0,0.236,0.382,0.5,0.618,0.786,1]}:{})})
const drawingError=e=>({invalid_drawing_anchor:'Enter a valid date and a price greater than zero for every anchor.',invalid_drawing_style:'Choose a color and a line width from 1 to 5.',invalid_fibonacci_ratios:'Use up to 20 different Fibonacci ratios between -5 and 5.'}[e.message]||e.message)
export function useChartDrawings({project,unproject,width,height,scale,initialItems=[],readOnly=false}) {
 const [history,dispatch]=useReducer(drawingReducer,initialItems,drawingHistory),[tool,setTool]=useState('select'),[selected,setSelected]=useState(null),[preview,setPreview]=useState(null),[editor,setEditor]=useState(null),[error,setError]=useState(null)
 const drag=useRef(null),pendingAnchor=useRef(null),surface=useRef(null),dialog=useRef(null),returnFocus=useRef(null)
 useEffect(()=>{if(editor){returnFocus.current=document.activeElement;if(!dialog.current.open)dialog.current.showModal()}},[!!editor]) // eslint-disable-line react-hooks/exhaustive-deps
 const commit=drawing=>{try{const next=validateDrawing(drawing);if(history.items.length>=200&&!history.items.some(d=>d.id===next.id))throw new Error('A chart supports up to 200 drawings. Remove one before adding another.');dispatch({type:'put',drawing:next});setError(null);return true}catch(e){setError(drawingError(e));return false}}
 const coordinates=event=>{const box=surface.current.getBoundingClientRect();return unproject({x:event.clientX-box.left,y:event.clientY-box.top})}
 const start=(event,drawing=null,anchorIndex=null)=>{
  if(readOnly||event.button!==0)return
  event.stopPropagation();const point=coordinates(event);if(!point)return
  if(drawing){setSelected(drawing.id);drag.current={drawing,anchorIndex,start:point,origin:{x:event.clientX,y:event.clientY}};setPreview(drawing)}
  else if(tool!=='select'){
   const first=pendingAnchor.current||point;const draft=make(tool,first,point)
   drag.current={drawing:draft,new:true,start:first,origin:{x:event.clientX,y:event.clientY},secondTap:!!pendingAnchor.current};setPreview(draft)
  }else{setSelected(null);return}
  surface.current.setPointerCapture(event.pointerId)
 }
 const move=event=>{
  const action=drag.current,point=coordinates(event)
  if(!point)return
  if(!action){if(pendingAnchor.current&&tool!=='select')setPreview(make(tool,pendingAnchor.current,point));return}
  try{
   const drawing=action.new?{...action.drawing,anchors:countFor(action.drawing.tool)===1?[point]:[action.start,point]}:action.anchorIndex!=null?{...action.drawing,anchors:action.drawing.anchors.map((a,i)=>i===action.anchorIndex?point:a)}:translateDrawing(action.drawing,action.start,point,scale)
   setPreview(validateDrawing(drawing));action.current=drawing
  }catch{/* A pointer outside the valid price/time domain leaves the last valid preview. */}
 }
 const finish=event=>{
  const action=drag.current;if(!action)return
  const drawing=action.current||action.drawing,travel=Math.hypot(event.clientX-action.origin.x,event.clientY-action.origin.y)
  drag.current=null;surface.current.releasePointerCapture?.(event.pointerId)
  if(action.new&&countFor(drawing.tool)===2&&travel<4&&!action.secondTap){pendingAnchor.current=action.start;return}
  pendingAnchor.current=null;setPreview(null)
  if(drawing.tool==='text'&&action.new)setEditor(drawing)
  else {commit(drawing);setSelected(drawing.id)}
  if(action.new)setTool('select')
 }
 const cancel=()=>{drag.current=null;pendingAnchor.current=null;setPreview(null);setTool('select')}
 useEffect(()=>{if(tool==='select')return;const escape=e=>{if(e.key==='Escape'){e.preventDefault();cancel()}};document.addEventListener('keydown',escape);return()=>document.removeEventListener('keydown',escape)},[tool])
 const editNew=()=>{const anchor=unproject({x:width/2,y:height/2});if(anchor){const end=unproject({x:width*0.7,y:height*0.4})||anchor;setEditor(make(tool==='select'?'trendline':tool,anchor,end))}}
 const closeEditor=()=>{setEditor(null);setError(null);returnFocus.current?.focus?.()}
 const saveEditor=()=>{try{if(editor.tool==='text'&&!editor.text.trim())throw new Error('Enter the annotation text.');let value=editor;if(editor.tool==='fibonacci'&&typeof editor.ratios==='string'){const parts=editor.ratios.split(',');if(parts.some(s=>!s.trim()))throw new Error('Enter a number for every retracement ratio.');value={...editor,ratios:parts.map(s=>Number(s.trim()))}}const drawing=validateDrawing(value);if(commit(drawing)){setSelected(drawing.id);closeEditor()}}catch(e){setError(drawingError(e))}}
 const selectedDrawing=history.items.find(d=>d.id===selected)
 const rendered=preview?(history.items.some(d=>d.id===preview.id)?history.items.map(d=>d.id===preview.id?preview:d):[...history.items,preview]):history.items
 const controls=<div className="intel-drawing-toolbar" role="group" aria-label="Chart drawings">
  <label>Draw<select value={tool} onChange={e=>{cancel();setTool(e.target.value)}}>{tools.map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
  <button type="button" onClick={editNew}>Add by coordinates</button>
  <button type="button" disabled={!history.past.length} onClick={()=>{cancel();dispatch({type:'undo'})}}>Undo</button>
  <button type="button" disabled={!history.future.length} onClick={()=>{cancel();dispatch({type:'redo'})}}>Redo</button>
  {selectedDrawing&&<><button type="button" onClick={()=>setEditor(selectedDrawing)}>Edit drawing</button><button type="button" onClick={()=>{dispatch({type:'delete',id:selected});setSelected(null)}}>Delete drawing</button></>}
  {history.items.length>0&&<button type="button" onClick={()=>{cancel();dispatch({type:'clear'});setSelected(null)}}>Clear drawings</button>}
  {tool!=='select'&&<span role="status">{countFor(tool)===1?'Tap a position.':'Drag, or tap two positions.'} Escape cancels.</span>}
  {error&&!editor&&<span role="alert">{error}</span>}
 </div>
 const overlay=<svg ref={surface} className="intel-workstation-overlay intel-drawing-surface" width={width} height={height} role="group" aria-label="Saved and unsaved chart drawings" style={{pointerEvents:tool==='select'?'none':'all',touchAction:tool==='select'?'auto':'none'}} onPointerDown={e=>start(e)} onPointerMove={move} onPointerUp={finish} onPointerCancel={cancel} onKeyDown={e=>{if(e.key==='Escape')cancel()}}>
  {rendered.map(drawing=>{
   const geometry=drawingGeometry(drawing,project,width,height);if(!geometry)return null
   const selectedNow=selected===drawing.id
   return <g key={drawing.id} role={readOnly?'img':'button'} tabIndex={readOnly?undefined:0} aria-label={`${tools.find(([key])=>key===drawing.tool)?.[1]}${drawing.text?`: ${drawing.text}`:''}`} onPointerDown={e=>start(e,drawing)} onKeyDown={e=>{if(readOnly)return;if(e.key==='Enter'){e.preventDefault();setSelected(drawing.id);setEditor(drawing)}if(e.key==='Delete'){dispatch({type:'delete',id:drawing.id})}}} style={{pointerEvents:!readOnly&&tool==='select'?'all':'none',cursor:readOnly?'default':'move'}}>
    {geometry.lines.map((line,i)=><g key={`line:${i}`}><line {...line} stroke="transparent" strokeWidth={14}/><line {...line} stroke={drawing.color} strokeWidth={drawing.width}/></g>)}
    {geometry.rectangles.map((rect,i)=><rect key={`rect:${i}`} {...rect} fill={`${drawing.color}12`} stroke={drawing.color} strokeWidth={drawing.width}/>)}
    {geometry.labels.map((label,i)=><text key={`label:${i}`} x={label.x} y={label.y} fill={drawing.color} fontFamily="Inter, sans-serif" fontSize={12}>{label.text.split('\n').slice(0,drawing.tool==='text'?3:1).map((line,j)=><tspan key={j} x={label.x} dy={j?15:0}>{line.slice(0,100)}</tspan>)}</text>)}
    {selectedNow&&geometry.anchors.map((anchor,i)=><circle key={`anchor:${i}`} cx={anchor.x} cy={anchor.y} r={6} fill="var(--bg-1)" stroke={drawing.color} strokeWidth={2} onPointerDown={e=>start(e,drawing,i)}/>)}
   </g>
  })}
 </svg>
 const editorView=editor&&<dialog ref={dialog} className="intel-chart-study-dialog" aria-labelledby="chart-drawing-title" onCancel={e=>{e.preventDefault();closeEditor()}}>
  <div className="intel-investigation-analysis-heading"><h2 id="chart-drawing-title">Drawing coordinates and notes</h2><button type="button" onClick={closeEditor}>Close</button></div>
  <label>Tool<select value={editor.tool} onChange={e=>{const next=e.target.value;setEditor(d=>({...d,tool:next,anchors:countFor(next)===1?[d.anchors[0]]:[d.anchors[0],d.anchors[1]||d.anchors[0]],...(next==='fibonacci'&&!d.ratios?{ratios:[0,0.236,0.382,0.5,0.618,0.786,1]}:{})}))}}>{tools.filter(([key])=>key!=='select').map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
  {editor.anchors.map((anchor,i)=><div key={i} className="intel-drawing-anchor-fields"><label>Anchor {i+1} time (UTC)<input type="datetime-local" step="0.001" value={stamp(anchor.t)} onChange={e=>setEditor(d=>({...d,anchors:d.anchors.map((a,j)=>j===i?{...a,t:Date.parse(`${e.target.value}Z`)}:a)}))}/></label><label>Anchor {i+1} price<input type="number" min="0" step="any" value={Number.isFinite(anchor.price)?anchor.price:''} onChange={e=>setEditor(d=>({...d,anchors:d.anchors.map((a,j)=>j===i?{...a,price:Number(e.target.value)}:a)}))}/></label></div>)}
  <label>Your annotation<textarea className="textarea" rows={3} maxLength={2000} value={editor.text} onChange={e=>setEditor(d=>({...d,text:e.target.value}))}/></label>
  {editor.tool==='fibonacci'&&<label>Retracement ratios, separated by commas<input value={Array.isArray(editor.ratios)?editor.ratios.join(', '):editor.ratios||''} onChange={e=>setEditor(d=>({...d,ratios:e.target.value}))}/></label>}
  <div className="intel-study-parameters"><label>Color<input type="color" value={editor.color} onChange={e=>setEditor(d=>({...d,color:e.target.value}))}/></label><label>Line width<input type="number" min="1" max="5" value={editor.width} onChange={e=>setEditor(d=>({...d,width:Number(e.target.value)}))}/></label></div>
  {error&&<p role="alert">{error}</p>}<button className="btn btn--primary" type="button" onClick={saveEditor}>Apply drawing</button>
  <p className="intel-analysis-caption">Coordinates stay attached to their time and price when you resize or zoom. Save the layout to keep them across visits.</p>
 </dialog>
 const list=history.items.length>0&&<details className="intel-chart-readings"><summary>Read and edit {history.items.length} drawings</summary><ul className="intel-study-list">{history.items.map(d=><li key={d.id}><span>{tools.find(([key])=>key===d.tool)?.[1]} · {d.text||d.anchors.map(a=>`${new Date(a.t).toISOString()} · ${a.price}`).join(' → ')}</span>{!readOnly&&<button type="button" onClick={()=>setEditor(d)}>Edit</button>}</li>)}</ul></details>
 return {items:history.items,add:drawing=>readOnly?false:commit(drawing),reset:items=>{cancel();setSelected(null);dispatch({type:'reset',items})},controls,overlay,editor:editorView,list,error}
}
