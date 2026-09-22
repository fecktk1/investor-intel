import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getDemoManifest } from './demo-runtime'
import { exitIntelDemo, DEMO_SIGNUP_PATH } from './demo-mode'

// The persistent line at the top of every demo page. House style: a hairline
// bar with text links, never a pill, chip, badge or card.

/** "22 Sep 2026, 04:13 UTC" in the reader's language, always in UTC. */
export function formatSnapshotTime(iso, language) {
  const ms = Date.parse(String(iso || ''))
  if (!Number.isFinite(ms)) return null
  try {
    const text = new Intl.DateTimeFormat(language || 'en', {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC',
    }).format(new Date(ms))
    return `${text} UTC`
  } catch {
    return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`
  }
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

  const when = formatSnapshotTime(manifest?.capturedAt || (manifest?.date ? `${manifest.date}T00:00:00Z` : null), i18n?.language)
  const lead = when
    ? t('intel_demo.banner_snapshot', { defaultValue: 'Live demo: a snapshot of Investor Intel from {{when}}.', when })
    : loaded
      ? t('intel_demo.banner_no_snapshot', { defaultValue: 'Live demo of Investor Intel. Today\'s snapshot is not available yet.' })
      : t('intel_demo.banner_loading', { defaultValue: 'Live demo of Investor Intel.' })

  const signup = (event) => { event.preventDefault(); exitIntelDemo(DEMO_SIGNUP_PATH) }
  const leave = (event) => { event.preventDefault(); exitIntelDemo() }

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
      <a href="https://coinmarketcap.com/" target="_blank" rel="noreferrer" className="underline underline-offset-4 text-[var(--fg-4)] sm:ml-auto">
        {t('intel_demo.attribution', { defaultValue: 'Data provided by CoinMarketCap.com' })}
      </a>
    </div>
  )
}
