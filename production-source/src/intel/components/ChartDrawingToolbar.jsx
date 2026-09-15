import React,{useId,useRef,useState} from 'react'
import {useTranslation} from 'react-i18next'
import {DRAWING_TOOLBAR} from '../lib/chart-drawing-tools'

const ACTION_ICONS={
 lock:'M4.5 7V5a3.5 3.5 0 0 1 7 0v2 M3 7h10v7H3z',
 magnet:'M4 13V7a4 4 0 0 1 8 0v6 M4 10h3 M9 10h3',
 undo:'M6 4 2.5 7.5 6 11 M2.5 7.5H10a3.5 3.5 0 0 1 0 7H6',
 redo:'M10 4l3.5 3.5L10 11 M13.5 7.5H6a3.5 3.5 0 0 0 0 7h4',
 clear:'M3 5h10 M6.5 5V3h3v2 M4.5 5l.7 9h5.6l.7-9',
 coordinates:'M2 4h12v8H2z M4.5 6.5h1 M7.5 6.5h1 M10.5 6.5h1 M4.5 9.5h7',
}

function DockButton({icon,label,hint,pressed,tabIndex,onClick,disabled,innerRef}) {
 return <button ref={innerRef} type="button" className="intel-draw-tool" aria-pressed={pressed} aria-label={hint} title={hint} tabIndex={tabIndex} disabled={disabled} onClick={onClick}>
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path d={icon} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
  <span className="intel-draw-tool-name">{label}</span>
 </button>
}

// The docked drawing toolbar. One press arms a tool; the next press or drag on the
// chart draws with it. Desktop keeps the vertical strip on the left edge of the
// plot; a narrow screen collapses it behind a single Tools button.
export default function ChartDrawingToolbar({tool,crosshair,lock,magnet,hint,canUndo,canRedo,canClear,onTool,onCrosshair,onLock,onMagnet,onCoordinates,onUndo,onRedo,onClear}) {
 const {t}=useTranslation('intel',{useSuspense:false})
 const [open,setOpen]=useState(false),[focused,setFocused]=useState(tool)
 const buttons=useRef(new Map()),stripId=useId()
 const shortcut=key=>t('chart.draw.shortcut',{defaultValue:'Shortcut Alt+{{key}}',key})
 const actions=[
  {id:'lock',label:t('chart.draw.lock',{defaultValue:'Keep tool armed'}),pressed:lock,onClick:onLock},
  {id:'magnet',label:t('chart.draw.magnet',{defaultValue:'Magnet to open, high, low and close'}),pressed:magnet,onClick:onMagnet},
  {id:'coordinates',label:t('chart.draw.by_coordinates',{defaultValue:'Add by coordinates'}),onClick:onCoordinates},
  {id:'undo',label:t('chart.draw.undo',{defaultValue:'Undo'}),onClick:onUndo,disabled:!canUndo},
  {id:'redo',label:t('chart.draw.redo',{defaultValue:'Redo'}),onClick:onRedo,disabled:!canRedo},
  {id:'clear',label:t('chart.draw.clear',{defaultValue:'Remove every drawing'}),onClick:onClear,disabled:!canClear},
 ]
 const order=[...DRAWING_TOOLBAR.map(entry=>entry.id),...actions.map(entry=>entry.id)]
 // ARIA toolbar roving focus: one stop in the page tab order, arrow keys inside.
 const move=event=>{
  const step={ArrowDown:1,ArrowRight:1,ArrowUp:-1,ArrowLeft:-1}[event.key]
  const at=order.indexOf(focused)
  let next=null
  if(step)next=order[(at<0?0:at+step+order.length)%order.length]
  else if(event.key==='Home')next=order[0]
  else if(event.key==='End')next=order.at(-1)
  if(next==null)return
  event.preventDefault();setFocused(next);buttons.current.get(next)?.focus()
 }
 const current=order.includes(focused)?focused:tool
 return <div className="intel-draw-dock" data-open={open}>
  <button type="button" className="intel-draw-dock-toggle" aria-expanded={open} aria-controls={stripId} onClick={()=>setOpen(value=>!value)}>{t('chart.draw.tools',{defaultValue:'Tools'})}</button>
  <div id={stripId} className="intel-draw-dock-strip" role="toolbar" aria-label={t('chart.draw.toolbar',{defaultValue:'Chart drawing tools'})} onKeyDown={move}>
   {DRAWING_TOOLBAR.map(entry=>{
    const label=t(entry.key,{defaultValue:entry.label})
    return <DockButton key={entry.id} innerRef={node=>{if(node)buttons.current.set(entry.id,node);else buttons.current.delete(entry.id)}}
     icon={entry.icon} label={label} hint={`${label} · ${shortcut(entry.shortcut)}`}
     pressed={entry.toggle?!!crosshair:tool===entry.id} tabIndex={current===entry.id?0:-1}
     onClick={()=>{setFocused(entry.id);entry.toggle?onCrosshair():onTool(entry.id)}}/>
   })}
   <span className="intel-draw-dock-rule" aria-hidden="true"/>
   {actions.map(entry=><DockButton key={entry.id} innerRef={node=>{if(node)buttons.current.set(entry.id,node);else buttons.current.delete(entry.id)}}
    icon={ACTION_ICONS[entry.id]} label={entry.label} hint={entry.label} pressed={entry.pressed}
    tabIndex={current===entry.id?0:-1} disabled={entry.disabled} onClick={()=>{setFocused(entry.id);entry.onClick()}}/>)}
  </div>
  {hint&&<p className="intel-draw-dock-hint" role="status">{hint}</p>}
 </div>
}
