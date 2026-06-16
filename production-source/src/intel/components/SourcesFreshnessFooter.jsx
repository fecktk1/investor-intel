import React from 'react'
import { useTranslation } from 'react-i18next'
import { Database, Clock, AlertTriangle } from 'lucide-react'
import ConfidenceChip from './ConfidenceChip'

// Provenance footer shown on every Intel insight: confidence + sources +
// per-source freshness + what could not be verified. Low confidence and stale
// data are visually distinct, never hidden.
export default function SourcesFreshnessFooter({ artifact }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  if (!artifact) return null
  const sources = artifact.sources || []
  const fresh = artifact.data_freshness || {}
  const missing = artifact.missing_context || artifact.structured?.missing_context || []
  const coverage = artifact.data_coverage || artifact.structured?.data_coverage || null
  const materialGaps = coverage?.material_gaps || missing
  const optionalGaps = coverage?.optional_gaps || []
  const unavailable = coverage?.unavailable_sources || []
  const checked = coverage?.checked_sources || []
  const used = coverage?.used_sources || []
  const showWarning = typeof coverage?.should_show_warning === 'boolean'
    ? coverage.should_show_warning
    : materialGaps.length > 0
  const freshEntries = Object.entries(fresh)
  const hasNeutralCoverage = coverage && (optionalGaps.length > 0 || unavailable.length > 0 || checked.length > 0 || used.length > 0)

  return (
    <div className="card--flat p-3 space-y-2 text-[12px]">
      <div className="flex items-center gap-2 flex-wrap">
        <ConfidenceChip value={artifact.confidence} />
        <span className="flex items-center gap-1.5 text-[var(--fg-4)]">
          <Database className="h-3.5 w-3.5" />
          {sources.length ? sources.join(', ') : t('sources.none', { defaultValue: 'No sources reported' })}
        </span>
      </div>
      {freshEntries.length > 0 && (
        <div className="flex items-start gap-1.5 text-[var(--fg-4)]">
          <Clock className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
          <span>{freshEntries.map(([k, v]) => `${k}: ${v}`).join(' · ')}</span>
        </div>
      )}
      {showWarning && materialGaps.length > 0 && (
        <div className="flex items-start gap-1.5 text-amber-400/80">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
          <span>{t('sources.missing', { defaultValue: 'Could not verify' })}: {materialGaps.join('; ')}</span>
        </div>
      )}
      {hasNeutralCoverage && (
        <details className="text-[var(--fg-4)]">
          <summary className="cursor-pointer select-none flex items-center gap-1.5">
            <Database className="h-3.5 w-3.5 flex-shrink-0" />
            <span>Data {t('markets.coverage', { defaultValue: 'coverage' })}</span>
            {optionalGaps.length > 0 && <span className="chip text-[10px]">{optionalGaps.length} optional</span>}
          </summary>
          <div className="mt-2 space-y-1 pl-5">
            {used.length > 0 && <div>Used: {used.slice(0, 8).join(', ')}{used.length > 8 ? '...' : ''}</div>}
            {optionalGaps.length > 0 && <div>{optionalGaps.join('; ')}</div>}
            {unavailable.length > 0 && <div>{t('sources.missing', { defaultValue: 'Could not verify' })}: {unavailable.slice(0, 8).join(', ')}{unavailable.length > 8 ? '...' : ''}</div>}
          </div>
        </details>
      )}
    </div>
  )
}
