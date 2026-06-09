import React from 'react'
import { Sparkles } from 'lucide-react'

// One-line RAG market-memory context (facts-only). Renders nothing when absent.
export default function MarketMemorySummary({ summary }) {
  if (!summary) return null
  return (
    <div className="text-[11px] text-[var(--fg-4)] flex items-start gap-1.5">
      <Sparkles className="h-3 w-3 mt-0.5 shrink-0 text-[var(--fg-5)]" />
      <span className="leading-relaxed">{summary}</span>
    </div>
  )
}
