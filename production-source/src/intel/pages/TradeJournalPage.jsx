import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react'
import { useSearchParams } from 'react-router'
import { useTranslation } from 'react-i18next'
import { LineChart, Info, Plus } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import {
  listTrades, listTheses, createTradePlan, closeTradeWithReview, deleteTrade, getTradeAnalytics,
} from '../lib/thesis-api'
import { useAssetPortfolioContext } from '../lib/useAssetPortfolioContext'
import { canonicalPortfolioKey } from '../lib/asset-identity'
import TradePlanForm from '../components/thesis/TradePlanForm'
import TradeCard from '../components/thesis/TradeCard'
import TradeAnalyticsPanel from '../components/thesis/TradeAnalyticsPanel'
import IntelErrorNotice from '../components/IntelErrorNotice'

export default function TradeJournalPage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase, user } = useSupabase()
  const [sp] = useSearchParams()
  const [tradeRows, setTrades] = useState([])
  const [thesisRows, setTheses] = useState([])
  const [analytics, setAnalytics] = useState({ loading: true, data: null })
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [activityTo] = useState(Date.now)
  const [activityKey, setActivityKey] = useState(sp.get('asset') || '')
  const assetParam = sp.get('asset') || ''
  useEffect(() => setActivityKey(assetParam), [assetParam])
  const scope = `${org?.id || ''}:${user?.id || ''}`
  const active = useRef(scope); active.current = scope
  const sequence = useRef(0)
  const [loadedScope, setLoadedScope] = useState(null)
  const trades = loadedScope === scope ? tradeRows : [], theses = loadedScope === scope ? thesisRows : []
  const linkedActivity = useAssetPortfolioContext({ canonicalAssetKey: canonicalPortfolioKey(activityKey), from: activityTo - 365 * 86400000, to: activityTo })

  const thesisTitles = useMemo(() => Object.fromEntries(theses.map((th) => [th.id, th.title])), [theses])

  const load = useCallback(async () => {
    if (!org?.id || !user?.id) return
    const seq = ++sequence.current
    setLoading(true); setErr(null)
    setAnalytics({ scope, loading: true, data: null })
    const isCurrent = () => active.current === scope && sequence.current === seq
    getTradeAnalytics(supabase, {}).then((data) => { if (isCurrent()) setAnalytics({ scope, loading: false, data }) }).catch(() => { if (isCurrent()) setAnalytics({ scope, loading: false, data: null }) })
    try {
      const [tr, th] = await Promise.all([listTrades(supabase, org.id), listTheses(supabase, org.id)])
      if (isCurrent()) { setTrades(tr); setTheses(th); setLoadedScope(scope) }
    } catch (e) { if (isCurrent()) setErr(e.message) } finally { if (isCurrent()) setLoading(false) }
  }, [org?.id, user?.id, supabase, scope])
  useEffect(() => { setBusy(false); setShowForm(false); load(); return () => { sequence.current++ } }, [load])

  const onSavePlan = useCallback(async (plan) => {
    setBusy(true); setErr(null)
    try { await createTradePlan(supabase, org.id, user?.id, plan); if (active.current === scope) { setShowForm(false); await load() } }
    catch (e) { if (active.current === scope) setErr(e.message); return false } finally { if (active.current === scope) setBusy(false) }
  }, [supabase, org?.id, user?.id, load, scope])

  const onClose = useCallback(async (tradeId, payload) => {
    setBusy(true); setErr(null)
    try {
      await closeTradeWithReview(supabase, org.id, tradeId, payload)
      if (active.current !== scope) return false
      await load()
      return true
    } catch (e) { if (active.current === scope) setErr(e.message); return false } finally { if (active.current === scope) setBusy(false) }
  }, [supabase, org?.id, user?.id, load, scope])

  const onDelete = useCallback(async (id) => {
    setBusy(true)
    try { await deleteTrade(supabase, id); if (active.current === scope) await load() } catch (e) { if (active.current === scope) setErr(e.message) } finally { if (active.current === scope) setBusy(false) }
  }, [supabase, load, scope])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="eyebrow flex items-center gap-1.5"><LineChart className="h-3.5 w-3.5" /> {t('journal.brand', { defaultValue: 'Thesis Journal' })}</div>
          <h1 className="page-title">{t('journal.nav.trades', { defaultValue: 'Trades' })}</h1>
        </div>
        <button onClick={() => setShowForm((s) => !s)} className="btn btn--primary btn--sm"><Plus className="h-4 w-4" /> {t('journal.trade.new_plan', { defaultValue: 'New trade plan' })}</button>
      </div>

      <div className="card--flat p-3 text-[12px] text-[var(--fg-3)] flex items-center gap-2">
        <Info className="h-4 w-4 text-[var(--fg-4)] shrink-0" />
        {t('journal.trades_no_exec', { defaultValue: 'Trade Journal is for planning and review only. Investor Intel does not execute trades.' })}
      </div>

      {err && <IntelErrorNotice error={err} />}
      <div className="flex gap-3 items-center flex-wrap text-xs"><label>{t('journal.trade.link_asset', { defaultValue: 'Portfolio activity for' })}<select className="select ml-3" value={activityKey} onChange={e => setActivityKey(e.target.value)}><option value="">{t('journal.trade.no_link_asset', { defaultValue: 'Choose a linked asset' })}</option>{[...new Map([...theses, ...trades].filter(x => x.subject_canonical_key).map(x => [x.subject_canonical_key, x.title || x.symbol])).entries()].map(([key,label]) => <option key={key} value={key}>{label}</option>)}{sp.get('asset') && <option value={sp.get('asset')}>{sp.get('asset')}</option>}</select></label>{linkedActivity.nextCursor && <button className="underline" onClick={linkedActivity.loadMore}>{t('journal.trade.more_activity', { defaultValue: 'Load older activity' })}</button>}</div>
      {showForm && <TradePlanForm portfolioEvents={linkedActivity.markers} theses={theses} defaultThesisId={sp.get('thesis')} onSave={onSavePlan} onCancel={() => setShowForm(false)} busy={busy} />}

      <TradeAnalyticsPanel analytics={analytics.scope === scope ? analytics.data : null} loading={analytics.scope !== scope || analytics.loading} />

      {loading ? (
        <div className="card p-8 grid place-items-center"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--accent)]" /></div>
      ) : loadedScope !== scope ? null : trades.length === 0 ? (
        <div className="card p-6 text-center text-[13px] text-[var(--fg-4)]">{t('journal.trade.empty', { defaultValue: 'No trades yet. Plan one above and link it to a thesis to keep your reasoning and execution aligned.' })}</div>
      ) : (
        <div className="space-y-2">
          {trades.map((tr) => <TradeCard portfolioEvents={linkedActivity.markers.filter(event => event.canonicalAssetKey === canonicalPortfolioKey(tr.subject_canonical_key || theses.find(th => th.id === tr.thesis_id)?.subject_canonical_key))} key={tr.id} trade={tr} thesisTitle={thesisTitles[tr.thesis_id]} onClose={onClose} onDelete={onDelete} busy={busy} />)}
        </div>
      )}
    </div>
  )
}
