import React,{useCallback,useEffect,useRef,useState} from 'react'
import {Link,useSearchParams} from 'react-router'
import {useTranslation} from 'react-i18next'
import {useProfile} from '../../lib/profile-context'
import {useSupabase} from '../../lib/useSupabase'
import {listThesesPage} from '../lib/thesis-api'
import IntelErrorNotice from '../components/IntelErrorNotice'

const statuses=['','active','strengthening','weakening','needs_review','confirmed','invalidated','closed','archived']
const date=value=>{if(!value)return '—';const parsed=/^\d{4}-\d{2}-\d{2}$/.test(value)?new Date(...String(value).split('-').map((n,i)=>Number(n)-(i===1?1:0))):new Date(value);return Number.isFinite(parsed.getTime())?parsed.toLocaleDateString():'—'}
export default function ThesisListPage(){
 const {t}=useTranslation('intel',{useSuspense:false}),{org}=useProfile(),{supabase,user}=useSupabase()
 const [params,setParams]=useSearchParams(),status=statuses.includes(params.get('status')||'')?params.get('status')||'':'',q=(params.get('q')||'').slice(0,200),page=Math.max(0,Math.min(10000,Math.trunc(Number(params.get('page'))||0)))
 const [search,setSearch]=useState(q),[state,setState]=useState({scope:null,rows:[],hasMore:false,loading:true,error:null})
 const scope=JSON.stringify([org?.id,user?.id,status,q,page]),active=useRef(scope),sequence=useRef(0);active.current=scope
 const load=useCallback(async()=>{
  const id=++sequence.current
  if(!org?.id||!user?.id)return
  setState(previous=>({...previous,scope,loading:true,error:null,rows:previous.scope===scope?previous.rows:[]}))
  try{const data=await listThesesPage(supabase,org.id,{status,q,page});if(active.current===scope&&sequence.current===id)setState({...data,scope,loading:false,error:null})}
  catch(error){if(active.current===scope&&sequence.current===id)setState({scope,rows:[],hasMore:false,loading:false,error:error.message})}
 },[scope,org?.id,user?.id,supabase,status,q,page])
 useEffect(()=>{void load();return()=>{sequence.current++}},[load])
 useEffect(()=>setSearch(q),[q])
 const update=(key,value)=>{const next=new URLSearchParams(params);if(value)next.set(key,String(value));else next.delete(key);if(key!=='page')next.delete('page');setParams(next)}
 const current=state.scope===scope,rows=current?state.rows:[],loading=!current||state.loading
 return <section className="space-y-4" aria-label="Thesis journal index">
  <div className="intel-investigation-analysis-heading"><div><h1 className="page-title">{t('journal.nav.theses',{defaultValue:'Theses'})}</h1><p className="page-sub">Your decisions, evidence and review history, including closed and archived research.</p></div></div>
  <form className="intel-journal-filters" onSubmit={event=>{event.preventDefault();update('q',search.trim())}}>
   <label>Find a thesis<input type="search" maxLength={200} value={search} onChange={event=>setSearch(event.target.value)}/></label><button type="submit" className="btn">Search</button>
   <label>Status<select value={status} onChange={event=>update('status',event.target.value)}>{statuses.map(value=><option key={value} value={value}>{value?t(`journal.status.${value}`,{defaultValue:value.replaceAll('_',' ')}):'All statuses'}</option>)}</select></label>
  </form>
  {current&&state.error&&<div role="alert"><IntelErrorNotice error={state.error}/><button type="button" className="btn" onClick={load}>Retry journal</button></div>}
  {loading?<p role="status">Loading theses…</p>:!state.error&&rows.length===0?<p>{q||status||page?'No theses match this view. Change the search or status, or return to the first page.':'No theses yet. Create a thesis to record your reasoning and track its history on the asset chart.'}</p>:rows.length>0&&<div className="intel-journal-table" tabIndex={0} role="region" aria-label="Thesis results; scroll horizontally for all columns"><table>
   <thead><tr><th>Thesis and asset</th><th>Status / stance</th><th>Conviction</th><th>Next review</th><th>Details</th></tr></thead>
   <tbody>{rows.map(row=><tr key={row.id}>
    <td><Link to={`/intel/theses/${row.id}`} state={{journalReturn:{url:`/intel/theses/list${params.size?'?'+params.toString():''}`,orgId:org?.id,userId:user?.id}}} className="intel-text-link">{row.title||'Untitled thesis'}</Link><small>{row.subject_canonical_key||'Identity not recorded'}{row.user_id!==user?.id?' · Shared research':''}</small></td>
    <td>{t(`journal.status.${row.status}`,{defaultValue:row.status})}<small>{row.stance||'—'}{row.needs_user_review?' · Review due':''}</small></td>
    <td>{row.conviction==null?'—':`${Math.round(row.conviction*5)}/5`}</td><td>{date(row.next_review_at)}</td>
    <td><details><summary>Research details</summary><dl><dt>Type</dt><dd>{row.thesis_type||'asset'}</dd><dt>Horizon</dt><dd>{row.time_horizon||'Unspecified'}</dd><dt>Recorded</dt><dd>{date(row.thesis_date||row.created_at)}</dd><dt>Quality</dt><dd>{row.quality_score==null?'—':`${row.quality_score}/100`}</dd></dl></details></td>
   </tr>)}</tbody>
  </table></div>}
  <nav className="intel-chart-navigation" aria-label="Thesis pages"><button type="button" disabled={loading||page===0} onClick={()=>update('page',page-1)}>Previous page</button><span>Page {page+1}</span><button type="button" disabled={loading||!state.hasMore} onClick={()=>update('page',page+1)}>Next page</button>{page>0&&<button type="button" onClick={()=>update('page',0)}>First page</button>}</nav>
 </section>
}
