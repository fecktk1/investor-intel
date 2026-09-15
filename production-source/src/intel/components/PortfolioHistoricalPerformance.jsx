import React,{useEffect,useRef,useState} from 'react'
import {useTranslation} from 'react-i18next'
import PortfolioCashflowBenchmark from './PortfolioCashflowBenchmark'
const number=v=>v==null?'—':Number(v).toLocaleString(undefined,{maximumFractionDigits:3})
const date=v=>v&&Number.isFinite(Date.parse(v))?new Date(v).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'long'}):'Time unavailable'
const reasons={
 two_dated_snapshots_required:'Two dated snapshots are required.',snapshot_history_not_verified:'This snapshot predates recorded quantity and history checks, or its transaction history is incomplete.',
 incomplete_snapshot_valuation:'A snapshot has missing identity, quantity or fresh valuation evidence.',snapshot_total_mismatch:'The recorded positions do not reconcile to the snapshot total.',
 quantity_reconciliation_failed:'Recorded transactions do not reconcile the opening and closing quantities.',flow_value_not_recorded:'A capital movement has no recorded USD value.',
 fee_value_not_recorded:'A fee has no verified USD amount.',fee_identity_unavailable:'The native fee asset could not be identified.',
 trade_counterleg_missing:'A synced trade is missing its counterparty asset leg.',unclassified_or_incomplete_transaction:'A transaction needs classification or complete asset legs.',
 unsupported_transaction_type:'This period contains activity whose effect on the portfolio cannot yet be established.',transaction_time_missing:'A transaction has no effective time.',
 input_limit_exceeded:'This calculation exceeds its supported input window.',incomplete_manual_swap:'Both sides of a manual swap must have the same effective time.',
 non_positive_or_invalid_capital:'The weighted invested capital is not positive or cannot be represented safely.',conflicting_transfer_times:'Linked transfer records have conflicting effective times.',
 invalid_snapshot_clock:'A snapshot has an invalid or future observation time.',non_increasing_snapshot_clock:'Snapshot observation times must increase.',invalid_return_range:'The result exceeds the supported return range.',incomplete_transaction_leg:'A transaction leg is missing its identity, quantity or direction.',
}
export default function PortfolioHistoricalPerformance({performance=null,supabase,orgId,portfolioId}){
 const {t}=useTranslation('intel',{useSuspense:false}),[current,setCurrent]=useState(null),[loading,setLoading]=useState(false),[page,setPage]=useState(0),mounted=useRef(true)
 useEffect(()=>{mounted.current=true;return ()=>{mounted.current=false}},[])
 const result=performance||current,periods=result?.periods||[],last=Math.max(0,Math.ceil(periods.length/10)-1),visible=periods.slice(Math.min(page,last)*10,Math.min(page,last)*10+10)
 async function load(){
  if(loading)return;setLoading(true)
  try{const {data,error}=await supabase.functions.invoke('intel-portfolio',{body:{orgId,portfolioId,operation:'performance'}});if(error||!data?.performance)throw Error('read_failed');if(mounted.current){setCurrent(data.performance);setPage(0)}}
  catch{if(mounted.current)setCurrent({status:'error'})}
  finally{if(mounted.current)setLoading(false)}
 }
 return <details className="py-3 border-b border-[var(--border-default)]"><summary>{t('portfolio.flow_return_title',{defaultValue:'Return after capital movements'})}</summary>
  <p className="text-sm my-2">{t('portfolio.flow_return_intro',{defaultValue:'Use dated valuations and recorded transactions to separate capital movements from changes in your asset book. Unsupported periods remain gaps.'})}</p>
  {!performance&&supabase&&<button type="button" className="btn btn--quiet btn--sm" disabled={loading} onClick={load}>{loading?t('portfolio.flow_return_loading',{defaultValue:'Reading history…'}):result?t('portfolio.flow_return_refresh',{defaultValue:'Refresh calculation'}):t('portfolio.flow_return_load',{defaultValue:'Calculate from recorded history'})}</button>}
  {loading&&<p role="status">{t('portfolio.flow_return_loading',{defaultValue:'Reading history…'})}</p>}
  {result?.status==='error'&&<p role="alert">{t('portfolio.flow_return_error',{defaultValue:'Performance history could not be read. Retry the calculation; no return has been inferred.'})}</p>}
  {result&&result.status!=='error'&&<>
   <details className="text-sm my-2"><summary>{t('portfolio.flow_return_method',{defaultValue:'Method and input version'})}</summary><p>{result.note}</p>{result.version&&<p className="text-xs break-all">{t('portfolio.flow_return_version',{defaultValue:'Recorded input version'})}: {result.version}</p>}</details>
   {result.status==='estimate'?<p>{t('portfolio.flow_return_estimate',{defaultValue:'Estimated return'})}: <strong>{number(result.returnPercent)}%</strong> · {t('portfolio.flow_return_gain',{defaultValue:'Change after capital movements'})}: {number(result.changeAfterFlowsUsd)} USD</p>:<p>{reasons[result.reason]||t('portfolio.flow_return_incomplete',{defaultValue:'A complete return is unavailable. Review the affected periods below; older snapshots are not reconstructed from current balances.'})}</p>}
   {!!periods.length&&<div className="intel-table-scroll" tabIndex={0} role="region" aria-label={t("portfolio.flow_return_evidence",{defaultValue:"Calculation evidence"})}><table><caption>{t('portfolio.flow_return_periods',{defaultValue:'Recorded periods · past 90 days'})}</caption><thead><tr><th>{t('portfolio.flow_return_interval',{defaultValue:'Valuation interval'})}</th><th>{t('portfolio.flow_return_estimate',{defaultValue:'Estimated return'})}</th><th>{t('portfolio.flow_return_flows',{defaultValue:'Net capital movements (USD)'})}</th><th>{t('portfolio.flow_return_evidence',{defaultValue:'Calculation evidence'})}</th></tr></thead><tbody>{visible.map((p,i)=><tr key={`${p.from}:${p.to}:${i}`}><td><time dateTime={p.from}>{date(p.from)}</time><br/><time dateTime={p.to}>{date(p.to)}</time></td><td>{p.returnPercent==null?'—':`${number(p.returnPercent)}%`}</td><td>{p.status==='estimate'?number(p.netFlowsUsd):'—'}</td><td><details><summary>{p.status==='estimate'?t('portfolio.flow_return_inputs',{defaultValue:'Recorded inputs'}):t('portfolio.flow_return_gap',{defaultValue:'Why unavailable'})}</summary>
    {p.issues?.map(issue=><p key={issue}>{reasons[issue]||issue.replaceAll('_',' ')}</p>)}
    <p>{t('portfolio.flow_return_values',{defaultValue:'Opening / closing value (USD)'})}: {number(p.startValueUsd)} / {number(p.endValueUsd)}</p>
    <p>{t('portfolio.flow_return_capital',{defaultValue:'Weighted capital (USD)'})}: {p.status==='estimate'?number(p.weightedCapitalUsd):'—'}</p>
    {!!p.flows?.length&&<FlowRows rows={p.flows} t={t}/>}
    <p className="text-xs break-all">{t('portfolio.flow_return_snapshots',{defaultValue:'Snapshot references'})}: {p.snapshotIds?.join(' · ')}</p>
   </details></td></tr>)}</tbody></table></div>}
   {last>0&&<div className="flex gap-3 items-center my-2"><button type="button" className="btn btn--quiet" disabled={!page} onClick={()=>setPage(p=>p-1)}>{t('portfolio.flow_return_previous',{defaultValue:'Earlier periods'})}</button><span>{Math.min(page,last)+1} / {last+1}</span><button type="button" className="btn btn--quiet" disabled={page>=last} onClick={()=>setPage(p=>p+1)}>{t('portfolio.flow_return_next',{defaultValue:'Later periods'})}</button></div>}
   <PortfolioCashflowBenchmark key={result.version||'unavailable'} comparisons={result.benchmarkComparisons}/>
  </>}
 </details>
}
function FlowRows({rows,t}){
 const [page,setPage]=useState(0),last=Math.ceil(rows.length/10)-1
 return <><div className="intel-table-scroll" tabIndex={0} role="region" aria-label={t("portfolio.flow_return_evidence",{defaultValue:"Calculation evidence"})}><table><thead><tr><th>{t('portfolio.flow_return_time',{defaultValue:'Effective time'})}</th><th>USD</th><th>{t('portfolio.flow_return_reference',{defaultValue:'Activity reference'})}</th></tr></thead><tbody>{rows.slice(page*10,page*10+10).map((f,i)=><tr key={i}><td>{date(f.at)}</td><td>{number(f.valueUsd)}</td><td className="break-all">{f.id}</td></tr>)}</tbody></table></div>{last>0&&<div className="flex gap-3"><button type="button" className="btn" disabled={!page} onClick={()=>setPage(p=>p-1)}>{t('portfolio.flow_return_previous_flows',{defaultValue:'Previous movements'})}</button><button type="button" className="btn" disabled={page===last} onClick={()=>setPage(p=>p+1)}>{t('portfolio.flow_return_next_flows',{defaultValue:'Next movements'})}</button></div>}</>
}
