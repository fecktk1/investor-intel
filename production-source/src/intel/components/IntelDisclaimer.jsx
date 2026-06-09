import React from 'react'
import { useTranslation } from 'react-i18next'
import { Info } from 'lucide-react'

// Persistent non-financial-advice disclaimer. Investor Intel is research,
// education, and risk context — never advice. This renders in the shell and
// can be reused per-page (variant="block").
export default function IntelDisclaimer({ variant = 'bar' }) {
  const { t } = useTranslation('intel', { useSuspense: false })

  if (variant === 'block') {
    return (
      <div className="card--flat p-3 flex items-start gap-2.5 text-[12px] text-[var(--fg-3)]">
        <Info className="h-4 w-4 flex-shrink-0 mt-0.5 text-[var(--fg-4)]" />
        <span>{t('disclaimer.long', { defaultValue: 'Investor Intel provides crypto research, education, and risk context — not financial advice. Always verify before acting.' })}</span>
      </div>
    )
  }

  return (
    <div className="px-4 lg:px-6 py-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-1)] flex items-center gap-2 text-[11px] text-[var(--fg-4)]">
      <Info className="h-3.5 w-3.5 flex-shrink-0" />
      <span className="truncate">{t('disclaimer.short', { defaultValue: 'Research & education, not financial advice. Verify before acting.' })}</span>
    </div>
  )
}
