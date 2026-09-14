import { evidenceFreshness, groupFreshness } from './evidence-freshness.ts'
const now = Date.parse('2026-11-01T07:00:00Z')
function equal(actual: unknown, expected: unknown) { if (actual !== expected) throw new Error(`${actual} != ${expected}`) }
Deno.test('T02 freshness uses observation time independently of ingestion time across DST', () => {
  const value = evidenceFreshness({ observed_at: '2026-11-01T01:30:00-05:00', fetched_at: '2026-11-01T06:59:00Z' }, now, 1)
  equal(value.as_of, '2026-11-01T06:30:00.000Z'); equal(value.age_hours, 0.5)
  equal(value.recorded_at, '2026-11-01T06:59:00.000Z'); equal(value.status, 'fresh')
})
Deno.test('T02 invalid and future observation clocks cannot be fresh despite an unexpired cache', () => {
  for (const observed_at of [undefined, 'bad', '2026-11-02T00:00:00Z']) {
    equal(evidenceFreshness({ observed_at, fetched_at: new Date(now).toISOString(), stale_after: '2030-01-01' }, now).status, 'unknown')
  }
})
Deno.test('T02 expiry boundary is stale and empty evidence is missing', () => {
  equal(evidenceFreshness({ as_of: '2026-11-01T06:00:00Z', stale_after: new Date(now).toISOString() }, now).status, 'stale')
  equal(groupFreshness([], now).status, 'missing')
})
Deno.test('T02 group freshness is order-independent and preserves unknown clocks', () => {
  const rows = [{ as_of: '2026-11-01T06:59:00Z' }, { fetched_at: '2026-11-01T06:59:00Z' }]
  for (const input of [rows, [...rows].reverse()]) {
    const value = groupFreshness(input, now)
    equal(value.status, 'unknown'); equal(value.as_of, null); equal(value.unknown_observation_count, 1)
    equal(value.observations.length, 2)
  }
})

Deno.test('catalog quote recording time uses its refresh, not catalog creation', () => {
  const row = { as_of: '2026-11-01T06:30:00Z', last_refreshed_at: '2026-11-01T06:45:00Z', created_at: '2026-06-09T02:20:03Z' }
  const value = evidenceFreshness(row, now, 1)
  equal(value.as_of, '2026-11-01T06:30:00.000Z')
  equal(value.recorded_at, '2026-11-01T06:45:00.000Z')
  equal(value.age_hours, 0.5)
  equal(value.status, 'fresh')
  equal(evidenceFreshness({ ...row, fetched_at: '2026-11-01T06:40:00Z' }, now).recorded_at, '2026-11-01T06:40:00.000Z')
})

Deno.test('invalid catalog refresh stays unknown instead of borrowing an older creation clock', () => {
  const value = evidenceFreshness({ last_refreshed_at: 'invalid', created_at: '2026-06-09T02:20:03Z' }, now)
  equal(value.recorded_at, null)
  equal(value.as_of, null)
  equal(value.status, 'unknown')
})
