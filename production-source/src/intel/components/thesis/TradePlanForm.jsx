import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CHAINS } from '../../lib/chains'
import { canonicalPortfolioKey } from '../../lib/asset-identity'
import { portfolioAssetChartRef } from '../../lib/portfolio-markers'
import { isRecordedJournalExecution } from '../../lib/journal-exit'

// Plan a trade (research journal only — never executes). Copy uses "Save plan",
// never "place/execute/submit order".
const DIRECTIONS = ['long', 'short', 'spot_accumulate', 'spot_reduce']
const EMOTIONS = ['calm', 'confident', 'fomo', 'fearful', 'revenge', 'bored']

export default function TradePlanForm({ theses = [], defaultThesisId = null, portfolioEvents = [], onSave, onCancel, busy }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const [f, setF] = useState({
    thesis_id: defaultThesisId || '', symbol: '', chain: 'solana', direction: 'long', trade_type: '', setup: '',
    planned_entry: '', planned_stop: '', target1: '', target2: '', target3: '',
    planned_size_usd: '', risk_amount: '', time_stop: '', invalidation_reason: '', pre_notes: '', emotion: '', tags: '', portfolio_event: '',
  })
  const set = (p) => setF((s) => ({ ...s, ...p }))
  const thesisKey=canonicalPortfolioKey(theses.find(th=>th.id===f.thesis_id)?.subject_canonical_key)
  const executionEvents=portfolioEvents.filter(event=>isRecordedJournalExecution(event) && (!thesisKey || event.canonicalAssetKey===thesisKey))

  const rPlanned = useMemo(() => {
    const e = Number(f.planned_entry), s = Number(f.planned_stop), tg = Number(f.target1)
    if (!e || !s || !tg || e === s) return null
    const risk = Math.abs(e - s), reward = Math.abs(tg - e)
    return risk ? Math.round((reward / risk) * 100) / 100 : null
  }, [f.planned_entry, f.planned_stop, f.target1])

  const num = (v) => v === '' ? null : Number(v)
  const submit = () => {
    if (!f.symbol.trim()) return
    const linked = executionEvents.find((event) => `${event.sourceRef?.kind}:${event.sourceRef?.id}` === f.portfolio_event)
    if (f.portfolio_event && !linked) return
    const canonicalKey=linked?.canonicalAssetKey || thesisKey
    const chain=portfolioAssetChartRef(canonicalKey)?.chain || f.chain
    onSave({
      thesis_id: f.thesis_id || null, symbol: linked?.tokenSymbol || f.symbol.trim().toUpperCase(), chain, direction: f.direction,
      ...(canonicalKey ? {subject_canonical_key:canonicalKey} : {}),
      trade_type: f.trade_type || null, setup: f.setup || null, status: 'planned',
      planned_entry: num(f.planned_entry), planned_stop: num(f.planned_stop),
      target1: num(f.target1), target2: num(f.target2), target3: num(f.target3),
      planned_size_usd: num(f.planned_size_usd), risk_amount: num(f.risk_amount), r_planned: rPlanned,
      time_stop: f.time_stop || null, invalidation_reason: f.invalidation_reason || null,
      pre_notes: f.pre_notes || null, emotion: f.emotion || null,
      tags: f.tags ? f.tags.split(',').map((x) => x.trim()).filter(Boolean) : [],
      ...(linked ? { portfolio_id: linked.portfolioId, entry_portfolio_event_kind: linked.sourceRef.kind, entry_portfolio_event_id: linked.sourceRef.id,
        subject_canonical_key: linked.canonicalAssetKey,
        status: 'open', opened_at: new Date(linked.t).toISOString(), entry_price: linked.executionPrice ?? null, size_usd: linked.executionValue ?? null } : {}),
    })
  }

  const field = (k, label, type = 'text') => (
    <label className="block"><span className="text-[10px] text-[var(--fg-4)]">{label}</span>
      <input type={type} className="input w-full" value={f[k]} onChange={(e) => set({ [k]: e.target.value })} /></label>
  )

  return (
    <div className="card p-4 space-y-3">
      <div className="text-[13px] font-medium text-[var(--fg-1)]">{t('journal.trade.new_plan', { defaultValue: 'New trade plan' })}</div>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="block"><span className="text-[10px] text-[var(--fg-4)]">{t('journal.trade.thesis', { defaultValue: 'Link thesis (optional)' })}</span>
          <select className="select w-full" value={f.thesis_id} onChange={(e) => set({ thesis_id: e.target.value, portfolio_event:'' })}>
            <option value="">{t('journal.trade.no_thesis', { defaultValue: 'No thesis' })}</option>
            {theses.map((th) => <option key={th.id} value={th.id}>{th.title}</option>)}
          </select>
        </label>
        {field('symbol', t('journal.trade.symbol', { defaultValue: 'Symbol' }))}
        <label><span className="text-xs text-[var(--fg-4)]">{t('portfolio.cols.chain',{defaultValue:'Chain'})}</span><select className="select w-full" value={portfolioAssetChartRef(thesisKey)?.chain || f.chain} disabled={!!thesisKey || !!f.portfolio_event} onChange={event=>set({chain:event.target.value})}>{CHAINS.map(chain=><option key={chain.id} value={chain.id}>{chain.label}</option>)}</select></label>
        <label className="block"><span className="text-[10px] text-[var(--fg-4)]">{t('journal.trade.direction', { defaultValue: 'Direction' })}</span>
          <select className="select w-full" value={f.direction} onChange={(e) => set({ direction: e.target.value })}>{DIRECTIONS.map((d) => <option key={d} value={d}>{d.replace(/_/g, ' ')}</option>)}</select></label>
        {field('trade_type', t('journal.trade.type', { defaultValue: 'Type (breakout, swing…)' }))}
        {field('setup', t('journal.trade.setup', { defaultValue: 'Setup' }))}
        {field('planned_size_usd', t('journal.trade.size', { defaultValue: 'Size (USD)' }), 'number')}
        {field('planned_entry', t('journal.trade.entry', { defaultValue: 'Entry' }), 'number')}
        {field('planned_stop', t('journal.trade.stop', { defaultValue: 'Stop' }), 'number')}
        {field('target1', t('journal.trade.t1', { defaultValue: 'Target 1' }), 'number')}
        {field('target2', t('journal.trade.t2', { defaultValue: 'Target 2' }), 'number')}
        {field('target3', t('journal.trade.t3', { defaultValue: 'Target 3' }), 'number')}
        {field('risk_amount', t('journal.trade.risk', { defaultValue: 'Risk amount (USD)' }), 'number')}
        {field('time_stop', t('journal.trade.time_stop', { defaultValue: 'Time stop' }))}
        {field('emotion', t('journal.trade.emotion', { defaultValue: 'Emotion' }))}
      </div>
      {portfolioEvents.length > 0 && <label className="block"><span className="text-[11px] text-[var(--fg-4)]">{t('journal.trade.link_entry', { defaultValue: 'Link recorded portfolio entry (optional)' })}</span>
        <select className="select w-full" value={f.portfolio_event} onChange={(event) => {const linked=executionEvents.find(item=>`${item.sourceRef.kind}:${item.sourceRef.id}`===event.target.value);set({portfolio_event:event.target.value,...(linked ? {symbol:linked.tokenSymbol||f.symbol,chain:portfolioAssetChartRef(linked.canonicalAssetKey)?.chain||f.chain} : {})})}}>
          <option value="">{t('journal.trade.no_link', { defaultValue: 'Keep journal separate' })}</option>
          {executionEvents.map((event) => <option key={`${event.sourceRef.kind}:${event.sourceRef.id}`} value={`${event.sourceRef.kind}:${event.sourceRef.id}`}>{event.label} · {new Date(event.t).toLocaleString()}</option>)}
        </select></label>}
      {rPlanned != null && <div className="text-[11px] text-[var(--fg-3)]">{t('journal.trade.rr', { defaultValue: 'Planned R:R' })}: <b>{rPlanned}</b></div>}
      <label className="block"><span className="text-[10px] text-[var(--fg-4)]">{t('journal.trade.invalidation', { defaultValue: 'Invalidation reason' })}</span>
        <input className="input w-full" value={f.invalidation_reason} onChange={(e) => set({ invalidation_reason: e.target.value })} /></label>
      <label className="block"><span className="text-[10px] text-[var(--fg-4)]">{t('journal.trade.pre_notes', { defaultValue: 'Pre-trade notes' })}</span>
        <textarea className="textarea w-full" rows={2} value={f.pre_notes} onChange={(e) => set({ pre_notes: e.target.value })} /></label>
      <div className="flex justify-end gap-2">
        {onCancel && <button onClick={onCancel} className="btn btn--quiet btn--sm">{t('journal.cancel', { defaultValue: 'Cancel' })}</button>}
        <button onClick={submit} disabled={busy || !f.symbol.trim()} className="btn btn--primary btn--sm disabled:opacity-50">{f.portfolio_event ? t('journal.trade.save_entry', { defaultValue: 'Save journal entry' }) : t('journal.trade.save_plan', { defaultValue: 'Save plan' })}</button>
      </div>
    </div>
  )
}
