import React from 'react'
import {useTranslation} from 'react-i18next'

const clock=(value,timeZone)=>Number.isFinite(value)?new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short',...(timeZone?{timeZone}:{})}):null
const providerName=provider=>provider==='coinmarketcap'?'CoinMarketCap':provider==='coingecko'?'CoinGecko':provider||null

/** The brand card a share link carries: the facts a reader needs to judge the
 * chart, and nothing that would leak the research itself. Rendered from the
 * layout and the capture that will actually be shared, so what the owner reads
 * here is what the recipient gets. */
export default function ChartShareCard({layout,source=null,capturedAt=null,latestObservation=null}) {
 const {t}=useTranslation('intel',{useSuspense:false})
 const timezone=layout?.timezone||'UTC'
 const missing=t('chart.share.card_unrecorded',{defaultValue:'Not recorded'})
 const from=clock(layout?.range?.from,timezone),to=clock(layout?.range?.to,timezone)
 const observed=clock(latestObservation,timezone),captured=clock(capturedAt,timezone)
 const currency=source?.currency||null,provider=providerName(source?.provider)
 return <section className="intel-share-card" aria-label={t('chart.share.card_title',{defaultValue:'What the recipient sees'})}>
  <p className="eyebrow">TheContentForge · Investor Intel</p>
  <dl className="intel-event-facts">
   <dt>{t('chart.share.card_asset',{defaultValue:'Asset'})}</dt><dd>{layout?.asset||missing}</dd>
   <dt>{t('chart.share.card_timeframe',{defaultValue:'Timeframe'})}</dt><dd>{from&&to?t('chart.share.card_range',{from,to,defaultValue:'{{from}} to {{to}}'}):missing}</dd>
   <dt>{t('chart.share.card_timezone',{defaultValue:'Time zone'})}</dt><dd>{timezone}</dd>
   <dt>{t('chart.share.card_data_age',{defaultValue:'Data age'})}</dt><dd>{observed?t('chart.share.card_observed',{time:observed,defaultValue:'Latest observation {{time}}'}):missing}{captured?` · ${t('chart.share.card_captured',{time:captured,defaultValue:'captured {{time}}'})}`:''}</dd>
   <dt>{t('chart.share.card_source',{defaultValue:'Source'})}</dt><dd>{provider?`${provider}${currency?` · ${currency}`:''}`:missing}</dd>
  </dl>
  <p className="intel-analysis-caption">{t('chart.share.card_note',{defaultValue:'A social preview of the link shows this brand card only. Prices, notes and portfolio content stay behind the link and access is checked again when it is opened.'})}</p>
 </section>
}
