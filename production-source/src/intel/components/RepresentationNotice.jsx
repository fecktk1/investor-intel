import React from 'react'
import {representationReview} from '../../../supabase/functions/_shared/intel/representation-review.ts'
import {sourceHref} from './ResearchEvidence'

/** Supplied records are frozen evidence: never replace them with today's review. */
export default function RepresentationNotice({canonicalAssetKey,record,asOf}){
 const review=record===undefined?representationReview(canonicalAssetKey,asOf??Date.now()):record
 if(!review)return null
 if(review.status==='restricted')return <p className="intel-analysis-caption">{review.reason} <span className="break-all">{review.sourceRef}</span></p>
 return <aside aria-label="Issuer deployment notice" className="border-l-2 border-[var(--accent)] pl-3 my-3 text-sm">
  <p><strong>{review.issuer} · {review.network} deployment notice</strong>{review.status==='review_expired'?' · Review needs updating':''}</p>
  <p>{review.summary}</p>
  <details><summary>Source and dates</summary><p>Issuer effective date: <time dateTime={review.effectiveDate}>{review.effectiveDate}</time>. Time and timezone unreported.</p>
   <p>Source reviewed: <time dateTime={review.reviewedAt}>{review.reviewedAt}</time>. Review due: <time dateTime={review.reviewExpiresAt}>{review.reviewExpiresAt}</time>.</p>
   <p>{review.timeMeaning}</p><p className="break-all">{review.sourceRef}</p>
   {sourceHref(review.sourceUrl)&&<a className="intel-text-link" href={sourceHref(review.sourceUrl)} target="_blank" rel="noreferrer">Issuer contract list</a>}
  </details>
 </aside>
}
