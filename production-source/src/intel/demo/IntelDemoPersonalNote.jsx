import React from 'react'
import { useLocation } from 'react-router'
import { useTranslation } from 'react-i18next'
import { isDemoPersonalPath, isIntelDemoActive } from './demo-mode'

// On the visitor's own sections (watchlist, portfolio, wallets, theses, alerts,
// briefs, saved research, settings) the demo says once why they are empty.
// House style: one plain line under a hairline, never a pill or a card.
export default function IntelDemoPersonalNote() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { pathname } = useLocation()
  if (!isIntelDemoActive() || !isDemoPersonalPath(pathname)) return null
  return (
    <p className="border-b border-[var(--border-default)] px-4 lg:px-6 py-2 text-xs text-[var(--fg-3)]" data-intel-demo-personal="">
      {t('intel_demo.personal_empty', { defaultValue: 'Your own lists start empty in the demo. Add something to try it; nothing is saved.' })}
    </p>
  )
}
