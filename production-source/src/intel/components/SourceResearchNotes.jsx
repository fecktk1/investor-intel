import React,{useEffect,useId,useRef,useState} from 'react'
import {Link} from 'react-router'
import {useProfile} from '../../lib/profile-context'
import {useSupabase} from '../../lib/useSupabase'
import {saveResearch} from '../lib/intel-data'
import {savedCohortPath} from '../lib/cohort-evidence'

/** Private authored notes attach to the exact reference visible at Save. A new
 * response never rewrites an earlier save or substitutes today's values. */
export default function SourceResearchNotes({reference,title,workspacePath,onDraftChange}) {
 const {org}=useProfile(),{user,supabase}=useSupabase()
 if(!org?.id||!user?.id||!reference?.payloadHash)return null
 return <Notes key={`${user.id}:${org.id}:${reference.subject}:${reference.payloadHash}:${workspacePath||''}`} reference={reference} title={title} workspacePath={savedCohortPath(workspacePath)} orgId={org.id} userId={user.id} supabase={supabase} onDraftChange={onDraftChange}/>
}
function Notes({reference,title,workspacePath,orgId,userId,supabase,onDraftChange}) {
 const [note,setNote]=useState(''),[saving,setSaving]=useState(false),[saved,setSaved]=useState(null),[error,setError]=useState(null)
 const lock=useRef(false),alive=useRef(true),id=useId()
 const draftCallback=useRef(onDraftChange);draftCallback.current=onDraftChange
 useEffect(()=>{draftCallback.current?.(Boolean(note)&&!saved||saving)},[note,saved,saving])
 useEffect(()=>()=>draftCallback.current?.(false),[])
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
 const save=async()=>{
  if(lock.current||!note.trim())return
  lock.current=true;setSaving(true);setError(null)
  try {
   const row=await saveResearch(supabase,orgId,userId,{artifactId:null,title,
    snapshot:{summary:note,source:'CoinMarketCap',source_evidence:reference,replay:'Source references and your original notes; provider values are not embedded.',...(workspacePath?{workspace_path:workspacePath}:{})},
    tags:['investigation','source-reference'],privateOwner:true})
   if(alive.current)setSaved(row?.id||true)
  }catch(e){if(alive.current)setError(e.message||'Research could not be saved.')}
  finally{lock.current=false;if(alive.current)setSaving(false)}
 }
 return <details><summary>Save this source to your research</summary>
  <p className="intel-analysis-caption">Keeps your original words, the response fingerprint and source clocks. CMC data values are not embedded under the current export policy.</p>
  <label htmlFor={id}>Your notes about this source</label><textarea id={id} className="textarea w-full" maxLength={20000} disabled={saving||!!saved} value={note} onChange={e=>setNote(e.target.value)}/>
  <button className="btn" disabled={saving||!!saved||!note.trim()} onClick={save}>{saving?'Saving…':saved?'Saved privately':'Save source and notes'}</button>
  {saved&&<Link className="intel-text-link ml-3" to={typeof saved==='string'?`/intel/research?research_id=${encodeURIComponent(saved)}`:'/intel/research'}>Open saved research</Link>}
  {error&&<p role="alert">{error}</p>}
 </details>
}
