import React,{useState,useEffect} from 'react'
import {Link} from 'react-router'
import {useProfile} from '../../lib/profile-context'
import {useSupabase} from '../../lib/useSupabase'
import {useMarketResearch} from '../lib/useMarketResearch'
import {InvestigationTable,time,value} from './InvestigationTable'
import {evidenceAt} from '../../../supabase/functions/_shared/intel/investigation-evidence.ts'
import {projectDexEvidence} from '../lib/dex-evidence-projection'
import {cmcDexIdentity} from '../../../supabase/functions/_shared/market-assets/cmc-dex.ts'
import SourceResearchNotes from './SourceResearchNotes'
import {SecuritySourceHistory} from './MarketSourceHistory'
import {SharedResearchRefresh} from './ResearchEvidence'
const financial=v=>v!=null&&v!==''&&typeof v!=='boolean'&&Number.isFinite(Number(v))?value(Number(v)):'—'

export function DexObservationTable({observations=[],subject,at=Date.now(),view}){
 const metric=view==='holders'?'holder_count':view==='swaps'?'swap_event_usd':'liquidity_event_usd'
 const rows=evidenceAt(projectDexEvidence(observations,at),at).filter(o=>o.subject===subject&&o.provider==='coinmarketcap'&&o.metric===metric).sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt))
 return <><p className="intel-analysis-caption">{view==='holders'?'Dated holder accounts for this exact contract. Accounts are not people; no ownership or concentration is inferred.':view==='swaps'?'Public swaps for this exact contract. The venue classification and both token legs stay with each event. These are not your portfolio transactions.':'Reported pool liquidity activity. These records are separate from your portfolio transactions and executable order-book depth.'}</p>
 {!rows.length?<p role="status">No dated CMC {view==='holders'?'holder':view==='swaps'?'swap':'liquidity'} observations are available at this research time.</p>:<InvestigationTable caption={view==='holders'?'CMC holder history':view==='swaps'?'CMC public swaps':'CMC liquidity activity'} rows={rows} columns={[
  ['Observed',o=>time(o.observedAt)],[view==='holders'?'Holder accounts':'Activity',o=>view==='holders'?value(o.value):o.metadata?.eventType||'Unclassified'],
  ...(view==='holders'?[]:[['Value (USD)',o=>value(o.value)],['Venue',o=>o.metadata?.venue||'Unreported'],['Transaction',o=><details><summary className="break-all">{o.metadata?.transaction}</summary><p>Log {o.metadata?.logIndex}. Base: {value(o.metadata?.baseQuantity)} ({o.metadata?.baseAddress}). Quote: {value(o.metadata?.quoteQuantity)} ({o.metadata?.quoteAddress}). {o.metadata?.excluded?'Provider excludes this record.':''}</p></details>]]),
  ['First recorded',o=>time(o.recordedAt)],
 ]}/>}</>
}
export default function ContractResearchWorkspace({canonicalKey,onEvidence}){
 const {org}=useProfile(),{user}=useSupabase()
 const identity=cmcDexIdentity(canonicalKey)
 if(!identity)return null
 return <Workspace key={`${user?.id}:${org?.id}:${identity.subject}`} canonicalKey={identity.subject} identity={identity} onEvidence={onEvidence}/>
}
function Workspace({canonicalKey,identity,onEvidence}){
 const [open,setOpen]=useState(false),[view,setView]=useState('overview'),[intent,setIntent]=useState({refresh:false,requestRevision:0}),[cursors,setCursors]=useState([])
 const [drafts,setDrafts]=useState({})
 const query=useMarketResearch('dexContext',{canonicalKey,view,...intent,...(cursors.length?{cursor:cursors.at(-1)}:{})},open,!Object.values(drafts).some(Boolean)),result=query.result
 useEffect(()=>{if(result?.canonicalKey===canonicalKey)onEvidence?.(result)},[result,canonicalKey,onEvidence])
 const changeView=v=>{setView(v);setCursors([]);setIntent(i=>({refresh:false,requestRevision:i.requestRevision+1}))}
 const refresh=()=>setIntent(i=>({refresh:true,requestRevision:i.requestRevision+1}))
 return <details className="intel-open-section" onToggle={e=>setOpen(e.currentTarget.open)}><summary>On-chain participation & liquidity · CoinMarketCap</summary>
  <p className="intel-analysis-caption">{identity.label} contract <span className="break-all">{identity.address}</span>. Select the evidence you need; refresh reuses the shared cache.</p>
  <div className="intel-holdings-toolbar"><label>Evidence <select className="select" value={view} onChange={e=>changeView(e.target.value)}><option value="overview">Token and holders</option><option value="holders">Holder history</option><option value="pools">Current pools</option><option value="swaps">Public swaps</option><option value="liquidity">Liquidity activity</option><option value="security">Security observations</option></select></label><button className="btn" disabled={query.loading} onClick={refresh}>Refresh shared contract evidence</button></div>
  <SharedResearchRefresh query={query}/>
  {Object.values(drafts).some(Boolean)&&<p className="intel-analysis-caption">Automatic updates paused while your source notes are unsaved.</p>}
  {query.loading?<p role="status">Loading contract evidence…</p>:query.error?<p role="alert">Contract evidence could not be read. <button className="intel-text-link" onClick={()=>setIntent(i=>({refresh:false,requestRevision:i.requestRevision+1}))}>Retry retained read</button></p>:result&&<>
   {result.sources?.map(s=><section key={s.capability} className="py-3"><p className="intel-analysis-caption">{({dexToken:'Token market data',dexHolderCount:'Holder count',dexHolderHistory:'Holder history',dexSecurity:'Security observations',dexLiquidityEvents:'Liquidity activity',dexPools:'Current pools',dexSwaps:'Public swaps'})[s.capability]} · {s.state}{s.reason?` · ${s.reason.replaceAll('_',' ')}`:''}{s.provenance?.fetchedAt?` · Retrieved ${time(s.provenance.fetchedAt)}`:''}</p>
    {s.capability==='dexToken'&&s.rows?.map((r,i)=><React.Fragment key={i}><InvestigationTable rows={[r]} columns={[[ 'Token',r=>`${r.name} (${r.symbol})`],['Price (USD)',r=>financial(r.price)],['Price observed',r=>r.priceObservedAt?time(Number(r.priceObservedAt)<1e12?Number(r.priceObservedAt)*1000:Number(r.priceObservedAt)):'Unreported'],['Reported pool liquidity (USD)',r=>financial(r.liquidityUsd)]]}/><p className="intel-analysis-caption">The liquidity observation time is not reported. The price timestamp applies only to price.</p></React.Fragment>)}
    {s.capability==='dexHolderCount'&&s.rows?.map((r,i)=><p key={i}>Holder accounts: <strong>{financial(r.count)}</strong>. Observation time not reported by this endpoint.</p>)}
    {s.capability==='dexSecurity'&&s.rows?.map((r,i)=>r.exists===false?<p key={i}>Security coverage was not reported for this contract.</p>:<div key={i}><p>CMC source classification: {r.level??'Unreported'}. Observation time not reported.</p><InvestigationTable rows={r.items||[]} columns={[[ 'Source observation',r=>r.description||r.code],['Reported result',r=>r.hit===true?'Flagged':r.hit===false?'Not flagged':'Unknown'],['Source level',r=>r.level??'Unreported']]}/><p className="intel-analysis-caption">Not flagged does not establish that a contract is safe.</p></div>)}
   </section>)}
   {view==='pools'&&<><p className="intel-analysis-caption">Up to 12 reported pools. Liquidity and volume observation times are unreported; pool creation time does not date them. Reported liquidity is not executable depth.</p><InvestigationTable rows={result.sources?.[0]?.rows||[]} caption="Current reported pools" columns={[
    ['Pool',r=><details><summary>{r.venue||'Unreported venue'} · {r.token0?.symbol} / {r.token1?.symbol}</summary><p className="break-all">Pool: {r.address}<br/>Token 0: {r.token0?.address}<br/>Token 1: {r.token1?.address}</p></details>],['Liquidity (USD)',r=>financial(r.liquidityUsd)],['Reported 24h volume (USD)',r=>financial(r.volume24h)]
   ]}/></>}
   {['holders','liquidity','swaps'].includes(view)&&<DexObservationTable observations={result.observations} subject={canonicalKey} view={view}/>}
   {view==='security'&&<SecuritySourceHistory history={result.securityHistory} saveable/>}
   {['liquidity','swaps'].includes(view)&&<div className="intel-investigation-pagination"><button className="btn" disabled={!cursors.length||query.loading} onClick={()=>{setCursors(c=>c.slice(0,-1));setIntent(i=>({...i,refresh:false}))}}>Previous activity</button><button className="btn" disabled={query.loading||!result.sources?.[0]?.nextCursor||cursors.includes(result.sources?.[0]?.nextCursor)} onClick={()=>{setCursors(c=>[...c,result.sources[0].nextCursor]);setIntent(i=>({...i,refresh:true}))}}>Next activity</button></div>}
   {result.sources?.map(s=><SourceResearchNotes key={s.capability} reference={s.sourceReference} title={`${identity.label} ${identity.address} · ${view}`} onDraftChange={pending=>setDrafts(previous=>previous[s.capability]===pending?previous:{...previous,[s.capability]:pending})}/>)}
   <Link className="intel-text-link" to={`/intel/investigate?asset=${encodeURIComponent(canonicalKey)}&lens=${['liquidity','swaps','pools'].includes(view)?'liquidity':'participation'}`}>Investigate and save dated evidence</Link>
  </>}
  <p className="intel-analysis-caption"><a href="https://coinmarketcap.com" target="_blank" rel="noreferrer">Data provided by CoinMarketCap.com</a> · Source clocks and coverage stay with each observation.</p>
 </details>
}
