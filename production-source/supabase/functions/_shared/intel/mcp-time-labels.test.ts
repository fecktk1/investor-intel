import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { timeLabel, withTimeLabels, TIME_LABEL_CAP } from './mcp-time-labels.ts'

Deno.test('the 23 Sep 2026 slip: 22 Sep 2026 16:58:36 UTC is labelled a Tuesday', () => {
  assertEquals(timeLabel('2026-09-22T16:58:36Z'), 'Tue 22 Sep 2026, 16:58:36 UTC')
  assertEquals(timeLabel('2026-09-22T16:58:36.000Z'), 'Tue 22 Sep 2026, 16:58:36 UTC')
})

Deno.test('instants in every stored UTC spelling, seconds only when not zero, and plain dates', () => {
  assertEquals(timeLabel('2026-09-23T14:00:00+00:00'), 'Wed 23 Sep 2026, 14:00 UTC')
  assertEquals(timeLabel('2026-09-23 08:45:59+00'), 'Wed 23 Sep 2026, 08:45:59 UTC')
  assertEquals(timeLabel('2026-09-23T08:45Z'), 'Wed 23 Sep 2026, 08:45 UTC')
  assertEquals(timeLabel('2026-09-27'), 'Sun 27 Sep 2026')
  assertEquals(timeLabel('2026-12-31T23:59:59Z'), 'Thu 31 Dec 2026, 23:59:59 UTC')
})

Deno.test('non-timestamps and non-UTC offsets are not labelled', () => {
  for (const value of ['NVDA', '40685', '2026-09-23T10:00:00-04:00', '2026-13-40', '', null, 12, '2026-09-23T25:00:00Z']) {
    assertEquals(timeLabel(value), null, String(value))
  }
})

Deno.test('withTimeLabels adds one map of distinct times and leaves every field as it was', () => {
  const payload = {
    tool: 'rwa_best_wrapper', as_of: '2026-09-23T14:00:00+00:00',
    data: { picks: { cheapest: { symbol: 'NVDA', observedAt: '2026-09-23T08:45:59+00:00' } },
      reference: { observedAt: '2026-09-22T16:58:36Z' }, rows: [{ at: '2026-09-23T14:00:00+00:00' }] },
  }
  const out = withTimeLabels(payload) as Record<string, unknown>
  assertEquals(out.as_of, payload.as_of)
  assertEquals(out.data, payload.data)
  assertEquals(out.time_labels, {
    '2026-09-23T14:00:00+00:00': 'Wed 23 Sep 2026, 14:00 UTC',
    '2026-09-23T08:45:59+00:00': 'Wed 23 Sep 2026, 08:45:59 UTC',
    '2026-09-22T16:58:36Z': 'Tue 22 Sep 2026, 16:58:36 UTC',
  })
  assertEquals(out.time_labels_truncated, undefined)
})

Deno.test('a payload with no time, an array or a scalar is returned unchanged', () => {
  const plain = { tool: 'search_assets', data: [{ symbol: 'BTC' }] }
  assertEquals(withTimeLabels(plain), plain)
  assertEquals(withTimeLabels([1, 2]), [1, 2])
  assertEquals(withTimeLabels(null), null)
})

Deno.test('a long series is bounded breadth-first: as_of is labelled before the deep points', () => {
  const series = Array.from({ length: 200 }, (_, i) => ({ t: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString() }))
  const out = withTimeLabels({ as_of: '2026-09-23T14:00:00Z', data: { series } }) as Record<string, any>
  assertEquals(Object.keys(out.time_labels).length, TIME_LABEL_CAP)
  assertEquals(out.time_labels['2026-09-23T14:00:00Z'], 'Wed 23 Sep 2026, 14:00 UTC')
  assertEquals(out.time_labels_truncated, true)
})
