import React,{useEffect,useRef,useState} from 'react'
import {useTranslation} from 'react-i18next'
import i18next from 'i18next'
import { formatDataTime } from '../lib/as-of'
import {receiptFreshness,providerLabel,receiptCost,receiptProof} from '../lib/source-receipt'
import {cmcReproduceCommand,cmcReproduceRequest} from '../../../supabase/functions/_shared/market-assets/cmc-reproduce.ts'
import ReceiptCostLine from './ReceiptCostLine'
import ReceiptParameters from './ReceiptParameters'
// Every time in a receipt in the one format (../lib/as-of.js): UTC and its age.
const time=v=>formatDataTime(v,{language:i18next.language})
const FRESHNESS_DEFAULTS={fresh:'Fresh: a provider call answered this read',cached:'Cached: inside its refresh limit',stale:'Stale: past its refresh limit',unavailable:'Unavailable: nothing usable answered this read'}
const CALL_DEFAULTS={live:'Live provider call',cache:'Shared cache','negative-cache':'Shared failure record',error:'Failed call'}
// What the command reproduces, so a cached figure's command is never called "this call".
const REPRODUCE_LABELS={this_call:['receipt_reproduce.label','Reproduce this call'],cache_fill:['receipt_proof.reproduce_cache_fill','Reproduce the call that filled the cache'],
 failed_call:['receipt_proof.reproduce_failed_call','Reproduce the call that failed'],capture_call:['receipt_proof.reproduce_capture_call','Reproduce the capture call'],
 capture_call_earlier:['receipt_proof.reproduce_capture_call_earlier','Reproduce the kept capture call']}
const MISSING_DEFAULTS={failure_body_not_kept:'Not kept: a failed call keeps only its HTTP status, never its body.',
 body_not_json:'Not shown: CoinMarketCap answered with a body that is not JSON.',
 not_recorded:'Not recorded for this capture.',
 withheld:'Withheld: the body contained key-shaped material.'}
const selectText=node=>{try{const sel=window.getSelection?.();if(!node||!sel||typeof document.createRange!=='function')return;const range=document.createRange();range.selectNodeContents(node);sel.removeAllRanges();sel.addRange(range)}catch{/* the command stays on screen either way */}}
/** "Reproduce this call": the exact request behind the figure, as curl for the
 * reader's own key. The key is only ever the literal $CMC_API_KEY (cmc-reproduce.ts);
 * a keyless receipt shows the keyless form. "Copied" is announced beside the
 * button, never a relabel; a browser without the clipboard API gets the command
 * selected for a keyboard copy instead. */
function ReproduceCallRow({command,label,keyless}){
 const {t}=useTranslation('intel',{useSuspense:false})
 const [status,setStatus]=useState(null)
 const code=useRef(null),timer=useRef(null)
 useEffect(()=>()=>{if(timer.current)clearTimeout(timer.current)},[])
 const copy=async()=>{
  if(timer.current)clearTimeout(timer.current)
  try{if(!navigator?.clipboard?.writeText)throw new Error('clipboard_unavailable');await navigator.clipboard.writeText(command);setStatus('copied');timer.current=setTimeout(()=>setStatus(null),2000)}
  catch{selectText(code.current);setStatus('manual')}
 }
 return <><dt>{label}</dt>
  <dd><code ref={code} className="break-all" data-testid="receipt-reproduce-command">{command}</code>
   <div><button type="button" className="btn btn--quiet btn--sm" onClick={copy}>{t('receipt_reproduce.copy',{defaultValue:'Copy command'})}</button>
    <span role="status" aria-live="polite">{status==='copied'?` ${t('receipt_reproduce.copied',{defaultValue:'Copied'})}`:status==='manual'?` ${t('receipt_reproduce.copy_manual',{defaultValue:'Clipboard access is unavailable. The command is selected: copy it with your keyboard.'})}`:''}</span></div>
   <p className="intel-analysis-caption">{keyless
    ?t('receipt_proof.reproduce_keyless_caption',{defaultValue:'This call was made without a key, so the command carries none.'})
    :t('receipt_reproduce.caption',{defaultValue:'Runs with your own CoinMarketCap key from the CMC_API_KEY environment variable and is charged to your account, not ours. The key is never part of this command.'})}</p></dd></>
}
/** What CoinMarketCap returned for the call behind the figure: its status block
 * and the first rows of its data, trimmed and labelled as trimmed with the real
 * totals. Display only; no export path reads it. */
function ResponseExcerptRow({view,origin,callCount}){
 const {t}=useTranslation('intel',{useSuspense:false})
 const label=t('receipt_proof.response',{defaultValue:'What CoinMarketCap returned'})
 if(view.state==='absent')return <><dt>{label}</dt><dd>{t('receipt_proof.absent',{defaultValue:'Not included in this receipt: the service that issued it did not yet attach the response.'})}</dd></>
 if(view.state==='stored')return <><dt>{label}</dt><dd>{t('receipt_proof.stored_row',{defaultValue:'Stored normalised row. No raw response excerpt was kept for this capture.'})}</dd></>
 if(view.state==='missing')return <><dt>{label}</dt><dd>{t(`receipt_proof.missing_${view.missing}`,{defaultValue:MISSING_DEFAULTS[view.missing]||MISSING_DEFAULTS.not_recorded})}</dd></>
 const kept=time(view.retrievedAt)||'—'
 const where=origin==='live'?t('receipt_proof.from_live',{defaultValue:'The response to this call.'})
  :view.earlierRun?t('receipt_proof.from_earlier_run',{date:kept,defaultValue:'Stored normalised row; raw excerpt kept from an earlier capture run, retrieved {{date}}.'})
  :origin==='capture'||origin==='stored'?t('receipt_proof.from_capture',{date:kept,defaultValue:'The response to the capture call, kept at capture time, retrieved {{date}}.'})
  :origin==='negative-cache'?t('receipt_proof.from_failure',{date:kept,defaultValue:'The response of the call that failed, retrieved {{date}}.'})
  :t('receipt_proof.from_cache',{date:kept,defaultValue:'The stored response of the call that filled the shared cache, retrieved {{date}}.'})
 const cuts=view.lists.map(l=>t('receipt_proof.list_cut',{path:l.path,shown:l.shown,total:l.total,defaultValue:'{{path}}: {{shown}} of {{total}} rows'}))
 // A run that called this endpoint several times kept the proof of its last call.
 const several=(origin==='capture'||origin==='stored')&&!view.earlierRun&&Number(callCount)>1
 const trims=[
  view.dataOmitted?t('receipt_proof.data_omitted',{defaultValue:'The data member is too large to excerpt and is left out.'}):null,
  cuts.length?t('receipt_proof.trimmed_lists',{lists:cuts.join('; '),defaultValue:'Trimmed: {{lists}}.'}):null,
  view.shortened?t('receipt_proof.shortened',{count:view.shortened,defaultValue:'{{count}} long text value shortened (ends in …).'}):null,
 ].filter(Boolean)
 const caption=[where,
  several?t('receipt_proof.last_of_calls',{count:Number(callCount),defaultValue:'Kept from the last of the {{count}} calls this run made to this endpoint.'}):null,
  trims.length?trims.join(' '):t('receipt_proof.untrimmed',{defaultValue:'Shown in full: nothing was trimmed.'}),
  t('receipt_proof.display_only',{defaultValue:'Status block as returned. Shown for checking only and never exported.'})].filter(Boolean).join(' ')
 return <><dt>{label}</dt>
  <dd className="min-w-0"><p className="intel-analysis-caption">{caption}</p>
   <pre className="text-[11px] leading-snug overflow-auto whitespace-pre max-h-64 max-w-full mt-1" data-testid="receipt-response-excerpt" tabIndex={0} aria-label={label}>{view.json}</pre></dd></>
}
/** What actually answered one read. provider_call_logs and the response cache
 * are service-role only, so this rides in the response body or a reader cannot
 * see it at all. Same <details><summary> idiom as AlertSourceReceipt.
 *
 * Props are backward compatible: `receipt`, `scope` and `observedAt` behave as
 * before. A receipt may be a CmcReceipt (one transport read) or a SourceReceipt
 * (a stored copy or a recorded capture run); both render here. Optional
 * `scopeKey` renders the scope sentence in the reader's language.
 *
 * Every CoinMarketCap receipt proves its call: the curl that reproduces it, what
 * the provider returned (a trimmed excerpt of the response behind the figure),
 * and the charge that call reported, beside the endpoint, HTTP status, clocks and
 * age. A figure served from the shared cache made no call of its own, so its
 * charge is stated as the ORIGINAL call's, never as this reader's. */
export default function SourceCallReceipt({receipt,scope,scopeKey,observedAt}){
 const {t}=useTranslation('intel',{useSuspense:false})
 if(!receipt)return null
 const absent=t('receipt.not_reported',{defaultValue:'not reported'})
 const view=receiptProof(receipt)
 const cost=receiptCost(receipt)
 // A credit count of 0 is a real charge of zero and must read as 0. A cache hit
 // made no call of its own, so its line also names the ORIGINAL call's charge,
 // from that call's stored response. "Not recorded" is said only when a proof
 // exists and its response carried no charge; a receipt that predates proofs
 // keeps the older "not reported".
 const originCredits=cost?.originCredits==null?null:t('receipt_proof.credits_origin',{count:cost.originCredits,defaultValue:'{{count}} credit reported by CoinMarketCap on the original call'})
 const unknown=view&&view.state!=='absent'?t('receipt_proof.credits_not_recorded',{defaultValue:'not recorded for this capture'}):absent
 const credits=receipt.origin==='cache'
  ?[t('receipt_proof.credits_none_this_read',{defaultValue:'none for this read (no call was made)'}),originCredits??unknown].join(' · ')
  :receipt.creditCount!=null?String(receipt.creditCount)
  :receipt.origin==='live'?absent
  :originCredits??unknown
 const freshness=receiptFreshness(receipt)
 const freshnessText=t(`receipt_state.${freshness}`,{defaultValue:FRESHNESS_DEFAULTS[freshness]})
 const origin=receipt.origin==='live'?t('receipt.origin_live',{defaultValue:'Live provider call'})
  // A negative-cache hit is a remembered FAILURE, not a stored figure, and must
  // never read like "Shared cache".
  :receipt.origin==='negative-cache'?t('receipt_state.origin_negative_cache',{defaultValue:'Shared failure record, no call made'})
  :receipt.origin==='capture'?t('receipt_state.origin_capture',{defaultValue:'Recorded capture, no call made for this view'})
  :receipt.origin==='stored'?t('receipt_state.origin_stored',{defaultValue:'Stored copy, no call made for this view'})
  :t('receipt.origin_cache',{defaultValue:'Shared cache, no call made'})
 const keyMode=receipt.keyMode==='keyed'?t('receipt_state.key_keyed',{defaultValue:'Keyed provider account'})
  :receipt.keyMode==='keyless'?t('receipt_state.key_keyless',{defaultValue:'Keyless public endpoint'}):absent
 // A stored copy or a capture is measured against the cadence its store is
 // refreshed on; a transport read against its own refresh limit.
 const cadence=receipt.cadenceSeconds!=null&&(receipt.origin==='capture'||receipt.origin==='stored')
 const call=receipt.captureCall&&CALL_DEFAULTS[receipt.captureCall]?t(`receipt_state.call_${receipt.captureCall.replace('-','_')}`,{defaultValue:CALL_DEFAULTS[receipt.captureCall]}):null
 const scopeText=scopeKey?t(`figure_scope.${scopeKey}`,{defaultValue:scope||''}):scope
 // The request behind the figure: this call, the call that filled the cache, the
 // call that failed, or the capture's own recorded call. Null when there is no
 // single exact request to give (a stored row, a capture that kept none).
 const request=cmcReproduceRequest(receipt)
 const reproduce=request?cmcReproduceCommand(receipt):null
 const [labelKey,labelDefault]=REPRODUCE_LABELS[request?.meaning==='capture_call'&&view?.earlierRun?'capture_call_earlier':request?.meaning]||REPRODUCE_LABELS.this_call
 const noReproduce=view&&!reproduce&&(receipt.origin==='capture'||receipt.origin==='stored')
  ?(receipt.origin==='stored'
   ?t('receipt_proof.no_reproduce_stored',{defaultValue:'None: this figure is a stored normalised row, not the answer to one call.'})
   :t('receipt_proof.no_reproduce_capture',{defaultValue:'Not recorded for this capture: the run kept its endpoint, status and credits, but not its request parameters.'})):null
 return <details className="intel-source-call-receipt" data-freshness={freshness} data-served={cost?.served||undefined}><summary>{t('receipt.summary',{defaultValue:'Source call receipt'})}
  {cost?<> · <ReceiptCostLine receipt={receipt} /></>:null}</summary>
  <dl className="intel-event-facts">
   {receipt.provider&&<><dt>{t('receipt_state.provider',{defaultValue:'Provider'})}</dt><dd>{providerLabel(receipt.provider,t)}</dd></>}
   <dt>{t('receipt.capability',{defaultValue:'Capability'})}</dt><dd className="break-all">{receipt.endpoint?`${receipt.capability} · ${receipt.endpoint}`:receipt.capability}</dd>
   {/* What the call SENT, from the same request as the command below (never "None" beside a command with parameters). */}
   <dt>{t('receipt.parameters',{defaultValue:'Parameters'})}</dt><dd className="break-all"><ReceiptParameters receipt={receipt}/></dd>
   <dt>{t('receipt.origin',{defaultValue:'Answered by'})}</dt><dd>{origin}</dd>
   <dt>{t('receipt_state.freshness',{defaultValue:'Freshness'})}</dt><dd>{freshnessText}</dd>
   <dt>{t('receipt_state.key_mode',{defaultValue:'Provider key'})}</dt><dd>{keyMode}</dd>
   {call&&<><dt>{t('receipt_state.capture_call',{defaultValue:'Capture run call'})}</dt><dd>{call}</dd></>}
   {receipt.callCount!=null&&<><dt>{t('receipt_state.call_count',{defaultValue:'Calls to this endpoint in the run'})}</dt><dd>{receipt.callCount}</dd></>}
   <dt>{t('receipt.http_status',{defaultValue:'HTTP status'})}</dt><dd>{receipt.httpStatus==null?absent:receipt.httpStatus}</dd>
   <dt>{t('receipt.credits',{defaultValue:'Credits charged'})}</dt><dd>{credits}</dd>
   {receipt.cacheAgeSeconds!=null&&<><dt>{t('receipt.age',{defaultValue:'Age against refresh limit'})}</dt>
    <dd>{cadence?t('receipt_state.age_of_cadence',{defaultValue:'{{age}}s of a {{cadence}}s cadence',age:receipt.cacheAgeSeconds,cadence:receipt.cadenceSeconds})
     :receipt.ttlSeconds==null?t('receipt.age_seconds',{defaultValue:'{{age}}s',age:receipt.cacheAgeSeconds}):t('receipt.age_of_ttl',{defaultValue:'{{age}}s of {{ttl}}s',age:receipt.cacheAgeSeconds,ttl:receipt.ttlSeconds})}</dd></>}
   {receipt.capturedAt&&receipt.capturedAt!==receipt.fetchedAt&&<><dt>{t('receipt_state.captured',{defaultValue:'Captured'})}</dt><dd><time dateTime={receipt.capturedAt}>{time(receipt.capturedAt)}</time></dd></>}
   {receipt.fetchedAt&&<><dt>{t('research.fetched',{defaultValue:'Retrieved'})}</dt><dd><time dateTime={receipt.fetchedAt}>{time(receipt.fetchedAt)}</time></dd></>}
   {view?.respondedAt&&!view.earlierRun&&<><dt>{t('receipt_proof.responded',{defaultValue:'CoinMarketCap response time'})}</dt><dd><time dateTime={view.respondedAt}>{time(view.respondedAt)}</time></dd></>}
   {observedAt&&<><dt>{t('research.observed',{defaultValue:'Observed'})}</dt><dd><time dateTime={observedAt}>{time(observedAt)}</time></dd></>}
   {reproduce&&<ReproduceCallRow command={reproduce} label={t(labelKey,{defaultValue:labelDefault})} keyless={request.keyMode==='keyless'}/>}
   {noReproduce&&<><dt>{t('receipt_reproduce.label',{defaultValue:'Reproduce this call'})}</dt><dd>{noReproduce}</dd></>}
   {view&&<ResponseExcerptRow view={view} origin={receipt.origin} callCount={receipt.callCount}/>}
  </dl>
  {scopeText&&<p className="intel-analysis-caption">{scopeText}</p>}
 </details>
}
