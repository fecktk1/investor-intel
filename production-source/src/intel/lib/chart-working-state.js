import {useEffect,useRef,useState} from 'react'

import {validateChartLayout} from '../../../supabase/functions/_shared/intel/chart-workspace-contract'
import {readChartWorkingState} from './chart-workspace-api'

/** How long the chart stays quiet before its working state is written back. */
export const WORKING_STATE_DEBOUNCE_MS=2000

// A member who was reading the live edge expects the live edge when they return:
// two days later the same window should end at now, and the drawings they left
// simply sit further left on it. A member who had deliberately scrolled BACK to
// an older stretch of history expects that stretch, not today. The two are told
// apart by where the saved window ended relative to the moment it was saved: at
// the live edge, or a meaningful distance behind it.
const LIVE_EDGE=0.05
const span=range=>range&&Number.isFinite(range.from)&&Number.isFinite(range.to)&&range.to>range.from?range.to-range.from:null

/**
 * The window to open on. A window that was at the live edge keeps its WIDTH and
 * ends at `now`, so time having passed simply moves the drawings left. A window
 * the member had scrolled back to is returned exactly as it was left.
 */
export function workingViewRange(range,now,savedAt=null) {
 const width=span(range)
 if(width==null)return null
 const live=!Number.isFinite(savedAt)||range.to>=savedAt-width*LIVE_EDGE
 return Number.isFinite(now)&&now>range.to&&live?{from:Math.max(0,now-width),to:now}:{from:range.from,to:range.to}
}

/**
 * The range button a saved window belongs under: the narrowest offered window
 * that still holds it, so the chart loads the history the view actually needs.
 * `windows` is the range vocabulary, mapped to milliseconds.
 */
export function workingRangePreset(range,windows) {
 const width=span(range)
 const keys=width==null?[]:Object.keys(windows||{})
 if(!keys.length)return null
 return keys.filter(key=>windows[key]>=width).sort((a,b)=>windows[a]-windows[b])[0]||keys.sort((a,b)=>windows[b]-windows[a])[0]
}

/**
 * The candle width control speaks '1M' for ONE MINUTE; the stored contract speaks
 * '1m'. This maps a stored width back to the exact choice the control offers, and
 * answers null for a width this asset cannot be asked for.
 */
export function workingCandleInterval(interval,choices) {
 if(typeof interval!=='string'||!interval||interval==='auto')return null
 return (choices||[]).find(choice=>String(choice).toLowerCase()===interval.toLowerCase())||null
}

/** The stored state as the workstation's initial state, with its window moved to now. */
export function workingInitialState(state,now,savedAt=null) {
 if(!state||typeof state!=='object')return null
 const range=workingViewRange(state.range,now,savedAt)
 return range?{...state,range}:{...state}
}

export const usableChartContext=context=>!!(context?.supabase&&context.userId&&context.orgId&&context.asset)
const usable=usableChartContext

/**
 * The chart's latest draft, held outside React so the workstation reporting a
 * change costs no render, and so the saver can arrive late and still find what
 * the member has already done. The same small store shape the drawing preview uses.
 */
export function workingDraftStore() {
 let value=null
 const listeners=new Set()
 return {get:()=>value,set:next=>{value=next;for(const listener of listeners)listener(next)},subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener)}}
}

/**
 * Reads the member's working state for one asset ONCE, before the chart is built.
 * A read that fails never holds the chart back: the member gets a fresh chart and
 * the reason is reported beside it rather than a spinner that never ends.
 */
const waiting=key=>({key,loading:!!key,working:null,error:null})
export function useChartWorkingState(context,{read=readChartWorkingState}={}) {
 const key=usable(context)?`${context.userId}:${context.orgId}:${context.asset}`:''
 const [state,setState]=useState(()=>waiting(key))
 const live=useRef(null);live.current={context,read}
 useEffect(()=>{
  const {context:current,read:load}=live.current
  if(!key||!usable(current)){setState({...waiting(key),loading:false});return}
  let alive=true
  Promise.resolve(load(current,current.asset))
   .then(working=>{if(alive)setState({key,loading:false,working:working||null,error:null})})
   .catch(error=>{if(alive)setState({...waiting(key),loading:false,error:error?.message||'unavailable'})})
  return()=>{alive=false}
 },[key])
 // A chart that has just been named is loading from the FIRST RENDER that names
 // it, not from the effect a paint later: waiting for the effect would mount the
 // chart unrestored, unmount it and mount it again.
 return state.key===key?state:waiting(key)
}
