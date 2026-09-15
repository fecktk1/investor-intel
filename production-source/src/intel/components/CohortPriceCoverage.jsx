import React,{useEffect,useId,useRef,useState} from 'react'
import {useTranslation} from 'react-i18next'
import {cohortPriceCoverage} from '../lib/cohort-evidence'
import {time} from './InvestigationTable'

export default function CohortPriceCoverage({row,quote,at}){
 const {t}=useTranslation('intel',{useSuspense:false}),coverage=cohortPriceCoverage(row,quote,at)
 const [selected,setSelected]=useState(null)
 return <><button className="intel-text-link" aria-haspopup="dialog" onClick={()=>setSelected({name:row.name,subject:row.subject,quote:{...quote},at,coverage})}>{t(`cohort.coverage.${coverage.code}`,{defaultValue:coverage.label})}</button>
  {selected&&<PriceClockDialog selected={selected} onClose={()=>setSelected(null)}/>}
 </>
}
function PriceClockDialog({selected,onClose}){
 const {t}=useTranslation('intel',{useSuspense:false}),panel=useRef(null),title=useId(),{quote,at,coverage}=selected
 useEffect(()=>{const node=panel.current,previous=document.activeElement;node.showModal();return()=>{node.close();if(previous?.isConnected)previous.focus?.()}},[])
 return <dialog ref={panel} className="intel-investigation intel-cohort-coverage-dialog" aria-labelledby={title} onCancel={event=>{event.preventDefault();onClose()}}>
  <div className="intel-investigation-analysis-heading"><h2 id={title}>{selected.name||selected.subject}</h2><button className="btn" onClick={onClose}>{t('cohort.close',{defaultValue:'Close'})}</button></div>
  <p>{t(`cohort.coverage.${coverage.code}`,{defaultValue:coverage.label})}</p>
  <p>{t('cohort.coverage.retained_member',{defaultValue:'The original member remains in this cohort. Unavailable prices do not count as zero returns.'})}</p>
  <dl className="intel-cohort-price-clocks">
   <dt>{t('cohort.coverage.observed',{defaultValue:'Price observed'})}</dt><dd>{time(quote?.observedAt)}</dd>
   <dt>{t('cohort.coverage.recorded',{defaultValue:'First recorded'})}</dt><dd>{time(quote?.recordedAt)}</dd>
   <dt>{t('cohort.coverage.expires',{defaultValue:'Freshness limit'})}</dt><dd>{time(quote?.expiresAt)}</dd>
   <dt>{t('cohort.coverage.selected',{defaultValue:'Selected evidence time'})}</dt><dd>{time(at)}</dd>
  </dl>
  <p className="intel-analysis-caption">{selected.subject}</p>
 </dialog>
}
