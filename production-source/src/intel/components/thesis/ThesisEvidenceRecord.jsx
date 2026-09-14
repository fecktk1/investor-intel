import React from 'react'
import { useTranslation } from 'react-i18next'
import RecordedEvidence from './RecordedEvidence'

export default function ThesisEvidenceRecord({ evidence: e }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const snap = e.event_snapshot || {}
  return (
              <div key={e.id} className="card p-3 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[13px] text-[var(--fg-1)]">{snap.title || e.event_type}</div>
                  {e.user_label && <span className="chip text-[10px]">{e.user_label}</span>}
                </div>
                {snap.summary && <p className="text-[12px] text-[var(--fg-3)]">{snap.summary}</p>}
                <RecordedEvidence version={snap.evidence_version} sources={[{
                  ...snap, citation_id: snap.coach_citation_id || snap.citation_id,
                  source_table: e.source_table, source_ref: e.source_ref, date: e.event_at || snap.date,
                }]} />
                <div className="flex items-center gap-1.5 flex-wrap text-[10px] text-[var(--fg-5)]">
                  {e.impact && <span className={`chip ${e.impact === 'supports' || e.impact === 'confirms' ? 'chip--ok' : e.impact === 'weakens' || e.impact === 'invalidates' ? 'chip--err' : ''}`}>{e.impact}</span>}
                  <span>{e.event_type}</span>{e.is_baseline && <span className="chip chip--info">baseline</span>}
                </div>
              </div>
  )
}
