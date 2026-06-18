import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

// Log a trade's exit + review it (research journal only). Computes realized P&L
// and R from the journaled entry/exit — no live execution.
const OUTCOMES = ['win', 'loss', 'breakeven', 'scratch']
const MISTAKES = ['no_plan', 'moved_stop', 'oversized', 'fomo_entry', 'early_exit', 'late_exit', 'revenge', 'ignored_thesis']

export default function TradeReviewForm({ trade, onSubmit, onCancel, busy }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const [f, setF] = useState({
    entry_price: trade?.entry_price ?? trade?.planned_entry ?? '', exit_price: '', fees_usd: '',
    outcome: '', followed_plan: '', what_went_well: '', what_went_wrong: '', lesson: '',
    would_take_again: '', matched_thesis: '', mistakes: [],
  })
  const set = (p) => setF((s) => ({ ...s, ...p }))
  const toggleMistake = (m) => set({ mistakes: f.mistakes.includes(m) ? f.mistakes.filter((x) => x !== m) : [...f.mistakes, m] })

  const computed = useMemo(() => {
    const e = Number(f.entry_price), x = Number(f.exit_price), size = Number(trade?.planned_size_usd || trade?.size_usd || 0)
    const stop = Number(trade?.planned_stop || 0)
    if (!e || !x) return { pnlPct: null, pnlUsd: null, r: null }
    const short = ['short', 'spot_reduce'].includes(trade?.direction)
    const pnlPct = ((short ? (e - x) : (x - e)) / e) * 100
    const pnlUsd = size ? (size * pnlPct) / 100 : null
    const r = (e && stop && e !== stop) ? Math.round(((short ? (e - x) : (x - e)) / Math.abs(e - stop)) * 100) / 100 : null
    return { pnlPct: Math.round(pnlPct * 100) / 100, pnlUsd: pnlUsd != null ? Math.round(pnlUsd * 100) / 100 : null, r }
  }, [f.entry_price, f.exit_price, trade])

  const num = (v) => v === '' ? null : Number(v)
  const bool = (v) => v === '' ? null : v === 'yes'
  const submit = () => {
    onSubmit({
      trade: {
        entry_price: num(f.entry_price), exit_price: num(f.exit_price), fees_usd: num(f.fees_usd),
        status: 'closed', closed_at: new Date().toISOString(),
        realized_pnl_usd: computed.pnlUsd, realized_pnl_pct: computed.pnlPct, r_multiple: computed.r,
      },
      review: {
        outcome: f.outcome || (computed.pnlPct > 0 ? 'win' : computed.pnlPct < 0 ? 'loss' : 'breakeven'),
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
      <textarea className="textarea w-full" rows={2} placeholder={t('journal.trade.lesson', { defaultValue: 'Lesson learned' })} value={f.lesson} onChange={(e) => set({ lesson: e.target.value })} />
      <div className="flex justify-end gap-2">
        {onCancel && <button onClick={onCancel} className="btn btn--quiet btn--sm">{t('journal.cancel', { defaultValue: 'Cancel' })}</button>}
        <button onClick={submit} disabled={busy} className="btn btn--primary btn--sm disabled:opacity-50">{t('journal.trade.save_review', { defaultValue: 'Save review' })}</button>
      </div>
    </div>
  )
}
