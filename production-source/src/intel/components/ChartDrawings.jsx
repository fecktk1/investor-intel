import React,{useEffect,useReducer,useRef,useState} from 'react'
import {useTranslation} from 'react-i18next'
import {validateDrawing,drawingAnchorCount} from '../../../supabase/functions/_shared/intel/chart-workspace-contract'
import {drawingHistory,drawingReducer,translateDrawing} from '../lib/chart-drawings'
import {DRAWING_TOOLBAR,drawingShortcutTool,drawingToolLabel} from '../lib/chart-drawing-tools'
import {resolveAnchor} from '../lib/chart-drawing-snap'
import ChartDrawingToolbar from './ChartDrawingToolbar'
import deferredPanel from './deferred-panel'

// Deferred so the price chart's first paint carries the toolbar strip and the
// chart. The surface is an overlay on top of the plot, so nothing shifts when it
// arrives; the editor opens only when a member edits a drawing by hand.
const DrawingSurface=deferredPanel(()=>import('./ChartDrawingSurface'),{label:'The chart drawing surface'})
const DrawingEditor=deferredPanel(()=>import('./ChartDrawingEditor'),{label:'The drawing editor'})

const DRAWABLE=DRAWING_TOOLBAR.filter(entry=>!entry.toggle&&entry.id!=='select').map(entry=>entry.id)
const countFor=drawingAnchorCount
const FIB=[0,0.236,0.382,0.5,0.618,0.786,1]
const make=(tool,anchor,end=anchor)=>{
 const count=countFor(tool)
 return {id:crypto.randomUUID(),tool,anchors:count===1?[anchor]:count===3?[anchor,end,end]:[anchor,end],text:'',color:'#DFA647',width:2,
  ...(tool==='fibonacci'?{ratios:FIB}:{}),...(tool==='tweet'?{url:''}:{})}
}
const drawingError=(t,e)=>({
 invalid_drawing:t('chart.draw.error_drawing',{defaultValue:'This drawing is incomplete. Place every anchor before saving it.'}),
 invalid_drawing_anchor:t('chart.draw.error_anchor',{defaultValue:'Enter a valid date and a price greater than zero for every anchor.'}),
 invalid_drawing_style:t('chart.draw.error_style',{defaultValue:'Choose a color, a line width from 1 to 5 and a line style.'}),
 invalid_fibonacci_ratios:t('chart.draw.error_ratios',{defaultValue:'Use up to 20 different Fibonacci ratios between -5 and 5.'}),
 invalid_tweet_url:t('chart.draw.error_url',{defaultValue:'Paste the address of a public post on x.com, for example https://x.com/name/status/1234567890.'}),
 drawing_limit:t('chart.draw.error_limit',{defaultValue:'A chart supports up to 200 drawings. Remove one before adding another.'}),
 empty_text:t('chart.draw.error_text',{defaultValue:'Enter the annotation text.'}),
 empty_ratio:t('chart.draw.error_ratio_blank',{defaultValue:'Enter a number for every retracement ratio.'}),
}[e.message]||e.message)

// The live drawing under the pointer lives outside React state, so a pointer move
// re-renders only the drawing surface instead of the whole price workstation.
function previewStore() {
 let value=null
 const listeners=new Set()
 return {get:()=>value,set:next=>{if(next===value)return;value=next;for(const listener of listeners)listener()},subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener)}}
}

export function useChartDrawings({project,unproject,width,height,scale,initialItems=[],readOnly=false,bars=[],intervalMs=null,context=null}) {
 const {t}=useTranslation('intel',{useSuspense:false})
 const [history,dispatch]=useReducer(drawingReducer,initialItems,drawingHistory)
 const [tool,setToolState]=useState('select'),[selected,setSelected]=useState(null),[editor,setEditor]=useState(null),[error,setError]=useState(null)
 const [lock,setLock]=useState(false),[magnet,setMagnet]=useState(false),[crosshair,setCrosshair]=useState(true)
 const store=useRef(null);if(!store.current)store.current=previewStore()
 const preview=store.current
 const drag=useRef(null),pending=useRef(null),pendingThird=useRef(null),surface=useRef(null),returnFocus=useRef(null)
 useEffect(()=>{if(editor)returnFocus.current=document.activeElement},[!!editor]) // eslint-disable-line react-hooks/exhaustive-deps
 const commit=drawing=>{
  try{
   const next=validateDrawing(drawing)
   if(history.items.length>=200&&!history.items.some(d=>d.id===next.id))throw new Error('drawing_limit')
   dispatch({type:'put',drawing:next});setError(null);return true
  }catch(e){setError(drawingError(t,e));return false}
 }
 // Every anchor is read through the chart's own coordinate conversion, so it stays
 // on its time and price when the chart scrolls, zooms, resizes or goes fullscreen.
 const anchorAt=event=>{
  if(!surface.current)return null
  const box=surface.current.getBoundingClientRect(),point={x:event.clientX-box.left,y:event.clientY-box.top}
  const raw=unproject(point)
  return raw?{point,anchor:resolveAnchor(raw,point,{bars,intervalMs,magnet,project})}:null
 }
 const release=event=>{if(!lock&&!event?.shiftKey)setToolState('select')}
 const cancel=()=>{drag.current=null;pending.current=null;pendingThird.current=null;preview.set(null);setToolState('select')}
 const setTool=next=>{drag.current=null;pending.current=null;pendingThird.current=null;preview.set(null);setToolState(next)}
 const start=(event,drawing=null,anchorIndex=null)=>{
  if(readOnly||event.button!==0)return
  event.stopPropagation()
  const resolved=anchorAt(event);if(!resolved)return
  const {anchor}=resolved
  if(drawing){setSelected(drawing.id);drag.current={drawing,anchorIndex,start:anchor,origin:{x:event.clientX,y:event.clientY}};preview.set(drawing)}
  else if(pendingThird.current){
   const draft={...pendingThird.current,anchors:[...pendingThird.current.anchors.slice(0,2),anchor]}
   pendingThird.current=null;preview.set(null)
   if(commit(draft))setSelected(draft.id)
   release(event);return
  }
  else if(tool!=='select'){
   const held=pending.current
   const draft=held?{...held.drawing,anchors:countFor(held.drawing.tool)===3?[held.start,anchor,anchor]:[held.start,anchor]}:make(tool,anchor)
   drag.current={drawing:draft,new:true,start:held?held.start:anchor,origin:{x:event.clientX,y:event.clientY},secondTap:!!held}
   preview.set(draft)
  }else{setSelected(null);return}
  surface.current.setPointerCapture?.(event.pointerId)
 }
 const move=event=>{
  const action=drag.current,resolved=anchorAt(event)
  if(!resolved)return
  const {anchor}=resolved
  if(!action){
   if(pendingThird.current)preview.set({...pendingThird.current,anchors:[...pendingThird.current.anchors.slice(0,2),anchor]})
   else if(pending.current)preview.set({...pending.current.drawing,anchors:countFor(pending.current.drawing.tool)===3?[pending.current.start,anchor,anchor]:[pending.current.start,anchor]})
   return
  }
  try{
   const count=countFor(action.drawing.tool)
   const drawing=action.new
    ?{...action.drawing,anchors:count===1?[anchor]:count===3?[action.start,anchor,anchor]:[action.start,anchor]}
    :action.anchorIndex!=null?{...action.drawing,anchors:action.drawing.anchors.map((a,i)=>i===action.anchorIndex?anchor:a)}
    :translateDrawing(action.drawing,action.start,anchor,scale)
   preview.set(drawing.tool==='tweet'?drawing:validateDrawing(drawing));action.current=drawing
  }catch{/* A pointer outside the valid price/time domain leaves the last valid preview. */}
 }
 const finish=event=>{
  const action=drag.current;if(!action)return
  const drawing=action.current||action.drawing,count=countFor(drawing.tool)
  const travel=Math.hypot(event.clientX-action.origin.x,event.clientY-action.origin.y)
  drag.current=null;surface.current.releasePointerCapture?.(event.pointerId)
  if(action.new&&count>=2&&travel<4&&!action.secondTap){pending.current={drawing,start:action.start};preview.set(drawing);return}
  pending.current=null
  if(action.new&&count===3){pendingThird.current=drawing;preview.set(drawing);return}
  preview.set(null)
  if(action.new&&(drawing.tool==='text'||drawing.tool==='tweet'))setEditor(drawing)
  else{commit(drawing);setSelected(drawing.id)}
  if(action.new)release(event)
 }
 const remove=id=>{dispatch({type:'delete',id});setSelected(current=>current===id?null:current)}
 const restyle=patch=>{const drawing=history.items.find(d=>d.id===selected);if(drawing)commit({...drawing,...patch})}
 useEffect(()=>{
  if(readOnly)return
  const key=event=>{
   const target=event.target
   if(target?.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName||''))return
   if(event.key==='Escape'){cancel();return}
   if((event.key==='Delete'||event.key==='Backspace')&&selected&&!editor){event.preventDefault();remove(selected);return}
   const next=drawingShortcutTool(event)
   if(!next)return
   event.preventDefault()
   if(next==='crosshair')setCrosshair(value=>!value)
   else setTool(next)
  }
  document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key)
 }) // eslint-disable-line react-hooks/exhaustive-deps
 const editNew=()=>{
  const anchor=unproject({x:width/2,y:height/2})
  if(!anchor)return
  const end=unproject({x:width*0.7,y:height*0.4})||anchor
  setEditor(make(DRAWABLE.includes(tool)?tool:'trendline',anchor,end))
 }
 const closeEditor=()=>{setEditor(null);setError(null);returnFocus.current?.focus?.()}
 const saveEditor=()=>{
  try{
   if(editor.tool==='text'&&!editor.text.trim())throw new Error('empty_text')
   let value=editor
   if(editor.tool==='fibonacci'&&typeof editor.ratios==='string'){
    const parts=editor.ratios.split(',')
    if(parts.some(part=>!part.trim()))throw new Error('empty_ratio')
    value={...editor,ratios:parts.map(part=>Number(part.trim()))}
   }
   const drawing=validateDrawing(value)
   if(commit(drawing)){setSelected(drawing.id);closeEditor()}
  }catch(e){setError(drawingError(t,e))}
 }
 const selectedDrawing=history.items.find(d=>d.id===selected)
 const hint=error&&!editor?error:tool==='select'?null
  :pendingThird.current?t('chart.draw.hint_third',{defaultValue:'Set the channel width, then press to keep it. Escape cancels.'})
  :countFor(tool)===1?t('chart.draw.hint_one',{defaultValue:'Press a position on the chart. Escape cancels.'})
  :t('chart.draw.hint_two',{defaultValue:'Drag, or press two positions. Escape cancels.'})
 const toolbar=!readOnly&&<ChartDrawingToolbar tool={tool} crosshair={crosshair} lock={lock} magnet={magnet} hint={hint}
  canUndo={!!history.past.length} canRedo={!!history.future.length} canClear={!!history.items.length} canDelete={!!selectedDrawing}
  onTool={setTool} onCrosshair={()=>setCrosshair(value=>!value)} onLock={()=>setLock(value=>!value)} onMagnet={()=>setMagnet(value=>!value)}
  onCoordinates={editNew} onUndo={()=>{setTool('select');dispatch({type:'undo'})}} onRedo={()=>{setTool('select');dispatch({type:'redo'})}}
  onDelete={()=>selected&&remove(selected)} onClear={()=>{setTool('select');dispatch({type:'clear'});setSelected(null)}}/>
 const overlay=<DrawingSurface store={preview} surfaceRef={surface} items={history.items} selected={selected} tool={tool} readOnly={readOnly} width={width} height={height}
  project={project} intervalMs={intervalMs} context={context} onStart={start} onMove={move} onFinish={finish} onCancel={cancel}
  onEdit={setEditor} onDelete={remove} onSelect={setSelected} onStyle={restyle}/>
 const editorView=editor&&<DrawingEditor editor={editor} tools={DRAWABLE} error={error} onChange={setEditor} onClose={closeEditor} onApply={saveEditor}/>
 const list=history.items.length>0&&<details className="intel-chart-readings"><summary>{t('chart.draw.read_list',{defaultValue:'Read and edit {{count}} drawings',count:history.items.length})}</summary>
  <ul className="intel-study-list">{history.items.map(drawing=><li key={drawing.id}>
   <span>{drawingToolLabel(t,drawing.tool)} · {drawing.text||drawing.url||drawing.anchors.map(a=>`${new Date(a.t).toISOString()} · ${a.price}`).join(' → ')}</span>
   {!readOnly&&<button type="button" onClick={()=>setEditor(drawing)}>{t('chart.draw.edit_short',{defaultValue:'Edit'})}</button>}
  </li>)}</ul></details>
 return {items:history.items,add:drawing=>readOnly?false:commit(drawing),reset:items=>{cancel();setSelected(null);dispatch({type:'reset',items})},
  // The toolbar now runs along the top edge of the plot; the price workstation's
  // display-controls row keeps no drawing controls of its own.
  controls:null,toolbar,overlay,editor:editorView,list,error,crosshair,selected:selectedDrawing?.id??null}
}
