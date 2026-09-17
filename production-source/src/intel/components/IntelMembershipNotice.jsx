import React from 'react'
import { useTranslation } from 'react-i18next'
import { useIntel } from '../context/IntelContext'

// A trial that has run out is a FREE MEMBERSHIP, not an error and not a
// paywall. The workspace, the watchlists, the theses, the saved research and
// the settings are all still there; the ten per member surfaces carry the same
// lock a free signup sees, and those locks already explain themselves.
//
// So this says the one thing those locks cannot: what happened, and that
// nothing was lost. It is deliberately a plain sentence on a hairline rail,
// not a pill, a card or a banner with an action in it. The place to upgrade is
// the lock the member actually meets, and the plans page it links to.
export default function IntelMembershipNotice() {
  const { t } = useTranslation('intel', { useSuspense: false })
  const { trialLapsed } = useIntel()
  if (!trialLapsed) return null
  return (
    <p className="mx-3 mt-3 pt-3 border-t border-[var(--intel-border-soft)] text-[12px] leading-relaxed text-[var(--fg-3)]">
      {t('access.trial_lapsed', {
        defaultValue: 'Your 7-day trial has ended. You are on the free plan. Everything you saved is still here.',
      })}
    </p>
  )
}
