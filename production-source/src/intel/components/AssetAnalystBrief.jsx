import React from 'react'
import { useTranslation } from 'react-i18next'
import ArtifactView from './ArtifactView'
export default function AssetAnalystBrief({ analysis, onOpen }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  return <section className="space-y-2">
    <div className="flex items-center justify-between">
      <div className="eyebrow">{t('markets.aiExplain', { defaultValue: 'Analyst brief' })}</div>
      <button onClick={() => onOpen(!!analysis.result)} disabled={analysis.loading} className="btn btn--primary btn--sm">
        {analysis.result ? t('markets.updatedBrief', { defaultValue: 'Create updated brief' }) : t('markets.explainWhy', { defaultValue: 'Open brief' })}
      </button>
    </div>
    {analysis.loading && <p role="status">{t('markets.preparingBrief', { defaultValue: 'Preparing research from the available evidence…' })}</p>}
    {analysis.error && <p role="alert">{analysis.error}</p>}
    {analysis.result && <>
      <p className="text-xs text-[var(--fg-4)]">{t('markets.updatedBriefNote', { defaultValue: 'An update creates a new research record. Earlier research remains in your history.' })}</p>
      <ArtifactView result={analysis.result} />
    </>}
  </section>
}
