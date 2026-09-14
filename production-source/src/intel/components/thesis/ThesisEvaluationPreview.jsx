import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

// Uses the existing authorized monitor dry run. Opening this section does no work.
export default function ThesisEvaluationPreview({ onPreview }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const [state, setState] = useState({})
  const request = useRef(0)
  useEffect(() => () => { request.current++ }, [])
  const preview = async () => {
    const id = ++request.current
    setState({ loading: true })
    try {
      const result = await onPreview()
      if (!result?.ok || !result.evidence_version) throw new Error('evaluation_unavailable')
      if (id === request.current) setState({ result })
    } catch {
      if (id === request.current) setState({ error: true })
    }
  }
  return <section aria-label={t('journal.monitorPreview', { defaultValue: 'Monitoring preview' })} className="space-y-2 text-sm">
    <button type="button" className="btn btn--quiet btn--sm" disabled={state.loading} onClick={preview}>
      {t('journal.previewMonitoring', { defaultValue: 'Preview monitoring' })}
    </button>
    <p className="text-[var(--fg-3)]">{t('journal.monitorPreviewHelp', { defaultValue: 'Check the current evidence without saving changes or sending notifications.' })}</p>
    {state.loading && <p role="status">{t('journal.monitorPreviewLoading', { defaultValue: 'Reading monitoring evidence…' })}</p>}
    {state.error && <p role="alert">{t('journal.monitorPreviewError', { defaultValue: 'Monitoring evidence could not be read. Try the preview again.' })}</p>}
    {state.result && <div role="status">
      <p>{t('journal.evidenceVersion', { defaultValue: 'Evidence version' })}: {state.result.evidence_version}</p>
      <p>{t('journal.newEvidenceCount', { defaultValue: 'New evidence records' })}: {state.result.new_evidence}</p>
      <p>{t('journal.monitorPreviewNoWrites', { defaultValue: 'Preview complete. No research, status, or notifications were changed.' })}</p>
    </div>}
  </section>
}
