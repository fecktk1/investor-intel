import React,{useEffect,useRef,useState} from 'react'
import {useTranslation} from 'react-i18next'

export const REPLAY_SPEEDS=[0.5,1,2,4]
export const replayStepMs=speed=>Math.max(50,Math.round(1000/(Number(speed)||1)))

export default function ChartReplayControls({stops,at,onTime,knownOnly,onKnownOnly,onExit,gaps}) {
 const {t}=useTranslation('intel',{useSuspense:false})
 const [playing,setPlaying]=useState(false),[speed,setSpeed]=useState(1)
 const index=stops.findLastIndex(stop=>stop<=at),last=stops.at(-1)
 const ended=stops.length>0&&index>=stops.length-1
 // While playing, the timer owns the playhead. Reading the index out of a
 // closure made every re-render restart the interval and every batched tick
 // repeat the same bar, so the cursor stood still; the ref advances instead and
 // re-syncs from the chart whenever playback is stopped or the cursor is moved.
 const playIndex=useRef(index),latest=useRef({stops,onTime});latest.current={stops,onTime}
 useEffect(()=>{if(!playing)playIndex.current=index},[index,playing])
 useEffect(()=>{setPlaying(false)},[knownOnly])
 useEffect(()=>{
  if(!playing)return
  const hide=()=>{if(document.hidden)setPlaying(false)}
  document.addEventListener('visibilitychange',hide)
  const timer=setInterval(()=>{
   if(document.hidden){setPlaying(false);return}
   const list=latest.current.stops,next=playIndex.current+1
   if(next>=list.length){setPlaying(false);return}
   playIndex.current=next
   latest.current.onTime(list[next])
  },replayStepMs(speed))
  return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',hide)}
 },[playing,speed])
 const move=position=>{setPlaying(false);playIndex.current=position;onTime(stops[position])}
 return <div className="intel-chart-replay" role="group" aria-label={t('chart.replay.region',{defaultValue:'Historical chart replay'})}>
  <div className="intel-chart-navigation">
   <button type="button" disabled={index<=0} onClick={()=>move(index-1)}>{t('chart.replay.previous',{defaultValue:'Previous bar'})}</button>
   <button type="button" disabled={!stops.length||at>=last} onClick={()=>setPlaying(v=>!v)}>{playing?t('chart.replay.pause',{defaultValue:'Pause replay'}):t('chart.replay.play',{defaultValue:'Play replay'})}</button>
   <button type="button" disabled={index>=stops.length-1} onClick={()=>move(index+1)}>{t('chart.replay.next',{defaultValue:'Next bar'})}</button>
   <button type="button" onClick={onExit}>{t('chart.replay.exit',{defaultValue:'Exit replay'})}</button>
   <label className="intel-workstation-check">{t('chart.replay.speed',{defaultValue:'Speed'})}<select value={speed} onChange={e=>setSpeed(Number(e.target.value))}>{REPLAY_SPEEDS.map(rate=><option key={rate} value={rate}>{t('chart.replay.speed_option',{rate,defaultValue:'{{rate}}× per second'})}</option>)}</select></label>
   <label className="intel-workstation-check"><input type="checkbox" checked={knownOnly} onChange={e=>{setPlaying(false);onKnownOnly(e.target.checked)}}/>{t('chart.replay.known_only',{defaultValue:'Only data recorded by then'})}</label>
  </div>
  <label className="intel-replay-clock">{t('chart.replay.through',{defaultValue:'Replay through'})} <time dateTime={Number.isFinite(at)?new Date(at).toISOString():undefined}>{new Date(at).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'long'})}</time><input type="range" aria-label={t('chart.replay.bar_slider',{defaultValue:'Replay bar'})} min={0} max={Math.max(0,stops.length-1)} value={Math.max(0,index)} disabled={!stops.length} onChange={e=>move(Number(e.target.value))}/></label>
  {ended&&<p role="status" className="intel-analysis-caption">{t('chart.replay.ended',{defaultValue:'Replay reached the last loaded bar. Step back, or exit replay to return to the live chart.'})}</p>}
  <p className="intel-analysis-caption">{knownOnly?t('chart.replay.note_recorded',{defaultValue:'Recorded evidence replay. Later-recorded bars and notes are hidden.'}):t('chart.replay.note_historical',{defaultValue:'Historical bar replay. Later source corrections may be present; this does not prove what was known then.'})} {gaps.unknownClose>0&&`${t('chart.replay.gap_unknown_close',{bars:gaps.unknownClose,defaultValue:'{{bars}} bars omitted because their close time is unverified.'})} `}{knownOnly&&gaps.unknownRecording>0&&`${t('chart.replay.gap_unknown_recording',{bars:gaps.unknownRecording,defaultValue:'{{bars}} bars lack a recording timestamp.'})} `}{gaps.omittedEvents>0&&`${t('chart.replay.gap_omitted_events',{events:gaps.omittedEvents,defaultValue:'{{events}} past events have no eligible recording history.'})} `}{t('chart.replay.note_hidden',{defaultValue:'Saved drawings and undated levels are hidden during replay.'})}</p>
 </div>
}
