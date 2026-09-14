import React,{useEffect,useRef,useState} from 'react'
import {Link} from 'react-router'
import {useTranslation} from 'react-i18next'
import {useSupabase} from '../../lib/useSupabase'
import {useProfile} from '../../lib/profile-context'
import {cohortResearchPath} from '../lib/cohort-evidence'
export default function DexCohortCapture({reference,ready}){
 const {supabase,user}=useSupabase(),{org}=useProfile()
 if(!user?.id||!org?.id||!reference?.payloadHash)return null
 const parameters=JSON.stringify(Object.entries(reference.parameters||{}).sort(([a],[b])=>a.localeCompare(b)))
 return <Capture key={`${user.id}:${org.id}:${reference.subject}:${reference.capability}:${parameters}`} {...{supabase,orgId:org.id,reference,ready}}/>
}
function Capture({supabase,orgId,reference,ready}){
 const {t}=useTranslation('intel',{useSuspense:false})
 const [busy,setBusy]=useState(false),[cohort,setCohort]=useState(null),[error,setError]=useState(null),alive=useRef(true),lock=useRef(false)
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
 async function capture(){
  if(lock.current||!ready)return;lock.current=true;setBusy(true);setError(null)
  try{
   const {data,error:failure}=await supabase.functions.invoke('intel-research',{body:{orgId,capability:'dexCohort',params:{operation:'capture',capability:reference.capability,parameters:reference.parameters,payloadHash:reference.payloadHash,retrievedAt:reference.retrievedAt}}})
   if(failure||data?.error){const body=data||await failure?.context?.json?.().catch(()=>null);throw Error(body?.error==='dex_cohort_source_changed'?'The source changed after this page was loaded. Refresh and review the new membership before capturing it.':'The cohort could not be captured. Your original discovery page is unchanged.')}
   if(!data?.cohort)throw Error(data?.reason||'Fresh retained discovery membership is required.')
   if(alive.current)setCohort({record:data.cohort,payloadHash:reference.payloadHash,retrievedAt:reference.retrievedAt})
  }catch(e){if(alive.current)setError(e.message)}finally{lock.current=false;if(alive.current)setBusy(false)}
 }
 const sameResponse=cohort?.payloadHash===reference.payloadHash&&cohort?.retrievedAt===reference.retrievedAt
 return <div className="intel-investigation-controls"><button className="btn" disabled={!ready||busy||sameResponse} onClick={capture}>{busy?'Capturing original membership…':sameResponse?'Cohort captured':'Track this discovery cohort'}</button>
  {cohortResearchPath(cohort?.record)&&<Link className="intel-text-link" to={cohortResearchPath(cohort.record)}>Open original cohort and retained prices</Link>}
  {cohort&&!sameResponse&&<p role="status">{t('cohort.response_changed',{defaultValue:'The discovery response has changed. Your saved cohort still opens its original members. Capture this response explicitly to track another cohort.'})}</p>}
  <p className="intel-analysis-caption">Captures this response’s exact contracts now. Future missing prices keep their original members; no wallet or provider refresh is triggered.</p>
  {error&&<p role="alert">{error}</p>}
 </div>
}
