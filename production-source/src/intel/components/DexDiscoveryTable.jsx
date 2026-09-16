import React from 'react'
import {Link} from 'react-router'
import {InvestigationTable,time,value} from './InvestigationTable'
import {CMC_DEX_NETWORKS} from '../../../supabase/functions/_shared/market-assets/cmc-dex.ts'
import SourceResearchNotes from './SourceResearchNotes'
import TokenAvatar from './TokenAvatar'
import DexCohortCapture from './DexCohortCapture'
const names={dexTrending:'Trending contracts',dexNew:'New contracts',dexMeme:'Meme discovery',dexGainers:'Gainers and losers'}
const finite=v=>v!=null&&v!==''&&typeof v!=='boolean'&&Number.isFinite(Number(v))?Number(v):null
export default function DexDiscoveryTable({query,capability,network,onNetwork,cursor,onNext,onFirst,onDraftChange}){
 const result=query.result,rows=result?.data?.rows||[],next=result?.sourceReference?.parameters?.nextPageIndex
 // Actual next-page cursor is supplied separately from the response projection.
 const nextCursor=result?.data?.nextCursor
 return <section aria-label="CMC DEX discovery">
  <label className="intel-inline-field">Network<select className="select max-w-xs" value={network} onChange={e=>onNetwork(e.target.value)}>{CMC_DEX_NETWORKS.map(n=><option key={n.platformId} value={String(n.platformId)}>{n.label}</option>)}</select></label>
  <p className="intel-analysis-caption">Exact contracts in the current CMC discovery response. Rank and source classification are not endorsements or narrative scores. Price has its own timestamp; other statistics do not inherit it.</p>
  <InvestigationTable caption={names[capability]} rows={rows} columns={[
   ['Asset',r=><div><Link className="intel-text-link inline-flex items-center gap-2" to={`/intel/asset/${encodeURIComponent(r.canonicalKey)}`}><TokenAvatar src={r.lg} symbol={r.symbol} name={r.name} size="sm"/>{r.name} · {r.symbol}</Link><details><summary>Contract identity</summary><p className="break-all">{r.canonicalKey}</p><Link className="intel-text-link" to={`/intel/investigate?asset=${encodeURIComponent(r.canonicalKey)}&lens=participation`}>Investigate this contract</Link></details></div>],
   ['Price (USD)',r=>value(finite(r.p))],['Price observed',r=>time(r.quote?.last_updated)],['Reported liquidity (USD)',r=>value(finite(r.liqUsd))],['Reported 24h volume (USD)',r=>value(finite(r.v24h))],
   ...(capability==='dexMeme'?[['Source stage',r=>r.discoveryStage]]:[])
  ]}/>
  <div className="intel-investigation-pagination"><button className="btn" disabled={!cursor||query.loading} onClick={onFirst}>First discovery page</button><button className="btn" disabled={query.loading||!nextCursor||nextCursor===cursor||nextCursor===next} onClick={()=>onNext(nextCursor)}>Next discovery page</button></div>
  {/* A cohort may be captured from a snapshot inside its TTL as well as from a live read: both are the exact response the reference pins. */}
  <DexCohortCapture reference={result?.sourceReference} ready={!query.loading&&!query.error&&(result?.state==='fresh'||result?.state==='cached')&&rows.length>0}/>
  <SourceResearchNotes reference={result?.sourceReference} title={`${names[capability]} · ${CMC_DEX_NETWORKS.find(n=>String(n.platformId)===network)?.label||network}`} onDraftChange={onDraftChange}/>
 </section>
}
