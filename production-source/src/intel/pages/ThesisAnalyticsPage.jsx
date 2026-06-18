import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BarChart3 } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import { getThesisAnalytics, getTradeAnalytics } from '../lib/thesis-api'
import TradeAnalyticsPanel from '../components/thesis/TradeAnalyticsPanel'
import PortfolioThesisInsights from '../components/thesis/PortfolioThesisInsights'
import ThesisStatusBadge from '../components/thesis/ThesisStatusBadge'
import IntelDisclaimer from '../components/IntelDisclaimer'

const Stat = ({ label, value, tone }) => (
  <div className="card p-3"><div className="text-[11px] text-[var(--fg-4)]">{label}</div><div className={`text-lg font-semibold ${tone || 'text-[var(--fg-1)]'}`}>{value ?? '—'}</div></div>
)

export default function ThesisAnalyticsPage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase } = useSupabase()
  const [th, setTh] = useState({ loading: true, data: null })
  const [tr, setTr] = useState({ loading: true, data: null })
  const [portfolioId, setPortfolioId] = useState(null)

  const load = useCallback(async () => {
    if (!org?.id) return
    getThesisAnalytics(supabase).then((d) => setTh({ loading: false, data: d })).catch(() => setTh({ loading: false, data: null }))
    getTradeAnalytics(supabase, {}).then((d) => setTr({ loading: false, data: d })).catch(() => setTr({ loading: false, data: null }))
    try {
      const { data } = await supabase.from('investor_portfolios').select('id, is_default').order('is_default', { ascending: false }).limit(1).maybeSingle()
      if (data?.id) setPortfolioId(data.id)
    } catch { /* no portfolio */ }
  }, [org?.id, supabase])
  useEffect(() => { load() }, [load])

  const a = th.data || {}
  const statusEntries = Object.entries(a.count_by_status || {})
  const winloss = Object.entries(a.winloss_by_stance || {})

  return (
    <div className="space-y-5">
      <div>
        <div className="eyebrow flex items-center gap-1.5"><BarChart3 className="h-3.5 w-3.5" /> {t('journal.brand', { defaultValue: 'Thesis Journal' })}</div>
        <h1 className="page-title">{t('journal.nav.analytics', { defaultValue: 'Analytics' })}</h1>
      </div>

      {/* Thesis analytics */}
      <div className="space-y-3">
        <div className="eyebrow">{t('journal.thesis_analytics', { defaultValue: 'Thesis analytics' })}</div>
        {th.loading ? <div className="card p-6 grid place-items-center"><div className="animate-spin rounded-full h-5 w-5 border-b-2 border-[var(--accent)]" /></div> : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Stat label={t('journal.total', { defaultValue: 'Total' })} value={statusEntries.reduce((s, [, n]) => s + n, 0)} />
              <Stat label={t('journal.status.needs_review', { defaultValue: 'Needs review' })} value={a.needs_review} tone={a.needs_review > 0 ? 'text-amber-300' : undefined} />
              <Stat label={t('journal.avg_conviction', { defaultValue: 'Avg conviction' })} value={a.avg_conviction != null ? `${Math.round(a.avg_conviction * 5 * 10) / 10}/5` : '—'} />
              <Stat label={t('journal.avg_quality', { defaultValue: 'Avg quality' })} value={a.avg_quality != null ? `${a.avg_quality}/100` : '—'} />
            </div>
            {statusEntries.length > 0 && (
              <div className="card p-3"><div className="eyebrow mb-2">{t('journal.by_status', { defaultValue: 'By status' })}</div>
                <div className="flex flex-wrap gap-2">{statusEntries.map(([s, n]) => <span key={s} className="inline-flex items-center gap-1"><ThesisStatusBadge status={s} /> <b className="text-[12px]">{n}</b></span>)}</div></div>
            )}
            {winloss.length > 0 && (
              <div className="card p-3"><div className="eyebrow mb-2">{t('journal.winloss_stance', { defaultValue: 'Win / loss by stance' })}</div>
                <div className="flex flex-wrap gap-3 text-[12px]">{winloss.map(([s, v]) => <span key={s}>{s}: <span className="text-[var(--ok)]">{v.wins || 0}W</span> / <span className="text-red-400">{v.losses || 0}L</span></span>)}</div></div>
            )}
            <div className="flex flex-wrap gap-2 text-[11px]">
              {a.rule_violations > 0 && <span className="chip chip--err">{a.rule_violations} {t('journal.rule_violations', { defaultValue: 'invalidations triggered' })}</span>}
              {a.trades_without_thesis > 0 && <span className="chip text-amber-300">{a.trades_without_thesis} {t('journal.trade.without_thesis', { defaultValue: 'trades without thesis' })}</span>}
            </div>
          </>
        )}
      </div>

      {/* Trade analytics */}
      <TradeAnalyticsPanel analytics={tr.data} loading={tr.loading} />

      {/* Portfolio conflicts */}
      <PortfolioThesisInsights supabase={supabase} portfolioId={portfolioId} />

      <IntelDisclaimer variant="block" />
    </div>
  )
}
