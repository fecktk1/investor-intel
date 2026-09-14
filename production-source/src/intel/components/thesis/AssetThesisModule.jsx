import React, { useEffect, useState, useRef, useCallback } from 'react'
import { Link, useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { NotebookPen, ArrowRight } from 'lucide-react'
import { useProfile } from '../../../lib/profile-context'
import { useSupabase } from '../../../lib/useSupabase'
import { THESIS_JOURNAL_ENABLED } from '../../lib/flags'
import ThesisStatusBadge from './ThesisStatusBadge'
import { listAssetTheses } from '../../lib/thesis-api'
import { intelReadError } from '../../lib/read-error'
import { appendHistoryPage } from '../../lib/history-page'
import { portfolioAssetChartRef } from '../../lib/portfolio-markers'
import ThesisBoundary from './ThesisBoundary'

// Asset-page Thesis Journal module. Replaces the old ThesisDriftCard: shows the
// user's thesis for this asset (status, conviction, quality, review cadence) with
// quick actions, or an entry point to create one. Personal — RLS scopes the read.
const STANCE_CLS = { bullish: 'text-[var(--ok)]', bearish: 'text-red-400', neutral: 'text-[var(--fg-3)]' }
const fmtDate = (d) => d ? new Date(d).toLocaleDateString() : '—'

function AssetThesisModuleInner({ symbol, chain, canonicalAssetKey, entityId, providerId, sourceProvider }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase, user } = useSupabase()
  const navigate = useNavigate()
  const [state, setState] = useState({ scope: null, rows: [], loading: true, error: null, nextCursor: null })
  const scope = `${user?.id}:${org?.id}:${canonicalAssetKey}:${entityId}`
  const theses = state.scope === scope ? state.rows : []
  const active = useRef(scope); active.current = scope
  const sequence = useRef(0)
  const load = useCallback(async (cursor = null) => {
    if (!THESIS_JOURNAL_ENABLED || !org?.id || !user?.id || (!canonicalAssetKey && !entityId)) return
    const seq = ++sequence.current
    setState(previous => ({ ...previous, scope, rows: previous.scope === scope ? previous.rows : [], loading: true, error: null }))
    try {
      const page = await listAssetTheses(supabase, org.id, { canonicalKey: canonicalAssetKey, entityId, cursor })
      if (active.current !== scope || sequence.current !== seq) return
      setState(previous => ({ scope, rows: cursor ? appendHistoryPage(previous.rows, page.rows) : page.rows, loading: false, error: null, nextCursor: page.nextCursor }))
    } catch (e) { if (active.current === scope && sequence.current === seq) setState(previous => ({ ...previous, loading: false, error: intelReadError(e, 'Your asset theses are temporarily unavailable.') })) }
  }, [org?.id, user?.id, canonicalAssetKey, entityId, scope, supabase])

  useEffect(() => {
    load()
    const changed = event => { if (event.detail?.orgId === org?.id) load() }
    window.addEventListener('intel:thesis-activity-changed', changed)
    return () => { sequence.current++; window.removeEventListener('intel:thesis-activity-changed', changed) }
  }, [load, org?.id])

  if (!THESIS_JOURNAL_ENABLED || theses == null) return null
  if (!canonicalAssetKey && !entityId) return <p className="text-sm text-[var(--fg-4)]">Resolve an exact asset to load your theses.</p>
  if (state.scope !== scope || (state.loading && !theses.length)) return <p className="text-sm text-[var(--fg-4)]" role="status">Loading your theses…</p>
  if (state.error) return <div role="alert" className="text-sm text-[var(--fg-4)]">{state.error} <button className="btn btn--quiet btn--sm" onClick={() => load()}>Retry</button> <Link className="underline underline-offset-4" to="/intel/theses/list">Open Thesis Journal</Link></div>
  const chartIdentity = portfolioAssetChartRef(canonicalAssetKey)
  const value = chartIdentity && !chartIdentity.native ? chartIdentity.ref.slice(chartIdentity.ref.indexOf(':') + 1) : symbol
  const prefill = (extra = {}) => navigate('/intel/theses/new', { state: { prefill: { source: 'market', chain: chartIdentity?.chain || chain, value, symbol, canonicalKey: canonicalAssetKey, entityId, sourceProvider, providerId, ...extra } } })

  if (theses.length === 0) {
    return (
      <section className="card p-4 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2"><NotebookPen className="h-4 w-4 text-[var(--accent)]" /><span className="text-[13px] text-[var(--fg-2)]">{t('journal.asset_none_current', { defaultValue: 'No unarchived thesis on this asset.' })} <Link className="intel-text-link" to="/intel/theses/list?status=archived">View archived research</Link></span></div>
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
      {theses.map((th) => (
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
            <Link to={`/intel/theses/trades?thesis=${th.id}&asset=${encodeURIComponent(canonicalAssetKey || "")}`} className="chip text-[11px]">{t('journal.trade_plan', { defaultValue: 'Trade plan' })}</Link>
          </div>
        </div>
      ))}
      {state.nextCursor && <button className="btn btn--quiet btn--sm" disabled={state.loading} onClick={() => load(state.nextCursor)}>{state.loading ? 'Loading…' : 'Load more theses'}</button>}
    </section>
  )
}

export default function AssetThesisModule(props) {
  return <ThesisBoundary><AssetThesisModuleInner {...props} /></ThesisBoundary>
}
