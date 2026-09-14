import {useEffect,useRef,useState} from 'react'
import {getAssetPortfolioEvent} from './portfolio-api'
export function usePortfolioActivityTarget({supabase,userId,orgId,portfolioId,canonicalAssetKey,eventKey}){
 const scope=JSON.stringify([userId,orgId,portfolioId,canonicalAssetKey,eventKey]),active=useRef(scope);active.current=scope
 const [state,setState]=useState({scope:null,marker:null,loading:false,error:null}),[retry,setRetry]=useState(0)
 useEffect(()=>{
  if(!userId||!orgId||!portfolioId||!canonicalAssetKey||!eventKey)return
  const controller=new AbortController();let alive=true
  setState({scope,marker:null,loading:true,error:null})
  getAssetPortfolioEvent(supabase,orgId,{portfolioId,canonicalAssetKey,eventKey,signal:controller.signal})
   .then(marker=>{if(alive&&active.current===scope)setState({scope,marker,loading:false,error:null})})
   .catch(error=>{if(alive&&active.current===scope)setState({scope,marker:null,loading:false,error})})
  return()=>{alive=false;controller.abort()}
 },[supabase,userId,orgId,portfolioId,canonicalAssetKey,eventKey,scope,retry])
 return {...(state.scope===scope?state:{marker:null,error:null,loading:!!eventKey}),retry:()=>setRetry(v=>v+1)}
}
