import React, { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { journalExitResult, isRecordedJournalExecution } from '../../lib/journal-exit'
import { localDateTimeValue } from '../../lib/portfolio-markers'

// Log a trade's exit + review it (research journal only). Computes realized P&L
// and R from the journaled entry/exit — no live execution.
const OUTCOMES = ['win', 'loss', 'breakeven', 'scratch']
const MISTAKES = ['no_plan', 'moved_stop', 'oversized', 'fomo_entry', 'early_exit', 'late_exit', 'revenge', 'ignored_thesis']

export default function TradeReviewForm({ trade, portfolioEvents = [], onSubmit, onCancel, busy }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const [f, setF] = useState({
    entry_price: trade?.entry_price ?? trade?.planned_entry ?? '', exit_price: '', fees_usd: '',
    outcome: '', followed_plan: '', what_went_well: '', what_went_wrong: '', lesson: '',
    would_take_again: '', matched_thesis: '', mistakes: [], exit_at: '', portfolio_event: '', exit_kind:'full', exit_percent:'',
  })
  const set = (p) => setF((s) => ({ ...s, ...p }))
  const pendingOperation = useRef(null)
  const [saveError, setSaveError] = useState(null)
  const toggleMistake = (m) => set({ mistakes: f.mistakes.includes(m) ? f.mistakes.filter((x) => x !== m) : [...f.mistakes, m] })
  const remaining=1-Number(trade?.exited_fraction || 0)
  const fraction=f.exit_kind==='full' ? remaining : Number(f.exit_percent)/100
  const executionEvents=portfolioEvents.filter(isRecordedJournalExecution)
  const selectedEvent=executionEvents.find(event=>`${event.sourceRef.kind}:${event.sourceRef.id}`===f.portfolio_event)
  const computed = useMemo(() => journalExitResult(trade,{entry:f.entry_price,exit:f.exit_price,fees:f.fees_usd||0,fraction}),[trade,f.entry_price,f.exit_price,f.fees_usd,fraction])

  const num = (v) => v === '' ? null : Number(v)
  const bool = (v) => v === '' ? null : v === 'yes'
  const submit = () => {
    const explicitExit = selectedEvent ? new Date(selectedEvent.t) : f.exit_at ? new Date(f.exit_at) : null
    if (explicitExit && !Number.isFinite(explicitExit.getTime())) { setSaveError(t('journal.trade.invalid_time', { defaultValue: 'Enter a valid exit time.' })); return }
    if (!Number.isFinite(fraction) || fraction<=0 || fraction>remaining || (f.exit_kind==='partial' && fraction>=remaining)) {setSaveError('Enter a portion smaller than the remaining original position, or choose full exit.');return}
    if (!Number.isFinite(Number(f.exit_price)) || Number(f.exit_price)<=0 || Number(f.fees_usd)<0) {setSaveError('Enter a positive exit price and non-negative fees.');return}
    if(f.portfolio_event && !selectedEvent) {setSaveError('This recorded execution is no longer available. Choose it again.');return}
    setSaveError(null)
    const linked = selectedEvent
    const signature = JSON.stringify(f)
    if (pendingOperation.current?.signature !== signature) pendingOperation.current = { signature, id: crypto.randomUUID(), closedAt: (explicitExit || (linked ? new Date(linked.t) : new Date())).toISOString() }
    return onSubmit({
      idempotency_key: pendingOperation.current.id,
      trade: {
        entry_price: num(f.entry_price), exit_price: num(f.exit_price), fees_usd: num(f.fees_usd),
        status: f.exit_kind==='partial' ? 'partially_closed' : 'closed', closed_at: pendingOperation.current.closedAt, exit_fraction:fraction,
        realized_pnl_usd: computed.pnlUsd, realized_pnl_pct: computed.pnlPct, r_multiple: computed.r,
        ...(linked ? { portfolio_id: linked.portfolioId, exit_portfolio_event_kind: linked.sourceRef.kind, exit_portfolio_event_id: linked.sourceRef.id } : {}),
      },
      review: {
        outcome: f.outcome || (computed.pnlUsd == null ? null : computed.pnlUsd > 0 ? 'win' : computed.pnlUsd < 0 ? 'loss' : 'breakeven'),
        followed_plan: bool(f.followed_plan), what_went_well: f.what_went_well || null, what_went_wrong: f.what_went_wrong || null,
        lesson: f.lesson || null, would_take_again: bool(f.would_take_again), matched_thesis: bool(f.matched_thesis), mistakes: f.mistakes,
      },
    })
  }

  const yesno = (k, label) => (
    <label className="block"><span className="text-[10px] text-[var(--fg-4)]">{label}</span>
      <select className="select w-full" value={f[k]} onChange={(e) => set({ [k]: e.target.value })}>
        <option value="">—</option><option value="yes">{t('journal.yes', { defaultValue: 'Yes' })}</option><option value="no">{t('journal.no', { defaultValue: 'No' })}</option>
      </select></label>
  )

  return (
    <div className="card--flat p-3 space-y-2">
      <div className="text-[12px] font-medium text-[var(--fg-1)]">{t('journal.trade.review_close', { defaultValue: 'Log exit & review' })}</div>
      {saveError && <p role="alert" className="text-[12px] text-red-400">{saveError}</p>}
      <div className="grid gap-3 sm:grid-cols-2"><label><span className="text-xs text-[var(--fg-4)]">Exit amount</span><select className="select w-full" value={f.exit_kind} onChange={event=>set({exit_kind:event.target.value})}><option value="full">Full remaining position</option><option value="partial">Partial exit</option></select></label>{f.exit_kind==='partial' && <label><span className="text-xs text-[var(--fg-4)]">Percent of original position</span><input className="input w-full" type="number" step="any" min="0" max={remaining*100} value={f.exit_percent} onChange={event=>set({exit_percent:event.target.value})}/></label>}</div>
      <p className="text-xs text-[var(--fg-4)]">{Number((remaining*100).toFixed(6))}% of this journal position remains. This review does not change portfolio holdings.</p>
      <label className="block"><span className="text-[11px] text-[var(--fg-4)]">{t('journal.trade.exit_time', { defaultValue: 'Exit time (optional, your timezone)' })}</span>
        <input type="datetime-local" className="input w-full" disabled={!!selectedEvent} value={f.exit_at} onInput={(event) => set({ exit_at: event.target.value })} onChange={(event) => set({ exit_at: event.target.value })} />
        <span className="text-[11px] text-[var(--fg-4)]">{selectedEvent ? `Recorded transaction time · ${Intl.DateTimeFormat().resolvedOptions().timeZone}` : t('journal.trade.exit_time_default', { defaultValue: 'Uses the current time when left blank.' })}</span></label>
      {portfolioEvents.length > 0 && <label className="block"><span className="text-[11px] text-[var(--fg-4)]">{t('journal.trade.link_exit', { defaultValue: 'Link recorded portfolio exit (optional)' })}</span>
        <select className="select w-full" value={f.portfolio_event} onChange={(event) => {const linked=executionEvents.find(item=>`${item.sourceRef.kind}:${item.sourceRef.id}`===event.target.value);set({portfolio_event:event.target.value,...(linked ? {exit_at:localDateTimeValue(new Date(linked.t)),exit_price:linked.executionPrice??'',fees_usd:linked.fee?.usd??''} : {})})}}>
          <option value="">{t('journal.trade.no_link', { defaultValue: 'Keep journal separate' })}</option>
          {executionEvents.map((event) => <option key={`${event.sourceRef.kind}:${event.sourceRef.id}`} value={`${event.sourceRef.kind}:${event.sourceRef.id}`}>{event.label} · {new Date(event.t).toLocaleString()}</option>)}
        </select></label>}
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="block"><span className="text-[10px] text-[var(--fg-4)]">{t('journal.trade.entry', { defaultValue: 'Entry' })}</span><input type="number" className="input w-full" value={f.entry_price} onChange={(e) => set({ entry_price: e.target.value })} /></label>
        <label className="block"><span className="text-[10px] text-[var(--fg-4)]">{t('journal.trade.exit', { defaultValue: 'Exit' })}</span><input type="number" className="input w-full" value={f.exit_price} onChange={(e) => set({ exit_price: e.target.value })} /></label>
        <label className="block"><span className="text-[10px] text-[var(--fg-4)]">{t('journal.trade.fees', { defaultValue: 'Fees (USD)' })}</span><input type="number" className="input w-full" value={f.fees_usd} onChange={(e) => set({ fees_usd: e.target.value })} /></label>
      </div>
      {computed.pnlPct != null && (
        <div className="text-[12px]">{t('journal.trade.pnl', { defaultValue: 'P&L' })}: <b className={computed.pnlPct >= 0 ? 'text-[var(--ok)]' : 'text-red-400'}>{computed.pnlPct >= 0 ? '+' : ''}{computed.pnlPct}%{computed.pnlUsd != null ? ` ($${computed.pnlUsd})` : ''}</b>{computed.r != null && <span className="text-[var(--fg-4)]"> · R {computed.r}</span>}</div>
      )}
      <div className="grid gap-2 sm:grid-cols-3">
        {yesno('followed_plan', t('journal.trade.followed', { defaultValue: 'Followed plan?' }))}
        {yesno('matched_thesis', t('journal.trade.matched', { defaultValue: 'Matched thesis?' }))}
        {yesno('would_take_again', t('journal.trade.again', { defaultValue: 'Take again?' }))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {MISTAKES.map((m) => <button key={m} onClick={() => toggleMistake(m)} className={`chip text-[10px] ${f.mistakes.includes(m) ? 'chip--err' : 'text-[var(--fg-4)]'}`}>{m.replace(/_/g, ' ')}</button>)}
      </div>
      <label className="block"><span className="text-xs text-[var(--fg-4)]">{t('journal.trade.lesson', { defaultValue: 'Lesson learned' })}</span><textarea className="textarea w-full" rows={2} placeholder={t('journal.trade.lesson', { defaultValue: 'Lesson learned' })} value={f.lesson} onChange={(e) => set({ lesson: e.target.value })} /></label>
      <div className="flex justify-end gap-2">
        {onCancel && <button onClick={onCancel} className="btn btn--quiet btn--sm">{t('journal.cancel', { defaultValue: 'Cancel' })}</button>}
        <button onClick={submit} disabled={busy} className="btn btn--primary btn--sm disabled:opacity-50">{t('journal.trade.save_review', { defaultValue: 'Save review' })}</button>
      </div>
    </div>
  )
}
