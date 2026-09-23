// Investor Intel: ONE way to say when a section's data is from.
//
//   as of 23 Sep 2026, 14:00 UTC (4 hours ago)
//
// The time is always UTC (the capture lanes, the snapshot and every cron are
// scheduled in UTC, so the times on one page can be compared at a glance), and
// the age beside it says how old the data is in plain words, in the reader's
// language (Intl.RelativeTimeFormat), so nothing needs the word "stale" to say
// that data is old. The wording is the Markets table's own as-of string
// (markets.sharedSnapshotAsOf), reused everywhere a section states its time.

import { useEffect, useState } from 'react'

const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000

const msOf = (value) => {
  const ms = Date.parse(String(value ?? ''))
  return Number.isFinite(ms) ? ms : null
}

/** "23 Sep 2026, 14:00 UTC" in the reader's language, always in UTC. */
export function formatUtcTime(value, language) {
  const ms = msOf(value)
  if (ms == null) return null
  try {
    const text = new Intl.DateTimeFormat(language || 'en', {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC',
    }).format(new Date(ms))
    return `${text} UTC`
  } catch {
    return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`
  }
}

/** "4 hours ago" (or "in 3 hours" for a time ahead) in the reader's language. */
export function relativeAge(value, language, now = Date.now()) {
  const ms = msOf(value)
  if (ms == null) return null
  const diff = ms - now
  const abs = Math.abs(diff)
  const [amount, unit] = abs < MINUTE ? [0, 'second']
    : abs < HOUR ? [Math.round(diff / MINUTE), 'minute']
      : abs < 2 * DAY ? [Math.round(diff / HOUR), 'hour']
        : [Math.round(diff / DAY), 'day']
  try {
    return new Intl.RelativeTimeFormat(language || 'en', { numeric: 'auto' }).format(amount, unit)
  } catch {
    return `${Math.abs(amount)} ${unit}${Math.abs(amount) === 1 ? '' : 's'} ${diff < 0 ? 'ago' : 'ahead'}`
  }
}

/** "23 Sep 2026, 14:00 UTC (4 hours ago)", or null without a usable time. The
 * age is in the reader's language already (Intl), so the pattern needs no
 * translation of its own. */
export function formatDataTime(value, { language, now = Date.now() } = {}) {
  const date = formatUtcTime(value, language)
  if (!date) return null
  const age = relativeAge(value, language, now)
  return age ? `${date} (${age})` : date
}

/** "as of 23 Sep 2026, 14:00 UTC (4 hours ago)", or null without a usable time. */
export function asOfText(t, value, options = {}) {
  const date = formatDataTime(value, options)
  return date ? t('markets.sharedSnapshotAsOf', { date, defaultValue: 'as of {{date}}' }) : null
}

/** The current time, updated once a minute, so a stated age keeps up. */
export function useMinuteClock(enabled = true) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return undefined
    const timer = setInterval(() => setNow(Date.now()), MINUTE)
    return () => clearInterval(timer)
  }, [enabled])
  return now
}
