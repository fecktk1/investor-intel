import React,{useEffect,useReducer,useRef,useState,useSyncExternalStore} from 'react'
import {useTranslation} from 'react-i18next'
import {validateDrawing,drawingAnchorCount,DRAWING_DASHES} from '../../../supabase/functions/_shared/intel/chart-workspace-contract'
import {drawingHistory,drawingReducer,drawingGeometry,translateDrawing} from '../lib/chart-drawings'
import {DRAWING_TOOLBAR,DRAWING_COLORS,DRAWING_DASH_PATTERN,drawingShortcutTool,drawingToolLabel} from '../lib/chart-drawing-tools'
import {resolveAnchor} from '../lib/chart-drawing-snap'
import ChartDrawingToolbar from './ChartDrawingToolbar'
import ChartTweetCard from './ChartTweetCard'

const DRAWABLE=DRAWING_TOOLBAR.filter(entry=>!entry.toggle&&entry.id!=='select').map(entry=>entry.id)
const countFor=drawingAnchorCount
const stamp=t=>Number.isFinite(t)?new Date(t).toISOString().slice(0,23):''
const number=value=>Number(value).toLocaleString(undefined,{maximumFractionDigits:8})
const signed=value=>`${value>=0?'+':''}${number(value)}`
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

function DrawingOptions({drawing,point,width,height,onChange,onEdit,onDelete}) {
 const {t}=useTranslation('intel',{useSuspense:false})
 // Placed from the chart's own coordinate conversion, then clamped to whatever
 // the plot currently measures, so it stays reachable when the chart is expanded.
 const left=Math.max(34,Math.min(Math.max(34,width-250),point.x-40))
 const top=Math.max(4,Math.min(Math.max(4,height-40),point.y+16))
 return <div className="intel-draw-options" role="group" aria-label={t('chart.draw.options',{defaultValue:'Drawing style'})} style={{left,top}}>
  <span className="intel-draw-swatches">{DRAWING_COLORS.map(color=><button key={color} type="button" className="intel-draw-swatch" style={{background:color}}
   aria-pressed={drawing.color.toLowerCase()===color.toLowerCase()} aria-label={t('chart.draw.color_value',{defaultValue:'Color {{color}}',color})} onClick={()=>onChange({color})}/>)}</span>
  <label>{t('chart.draw.width',{defaultValue:'Width'})}<select value={drawing.width} onChange={event=>onChange({width:Number(event.target.value)})}>{[1,2,3,4,5].map(value=><option key={value} value={value}>{value}</option>)}</select></label>
  <label>{t('chart.draw.dash',{defaultValue:'Line'})}<select value={drawing.dash||'solid'} onChange={event=>onChange({dash:event.target.value})}>
   <option value="solid">{t('chart.draw.dash_solid',{defaultValue:'Solid'})}</option>
   <option value="dashed">{t('chart.draw.dash_dashed',{defaultValue:'Dashed'})}</option>
   <option value="dotted">{t('chart.draw.dash_dotted',{defaultValue:'Dotted'})}</option>
  </select></label>
  <button type="button" onClick={onEdit}>{t('chart.draw.edit',{defaultValue:'Edit drawing'})}</button>
  <button type="button" onClick={onDelete}>{t('chart.draw.delete',{defaultValue:'Delete drawing'})}</button>
 </div>
}

function DrawingSurface({store,surfaceRef,items,selected,tool,readOnly,width,height,project,intervalMs,context,onStart,onMove,onFinish,onCancel,onEdit,onDelete,onSelect,onStyle}) {
 const {t}=useTranslation('intel',{useSuspense:false})
 const preview=useSyncExternalStore(store.subscribe,store.get,store.get)
 const rendered=preview?(items.some(d=>d.id===preview.id)?items.map(d=>d.id===preview.id?preview:d):[...items,preview]):items
 const idle=tool==='select'
 const selectedDrawing=rendered.find(d=>d.id===selected)
 const selectedPoint=selectedDrawing&&!readOnly?project(selectedDrawing.anchors[0]):null
 const measure=metrics=>`${signed(metrics.change)} · ${metrics.percent>=0?'+':''}${metrics.percent.toFixed(2)}%${metrics.bars==null?'':` · ${t('chart.draw.measure_bars',{defaultValue:'{{count}} bars',count:metrics.bars})}`}`
 return <>
  <svg ref={surfaceRef} className="intel-workstation-overlay intel-drawing-surface" width={width} height={height} role="group" aria-label={t('chart.draw.surface',{defaultValue:'Saved and unsaved chart drawings'})}
   style={{pointerEvents:idle?'none':'all',touchAction:idle?'auto':'none'}} onPointerDown={onStart} onPointerMove={onMove} onPointerUp={onFinish} onPointerCancel={onCancel} onKeyDown={event=>{if(event.key==='Escape')onCancel()}}>
   {rendered.map(drawing=>{
    const geometry=drawingGeometry(drawing,project,width,height,{intervalMs})
    if(!geometry)return null
    const active=selected===drawing.id,dash=DRAWING_DASH_PATTERN[drawing.dash||'solid'],marker=drawing.tool==='arrow_up'||drawing.tool==='arrow_down'
    const label=drawingToolLabel(t,drawing.tool)
    return <g key={drawing.id} role={readOnly?'img':'button'} tabIndex={readOnly?undefined:0} aria-label={`${label}${drawing.text?`: ${drawing.text}`:''}`}
     onPointerDown={event=>onStart(event,drawing)}
     onKeyDown={event=>{if(readOnly)return;if(event.key==='Enter'){event.preventDefault();onSelect(drawing.id);onEdit(drawing)}if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();onDelete(drawing.id)}}}
     style={{pointerEvents:!readOnly&&idle?'all':'none',cursor:readOnly?'default':'move'}}>
     {drawing.tool!=='tweet'&&geometry.polygons.map((polygon,i)=><polygon key={`area:${i}`} points={polygon.points.map(p=>`${p.x},${p.y}`).join(' ')} fill={marker?drawing.color:`${drawing.color}1f`} stroke="none"/>)}
     {drawing.tool!=='tweet'&&geometry.lines.map((line,i)=><g key={`line:${i}`}><line {...line} stroke="transparent" strokeWidth={14}/><line {...line} stroke={drawing.color} strokeWidth={drawing.width} strokeDasharray={dash}/></g>)}
     {drawing.tool!=='tweet'&&geometry.rectangles.map((rect,i)=><rect key={`rect:${i}`} {...rect} fill={`${drawing.color}12`} stroke={drawing.color} strokeWidth={drawing.width} strokeDasharray={dash}/>)}
     {drawing.tool!=='tweet'&&geometry.labels.map((text,i)=>{
      const value=geometry.metrics&&drawing.tool==='measure'&&i===0?measure(geometry.metrics):text.text
      return <text key={`label:${i}`} x={text.x} y={text.y} fill={drawing.color} fontFamily="Inter, sans-serif" fontSize={12}>
       {value.split('\n').slice(0,drawing.tool==='text'?3:1).map((line,j)=><tspan key={j} x={text.x} dy={j?15:0}>{line.slice(0,100)}</tspan>)}</text>
     })}
     {active&&geometry.anchors.map((anchor,i)=><circle key={`anchor:${i}`} cx={anchor.x} cy={anchor.y} r={6} fill="var(--bg-1)" stroke={drawing.color} strokeWidth={2} onPointerDown={event=>onStart(event,drawing,i)}/>)}
    </g>
   })}
  </svg>
  <div className="intel-draw-layer" style={{width,height}}>
   {rendered.filter(drawing=>drawing.tool==='tweet').map(drawing=>{
    const point=project(drawing.anchors[0])
    return point&&<ChartTweetCard key={drawing.id} drawing={drawing} point={point} width={width} height={height} context={context} selected={selected===drawing.id} readOnly={readOnly}
     onSelect={event=>onStart(event,drawing)}/>
   })}
   {selectedDrawing&&selectedPoint&&<DrawingOptions drawing={selectedDrawing} point={selectedPoint} width={width} height={height} onChange={onStyle} onEdit={()=>onEdit(selectedDrawing)} onDelete={()=>onDelete(selectedDrawing.id)}/>}
  </div>
 </>
}

export function useChartDrawings({project,unproject,width,height,scale,initialItems=[],readOnly=false,bars=[],intervalMs=null,context=null}) {
 const {t}=useTranslation('intel',{useSuspense:false})
 const [history,dispatch]=useReducer(drawingReducer,initialItems,drawingHistory)
 const [tool,setToolState]=useState('select'),[selected,setSelected]=useState(null),[editor,setEditor]=useState(null),[error,setError]=useState(null)
 const [lock,setLock]=useState(false),[magnet,setMagnet]=useState(false),[crosshair,setCrosshair]=useState(true)
 const store=useRef(null);if(!store.current)store.current=previewStore()
 const preview=store.current
 const drag=useRef(null),pending=useRef(null),pendingThird=useRef(null),surface=useRef(null),dialog=useRef(null),returnFocus=useRef(null)
 useEffect(()=>{if(editor){returnFocus.current=document.activeElement;if(!dialog.current.open)dialog.current.showModal()}},[!!editor]) // eslint-disable-line react-hooks/exhaustive-deps
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
  canUndo={!!history.past.length} canRedo={!!history.future.length} canClear={!!history.items.length}
  onTool={setTool} onCrosshair={()=>setCrosshair(value=>!value)} onLock={()=>setLock(value=>!value)} onMagnet={()=>setMagnet(value=>!value)}
  onCoordinates={editNew} onUndo={()=>{setTool('select');dispatch({type:'undo'})}} onRedo={()=>{setTool('select');dispatch({type:'redo'})}}
  onClear={()=>{setTool('select');dispatch({type:'clear'});setSelected(null)}}/>
 const overlay=<DrawingSurface store={preview} surfaceRef={surface} items={history.items} selected={selected} tool={tool} readOnly={readOnly} width={width} height={height}
  project={project} intervalMs={intervalMs} context={context} onStart={start} onMove={move} onFinish={finish} onCancel={cancel}
  onEdit={setEditor} onDelete={remove} onSelect={setSelected} onStyle={restyle}/>
 const editorView=editor&&<dialog ref={dialog} className="intel-chart-study-dialog" aria-labelledby="chart-drawing-title" onCancel={event=>{event.preventDefault();closeEditor()}}>
  <div className="intel-investigation-analysis-heading"><h2 id="chart-drawing-title">{t('chart.draw.editor_title',{defaultValue:'Drawing coordinates and notes'})}</h2><button type="button" onClick={closeEditor}>{t('chart.draw.close',{defaultValue:'Close'})}</button></div>
  <label>{t('chart.draw.tool',{defaultValue:'Tool'})}<select value={editor.tool} onChange={event=>{
   const next=event.target.value
   setEditor(d=>{
    const count=countFor(next),base=d.anchors[0],second=d.anchors[1]||base
    return {...d,tool:next,anchors:count===1?[base]:count===3?[base,second,second]:[base,second],
     ...(next==='fibonacci'&&!d.ratios?{ratios:FIB}:{}),...(next==='tweet'&&d.url==null?{url:''}:{})}
   })
  }}>{DRAWABLE.map(id=><option key={id} value={id}>{drawingToolLabel(t,id)}</option>)}</select></label>
  {editor.tool==='tweet'&&<label>{t('chart.draw.tweet_url',{defaultValue:'Address of the post on X'})}<input type="url" inputMode="url" maxLength={500} placeholder="https://x.com/name/status/1234567890" value={editor.url||''} onChange={event=>setEditor(d=>({...d,url:event.target.value}))}/></label>}
  {editor.anchors.map((anchor,i)=><div key={i} className="intel-drawing-anchor-fields">
   <label>{t('chart.draw.anchor_time',{defaultValue:'Anchor {{index}} time (UTC)',index:i+1})}<input type="datetime-local" step="0.001" value={stamp(anchor.t)} onChange={event=>setEditor(d=>({...d,anchors:d.anchors.map((a,j)=>j===i?{...a,t:Date.parse(`${event.target.value}Z`)}:a)}))}/></label>
   <label>{t('chart.draw.anchor_price',{defaultValue:'Anchor {{index}} price',index:i+1})}<input type="number" min="0" step="any" value={Number.isFinite(anchor.price)?anchor.price:''} onChange={event=>setEditor(d=>({...d,anchors:d.anchors.map((a,j)=>j===i?{...a,price:Number(event.target.value)}:a)}))}/></label>
  </div>)}
  <label>{t('chart.draw.note',{defaultValue:'Your annotation'})}<textarea className="textarea" rows={3} maxLength={2000} value={editor.text} onChange={event=>setEditor(d=>({...d,text:event.target.value}))}/></label>
  {editor.tool==='fibonacci'&&<label>{t('chart.draw.ratios',{defaultValue:'Retracement ratios, separated by commas'})}<input value={Array.isArray(editor.ratios)?editor.ratios.join(', '):editor.ratios||''} onChange={event=>setEditor(d=>({...d,ratios:event.target.value}))}/></label>}
  <div className="intel-study-parameters">
   <label>{t('chart.draw.color',{defaultValue:'Color'})}<input type="color" value={editor.color} onChange={event=>setEditor(d=>({...d,color:event.target.value}))}/></label>
   <label>{t('chart.draw.width',{defaultValue:'Width'})}<input type="number" min="1" max="5" value={editor.width} onChange={event=>setEditor(d=>({...d,width:Number(event.target.value)}))}/></label>
   <label>{t('chart.draw.dash',{defaultValue:'Line'})}<select value={editor.dash||'solid'} onChange={event=>setEditor(d=>({...d,dash:event.target.value}))}>{DRAWING_DASHES.map(value=><option key={value} value={value}>{t(`chart.draw.dash_${value}`,{defaultValue:value})}</option>)}</select></label>
  </div>
  {error&&<p role="alert">{error}</p>}
  <button className="btn btn--primary" type="button" onClick={saveEditor}>{t('chart.draw.apply',{defaultValue:'Apply drawing'})}</button>
  <p className="intel-analysis-caption">{t('chart.draw.anchor_caption',{defaultValue:'Coordinates stay attached to their time and price when you resize or zoom. Save the layout to keep them across visits.'})}</p>
 </dialog>
 const list=history.items.length>0&&<details className="intel-chart-readings"><summary>{t('chart.draw.read_list',{defaultValue:'Read and edit {{count}} drawings',count:history.items.length})}</summary>
  <ul className="intel-study-list">{history.items.map(drawing=><li key={drawing.id}>
   <span>{drawingToolLabel(t,drawing.tool)} · {drawing.text||drawing.url||drawing.anchors.map(a=>`${new Date(a.t).toISOString()} · ${a.price}`).join(' → ')}</span>
   {!readOnly&&<button type="button" onClick={()=>setEditor(drawing)}>{t('chart.draw.edit_short',{defaultValue:'Edit'})}</button>}
  </li>)}</ul></details>
 return {items:history.items,add:drawing=>readOnly?false:commit(drawing),reset:items=>{cancel();setSelected(null);dispatch({type:'reset',items})},
  // The toolbar now docks to the chart surface itself; the price workstation's
  // display-controls row keeps no drawing controls of its own.
  controls:null,toolbar,overlay,editor:editorView,list,error,crosshair,selected:selectedDrawing?.id??null}
}
