import {useCallback,useEffect,useRef,useState} from 'react'
import {useProfile} from '../../lib/profile-context'
import {useSupabase} from '../../lib/useSupabase'
export async function invokeInvestigation(supabase,body,signal) {
  const {data,error}=await supabase.functions.invoke('intel-investigate',{body,signal})
  if(error||data?.error){
    const payload=data||await error?.context?.json?.().catch(()=>null),raw=payload?.error||error?.message,code=typeof raw==='string'&&raw.length<=250?raw:'investigation_unavailable'
    const messages={receipt_deleted:'This receipt was deleted. Reopen Connected research to start a new receipt.',scenario_conditions_changed_refresh_thesis:'The thesis conditions changed while you were researching. Reload the thesis, review the scenario, and save again.',scenario_asset_mismatch:'This scenario belongs to another asset. Select a thesis for the current asset.',scenario_thesis_unavailable:'The selected thesis is unavailable or is not owned by this account.',scenario_rule_limit:'A saved stress scenario supports up to 50 conditions.',invalid_scenario_basis:'Choose a supported unit and period for each scenario condition.',investigation_unavailable:'Research could not be loaded. Try again.'}
    const failure=new Error(Object.hasOwn(messages,code)?messages[code]:code);failure.code=code;throw failure
  }
  return data
}
export function useInvestigation(params) {
  const {supabase,user}=useSupabase(),{org}=useProfile()
  const key=JSON.stringify([user?.id,org?.id,params]),active=useRef(key);active.current=key
  const [state,setState]=useState({key:null,data:null,error:null,loading:false}),[revision,setRevision]=useState(0)
  useEffect(()=>{
    if(!user?.id||!org?.id)return
    const controller=new AbortController()
    setState({key,data:null,error:null,loading:true})
    invokeInvestigation(supabase,{...JSON.parse(key)[2],orgId:org.id},controller.signal).then(data=>{
      if(!controller.signal.aborted&&active.current===key)setState({key,data,error:null,loading:false})
    }).catch(error=>{if(!controller.signal.aborted&&active.current===key)setState({key,data:null,error:error.message,loading:false})})
    return()=>controller.abort()
  },[key,org?.id,user?.id,supabase,revision])
  const refresh=useCallback(()=>setRevision(r=>r+1),[])
  return {...(state.key===key?state:{data:null,error:null,loading:!!(user?.id&&org?.id)}),refresh,scope:`${key}:${revision}`}
}
