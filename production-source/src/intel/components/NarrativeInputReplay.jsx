import React,{useRef,useState} from 'react'
import {useProfile} from '../../lib/profile-context'
import {useSupabase} from '../../lib/useSupabase'

const label=k=>String(k).replaceAll('_',' ').replace(/([a-z])([A-Z])/g,'$1 $2')
const clock=v=>v&&Number.isFinite(Date.parse(v))?new Date(v).toLocaleString(undefined,{timeZoneName:'short'}):'Not recorded'
function InputRecord({value,name}){
 const [open,setOpen]=useState(false)
 if(value==null||typeof value!=='object')return <span className="whitespace-pre-wrap break-words">{value==null?'Not recorded':String(value)}</span>
 const entries=Object.entries(value),fields=entries.filter(([,v])=>v==null||typeof v!=='object'),nested=entries.filter(([,v])=>v!=null&&typeof v==='object')
 return <details onToggle={e=>setOpen(e.currentTarget.open)}><summary>{label(name)}{Array.isArray(value)?` · ${value.length} records`:''}</summary>{open&&<>
  {!entries.length&&<p>No records were present in this input.</p>}
  {fields.length>0&&<div className="intel-table-scroll"><table><thead><tr><th scope="col">Recorded field</th><th scope="col">Original value</th></tr></thead><tbody>{fields.map(([k,v])=><tr key={k}><th scope="row">{label(k)}</th><td><InputRecord value={v}/></td></tr>)}</tbody></table></div>}
  {nested.map(([k,v])=><InputRecord key={k} name={Array.isArray(value)?`Record ${Number(k)+1}`:k} value={v}/>)}
 </>}</details>
}
/** Explicit retained read only. Scope changes hide old personal state immediately;
 * a late response cannot populate another user's/org's report. */
export default function NarrativeInputReplay({artifact}){
 const {org}=useProfile(),{supabase,user}=useSupabase(),ref=artifact.structured?.narrative_input_receipt
 const scope=`${org?.id||''}:${user?.id||''}:${artifact.id||''}:${ref?.id||''}`,active=useRef(scope);active.current=scope
 const serial=useRef(0),[state,setState]=useState(null),current=state?.scope===scope?state:null
 async function load(section='context',page=1){
  if(!org?.id||!user?.id||!artifact.id)return
  const request=++serial.current
  setState({scope,section,page,loading:true})
  try{
   const {data,error}=await supabase.functions.invoke('intel-research',{body:{orgId:org.id,capability:'narrativeInputs',readMode:'retained',params:{artifactId:artifact.id,section,page}}})
   if(error||data?.error||!data?.state||!Array.isArray(data.records))throw Error('Original research inputs could not be loaded. Try again.')
   if(active.current===scope&&serial.current===request)setState({scope,section,page,data})
  }catch(error){if(active.current===scope&&serial.current===request)setState({scope,section,page,error:error.message})}
 }
 if(artifact.artifact_type!=='narrative_report')return null
 return <section aria-label="Original research inputs" className="border-t border-[var(--line)] pt-3 space-y-2">
  <h3>Original research inputs</h3>
  {!ref?<p>This report predates input replay. Its evidence will not be reconstructed from current data.</p>:<>
   <p className="text-[var(--fg-3)]">Recorded {clock(ref.recorded_at)}. These inputs belong to this report; each source retains its own observation time.</p>
   <details><summary>Evidence reference and retention</summary><p className="break-all">{ref.content_hash}</p><p>Source values retained until {clock(ref.retain_until)}. Your report and evidence reference remain after expiry.</p><p>{ref.normalization}</p></details>
   {!current&&<button className="btn btn--quiet btn--sm" disabled={!org?.id||!user?.id} onClick={()=>load()}>Inspect original inputs</button>}
   {current&&<>
    <label>Input section <select aria-label="Original input section" className="input" value={current.section} disabled={current.loading} onChange={e=>load(e.target.value,1)}><option value="context">Narrative & market context</option><option value="members">Member evidence</option><option value="signals">Narrative sources</option></select></label>
    {current.loading&&<p role="status">Loading original inputs…</p>}
    {current.error&&<div role="alert"><p>{current.error}</p><button className="btn btn--quiet btn--sm" onClick={()=>load(current.section,current.page)}>Retry original inputs</button></div>}
    {current.data&&<>
     {current.data.state!=='available'?<p role="status">{current.data.reason}</p>:<>
      <p>{current.data.total} recorded {current.section==='members'?'members':current.section==='signals'?'sources':'context record'} · Page {current.page}</p>
      {current.data.records.map((r,i)=><InputRecord key={`${current.section}:${current.page}:${i}`} value={r} name={r.subject?.symbol?`${r.subject.symbol} · ${r.subject.canonical_key}`:r.title||'Recorded input'}/>)}
      {!current.data.records.length&&<p>No records on this page of the original input.</p>}
      <div className="flex gap-2"><button className="btn btn--quiet btn--sm" disabled={current.page<=1} onClick={()=>load(current.section,current.page-1)}>Previous inputs</button><button className="btn btn--quiet btn--sm" disabled={!current.data.hasMore} onClick={()=>load(current.section,current.page+1)}>Next inputs</button></div>
     </>}
    </>}
   </>}
  </>}
 </section>
}
