import React, { useState } from 'react'
import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Trash2 } from 'lucide-react'
import TradeReviewForm from './TradeReviewForm'

const STATUS_CLS = { planned: 'text-[var(--fg-4)]', open: 'chip--info', partially_closed: 'chip--info', closed: '', cancelled: 'text-[var(--fg-5)]', invalidated: 'chip--err' }

export default function TradeCard({ trade, thesisTitle, portfolioEvents = [], onClose, onDelete, busy }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const [reviewing, setReviewing] = useState(false)
  const closed = trade.status === 'closed'
  const pnl = trade.realized_pnl_pct

  return (
    <div className="border-t border-[var(--border-default)] py-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-[var(--fg-1)]">{String(trade.direction||'').replace(/_/g,' ')} {trade.symbol}</span>
          <span className={`text-xs ${STATUS_CLS[trade.status] || ''}`}>{String(trade.status||'').replace(/_/g,' ')}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {closed && pnl != null && <span className={`text-[13px] font-semibold ${pnl >= 0 ? 'text-[var(--ok)]' : 'text-red-400'}`}>{pnl >= 0 ? '+' : ''}{pnl}%{trade.r_multiple != null ? ` · R ${trade.r_multiple}` : ''}</span>}
          <button aria-label={`Delete ${trade.symbol || ''} journal entry`} onClick={() => onDelete(trade.id)} className="p-1 text-[var(--fg-4)] hover:text-red-400"><Trash2 className="h-3.5 w-3.5" /></button>
        </div>
      </div>
      <div className="flex items-center gap-2 flex-wrap text-[11px] text-[var(--fg-4)]">
        {trade.chain && <span>{trade.chain}</span>}
        {trade.entry_price != null && <span>Recorded entry {trade.entry_price}</span>}
        {trade.exited_fraction>0 && <span>{Math.round(trade.exited_fraction*10000)/100}% exited · {trade.realized_pnl_usd==null ? 'Journal result unavailable' : `Journal result $${Number(trade.realized_pnl_usd).toLocaleString()}`}</span>}
        {trade.planned_entry != null && <span>entry {trade.planned_entry}</span>}
        {trade.planned_stop != null && <span>stop {trade.planned_stop}</span>}
        {trade.target1 != null && <span>tgt {trade.target1}</span>}
        {trade.r_planned != null && <span>R:R {trade.r_planned}</span>}
        {trade.thesis_id && <Link to={`/intel/theses/${trade.thesis_id}`} className="text-[var(--accent)]">{thesisTitle || t('journal.trade.thesis_link', { defaultValue: 'thesis' })}</Link>}
        {!trade.thesis_id && <span className="text-xs text-[var(--fg-4)]">{t('journal.trade.no_thesis_flag', { defaultValue: 'no thesis' })}</span>}
      </div>
      {trade.pre_notes && <p className="text-sm whitespace-pre-wrap text-[var(--fg-3)]">{trade.pre_notes}</p>}
      {!closed && (
        reviewing
          ? <TradeReviewForm trade={trade} portfolioEvents={portfolioEvents} busy={busy} onCancel={() => setReviewing(false)} onSubmit={async (payload) => { const saved = await onClose(trade.id, payload); if (saved !== false) setReviewing(false); return saved }} />
          : <button onClick={() => setReviewing(true)} className="btn btn--quiet btn--sm">{t('journal.trade.log_exit', { defaultValue: 'Log exit & review' })}</button>
      )}
    </div>
  )
}
