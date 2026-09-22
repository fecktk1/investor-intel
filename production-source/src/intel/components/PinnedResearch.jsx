import React, { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { useWorkspacePreference } from '../context/PersonalWorkspace'
import { useResearchThread } from '../context/ResearchThreads'
export function threadResumeHref(thread) {
  const params = new URLSearchParams({ asset: thread.subject })
  for (const key of ['lens', 'range', 'at', 'portfolio', 'thesis', 'network', 'watchlist']) if (thread.context?.[key] != null) params.set(key, String(thread.context[key]))
  return `/intel/investigate?${params}`
}
export default function PinnedResearch() {
  const { t } = useTranslation('intel', { useSuspense: false }), prefs = useWorkspacePreference('selection'), { supabase, user } = useSupabase(), { org } = useProfile()
  const id = prefs.value.pinnedThreadId, scope = `${user?.id}:${org?.id}:${id}`
  const details = useRef(null),[retry,setRetry]=useState(0)
  const [state, setState] = useState({ scope: null, row: null, error: null })
  useEffect(() => {
    if (!id || !user?.id || !org?.id) return
    let alive = true
    setState({ scope, row: null, error: null })
    supabase.from('intel_research_threads').select('id,subject,title,draft_question,context,revision').eq('id', id).eq('org_id', org.id).eq('user_id', user.id).maybeSingle().then(({ data, error }) => { if (alive) setState({ scope, row: data, error: error?.message || (!data ? 'Pinned thread is unavailable.' : null) }) }).catch(()=>{if(alive)setState({scope,row:null,error:'Pinned thread is unavailable.'})})
    return () => { alive = false }
  }, [supabase, id, user?.id, org?.id, scope,retry])
  useEffect(()=>{if(details.current)details.current.open=false},[scope])
  useEffect(()=>{
    const close=event=>{if(details.current?.open&&!details.current.contains(event.target))details.current.open=false}
    document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close)
  },[])
  const row = state.scope === scope ? state.row : null, thread = useResearchThread(row?.subject, { load: false })
  const current = id && thread.record?.thread?.id === id ? thread.record.thread : row
  const error=prefs.error||(state.scope===scope&&state.error)
  const pending=prefs.loading||!!id&&!current&&!error
  return <aside className="intel-research-context-row" aria-label={t('thread.pinned_context', { defaultValue: 'Pinned investigation context' })}>
    <details ref={details} className="intel-research-context" onKeyDown={event=>{if(event.key==='Escape'&&details.current?.open){event.preventDefault();details.current.open=false;details.current.querySelector('summary')?.focus()}}}>
      <summary><span>{t('thread.context_label',{defaultValue:'Research context'})}</span><strong>{current?.title||t(pending?'thread.context_loading':error?'thread.context_unavailable':'thread.context_unpinned',{defaultValue:pending?'Loading…':error?'Unavailable':'Nothing pinned'})}</strong></summary>
      <div className="intel-research-context-detail">
        {pending&&<p role="status">{t('thread.loading_pinned',{defaultValue:'Opening pinned investigation…'})}</p>}
        {error&&<p role="alert">{t('thread.pinned_failed',{defaultValue:'Your pinned investigation could not be loaded.'})} <button className="intel-text-link" onClick={()=>prefs.error?prefs.reload?.():setRetry(n=>n+1)}>{t('thread.retry_pinned',{defaultValue:'Retry reading'})}</button></p>}
        {current&&<><strong>{current.title}</strong><p className="whitespace-pre-wrap">{current.draft_question}</p><small className="break-all">{current.subject}</small></>}
        {!pending&&!error&&!id&&<p>{t('thread.pin_hint',{defaultValue:'Pin an investigation to keep its question and evidence close as you move through your workspace.'})}</p>}
        {!!id&&<button className="intel-text-link" onClick={()=>prefs.save({pinnedThreadId:null}).catch(error=>setState(s=>({...s,error:error.message})))}>{t('thread.unpin',{defaultValue:'Unpin'})}</button>}
      </div>
    </details>
    {current&&<Link className="intel-text-link" to={threadResumeHref(current)}>{t('thread.resume',{defaultValue:'Continue research'})}</Link>}
  </aside>
}
