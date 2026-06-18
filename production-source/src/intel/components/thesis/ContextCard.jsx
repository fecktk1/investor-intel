import React from 'react'
import EvidenceChips from './EvidenceChips'

// One evidence card in the Asset Context Pack. Shows the confidence labels so an
// announced partnership never looks as important as one with measurable usage.
const MAT_CLS = { high: 'chip--ok', medium: 'chip--info', low: 'text-[var(--fg-5)]' }
const SENT_CLS = { bullish: 'text-[var(--ok)]', bearish: 'text-red-400', mixed: 'text-amber-300', neutral: 'text-[var(--fg-4)]' }

export default function ContextCard({ card, selection, onChange, mode = 'builder', onAttach, onTurnInto }) {
  if (!card) return null
  return (
    <div className="card--flat p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="text-[13px] font-medium text-[var(--fg-1)] leading-snug">
          {card.url ? <a href={card.url} target="_blank" rel="noreferrer" className="hover:text-[var(--accent)]">{card.title}</a> : card.title}
        </div>
        {card.sentiment && <span className={`text-[10px] shrink-0 ${SENT_CLS[card.sentiment] || ''}`}>{card.sentiment}</span>}
      </div>
      {card.summary && <p className="text-[12px] text-[var(--fg-3)] leading-snug">{card.summary}</p>}

      <div className="flex items-center gap-1.5 flex-wrap text-[9px]">
        <span className={`chip ${MAT_CLS[card.materiality] || ''}`}>{card.materiality} materiality</span>
        {card.source_quality && <span className="chip text-[var(--fg-4)]">src: {card.source_quality}</span>}
        {card.coverage && <span className="chip text-[var(--fg-4)]">{card.coverage}</span>}
        {card.event_status && <span className="chip chip--info">{String(card.event_status).replace(/_/g, ' ')}</span>}
        {card.event_type && <span className="chip text-[var(--fg-5)]">{card.event_type}</span>}
        {(card.source || card.date) && <span className="text-[var(--fg-5)]">{[card.source, card.date].filter(Boolean).join(' · ')}</span>}
      </div>

      {card.watch_metric && <div className="text-[10px] text-[var(--fg-5)]">Watch: {card.watch_metric}</div>}

      <EvidenceChips card={card} selection={selection} onChange={onChange} mode={mode} onAttach={onAttach} onTurnInto={onTurnInto} />
    </div>
  )
}
