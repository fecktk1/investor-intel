import React,{useState} from 'react'
import {useTranslation} from 'react-i18next'
import {InvestigationTable,time,value} from './InvestigationTable'
const reasons={portfolio_period_unavailable:'The portfolio period has incomplete valuation or transaction evidence.',exact_index_observation_missing:'No unambiguous CMC index observation matches both valuation times.',exact_flow_index_observation_missing:'A capital movement has no index observation at its exact effective time.',benchmark_capital_exhausted:'The same withdrawal would exhaust the hypothetical index position.',invalid_flow_input:'The recorded movement has invalid timing or value.',invalid_numeric_range:'The calculation exceeds the supported numeric range.',index_history_read_failed:'CMC index history could not be read. Retry the calculation.',portfolio_history_read_failed:'Portfolio history could not be read.',source_limit_exceeded:'The source history exceeds the supported read window.',current_source_permission_required:'Current source permission does not allow this retained comparison.',two_dated_snapshots_required:'Two dated portfolio valuations are required.',unsupported_time_window:'The valuation window is unsupported.'}
export default function PortfolioCashflowBenchmark({comparisons}){
 const {t}=useTranslation('intel',{useSuspense:false}),[index,setIndex]=useState('100'),e=comparisons?.find(r=>r.index===index)
 if(!e)return null
 const reason=key=>t(`portfolio.benchmark_reason_${key}`,{defaultValue:reasons[key]||'This period cannot be compared with the available evidence.'})
 const original=id=>e.observations?.find(o=>o.id===id)
 return <details className="my-3"><summary>{t('portfolio.flow_benchmark_title',{defaultValue:'CMC comparison with the same capital movements'})}</summary>
  {e.note&&<details className="text-sm my-2"><summary>{t('portfolio.flow_benchmark_method',{defaultValue:'Method and source requirements'})}</summary><p>{e.note}</p></details>}
  <label className="intel-inline-field max-w-sm">{t('portfolio.flow_benchmark_index',{defaultValue:'Comparison index'})}<select className="select" value={index} onChange={event=>setIndex(event.target.value)}><option value="100">CMC 100</option><option value="20">CMC 20</option></select></label>
  {e.status==='comparable'?<p>{t('portfolio.flow_benchmark_difference',{defaultValue:'Portfolio minus index (percentage points)'})}: <strong>{value(e.differencePercentagePoints)}</strong></p>:<p role={e.status==='error'?'alert':'status'}>{e.reason?reason(e.reason):t('portfolio.flow_benchmark_incomplete',{defaultValue:'A complete comparison is unavailable. Each period below explains its missing evidence.'})}</p>}
  {!!e.periods?.length&&<InvestigationTable pageSize={10} rows={e.periods} caption={t('portfolio.flow_benchmark_periods',{defaultValue:'Identical valuation and capital-movement times'})} columns={[
   [t('portfolio.flow_return_interval',{defaultValue:'Valuation interval'}),r=>`${time(r.from)} – ${time(r.to)}`],
   [t('portfolio.flow_benchmark_book',{defaultValue:'Recorded book return'}),r=>r.portfolioReturnPercent==null?'—':`${value(r.portfolioReturnPercent)}%`],
   [e.label,r=>r.benchmarkReturnPercent==null?'—':`${value(r.benchmarkReturnPercent)}%`],
   [t('portfolio.flow_benchmark_difference',{defaultValue:'Portfolio minus index (percentage points)'}),r=>value(r.differencePercentagePoints)],
   [t('portfolio.flow_return_evidence',{defaultValue:'Calculation evidence'}),r=><details><summary>{r.status==='comparable'?t('portfolio.flow_return_inputs',{defaultValue:'Recorded inputs'}):t('portfolio.flow_return_gap',{defaultValue:'Why unavailable'})}</summary>
    {r.reason&&<p>{reason(r.reason)}</p>}
    {r.status==='comparable'&&<p>{t('portfolio.flow_benchmark_end',{defaultValue:'Hypothetical index closing value (USD)'})}: {value(r.benchmarkEndValueUsd)}</p>}
    {r.observationIds?.map(id=>{const o=original(id);return o?<p key={id} className="break-all">{value(o.value)} {o.unit} · {time(o.observedAt)} · {t('portfolio.flow_benchmark_known',{defaultValue:'Recorded'})} {time(o.recordedAt)} · {o.sourceRef} · {id}</p>:null})}
   </details>],
  ]}/>}
 </details>
}
