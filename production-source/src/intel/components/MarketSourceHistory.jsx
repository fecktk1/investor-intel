import React,{useState} from 'react'
import {Link} from 'react-router'
import {InvestigationTable,time} from './InvestigationTable'
import SourceResearchNotes from './SourceResearchNotes'
import SourceHistoryPager from './SourceHistoryPager'
const result=r=>r==null?'Unreported':r===true?'Flagged':r===false?'Not flagged':String(r)
const changeValue=(row,side)=>row.field?(row[side]?.value==null?'Unreported':String(row[side].value)):result(row[side]?.hit)
export function SecuritySourceHistory({history,saveable=false}){
 if(!history)return null
 return saveable?<SourceHistoryPager history={history}>{page=><SecuritySourceView history={page} saveable/>}</SourceHistoryPager>:<SecuritySourceView history={history}/>
}
function SecuritySourceView({history,saveable=false}){
 const [selected,setSelected]=useState(null)
 if(!history)return null
 const comparison=history.comparison,version=history.versions?.find(v=>v.id===selected)||history.versions?.[0]
 return <details className="my-3"><summary>Security source history</summary>
  <p role={history.status==='error'?'alert':undefined}>{history.status} {history.reason}</p>
  <p>{comparison?.note||'CMC supplies no effective observation time. First recorded means first retained here, not when the contract changed.'}</p>
   {!!comparison?.changes?.length&&<InvestigationTable caption="Differences between the first two retained responses on this page" rows={comparison.changes} columns={[
   ['Source code',r=>r.code],['Change',r=>r.kind.replaceAll('_',' ')],['Previous result',r=>changeValue(r,'before')],['Latest result',r=>changeValue(r,'after')],['Level',r=>r.field?'—':`${result(r.before?.level)} → ${result(r.after?.level)}`],
  ]}/>}
  {!!comparison?.ambiguousCodes?.length&&<p>{comparison.ambiguousCodes.length} source codes have conflicting duplicate entries and cannot be compared.</p>}
  {comparison?.status==='compared'&&!comparison.changes?.length&&<p>No comparable classification or flag changes between these two retained responses.</p>}
  {version&&<><label>Source response <select className="select" value={version.id} onChange={e=>setSelected(e.target.value)}>{history.versions.map(v=><option key={v.id} value={v.id}>Retrieved {time(v.fetchedAt)}</option>)}</select></label>
   <p>First recorded {time(version.recordedAt)}. Source effective date unreported. Response freshness limit {time(version.expiresAt)}.</p>
   <p>Source coverage: {version.document?.exists==null?'Unreported':String(version.document.exists)}. Source classification: {version.document?.level??'Unreported'}.</p>
   {version.document?.omitted>0&&<p>{version.document.omitted} additional source items fall outside this bounded reading.</p>}
   <InvestigationTable caption="Original source classification, not a safety verdict" rows={version.document?.items||[]} columns={[
    ['Source observation',r=>r.description||r.code],['Result',r=>result(r.hit)],['Source level',r=>result(r.level)],
   ]}/><p className="intel-analysis-caption break-all">Version {version.id}</p>
   {saveable&&<SourceResearchNotes reference={version.sourceReference} title="CMC security source response"/>}
  </>}
  {history.has_more&&<p>Earlier versions exist beyond this bounded view.</p>}
 </details>
}
export function RwaSourceEvidence({history,saveable=false}){
 if(!history)return null
 return saveable?<SourceHistoryPager history={history}>{page=><RwaSourceView history={page}/>}</SourceHistoryPager>:<RwaSourceView history={history}/>
}
function RwaSourceView({history}){
 const [selected,setSelected]=useState(null)
 const version=history.versions?.find(v=>v.id===selected)||history.versions?.[0],r=version?.document
 return <details className="my-3"><summary>RWA relationship evidence</summary><p role={history.status==='error'?'alert':undefined}>{history.status} {history.reason}</p>
 {history.versions?.length>1&&<label>Relationship source <select className="select" value={version?.id} onChange={e=>setSelected(e.target.value)}>{history.versions.map(v=><option key={v.id} value={v.id}>Retrieved {time(v.fetchedAt)}</option>)}</select></label>}
 {r&&<><p>{r.tokenName} → {r.underlyingName} · {r.issuerName||'Issuer name unreported'}</p><p>Reported in source retrieved {time(version.fetchedAt)}; first recorded {time(version.recordedAt)}. Effective relationship date unreported. Response freshness limit {time(version.expiresAt)}.</p>
  <Link className="intel-text-link" to={`/intel/investigate?asset=rwa%3Acoinmarketcap%3A${encodeURIComponent(r.rwaId)}&lens=ownership&token=${encodeURIComponent(r.cryptoId)}`}>Underlying and issuer relationships</Link>{' · '}
  <Link className="intel-text-link" to={`/intel/investigate?asset=rwa%3Acoinmarketcap%3A${encodeURIComponent(r.rwaId)}&lens=sessions&token=${encodeURIComponent(r.cryptoId)}`}>Issuer terms and trading hours</Link>
  <p className="intel-analysis-caption">A relationship does not establish redemption eligibility, direct ownership rights or underlying NAV. Your position uses the selected portfolio ledger.</p><details><summary>Original source reference</summary><p className="break-all">{version.id}</p><p>{version.sourceReference?.endpoint}</p><p className="break-all">{version.sourceReference?.payloadHash}</p></details>
 </>}
 </details>
}
