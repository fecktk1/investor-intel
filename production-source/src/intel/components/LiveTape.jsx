import React,{useCallback,useEffect,useMemo,useRef,useState} from 'react'
import {useTranslation} from 'react-i18next'
import {useProfile} from '../../lib/profile-context'
import {useSupabase} from '../../lib/useSupabase'
import {liveTapeIdentity,readLiveTape,touchLiveTape,LIVE_TAPE_POLL_MS,LIVE_TAPE_TOUCH_MS} from '../lib/live-tape-api'
import {liveTapeMarkers} from '../lib/dex-evidence-markers'
import {explorerTxUrl} from '../lib/chains'
import {fmtNum,fmtVol} from '../lib/market-format'
import SwapClock from './SwapClock'

// Live on-chain tape (CMC plan Stage 4, proposal 28).
// docs/investor-intel/live-on-chain-tape.md
//
// The panel is honest about one thing above all: the collector that would fill
// this tape is behind the worker release gate (G2) and the
// CMC_LIVE_ONCHAIN_ENABLED switch, both unset today. So starting the tape does
// NOT mean a tape is live. A lease that was never granted answers no
// `expiresAt`, and that absence — not a message we compose — is what puts this
// panel into its "channels are not enabled yet" state. Nothing here ever draws a
// placeholder tick, a simulated swap or an assumed viewer count.

export const LIVE_TAPE_ROWS=50

/** One readable state from the two answers. Exported because it is the whole
 * honesty of this panel: `disabled` is a lease that was refused, `waiting` is a
 * lease that is held over a quiet contract, and they are not the same thing. */
export function liveTapeState({started,touch,tape}) {
  if(!started)return 'paused'
  if(touch&&touch.ok===false)return 'error'
  if(!touch)return 'starting'
  if(touch.expiresAt==null)return 'disabled'
  return tape?.events?.length?'streaming':'waiting'
}

const shortTx=value=>{
  const text=String(value||'')
  return text.length>18?`${text.slice(0,8)}…${text.slice(-6)}`:text||null
}
const clockTime=iso=>{
  const at=Date.parse(iso)
  return Number.isFinite(at)?new Date(at).toLocaleTimeString():String(iso??'')
}

export default function LiveTape({canonicalKey,onMarkers}) {
  const {t}=useTranslation('intel',{useSuspense:false})
  const {org}=useProfile()
  const {supabase,user}=useSupabase()
  const identity=useMemo(()=>liveTapeIdentity(canonicalKey),[canonicalKey])
  const [started,setStarted]=useState(false)
  const [touch,setTouch]=useState(null)
  const [tape,setTape]=useState(null)
  const orgId=org?.id,subject=identity?.subject??null
  const markersRef=useRef(onMarkers);markersRef.current=onMarkers

  useEffect(()=>{
    if(!started||!subject||!orgId||!user?.id)return
    let alive=true
    const viewId=crypto.randomUUID(),controller=new AbortController()
    setTouch(null);setTape(null)
    const hold=async()=>{
      const answer=await touchLiveTape(supabase,{orgId,canonicalKey,enabled:true,viewId,signal:controller.signal})
      if(alive)setTouch(answer)
    }
    const poll=async()=>{
      const answer=await readLiveTape(supabase,{orgId,canonicalKey,signal:controller.signal})
      if(alive)setTape(answer)
    }
    void hold();void poll()
    // The lease is 45 s; refresh at 30 s so a slow round trip never drops it.
    const lease=setInterval(()=>void hold(),LIVE_TAPE_TOUCH_MS)
    const reader=setInterval(()=>void poll(),LIVE_TAPE_POLL_MS)
    return()=>{
      alive=false;clearInterval(lease);clearInterval(reader);controller.abort()
      // Release on its own transport: the aborted controller would cancel it,
      // and a lease nobody releases keeps a collector slot for 45 seconds.
      void touchLiveTape(supabase,{orgId,canonicalKey,enabled:false,viewId})
    }
  },[started,subject,orgId,user?.id,canonicalKey,supabase])

  const events=useMemo(()=>tape?.events??[],[tape])
  const at=useMemo(()=>Date.parse(tape?.asOf??'')||Date.now(),[tape])
  const markers=useMemo(()=>identity?liveTapeMarkers(events,identity.observationSubject,at):[],[events,identity,at])
  useEffect(()=>{markersRef.current?.(markers)},[markers])
  useEffect(()=>()=>markersRef.current?.([]),[])

  const toggle=useCallback(()=>setStarted(value=>!value),[])
  // Pausing discards the answers with the lease: a released lease must not leave
  // a stale "live until" or a stale row on screen.
  useEffect(()=>{if(!started){setTouch(null);setTape(null)}},[started])
  if(!identity)return null

  const state=liveTapeState({started,touch,tape})
  const lease=tape?.lease??null
  const rows=events.slice(0,LIVE_TAPE_ROWS)
  const status=state==='paused'?t('live_tape.status_paused',{defaultValue:'Paused. No lease is held and nothing is being read.'})
    :state==='error'?t('live_tape.status_error',{reason:touch?.reason??'',defaultValue:'The live lease could not be touched: {{reason}}'})
    :state==='starting'?t('live_tape.status_starting',{defaultValue:'Asking for a lease…'})
    :state==='disabled'?t('live_tape.status_disabled',{defaultValue:'On-chain channels are not enabled yet for this workspace. No lease was created and no stream is running; the retained public history above is unaffected.'})
    :t('live_tape.status_live',{until:clockTime(lease?.expiresAt??touch?.expiresAt),viewers:lease?.viewers??0,
      defaultValue:'Lease active until {{until}} · {{viewers}} viewers in this workspace'})

  return <section className="intel-live-tape space-y-3" aria-label={t('live_tape.title',{defaultValue:'Live on-chain tape'})}>
    <div>
      <div className="eyebrow">{t('live_tape.eyebrow',{defaultValue:'Live tape'})}</div>
      <h2 className="text-[15px] text-[var(--fg-1)]">{t('live_tape.title',{defaultValue:'Live on-chain tape'})}</h2>
      <p className="text-[12px] text-[var(--fg-4)]">
        {t('live_tape.subtitle',{defaultValue:'Public swaps, pool liquidity events and provider windows for this contract, from one shared server subscription. These are reported public events, not your trades and not executable depth.'})}
      </p>
    </div>
    <div className="intel-investigation-controls">
      <button className="btn" aria-pressed={started} onClick={toggle} data-testid="live-tape-toggle">
        {started?t('live_tape.pause',{defaultValue:'Pause live tape'}):t('live_tape.start',{defaultValue:'Start live tape'})}
      </button>
      <span role="status" data-testid="live-tape-status" data-state={state}>{status}</span>
    </div>
    {state==='waiting'&&<p className="text-[12px] text-[var(--fg-3)]" data-testid="live-tape-quiet">
      {t('live_tape.quiet',{defaultValue:'The lease is held and no on-chain event has been reported in this window yet. A quiet contract is a quiet contract, not a missing tape.'})}
    </p>}
    {tape?.ok===false&&<p className="text-[12px] text-[var(--fg-3)]" role="alert" data-testid="live-tape-read-error">
      {t('live_tape.read_failed',{reason:tape.reason??'',defaultValue:'The tape could not be read: {{reason}}'})}
    </p>}
    {rows.length>0&&<ul className="intel-live-tape-rows text-[12px]" data-testid="live-tape-events">
      {rows.map((event,index)=>{
        const meta=event.metadata||{}
        const url=meta.transaction?explorerTxUrl(identity.platform,meta.transaction):null
        return <li key={`${meta.transaction??'row'}:${meta.logIndex??index}:${event.observedAt}`} className="flex flex-wrap gap-x-3">
          <span className="intel-event-meta">{clockTime(event.observedAt)}</span>
          <span>{t(`live_tape.kind_${event.kind}`,{defaultValue:{swap:'Public swap',liquidity:'Pool liquidity',agg:'Window swap volume',traders:'Unique traders'}[event.kind]||String(event.kind)})}</span>
          <span className="intel-number">{event.unit==='USD'?fmtVol(event.value):`${fmtNum(event.value)} ${event.unit??''}`.trim()}</span>
          <span>{meta.venue||t('live_tape.venue_unreported',{defaultValue:'Venue unreported'})}</span>
          <span>{meta.eventType||t('live_tape.side_unclassified',{defaultValue:'unclassified'})}</span>
          {url
            ? <a className="intel-text-link" href={url} target="_blank" rel="noreferrer noopener">{shortTx(meta.transaction)}</a>
            : <span>{t('live_tape.tx_unreported',{defaultValue:'Transaction unreported'})}</span>}
        </li>
      })}
    </ul>}
    <SwapClock events={events} started={started} state={state}/>
  </section>
}
