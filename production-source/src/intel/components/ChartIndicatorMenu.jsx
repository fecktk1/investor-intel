import React,{useEffect,useId,useRef,useState} from 'react'
import {useTranslation} from 'react-i18next'
import deferredPanel from './deferred-panel'

/** Indicators: the trigger and the open/close behaviour.
 *
 * The catalogue list is a chunk of its own, so the asset route carries only
 * this button until someone asks for indicators. The disclosure floats over the
 * chart, so the loading fallback cannot shift the page; it stands in the same
 * place and says what is happening. */
const IndicatorList=deferredPanel(()=>import('./ChartIndicatorPanel'),{
 label:'The indicator list',
 fallback:props=><div id={props.panelId} className="intel-indicator-panel"><p className="intel-indicator-hint" role="status">{props.loadingLabel}</p></div>,
})

export default function ChartIndicatorMenu({studies=[],disabled=false,onToggle,onAdvanced}) {
 const {t}=useTranslation('intel',{useSuspense:false})
 const [open,setOpen]=useState(false)
 const wrap=useRef(null),trigger=useRef(null)
 const panelId=useId()
 useEffect(()=>{
  if(!open)return
  const onKey=event=>{if(event.key==='Escape'){setOpen(false);trigger.current?.focus()}}
  const onPointer=event=>{if(!wrap.current?.contains(event.target))setOpen(false)}
  document.addEventListener('keydown',onKey)
  document.addEventListener('pointerdown',onPointer)
  return()=>{document.removeEventListener('keydown',onKey);document.removeEventListener('pointerdown',onPointer)}
 },[open])
 return <div className="intel-indicator-menu" ref={wrap}>
  <button type="button" ref={trigger} disabled={disabled} aria-expanded={open} aria-haspopup="true" aria-controls={panelId} onClick={()=>setOpen(value=>!value)}>
   {studies.length?t('chart.indicators.open_count',{total:studies.length,defaultValue:'Indicators ({{total}})'}):t('chart.indicators.open',{defaultValue:'Indicators'})}
  </button>
  {open&&<IndicatorList panelId={panelId} studies={studies} disabled={disabled} onToggle={onToggle}
   loadingLabel={t('chart.indicators.loading',{defaultValue:'Loading the indicator list…'})}
   onAdvanced={()=>{setOpen(false);onAdvanced?.()}}/>}
 </div>
}
