import React,{useSyncExternalStore} from 'react'
import {useTranslation} from 'react-i18next'
import {drawingGeometry} from '../lib/chart-drawings'
import {DRAWING_DASH_PATTERN,drawingToolLabel} from '../lib/chart-drawing-tools'
import deferredPanel from './deferred-panel'

const number=value=>Number(value).toLocaleString(undefined,{maximumFractionDigits:8})
const signed=value=>`${value>=0?'+':''}${number(value)}`

// Deferred within the deferred surface: an anchored post card and the style row
// for the selected drawing, each reserving the footprint it will occupy.
const TweetCard=deferredPanel(()=>import('./ChartTweetCard'),{label:'This post from X',
 fallback:({point,width,height})=>{
  const left=Math.max(0,Math.min(Math.max(0,(width||0)-232),point.x+8)),top=Math.max(0,Math.min(Math.max(0,(height||0)-48),point.y-16))
  return <article className="intel-draw-tweet" aria-hidden="true" style={{left,top,minHeight:48}}/>
 }})
const DrawingOptions=deferredPanel(()=>import('./ChartDrawingOptions'),{label:'The drawing style row'})

// The drawing surface: the SVG the pointer draws on, plus the HTML layer that
// carries anchored post cards and the style row. Deferred as a whole, so the
// price chart's first paint carries the toolbar and the chart only.
export default function ChartDrawingSurface({store,surfaceRef,items,selected,tool,readOnly,width,height,project,intervalMs,context,onStart,onMove,onFinish,onCancel,onEdit,onDelete,onSelect,onStyle}) {
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
    return point&&<TweetCard key={drawing.id} drawing={drawing} point={point} width={width} height={height} context={context} selected={selected===drawing.id} readOnly={readOnly}
     onSelect={event=>onStart(event,drawing)}/>
   })}
   {selectedDrawing&&selectedPoint&&<DrawingOptions drawing={selectedDrawing} point={selectedPoint} width={width} height={height} onChange={onStyle} onEdit={()=>onEdit(selectedDrawing)} onDelete={()=>onDelete(selectedDrawing.id)}/>}
  </div>
 </>
}
