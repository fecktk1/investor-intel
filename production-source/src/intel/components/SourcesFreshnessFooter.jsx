import React from 'react'
import { useTranslation } from 'react-i18next'
import { Database, Clock, AlertTriangle } from 'lucide-react'
import ConfidenceChip from './ConfidenceChip'

const SOURCE_NAMES = {intel_current_regime:'Market regime',market_macro_snapshots:'Market summary',narrative_category_snapshots:'Sector observations',narrative_state:'Narrative research',intel_curated_news:'Analyzed news',portfolio_holdings:'Your recorded holdings',brief_evidence_pack:'Brief evidence',ranked_evidence_package:'Selected evidence'}
const sourceName = value => String(value).split(' / ').map(part=>SOURCE_NAMES[part.toLowerCase()] || part.replace(/_/g,' ')).join(' / ')
const observationTime = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'long'}) : String(value)

// Provenance footer shown on every Intel insight: confidence + sources +
// per-source freshness + what could not be verified. Low confidence and stale
// data are visually distinct, never hidden.
export default function SourcesFreshnessFooter({ artifact, showCoverageWarning = true }) {
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
  const showWarning = materialGaps.length > 0 || coverage?.should_show_warning === true
  const freshEntries = Object.entries(fresh)
  const hasNeutralCoverage = coverage && (optionalGaps.length > 0 || unavailable.length > 0 || checked.length > 0 || used.length > 0)

  return (
    <div className="border-t border-[var(--border-default)] pt-3 space-y-2 text-[12px]">
      <div className="flex items-center gap-2 flex-wrap">
        <ConfidenceChip value={artifact.confidence} />
        <span className="flex items-center gap-1.5 text-[var(--fg-4)]">
          <Database className="h-3.5 w-3.5" />
          {sources.length ? [...new Set(sources.map(sourceName))].join(', ') : t('sources.none', { defaultValue: 'No sources reported' })}
        </span>
      </div>
      {freshEntries.length > 0 && (
        <details className="text-[var(--fg-4)]">
          <summary className="cursor-pointer flex items-center gap-1.5"><Clock className="h-3.5 w-3.5" />Source observation times</summary>
          <dl className="mt-2 space-y-2">{freshEntries.map(([key,value])=><div key={key}><dt>{sourceName(key)}</dt><dd title={String(value)} className="text-[var(--fg-2)]">{observationTime(value)}</dd></div>)}</dl>
        </details>
      )}
      {showCoverageWarning && showWarning && materialGaps.length > 0 && (
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
            {optionalGaps.length > 0 && <span className="text-[10px]">{optionalGaps.length} optional</span>}
          </summary>
          <div className="mt-2 space-y-1 pl-5">
            {used.length > 0 && <div>Used: {used.map(sourceName).join(', ')}</div>}
            {optionalGaps.length > 0 && <div>{optionalGaps.join('; ')}</div>}
            {unavailable.length > 0 && <div>{t('sources.missing', { defaultValue: 'Could not verify' })}: {unavailable.slice(0, 8).join(', ')}{unavailable.length > 8 ? '...' : ''}</div>}
          </div>
        </details>
      )}
    </div>
  )
}
