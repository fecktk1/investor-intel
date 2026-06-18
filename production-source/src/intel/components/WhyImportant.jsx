import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Sparkles, ChevronUp } from 'lucide-react'
import { useArtifact } from '../lib/useArtifact'
import ArtifactView from './ArtifactView'

// Inline "Why is this important?" — generates an easy-to-understand explain artifact
// for any headline / event / indicator, exactly like Explain This (same
// intel-generate 'explain' path, same guardrails + cost controls). Lazy: only
// generates on first expand.
export default function WhyImportant({ topic, context = '', entityId = null }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const [open, setOpen] = useState(false)
  const ex = useArtifact()

  const onClick = () => {
    if (open) { setOpen(false); return }
    setOpen(true)
    if (!ex.result && !ex.loading) {
      const q = `Explain the impact of this market context in simple terms: "${topic}".${context ? ` Context: ${context}` : ''} Cover what it means, why it matters, and what to watch next. This is education, not financial advice.`
      ex.generate({ artifactType: 'explain', entityId, extra: { question: q } })
    }
  }

  return (
    <div className="mt-1.5">
      <button type="button" onClick={onClick} className="chip inline-flex items-center gap-1 text-[var(--accent)]">
        {open ? <ChevronUp className="h-3 w-3" /> : <Sparkles className="h-3 w-3" />}
        {t('macro.why', { defaultValue: 'Explain impact' })}
      </button>
      {open && (
        <div className="mt-2">
          <ArtifactView result={ex.result} loading={ex.loading} />
          {ex.error && <div className="card--flat p-2 text-[12px] text-red-400">{ex.error}</div>}
        </div>
      )}
    </div>
  )
}
