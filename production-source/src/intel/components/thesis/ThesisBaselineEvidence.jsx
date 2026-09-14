import React, { useState } from 'react'
import { getThesisRecordedEvidence } from '../../lib/thesis-api'
import RecordedEvidence from './RecordedEvidence'

export default function ThesisBaselineEvidence({supabase,orgId,thesisId}) {
 const [result,setResult]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(null)
 const load=async()=>{setBusy(true);setError(null);try{setResult(await getThesisRecordedEvidence(supabase,orgId,thesisId))}catch(e){setError(e.message)}finally{setBusy(false)}}
 return <section className="border-b border-[var(--border-default)] py-3 space-y-2" aria-label="Evidence at thesis creation">
  <h2>Evidence at thesis creation</h2>
  <p className="text-xs text-[var(--fg-4)]">The original research version, with each source's observation time. Loading it does not refresh evidence or generate research.</p>
  {!result&&<button className="btn btn--quiet btn--sm" onClick={load} disabled={busy}>{busy?'Loading recorded version…':error?'Retry recorded version':'Load recorded version'}</button>}
  {error&&<p role="alert">{error}</p>}
  {result?.reason&&<p>{result.reason}</p>}
  {result?.version&&<RecordedEvidence {...result}/>}
 </section>
}
