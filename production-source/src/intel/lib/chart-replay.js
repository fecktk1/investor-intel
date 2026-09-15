import {epochMs} from './chart-history'
export const barClosedAt=bar=>Number.isFinite(bar.closedAt)?bar.closedAt:bar.o==null?bar.t:null
export function chartReplay(bars,markers,at,knownOnly=false) {
 const visible=bars.filter(b=>{const closed=barClosedAt(b);return closed!=null&&closed<=at&&(!knownOnly||Number.isFinite(b.recordedAt)&&b.recordedAt<=at)})
 const eventVisible=event=>{const t=epochMs(event.t??event.occurredAt),recorded=epochMs(event.recordedAt??event.recorded_at);return t!=null&&recorded!=null&&t<=at&&recorded<=at}
 // Linked notes have their own recording clocks; a past trade must not reveal a later review.
 const events=markers.flatMap(event=>{
  const linkedResearch=(event.linkedResearch||[]).filter(eventVisible)
  return eventVisible(event)?[{...event,linkedResearch}]:linkedResearch
 })
 return {bars:visible,events,unknownClose:bars.filter(b=>barClosedAt(b)==null).length,unknownRecording:bars.filter(b=>!Number.isFinite(b.recordedAt)).length,
  omittedEvents:markers.filter(e=>epochMs(e.t??e.occurredAt)<=at&&!eventVisible(e)).length}
}
export function replayStops(bars,knownOnly=false) {
 return [...new Set(bars.flatMap(b=>{const closed=barClosedAt(b);return closed==null||knownOnly&&!Number.isFinite(b.recordedAt)?[]:[knownOnly?Math.max(closed,b.recordedAt):closed]}))].sort((a,b)=>a-b)
}
