import React, { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { useSupabase } from '../../lib/useSupabase'
import { useProfile } from '../../lib/profile-context'
import { threadResumeHref } from './PinnedResearch'

export default function ResearchThreadLibrary() {
  const { supabase, user } = useSupabase(), { org } = useProfile()
  const [page, setPage] = useState(0), [attempt, setAttempt] = useState(0), [state, setState] = useState({})
  const scope = `${user?.id}:${org?.id}:${page}`
  useEffect(() => {
    if (!user?.id || !org?.id) return
    let alive = true
    setState({scope,loading:true})
    supabase.from('intel_research_threads').select('id,subject,title,draft_question,context,revision,updated_at').eq('org_id',org.id).eq('user_id',user.id).order('updated_at',{ascending:false}).order('id').range(page*10,page*10+10).then(({data,error}) => {
      if (alive) setState({scope,rows:Array.isArray(data)?data.slice(0,10):[],hasMore:data?.length>10,error:error?.message || (!Array.isArray(data)?'Your research threads could not be read.':null)})
    }).catch(error => { if (alive) setState({scope,error:error.message}) })
    return () => { alive=false }
  }, [supabase,user?.id,org?.id,scope,page,attempt])
  const current = state.scope===scope?state:{loading:true}
  return <details className="intel-open-section intel-thread-library" aria-label="Your continuous investigations"><summary>Continue an investigation</summary><p className="text-xs text-[var(--fg-4)] mb-3">Private questions and drafts. Recorded entries preserve the words and evidence you saved.</p>{current.loading?<p role="status">Loading your investigations…</p>:current.error?<p role="alert">{current.error} <button className="intel-text-link" onClick={()=>setAttempt(n=>n+1)}>Retry</button></p>:!current.rows?.length?<p>No investigations saved yet. <Link className="intel-text-link" to="/intel/investigate">Start a question</Link></p>:<ul>{current.rows.map(row=><li key={row.id} className="border-t py-2"><Link className="intel-text-link" to={threadResumeHref(row)}>{row.title}</Link><p className="text-sm">{row.draft_question}</p><small className="text-[var(--fg-4)]">Draft revision {row.revision} · {new Date(row.updated_at).toLocaleString(undefined,{timeZoneName:'short'})}</small></li>)}</ul>}<div className="flex gap-4 mt-2">{page>0&&<button className="intel-text-link" onClick={()=>setPage(n=>n-1)}>Newer investigations</button>}{current.hasMore&&<button className="intel-text-link" onClick={()=>setPage(n=>n+1)}>Older investigations</button>}</div></details>
}
