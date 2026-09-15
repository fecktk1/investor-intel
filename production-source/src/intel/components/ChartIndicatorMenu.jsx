import React,{useEffect,useId,useRef,useState} from 'react'
import {useTranslation} from 'react-i18next'
import {STUDY_CATALOG} from '../../../supabase/functions/_shared/intel/chart-analysis'

// Indicator vocabulary for the chart tools. The catalogue itself is shared with
// the edge functions and keyed by study id; this file only decides how the list
// reads to a person: four named families, then anything the catalogue gains
// later, so a new study is never silently missing from the menu.
export const INDICATOR_FAMILIES=[
 ['trend',['sma','ema','dema','ichimoku','weekly']],
 ['momentum',['rsi','macd','stoch_rsi','vwrsi']],
 ['volatility',['bollinger','atr']],
 ['volume',['obv','vwap']],
]
export const FAMILY_LABELS={trend:'Trend',momentum:'Momentum',volatility:'Volatility',volume:'Volume',other:'Other indicators'}
export function indicatorFamilies(catalog=STUDY_CATALOG){
 const placed=new Set(INDICATOR_FAMILIES.flatMap(([,types])=>types))
 const rest=Object.keys(catalog).filter(type=>!placed.has(type))
 return [...INDICATOR_FAMILIES.map(([family,types])=>[family,types.filter(type=>Object.hasOwn(catalog,type))]).filter(([,types])=>types.length),...(rest.length?[['other',rest]]:[])]
}
/** Parameters as they stand right now: the active instances if the indicator is
 * on, otherwise the defaults it would be added with. A zero is a value. */
export function indicatorParameters(type,studies,catalog=STUDY_CATALOG){
 const active=studies.filter(study=>study.type===type)
 const sets=active.length?active.map(study=>({...catalog[type].defaults,...study.params})):[{...catalog[type].defaults}]
 return sets.map(params=>Object.entries(params).filter(([,value])=>value!=null).map(([key,value])=>`${key} ${value}`).join(', ')).filter(Boolean)
}

export default function ChartIndicatorMenu({studies=[],disabled=false,onToggle,onAdvanced,catalog=STUDY_CATALOG}){
 const {t}=useTranslation('intel',{useSuspense:false})
 const [open,setOpen]=useState(false),[notice,setNotice]=useState(null)
 const wrap=useRef(null),trigger=useRef(null),panel=useRef(null)
 const panelId=useId()
 useEffect(()=>{
  if(!open)return
  const onKey=event=>{if(event.key==='Escape'){setOpen(false);trigger.current?.focus()}}
  const onPointer=event=>{if(!wrap.current?.contains(event.target))setOpen(false)}
  document.addEventListener('keydown',onKey)
  document.addEventListener('pointerdown',onPointer)
  return()=>{document.removeEventListener('keydown',onKey);document.removeEventListener('pointerdown',onPointer)}
 },[open])
 useEffect(()=>{if(open)panel.current?.querySelector('input:not(:disabled)')?.focus();else setNotice(null)},[open])
 const active=type=>studies.some(study=>study.type===type)
 const toggle=(type,on)=>{const reason=onToggle?.(type,on);setNotice(reason||null)}
 return <div className="intel-indicator-menu" ref={wrap}>
  <button type="button" ref={trigger} disabled={disabled} aria-expanded={open} aria-haspopup="true" aria-controls={panelId} onClick={()=>setOpen(value=>!value)}>
   {studies.length?t('chart.indicators.open_count',{total:studies.length,defaultValue:'Indicators ({{total}})'}):t('chart.indicators.open',{defaultValue:'Indicators'})}
  </button>
  <div id={panelId} ref={panel} className="intel-indicator-panel" role="group" aria-label={t('chart.indicators.title',{defaultValue:'Indicators'})} hidden={!open}>
   <p className="intel-indicator-hint">{t('chart.indicators.hint',{defaultValue:'Selecting an indicator draws it immediately. Open Advanced to change its parameters or add a second copy.'})}</p>
   {indicatorFamilies(catalog).map(([family,types])=><fieldset key={family} className="intel-indicator-family">
    <legend>{t(`chart.indicators.family_${family}`,{defaultValue:FAMILY_LABELS[family]||family})}</legend>
    {types.map(type=><label key={type} className="intel-indicator-row">
     <input type="checkbox" checked={active(type)} disabled={disabled} onChange={event=>toggle(type,event.target.checked)}/>
     <span className="intel-indicator-name">{catalog[type].label}</span>
     <span className="intel-indicator-parameters">{indicatorParameters(type,studies,catalog).join(' · ')||t('chart.indicators.no_parameters',{defaultValue:'No parameters'})}</span>
    </label>)}
   </fieldset>)}
   {notice&&<p role="alert" className="intel-indicator-notice">{notice}</p>}
   <button type="button" className="intel-indicator-advanced" disabled={disabled} onClick={()=>{setOpen(false);onAdvanced?.()}}>{t('chart.indicators.advanced',{defaultValue:'Advanced parameters'})}</button>
  </div>
 </div>
}
