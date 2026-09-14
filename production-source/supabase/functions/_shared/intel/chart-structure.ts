import {normalizeBars,period,type Bar} from './chart-analysis.ts'
import {validateDrawing} from './chart-workspace-contract.ts'

export const STRUCTURE_VERSION='structure-1'
export type StructureFinding={id:string;kind:string;label:string;t:number;confirmedAt:number;knownAt:number|null;price:number;lower?:number;upper?:number;pivotId?:string;classification?:string;brokenAt?:number;filledAt?:number;distanceAtr?:number|null;definition:string;window:number;methodVersion?:string}
export const STRUCTURE_DEFINITIONS={
 pivot:'A strict high or low above or below every other bar in a symmetric window. It is confirmed only when the right-hand bars have closed. Equal extremes do not qualify.',
 break:'The close crosses a previously confirmed pivot level. A wick alone is not a close break. Only the first break of each tracked pivot is recorded.',
 retest:'After a close break, a later bar touches the level and closes on the breakout side. This describes a bar, not a prediction of a successful trade.',
 sweep:'A wick crosses a confirmed, unbroken pivot and the close returns to its original side. This is a sweep candidate; candles cannot establish intent or stop orders.',
 gap:'A three-bar wick gap: the third low exceeds the first high, or the third high is below the first low. Fill means a later wick reaches the far edge. This heuristic does not establish fair value.',
}
const closeTime=(b:Bar)=>Number.isFinite(b.closedAt)?b.closedAt!:null
const knownTime=(bars:Bar[])=>bars.every(b=>Number.isFinite(b.recordedAt))?Math.max(...bars.map(b=>b.recordedAt!)):null

/** Only complete, contiguous OHLC windows participate. Replay never consumes
 * future right-hand bars, and known-only replay also requires capture clocks. */
export function chartStructure(input:Bar[],options:{at:number;intervalMs:number|null;window?:number;atrPeriod?:number;knownOnly?:boolean}) {
 const window=period(options.window,2,1,10),atrPeriod=period(options.atrPeriod,14,2,100),step=options.intervalMs
 if(!Number.isFinite(options.at))throw new Error('invalid_structure_time')
 const normalized=normalizeBars(input),validInterval=Number.isSafeInteger(step)&&step!>=1000
 const eligible=normalized.bars.filter(b=>b.o!=null&&b.h!=null&&b.l!=null&&closeTime(b)!=null&&closeTime(b)!<=options.at&&(!options.knownOnly||b.recordedAt!=null&&b.recordedAt<=options.at))
 const pivots:StructureFinding[]=[],events:StructureFinding[]=[],gaps:StructureFinding[]=[]
 const omitted=normalized.rejected+normalized.bars.length-eligible.length
 const coverage='Descriptive calculations from completed OHLC bars. Missing bars reset the window. The 80 most recent pivots and gaps per continuous segment are tracked; results show up to 250 levels, 500 events and 250 gaps. These are heuristic observations, not trade probabilities.'
 if(!validInterval)return {version:STRUCTURE_VERSION,pivots,events,gaps,atr:null,window,omitted,coverage,reason:'A verified bar interval is required for structure analysis.',asOf:options.at}
 let segment:Bar[]=[],active:StructureFinding[]=[],openGaps:StructureFinding[]=[],lastHigh:number|null=null,lastLow:number|null=null,atr:number|null=null,trSeed:number[]=[],last:Bar|undefined
 const retested=new Set<string>(),swept=new Set<string>()
 for(const b of eligible){
  if(!last||b.t-last.t!==step){segment=[];active=[];openGaps=[];lastHigh=null;lastLow=null;atr=null;trSeed=[];last=undefined}
  const tr=last?Math.max(b.h!-b.l!,Math.abs(b.h!-last.c),Math.abs(b.l!-last.c)):b.h!-b.l!
  if(atr==null){trSeed.push(tr);if(trSeed.length===atrPeriod)atr=trSeed.reduce((s,v)=>s+v,0)/atrPeriod}else atr+=(tr-atr)/atrPeriod
  const confirmedAt=closeTime(b)!,event=(kind:string,p:StructureFinding,label:string)=>{const priorKnown=p.knownAt,barKnown=knownTime(last?[last,b]:[b]);events.push({id:`${kind}:${p.id}:${b.t}`,kind,label,t:b.t,confirmedAt,knownAt:priorKnown!=null&&barKnown!=null?Math.max(priorKnown,barKnown):null,price:p.price,pivotId:p.id,definition:STRUCTURE_DEFINITIONS[kind as 'break'|'retest'|'sweep'],window})}
  for(const p of active){
   const high=p.kind==='high',outside=high?b.c>p.price:b.c<p.price,wasInside=last&&(high?last.c<=p.price:last.c>=p.price)
   if(p.brokenAt==null){
    if(outside&&wasInside){p.brokenAt=confirmedAt;event('break',p,high?'Close above swing high':'Close below swing low')}
    else if(wasInside&&!outside&&(high?b.h!>p.price&&b.c<=p.price:b.l!<p.price&&b.c>=p.price)&&!swept.has(p.id)){swept.add(p.id);event('sweep',p,high?'Upper sweep candidate':'Lower sweep candidate')}
   }else if(confirmedAt>p.brokenAt&&!retested.has(p.id)&&(high?b.l!<=p.price&&b.c>=p.price:b.h!>=p.price&&b.c<=p.price)){
    retested.add(p.id);event('retest',p,high?'Retest above broken high':'Retest below broken low')
   }
  }
  for(const g of openGaps)if(g.filledAt==null&&(g.kind==='gap_up'?b.l!<=g.lower!:b.h!>=g.upper!))g.filledAt=confirmedAt
  segment.push(b)
  const i=segment.length-1
  if(i>=2){
   const first=segment[i-2],up=b.l!>first.h!,down=b.h!<first.l!
   if(up||down){const lower=up?first.h!:b.h!,upper=up?b.l!:first.l!;const g:StructureFinding={id:`gap:${b.t}:${up?'up':'down'}`,kind:up?'gap_up':'gap_down',label:up?'Upward wick gap':'Downward wick gap',t:first.t,confirmedAt,knownAt:knownTime(segment.slice(-3)),price:(lower+upper)/2,lower,upper,definition:STRUCTURE_DEFINITIONS.gap,window};gaps.push(g);openGaps.push(g);openGaps=openGaps.slice(-80)}
  }
  if(i>=2*window){
   const j=i-window,candidate=segment[j],slice=segment.slice(j-window,j+window+1)
   for(const kind of ['high','low'] as const){
    const value=kind==='high'?candidate.h!:candidate.l!,strict=slice.every((other,k)=>k===window||(kind==='high'?value>other.h!:value<other.l!))
    if(!strict)continue
    const previous=kind==='high'?lastHigh:lastLow
    const classification=previous==null?(kind==='high'?'H':'L'):kind==='high'?(value>previous?'HH':value<previous?'LH':'EH'):(value>previous?'HL':value<previous?'LL':'EL')
    const p:StructureFinding={id:`pivot:${kind}:${candidate.t}:${window}`,kind,label:kind==='high'?'Confirmed swing high':'Confirmed swing low',classification,t:candidate.t,confirmedAt,knownAt:knownTime(slice),price:value,definition:STRUCTURE_DEFINITIONS.pivot,window}
    pivots.push(p);active.push(p);active=active.slice(-80)
    if(kind==='high')lastHigh=value;else lastLow=value
   }
  }
  last=b
 }
 const lastPrice=eligible.at(-1)?.c
 return {version:STRUCTURE_VERSION,pivots:pivots.slice(-250).map(p=>({...p,distanceAtr:atr!=null&&atr>0&&lastPrice!=null?(p.price-lastPrice)/atr:null})),events:events.slice(-500),gaps:gaps.slice(-250),atr,window,omitted,coverage,reason:eligible.length<2*window+1?'More completed, contiguous OHLC bars are needed to confirm a swing.':null,asOf:options.at}
}

/** A kept finding uses the existing private drawing/snapshot audience controls. */
export function structureDrawing(finding:StructureFinding,id:string,source:string){
 const text=`${finding.label}${finding.classification?` (${finding.classification})`:''}\n${finding.methodVersion||STRUCTURE_VERSION}; ${finding.window} bars on each side. Confirmed ${new Date(finding.confirmedAt).toISOString()}. Source: ${source.slice(0,120)}. ${finding.definition}`
 return validateDrawing({id,tool:finding.lower!=null&&finding.upper!=null&&finding.lower!==finding.upper?'rectangle':'ray',anchors:finding.lower!=null&&finding.upper!=null&&finding.lower!==finding.upper?[{t:finding.t,price:finding.lower},{t:finding.confirmedAt,price:finding.upper}]:[{t:finding.t,price:finding.price},{t:finding.confirmedAt,price:finding.price}],text,color:'#DFA647',width:1})
}
