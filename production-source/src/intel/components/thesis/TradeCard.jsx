import React, { useState } from 'react'
import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Trash2 } from 'lucide-react'
import TradeReviewForm from './TradeReviewForm'

const STATUS_CLS = { planned: 'text-[var(--fg-4)]', open: 'chip--info', partially_closed: 'chip--info', closed: '', cancelled: 'text-[var(--fg-5)]', invalidated: 'chip--err' }

export default function TradeCard({ trade, thesisTitle, onClose, onDelete, busy }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const [reviewing, setReviewing] = useState(false)
  const closed = trade.status === 'closed'
  const pnl = trade.realized_pnl_pct

  return (
    <div className="card p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-[var(--fg-1)]">{trade.direction} {trade.symbol}</span>
          <span className={`chip text-[10px] ${STATUS_CLS[trade.status] || ''}`}>{trade.status}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {closed && pnl != null && <span className={`text-[13px] font-semibold ${pnl >= 0 ? 'text-[var(--ok)]' : 'text-red-400'}`}>{pnl >= 0 ? '+' : ''}{pnl}%{trade.r_multiple != null ? ` · R ${trade.r_multiple}` : ''}</span>}
          <button onClick={() => onDelete(trade.id)} className="p-1 text-[var(--fg-4)] hover:text-red-400"><Trash2 className="h-3.5 w-3.5" /></button>
        </div>
      </div>
      <div className="flex items-center gap-2 flex-wrap text-[11px] text-[var(--fg-4)]">
        {trade.planned_entry != null && <span>entry {trade.planned_entry}</span>}
        {trade.planned_stop != null && <span>stop {trade.planned_stop}</span>}
        {trade.target1 != null && <span>tgt {trade.target1}</span>}
        {trade.r_planned != null && <span>R:R {trade.r_planned}</span>}
        {trade.thesis_id && <Link to={`/intel/theses/${trade.thesis_id}`} className="text-[var(--accent)]">{thesisTitle || t('journal.trade.thesis_link', { defaultValue: 'thesis' })}</Link>}
        {!trade.thesis_id && <span className="chip text-[9px] text-amber-300">{t('journal.trade.no_thesis_flag', { defaultValue: 'no thesis' })}</span>}
      </div>
      {!closed && (
        reviewing
          ? <TradeReviewForm trade={trade} busy={busy} onCancel={() => setReviewing(false)} onSubmit={(payload) => { onClose(trade.id, payload); setReviewing(false) }} />
          : <button onClick={() => setReviewing(true)} className="btn btn--quiet btn--sm">{t('journal.trade.log_exit', { defaultValue: 'Log exit & review' })}</button>
      )}
    </div>
  )
}
