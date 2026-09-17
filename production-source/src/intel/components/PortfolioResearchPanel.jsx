import React,{lazy,Suspense,useId,useRef,useState} from 'react'
import {Link} from 'react-router'

const PortfolioResearchEvidence=lazy(()=>import('./PortfolioResearchEvidence'))
const PortfolioReadingHistory=lazy(()=>import('./PortfolioReadingHistory'))

const labels=['Overview','Holdings','Activity','Risk','News','Evidence']
const money=value=>value==null?'Unavailable':Number(value).toLocaleString(undefined,{style:'currency',currency:'USD',maximumFractionDigits:2})
const amount=value=>value==null?'—':Number(value).toLocaleString(undefined,{maximumSignificantDigits:12})
const readable=value=>String(value||'Unavailable').replaceAll('_',' ')
const date=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString(undefined,{timeZoneName:'short'}):'Time not recorded'

function PageControls({page,setPage,count,label}) {
 const last=Math.max(0,Math.ceil(count/5)-1)
 return count>5&&<div className="intel-research-pagination" aria-label={`${label} pagination`}>
  <span>{page*5+1}–{Math.min(count,(page+1)*5)} of {count}</span>
  <button type="button" className="btn btn--quiet btn--sm" disabled={!page} onClick={()=>setPage(page-1)}>Previous {label.toLowerCase()}</button>
  <button type="button" className="btn btn--quiet btn--sm" disabled={page>=last} onClick={()=>setPage(page+1)}>Next {label.toLowerCase()}</button>
 </div>
}

export default function PortfolioResearchPanel({intel,loading,reading=false,error=null,onRetry,onGenerate,portfolioId,history,t=(_key,{defaultValue})=>defaultValue}) {
 const id=useId(),[tab,setTab]=useState('Overview'),[pages,setPages]=useState({Holdings:0,Activity:0,Risk:0})
 const [historyOpen,setHistoryOpen]=useState(false),historyTrigger=useRef(null)
 const artifact=intel?.artifact,s=artifact?.structured,evidence=artifact?.evidence
 const rows=tab==='Holdings'?evidence?.holdings||[]:tab==='Activity'?evidence?.activity||[]:artifact?.risk?.factors||[]
 const page=Math.min(pages[tab]||0,Math.max(0,Math.ceil(rows.length/5)-1)),visible=rows.slice(page*5,page*5+5)
 const setPage=value=>setPages(current=>({...current,[tab]:value}))
 const onKey=(event,index)=>{
  const next=event.key==='ArrowRight'?(index+1)%labels.length:event.key==='ArrowLeft'?(index+labels.length-1)%labels.length:event.key==='Home'?0:event.key==='End'?labels.length-1:null
  if(next==null)return;event.preventDefault();setTab(labels[next]);event.currentTarget.parentElement.children[next]?.focus()
 }
 return <section className="intel-portfolio-research" aria-label="Portfolio intelligence" aria-busy={loading||reading}>
  <header><h2>{t('portfolio.intel',{defaultValue:'Portfolio intelligence'})}</h2>
   {history&&<button ref={historyTrigger} type="button" className="intel-text-link" onClick={()=>setHistoryOpen(true)}>{t('portfolio.history_title',{defaultValue:'Portfolio readings'})}</button>}
   <button type="button" className="btn btn--primary btn--sm" disabled={loading||reading} onClick={onGenerate}>{loading?'Preparing…':s?t('portfolio.refresh',{defaultValue:'Refresh'}):t('portfolio.generate',{defaultValue:'Generate'})}</button>
  </header>
  {historyOpen&&history&&<Suspense fallback={<p role="status">{t('portfolio.history_loading',{defaultValue:'Loading reading history…'})}</p>}><PortfolioReadingHistory {...history} portfolioId={portfolioId} selectedId={intel?.operationId} onClose={()=>{setHistoryOpen(false);historyTrigger.current?.focus()}} t={t}/></Suspense>}
  {loading&&<p role="status">Preparing portfolio research. Your positions and activity remain available.</p>}
  {reading&&<p role="status">{t('portfolio.reading_saved',{defaultValue:'Opening your last portfolio reading…'})}</p>}
  {error&&<p role="alert">{t('portfolio.saved_read_failed',{defaultValue:'Portfolio research could not be loaded. Your holdings and activity remain available.'})} {onRetry&&<button type="button" className="intel-text-link" onClick={()=>onRetry()}>{t('portfolio.retry_read',{defaultValue:'Retry reading'})}</button>}</p>}
  {!s&&!loading&&!reading&&!error&&<p>Connect your positions with recorded activity, market context and risk. Generate a private reading of this portfolio.</p>}
  {s&&<>
   <div className="intel-source-strip">
    {artifact.observedAt&&<span>Evidence checked <time dateTime={artifact.observedAt}>{date(artifact.observedAt)}</time></span>}
    {intel.cache==='hit'&&<span>Analysis reused · evidence unchanged</span>}
    {intel.cache==='saved'&&<span>{t('portfolio.previous_reading',{defaultValue:'Previous reading (original evidence retained)'})}</span>}
    {intel.generatedAt&&<span>{t('portfolio.prepared_at',{defaultValue:'Prepared'})} <time dateTime={intel.generatedAt}>{date(intel.generatedAt)}</time></span>}
    {intel.pending&&<span role="status">Analysis in progress · recorded facts shown</span>}
    <span>Private · only you</span>
   </div>
   <div role="tablist" aria-label="Portfolio research views" className="intel-portfolio-research-tabs">{labels.map((label,index)=><button key={label} role="tab" type="button" id={`${id}-${label}`} aria-controls={`${id}-panel`} aria-selected={label===tab} tabIndex={label===tab?0:-1} onKeyDown={event=>onKey(event,index)} onClick={()=>setTab(label)}>{label}</button>)}</div>
   <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${tab}`} tabIndex={0} className="intel-portfolio-research-body">
    {tab==='Overview'&&<><p>{s.summary}</p>{s.what_changed&&<p className="text-[var(--fg-3)]">{s.what_changed}</p>}{evidence?.coverage?.incompleteCostBasis>0&&<p>Cost basis is incomplete or unavailable for {evidence.coverage.incompleteCostBasis} open positions.</p>}</>}
    {tab==='Holdings'&&<>
     {s.contributors&&<p>{s.contributors}</p>}{s.signal_exposure&&<p className="text-[var(--fg-3)]">{s.signal_exposure}</p>}
     {!!rows.length&&<div className="intel-table-scroll"><table aria-label="Research holdings"><thead><tr><th scope="col">Asset</th><th scope="col">Quantity</th><th scope="col">Value (USD)</th><th scope="col">Quote / basis</th></tr></thead><tbody>{visible.map(h=><tr key={h.canonicalAssetKey}><th scope="row">{h.canonicalAssetKey&&portfolioId?<Link to={`/intel/portfolio/${portfolioId}/asset/${encodeURIComponent(h.canonicalAssetKey)}`}>{h.symbol||h.name}</Link>:h.symbol||h.name}<small>{h.chain}</small></th><td>{amount(h.quantity)}</td><td>{money(h.value)}</td><td>{readable(h.priceStatus)} · {readable(h.costBasisStatus)} basis{h.observedAt&&<small><time dateTime={h.observedAt}>{date(h.observedAt)}</time></small>}<small>{h.priceSource||'Price source unavailable'}</small></td></tr>)}</tbody></table></div>}
     {!rows.length&&<p>No open holdings were included in this reading.</p>}
     {!!evidence?.coverage?.holdingsOmitted&&<p>The reading describes {evidence.coverage.holdingsIncluded} of {evidence.coverage.totalOpenHoldings} open positions. Totals include the full recorded portfolio.</p>}
    </>}
    {tab==='Activity'&&<>
     <p>{s.what_changed||'Recent recorded activity supporting this reading.'}</p>
     {!!rows.length?<div className="intel-table-scroll"><table aria-label="Research activity"><thead><tr><th scope="col">Recorded action</th><th scope="col">Effective time</th><th scope="col">Amount / state</th><th scope="col">Notes and source</th></tr></thead><tbody>{visible.map((a,i)=><tr key={`${a.kind}:${a.id||i}`}><th scope="row">{readable(a.type)}{a.groupId&&<small>Paired transaction · {a.direction} leg</small>}</th><td><time dateTime={a.timestamp||undefined}>{date(a.timestamp)}</time></td><td>{a.quantity!=null&&<span>{amount(a.quantity)} {a.symbol}</span>}<small>{readable(a.status)} · {readable(a.classification)}</small></td><td><details><summary>Read record</summary>{a.notes&&<p className="whitespace-pre-wrap">{a.notes}</p>}{a.notesTruncated&&<p>Long note excerpt · open the transaction for the full text.</p>}<p>{a.provider||'Source unavailable'} · {a.chain||'Network unavailable'}</p>{a.price!=null&&<p>Recorded price {amount(a.price)} {a.currency||'currency unavailable'}</p>}{a.fee!=null&&<p>Fee {amount(a.fee)} {a.feeCurrency||'currency unavailable'}</p>}{a.transactionRef&&<p className="break-all">{a.transactionRef}</p>}</details></td></tr>)}</tbody></table></div>:<p>No activity was recorded in this evidence read.</p>}
     {evidence?.coverage?.activityHasMore&&<p>Showing the latest recorded activity. Earlier entries remain in Transactions.</p>}
    </>}
    {tab==='Risk'&&<><p>{s.risks}</p>{!!rows.length&&<div className="intel-table-scroll"><table aria-label="Portfolio risk drivers"><thead><tr><th scope="col">Factor</th><th scope="col">Observed context</th></tr></thead><tbody>{visible.map(f=><tr key={f.factor}><th scope="row">{readable(f.factor)}</th><td>{f.detail}</td></tr>)}</tbody></table></div>}</>}
    {tab==='News'&&<p>{s.news_that_matters||'No current portfolio-specific news was included.'}</p>}
    {tab==='Evidence'&&<Suspense fallback={<p role="status">Opening portfolio evidence…</p>}><PortfolioResearchEvidence evidence={evidence} portfolioId={portfolioId}/></Suspense>}
    {['Holdings','Activity','Risk'].includes(tab)&&<PageControls page={page} setPage={setPage} count={rows.length} label={tab}/>}
   </div>
  </>}
 </section>
}
