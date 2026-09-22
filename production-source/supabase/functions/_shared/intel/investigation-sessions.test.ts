import { assertEquals as eq } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { nyseClosedDays, NYSE_HOLIDAY_YEARS, equitySession } from './investigation-sessions.ts'

Deno.test('nyseClosedDays: weekends and scheduled full-day holidays, never early closes', () => {
  // Thanksgiving week 2026: Thursday 26 is closed, Friday 27 is an early close (open).
  const days = nyseClosedDays(Date.parse('2026-11-23T00:00:00Z'), Date.parse('2026-11-30T00:00:00Z'))
  eq(days, [
    { date: '2026-11-26', kind: 'holiday' },
    { date: '2026-11-28', kind: 'weekend' },
    { date: '2026-11-29', kind: 'weekend' },
  ])
})

Deno.test('nyseClosedDays: Labor Day 2026 and the bounds are inclusive by date', () => {
  eq(nyseClosedDays(Date.parse('2026-09-05T13:00:00Z'), Date.parse('2026-09-07T01:00:00Z')).map((d) => d.date), ['2026-09-05', '2026-09-06', '2026-09-07'])
  eq(nyseClosedDays(Date.parse('2026-09-07T00:00:00Z'), Date.parse('2026-09-07T00:00:00Z'))[0].kind, 'holiday')
})

Deno.test('nyseClosedDays: outside the covered years only weekends are reported', () => {
  eq(NYSE_HOLIDAY_YEARS, { from: 2026, to: 2028 })
  // 2025-12-25 was a NYSE holiday, but the list does not cover 2025.
  eq(nyseClosedDays(Date.parse('2025-12-25T00:00:00Z'), Date.parse('2025-12-25T00:00:00Z')), [])
})

Deno.test('nyseClosedDays: invalid or reversed ranges return nothing, and a long range is bounded', () => {
  eq(nyseClosedDays(NaN, 0), [])
  eq(nyseClosedDays(10, 5), [])
  const long = nyseClosedDays(Date.parse('2020-01-01T00:00:00Z'), Date.parse('2030-01-01T00:00:00Z'))
  eq(long.length <= 1100, true)
})

Deno.test('equitySession is unchanged by the new export', () => {
  const s = equitySession(Date.parse('2026-09-07T15:00:00Z'), 'XNYS')
  eq(s.state, 'scheduled_closed')
  eq(s.sessions[0].date, '2026-09-08')
})
