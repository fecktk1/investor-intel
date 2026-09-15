import React,{useEffect,useRef,useState} from 'react'
import {useTranslation} from 'react-i18next'
import {STUDY_CATALOG} from '../../../supabase/functions/_shared/intel/chart-analysis'
import {FAMILY_LABELS,indicatorFamilies,indicatorParameters} from '../lib/chart-indicators'

/** The indicator list itself, loaded on the first press of Indicators.
 *
 * Only the trigger is eager, so an asset page that never opens the list does
 * not carry the catalogue markup. The list takes focus on arrival, which is
 * where focus would have gone had the code already been there. */
export default function ChartIndicatorPanel({studies=[],disabled=false,onToggle,onAdvanced,catalog=STUDY_CATALOG,panelId}) {
 const {t}=useTranslation('intel',{useSuspense:false})
 const [notice,setNotice]=useState(null)
 const panel=useRef(null)
 useEffect(()=>{panel.current?.querySelector('input:not(:disabled)')?.focus()},[])
 const active=type=>studies.some(study=>study.type===type)
 const toggle=(type,on)=>{setNotice(onToggle?.(type,on)||null)}
 return <div id={panelId} ref={panel} className="intel-indicator-panel" role="group" aria-label={t('chart.indicators.title',{defaultValue:'Indicators'})}>
  <p className="intel-indicator-hint">{t('chart.indicators.hint',{defaultValue:'Selecting an indicator draws it immediately. Open Advanced parameters to change its settings or add a second copy.'})}</p>
  {indicatorFamilies(catalog).map(([family,types])=><fieldset key={family} className="intel-indicator-family">
   <legend>{t(`chart.indicators.family_${family}`,{defaultValue:FAMILY_LABELS[family]||family})}</legend>
   {types.map(type=><label key={type} className="intel-indicator-row">
    <input type="checkbox" checked={active(type)} disabled={disabled} onChange={event=>toggle(type,event.target.checked)}/>
    <span className="intel-indicator-name">{catalog[type].label}</span>
    <span className="intel-indicator-parameters">{indicatorParameters(type,studies,catalog).join(' · ')||t('chart.indicators.no_parameters',{defaultValue:'No parameters'})}</span>
   </label>)}
  </fieldset>)}
  {notice&&<p role="alert" className="intel-indicator-notice">{notice}</p>}
  <button type="button" className="intel-indicator-advanced" disabled={disabled} onClick={onAdvanced}>{t('chart.indicators.advanced',{defaultValue:'Advanced parameters'})}</button>
 </div>
}
