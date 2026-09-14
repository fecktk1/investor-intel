import React,{useEffect,useState} from 'react'
import {Link} from 'react-router'
import {useSupabase} from '../../lib/useSupabase'
import {useProfile} from '../../lib/profile-context'
import {useResearchThread} from '../context/ResearchThreads'
import ResearchThreadPanel from './ResearchThreadPanel'
import {threadResumeHref} from './PinnedResearch'
export default function ComparisonThread({id,assets,period,view}){
 const {supabase,user}=useSupabase(),{org}=useProfile(),[state,setState]=useState({}),scope=`${user?.id}:${org?.id}:${id}`
 useEffect(()=>{if(!id||!user?.id||!org?.id)return;let alive=true;setState({scope,loading:true});supabase.from('intel_research_threads').select('id,subject').eq('id',id).eq('user_id',user.id).eq('org_id',org.id).maybeSingle().then(({data,error})=>{if(alive)setState({scope,row:data,error:error?.message||(!data?'This research thread is unavailable.':null)})}).catch(error=>{if(alive)setState({scope,error:error.message})});return()=>{alive=false}},[supabase,scope])
 const current=state.scope===scope?state:{loading:true},thread=useResearchThread(current.row?.subject)
 if(!id)return null
 if(current.loading)return <p role="status">Opening the original investigation thread…</p>
 if(current.error)return <p role="alert">{current.error}</p>
 if(!thread.record)return null
 const subject=current.row.subject
 const comparison={assets:assets.map(({asset,label})=>({asset,label})),period,view}
 const edit=patch=>thread.store.edit(subject,patch)
 const record=async action=>{if(action==='note'&&assets.length>=2){edit(previous=>({context:{...previous.context,comparison}}));return thread.store.append(subject,'comparison')}return thread.store.append(subject,action)}
 return <><ResearchThreadPanel subject={subject} title={thread.record.title} thread={thread} onQuestion={question=>edit({question})} onDecision={decision=>edit({decision})} onFlush={()=>thread.store.flush(subject)} onRecord={record}/><p className="text-xs">Recording notes keeps these comparison identities and view controls with your original question. Price history remains a separate evidence read. <Link className="intel-text-link" to={threadResumeHref({subject,context:thread.record.context})}>Return to investigation</Link></p></>
}
