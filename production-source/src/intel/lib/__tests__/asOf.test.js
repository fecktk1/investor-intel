import { describe, expect, it } from 'vitest'
import { asOfText, formatDataTime, formatUtcTime, relativeAge } from '../as-of'

const NOW = Date.parse('2026-09-23T17:51:00.000Z')
const t = (key, options = {}) => String(options.defaultValue ?? key).replace(/\{\{(\w+)\}\}/g, (_, name) => String(options[name] ?? ''))

describe('one as-of statement for every demo section', () => {
  it('states the time in UTC and the age in words, whatever the viewer\'s zone', () => {
    expect(formatUtcTime('2026-09-23T14:00:00.000Z', 'en')).toBe('Sep 23, 2026, 14:00 UTC')
    expect(formatDataTime('2026-09-23T14:00:00.000Z', { language: 'en', now: NOW })).toBe('Sep 23, 2026, 14:00 UTC (4 hours ago)')
    expect(asOfText(t, '2026-09-23T17:47:00.000Z', { language: 'en', now: NOW })).toBe('as of Sep 23, 2026, 17:47 UTC (4 minutes ago)')
  })

  it('says how old data is instead of calling it stale, in the reader\'s language', () => {
    expect(relativeAge('2026-09-23T17:50:40.000Z', 'en', NOW)).toBe('now')
    expect(relativeAge('2026-09-23T04:13:00.000Z', 'en', NOW)).toBe('14 hours ago')
    expect(relativeAge('2026-09-20T17:51:00.000Z', 'en', NOW)).toBe('3 days ago')
    expect(relativeAge('2026-09-23T13:51:00.000Z', 'de', NOW)).toBe('vor 4 Stunden')
    expect(formatDataTime('2026-09-23T14:00:00.000Z', { language: 'en', now: NOW })).not.toMatch(/stale/i)
  })

  it('claims no time it does not have', () => {
    expect(formatDataTime(null, { now: NOW })).toBeNull()
    expect(asOfText(t, 'not a time', { now: NOW })).toBeNull()
  })
})
