import React, { useState, useCallback, useEffect } from 'react'
import { useSearchParams } from 'react-router'
import { useTranslation } from 'react-i18next'
import { HelpCircle, Send } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { getEntityByRef } from '../lib/artifact-api'
import { useArtifact } from '../lib/useArtifact'
import ArtifactView from '../components/ArtifactView'
import IntelDisclaimer from '../components/IntelDisclaimer'
import IntelSurfaceGate from '../components/IntelSurfaceGate'

const QUICK = [
  ['explain_new', 'Explain like I\'m new'],
  ['why_moving', 'Why might this be moving?'],
  ['bull_bear', 'Give the bull, bear and neutral case'],
  ['risks', 'What are the key risks?'],
]

// P11 — Explain This (easy-to-understand Q&A over an entity / general crypto topic).
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

  const [lastQ, setLastQ] = useState(null)
  const ask = useCallback((q, force = false) => {
    const question_ = (q ?? question).trim()
    if (!question_) return
    setLastQ(question_)
    ex.generate({ artifactType: 'explain', entityId: entity?.id || null, entity: entity || null, force: force === true, extra: { question: question_ } })
  }, [question, entity, ex])

  const SURFACE_LABEL = { watchlist: 'your watchlist', theses: 'your theses', alerts: 'your recent alerts', saved_research: 'your saved research', narratives: 'narratives', signals: 'stored signals' }

  return (
    <div className="space-y-5">
      <div>
        <div className="eyebrow flex items-center gap-1.5"><HelpCircle className="h-3.5 w-3.5" /> {t('brand.name', { defaultValue: 'Investor Intel' })}</div>
        <h1 className="page-title">{t('nav.explain', { defaultValue: 'Explain This' })}</h1>
        <p className="page-sub">{t('pages.explain_sub', { defaultValue: 'Clear, easy-to-understand explanations for any token, wallet, chart or narrative.' })}</p>
      </div>

      {/* Asking spends model tokens for this one reader, so the prompt to
          upgrade sits on the asking, not on the page. */}
      <IntelSurfaceGate surface="ai_generation" title={t('access.surface_ai_generation', { defaultValue: 'AI generation' })}>
      <form onSubmit={(e) => { e.preventDefault(); ask() }} className="card p-4 space-y-3">
        {entity && <div className="text-[12px] text-[var(--fg-4)] font-mono break-all">{entity.canonical_ref_key}</div>}
        <textarea className="textarea w-full" rows={3} placeholder={t('explain.placeholder', { defaultValue: 'Ask anything, e.g. “What is liquidity and why does it matter?”' })} value={question} onChange={(e) => setQuestion(e.target.value)} />
        <div className="flex flex-wrap gap-2">
          {QUICK.map(([k, def]) => (
            <button key={k} type="button" className="chip" onClick={() => { const q = t(`explain.quick.${k}`, { defaultValue: def }); setQuestion(q); ask(q) }}>{t(`explain.quick.${k}`, { defaultValue: def })}</button>
          ))}
        </div>
        <div className="flex justify-end">
          <button type="submit" className="btn btn--primary btn--sm" disabled={ex.loading || !question.trim()}><Send className="h-4 w-4" /> {t('explain.ask', { defaultValue: 'Ask' })}</button>
        </div>
      </form>
      </IntelSurfaceGate>

      {/* Context-routing provenance: which of YOUR cached surfaces grounded the answer */}
      {Array.isArray(ex.result?.matched_surfaces) && ex.result.matched_surfaces.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap text-[12px] text-[var(--fg-4)]">
          <span>{t('explain.answered_using', { defaultValue: 'Answered using' })}:</span>
          {ex.result.matched_surfaces.map((s) => <span key={s} className="chip text-[10px] chip--accent">{SURFACE_LABEL[s] || s}</span>)}
        </div>
      )}
      <ArtifactView result={ex.result} loading={ex.loading} onRefresh={lastQ ? () => ask(lastQ, true) : undefined} />
      {ex.error && <div className="card--flat p-3 text-[13px] text-red-400">{ex.error}</div>}
      <IntelDisclaimer variant="block" />
    </div>
  )
}
