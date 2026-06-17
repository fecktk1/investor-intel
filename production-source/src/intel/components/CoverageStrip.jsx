import React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'

// Prominent honesty strip for an artifact's reconciled data_coverage. Elevates
// should_show_warning + material gaps above the provenance footer so a thin /
// unverified read is visible at a glance, not buried. Renders nothing when the
// read is clean — SourcesFreshnessFooter still carries confidence + sources.
export default function CoverageStrip({ coverage }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  if (!coverage) return null
  const material = Array.isArray(coverage.material_gaps) ? coverage.material_gaps.filter(Boolean) : []
  const warn = coverage.should_show_warning === true
  // Surface only when there is a real honesty story: an active warning, or
  // material gaps the warning suppressed (high-confidence-but-gappy reads).
  if (!warn && material.length === 0) return null
  const gaps = material.slice(0, 4).join('; ')

  if (warn) {
    return (
      <div className="card--flat p-3 flex items-start gap-2 border border-red-400/30 bg-red-400/5">
        <AlertTriangle className="h-4 w-4 text-red-400 mt-0.5 flex-shrink-0" />
        <div className="text-[12px] leading-relaxed">
          <div className="font-medium text-red-400">{t('coverage.limited_title', { defaultValue: 'Limited data on this read' })}</div>
          {gaps && <div className="text-[var(--fg-3)] mt-0.5">{t('coverage.unverified', { defaultValue: "Couldn't verify" })}: {gaps}</div>}
        </div>
      </div>
    )
  }
  // Warning suppressed by high confidence, but gaps remain — don't render clean.
  return (
    <div className="card--flat p-2.5 flex items-start gap-2 border border-amber-400/20">
      <AlertTriangle className="h-3.5 w-3.5 text-amber-400/80 mt-0.5 flex-shrink-0" />
      <div className="text-[12px] text-[var(--fg-3)] leading-relaxed">
        {t('coverage.mostly_covered', { defaultValue: 'Mostly covered' })} — {t('coverage.unverified', { defaultValue: "Couldn't verify" })}: {gaps}
      </div>
    </div>
  )
}
