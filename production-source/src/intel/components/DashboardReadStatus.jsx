import React from 'react'
import {useTranslation} from 'react-i18next'
const names={watchlist:'Watchlist',profile:'Followed chains',custom_news:'Workspace news',global_news:'Market news',narratives:'Narratives',alerts:'Recent alerts',brief:'Latest brief',research:'Saved research',changes:'Changes since your visit',exchange_tickers:'Venue prices',exchange_signals:'Venue signals',curated_news:'Curated stories',signal_feed:'Personalized signals'}
export const dashboardReadFailed=(data,...names)=>names.some(name=>data?.read_states?.[name]?.state==='error')
export default function DashboardReadStatus({data,onRetry}){
 const {t}=useTranslation('intel',{useSuspense:false}),failed=Object.keys(names).filter(name=>dashboardReadFailed(data,name))
 if(!failed.length)return null
 return <div role="alert" className="text-sm py-2 border-b border-[var(--border-default)]"><p>{t('pulse.partial_reads',{defaultValue:'Some parts of your desk could not be read. Available sources remain visible; missing sections are not empty results.'})}</p><p>{failed.map(name=>t(`pulse.read_${name}`,{defaultValue:names[name]})).join(' · ')}</p><button type="button" className="intel-text-link" onClick={onRetry}>{t('common.retry',{defaultValue:'Retry'})}</button></div>
}
