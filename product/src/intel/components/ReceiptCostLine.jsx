import React from 'react'
import {useTranslation} from 'react-i18next'
import {receiptCost} from '../lib/source-receipt'

/** What one read cost, in one line a reader sees WITHOUT opening the receipt
 * drawer. Every number comes from the receipt the response already carries
 * (`receiptCost` in ../lib/source-receipt.js); nothing here is estimated, and a
 * charge the provider did not report is said in words rather than shown as 0.
 *
 * Four shapes, because the four ways a figure gets served cost four different
 * things and must not read alike:
 *   live    "1 provider call · 250 credits · live"
 *   cache   "No provider call · served from the shared cache · original call 1 credit"
 *           (the last part only when the receipt carries the original call's
 *           own reported charge, receipt.proof.creditCount)
 *   shared  "Shared capture, no per-reader provider cost · captured <time>"
 *   failed  "No provider call · a remembered failure answered this read"
 *
 * `as` lets the line render inside a <summary> (a <span>) or on its own (a <p>).
 * Returns null for a receipt that did not say how it was served, so a cost claim
 * is never invented. */
export default function ReceiptCostLine({receipt,as:Tag='span',className=''}){
 const {t}=useTranslation('intel',{useSuspense:false})
 const cost=receiptCost(receipt)
 if(!cost)return null
 // A reported 0 is a real charge of zero and reads as 0; only a genuinely absent
 // figure says so in words, which every cache hit does.
 const credits=cost.credits==null
  ?t('receipt_cost.credits_not_reported',{defaultValue:'credits not reported'})
  :t('receipt_cost.credits',{count:cost.credits,defaultValue:'{{count}} credit'})
 const captured=receipt?.capturedAt||receipt?.fetchedAt||null
 const capturedText=captured&&Number.isFinite(Date.parse(captured))?new Date(captured).toLocaleString():null
 let text
 if(cost.served==='live'){
  text=`${t('receipt_cost.calls',{count:cost.calls,defaultValue:'{{count}} provider call'})} · ${credits} · ${t('receipt_cost.live',{defaultValue:'live'})}`
 }else if(cost.served==='cache'){
  // The ORIGINAL call's charge, from its stored response, when the receipt
  // carries it: what filling the shared cache cost once, never this reader.
  const origin=cost.originCredits==null?null:t('receipt_cost.origin_credits',{count:cost.originCredits,defaultValue:'original call {{count}} credit'})
  text=[t('receipt_cost.no_call',{defaultValue:'No provider call'}),t('receipt_cost.from_cache',{defaultValue:'served from the shared cache'}),origin].filter(Boolean).join(' · ')
 }else if(cost.served==='shared'){
  // The capture's own call count is what the capture cost ONCE for everyone, so
  // it is stated as the run's cost and never as this reader's.
  const run=cost.runCalls==null?null:t('receipt_cost.run_calls',{count:cost.runCalls,defaultValue:'the capture run made {{count}} call to this endpoint'})
  text=[t('receipt_cost.shared',{defaultValue:'Shared capture, no per-reader provider cost'}),
   capturedText?t('receipt_cost.captured_at',{date:capturedText,defaultValue:'captured {{date}}'}):null,run].filter(Boolean).join(' · ')
 }else{
  text=`${t('receipt_cost.no_call',{defaultValue:'No provider call'})} · ${t('receipt_cost.failed',{defaultValue:'a remembered failure answered this read'})}`
 }
 return <Tag className={`intel-receipt-cost ${className}`.trim()} data-served={cost.served} data-calls={cost.calls}>{text}</Tag>
}
