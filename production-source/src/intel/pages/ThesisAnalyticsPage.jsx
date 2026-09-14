import React,{useEffect,useState} from 'react'
import {useTranslation} from 'react-i18next'
import {useProfile} from '../../lib/profile-context'
import {useSupabase} from '../../lib/useSupabase'
import {getThesisAnalytics,getTradeAnalytics} from '../lib/thesis-api'
import {usePortfolioSelection} from '../lib/PortfolioSelectionContext'
import TradeAnalyticsPanel from '../components/thesis/TradeAnalyticsPanel'
import PortfolioThesisInsights from '../components/thesis/PortfolioThesisInsights'
import ThesisPerformanceLedger from '../components/thesis/ThesisPerformanceLedger'
import IntelDisclaimer from '../components/IntelDisclaimer'
export default function ThesisAnalyticsPage(){
 const {org}=useProfile(),{supabase,user}=useSupabase()
 return <Analytics key={`${org?.id}:${user?.id}`} orgId={org?.id} userId={user?.id} supabase={supabase}/>
}
function Analytics({orgId,userId,supabase}){
 const {t}=useTranslation('intel',{useSuspense:false}),portfolio=usePortfolioSelection()
 const [th,setTh]=useState({loading:true}),[tr,setTr]=useState({loading:true}),[version,setVersion]=useState(0)
 useEffect(()=>{let alive=true;if(!orgId||!userId)return;setTh({loading:true});setTr({loading:true});
  getThesisAnalytics(supabase,{orgId}).then(data=>alive&&setTh({data,loading:false})).catch(error=>alive&&setTh({error,loading:false}))
  getTradeAnalytics(supabase,{orgId}).then(data=>alive&&setTr({data,loading:false})).catch(error=>alive&&setTr({error,loading:false}))
  return()=>{alive=false}
 },[orgId,userId,supabase,version])
 const a=th.data,statusEntries=Object.entries(a?.count_by_status||{}),outcomes=Object.entries(a?.winloss_by_stance||{})
 return <div className="space-y-6"><div><div className="eyebrow">{t('journal.brand',{defaultValue:'Thesis Journal'})}</div><h1 className="page-title">{t('journal.nav.analytics',{defaultValue:'Analytics'})}</h1></div>
  <ThesisPerformanceLedger supabase={supabase} orgId={orgId} userId={userId}/>
  <section className="space-y-3 border-t border-[var(--border-default)] pt-4" aria-label="Descriptive thesis analytics"><h2>Descriptive thesis analytics</h2>
   {th.loading?<p role="status">Loading thesis analytics…</p>:th.error?<p role="alert">{th.error.message}</p>:a&&<>
    <dl className="intel-thesis-facts"><div><dt>Total</dt><dd>{statusEntries.reduce((sum,[,n])=>sum+Number(n),0)}</dd></div><div><dt>Needs review</dt><dd>{a.needs_review??'—'}</dd></div><div><dt>Average conviction</dt><dd>{a.avg_conviction!=null?`${Math.round(a.avg_conviction*50)/10}/5`:'—'}</dd></div><div><dt>Average quality</dt><dd>{a.avg_quality!=null?`${a.avg_quality}/100`:'—'}</dd></div></dl>
    <p>{statusEntries.map(([status,count])=>`${status.replaceAll('_',' ')}: ${count}`).join(' · ')}</p>
    {outcomes.length>0&&<details><summary>User-marked thesis outcomes by stance</summary><p>Descriptive status counts, separate from windowed performance assessments and realized P&L.</p><table className="w-full text-sm"><thead><tr className="text-left"><th>Stance</th><th>Confirmed / partially confirmed</th><th>Invalidated</th></tr></thead><tbody>{outcomes.map(([stance,value])=><tr key={stance}><td>{stance}</td><td>{value.wins??0}</td><td>{value.losses??0}</td></tr>)}</tbody></table></details>}
    <p>{a.rule_violations??0} invalidation conditions triggered · {a.trades_without_thesis??0} trades without a thesis</p>
   </>}
  </section>
  {tr.error?<p role="alert">{tr.error.message}</p>:<TradeAnalyticsPanel analytics={tr.data} loading={tr.loading}/>}
  {(th.error||tr.error)&&<button className="btn" onClick={()=>setVersion(v=>v+1)}>Retry analytics</button>}
  {portfolio.error?<p role="alert">{portfolio.error.message}</p>:<PortfolioThesisInsights supabase={supabase} portfolioId={portfolio.portfolioId}/>}
  <IntelDisclaimer variant="block"/>
 </div>
}
