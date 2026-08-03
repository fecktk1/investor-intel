import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { useTranslation } from 'react-i18next'
import { LineChart, Info, Plus } from 'lucide-react'
import { useProfile } from '../../lib/profile-context'
import { useSupabase } from '../../lib/useSupabase'
import {
  listTrades, listTheses, createTradePlan, updateTrade, deleteTrade, createTradeReview, getTradeAnalytics,
} from '../lib/thesis-api'
import TradePlanForm from '../components/thesis/TradePlanForm'
import TradeCard from '../components/thesis/TradeCard'
import TradeAnalyticsPanel from '../components/thesis/TradeAnalyticsPanel'
import IntelErrorNotice from '../components/IntelErrorNotice'

export default function TradeJournalPage() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { org } = useProfile()
  const { supabase, user } = useSupabase()
  const [sp] = useSearchParams()
  const [trades, setTrades] = useState([])
  const [theses, setTheses] = useState([])
  const [analytics, setAnalytics] = useState({ loading: true, data: null })
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  const thesisTitles = useMemo(() => Object.fromEntries(theses.map((th) => [th.id, th.title])), [theses])

  const load = useCallback(async () => {
    if (!org?.id) return
    setLoading(true); setErr(null)
    try {
      const [tr, th] = await Promise.all([listTrades(supabase, org.id), listTheses(supabase, org.id)])
      setTrades(tr); setTheses(th)
    } catch (e) { setErr(e.message) } finally { setLoading(false) }
    getTradeAnalytics(supabase, {}).then((d) => setAnalytics({ loading: false, data: d })).catch(() => setAnalytics({ loading: false, data: null }))
  }, [org?.id, supabase])
  useEffect(() => { load() }, [load])

  const onSavePlan = useCallback(async (plan) => {
    setBusy(true); setErr(null)
    try { await createTradePlan(supabase, org.id, user?.id, plan); setShowForm(false); await load() }
    catch (e) { setErr(e.message) } finally { setBusy(false) }
  }, [supabase, org?.id, user?.id, load])

  const onClose = useCallback(async (tradeId, { trade, review }) => {
    setBusy(true); setErr(null)
    try {
      await updateTrade(supabase, tradeId, trade)
      await createTradeReview(supabase, org.id, user?.id, tradeId, review)
      await load()
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }, [supabase, org?.id, user?.id, load])

  const onDelete = useCallback(async (id) => {
    setBusy(true)
    try { await deleteTrade(supabase, id); await load() } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }, [supabase, load])

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
      {showForm && <TradePlanForm theses={theses} defaultThesisId={sp.get('thesis')} onSave={onSavePlan} onCancel={() => setShowForm(false)} busy={busy} />}

      <TradeAnalyticsPanel analytics={analytics.data} loading={analytics.loading} />

      {loading ? (
        <div className="card p-8 grid place-items-center"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--accent)]" /></div>
      ) : trades.length === 0 ? (
        <div className="card p-6 text-center text-[13px] text-[var(--fg-4)]">{t('journal.trade.empty', { defaultValue: 'No trades yet. Plan one above — link it to a thesis to keep your reasoning and execution aligned.' })}</div>
      ) : (
        <div className="space-y-2">
          {trades.map((tr) => <TradeCard key={tr.id} trade={tr} thesisTitle={thesisTitles[tr.thesis_id]} onClose={onClose} onDelete={onDelete} busy={busy} />)}
        </div>
      )}
    </div>
  )
}
