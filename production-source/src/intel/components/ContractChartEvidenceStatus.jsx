import React from 'react'
import {useTranslation} from 'react-i18next'

// What the retained public market history says about this contract.
//
// Three states, and they are NOT interchangeable:
//
//   - The read failed. That keeps its own wording and its retry, because a
//     failure is not evidence of anything and must never be dressed up as one.
//   - The read succeeded and nothing is retained. For a contract a few hours
//     old this is the expected answer, so it is stated as an absence rather
//     than as a count of zero beside a sentence about what the count excludes.
//   - The read succeeded and events exist. Then the count is the point.
export default function ContractChartEvidenceStatus({evidence}){
 const {t}=useTranslation('intel',{useSuspense:false})
 if(!evidence.enabled)return null
 const empty=!evidence.loading&&!evidence.error&&!evidence.markers.length&&!evidence.observations?.length
 return <div className="intel-analysis-caption" aria-label={t('chart_evidence.heading',{defaultValue:'Public market chart history'})}>
  {evidence.error
   ?<span role="alert">{evidence.error} <button className="intel-text-link" onClick={evidence.refresh}>{t('chart_evidence.retry',{defaultValue:'Retry market history'})}</button></span>
   :empty
    ?<span>{t('chart_evidence.none_yet',{defaultValue:'No public market history yet for this contract.'})}</span>
    :<span>{evidence.loading?t('chart_evidence.reading',{defaultValue:'Reading retained public market events…'}):t('chart_evidence.retained',{events:evidence.markers.length,defaultValue:'{{events}} retained public market events in this window.'})} {t('chart_evidence.separate',{defaultValue:'Public swaps and pool activity are separate from your positions.'})}</span>}
  {evidence.hasMore&&<button className="intel-text-link ml-3" disabled={evidence.loading} onClick={evidence.loadMore}>{t('chart_evidence.load_more',{defaultValue:'Load more public market events'})}</button>}
  {evidence.rangeLimited&&<span> {t('chart_evidence.range_limited',{defaultValue:'Public event history is limited to the final 90 days of this range, subject to source retention.'})}</span>}
 </div>
}
