import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getDemoManifest } from './demo-runtime'
import { exitIntelDemo, DEMO_SIGNUP_PATH } from './demo-mode'
import { formatDataTime, formatUtcTime, useMinuteClock } from '../lib/as-of'

// The persistent line at the top of every demo page. House style: a hairline
// bar with text links, never a pill, chip, badge or card.

/** "22 Sep 2026, 04:13 UTC" in the reader's language, always in UTC: the one
 * time format every demo section uses (../lib/as-of.js). */
export function formatSnapshotTime(iso, language) {
  return formatUtcTime(iso, language)
}

export default function IntelDemoBanner({ manifestLoader = getDemoManifest }) {
  const { t, i18n } = useTranslation('intel')
  const [manifest, setManifest] = useState(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let live = true
    Promise.resolve(manifestLoader?.()).then((m) => { if (live) { setManifest(m || null); setLoaded(true) } }).catch(() => { if (live) setLoaded(true) })
    return () => { live = false }
  }, [manifestLoader])

  // When the snapshot was BUILT, with its age, and no more: each section below
  // states the time of its own data (AsOfTime), and a capture view or a quote
  // with a newer stored copy shows that copy, so the build time is not the age
  // of everything on the page and the line does not say it is.
  const builtAt = manifest?.capturedAt || (manifest?.date ? `${manifest.date}T00:00:00Z` : null)
  const now = useMinuteClock(!!builtAt)
  const when = formatDataTime(builtAt, { language: i18n?.language, now })
  const lead = when
    ? t('intel_demo.banner_snapshot', { defaultValue: 'Live demo of Investor Intel, opened from a snapshot built {{when}}. Each section states the time of its own data, and shows a newer stored capture when there is one.', when })
    : loaded
      ? t('intel_demo.banner_no_snapshot', { defaultValue: 'Live demo of Investor Intel. Today\'s snapshot is not available yet.' })
      : t('intel_demo.banner_loading', { defaultValue: 'Live demo of Investor Intel.' })

  const signup = (event) => { event.preventDefault(); exitIntelDemo(DEMO_SIGNUP_PATH) }
  const leave = (event) => { event.preventDefault(); exitIntelDemo() }
  // A member who reached this page from a direct link signs in and returns here.
  const signInHref = () => {
    const here = `${globalThis.location?.pathname || ''}${globalThis.location?.search || ''}`
    return here.startsWith('/intel') ? `/login?next=${encodeURIComponent(here)}` : '/login'
  }
  const signIn = (event) => { event.preventDefault(); exitIntelDemo(signInHref()) }

  return (
    <div
      role="region"
      aria-label={t('intel_demo.banner_label', { defaultValue: 'Demo notice' })}
      className="intel-demo-banner border-b border-[var(--border-default)] px-4 lg:px-6 py-2 text-xs text-[var(--fg-3)] flex flex-wrap items-baseline gap-x-4 gap-y-1"
      data-intel-demo-banner=""
    >
      <span className="text-[var(--fg-2)]">
        {lead} {t('intel_demo.banner_nothing_saved', { defaultValue: 'Nothing you do here is saved.' })}
      </span>
      <a href={DEMO_SIGNUP_PATH} onClick={signup} className="intel-text-link underline underline-offset-4 text-[var(--accent)]">
        {t('intel_demo.create_account', { defaultValue: 'Create a free account' })}
      </a>
      <a href="/investors" onClick={leave} className="intel-text-link underline underline-offset-4">
        {t('intel_demo.leave', { defaultValue: 'Leave demo' })}
      </a>
      <a href="/login" onClick={signIn} className="intel-text-link underline underline-offset-4">
        {t('intel_demo.sign_in', { defaultValue: 'Sign in' })}
      </a>
      <a href="https://coinmarketcap.com/" target="_blank" rel="noreferrer" className="underline underline-offset-4 text-[var(--fg-4)] sm:ml-auto">
        {t('intel_demo.attribution', { defaultValue: 'Data provided by CoinMarketCap.com' })}
      </a>
    </div>
  )
}
