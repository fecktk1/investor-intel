import {useEffect,useState} from 'react'

// Refresh only the small quote response. Do not rerun news, AI, holdings or the
// entire asset dossier once a minute. Hidden tabs stop polling.
export function useMarketQuote({supabase,orgId,userId,detail}){
 const scope=JSON.stringify([userId,orgId,detail?.sourceProvider,detail?.providerId])
 const [saved,setSaved]=useState(null),[error,setError]=useState(null)
 const seconds=detail?.quoteRefreshSeconds
 useEffect(()=>{
  setSaved(null);setError(null)
  if(!orgId||!userId||!detail?.providerId||!detail?.quoteProvider||![60,300].includes(seconds))return
  let alive=true,busy=false
  const refresh=async()=>{
   if(busy||document.visibilityState==='hidden')return
   busy=true
   try{
    const {data,error}=await supabase.functions.invoke('intel-markets',{body:{orgId,sourceProvider:detail.sourceProvider,providerId:detail.providerId,quotesOnly:true}})
    if(!alive)return
    if(error||data?.error||data?.sourceProvider!==detail.sourceProvider||String(data?.providerId)!==String(detail.providerId))throw new Error('quote_unavailable')
    const observed=Date.parse(data.asOf||'')
    if(!Number.isFinite(observed)||observed>Date.now()+30000)throw new Error('quote_time_unavailable')
    setSaved(prior=>observed>=Date.parse(prior?.data.asOf||detail.asOf||'1970-01-01')?{scope,data}:prior);setError(null)
   }catch{if(alive)setError({scope,message:'The latest quote is unavailable. Showing the last recorded price.'})}
   finally{busy=false}
  }
  // A stale first response may have started one shared background refresh.
  // Rejoin it through the small endpoint rather than leaving the old quote
  // displayed for another full five-minute interval.
  const catchup=detail.sourceFreshness==='stale'?setTimeout(refresh,250):null
  const timer=setInterval(refresh,seconds*1000)
  const resume=()=>{if(document.visibilityState!=='hidden')refresh()}
  document.addEventListener('visibilitychange',resume)
  return()=>{alive=false;clearInterval(timer);if(catchup)clearTimeout(catchup);document.removeEventListener('visibilitychange',resume)}
 },[supabase,scope,seconds]) // eslint-disable-line react-hooks/exhaustive-deps
 return {quote:saved?.scope===scope?saved.data:null,error:error?.scope===scope?error.message:null}
}
