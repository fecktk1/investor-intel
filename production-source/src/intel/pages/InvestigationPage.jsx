import BookCalendar from '../components/BookCalendar'
import React,{useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react'
import {Link,useSearchParams} from 'react-router'
import {useTranslation} from 'react-i18next'
import {useSupabase} from '../../lib/useSupabase'
import {useProfile} from '../../lib/profile-context'
import {nativeAssetChain, marketNativeChain} from '../lib/asset-identity'
import {useResearchThread} from '../context/ResearchThreads'
import {useWatchlistSelection} from '../context/WatchlistSelection'
import ResearchThreadPanel from '../components/ResearchThreadPanel'
import {useInvestigation,invokeInvestigation} from '../lib/useInvestigation'
import {loadMarketDetail} from '../lib/markets-api'
import {loadThesisChart} from '../lib/thesis-chart'
import {useMarketPortfolioIdentity} from '../lib/useMarketPortfolioIdentity'
import {canonicalPortfolioKey,assetEntityAliases,matchesResearchAsset} from '../lib/asset-identity'
import {useAssetPortfolioContext} from '../lib/useAssetPortfolioContext'
import {useAssetThesisHistory} from '../lib/useAssetThesisHistory'
import {getThesis,createReview} from '../lib/thesis-api'
import {normalizeCandles,mergeLinkedAssetMarkers} from '../lib/chart-history'
import {dexLiquidityMarkers} from '../lib/dex-evidence-markers'
import {projectDexEvidence} from '../lib/dex-evidence-projection'
import {verifyReceipt,evidenceAt,safeSourceUrl} from '../../../supabase/functions/_shared/intel/investigation-evidence.ts'
import TokenChart from '../components/TokenChart'
import AssetPortfolioPosition from '../components/AssetPortfolioPosition'
import ReviewComposer from '../components/thesis/ReviewComposer'
import RwaRelationships from '../components/RwaRelationships'
import RwaSessions from '../components/RwaSessions'
import RwaSelectedPosition from '../components/RwaSelectedPosition'
import {DexObservationTable} from '../components/ContractResearchWorkspace'
import LiveFocus from '../components/LiveFocus'
import {EvidenceRecord} from '../components/ResearchEvidence'
import {useMarketResearch} from '../lib/useMarketResearch'
import AdoptionAttentionEvidence from '../components/AdoptionAttentionEvidence'
import {BenchmarkLens} from '../components/BenchmarkEvidence'
import {cohortCaptureMarkers} from '../lib/cohort-evidence'
import {AttentionLens,CohortLens,CoverageLens,DeltaLens,FragilityLens,InvestigationTable,LiquidityLens,ParticipationLens,ReceiptView,ReplayLens,SessionsLens,StressLens,time,value} from '../components/InvestigationLenses'

const LENSES=[['replay','Decision replay','Decisions'],['delta','Evidence changes','Decisions'],['stress','Stress rehearsal','Decisions'],['counterargument','Second opinion','Decisions'],['receipt','Research receipt','Decisions'],['fragility','Leverage concentration','Markets'],['attention','Attention versus capital','Markets'],['sector','Sector rotation','Markets'],['cohort','New-listing cohorts','Markets'],['participation','Participation quality','Markets'],['liquidity','Liquidity and position','Markets'],['ownership','RWA ownership','Real-world assets'],['sessions','Sessions and redemption','Real-world assets'],['coverage','Evidence coverage','Evidence'],['live','Live focus','Evidence']]
const PERIODS={'24H':86400000,'7D':7*86400000,'1M':30*86400000,'3M':90*86400000}
LENSES.push(['benchmark','CMC benchmark comparison','Markets'])
const NATIVE_CMC={'native:bitcoin':'1','native:ethereum':'1027','native:solana':'5426'}
const DEFAULT_NATIVE={'1':'native:bitcoin','1027':'native:ethereum','5426':'native:solana'}
export default function InvestigationPage(){
  const {user}=useSupabase(),{org}=useProfile(),[search]=useSearchParams()
  return <InvestigationWorkspace key={`${user?.id}:${org?.id}:${search.get('asset')||'native:bitcoin'}`} />
}
export function InvestigationWorkspace(){
  const {t}=useTranslation('intel',{useSuspense:false}),{supabase,user}=useSupabase(),{org}=useProfile(),[search,setSearch]=useSearchParams()
  const subject=search.get('asset')||'native:bitcoin',lens=LENSES.some(([id])=>id===search.get('lens'))?search.get('lens'):'replay'
  const range=PERIODS[search.get('range')]?search.get('range'):'1M',category=search.get('category')||null
  const [to,setTo]=useState(Date.now),from=to-PERIODS[range]
  const [cursor,setCursor]=useState(()=>search.has('at')&&Number.isFinite(Number(search.get('at')))?Number(search.get('at')):null)
  const [replaying,setReplaying]=useState(()=>Number.isFinite(Number(search.get('at')))&&search.has('at'))
  const replayTo=value=>{setCursor(value);setReplaying(value!=null)}
  const searchRef=useRef(search)
  useLayoutEffect(()=>{searchRef.current=search},[search])
  const update=useCallback(patch=>{const next=new URLSearchParams(searchRef.current);for(const[k,v]of Object.entries(patch)){if(v==null)next.delete(k);else next.set(k,String(v))}searchRef.current=next;setSearch(next)},[setSearch])
  useEffect(()=>{const raw=search.get('at'),value=raw==null?null:Number(raw);setCursor(Number.isFinite(value)?value:null);setReplaying(raw!=null&&Number.isFinite(value))},[search.get('at'),range]) // eslint-disable-line
  const cryptoId=/^market:coinmarketcap:(\d+)$/.exec(subject)?.[1]||NATIVE_CMC[subject]
  const [detail,setDetail]=useState(null),[detailError,setDetailError]=useState(null)
  useEffect(()=>{if(!org?.id||!cryptoId)return;let alive=true;loadMarketDetail(supabase,org.id,null,{sourceProvider:'coinmarketcap',providerId:cryptoId}).then(r=>{if(alive)setDetail(r)}).catch(e=>{if(alive)setDetailError(e.message)});return()=>{alive=false}},[supabase,org?.id,cryptoId])
  const fallbackKey=canonicalPortfolioKey(DEFAULT_NATIVE[cryptoId]||subject)
  const network=useMarketPortfolioIdentity({identityChoices:detail?.identityChoices,defaultKey:detail?.canonicalAssetKey||fallbackKey,marketKey:cryptoId?`market:coinmarketcap:${cryptoId}`:subject,explicitKey:search.get('network')})
  const canonical=network.canonicalAssetKey||fallbackKey||subject
  const benchmark=search.get('benchmark')==='20'?'20':'100'
  const query=useInvestigation({subject,network:network.canonicalAssetKey||undefined,lens,from,to,category,...(lens==='cohort'&&search.get('cohort')?{cohortId:search.get('cohort')}:{}),...(lens==='benchmark'?{benchmark}:{})}),data=query.data
  const effectiveTo=Math.max(to,Date.parse(data?.serverTime)||to),at=cursor==null?effectiveTo:Math.min(effectiveTo,Math.max(from,cursor))
  const position=useAssetPortfolioContext({canonicalAssetKey:subject.startsWith('rwa:')?null:network.canonicalAssetKey||fallbackKey,portfolioId:search.get('portfolio'),from,to})
  const history=useAssetThesisHistory({canonicalKey:canonical,from,to})
  const [prices,setPrices]=useState({loading:true,candles:[],error:null})
  useEffect(()=>{if(!org?.id)return;let alive=true;setPrices({loading:true,candles:[],error:null});
    if(subject.startsWith('rwa:')){setPrices({loading:false,candles:[],error:null});return}
    loadThesisChart(supabase,org.id,{subject_canonical_key:subject},range,to).then(r=>{if(alive)setPrices({loading:false,candles:Array.isArray(r)?r:r?.candles||[],coverage:r,error:null})}).catch(e=>{if(alive)setPrices({loading:false,candles:[],error:e.message})});return()=>{alive=false}
  },[supabase,org?.id,subject,range,to])
  const [theses,setTheses]=useState([]),[thesis,setThesis]=useState(null),[thesisError,setThesisError]=useState(null)
  const thesisId=search.get('thesis')||''
  useEffect(()=>{if(!user?.id||!org?.id)return;let alive=true;setTheses([])
    supabase.from('intel_theses').select('id,title,subject_canonical_key').eq('org_id',org.id).eq('user_id',user.id).in('subject_canonical_key',[...new Set([subject,canonical,...assetEntityAliases(canonical)])]).order('created_at',{ascending:false}).limit(50).then(({data,error})=>{if(alive){if(error)setThesisError(error.message);else setTheses(data||[])}})
    return()=>{alive=false}
  },[supabase,user?.id,org?.id,subject,canonical])
  useEffect(()=>{setThesis(null);setThesisError(null);if(!thesisId||!org?.id)return;let alive=true;getThesis(supabase,org.id,thesisId).then(r=>{if(!alive)return;if(!matchesResearchAsset(r?.subject_canonical_key,subject,canonical,cryptoId?`market:coinmarketcap:${cryptoId}`:null)){setThesisError('This thesis belongs to a different asset. Select a thesis for this chart.');return}setThesis(r)}).catch(e=>{if(alive)setThesisError(e.message)});return()=>{alive=false}},[supabase,org?.id,thesisId,subject,canonical,cryptoId])
  const [historyPages,setHistoryPages]=useState({scope:null,observations:[],nextCursor:null})
  const [liveObservations,setLiveObservations]=useState([])
  const extraHistory=historyPages.scope===query.scope?historyPages.observations:[]
  const nextHistoryCursor=historyPages.scope===query.scope?historyPages.nextCursor:data?.history?.nextCursor
  const observations=useMemo(()=>projectDexEvidence([...new Map([...(data?.current||[]),...(data?.history?.observations||[]),...extraHistory,...liveObservations].map(o=>[o.id,o])).values()],at),[data,historyPages,query.scope,liveObservations,at]) // eslint-disable-line
  const events=useMemo(()=>[...mergeLinkedAssetMarkers(position.markers,history.markers),...dexLiquidityMarkers(observations,canonical,at)],[history.markers,position.markers,observations,canonical,at])
  const normalizedPrices=useMemo(()=>normalizeCandles(prices.candles),[prices.candles])
  const marketSubject=data?.identity?.subject||subject
  const [selectedEvidence,setSelectedEvidence]=useState(null),pane=useRef(null)
  const selectEvidence=(observation,reason)=>setSelectedEvidence({observation,reason})
  useEffect(()=>{if(!selectedEvidence)return;const previous=document.activeElement;pane.current?.showModal();return()=>previous?.focus?.()},[selectedEvidence])
  const [issuer,setIssuer]=useState(null),issuerQuery=useMarketResearch('issuer',{issuer_id:issuer,limit:20},!!issuer)
  const title=detail?.displayName||detail?.name||data?.connected?.name||data?.snapshots?.[0]?.data?.rows?.[0]?.name||nativeAssetChain(subject)?.label||({'1':'Bitcoin','1027':'Ethereum','5426':'Solana'}[cryptoId])||subject
  const threadNative = nativeAssetChain(subject)?.id || (cryptoId ? marketNativeChain('coinmarketcap', cryptoId) : null)
  const threadSubject = threadNative ? `native:${threadNative}` : subject
  const thread=useResearchThread(threadSubject), watchlist=useWatchlistSelection(search.get('watchlist'))
  const [localQuestion,setLocalQuestion]=useState(''),[localDecision,setLocalDecision]=useState(''),[receipt,setReceipt]=useState(null),[busy,setBusy]=useState(false),[actionError,setActionError]=useState(null),[notice,setNotice]=useState(null)
  const question=thread.record?.question??localQuestion, decision=thread.record?.decision??localDecision
  const threadContext={...(thread.record?.context?.comparison?{comparison:thread.record.context.comparison}:{}),subject,canonical,lens,range,at:search.has('at')?Number(search.get('at')):null,portfolio:position.portfolioId||null,thesis:thesisId||null,network:network.canonicalAssetKey||null,watchlist:watchlist.selected?.id||null}
  const setQuestion=value=>thread.store?thread.store.edit(threadSubject,{question:value,title,context:threadContext}):setLocalQuestion(value)
  const setDecision=value=>thread.store?thread.store.edit(threadSubject,{decision:value,title,context:threadContext}):setLocalDecision(value)
  const [threadRestored,setThreadRestored]=useState(false)
  useEffect(()=>{
    if(!thread.record?.loaded||threadRestored)return
    const context=thread.record.thread?.context
    if(context){const patch={};for(const key of ['lens','range','at','portfolio','thesis','network','watchlist'])if(!search.has(key)&&context[key]!=null)patch[key]=context[key];if(Object.keys(patch).length)update(patch)}
    setThreadRestored(true)
  },[thread.record?.loaded,threadRestored]) // eslint-disable-line
  const contextSignature=JSON.stringify(threadContext)
  useEffect(()=>{
    if(threadRestored&&thread.record?.thread&&!thread.record.loading&&(JSON.stringify(thread.record.context)!==contextSignature||thread.record.title!==title))thread.store.edit(threadSubject,{context:JSON.parse(contextSignature),title})
  },[threadRestored,contextSignature,thread.record?.loaded,title]) // eslint-disable-line
  const flushThread=async()=>{if(!thread.store)return null;thread.store.edit(threadSubject,{context:threadContext,title});return thread.store.flush(threadSubject)}
  const recordThread=async(action,receiptReference=null)=>{await flushThread();return thread.store?.append(threadSubject,action,receiptReference)}

  const receiptOperation=useRef(null)
  const [scenarioDraft,setScenarioDraft]=useState(null),[includeScenario,setIncludeScenario]=useState(false),[preparedEvidence,setPreparedEvidence]=useState(null)
  const [preparedBenchmark,setPreparedBenchmark]=useState(null)
  const [preparedSources,setPreparedSources]=useState(null)
  useEffect(()=>{if(lens!=='receipt')setPreparedSources(null)},[lens])
  useEffect(()=>setPreparedSources(null),[range])
  useEffect(()=>{if(lens!=='receipt')setPreparedBenchmark(null)},[lens])
  useEffect(()=>setPreparedBenchmark(null),[range])
  const selectedScenario=scenarioDraft?.thesisId===thesisId?scenarioDraft:null
  const [cohort,setCohort]=useState(null),[cohortQuotes,setCohortQuotes]=useState(null),[cohortReason,setCohortReason]=useState(null)
  const call=body=>invokeInvestigation(supabase,{orgId:org.id,subject,lens,...body})
  const act=async fn=>{setBusy(true);setActionError(null);try{await fn()}catch(e){setActionError(e.message)}finally{setBusy(false)}}
  const captureCohort=()=>act(async()=>{
    const r=await call({operation:'cohort',category});setCohort(r.cohort);setCohortQuotes(r.quotes);setCohortReason(r.reason)
    if(r.cohort){
      // An explicit capture establishes knowledge now, even while replaying an earlier time.
      setTo(Math.max(Date.now(),Date.parse(r.cohort.created_at)||0,...(r.cohort.members||[]).map(m=>Date.parse(m.joinedAt)||0)))
      replayTo(null);update({cohort:r.cohort.id,at:null})
    }
  })
  useEffect(()=>{const id=search.get('cohort');setCohort(null);setCohortQuotes(null);setCohortReason(null);if(!id||!['sector','cohort'].includes(lens))return;let alive=true;
    call({operation:'cohort',cohortId:id,...(replaying?{at}:{})}).then(r=>{if(alive){setCohort(r.cohort);setCohortQuotes(r.quotes);setCohortReason(r.reason)}}).catch(e=>{if(alive)setCohortReason(e.message)});return()=>{alive=false}
  },[search.get('cohort'),lens,org?.id,subject,query.scope]) // eslint-disable-line
  const saveReceipt=()=>act(async()=>{
    const prepared=includeScenario&&selectedScenario&&preparedEvidence?.thesisId===selectedScenario.thesisId?preparedEvidence:null
    const benchmarkInput=!prepared&&preparedBenchmark?preparedBenchmark:null
    const sourceInput=!prepared&&!benchmarkInput?preparedSources:null
    const payload={question,decision,at:prepared?.at??benchmarkInput?.at??sourceInput?.at??at,lens:includeScenario&&selectedScenario?'stress':benchmarkInput?'benchmark':sourceInput?.lens??lens,observationIds:prepared?.observationIds??benchmarkInput?.observationIds??sourceInput?.observationIds??evidenceAt(observations,at).map(o=>o.id).slice(0,500).sort(),...(benchmarkInput?{benchmark:benchmarkInput.benchmark}:{}),...(includeScenario&&selectedScenario?{scenario:selectedScenario}:{})}
    const signature=JSON.stringify(payload);if(receiptOperation.current?.signature!==signature)receiptOperation.current={signature,id:crypto.randomUUID()}
    const r=await call({operation:'receipt',operationId:receiptOperation.current.id,...payload})
    setReceipt(r.receipt);await recordThread('receipt',{id:r.id,fingerprint:r.receipt?.fingerprint});setNotice('Receipt saved privately in Saved Research and linked to this thread.');receiptOperation.current=null
  })
  const importReceipt=async event=>{const file=event.target.files?.[0];if(!file)return;await act(async()=>{if(file.size>250000)throw new Error('Receipt exceeds 250 KB.');const verified=await verifyReceipt(JSON.parse(await file.text()));setReceipt(verified.receipt);setNotice(`Imported receipt: ${verified.verifiedObservations} observations verified; ${verified.unavailableObservations} references without embedded data. Authorship is not authenticated.`)});event.target.value=''}
  const exportReceipt=()=>{if(!receipt)return;const href=URL.createObjectURL(new Blob([JSON.stringify(receipt,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=href;a.download='investor-intel-research-receipt.json';a.click();setTimeout(()=>URL.revokeObjectURL(href),1000)}
  const review=async payload=>{setBusy(true);setActionError(null);try{await createReview(supabase,org.id,user.id,thesis.id,payload);setTo(Date.now());setNotice('Review saved. The chart is refreshing your activity.');setThesis(await getThesis(supabase,org.id,thesis.id));return true}catch(e){setActionError(e.message);return false}finally{setBusy(false)}}
  const onAsset=asset=>update({asset,at:null,thesis:null,network:null})
  const activeLens=LENSES.find(([id])=>id===lens)
  const loaded=!!data
  return <div className="intel-investigation-workspace">
    <header className="intel-investigation-heading"><div><p className="eyebrow">{t('investigation.workspace',{defaultValue:'Connected research'})}</p><h1 className="page-title">{title}</h1><p className="page-sub">What changed, and what does it change about your thesis?</p></div><Link className="intel-text-link" to={subject.startsWith('rwa:')?'/intel/rwa':`/intel/asset/${encodeURIComponent(canonical)}`}>Asset workspace</Link></header>
    <ResearchThreadPanel subject={threadSubject} title={title} thread={thread} onQuestion={setQuestion} onDecision={setDecision} onRecord={recordThread} onFlush={flushThread}/>
    <div className="intel-investigation-controls"><label>Research lens<select className="select" value={lens} onChange={e=>{update({lens:e.target.value,cohort:null});setSelectedEvidence(null)}}>{['Decisions','Markets','Real-world assets','Evidence'].map(group=><optgroup key={group} label={group}>{LENSES.filter(r=>r[2]===group).map(([id,label])=><option key={id} value={id}>{label}</option>)}</optgroup>)}</select></label>
      <label>Period<select className="select" value={range} onChange={e=>update({range:e.target.value,at:null})}>{Object.keys(PERIODS).map(r=><option key={r}>{r}</option>)}</select></label>
      <label>Your thesis<select className="select" value={thesisId} onChange={e=>update({thesis:e.target.value||null})}><option value="">Select a thesis</option>{theses.map(r=><option key={r.id} value={r.id}>{r.title}</option>)}</select></label>
      {network.choices.length>1&&<label>Network<select className="select" value={network.canonicalAssetKey||''} onChange={e=>{network.selectNetwork(e.target.value);update({network:e.target.value})}}>{network.choices.map(c=><option key={c.canonicalAssetKey} value={c.canonicalAssetKey}>{c.label}</option>)}</select></label>}
      <button className="btn" onClick={()=>{setTo(Date.now());query.refresh()}} disabled={query.loading}>Refresh evidence</button>
    </div>
    {subject.startsWith('rwa:')?<><p className="intel-analysis-caption">This is an underlying asset. Select a token and its network to inspect your recorded position and asset chart.</p><RwaSelectedPosition tokens={data?.snapshots?.filter(s=>s.capability==='rwaQuotes').flatMap(s=>s.data.rows.filter(r=>`rwa:coinmarketcap:${r.rwa_id}`===subject).flatMap(r=>r.tokens||[]))||[]} selectedToken={search.get('token')} onTokenChange={token=>update({token})} portfolioId={search.get('portfolio')}/></>:<AssetPortfolioPosition context={position}/>}
    {detailError&&<p role="status">Asset identity detail: {detailError}</p>}
    <TokenChart priceCoverage={prices.coverage} height={260} candles={prices.candles} loading={prices.loading} markers={[...events,...cohortCaptureMarkers(cohort,canonical,at)]} showDensityToggles assetKey={canonical} persistence={{supabase,userId:user?.id,orgId:org?.id,asset:canonical}} defaultRange={range} timeWindow={{from,to:effectiveTo}} cursorTime={at} onCursorChange={setCursor} replayCursor={replaying?at:undefined} onReplayChange={value=>{replayTo(value);if(value==null)update({at:null})}} historyLoading={history.loading||position.loading} historyError={history.error||position.error?.message} historyHasMore={!!(history.nextCursor||position.nextCursor)} onLoadMoreHistory={()=>{if(history.nextCursor)history.loadMore();if(position.nextCursor)position.loadMore()}}/>
    <BookCalendar asset={canonical} knownAt={search.has('at')?Number(search.get('at')):null} chartLane/>
    {prices.error&&<p role="status">{prices.error}</p>}
    <div className="intel-replay-cursor"><label htmlFor="investigation-cursor">Evidence known by <time>{time(at)}</time></label><input id="investigation-cursor" type="range" min={from} max={effectiveTo} step="1000" value={at} onChange={e=>replayTo(Number(e.target.value))} onPointerUp={()=>update({at})} onKeyUp={()=>update({at})}/><button className="btn" onClick={()=>{setTo(Date.now());replayTo(null);update({at:null})}}>Now</button></div>
    <section className="intel-investigation-analysis" aria-labelledby="investigation-lens-title"><div className="intel-investigation-analysis-heading"><h2 id="investigation-lens-title">{activeLens[1]}</h2><button className="intel-text-link" onClick={()=>update({lens:'coverage'})}>Inspect coverage</button></div>
      {query.loading&&<p role="status">Loading shared evidence…</p>}{query.error&&<p role="alert">{query.error}</p>}{data?.storageError&&<p role="status">{data.storageError}</p>}
      {data?.snapshots?.filter(s=>s.state!=='fresh').map(s=><p key={s.capability} role="status">{s.capability}: {s.state} · {s.reason||'Source observation is outside its freshness window.'}</p>)}
      {lens==='replay'&&<ReplayLens events={events} prices={normalizedPrices} observations={observations} at={at} onTime={replayTo}/>}
      {lens==='benchmark'&&<><label>Benchmark <select className="select" value={benchmark} onChange={e=>{setPreparedBenchmark(null);update({benchmark:e.target.value})}}><option value="100">CMC 100</option><option value="20">CMC 20</option></select></label><p className="intel-analysis-caption">At most ten reported daily observations within the selected period. Index points are not asset prices.</p><BenchmarkLens observations={observations} subject={marketSubject} benchmark={benchmark} from={from} at={at} onSelect={selectEvidence} onPrepareReceipt={sources=>{setIncludeScenario(false);setPreparedBenchmark({benchmark,at,observationIds:sources.map(o=>o.id).sort()});if(!question.trim())setQuestion(`How did this asset compare with CMC ${benchmark} at matching reported times?`);update({lens:'receipt'})}}/></>}
      {lens==='receipt'&&preparedBenchmark&&<p>Prepared CMC {preparedBenchmark.benchmark} comparison · {preparedBenchmark.observationIds.length} original source references, known by {time(preparedBenchmark.at)}. <button className="intel-text-link" onClick={()=>setPreparedBenchmark(null)}>Discard prepared comparison</button></p>}
      {lens==='receipt'&&preparedSources&&<p>Prepared {preparedSources.label} · {preparedSources.observationIds.length} original source references, known by {time(preparedSources.at)}. <button className="intel-text-link" onClick={()=>setPreparedSources(null)}>Discard prepared issuer evidence</button></p>}
      {lens==='coverage'&&<CoverageLens observations={observations} subject={marketSubject} at={at} onSelect={selectEvidence}/>}
      {lens==='fragility'&&<FragilityLens from={from} onTime={replayTo} observations={observations} subject={marketSubject} at={at} onSelect={selectEvidence}/>}
      {lens==='attention'&&<><AdoptionAttentionEvidence comparison={data?.attentionComparison}/><AttentionLens observations={observations} at={at} onAsset={onAsset}/></>}
      {lens==='delta'&&<DeltaLens observations={observations} at={at} seenAt={data?.seenAt} baselineError={data?.storageErrors?.visit} onTime={replayTo} onSeen={()=>act(async()=>{await call({operation:'seen'});query.refresh();setNotice('Your evidence baseline is saved.')})}/>}
      {['stress','counterargument'].includes(lens)&&<StressLens key={`${lens}:${thesisId}`} thesis={thesis} observations={observations} subject={marketSubject} at={at} counterargument={lens==='counterargument'} initialScenario={selectedScenario} onScenarioChange={setScenarioDraft} onPrepareReceipt={thesis?.user_id===user?.id&&selectedScenario?()=>{setPreparedEvidence({thesisId,at,observationIds:evidenceAt(observations,at).map(o=>o.id).slice(0,500).sort()});setIncludeScenario(true);if(!question.trim())setQuestion('How do my stated conditions respond to this scenario?');update({lens:'receipt'})}:undefined}/>}
      {['sector','cohort'].includes(lens)&&<>{lens==='sector'&&!category&&<InvestigationTable rows={data?.snapshots?.[0]?.data?.rows||[]} columns={[[ 'Category',r=><button className="intel-text-link" onClick={()=>update({category:r.id,cohort:null})}>{r.name}</button>],['Members',r=>value(r.num_tokens)],['Reported market cap',r=>value(r.market_cap)]]}/>}<CohortLens cohort={cohort} quotes={cohortQuotes} at={at} onCapture={captureCohort} onAsset={onAsset} busy={busy||!loaded||lens==='sector'&&!category} reason={cohortReason}/></>}
      {lens==='ownership'&&<>{data?.snapshots?.[0]?.data?.rows?.map(r=><RwaRelationships showPosition={!subject.startsWith('rwa:')} key={r.rwa_id||r.id} record={r} onIssuer={setIssuer}/>)}{!subject.startsWith('rwa:')&&<Link className="intel-text-link" to="/intel/rwa">Select a real-world underlying asset</Link>}</>}
      {lens==='sessions'&&(subject.startsWith('rwa:')?<RwaSessions subject={subject} records={data?.snapshots?.filter(s=>s.capability==='rwaQuotes').flatMap(s=>s.data.rows)||[]} observations={observations} at={at} selectedToken={search.get('token')} onTokenChange={token=>update({token})} onPrepareReceipt={(sources,token,calculation)=>{if(calculation){const draft=[decision,calculation].filter(Boolean).join("\n\n");if(draft.length>16000){setActionError("Your notes are too long to append the calculation. Save them first, then prepare another receipt.");return}setDecision(draft)}setIncludeScenario(false);setPreparedBenchmark(null);setPreparedSources({lens:'sessions',label:`${token.name} issuer evidence`,at,observationIds:sources.map(o=>o.id).sort()});if(!question.trim())setQuestion(`Which issuer terms and market hours affect ${token.name}?`);update({lens:'receipt',at})}}/>:<><label className="intel-inline-field">Explore an underlying market calendar<select className="select" value={search.get('market')||''} onChange={e=>update({market:e.target.value||null})}><option value="">Select exchange calendar</option><option value="XNYS">NYSE core equities</option><option value="XNAS">Nasdaq core equities</option></select></label><SessionsLens at={at} market={search.get('market')}/><Link className="intel-text-link" to="/intel/rwa">Select an RWA for issuer-specific evidence</Link></>)}
      {lens==='participation'&&<><AdoptionAttentionEvidence comparison={data?.attentionComparison}/><ParticipationLens snapshots={data?.participation||[]} subject={canonical} at={at}/><DexObservationTable observations={observations} subject={canonical} at={at} view="holders"/></>}
      {lens==='liquidity'&&<><LiquidityLens depthQuotes={detail?.depthQuotes||[]} holding={position.holding} observations={observations} subject={marketSubject} at={at}/><details><summary>Pool liquidity activity</summary><DexObservationTable observations={observations} subject={canonical} at={at} view="liquidity"/></details><details><summary>Public swap activity</summary><DexObservationTable observations={observations} subject={canonical} at={at} view="swaps"/></details></>}
      {lens==='live'&&<LiveFocus request={call} onObservation={o=>setLiveObservations(rows=>[...new Map([...rows,o].map(r=>[r.id,r])).values()].slice(-100))}/>}
      {lens==='receipt'&&<>{includeScenario&&selectedScenario&&preparedEvidence?.thesisId===thesisId&&<p className="intel-analysis-caption">Scenario evidence prepared at {time(preparedEvidence.at)}. Saving preserves these references; expired depth is reported as unavailable rather than replaced with a newer book.</p>}{selectedScenario&&<label className="intel-cohort-selection"><input type="checkbox" checked={includeScenario} onChange={e=>setIncludeScenario(e.target.checked)}/>Include the selected thesis’s stress inputs and numeric conditions</label>}<label className="intel-research-field">Research question<textarea className="textarea" rows={2} value={question} maxLength={8000} onChange={e=>setQuestion(e.target.value)}/></label><label className="intel-research-field">Your decision and notes<textarea className="textarea" rows={3} value={decision} maxLength={16000} onChange={e=>setDecision(e.target.value)}/></label><div className="intel-investigation-controls"><button className="btn btn--primary" disabled={busy||!question.trim()||!loaded} onClick={saveReceipt}>Save private receipt</button><label className="intel-text-link">Import receipt<input className="block text-xs mt-1" type="file" accept="application/json,.json" onChange={importReceipt}/></label>{receipt&&<button className="btn" onClick={exportReceipt}>Export permitted receipt</button>}</div>{receipt&&<ReceiptView receipt={receipt}/>}</>}
    </section>
    {['stress','counterargument','fragility','participation','liquidity'].includes(lens)&&thesis?.user_id===user?.id&&<ReviewComposer thesis={thesis} onSubmit={review} busy={busy}/>}
    {thesisError&&<p role="alert">{thesisError}</p>}{actionError&&<p role="alert">{actionError}</p>}{notice&&<p role="status">{notice}</p>}
    {nextHistoryCursor&&<button className="btn" disabled={busy||observations.length>=5000} onClick={()=>act(async()=>{const page=await call({operation:'history',from,to,cursor:nextHistoryCursor,subjects:data.history.subjects,limit:500});setHistoryPages(previous=>({scope:query.scope,observations:[...(previous.scope===query.scope?previous.observations:[]),...page.observations],nextCursor:page.nextCursor}))})}>Load more evidence history</button>}
    {observations.length>=5000&&<p className="intel-analysis-caption">Showing 5,000 observations. Narrow the period to inspect more detail.</p>}
    {selectedEvidence&&<dialog ref={pane} className="intel-investigation" aria-label="Observation evidence" onCancel={e=>{e.preventDefault();setSelectedEvidence(null)}}><div className="intel-investigation-analysis-heading"><h2>Observation evidence</h2><button className="btn" onClick={()=>setSelectedEvidence(null)}>Close</button></div>{selectedEvidence.reason&&<p>{selectedEvidence.reason}</p>}{selectedEvidence.observation&&<EvidenceRecord record={selectedEvidence.observation}/>}</dialog>}
    {issuer&&<section className="intel-investigation-analysis"><div className="intel-investigation-analysis-heading"><h2>Issuer evidence</h2><button className="btn" onClick={()=>setIssuer(null)}>Close issuer</button></div>{issuerQuery.loading?<p role="status">Loading issuer…</p>:issuerQuery.result?.data?.rows?.map((r,i)=><EvidenceRecord key={i} record={r}/>)}{issuerQuery.error&&<p role="alert">{issuerQuery.error.message}</p>}</section>}
  </div>
}
