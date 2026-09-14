import {useCallback,useEffect,useRef,useState} from 'react'
import {requestChartWorkspace} from './chart-workspace-api'

const EMPTY={markers:[],nextCursor:null,error:null,loading:false}
const actions={draft_created:'Chart condition drafted',created_active:'Chart condition activated',activated:'Chart condition activated',paused:'Chart condition paused',edited:'Chart condition edited',crossed:'Chart level crossed'}
export function chartAlertMarkers(rows){return (rows||[]).map(row=>{
 const config=row.detail?.config||row.event_config,previous=row.detail?.previousConfig,changes={}
 if(previous&&config)for(const field of ['threshold_usd','direction','note','title','asset','condition','repeat','hysteresis_pct','sustain_minutes'])if(JSON.stringify(previous[field])!==JSON.stringify(config[field]))changes[field]={before:previous[field],after:config[field]}
 const checkpoint=row.detail?.checkpoint,action=row.action==='crossed'&&config?.condition==='sustained'?'Chart sustained condition met':actions[row.action]||'Chart condition activity'
 return {id:`chart-alert:${row.id}`,t:Date.parse(row.occurred_at),recordedAt:row.recorded_at,group:'rules',type:'chart_alert',label:action,action,actorKind:row.action==='crossed'?'system':'user',title:config?.title,note:config?.note,changes,source:checkpoint?.source||'Your saved chart condition',transactionRef:checkpoint?.observationId||null,priceSource:checkpoint?.gapNotice||null,
  status:row.action==='crossed'?(config?.condition==='sustained'?'Observed sustained condition; the path between checks is unknown':'Observed between sampled quotes'):row.detail?.active?'Active':'Draft / paused',condition:config?{level:config.threshold_usd,direction:config.direction,anchor:config.anchor,revision:row.revision,behavior:config.condition,repeat:config.repeat,sustainMinutes:config.sustain_minutes,hysteresisPct:config.hysteresis_pct}:null}
}).filter(row=>Number.isFinite(row.t))}

export function useChartAlertHistory(context,from,to,scopeKey=''){
 const scope=JSON.stringify([context?.userId,context?.orgId,context?.portfolioId,context?.asset,from,to,scopeKey]),enabled=!!(context?.supabase&&context?.userId&&context?.orgId&&context?.asset&&Number.isFinite(from)&&Number.isFinite(to))
 const active=useRef(scope),generation=useRef(0),pending=useRef(false);active.current=scope
 const [state,setState]=useState({...EMPTY,scope:null})
 const read=useCallback(async(cursor=null)=>{
  if(!enabled||pending.current)return
  pending.current=true;const request=++generation.current
  setState(s=>cursor?{...s,loading:true,error:null}:{...EMPTY,scope,loading:true})
  try{const data=await requestChartWorkspace(context,{operation:'alert_history',asset:context.asset,from,to,cursor});if(active.current!==scope||generation.current!==request)return
   setState(s=>({...EMPTY,scope,nextCursor:data.nextCursor,markers:[...new Map([...(cursor?s.markers:[]),...chartAlertMarkers(data.rows)].map(row=>[row.id,row])).values()]}))
  }catch{if(active.current===scope&&generation.current===request)setState(s=>cursor?{...s,error:'More chart conditions could not be loaded. Retry from this chart.',loading:false}:{...EMPTY,scope,error:'Your chart condition history is temporarily unavailable. Your saved conditions remain in Alerts.'})}
  finally{if(request===generation.current)pending.current=false}
 },[scope,enabled,context?.supabase]) // eslint-disable-line react-hooks/exhaustive-deps
 useEffect(()=>{pending.current=false;void read();return()=>{generation.current++;pending.current=false}},[read])
 useEffect(()=>{if(!enabled)return;const refresh=e=>{if(e.type==='visibilitychange'&&document.visibilityState!=='visible')return;if(e.detail?.orgId&&e.detail.orgId!==context.orgId)return;pending.current=false;void read()};const timer=setInterval(()=>{if(document.visibilityState==='visible')refresh({})},60000);window.addEventListener('intel:chart-alert-changed',refresh);document.addEventListener('visibilitychange',refresh);return()=>{clearInterval(timer);window.removeEventListener('intel:chart-alert-changed',refresh);document.removeEventListener('visibilitychange',refresh)}},[read,enabled,context?.orgId])
 const visible=state.scope===scope?state:{...EMPTY,loading:enabled}
 return {...visible,loadMore:()=>{if(visible.nextCursor)void read(visible.nextCursor)}}
}
