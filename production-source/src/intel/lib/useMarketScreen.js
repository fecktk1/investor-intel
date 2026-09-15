import {useCallback,useEffect,useRef,useState} from 'react'
import {loadMarkets} from './markets-api'
/** Five-minute cached screen reads, with immediate owner and catalogue isolation. */
export function useMarketScreen({supabase,userId,orgId,params,enabled=true}){
 const key=JSON.stringify([userId,orgId,params]),[state,setState]=useState(null),refreshRef=useRef(null)
 useEffect(()=>{
  if(!enabled||!userId||!orgId)return
  let alive=true,busy=false
  const load=async()=>{
   if(busy||document.visibilityState==='hidden')return
   busy=true;setState(prior=>({key,data:prior?.key===key?prior.data:null,pending:true,error:null}))
   try{const data=await loadMarkets(supabase,orgId,params);if(alive)setState({key,data,pending:false,error:null})}
   catch{if(alive)setState(prior=>({key,data:prior?.key===key?prior.data:null,pending:false,error:'Market data could not be refreshed. Try again.'}))}
   finally{busy=false}
  }
  refreshRef.current=load
  const first=setTimeout(load,params.search?200:0),timer=setInterval(load,300000)
  const resume=()=>{if(document.visibilityState!=='hidden')load()}
  document.addEventListener('visibilitychange',resume)
  return()=>{alive=false;clearTimeout(first);clearInterval(timer);document.removeEventListener('visibilitychange',resume);if(refreshRef.current===load)refreshRef.current=null}
 },[supabase,key,enabled]) // eslint-disable-line react-hooks/exhaustive-deps
 const refresh=useCallback(()=>refreshRef.current?.(),[])
 return {data:enabled&&state?.key===key?state.data:null,pending:enabled&&(state?.key!==key||state.pending),error:enabled&&state?.key===key?state.error:null,refresh}
}
