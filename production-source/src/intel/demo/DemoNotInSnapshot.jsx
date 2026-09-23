import React from 'react'
import i18next from 'i18next'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { DEMO_SIGNUP_PATH, exitIntelDemo, isIntelDemoActive } from './demo-mode'
import { DEMO_MISS_CODE, DEMO_UNTRACKED_CODE } from './demo-fetch'

// "Not in today's demo snapshot. Create a free account to look it up." with the
// account link inline. A text link, never a button-shaped pill.
export default function DemoNotInSnapshot({ className = '' }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const go = (event) => { event.preventDefault(); exitIntelDemo(DEMO_SIGNUP_PATH) }
  return (
    <span className={className} data-demo-not-in-snapshot="">
      {t('intel_demo.not_in_snapshot_lead', { defaultValue: "Not in today's demo snapshot." })}{' '}
      <a href={DEMO_SIGNUP_PATH} onClick={go} className="underline underline-offset-4 text-[var(--accent)]">
        {t('intel_demo.not_in_snapshot_link', { defaultValue: 'Create a free account' })}
      </a>{' '}
      {t('intel_demo.not_in_snapshot_tail', { defaultValue: 'to look it up.' })}
    </span>
  )
}

// The demo answers a visitor's own search for the assets our capture lanes
// actively track. Anything else (a new listing, a random contract) gets this
// calm sentence instead of a read: never an error, never an alert.
export function DemoNotTracked({ className = '' }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const go = (event) => { event.preventDefault(); exitIntelDemo(DEMO_SIGNUP_PATH) }
  return (
    <span className={className} data-demo-not-tracked="">
      {t('intel_demo.untracked_lead', { defaultValue: 'Not among the assets this demo tracks.' })}{' '}
      <a href={DEMO_SIGNUP_PATH} onClick={go} className="underline underline-offset-4 text-[var(--accent)]">
        {t('intel_demo.not_in_snapshot_link', { defaultValue: 'Create a free account' })}
      </a>{' '}
      {t('intel_demo.not_in_snapshot_tail', { defaultValue: 'to look it up.' })}
    </span>
  )
}

/** A search the current screen cannot show, although the demo tracks what it
 * names (an RWA wrapper outside the top 1,000, say): the matches as text links. */
export function DemoOutsideScreen({ rows = [], className = '' }) {
  const { t } = useTranslation('intel', { useSuspense: false })
  const shown = rows.filter((row) => row?.href).slice(0, 8)
  if (!shown.length) return null
  return (
    <span className={className} data-demo-outside-screen="">
      {t('intel_demo.outside_screen', { defaultValue: 'Tracked in this demo, outside the current screen:' })}{' '}
      {shown.map((row, index) => (
        <React.Fragment key={`${row.sourceProvider}:${row.providerId}`}>
          {index > 0 && ' · '}
          <Link to={row.href} className="underline underline-offset-4 text-[var(--accent)]">{row.displayName || row.symbol || row.providerId}</Link>
        </React.Fragment>
      ))}
    </span>
  )
}

/** Is this reason (or error code) the public endpoint's untracked refusal? */
export function isDemoUntrackedReason(reason) {
  return reason === DEMO_UNTRACKED_CODE
}

const DEMO_MISS_DEFAULT = "Not in today's demo snapshot. Create a free account to look it up."

/** The demo's reason sentence as translated text (for string contexts). */
export function demoNotInSnapshotText(t) {
  const translate = typeof t === 'function' ? t : (key, options) => i18next.t(key, { ns: 'intel', ...options })
  return translate('intel_demo.not_in_snapshot', { defaultValue: DEMO_MISS_DEFAULT })
}

/** Is this reason (the code, or the sentence in English or the reader's language) the demo miss? */
export function isDemoMissReason(reason) {
  if (reason == null || typeof reason !== 'string') return false
  if (reason === DEMO_MISS_CODE || reason === DEMO_MISS_DEFAULT) return true
  try { return reason === demoNotInSnapshotText() } catch { return false }
}

/** A reason ready to render: the linked sentence in the demo, else the reason as given. */
export function demoReasonNode(reason) {
  if (isIntelDemoActive() && isDemoUntrackedReason(reason)) return <DemoNotTracked />
  return isIntelDemoActive() && isDemoMissReason(reason) ? <DemoNotInSnapshot /> : reason
}
