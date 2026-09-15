import React,{useState} from 'react'
import { useTranslation } from 'react-i18next'
import VenueEvidence from '../VenueEvidence'
import {InvestigationTable} from '../InvestigationTable'
import AdoptionAttentionEvidence from '../AdoptionAttentionEvidence'
import {SecuritySourceHistory,RwaSourceEvidence} from '../MarketSourceHistory'
import BenchmarkEvidence from '../BenchmarkEvidence'
import RepresentationNotice from '../RepresentationNotice'

// Display only the authorized, frozen pack supplied by the parent. Expanding
// these disclosures performs no research generation or provider reads.
export default function SpecialistEvidenceDetails({ specialist, allowSourcePaging=false }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const label = (key, fallback) => t(`journal.specialist.${key}`, { defaultValue: fallback })
  const unknown = label('unknown', 'Unknown')
  const derivatives = specialist?.derivatives_state, holders = specialist?.holder_state
  const contract = specialist?.cmc_contract_state
  const [contractMetric,setContractMetric]=useState('all')
  const contractRows=(contract?.observations||[]).filter(o=>contractMetric==='all'||o.metric===contractMetric)
  const utc=v=>Number.isFinite(Date.parse(v))?new Date(v).toLocaleString(undefined,{timeZone:'UTC',dateStyle:'medium',timeStyle:'medium'}):unknown
  const state = value => <p role={value.status === 'error' ? 'alert' : undefined}>{value.status}{value.reason ? ` · ${value.reason}` : ''}</p>
  return <>
    <RepresentationNotice record={specialist?.representation_state??null}/>
    <RwaSourceEvidence history={specialist?.rwa_state} saveable={allowSourcePaging}/>
    <SecuritySourceHistory history={specialist?.security_state} saveable={allowSourcePaging}/>
    <BenchmarkEvidence evidence={specialist?.benchmark_state} asset={specialist?.connected_identity?.requested||specialist?.benchmark_state?.comparisons?.[0]?.subject}/>
    <AdoptionAttentionEvidence comparison={contract?.attention_comparison}/>
    {contract&&contract.status!=='unsupported'&&<details className="my-3"><summary>Retained CMC contract evidence</summary>{state(contract)}<p>{contract.coverage}</p>
    {!!contract.observations?.length&&<label>Observation type <select className="select" value={contractMetric} onChange={e=>setContractMetric(e.target.value)}><option value="all">All retained types</option>{[...new Set(contract.observations.map(o=>o.metric))].map(metric=><option key={metric} value={metric}>{metric.replaceAll('_',' ')}</option>)}</select></label>}
    <InvestigationTable key={contractMetric} pageSize={5} caption="Original contract observations in this evidence version" rows={contractRows} columns={[
      ['Observation',o=>o.metric.replaceAll('_',' ')],['Value',o=>`${typeof o.value==='number'?o.value.toLocaleString(undefined,{maximumSignificantDigits:8}):o.value??unknown} ${o.unit}`],['Observed (UTC)',o=>utc(o.observedAt)],['Recorded (UTC)',o=>utc(o.recordedAt)],['Evidence',o=><details><summary>Source record</summary><p>Recorded value: {o.value??unknown} {o.unit}</p><p>{o.observedAt||unknown}</p><p>{o.recordedAt||unknown}</p><p className="break-all">{o.sourceRef}</p></details>],
    ]}/>{contract.has_more&&<p>Additional observations exist beyond this bounded evidence version.</p>}</details>}
    {derivatives && <details className="my-3">
      <summary>{label('derivatives', 'Retained derivatives')}</summary>
      {state(derivatives)}
      {derivatives.coverage && <p>{derivatives.coverage}</p>}
      {Number.isFinite(Date.parse(derivatives.evaluated_at))&&<VenueEvidence observations={derivatives.observations||[]} subject={derivatives.subject} at={Date.parse(derivatives.evaluated_at)} depth={specialist?.liquidity_state?.venue_depth}/>}
      {!!derivatives.observations?.length && <details><summary>All retained source observations ({derivatives.observations.length})</summary><InvestigationTable caption={derivatives.has_more?'Additional observations are outside this bounded pack.':'Frozen source records'} rows={derivatives.observations} columns={[
        ['Metric',o=>o.metric?.replaceAll('_',' ')],['Value',o=>`${o.value??unknown} ${o.unit}`],['Observed (UTC)',o=>o.observedAt||unknown],['Recorded (UTC)',o=>o.recordedAt||unknown],['Source',o=>`${o.provider} · ${o.sourceRef}`],
      ]}/></details>}
    </details>}
    {holders && <details className="my-3">
      <summary>{label('holders', 'Retained holder distribution')}</summary>
      {state(holders)}
      {holders.note && <p>{holders.note}</p>}
      {holders.records?.map((r, index) => <div key={r.sourceRef || index} className="my-3 break-words">
        <p>{r.subject}</p>
        <p>{label('holderCount', 'Reported holder count')}: {r.holderCount ?? unknown} · {label('top10', 'Top 10 concentration')}: {r.top10Percent == null ? unknown : `${r.top10Percent}%`}</p>
        <p>{label('sampledGini', 'Sample Gini')}: {r.sampledGini ?? unknown} · {label('sampledTop1', 'Sample top 1 concentration')}: {r.sampledTop1Percent == null ? unknown : `${r.sampledTop1Percent}%`}</p>
        {r.countReason && <p>{r.countReason}</p>}
        {r.clockMeaning && <p>{r.clockMeaning}</p>}
        <p>{label('observedShort', 'Observed')}: {r.observedAt || unknown} · {label('computed', 'Computed')}: {r.computed_at || unknown}</p>
        <p>{r.provider} · {r.sourceRef}</p>
      </div>)}
    </details>}
  </>
}
