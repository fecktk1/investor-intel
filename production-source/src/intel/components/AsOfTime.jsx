import React from 'react'
import { useTranslation } from 'react-i18next'
import { asOfText, useMinuteClock } from '../lib/as-of'

/** "as of 23 Sep 2026, 14:00 UTC (4 hours ago)": the one as-of statement a
 * section makes about its own data (../lib/as-of.js). Plain text in a <time>
 * element, never a pill, chip or tile; the age keeps up once a minute. Renders
 * nothing without a usable time, so a section never claims a time it lacks.
 *
 * `render` may place the statement inside a longer translated sentence, for a
 * figure group whose time differs from the section's (it receives the text). */
export default function AsOfTime({ value, className = '', testId = null, render = null }) {
  const { t, i18n } = useTranslation('intel', { useSuspense: false })
  const ms = Date.parse(String(value ?? ''))
  const valid = Number.isFinite(ms)
  const now = useMinuteClock(valid)
  const text = valid ? asOfText(t, value, { language: i18n?.language, now }) : null
  if (!text) return null
  return (
    <time dateTime={new Date(ms).toISOString()} className={className || undefined} data-as-of="" data-testid={testId || undefined}>
      {typeof render === 'function' ? render(text) : text}
    </time>
  )
}
