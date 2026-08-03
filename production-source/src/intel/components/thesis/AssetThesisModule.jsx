import React, { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { NotebookPen, ArrowRight } from 'lucide-react'
import { useProfile } from '../../../lib/profile-context'
import { useSupabase } from '../../../lib/useSupabase'
import { THESIS_JOURNAL_ENABLED } from '../../lib/flags'
import ThesisStatusBadge from './ThesisStatusBadge'
import ThesisBoundary from './ThesisBoundary'

// Asset-page Thesis Journal module. Replaces the old ThesisDriftCard: shows the
// user's thesis for this asset (status, conviction, quality, review cadence) with
// quick actions, or an entry point to create one. Personal — RLS scopes the read.
const STANCE_CLS = { bullish: 'text-[var(--ok)]', bearish: 'text-red-400', neutral: 'text-[var(--fg-3)]' }
const fmtDate = (d) => d ? new Date(d).toLocaleDateString() : '—'

function AssetThesisModuleInner({ symbol, chain }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase } = useSupabase()
  const navigate = useNavigate()
  const [theses, setTheses] = useState(null)

  useEffect(() => {
    let alive = true
    if (!THESIS_JOURNAL_ENABLED || !org?.id || !symbol) { setTheses([]); return }
    ;(async () => {
      try {
        const { data } = await supabase.from('intel_theses')
          .select('id, title, stance, status, conviction, quality_score, created_at, last_reviewed_at, next_review_at, needs_user_review, engine_suggested_status, subject_canonical_key, entity:entities(display_symbol, native_symbol)')
          .eq('org_id', org.id).neq('status', 'archived')
        const sym = String(symbol).toUpperCase().replace(/^\$/, '')
        const keySym = (k) => String(k || '').split(/[:/]/).pop().toUpperCase()
        if (alive) setTheses((data || []).filter((th) =>
          String(th.entity?.display_symbol || '').toUpperCase() === sym ||
          String(th.entity?.native_symbol || '').toUpperCase() === sym ||
          keySym(th.subject_canonical_key) === sym))
      } catch { if (alive) setTheses([]) }
    })()
    return () => { alive = false }
  }, [org?.id, supabase, symbol])

  if (!THESIS_JOURNAL_ENABLED || theses == null) return null
  const prefill = (extra = {}) => navigate('/intel/theses/new', { state: { prefill: { source: 'market', chain, value: symbol, ...extra } } })

  if (theses.length === 0) {
    return (
      <section className="card p-4 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2"><NotebookPen className="h-4 w-4 text-[var(--accent)]" /><span className="text-[13px] text-[var(--fg-2)]">{t('journal.asset_none', { defaultValue: 'No thesis on this asset yet.' })}</span></div>
        <div className="flex items-center gap-1.5">
          <button onClick={() => prefill()} className="btn btn--primary btn--sm">{t('journal.create_thesis', { defaultValue: 'Create thesis' })}</button>
          <button onClick={() => prefill({ stance: 'bearish', thesisType: 'bear_case' })} className="btn btn--quiet btn--sm">{t('journal.create_bear', { defaultValue: 'Bear case' })}</button>
        </div>
      </section>
    )
  }

  return (
    <section className="card p-4 space-y-2">
      <div className="flex items-center justify-between">
        <div className="eyebrow flex items-center gap-1.5"><NotebookPen className="h-3.5 w-3.5" /> {t('journal.your_thesis', { defaultValue: 'Your thesis on this asset' })}</div>
        <Link to="/intel/theses/list" className="text-[12px] text-[var(--accent)] flex items-center gap-1">{t('journal.brand', { defaultValue: 'Thesis Journal' })} <ArrowRight className="h-3 w-3" /></Link>
      </div>
      {theses.slice(0, 2).map((th) => (
        <div key={th.id} className="card--flat p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Link to={`/intel/theses/${th.id}`} className="text-[13px] font-medium text-[var(--fg-1)] hover:text-[var(--accent)]">{th.title}</Link>
            <div className="flex items-center gap-1.5">
              {th.needs_user_review && <span className="chip text-[10px] text-amber-300">{t('journal.review_due', { defaultValue: 'Review' })}</span>}
              <ThesisStatusBadge status={th.status} />
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap text-[11px] text-[var(--fg-4)]">
            <span className={STANCE_CLS[th.stance] || ''}>{th.stance}</span>
            {th.conviction != null && <span>· {Math.round(th.conviction * 5)}/5</span>}
            {typeof th.quality_score === 'number' && <span>· {t('journal.quality', { defaultValue: 'Quality' })} {th.quality_score}</span>}
            <span>· {t('journal.next_review', { defaultValue: 'Next review' })} {fmtDate(th.next_review_at)}</span>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <Link to={`/intel/theses/${th.id}?tab=reviews`} className="chip text-[11px]">{t('journal.review', { defaultValue: 'Review' })}</Link>
            <Link to={`/intel/theses/${th.id}?tab=evidence`} className="chip text-[11px]">{t('journal.add_evidence', { defaultValue: 'Evidence' })}</Link>
            <Link to={`/intel/theses/trades?thesis=${th.id}`} className="chip text-[11px]">{t('journal.trade_plan', { defaultValue: 'Trade plan' })}</Link>
          </div>
        </div>
      ))}
    </section>
  )
}

export default function AssetThesisModule(props) {
  return <ThesisBoundary><AssetThesisModuleInner {...props} /></ThesisBoundary>
}
