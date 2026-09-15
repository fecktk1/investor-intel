import {useCallback,useEffect,useMemo,useRef,useState} from 'react'
import {useProfile} from '../../lib/profile-context'
import {useSupabase} from '../../lib/useSupabase'
import {invokeInvestigation} from './useInvestigation'
import {cmcDexIdentity} from '../../../supabase/functions/_shared/market-assets/cmc-dex.ts'
import {dexLiquidityMarkers} from './dex-evidence-markers'
import {projectDexEvidence} from './dex-evidence-projection'

/** Read retained public events only. No market refresh, wallet sync or AI call.
 * Owner/range changes discard old UI state synchronously and cancel its read. */
export function useContractChartEvidence({canonicalKey,from,to,portfolioId}){
 const {org}=useProfile(),{user,supabase}=useSupabase(),identity=cmcDexIdentity(canonicalKey)
 const subject=identity?.subject,windowFrom=Math.max(from,to-90*86400000),enabled=!!(subject&&user?.id&&org?.id&&Number.isFinite(windowFrom)&&Number.isFinite(to)&&windowFrom<to)
 const key=JSON.stringify([user?.id,org?.id,portfolioId,subject,windowFrom,to]),active=useRef(key);active.current=key
 const [state,setState]=useState({key:null,observations:[],cursor:null,loading:false,error:null,hasMore:false})
 const pending=useRef(null),sequence=useRef(0)
 const load=useCallback(async(cursor=null)=>{
  if(!enabled||active.current!==key)return
  pending.current?.abort();const controller=new AbortController();pending.current=controller;const request=++sequence.current
  setState(s=>({...(s.key===key?s:{observations:[],cursor:null,hasMore:false}),key,loading:true,error:null}))
  try{
   const data=await invokeInvestigation(supabase,{orgId:org.id,subject,lens:'liquidity',operation:'history',from:windowFrom,to,limit:100,metrics:['liquidity_event_usd','swap_event_usd'],...(cursor?{cursor}:{})},controller.signal)
   if(!Array.isArray(data?.observations)||typeof data.hasMore!=='boolean'||(data.hasMore&&!data.nextCursor))throw new Error('invalid_history_response')
   const rows=data.observations.filter(o=>o.subject===subject&&Date.parse(o.observedAt)>=windowFrom&&Date.parse(o.observedAt)<=to)
   if(!controller.signal.aborted&&active.current===key&&sequence.current===request)setState(s=>({key,observations:[...new Map([...(cursor&&s.key===key?s.observations:[]),...rows].map(o=>[o.id,o])).values()],cursor:data.nextCursor,hasMore:data.hasMore,loading:false,error:null}))
  }catch(e){if(!controller.signal.aborted&&active.current===key&&sequence.current===request)setState(s=>({...s,key,loading:false,error:'Public market history could not be read.'}))}
 },[enabled,key,org?.id,subject,windowFrom,to,supabase])
 useEffect(()=>{void load();return()=>pending.current?.abort()},[load])
 const acceptEvidence=useCallback(data=>{
  if(!enabled||active.current!==key||data?.canonicalKey!==subject)return
  const rows=(data.observations||[]).filter(o=>o.subject===subject&&Date.parse(o.observedAt)>=windowFrom&&Date.parse(o.observedAt)<=to)
  if(rows.length)setState(s=>({...s,key,observations:[...new Map([...(s.key===key?s.observations:[]),...rows].map(o=>[o.id,o])).values()]}))
 },[enabled,key,subject,windowFrom,to])
 const current=state.key===key?state:{observations:[],cursor:null,loading:enabled,error:null,hasMore:false}
 const markers=useMemo(()=>enabled?dexLiquidityMarkers(projectDexEvidence(current.observations,to),subject,to):[],[enabled,current.observations,subject,to])
 return {...current,enabled,windowFrom,rangeLimited:windowFrom>from,markers,refresh:()=>load(),loadMore:()=>current.hasMore&&!current.loading?load(current.cursor):Promise.resolve(),acceptEvidence}
}
