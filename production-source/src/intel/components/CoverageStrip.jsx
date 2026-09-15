import React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'

// Prominent honesty strip for an artifact's reconciled data_coverage. Elevates
// should_show_warning + material gaps above the provenance footer so a thin /
// unverified read is visible at a glance, not buried. Renders nothing when the
// read is clean — SourcesFreshnessFooter still carries confidence + sources.
export default function CoverageStrip({ coverage, compact = false }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  if (!coverage) return null
  const material = Array.isArray(coverage.material_gaps) ? coverage.material_gaps.filter(Boolean) : []
  const warn = material.length > 0 || coverage.should_show_warning === true
  // Older saved artifacts may contain the former confidence-based suppression.
  // Display their recorded material gaps without rewriting the saved artifact.
  if (!warn && material.length === 0) return null
  if (compact) return <details className="intel-coverage-disclosure">
    <summary><AlertTriangle className="h-4 w-4"/><span>{t('coverage.limited_title', { defaultValue: 'Limited data on this read' })}</span><span className="intel-coverage-action">Review {material.length || ''} {material.length === 1 ? 'gap' : 'gaps'}</span></summary>
    {material.length > 0 && <ul>{material.map((gap,index)=><li key={index}>{gap}</li>)}</ul>}
  </details>
  return (
    <aside className="border-l-2 border-[var(--accent)] pl-3 py-2 flex items-start gap-2">
      <AlertTriangle className="h-4 w-4 text-[var(--accent)] mt-0.5 flex-shrink-0" />
      <div className="min-w-0 flex-1 text-[12px] text-[var(--fg-3)] leading-relaxed">
        <div className="font-medium text-[var(--fg-1)]">{t('coverage.limited_title', { defaultValue: 'Limited data on this read' })}</div>
        {material.length > 0 && <details className="intel-coverage-disclosure mt-1">
          <summary>{t('coverage.unverified', { defaultValue: "Couldn't verify" })}<span className="intel-coverage-action">{material.length}</span></summary>
          <ul>{material.map((gap,index)=><li key={index}>{gap}</li>)}</ul>
        </details>}
      </div>
    </aside>
  )
}
