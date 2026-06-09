import React, { useState, useCallback, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { HelpCircle, Send } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { getEntityByRef } from '../lib/artifact-api'
import { useArtifact } from '../lib/useArtifact'
import ArtifactView from '../components/ArtifactView'
import IntelDisclaimer from '../components/IntelDisclaimer'

const QUICK = [
  ['explain_new', 'Explain like I\'m new'],
  ['why_moving', 'Why might this be moving?'],
  ['bull_bear', 'Give the bull, bear and neutral case'],
  ['risks', 'What are the key risks?'],
]

// P11 — Explain This (plain-English Q&A over an entity / general crypto topic).
export default function ExplainPage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const [sp] = useSearchParams()
  const refParam = sp.get('ref')
  const { org } = useProfile()
  const { supabase } = useSupabase()
  const [question, setQuestion] = useState('')
  const [entity, setEntity] = useState(null)
  const ex = useArtifact()

  useEffect(() => {
    let alive = true
    ;(async () => {
      if (refParam && org?.id) {
        try { const e = await getEntityByRef(supabase, org.id, decodeURIComponent(refParam)); if (alive) setEntity(e) } catch { /* ignore */ }
      }
    })()
    return () => { alive = false }
  }, [refParam, org?.id, supabase])

  const ask = useCallback((q) => {
    const question_ = (q ?? question).trim()
    if (!question_) return
    ex.generate({ artifactType: 'explain', entityId: entity?.id || null, entity: entity || null, extra: { question: question_ } })
  }, [question, entity, ex])

  return (
    <div className="space-y-5">
      <div>
        <div className="eyebrow flex items-center gap-1.5"><HelpCircle className="h-3.5 w-3.5" /> {t('brand.name', { defaultValue: 'Investor Intel' })}</div>
        <h1 className="page-title">{t('nav.explain', { defaultValue: 'Explain This' })}</h1>
        <p className="page-sub">{t('pages.explain_sub', { defaultValue: 'Plain-English explanations for any token, wallet, chart or narrative.' })}</p>
      </div>

      <form onSubmit={(e) => { e.preventDefault(); ask() }} className="card p-4 space-y-3">
        {entity && <div className="text-[12px] text-[var(--fg-4)] font-mono break-all">{entity.canonical_ref_key}</div>}
        <textarea className="textarea w-full" rows={3} placeholder={t('explain.placeholder', { defaultValue: 'Ask anything — e.g. “What is liquidity and why does it matter?”' })} value={question} onChange={(e) => setQuestion(e.target.value)} />
        <div className="flex flex-wrap gap-2">
          {QUICK.map(([k, def]) => (
            <button key={k} type="button" className="chip" onClick={() => { const q = t(`explain.quick.${k}`, { defaultValue: def }); setQuestion(q); ask(q) }}>{t(`explain.quick.${k}`, { defaultValue: def })}</button>
          ))}
        </div>
        <div className="flex justify-end">
          <button type="submit" className="btn btn--primary btn--sm" disabled={ex.loading || !question.trim()}><Send className="h-4 w-4" /> {t('explain.ask', { defaultValue: 'Ask' })}</button>
        </div>
      </form>

      <ArtifactView result={ex.result} loading={ex.loading} />
      {ex.error && <div className="card--flat p-3 text-[13px] text-red-400">{ex.error}</div>}
      <IntelDisclaimer variant="block" />
    </div>
  )
}
