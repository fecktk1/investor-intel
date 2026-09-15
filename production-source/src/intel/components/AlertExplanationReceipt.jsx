import React from 'react'
import AlertSourceReceipt from './AlertSourceReceipt'
export default function AlertExplanationReceipt({receipt}){
 const p=receipt.payload||{},condition=p.checkpoint?.condition
 return <section aria-label="Evidence for this explanation" className="intel-alert-source-receipt">
  <p>Original firing · Evidence {receipt.evidence_version??'version unavailable'} · Rule revision {receipt.rule_revision??'not recorded'}</p>
  <p className="intel-analysis-caption">This explanation uses the saved alert receipt. It does not refresh market data or change your thesis.</p>
  {condition&&<details><summary>Original thesis condition</summary><blockquote className="whitespace-pre-wrap break-words">{condition.description}</blockquote><p>{condition.metric} {condition.comparator} {condition.threshold??'Unavailable'} {condition.threshold_unit} · {condition.time_window}</p></details>}
  <AlertSourceReceipt payload={p}/>
 </section>
}
