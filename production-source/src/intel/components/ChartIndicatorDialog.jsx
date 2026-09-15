import React,{useEffect,useRef,useState} from 'react'
import {useTranslation} from 'react-i18next'
import {STUDY_CATALOG} from '../../../supabase/functions/_shared/intel/chart-analysis'

/** Advanced indicator parameters, loaded on demand from the indicator list.
 *
 * The draft type, its parameters and the refusal reason live here, so the
 * workstation keeps none of this markup in the asset route's static graph. The
 * workstation still owns the admission rules: `onAdd` returns the reason an
 * indicator was refused, or null when it was added and the dialog may close. */
export default function ChartIndicatorDialog({studies=[],theme,onTheme,onAdd,onRemove,onClose,catalog=STUDY_CATALOG}) {
 const {t}=useTranslation('intel',{useSuspense:false})
 const [type,setType]=useState('sma'),[params,setParams]=useState(()=>({...catalog.sma.defaults})),[error,setError]=useState(null)
 const dialog=useRef(null)
 useEffect(()=>{dialog.current?.showModal()},[])
 const add=()=>{setError(onAdd?.(type,params)||null)}
 return <dialog ref={dialog} className="intel-chart-study-dialog" aria-labelledby="chart-study-title" onCancel={e=>{e.preventDefault();onClose?.()}}>
  <div className="intel-investigation-analysis-heading"><h2 id="chart-study-title">{t('chart.indicators.dialog_title',{defaultValue:'Chart indicators'})}</h2><button type="button" onClick={onClose}>{t('common.close',{defaultValue:'Close'})}</button></div>
  <p className="intel-analysis-caption">{t('chart.indicators.dialog_intro',{defaultValue:'Choose an indicator and set its parameters. The list in Chart tools turns the same indicators on and off with their defaults.'})}</p>
  <label>{t('chart.indicators.dialog_choose',{defaultValue:'Indicator'})}<select className="select" value={type} onChange={e=>{setType(e.target.value);setParams({...catalog[e.target.value].defaults});setError(null)}}>{Object.entries(catalog).map(([id,spec])=><option key={id} value={id}>{spec.label}</option>)}</select></label>
  <p className="intel-analysis-caption">{catalog[type].definition}</p><div className="intel-study-parameters">{Object.keys(catalog[type].defaults).map(key=><label key={key}>{key.charAt(0).toUpperCase()+key.slice(1)}<input type="number" min="1" max={key==='multiplier'?10:500} step={key==='multiplier'?0.25:1} value={params[key]??''} onChange={e=>setParams(p=>({...p,[key]:e.target.value}))}/></label>)}</div>
  <label>{t('chart.indicators.appearance',{defaultValue:'Chart appearance'})}<select value={theme} onChange={e=>onTheme?.(e.target.value)}><option value="app">{t('chart.indicators.appearance_app',{defaultValue:'Follow app theme'})}</option><option value="dark">{t('chart.indicators.appearance_dark',{defaultValue:'Charcoal'})}</option><option value="light">{t('chart.indicators.appearance_light',{defaultValue:'Light'})}</option><option value="gray">{t('chart.indicators.appearance_gray',{defaultValue:'Neutral gray'})}</option></select></label>
  {type==='vwap'&&<label>{t('chart.indicators.vwap_anchor',{defaultValue:'Optional anchor (UTC)'})}<input type="datetime-local" onChange={e=>setParams(p=>({...p,anchor:e.target.value?Date.parse(`${e.target.value}Z`):undefined}))}/></label>}
  {error&&<p role="alert">{error}</p>}<button type="button" className="btn btn--primary" onClick={add}>{t('chart.indicators.add',{defaultValue:'Add indicator'})}</button>
  {studies.length>0&&<ul className="intel-study-list">{studies.map(study=><li key={study.id}><span>{catalog[study.type].label} · {Object.entries(study.params||catalog[study.type].defaults).filter(([,value])=>value!=null).map(([key,value])=>`${key}: ${value}`).join(', ')}</span><button type="button" onClick={()=>onRemove?.(study.id)}>{t('chart.indicators.remove',{defaultValue:'Remove'})}</button></li>)}</ul>}
 </dialog>
}
