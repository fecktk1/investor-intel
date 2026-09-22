import React,{useEffect,useRef,useState} from 'react'
import {useTranslation} from 'react-i18next'
import {receiptFreshness,providerLabel,receiptCost} from '../lib/source-receipt'
import {cmcReproduceCommand} from '../../../supabase/functions/_shared/market-assets/cmc-reproduce.ts'
import ReceiptCostLine from './ReceiptCostLine'
const time=v=>v&&Number.isFinite(Date.parse(v))?new Date(v).toLocaleString():null
const FRESHNESS_DEFAULTS={fresh:'Fresh: a provider call answered this read',cached:'Cached: inside its refresh limit',stale:'Stale: past its refresh limit',unavailable:'Unavailable: nothing usable answered this read'}
const CALL_DEFAULTS={live:'Live provider call',cache:'Shared cache','negative-cache':'Shared failure record',error:'Failed call'}
const selectText=node=>{try{const sel=window.getSelection?.();if(!node||!sel||typeof document.createRange!=='function')return;const range=document.createRange();range.selectNodeContents(node);sel.removeAllRanges();sel.addRange(range)}catch{/* the command stays on screen either way */}}
/** "Reproduce this call": the exact request a LIVE keyed read made, as curl for the
 * reader's own key. The key is only ever the literal $CMC_API_KEY (cmc-reproduce.ts).
 * "Copied" is announced beside the button, never a relabel; a browser without the
 * clipboard API gets the command selected for a keyboard copy instead. */
function ReproduceCallRow({command}){
 const {t}=useTranslation('intel',{useSuspense:false})
 const [status,setStatus]=useState(null)
 const code=useRef(null),timer=useRef(null)
 useEffect(()=>()=>{if(timer.current)clearTimeout(timer.current)},[])
 const copy=async()=>{
  if(timer.current)clearTimeout(timer.current)
  try{if(!navigator?.clipboard?.writeText)throw new Error('clipboard_unavailable');await navigator.clipboard.writeText(command);setStatus('copied');timer.current=setTimeout(()=>setStatus(null),2000)}
  catch{selectText(code.current);setStatus('manual')}
 }
 return <><dt>{t('receipt_reproduce.label',{defaultValue:'Reproduce this call'})}</dt>
  <dd><code ref={code} className="break-all" data-testid="receipt-reproduce-command">{command}</code>
   <div><button type="button" className="btn btn--quiet btn--sm" onClick={copy}>{t('receipt_reproduce.copy',{defaultValue:'Copy command'})}</button>
    <span role="status" aria-live="polite">{status==='copied'?` ${t('receipt_reproduce.copied',{defaultValue:'Copied'})}`:status==='manual'?` ${t('receipt_reproduce.copy_manual',{defaultValue:'Clipboard access is unavailable. The command is selected: copy it with your keyboard.'})}`:''}</span></div>
   <p className="intel-analysis-caption">{t('receipt_reproduce.caption',{defaultValue:'Runs with your own CoinMarketCap key from the CMC_API_KEY environment variable and is charged to your account, not ours. The key is never part of this command.'})}</p></dd></>
}
/** What actually answered one read. provider_call_logs and the response cache
 * are service-role only, so this rides in the response body or a reader cannot
 * see it at all. Same <details><summary> idiom as AlertSourceReceipt.
 *
 * Props are backward compatible: `receipt`, `scope` and `observedAt` behave as
 * before. A receipt may be a CmcReceipt (one transport read) or a SourceReceipt
 * (a stored copy or a recorded capture run); both render here. Optional
 * `scopeKey` renders the scope sentence in the reader's language. */
export default function SourceCallReceipt({receipt,scope,scopeKey,observedAt}){
 const {t}=useTranslation('intel',{useSuspense:false})
 if(!receipt)return null
 const absent=t('receipt.not_reported',{defaultValue:'not reported'})
 // A credit count of 0 is a real charge of zero and must read as 0. Only a
 // genuinely absent figure says so in words: every cache hit reports none,
 // because the cache row does not retain the originating charge.
 const credits=receipt.creditCount==null?absent:String(receipt.creditCount)
 const params=Object.entries(receipt.parameters||{})
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
 // The cost rides in the SUMMARY, not in the drawer: a reader must be able to see
 // what a figure cost without opening anything. The drawer below still carries the
 // full accounting (credits charged, HTTP status, parameters, clocks).
 const cost=receiptCost(receipt)
 // Only a live keyed read of a registered CoinMarketCap endpoint has a call to
 // reproduce; every other receipt returns null and draws no row.
 const reproduce=cmcReproduceCommand(receipt)
 return <details className="intel-source-call-receipt" data-freshness={freshness} data-served={cost?.served||undefined}><summary>{t('receipt.summary',{defaultValue:'Source call receipt'})}
  {cost?<> · <ReceiptCostLine receipt={receipt} /></>:null}</summary>
  <dl className="intel-event-facts">
   {receipt.provider&&<><dt>{t('receipt_state.provider',{defaultValue:'Provider'})}</dt><dd>{providerLabel(receipt.provider,t)}</dd></>}
   <dt>{t('receipt.capability',{defaultValue:'Capability'})}</dt><dd className="break-all">{receipt.endpoint?`${receipt.capability} · ${receipt.endpoint}`:receipt.capability}</dd>
   <dt>{t('receipt.parameters',{defaultValue:'Parameters'})}</dt><dd className="break-all">{params.length?params.map(([k,v])=>`${k}=${v}`).join(' · '):t('common.none',{defaultValue:'None'})}</dd>
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
   {observedAt&&<><dt>{t('research.observed',{defaultValue:'Observed'})}</dt><dd><time dateTime={observedAt}>{time(observedAt)}</time></dd></>}
   {reproduce&&<ReproduceCallRow command={reproduce}/>}
  </dl>
  {scopeText&&<p className="intel-analysis-caption">{scopeText}</p>}
 </details>
}
