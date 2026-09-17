import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  readMemeGraduation, MEME_CAPTURE_VIEWS, percentile, histogram,
  HISTOGRAM_EDGES, RETENTION_HOURS, FUNNEL_CONTRACTS,
} from './capture-meme-read.ts'

const HOUR = 3_600_000
const NOW = Math.floor((Date.now() - 7 * 86_400_000) / HOUR) * HOUR
const ago = (hours: number) => new Date(NOW - hours * HOUR).toISOString()
const SOL = (n: number) => `So1111111111111111111111111111111111111111${String(n).padStart(2, '0')}`

/** PostgREST-shaped fake with eq/gte/lt filters, order and limit. */
// deno-lint-ignore no-explicit-any
function fakeDb(tables: Record<string, any[]> = {}, errors: Record<string, string> = {}) {
  const compare = (a: unknown, b: unknown) => String(a ?? '').localeCompare(String(b ?? ''))
  return {
    from(table: string) {
      // deno-lint-ignore no-explicit-any
      const filters: [string, string, any][] = []
      let ordering: { column: string; ascending: boolean } | null = null
      const run = (max: number | null) => {
        if (errors[table]) return { data: null, error: { message: errors[table] } }
        let rows = [...(tables[table] || [])]
        for (const [key, op, operand] of filters) {
          rows = rows.filter((row) => {
            const v = row?.[key]
            if (op === 'eq') return String(v ?? '') === String(operand ?? '')
            if (op === 'gte') return compare(v, operand) >= 0
            if (op === 'lt') return compare(v, operand) < 0
            return true
          })
        }
        if (ordering) rows.sort((a, b) => compare(a?.[ordering!.column], b?.[ordering!.column]) * (ordering!.ascending ? 1 : -1))
        return { data: max == null ? rows : rows.slice(0, max), error: null }
      }
      // deno-lint-ignore no-explicit-any
      const q: any = {
        select: () => q,
        // deno-lint-ignore no-explicit-any
        eq: (k: string, v: any) => { filters.push([k, 'eq', v]); return q },
        // deno-lint-ignore no-explicit-any
        gte: (k: string, v: any) => { filters.push([k, 'gte', v]); return q },
        // deno-lint-ignore no-explicit-any
        lt: (k: string, v: any) => { filters.push([k, 'lt', v]); return q },
        // deno-lint-ignore no-explicit-any
        order: (column: string, options: any = {}) => { ordering = { column, ascending: options?.ascending !== false }; return q },
        limit: (max: number) => Promise.resolve(run(max)),
      }
      return q
    },
  }
}

const snapshot = (address: string, capturedHoursAgo: number, stage: string, firstSeenHoursAgo = capturedHoursAgo, chain = 'solana', marketCap = 50_000) =>
  ({ platform_id: 16, chain, contract_address: address, captured_at: ago(capturedHoursAgo), stage, name: `${address} token`, symbol: address.slice(-3), price: 0.001, market_cap: marketCap, first_seen_at: ago(firstSeenHoursAgo) })
const move = (address: string, atHoursAgo: number, from: string, to: string, hours: number | null, chain = 'solana') =>
  ({ chain, contract_address: address, from_stage: from, to_stage: to, at: ago(atHoursAgo), hours_since_first_seen: hours })

Deno.test('empty tables answer empty with asOf null and never an error', async () => {
  const result = await readMemeGraduation(fakeDb(), { days: 7 }, NOW)
  eq(result.view, 'meme_graduation')
  eq(result.asOf, null)
  eq(result.funnel, [])
  eq(result.recent, [])
  eq(result.retention, [])
  eq(result.graduationRate, null)
  eq(result.timeToGraduate, null)
  eq(result.coverage, { from: null, to: null, count: 0 })
  eq(result.reason, null)
})

Deno.test('a failed read is a reason on an empty answer', async () => {
  const result = await readMemeGraduation(fakeDb({}, { intel_meme_stage_snapshots: 'permission denied' }), { days: 7 }, NOW)
  eq(result.asOf, null)
  eq(result.reason, 'permission denied')
})

Deno.test('the funnel counts the newest capture only', async () => {
  const db = fakeDb({
    intel_meme_stage_snapshots: [
      snapshot(SOL(1), 0, 'newCreations', 1), snapshot(SOL(2), 0, 'newCreations', 2),
      snapshot(SOL(3), 0, 'aboutGraduates', 6), snapshot(SOL(4), 0, 'graduates', 10),
      // An older hour must not be counted in the board.
      snapshot(SOL(5), 3, 'newCreations', 3),
    ],
  })
  const result = await readMemeGraduation(db, { days: 7 }, NOW)
  eq(result.asOf, ago(0))
  const funnel = result.funnel as Record<string, unknown>[]
  eq(funnel.map((f) => [f.stage, f.count]), [['newCreations', 2], ['aboutGraduates', 1], ['graduates', 1]])
  eq((funnel[0].contracts as unknown[]).length, 2)
  eq(funnel.every((f) => f.contractsTruncated === false), true)
  eq((funnel[0].contracts as Record<string, unknown>[])[0].chain, 'solana')
})

Deno.test('a stage with no members keeps its zero', async () => {
  const db = fakeDb({ intel_meme_stage_snapshots: [snapshot(SOL(1), 0, 'newCreations', 1)] })
  const result = await readMemeGraduation(db, { days: 7 }, NOW)
  const funnel = result.funnel as Record<string, unknown>[]
  eq(funnel.length, 3, 'every stage is present, not only the populated ones')
  eq(funnel[2].stage, 'graduates')
  eq(funnel[2].count, 0)
})

Deno.test('the funnel contract list is capped and says so', async () => {
  const rows = Array.from({ length: FUNNEL_CONTRACTS + 4 }, (_, i) => snapshot(SOL(i), 0, 'newCreations', 1))
  const result = await readMemeGraduation(fakeDb({ intel_meme_stage_snapshots: rows }), { days: 7 }, NOW)
  const funnel = result.funnel as Record<string, unknown>[]
  eq(funnel[0].count, FUNNEL_CONTRACTS + 4, 'the count is the true count')
  eq((funnel[0].contracts as unknown[]).length, FUNNEL_CONTRACTS)
  eq(funnel[0].contractsTruncated, true)
})

Deno.test('the graduation rate is a cohort rate, and a measured zero stays zero', async () => {
  const db = fakeDb({
    intel_meme_stage_snapshots: [
      // Four contracts first seen inside the window, one of which graduated.
      snapshot(SOL(1), 0, 'graduates', 10), snapshot(SOL(1), 10, 'newCreations', 10),
      snapshot(SOL(2), 0, 'newCreations', 8),
      snapshot(SOL(3), 0, 'aboutGraduates', 6),
      snapshot(SOL(4), 0, 'newCreations', 2),
    ],
  })
  const result = await readMemeGraduation(db, { days: 7 }, NOW)
  eq(result.cohort, { firstSeenInWindow: 4, graduatedInWindow: 1 })
  eq(result.graduationRate, 0.25)

  const none = await readMemeGraduation(fakeDb({
    intel_meme_stage_snapshots: [snapshot(SOL(1), 0, 'newCreations', 2), snapshot(SOL(2), 0, 'newCreations', 3)],
  }), { days: 7 }, NOW)
  eq(none.graduationRate, 0, 'a cohort with no graduates is a zero, not an absence')
})

Deno.test('the rate is null when the denominator is zero', async () => {
  // Every sighting inside the window belongs to a contract first seen BEFORE it,
  // so the window has no new creations to measure against.
  const db = fakeDb({
    intel_meme_stage_snapshots: [snapshot(SOL(1), 0, 'graduates', 24 * 30), snapshot(SOL(2), 1, 'aboutGraduates', 24 * 40)],
  })
  const result = await readMemeGraduation(db, { days: 1 }, NOW)
  eq(result.cohort, { firstSeenInWindow: 0, graduatedInWindow: 0 })
  eq(result.graduationRate, null, 'an unmeasurable rate is never reported as zero')
  assert((result.recent as unknown[]).length > 0, 'the sightings themselves are still reported')
})

Deno.test('time to graduate reads newCreations to graduates transitions only', async () => {
  const db = fakeDb({
    intel_meme_stage_snapshots: [snapshot(SOL(1), 0, 'graduates', 10)],
    intel_meme_stage_transitions: [
      move(SOL(1), 0, 'newCreations', 'graduates', 2),
      move(SOL(2), 1, 'newCreations', 'graduates', 4),
      move(SOL(3), 2, 'newCreations', 'graduates', 30),
      // Not a graduation from a new creation: excluded from the distribution.
      move(SOL(4), 3, 'aboutGraduates', 'graduates', 99),
      move(SOL(5), 4, 'newCreations', 'aboutGraduates', 1),
    ],
  })
  const result = await readMemeGraduation(db, { days: 7 }, NOW)
  const t = result.timeToGraduate as Record<string, unknown>
  eq(t.sample, 3)
  eq(t.median, 4)
  eq(t.p25, 3)
  eq(t.p75, 17)
  const buckets = t.histogram as Record<string, unknown>[]
  eq(buckets.length, HISTOGRAM_EDGES.length)
  eq(buckets.find((b) => b.fromHours === 1)?.count, 1, '2 hours falls in [1,3)')
  eq(buckets.find((b) => b.fromHours === 3)?.count, 1, '4 hours falls in [3,6)')
  eq(buckets.find((b) => b.fromHours === 24)?.count, 1, '30 hours falls in [24,48)')
  eq(buckets.find((b) => b.fromHours === 168)?.toHours, null, 'the last bucket is open-ended')
  eq(buckets.filter((b) => b.count === 0).length, HISTOGRAM_EDGES.length - 3, 'empty buckets stay as zeros')
})

Deno.test('no retained graduation transition is null, not a zero distribution', async () => {
  const db = fakeDb({ intel_meme_stage_snapshots: [snapshot(SOL(1), 0, 'newCreations', 1)] })
  const result = await readMemeGraduation(db, { days: 7 }, NOW)
  eq(result.timeToGraduate, null)
})

Deno.test('retention counts only contracts that have had the time to fail', async () => {
  const db = fakeDb({
    intel_meme_stage_snapshots: [
      // Seen 30 hours ago, still seen now: survives 1, 6 and 24 hours.
      snapshot(SOL(1), 0, 'aboutGraduates', 30), snapshot(SOL(1), 30, 'newCreations', 30),
      // First seen 30 hours ago, last seen 30 hours ago: survives none of them.
      snapshot(SOL(2), 30, 'newCreations', 30),
      // First seen 20 minutes ago: not eligible for any of the tests yet.
      snapshot(SOL(3), 0, 'newCreations', 1 / 3),
    ],
  })
  const result = await readMemeGraduation(db, { days: 7 }, NOW)
  const retention = result.retention as Record<string, number>[]
  eq(retention.map((r) => r.hoursSinceFirstSeen), RETENTION_HOURS)
  eq(retention.find((r) => r.hoursSinceFirstSeen === 1), { hoursSinceFirstSeen: 1, stillListed: 1, eligible: 2 })
  eq(retention.find((r) => r.hoursSinceFirstSeen === 24), { hoursSinceFirstSeen: 24, stillListed: 1, eligible: 2 })
  eq(retention.find((r) => r.hoursSinceFirstSeen === 72), { hoursSinceFirstSeen: 72, stillListed: 0, eligible: 0 })
})

Deno.test('recent is the newest sighting per contract, capped at fifty', async () => {
  const rows = Array.from({ length: 60 }, (_, i) => snapshot(SOL(i), i % 5, 'newCreations', i % 5))
    .concat([snapshot(SOL(0), 4, 'newCreations', 4)])
  const result = await readMemeGraduation(fakeDb({ intel_meme_stage_snapshots: rows }), { days: 7 }, NOW)
  const recent = result.recent as Record<string, unknown>[]
  eq(recent.length, 50)
  eq(new Set(recent.map((r) => r.contractAddress)).size, 50, 'one row per contract')
  // Every key the page had before 20260917184100 is still here; the launchpad
  // source added provenance and bonding-curve fields beside them.
  eq(Object.keys(recent[0]).sort(), [
    'capturedAt', 'chain', 'completedAt', 'contractAddress', 'fdv', 'firstSeenAt', 'graduationPct',
    'launchpad', 'launchpadLabel', 'marketCap', 'migrationPool', 'name', 'source', 'stage', 'symbol',
  ])
})

Deno.test('a chain filter narrows every part of the answer', async () => {
  const db = fakeDb({
    intel_meme_stage_snapshots: [snapshot(SOL(1), 0, 'graduates', 4), snapshot('0x' + 'd'.repeat(40), 0, 'newCreations', 4, 'eip155:1')],
    intel_meme_stage_transitions: [move(SOL(1), 0, 'newCreations', 'graduates', 4), move('0x' + 'd'.repeat(40), 0, 'newCreations', 'graduates', 9, 'eip155:1')],
  })
  const all = await readMemeGraduation(db, { days: 7 }, NOW)
  eq(all.cohort, { firstSeenInWindow: 2, graduatedInWindow: 1 })
  eq((all.timeToGraduate as Record<string, unknown>).sample, 2)
  const solana = await readMemeGraduation(db, { days: 7, chain: 'solana' }, NOW)
  eq(solana.chain, 'solana')
  eq(solana.cohort, { firstSeenInWindow: 1, graduatedInWindow: 1 })
  eq(solana.graduationRate, 1)
  eq((solana.timeToGraduate as Record<string, unknown>).sample, 1)
  eq((solana.recent as unknown[]).length, 1)
})

Deno.test('days falls back to seven rather than widening the read', async () => {
  const db = fakeDb({ intel_meme_stage_snapshots: [snapshot(SOL(1), 0, 'newCreations', 1)] })
  eq((await readMemeGraduation(db, { days: 1 }, NOW)).days, 1)
  eq((await readMemeGraduation(db, { days: 7 }, NOW)).days, 7)
  eq((await readMemeGraduation(db, { days: 30 }, NOW)).days, 30)
  eq((await readMemeGraduation(db, { days: 365 }, NOW)).days, 7)
  eq((await readMemeGraduation(db, {}, NOW)).days, 7)
})

Deno.test('percentiles interpolate and a single sample is itself', () => {
  eq(percentile([], 0.5), null)
  eq(percentile([4], 0.5), 4)
  eq(percentile([1, 2, 3, 4], 0.5), 2.5)
  eq(percentile([1, 2, 3, 4], 0.25), 1.75)
  eq(percentile([1, 2, 3, 4], 0), 1)
  eq(percentile([1, 2, 3, 4], 1), 4)
})

Deno.test('the histogram ignores a negative or unreadable duration', () => {
  const buckets = histogram([0, -1, Number.NaN, 0.5, 500])
  eq(buckets[0].count, 2, 'zero and half an hour both fall in [0,1)')
  eq(buckets.at(-1)?.count, 1, '500 hours falls in the open-ended bucket')
  eq(buckets.reduce((sum, b) => sum + b.count, 0), 3)
})

Deno.test('the view is reachable as meme_graduation', async () => {
  eq(Object.keys(MEME_CAPTURE_VIEWS), ['meme_graduation'])
  const result = await MEME_CAPTURE_VIEWS.meme_graduation(fakeDb(), { days: 1 }, NOW)
  eq(result.view, 'meme_graduation')
})

Deno.test('one launch platform cannot fill the funnel sample or the head of recent', async () => {
  const flood = Array.from({ length: 30 }, (_, i) => ({ ...snapshot(SOL(i), 0, 'newCreations', 1), platform_id: 16 }))
  const others = Array.from({ length: 5 }, (_, i) => ({ ...snapshot(SOL(60 + i), 0, 'newCreations', 1), platform_id: 99 }))
  const older = { ...snapshot(SOL(90), 2, 'newCreations', 2), platform_id: 99 }
  const result = await readMemeGraduation(fakeDb({ intel_meme_stage_snapshots: [...flood, ...others, older] }), { days: 7 }, NOW)
  const funnel = result.funnel as Record<string, unknown>[]
  const sample = funnel[0].contracts as Record<string, unknown>[]
  eq(sample.length, FUNNEL_CONTRACTS, 'the fixed-size sample is never shorter')
  eq(sample.filter((c) => Number(String(c.contractAddress).slice(-2)) >= 60).length, 5, 'every other-platform contract reaches the sample')
  eq(funnel[0].count, 35, 'the count is still the true count')
  const recent = result.recent as Record<string, unknown>[]
  eq(recent.length, 36)
  const firstOther = recent.findIndex((r) => Number(String(r.contractAddress).slice(-2)) >= 60)
  eq(firstOther, 15, 'the other platform follows the flooding platform quota inside the same capture')
  eq(recent.at(-1)?.contractAddress, SOL(90), 'an older sighting is never moved ahead of a newer capture')
  eq(recent.slice(0, 35).every((r) => r.capturedAt === ago(0)), true)
})
