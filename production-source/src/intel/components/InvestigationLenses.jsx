import StressSensitivity from './StressSensitivity'
import {ResearchActivityWords,ResearchActivityChanges} from './ResearchActivityRecord'
import {scenarioRules} from '../../../supabase/functions/_shared/intel/stress-scenario-contract'
import {participationRecord} from '../../../supabase/functions/_shared/intel/participation-read.ts'
import React,{lazy,Suspense,useEffect,useMemo,useState} from 'react'
import {Link,useLocation} from 'react-router'
import {useScreenParams} from '../lib/useScreenParams'
import {useTranslation} from 'react-i18next'
import {coverageMatrix,evidenceAt,evidenceChanges,observationState,replayDecision,verifyReceipt,safeSourceUrl} from '../../../supabase/functions/_shared/intel/investigation-evidence.ts'
import {attentionCapital,cohortPerformance,participationQuality,positionLiquidity,liquidityEvents,thesisCounterargument,thesisStress,interpretStressRules,STRESS_BASES,stressSensitivity} from '../../../supabase/functions/_shared/intel/investigation-calculations.ts'
import {equitySession} from '../../../supabase/functions/_shared/intel/investigation-sessions.ts'
import RwaRelationships from './RwaRelationships'
import LiquidationHistory from './LiquidationHistory'
import FragilityHistory from './FragilityHistory'
import VenueEvidence from './VenueEvidence'
import {currentFragility} from '../../../supabase/functions/_shared/intel/fragility-history.ts'
import {cohortSubject,cohortQuoteRows,cohortCompareAsset,cohortResearchPath} from '../lib/cohort-evidence'
import SourceResearchNotes from './SourceResearchNotes'
import CohortPriceCoverage from './CohortPriceCoverage'
import {InvestigationTable,time,value} from './InvestigationTable'
export {InvestigationTable,time,value} from './InvestigationTable'
export function CoverageLens({observations,subject,at,onSelect}) {
  const requirements=[...new Map(observations.filter(o=>o.subject===subject).map(o=>[`${o.metric}:${o.unit}:${o.periodSeconds}`,{metric:o.metric,unit:o.unit,periodSeconds:o.periodSeconds??undefined}])).values()]
  if(!requirements.length)requirements.push({metric:'price',unit:'USD'})
  const rows=coverageMatrix(observations,requirements,subject,at)
  return <InvestigationTable columns={[
    ['Observation',r=><button className="intel-text-link" onClick={()=>onSelect?.(r.observation,r.reason)}>{r.metric.replaceAll('_',' ')}</button>],['State',r=>r.state],['Value',r=>`${value(r.observation?.value)} ${r.unit??''}`],['Provider',r=>r.observation?.provider??'—'],['Observed',r=>time(r.observation?.observedAt)],['Use',r=>r.observation?`${r.observation.aiAllowed?'AI permitted':'Display only'} · ${r.observation.exportAllowed?'export permitted':'references only'}`:r.reason],
  ]} rows={rows} caption="Evidence for the selected time. Missing observations never become zero."/>
}
export function ReplayLens({events,prices,observations,at,onTime}) {
  const replay=replayDecision(events,prices,observations,at)
  return <><p className="intel-analysis-caption">{replay.events.length} recorded actions known by {time(at)}. {replay.priceObservation?`Last observed market price: $${value(replay.priceObservation.price)}.`:'No price observation within the supported gap.'}</p>
    <InvestigationTable columns={[
      ['Action',r=><button className="intel-text-link" onClick={()=>onTime(r.t)}>{r.action||r.label||r.type}</button>],['Time',r=>time(r.t)],['Original words',r=><ResearchActivityWords event={r}/>],['Changes',r=><ResearchActivityChanges changes={r.changes}/>],
    ]} rows={[...replay.events].reverse()} caption="Decision history"/>
    <p className="intel-analysis-caption">Current holdings appear above. Historical holdings are not inferred from a partial activity window.</p></>
}
export function FragilityLens({observations,subject,at,onSelect,from,onTime}) {
  const [view,setView]=useState('venues')
  const result=currentFragility(observations,subject,at)
  return <><label className="intel-inline-field">Market structure view<select className="select" value={view} onChange={e=>setView(e.target.value)}><option value="venues">Current venues and liquidation windows</option><option value="history">Concentration history</option></select></label>{view==='history'?<FragilityHistory observations={observations} subject={subject} from={from} at={at} onTime={onTime} onSelect={onSelect}/>:<><p className="intel-analysis-caption">{result.coverage} {result.coveredContracts} / {result.suppliedContracts} contracts included. {result.excluded.length} excluded. {result.coverageNote} {result.batchKnownAt&&<>Recorded {time(result.batchKnownAt)}.</>}</p>
    <VenueEvidence observations={observations} subject={subject} at={at} onSelect={onSelect}/>
    <details className="intel-source-record"><summary>Compare venue shares visually</summary><div className="intel-contribution-bars" aria-label="Share of covered open interest">{result.venues.map(v=><div key={v.id}><span>{v.name}</span><span className="intel-contribution-track"><span style={{width:`${v.sharePercent??0}%`}}/></span><strong>{v.sharePercent==null?'No denominator':`${value(v.sharePercent)}%`}</strong></div>)}</div></details>
    {result.excluded.length>0&&<details><summary>Excluded observations</summary><ul>{result.excluded.map((r,i)=><li key={i}>{r.id}: {r.reason}</li>)}</ul></details>}<LiquidationHistory observations={observations} subject={subject} at={at} from={from} onSelect={onSelect} onTime={onTime}/></>}</>
}
function attentionRows(observations,at) {
  const known=evidenceAt(observations,at),ranks=known.filter(o=>o.metric==='attention_rank')
  return ranks.map(rank=>{const get=m=>known.filter(o=>o.subject===rank.subject&&o.metric===m).sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt))[0];const volume=get('volume_24h'),cap=get('market_cap');return {subject:rank.subject,name:rank.metadata?.name||rank.subject,rank:rank.value,rankTime:Date.parse(rank.observedAt),volumeUsd:volume?.value??null,quoteTime:volume?Date.parse(volume.observedAt):null,marketCapUsd:cap?.value??null}})
}
export function AttentionLens({observations,at,onAsset}) {
  const rows=attentionCapital(attentionRows(observations,at),attentionRows(observations,at-3600000)),comparable=rows.filter(r=>r.rankChange!=null&&r.volumeChangePercent!=null)
  const xMax=Math.max(1,...comparable.map(r=>Math.abs(r.rankChange))),yMax=Math.max(1,...comparable.map(r=>Math.abs(r.volumeChangePercent)))
  return <><p className="intel-analysis-caption">Attention rank versus reported 24-hour volume, compared with evidence known one hour earlier. This describes disagreement; it does not establish causality.</p>
    {comparable.length>0&&<svg viewBox="0 0 620 280" className="intel-attention-plot" role="img" aria-label="Attention improvement versus volume change. Equivalent values and asset links follow in the table."><line x1="310" x2="310" y1="20" y2="240"/><line x1="50" x2="570" y1="130" y2="130"/><text x="310" y="274" textAnchor="middle">Attention rank improvement →</text><text x="10" y="16">Volume change ↑</text>{comparable.map(r=><circle key={r.subject} cx={310+r.rankChange/xMax*240} cy={130-r.volumeChangePercent/yMax*100} r="5"><title>{r.name}: rank {value(r.rankChange)}, volume {value(r.volumeChangePercent)}%</title></circle>)}</svg>}
    <InvestigationTable rows={rows} columns={[
      ['Asset',r=><button className="intel-text-link" onClick={()=>onAsset(r.subject)}>{r.name}</button>],['Rank improvement',r=>value(r.rankChange)],['Volume change',r=>r.volumeChangePercent==null?'—':`${value(r.volumeChangePercent)}%`],['Volume / market cap',r=>value(r.turnover)],['Observation',r=>r.pattern],
    ]}/></>
}
export function DeltaLens({observations,at,seenAt,onSeen,onTime,baselineError}) {
  const result=evidenceChanges(seenAt?observations:null,observations,seenAt?Date.parse(seenAt):null,at)
  return <><p className="intel-analysis-caption">{baselineError?'Your prior visit could not be loaded. Retry the evidence read before comparing changes.':result.baseline?'This is your first recorded visit. Establish a baseline for future evidence changes.':`Compared with your visit at ${time(seenAt)}. Expired source evidence may limit the comparison.`}</p>
    <InvestigationTable rows={baselineError?[]:result.changes} columns={[
      ['Observation',r=><button className="intel-text-link" onClick={()=>onTime(Date.parse(r.after?.observedAt||r.before?.observedAt))}>{r.metric.replaceAll('_',' ')}</button>],['Change',r=>r.kind],['Before',r=>`${value(r.before?.value)} ${r.unit}`],['Now',r=>`${value(r.after?.value)} ${r.unit}`],['Coverage',r=>`${r.stateBefore} → ${r.stateAfter}`],
    ]}/><button className="btn mt-3" onClick={onSeen}>{result.baseline?'Establish baseline':'Mark reviewed through now'}</button></>
}
export function StressLens({thesis,observations,subject,at,counterargument=false,initialScenario=null,onScenarioChange,onPrepareReceipt}) {
  const [overrides,setOverrides]=useState(initialScenario?.overrides||{}),[bases,setBases]=useState(initialScenario?.bases||{}),[focusRule,setFocusRule]=useState(initialScenario?.focusRule||null)
  useEffect(()=>{if(!onScenarioChange||counterargument||!thesis?.id)return;try{onScenarioChange({thesisId:thesis.id,expectedRules:scenarioRules(thesis.rules||[]),overrides,bases,focusRule})}catch{onScenarioChange(null)}},[thesis,overrides,bases,focusRule,counterargument,onScenarioChange])
  const rules=interpretStressRules(thesis?.rules||[],bases),rows=thesisStress(rules,observations,subject,overrides,at)
  const counter=thesisCounterargument(rules,observations,subject,at,thesis?.authored_draft||{})
  if(!thesis)return <p>Select a thesis to examine your own stated conditions. <Link className="intel-text-link" to="/intel/theses/new">Create a thesis</Link></p>
  if(counterargument)return <><p>{counter.conclusion}</p><InvestigationTable rows={counter.disagreements} columns={[
    ['Your condition',r=>r.condition],['Evidence to examine',r=>`${value(r.observation.value)} ${r.observation.unit} · ${time(r.observation.observedAt)}`],['Why it challenges the thesis',r=>r.reason],
  ]}/>{counter.missing.length>0&&<details open><summary>Questions the evidence cannot answer</summary><ul>{counter.missing.map((r,i)=><li key={i}>{r.question} {r.reason}</li>)}</ul></details>}{counter.authoredQuestions.map(r=><blockquote key={r.field}>{r.words}<p>{r.question}</p></blockquote>)}</>
  return <><p className="intel-analysis-caption">Scenario rehearsal. Hypothetical inputs never change holdings or your thesis. Record a review explicitly when ready.</p><InvestigationTable rows={rows} columns={[
    ['Your condition',r=><><button className="intel-text-link" onClick={()=>setFocusRule(r.rule.id)}>{r.rule.label||`${r.rule.metric} ${r.rule.comparator} ${r.rule.threshold}`}</button>{['price_move','volume_spike','tvl_change'].includes(thesis.rules.find(rule=>rule.id===r.rule.id)?.metric)&&<label className="intel-inline-field">Evidence basis<select className="select" value={bases[r.rule.id]||''} onChange={e=>{setBases(b=>({...b,[r.rule.id]:e.target.value}));setOverrides({})}}><option value="">Choose unit and period</option>{Object.entries(STRESS_BASES).map(([key,b])=><option key={key} value={key}>{b.label}</option>)}</select></label>}</>],['Current',r=>`${value(r.current)} ${r.observation?.unit||r.rule.unit||''}`],['Scenario value',r=><input className="input w-32" aria-label={`Scenario ${r.rule.metric}`} type="number" disabled={r.rule.interpretationRequired} value={overrides[r.scenarioKey]??''} placeholder={r.current==null?'Unknown':String(r.current)} onChange={e=>setOverrides(s=>{const n={...s};if(e.target.value==='')delete n[r.scenarioKey];else n[r.scenarioKey]=Number(e.target.value);return n})}/>],['Current / scenario',r=>`${r.currentlyMet==null?'Unknown':r.currentlyMet?'Met':'Not met'} / ${r.scenarioMet==null?'Unknown':r.scenarioMet?'Met':'Not met'}`],['Coverage',r=><>{r.reason||'Dated observation available'}{r.observation?.metric==='depth_notional'&&<p className="intel-analysis-caption">{r.observation.metadata?.venue} · {r.observation.metadata?.pair} · {r.observation.metadata?.side}. Best level only · observed {time(r.observation.observedAt)} · known {time(r.observation.recordedAt)}. Values expire with the source snapshot; saved receipts retain references only.</p>}</>],
  ]}/><button className="btn mt-3" onClick={()=>{setOverrides({});setBases({});setFocusRule(null)}}>Reset scenario</button>{onPrepareReceipt&&<button className="btn mt-3 ml-3" onClick={onPrepareReceipt}>Save scenario receipt</button>}<StressSensitivity row={rows.find(r=>r.rule.id===focusRule)||rows[0]}/>{!rules.length&&<p>This thesis has no testable numeric conditions yet. Add rules in the Thesis Journal.</p>}</>
}
export function CohortLens({cohort,quotes,at,onCapture,onAsset,busy,reason}) {
  const location=useLocation(),[screen,setScreen]=useScreenParams('cohort_', {scope:'',weight:'equal',selected:'',page:0})
  const scope=cohort?.id||'',current=screen.scope===scope?screen:{weight:'equal',selected:'',page:0}
  const weight=current.weight==='cap'?'cap':'equal',selected=current.selected.split(',').filter(cohortSubject).slice(0,4)
  const change=patch=>setScreen(old=>{const base=old.scope===scope?old:{weight:'equal',selected:'',page:0};return {...base,...(typeof patch==='function'?patch(base):patch),scope}})
  const setWeight=weight=>change({weight}),setSelected=updater=>change(old=>({selected:updater(old.selected.split(',').filter(cohortSubject)).slice(0,4).join(',')}))
  const returnTo=location.pathname+location.search
  const beforeCapture=cohort&&Date.parse(cohort.created_at)>at
  const quoteRows=cohortQuoteRows(cohort,quotes,at),result=cohortPerformance(cohort?.members||[],quoteRows,at)
  const quotesBySubject=new Map(quoteRows.map(q=>[q.subject,q]))
  const chosen=result.rows.filter(r=>selected.includes(r.subject)).slice(0,4),compareAssets=chosen.map(cohortCompareAsset)
  const contribution=r=>weight==='cap'?r.capWeightContribution:r.equalWeightContribution
  const plotted=[...result.rows].filter(r=>contribution(r)!=null).sort((a,b)=>Math.abs(contribution(b))-Math.abs(contribution(a))).slice(0,12),max=Math.max(1,...plotted.map(r=>Math.abs(contribution(r))))
  if(beforeCapture)return <p role="status">This cohort was first recorded at {time(cohort.created_at)}, after the selected time. Move the timeline forward or select Now to see its original constituents.</p>
  return <><p className="intel-analysis-caption">{cohort?`${cohort.name}. First collected ${time(cohort.created_at)}. ${result.comparableMembers} / ${result.originalMembers} constituents have comparable prices.`:'Start a dated cohort from the current source list. The original members remain visible if later prices disappear.'}</p>{reason&&<p role="status">{reason}</p>}
    {cohort&&quotes?.state&&quotes.state!=='fresh'&&<p role="status">Cohort prices are {quotes.state}. {quotes.reason==='refresh_required'||quotes.reason==='refreshing'?'The shared price refresh is pending. Select Refresh evidence to check again.':quotes.reason==='missing_coverage'?'The source did not return every original constituent.':quotes.reason||'Some observations are outside their freshness window.'}</p>}
    {cohort?.source_reference&&<SourceResearchNotes reference={cohort.source_reference} title={`${cohort.name} · original discovery source`} workspacePath={cohortResearchPath(cohort)}/>} 
    {!cohort&&<button className="btn" onClick={onCapture} disabled={busy}>Start tracking this cohort</button>}
    {cohort&&<><p className="intel-analysis-caption">Breadth among comparable members: {value(result.breadthPercent)}%. Known {weight==='cap'?'initial-cap-weighted':'equal-weighted'} contribution: {value(weight==='cap'?result.knownCapContribution:result.knownEqualContribution)} percentage points. {result.coverage}</p><div className="intel-investigation-controls"><label>Contribution weighting<select value={weight} onChange={e=>setWeight(e.target.value)}><option value="equal">Equal original weights</option><option value="cap">Initial market-cap weights</option></select></label>{chosen.length>=2&&<Link className="intel-text-link" to={`/intel/compare?assets=${encodeURIComponent(JSON.stringify(compareAssets))}&returnTo=${encodeURIComponent(returnTo)}`}>Compare current charts ({chosen.length})</Link>}</div><p className="intel-analysis-caption">Largest five original weights: {value(result.initialTopFiveWeightPercent)}%. Initial concentration (sum of squared weights): {value(result.initialConcentrationHhi)}. Missing weights remain unknown.</p>{plotted.length>0&&<figure className="intel-cohort-contributions"><figcaption>Largest 12 known contributions · percentage points</figcaption>{plotted.map(r=><div key={r.subject}><span>{r.name}</span><span className="intel-cohort-track"><span style={{left:contribution(r)<0?`${50-Math.abs(contribution(r))/max*50}%`:'50%',width:`${Math.abs(contribution(r))/max*50}%`,background:contribution(r)<0?'var(--signal-red)':'var(--signal-green)'}}/></span><span>{value(contribution(r))}</span></div>)}</figure>}<InvestigationTable rows={result.rows} page={current.page} onPageChange={page=>change({page})} columns={[
      ['Original constituent',r=><div className="intel-cohort-selection"><input type="checkbox" aria-label={`Compare ${r.name}`} checked={selected.includes(r.subject)} disabled={!selected.includes(r.subject)&&chosen.length>=4} onChange={e=>setSelected(ids=>e.target.checked?[...ids,r.subject]:ids.filter(id=>id!==r.subject))}/><button className="intel-text-link" onClick={()=>onAsset(r.subject)}>{r.name}</button></div>],['First price',r=>value(r.initialPrice)],['Retained price',r=>value(r.currentPrice)],['Return',r=>r.returnPercent==null?'—':`${value(r.returnPercent)}%`],['Contribution (points)',r=>value(contribution(r))],['Coverage',r=><CohortPriceCoverage row={r} quote={quotesBySubject.get(r.subject)} at={at}/>],
    ]}/></>}</>
}
export function SessionsLens({at,market}) {
  const result=equitySession(at,market)
  return <><p className="intel-analysis-caption">Token trading, the underlying market and redemption are separate clocks.</p><div className="intel-session-ruler">{result.sessions?.slice(0,5).map(s=><div key={s.date}><time>{s.date}</time><span className="intel-session-bar">{time(s.open)} to {time(s.close)}</span><span>{s.earlyClose?'Early close':'Core session'}</span></div>)}</div>
    <InvestigationTable rows={[
      {id:'underlying',name:'Underlying core equity session',state:result.state,detail:result.reason},
      {id:'token',name:'Token venue',state:'Requires venue evidence',detail:'An underlying exchange calendar does not establish token trading hours.'},
      {id:'redemption',name:'Issuer redemption',state:'Requires issuer terms',detail:'Eligibility, minimum size and settlement terms must be verified for the selected token and issuer.'},
    ]} columns={[[ 'Clock',r=>r.name],['Status',r=>r.state],['Evidence',r=>r.detail]]}/><a className="intel-text-link" href={result.sourceUrl} target="_blank" rel="noreferrer">Official calendar</a></>
}
export function ParticipationLens({snapshots,at,subject}) {
  const rows=snapshots.filter(r=>Date.parse(r.computed_at)<=at).sort((a,b)=>Date.parse(b.computed_at)-Date.parse(a.computed_at)),map=r=>participationRecord(r,subject),current=rows[0]?map(rows[0]):null
  const r=current?participationQuality(current,rows[1]?map(rows[1]):null,at):null
  return <><p className="intel-analysis-caption">{r?.coverage||'No holder observations have been recorded for this exact chain and contract.'}</p>{r&&<InvestigationTable rows={[
    {id:'holders',metric:'Holder accounts',current:r.holderCount,change:r.holderCountChange},
    {id:'top1',metric:'Largest account / sampled balances (%)',current:current.sampledTop1Percent,change:null},
    {id:'top10',metric:'Largest ten accounts (%)',current:r.top10Percent,change:r.top10ChangePoints},
    {id:'traders',metric:'Unique traders in reported period',current:r.uniqueTraders,change:null},
  ]} columns={[[ 'Observation',v=>v.metric],['Current',v=>value(v.current)],['Comparable change',v=>value(v.change)],['Source',()=>r.provider],['Computed',()=>time(r.observedAt)]]}/>}<p className="intel-analysis-caption">{current?.countReason} {current?.clockMeaning} {r&&!r.comparable?'A comparable prior observation with the same provider and population is needed for concentration changes.':''}</p></>
}
export function LiquidityLens({holding,observations,subject,at,events=[],depth=null,depthQuotes=[]}) {
  const [depthKey,setDepthKey]=useState(''),[hypothetical,setHypothetical]=useState(''),known=evidenceAt(observations,at),price=known.find(o=>o.subject===subject&&o.metric==='price'&&observationState(o,at)==='known'),tvl=known.find(o=>o.subject===subject&&o.metric==='tvl'&&observationState(o,at)==='known')
  const selectedDepth=depthQuotes.find(d=>`${d.sourceRef}:${d.side}`===depthKey)||depthQuotes[0]||depth
  const result=positionLiquidity(hypothetical===''?holding?.quantity:Number(hypothetical),price?.value,tvl?.value,selectedDepth,subject,at),liquidity=liquidityEvents(events,subject,at-30*86400000,at)
  return <>{depthQuotes.length>0&&<label className="intel-inline-field">Recorded venue and side<select value={selectedDepth?`${selectedDepth.sourceRef}:${selectedDepth.side}`:''} onChange={e=>setDepthKey(e.target.value)}>{depthQuotes.map(d=><option key={`${d.sourceRef}:${d.side}`} value={`${d.sourceRef}:${d.side}`}>{d.venue} · {d.pair} · {d.side}</option>)}</select></label>}<label className="intel-inline-field">Hypothetical quantity<input className="input" type="number" min="0" value={hypothetical} placeholder={String(holding?.quantity??'')} onChange={e=>setHypothetical(e.target.value)}/></label><p className="intel-analysis-caption">{hypothetical===''?'Using your recorded current position.':'Scenario size; your holdings are unchanged.'} Value: ${value(result.valueUsd)}. Position / reported TVL: {value(result.positionToTvlPercent)}%. {result.reason}</p>
    {result.execution&&<><p className="intel-analysis-caption">{selectedDepth?.coverage} Observed {time(selectedDepth?.observedAt)}. {result.execution.complete?'Requested size fits the recorded level.':'Only part of the requested size is covered; the remainder has no price estimate.'}</p><InvestigationTable rows={[result.execution]} columns={[[ 'Side',r=>r.side],['Requested quantity',r=>value(r.requestedQuantity)],['Covered quantity',r=>value(r.coveredQuantity)],['Uncovered quantity',r=>value(r.uncoveredQuantity)],['Covered average (USD)',r=>value(r.averagePrice)],['Covered gross (USD)',r=>value(r.grossUsd)],['Fees (USD)',r=>r.feeUsd==null?'Unknown':value(r.feeUsd)]]}/></>}
    {liquidity.events.length>0&&<InvestigationTable rows={liquidity.events} columns={[[ 'Recorded event',r=>r.kind],['Pool',r=>r.pool],['Time',r=>time(r.timestamp)],['Value (USD)',r=>value(r.valueUsd)],['Transaction',r=>r.transactionRef]]}/>}<p className="intel-analysis-caption">{liquidity.coverage} {liquidity.events.length===0&&!known.some(o=>o.subject===subject&&o.metric==='liquidity_event_usd')?'No retained pool liquidity events are available in this period.':''}</p></>
}
const ReceiptReplay=lazy(()=>import('./ReceiptReplay'))
export function ReceiptView({receipt}) {
  const [replay,setReplay]=useState(false)
  const {t}=useTranslation('intel',{useSuspense:false})
  return <article className="intel-receipt"><h3>{t('investigation.receipt',{defaultValue:'Research receipt'})}</h3><p>{receipt.question}</p><blockquote className="whitespace-pre-wrap">{receipt.decision}</blockquote><p className="intel-analysis-caption">{time(receipt.createdAt)} · evidence at {time(receipt.cursor)} · calculation {receipt.calculationVersion}</p><InvestigationTable rows={receipt.observationRefs||[]} columns={[[ 'Observation',r=>r.metric?`${r.metric.replaceAll('_',' ')}${r.periodSeconds?` · ${r.periodSeconds/3600}h`:''}`:'Original reference'],['Source',r=><details><summary>{r.provider==='coinmarketcap'?'CoinMarketCap':r.provider}</summary>{safeSourceUrl(r.sourceUrl)?<a className="intel-text-link break-all" href={safeSourceUrl(r.sourceUrl)} target="_blank" rel="noreferrer">{r.sourceRef}</a>:r.sourceRef}</details>],['Observed',r=>time(r.observedAt)],['Unit',r=>r.unit]]}/>{receipt.gaps?.map((gap,i)=><p key={i}>{gap}</p>)}<p className="intel-analysis-caption">{receipt.observationRefs?.length||0} source references saved · {receipt.observations?.length||0} permitted values included for replay. Unavailable values are not reconstructed.</p><button className="btn" aria-expanded={replay} onClick={()=>setReplay(v=>!v)}>{replay?'Close saved replay':'Replay saved evidence'}</button>{replay&&<Suspense fallback={<p role="status">Loading saved replay…</p>}><ReceiptReplay key={receipt.fingerprint} receipt={receipt}/></Suspense>}</article>
}
