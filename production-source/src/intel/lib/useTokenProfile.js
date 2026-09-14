import {useCallback,useEffect,useState} from 'react'
import {loadTokenProfile} from './markets-api'

// Profile refresh is independent of prices, charts and research. Old requests
// cannot publish after an asset/account change. Legacy queued enrichment retains
// its bounded follow-up reads; CMC rendering is cache-only until explicit retry.
export function useTokenProfile({supabase,orgId,userId,ident}) {
 const identity=ident?JSON.stringify(ident):null
 const scope=JSON.stringify([userId,orgId,identity])
 const [saved,setSaved]=useState(null),[retry,setRetry]=useState(null)
 const refresh=useCallback(()=>setRetry(prior=>({scope,version:(prior?.version||0)+1})),[scope])
 const attempt=retry?.scope===scope?retry.version:0
 useEffect(()=>{
  if(!identity||!orgId||!userId)return
  let alive=true,timer=null,wake=null
  const controller=new AbortController()
  setSaved({scope,state:'loading',profile:null,error:null})
  ;(async()=>{
   for(const delay of [0,4000,10000]){
    if(delay)await new Promise(resolve=>{wake=resolve;timer=setTimeout(resolve,delay)})
    if(!alive)return
    try{
     const value=await loadTokenProfile(supabase,JSON.parse(identity),{orgId,refresh:attempt>0&&delay===0,signal:controller.signal})
     if(!alive)return
     setSaved({scope,...value,error:null})
     if(value.state!=='enqueued')return
    }catch{
     if(alive)setSaved({scope,profile:null,state:'error',error:'Project details could not be loaded. Retry to check the shared source.'})
     return
    }
   }
  })()
  return()=>{alive=false;controller.abort();clearTimeout(timer);wake?.()}
 },[supabase,scope,identity,orgId,userId,attempt])
 const active=saved?.scope===scope?saved:{profile:null,state:identity?'loading':null,error:null}
 return {...active,onRetry:refresh}
}
