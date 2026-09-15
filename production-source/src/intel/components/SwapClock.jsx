import React,{useMemo} from 'react'
import {useTranslation} from 'react-i18next'
import {PolarClock,RadialBars} from '../charts'
import {fmtNum,fmtVol} from '../lib/market-format'

// Swap clock (CMC plan Stage 4, proposal 28) — the shape of the live tape.
//
// Two honest readings, and one rule shared with every other clock in Intel: an
// hour nobody streamed is a GAP, never a zero. "No swap happened" and "nobody
// was listening" are different facts, and the tape can only ever speak for the
// minutes a lease was actually held. So an hour is a value only when the tape
// carries at least one event stamped inside it; every other hour is null and
// reads as "not streamed".

export const SWAP_CLOCK_HOURS=24
const hourText=hour=>`${String(hour).padStart(2,'0')}:00`

/** Swap value by hour of the reader's day. Hours come from the reader's clock,
 * because that is the clock the PolarClock's "now" marker uses. */
export function swapClockBuckets(events) {
  const swapped=new Array(SWAP_CLOCK_HOURS).fill(0),streamed=new Array(SWAP_CLOCK_HOURS).fill(false)
  for(const event of Array.isArray(events)?events:[]){
    const at=Date.parse(event?.observedAt)
    if(!Number.isFinite(at))continue
    const hour=new Date(at).getHours()
    // ANY streamed event proves the hour was observed; only a swap adds value.
    streamed[hour]=true
    if(event.metric==='swap_event_usd'&&Number.isFinite(Number(event.value)))swapped[hour]+=Number(event.value)
  }
  return swapped.map((value,hour)=>({label:hourText(hour),hour,value:streamed[hour]?value:null,streamed:streamed[hour]}))
}

/** Unique trader counts by provider window. One reading per window — the newest
 * — because a window count is a restatement of the same window, not a new
 * measurement to add to the last one. */
export function traderWindows(events) {
  const newest=new Map()
  for(const event of Array.isArray(events)?events:[]){
    if(event?.metric!=='unique_traders')continue
    const at=Date.parse(event.observedAt)
    if(!Number.isFinite(at)||!Number.isFinite(Number(event.value)))continue
    const key=event.metadata?.window??(event.periodSeconds!=null?String(event.periodSeconds):'window not reported')
    const previous=newest.get(key)
    if(!previous||at>previous.at)newest.set(key,{key,at,value:Number(event.value),observedAt:event.observedAt})
  }
  const rows=[...newest.values()].sort((a,b)=>b.value-a.value||a.key.localeCompare(b.key))
  const max=Math.max(0,...rows.map(row=>row.value))
  // One shared scale: the largest window fills its arc and the rest are read
  // against it. A single window is its own scale, never an invented ceiling.
  return rows.map(row=>({...row,label:row.key,max:max>0?max:1}))
}

export default function SwapClock({events,started=false,state='paused'}) {
  const {t}=useTranslation('intel',{useSuspense:false})
  const buckets=useMemo(()=>swapClockBuckets(events),[events])
  const windows=useMemo(()=>traderWindows(events),[events])
  const streamedHours=buckets.filter(bucket=>bucket.streamed).length
  const drawn=streamedHours>0

  const caption=t('live_tape.clock_caption',{
    defaultValue:'Swap value summed into the hour of the reader’s day it was streamed in. An hour with no streamed event at all stays a gap, never a zero, because the tape can only speak for the minutes a lease was held.',
  })
  const formatUsd=value=>value==null
    ? t('live_tape.not_streamed',{defaultValue:'Not streamed'})
    : fmtVol(value)

  return <div className="intel-swap-clock space-y-3" data-testid="swap-clock">
    <PolarClock
      title={t('live_tape.clock_title',{defaultValue:'Swap clock'})}
      description={caption}
      period="24h"
      buckets={buckets}
      formatValue={formatUsd}
      state={drawn?'ready':'empty'}
    />
    <p className="text-[12px] text-[var(--fg-4)]" data-testid="swap-clock-coverage">
      {drawn
        ? t('live_tape.clock_streamed',{streamed:streamedHours,hours:SWAP_CLOCK_HOURS,
          defaultValue:'{{streamed}} of the last {{hours}} hours carry a streamed event; the rest are gaps.'})
        : started&&state!=='disabled'
          ? t('live_tape.clock_waiting',{defaultValue:'No on-chain event has been streamed yet, so no hour of the clock carries a reading.'})
          : t('live_tape.clock_none',{defaultValue:'Nothing has been streamed for this contract, so the clock has no hours to draw. This is an absence of stream, not an absence of trading.'})}
    </p>
    {windows.length>0
      ? <RadialBars
        title={t('live_tape.traders_title',{defaultValue:'Unique traders by window'})}
        description={t('live_tape.traders_caption',{defaultValue:'Provider-reported unique on-chain trader accounts for each window it published. Accounts, not people, and read against the largest window on screen.'})}
        series={windows.map(window=>({key:window.key,label:window.label,value:window.value,max:window.max}))}
        formatValue={fmtNum}
      />
      : <p className="text-[12px] text-[var(--fg-4)]" data-testid="swap-clock-traders-empty">
        {t('live_tape.traders_none',{defaultValue:'No unique-trader window has been streamed for this contract, so no trader count is drawn.'})}
      </p>}
  </div>
}
