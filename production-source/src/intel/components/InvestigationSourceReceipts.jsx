import React from 'react'
import {useTranslation} from 'react-i18next'
import SourceCallReceipt from './SourceCallReceipt'

/** What answered each provider read behind this view, one drawer per read. */
export default function InvestigationSourceReceipts({snapshots=[]}){
  const {t}=useTranslation('intel',{useSuspense:false})
  const reads=(Array.isArray(snapshots)?snapshots:[]).filter(s=>s?.receipt)
  if(!reads.length)return null
  return <details className="intel-open-section"><summary>{t('investigation.source_receipts',{defaultValue:'Source call receipts'})} · {reads.length}</summary>
    <p className="intel-analysis-caption">{t('investigation.source_receipts_caption',{defaultValue:'What answered each provider read behind this view. A cached answer made no new call.'})}</p>
    {reads.map((s,i)=><section key={`${s.capability}:${i}`} className="py-2"><p className="intel-analysis-caption">{s.capability} · {s.state}</p><SourceCallReceipt receipt={s.receipt} observedAt={s.provenance?.observedAt}/></section>)}
  </details>
}
