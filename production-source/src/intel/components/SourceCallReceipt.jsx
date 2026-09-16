import React from 'react'
import {useTranslation} from 'react-i18next'
const time=v=>v&&Number.isFinite(Date.parse(v))?new Date(v).toLocaleString():null
/** What actually answered one research read. provider_call_logs and the response
 * cache are service-role only, so this rides in the response body or a reader
 * cannot see it at all. Same <details><summary> idiom as AlertSourceReceipt. */
export default function SourceCallReceipt({receipt,scope,observedAt}){
 const {t}=useTranslation('intel',{useSuspense:false})
 if(!receipt)return null
 const absent=t('receipt.not_reported',{defaultValue:'not reported'})
 // A credit count of 0 is a real charge of zero and must read as 0. Only a
 // genuinely absent figure says so in words: every cache hit reports none,
 // because the cache row does not retain the originating charge.
 const credits=receipt.creditCount==null?absent:String(receipt.creditCount)
 const params=Object.entries(receipt.parameters||{})
 return <details className="intel-source-call-receipt"><summary>{t('receipt.summary',{defaultValue:'Source call receipt'})}</summary>
  <dl className="intel-event-facts">
   <dt>{t('receipt.capability',{defaultValue:'Capability'})}</dt><dd className="break-all">{receipt.capability} · {receipt.endpoint}</dd>
   <dt>{t('receipt.parameters',{defaultValue:'Parameters'})}</dt><dd className="break-all">{params.length?params.map(([k,v])=>`${k}=${v}`).join(' · '):t('common.none',{defaultValue:'None'})}</dd>
   <dt>{t('receipt.origin',{defaultValue:'Answered by'})}</dt><dd>{receipt.origin==='live'?t('receipt.origin_live',{defaultValue:'Live provider call'}):t('receipt.origin_cache',{defaultValue:'Shared cache, no call made'})}</dd>
   <dt>{t('receipt.http_status',{defaultValue:'HTTP status'})}</dt><dd>{receipt.httpStatus==null?absent:receipt.httpStatus}</dd>
   <dt>{t('receipt.credits',{defaultValue:'Credits charged'})}</dt><dd>{credits}</dd>
   {receipt.cacheAgeSeconds!=null&&<><dt>{t('receipt.age',{defaultValue:'Age against refresh limit'})}</dt>
    <dd>{receipt.ttlSeconds==null?t('receipt.age_seconds',{defaultValue:'{{age}}s',age:receipt.cacheAgeSeconds}):t('receipt.age_of_ttl',{defaultValue:'{{age}}s of {{ttl}}s',age:receipt.cacheAgeSeconds,ttl:receipt.ttlSeconds})}</dd></>}
   {receipt.fetchedAt&&<><dt>{t('research.fetched',{defaultValue:'Retrieved'})}</dt><dd><time dateTime={receipt.fetchedAt}>{time(receipt.fetchedAt)}</time></dd></>}
   {observedAt&&<><dt>{t('research.observed',{defaultValue:'Observed'})}</dt><dd><time dateTime={observedAt}>{time(observedAt)}</time></dd></>}
  </dl>
  {scope&&<p className="intel-analysis-caption">{scope}</p>}
 </details>
}
