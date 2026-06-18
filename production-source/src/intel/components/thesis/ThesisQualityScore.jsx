import React from 'react'
import { useTranslation } from 'react-i18next'
import { Gauge, AlertCircle } from 'lucide-react'

// Live thesis quality score (0-100) + the gaps that are dragging it down. Shown in
// the builder rail, the detail header, and "Why I Own This". Makes the Journal
// feel guiding, not just structured.
const tone = (s) => s >= 80 ? 'var(--ok)' : s >= 60 ? '#fbbf24' : s >= 1 ? '#f87171' : 'var(--fg-5)'

export default function ThesisQualityScore({ quality, loading, compact = false }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const score = Number(quality?.score ?? 0)
  const missing = Array.isArray(quality?.missing) ? quality.missing : []
  const color = tone(score)

  return (
    <div className={compact ? '' : 'card p-3'}>
      <div className="flex items-center gap-2">
        <Gauge className="h-4 w-4" style={{ color }} />
        <div className="text-[12px] text-[var(--fg-3)]">{t('journal.quality', { defaultValue: 'Thesis quality' })}</div>
        <div className="ml-auto text-sm font-semibold" style={{ color }}>{loading ? '…' : `${score}/100`}</div>
      </div>
      <div className="mt-2 h-1.5 rounded-full bg-[var(--bg-2)] overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${Math.max(0, Math.min(100, score))}%`, background: color }} />
      </div>
      {missing.length > 0 && (
        <ul className="mt-2 space-y-1">
          {missing.slice(0, compact ? 2 : 5).map((m, i) => (
            <li key={i} className="text-[11px] text-[var(--fg-4)] flex items-start gap-1.5">
              <AlertCircle className="h-3 w-3 mt-0.5 shrink-0 text-amber-400" /> {m}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
