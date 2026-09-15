import React from 'react'
import { useArtifact } from '../lib/useArtifact'
import ArtifactView from './ArtifactView'

export default function NarrativeResearch({slug, name}) {
  const research = useArtifact(`narrative:${slug}`)
  const request = force => research.generate({artifactType:'narrative_report',extra:{narrativeSlug:slug,title:`${name} — narrative research`},force})
  return <section className="space-y-2" aria-label="Narrative research report">
    <div className="flex items-center justify-between flex-wrap gap-2"><h2 className="intel-section-title">Research this narrative</h2><button className="btn btn--primary btn--sm" disabled={research.loading} onClick={()=>request(Boolean(research.result))}>{research.result?'Create updated report':'Create narrative report'}</button></div>
    <p className="intel-analysis-caption">Uses retained member, sector, market and source evidence when you request it. Updates create a new report; original research remains in your history.</p>
    {research.loading && <p role="status">Preparing the narrative report…</p>}
    {research.error && <p role="alert">{research.error}</p>}
    {research.result && <><p className="intel-analysis-caption">{research.result.artifact?.evidence_hash ? `Report evidence ${research.result.artifact.evidence_hash}` : 'Evidence version is unavailable in this response.'}</p><ArtifactView result={research.result} savePrivately/></>}
  </section>
}
