import React,{useEffect,useId,useMemo,useRef,useState} from 'react'
import {useTranslation} from 'react-i18next'
import {DRAWING_TOOL_BY_ID,DRAWING_TOOL_GROUPS,ROW_LIMIT,toolbarRows} from '../lib/chart-drawing-tools'
import deferredPanel from './deferred-panel'

const ACTION_ICONS={
 magnet:'M4 13V7a4 4 0 0 1 8 0v6 M4 10h3 M9 10h3',
 lock:'M4.5 7V5a3.5 3.5 0 0 1 7 0v2 M3 7h10v7H3z',
 coordinates:'M2 4h12v8H2z M4.5 6.5h1 M7.5 6.5h1 M10.5 6.5h1 M4.5 9.5h7',
 undo:'M6 4 2.5 7.5 6 11 M2.5 7.5H10a3.5 3.5 0 0 1 0 7H6',
 redo:'M10 4l3.5 3.5L10 11 M13.5 7.5H6a3.5 3.5 0 0 0 0 7h4',
 delete:'M3 5h10 M6.5 5V3h3v2 M4.5 5l.7 9h5.6l.7-9 M6.5 7.5v4 M9.5 7.5v4',
 clear:'M2 13h12 M4 10.5 10.5 4 12 5.5 5.5 12z M9 5.5 10.5 7',
 more:'M3.5 8h.01 M8 8h.01 M12.5 8h.01',
}
// Row arithmetic lives in the tools library so the deferred strip's placeholder
// reserves the same height; re-exported here for the callers that had it.
export {BUTTON_WIDTH,SEPARATOR_WIDTH,MORE_WIDTH,ROW_LIMIT,toolbarRows} from '../lib/chart-drawing-tools'

// Only the body of the disclosure is deferred; the button that opens it is eager,
// so the strip never changes shape while the panel loads.
const MorePanel=deferredPanel(()=>import('./ChartDrawingMorePanel'),{label:'The remaining drawing tools'})

export function ToolButton({entry,tabIndex,innerRef,onPress}) {
 return <button ref={innerRef} type="button" className="intel-draw-tool" aria-pressed={entry.pressed} aria-label={entry.hint} title={entry.hint}
  tabIndex={tabIndex} disabled={entry.disabled} onClick={onPress}>
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path d={entry.icon} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
  <span className="intel-draw-tool-name">{entry.label}</span>
 </button>
}

// The drawing toolbar, running the full width of the plot along its top edge.
export default function ChartDrawingToolbar({tool,crosshair,lock,magnet,hint,canUndo,canRedo,canClear,canDelete,onTool,onCrosshair,onLock,onMagnet,onCoordinates,onUndo,onRedo,onDelete,onClear}) {
 const {t}=useTranslation('intel',{useSuspense:false})
 const [focused,setFocused]=useState(tool),[open,setOpen]=useState(false),[width,setWidth]=useState(0)
 const buttons=useRef(new Map()),shell=useRef(null),moreId=useId()
 useEffect(()=>{
  const node=shell.current
  if(!node)return
  const read=()=>setWidth(node.clientWidth||0)
  read()
  if(typeof ResizeObserver==='function'){const observer=new ResizeObserver(read);observer.observe(node);return()=>observer.disconnect()}
  window.addEventListener('resize',read)
  return()=>window.removeEventListener('resize',read)
 },[])
 const shortcut=key=>t('chart.draw.shortcut',{defaultValue:'Shortcut Alt+{{key}}',key})
 const groups=useMemo(()=>{
  const toolEntry=id=>{
   const entry=DRAWING_TOOL_BY_ID[id],label=t(entry.key,{defaultValue:entry.label})
   return {id,icon:entry.icon,label,hint:`${label} · ${shortcut(entry.shortcut)}`,pressed:entry.toggle?!!crosshair:tool===id,
    onPress:()=>{entry.toggle?onCrosshair():onTool(id)}}
  }
  const action=(id,label,extra)=>({id,icon:ACTION_ICONS[id],label,hint:label,...extra})
  return [
   ...DRAWING_TOOL_GROUPS.map(([name,ids])=>({name,items:ids.map(toolEntry)})),
   {name:'actions',items:[
    action('magnet',t('chart.draw.magnet',{defaultValue:'Magnet to open, high, low and close'}),{pressed:magnet,onPress:onMagnet}),
    action('lock',t('chart.draw.lock',{defaultValue:'Keep tool armed'}),{pressed:lock,onPress:onLock}),
    action('coordinates',t('chart.draw.by_coordinates',{defaultValue:'Add by coordinates'}),{onPress:onCoordinates}),
    action('undo',t('chart.draw.undo',{defaultValue:'Undo'}),{disabled:!canUndo,onPress:onUndo}),
    action('redo',t('chart.draw.redo',{defaultValue:'Redo'}),{disabled:!canRedo,onPress:onRedo}),
    action('delete',t('chart.draw.delete',{defaultValue:'Delete drawing'}),{disabled:!canDelete,onPress:onDelete}),
    action('clear',t('chart.draw.clear',{defaultValue:'Remove every drawing'}),{disabled:!canClear,onPress:onClear}),
   ]},
  ]
 },[t,tool,crosshair,lock,magnet,canUndo,canRedo,canClear,canDelete]) // eslint-disable-line react-hooks/exhaustive-deps
 // Trailing groups move into the disclosure until the rest fits in two rows.
 const shown=useMemo(()=>{
  let count=groups.length
  while(count>1&&toolbarRows(groups.slice(0,count),width,count<groups.length)>ROW_LIMIT)count--
  return count
 },[groups,width])
 const visible=groups.slice(0,shown),hidden=groups.slice(shown).flatMap(group=>group.items)
 useEffect(()=>{if(!hidden.length&&open)setOpen(false)},[hidden.length,open])
 const order=[...visible.flatMap(group=>group.items.map(item=>item.id)),...(hidden.length?['more']:[])]
 // ARIA toolbar roving focus: one stop in the page tab order, arrow keys inside.
 const move=event=>{
  if(event.key==='Escape'&&open){event.preventDefault();setOpen(false);buttons.current.get('more')?.focus();return}
  const step={ArrowRight:1,ArrowDown:1,ArrowLeft:-1,ArrowUp:-1}[event.key]
  const at=order.indexOf(focused)
  let next=null
  if(step)next=order[(at<0?0:at+step+order.length)%order.length]
  else if(event.key==='Home')next=order[0]
  else if(event.key==='End')next=order.at(-1)
  if(next==null)return
  event.preventDefault();setFocused(next);buttons.current.get(next)?.focus()
 }
 const current=order.includes(focused)?focused:order[0]
 const register=id=>node=>{if(node)buttons.current.set(id,node);else buttons.current.delete(id)}
 return <div ref={shell} className="intel-draw-bar" role="toolbar" aria-label={t('chart.draw.toolbar',{defaultValue:'Chart drawing tools'})} onKeyDown={move}>
  {visible.map(group=><span key={group.name} className="intel-draw-group">
   {group.items.map(entry=><ToolButton key={entry.id} entry={entry} innerRef={register(entry.id)} tabIndex={current===entry.id?0:-1}
    onPress={()=>{setFocused(entry.id);entry.onPress()}}/>)}
  </span>)}
  {hidden.length>0&&<span className="intel-draw-group intel-draw-more">
   <button ref={register('more')} type="button" className="intel-draw-more-toggle" aria-expanded={open} aria-controls={moreId}
    tabIndex={current==='more'?0:-1} onClick={()=>{setFocused('more');setOpen(value=>!value)}}>
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path d={ACTION_ICONS.more} fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"/></svg>
    {t('chart.draw.more',{defaultValue:'More'})}
   </button>
   {open&&<MorePanel id={moreId} items={hidden} onPress={entry=>{setOpen(false);entry.onPress()}}/>}
  </span>}
  {hint&&<p className="intel-draw-bar-hint" role="status">{hint}</p>}
 </div>
}
