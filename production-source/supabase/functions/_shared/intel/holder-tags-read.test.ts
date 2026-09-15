import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  captureHour, compareHolderTags, logSpacedBins, orderTags, readHolderCohort, readHolderTags,
  realizedSummary, HOLDER_TAG_CAPTURE_MAX, HOLDER_TAG_ROW_CAP, REALIZED_BIN_COUNT,
} from './holder-tags-read.ts'
import { HOLDER_COHORT_TABLE, HOLDER_TAG_TABLE } from './holder-tags.ts'

const CHAIN = 'eip155:8453'
const ADDRESS = `0x${'ab'.repeat(20)}`
const NOW = Math.floor((Date.now() - 3 * 86_400_000) / 3_600_000) * 3_600_000
const hourBack = (n: number) => new Date(NOW - n * 3_600_000).toISOString()
const evm = (n: number) => `0x${n.toString(16).padStart(40, '0')}`

/** Minimal PostgREST-shaped fake; every read chain ends in `.limit()`. */
// deno-lint-ignore no-explicit-any
function fakeDb(tables: Record<string, any[]> = {}, errors: Record<string, string> = {}) {
  const reads: { table: string; limit: number }[] = []
  return {
    reads,
    from(table: string) {
      // deno-lint-ignore no-explicit-any
      const filters: [string, string, any][] = []
      let ordering: { column: string; ascending: boolean } | null = null
      // deno-lint-ignore no-explicit-any
      const q: any = {
        select: () => q,
        // deno-lint-ignore no-explicit-any
        eq: (k: string, v: any) => { filters.push([k, 'eq', v]); return q },
        // deno-lint-ignore no-explicit-any
        gte: (k: string, v: any) => { filters.push([k, 'gte', v]); return q },
        order: (column: string, options?: { ascending?: boolean }) => { ordering = { column, ascending: options?.ascending !== false }; return q },
        limit: (max: number) => {
          reads.push({ table, limit: max })
          if (errors[table]) return Promise.resolve({ data: null, error: { message: errors[table] } })
          let rows = (tables[table] || []).filter((row) => filters.every(([k, op, v]) =>
            op === 'eq' ? String(row?.[k] ?? '') === String(v ?? '') : String(row?.[k] ?? '') >= String(v ?? '')))
          if (ordering) rows = [...rows].sort((a, b) => String(a?.[ordering!.column] ?? '').localeCompare(String(b?.[ordering!.column] ?? '')) * (ordering!.ascending ? 1 : -1))
          return Promise.resolve({ data: rows.slice(0, max), error: null })
        },
      }
      return q
    },
  }
}

const tagRow = (capturedAt: string, tag: string, holderCount: number, balance: number, ratio: number) =>
  ({ chain: CHAIN, contract_address: ADDRESS, captured_at: capturedAt, tag, holder_count: holderCount, balance, ratio, ratio_unit: 'unknown' })
// deno-lint-ignore no-explicit-any
const cohortRow = (capturedAt: string, tag: string, wallet: string, realized: number | null, extra: Record<string, any> = {}) =>
  ({ chain: CHAIN, contract_address: ADDRESS, captured_at: capturedAt, tag, wallet_address: wallet,
    balance: 100, percent: 1, buy_volume_usd: 10, sell_volume_usd: 5, realized_pnl_usd: realized, funding_source: 'bridge',
    first_seen_at: null, last_seen_at: null, ...extra })

// ── the clock ────────────────────────────────────────────────────────────────

Deno.test('a capture stamp is always an hour mark, and rubbish is not a stamp', () => {
  eq(captureHour('2026-09-15T14:32:09.500Z'), '2026-09-15T14:00:00.000Z')
  eq(captureHour('2026-09-15T14:00:00.000Z'), '2026-09-15T14:00:00.000Z')
  eq(captureHour('not a date'), null)
  eq(captureHour(null), null)
  eq(captureHour(true), null)
  eq(captureHour(''), null)
})

Deno.test('tags read in registry order, with anything new after them', () => {
  eq(orderTags(['tag_whale', 'tag_dev', 'tag_zzz_new', 'tag_bot']), ['tag_dev', 'tag_whale', 'tag_bot', 'tag_zzz_new'])
})

// ── histogram ────────────────────────────────────────────────────────────────

Deno.test('one sign takes all ten bins; both signs split them and never straddle zero', () => {
  const positive = logSpacedBins([1, 10, 100, 1000], REALIZED_BIN_COUNT, 1)
  eq(positive.length, 10)
  eq(positive.reduce((n, b) => n + b.count, 0), 4)
  assert(positive.every((b) => b.from > 0 && b.to > 0))
  assert(positive.every((b, i) => i === 0 || b.from >= positive[i - 1].to - 1e-9), 'bins ascend')
  eq(positive[0].from, 1)
  eq(positive.at(-1)!.to, 1000)

  const negative = logSpacedBins([1, 1000], REALIZED_BIN_COUNT, -1)
  eq(negative.length, 10)
  assert(negative.every((b) => b.from < 0 && b.to < 0))
  eq(negative[0].from, -1000, 'the most negative bin reads first')
  eq(negative.at(-1)!.to, -1)

  const both = realizedSummary([-1, -100, 1, 100])
  eq(both.histogram.length, 10, 'five bins a side when both signs are present')
  eq(both.histogram.filter((b) => b.to < 0).length, 5)
  eq(both.histogram.filter((b) => b.from > 0).length, 5)
  assert(both.histogram.every((b) => (b.from < 0) === (b.to < 0)), 'no bin crosses zero')
})

Deno.test('a side with one magnitude is one bin, not ten identical ones', () => {
  eq(logSpacedBins([42, 42, 42], REALIZED_BIN_COUNT, 1), [{ from: 42, to: 42, count: 3 }])
  eq(logSpacedBins([], REALIZED_BIN_COUNT, 1), [])
})

Deno.test('unknown realized gains are counted, never binned, and zero is not a profit', () => {
  const summary = realizedSummary([400, -25, 0, null, undefined, 'n/a', NaN])
  eq(summary.inProfit, 1)
  eq(summary.atLoss, 1)
  eq(summary.flat, 1, 'an explicit zero is a real answer with its own count')
  eq(summary.unknown, 4, 'a gain the provider did not report is not break-even')
  eq(summary.histogram.reduce((n, b) => n + b.count, 0), 2, 'only the two signed values are binned')
})

Deno.test('a cohort with nothing readable has an empty histogram, not a zero bar', () => {
  const summary = realizedSummary([null, null])
  eq(summary, { inProfit: 0, atLoss: 0, flat: 0, unknown: 2, histogram: [] })
})

// ── tag history ──────────────────────────────────────────────────────────────

Deno.test('captures come back chronological with the newest as latest', async () => {
  const db = fakeDb({ [HOLDER_TAG_TABLE]: [
    tagRow(hourBack(2), 'tag_whale', 3, 90, 4.5), tagRow(hourBack(2), 'tag_dev', 2, 10, 0.5),
    tagRow(hourBack(0), 'tag_dev', 5, 40, 2), tagRow(hourBack(0), 'tag_whale', 1, 9, 0.9),
  ] })
  const result = await readHolderTags(db, { chain: CHAIN, address: ADDRESS }, NOW) as any
  eq(result.view, 'holder_tags')
  eq(result.subject, `${CHAIN}:${ADDRESS}`)
  eq(result.days, 30)
  eq(result.captures.map((c: any) => c.capturedAt), [hourBack(2), hourBack(0)])
  eq(result.captures[0].tags.map((t: any) => t.tag), ['tag_dev', 'tag_whale'], 'registry order, not provider order')
  eq(result.captures[0].tags[0], { tag: 'tag_dev', holderCount: 2, balance: 10, ratio: 0.5 })
  eq(result.latest.capturedAt, hourBack(0))
  eq(result.asOf, hourBack(0))
  eq(result.coverage, { from: hourBack(2), to: hourBack(0), count: 4, truncated: false })
  eq(result.ratioUnit, 'unknown')
  eq(result.reason, null)
  eq(db.reads[0].limit, HOLDER_TAG_ROW_CAP)
})

Deno.test('an empty table is an empty series, never an error', async () => {
  const result = await readHolderTags(fakeDb(), { chain: CHAIN, address: ADDRESS }, NOW) as any
  eq(result.captures, [])
  eq(result.latest, null)
  eq(result.asOf, null)
  eq(result.coverage, { from: null, to: null, count: 0, truncated: false })
  eq(result.reason, null)
})

Deno.test('a failed read is reported on an empty series', async () => {
  const result = await readHolderTags(fakeDb({}, { [HOLDER_TAG_TABLE]: 'permission denied' }), { chain: CHAIN, address: ADDRESS }, NOW) as any
  eq(result.captures, [])
  eq(result.reason, 'permission denied')
})

Deno.test('an unverified contract identity is answered, not queried', async () => {
  const db = fakeDb()
  const result = await readHolderTags(db, { chain: 'eip155:999999', address: ADDRESS }, NOW) as any
  eq(result.reason, 'unverified_contract_identity')
  eq(result.subject, null)
  eq(db.reads.length, 0)
})

Deno.test('too many captures keep the newest and say the window was truncated', async () => {
  const rows = Array.from({ length: HOLDER_TAG_CAPTURE_MAX + 5 }, (_, i) => tagRow(hourBack(i), 'tag_dev', i, i, i))
  const result = await readHolderTags(fakeDb({ [HOLDER_TAG_TABLE]: rows }), { chain: CHAIN, address: ADDRESS, days: 90 }, NOW) as any
  eq(result.days, 90)
  eq(result.captures.length, HOLDER_TAG_CAPTURE_MAX)
  eq(result.captures.at(-1).capturedAt, hourBack(0), 'the newest capture survives the cap')
  eq(result.coverage.truncated, true)
})

Deno.test('the window only accepts offered days and falls back to thirty', async () => {
  const old = tagRow(new Date(NOW - 40 * 86_400_000).toISOString(), 'tag_dev', 1, 1, 1)
  const fresh = tagRow(hourBack(1), 'tag_dev', 2, 2, 2)
  const db = fakeDb({ [HOLDER_TAG_TABLE]: [old, fresh] })
  eq(((await readHolderTags(db, { chain: CHAIN, address: ADDRESS, days: 5000 }, NOW)) as any).days, 30)
  eq(((await readHolderTags(db, { chain: CHAIN, address: ADDRESS }, NOW)) as any).captures.length, 1, 'a capture outside the window is outside the window')
  eq(((await readHolderTags(db, { chain: CHAIN, address: ADDRESS, days: 90 }, NOW)) as any).captures.length, 2)
})

// ── cohort ───────────────────────────────────────────────────────────────────

Deno.test('with no stamp the newest capture is read, grouped by tag with its realized shape', async () => {
  const db = fakeDb({ [HOLDER_COHORT_TABLE]: [
    cohortRow(hourBack(5), 'tag_dev', evm(1), 10),
    cohortRow(hourBack(0), 'tag_whale', evm(2), -100),
    cohortRow(hourBack(0), 'tag_whale', evm(3), 100),
    cohortRow(hourBack(0), 'tag_dev', evm(4), null),
  ] })
  const result = await readHolderCohort(db, { chain: CHAIN, address: ADDRESS }) as any
  eq(result.view, 'holder_cohort')
  eq(result.capturedAt, hourBack(0))
  eq(result.asOf, hourBack(0))
  eq(result.tags.map((t: any) => t.tag), ['tag_dev', 'tag_whale'])
  eq(result.tags[0].wallets, [{ walletAddress: evm(4), balance: 100, percent: 1, buyVolumeUsd: 10, sellVolumeUsd: 5, realizedPnlUsd: null, fundingSource: 'bridge' }])
  eq(result.tags[0].realized.unknown, 1)
  eq(result.tags[0].realized.histogram, [])
  eq(result.tags[1].realized.inProfit, 1)
  eq(result.tags[1].realized.atLoss, 1)
  eq(result.tags[1].realized.histogram.length, 2, 'one magnitude a side is one bin a side')
  eq(result.coverage, { from: hourBack(0), to: hourBack(0), count: 3, truncated: false })
  // Wallet rows are addresses and figures. Nothing here can name a person.
  for (const t of result.tags) for (const w of t.wallets) eq(Object.keys(w).sort(), ['balance', 'buyVolumeUsd', 'fundingSource', 'percent', 'realizedPnlUsd', 'sellVolumeUsd', 'walletAddress'])
})

Deno.test('a requested stamp is floored to its hour and a requested tag narrows the read', async () => {
  const db = fakeDb({ [HOLDER_COHORT_TABLE]: [
    cohortRow(hourBack(2), 'tag_dev', evm(1), 10),
    cohortRow(hourBack(2), 'tag_whale', evm(2), 20),
  ] })
  const picked = await readHolderCohort(db, { chain: CHAIN, address: ADDRESS, capturedAt: new Date(NOW - 2 * 3_600_000 + 41 * 60_000).toISOString() }) as any
  eq(picked.capturedAt, hourBack(2))
  eq(picked.tags.length, 2)
  const single = await readHolderCohort(db, { chain: CHAIN, address: ADDRESS, capturedAt: hourBack(2), tag: 'tag_whale' }) as any
  eq(single.tag, 'tag_whale')
  eq(single.tags.map((t: any) => t.tag), ['tag_whale'])
})

Deno.test('an unknown tag is refused rather than silently widened', async () => {
  const db = fakeDb({ [HOLDER_COHORT_TABLE]: [cohortRow(hourBack(1), 'tag_dev', evm(1), 1)] })
  const result = await readHolderCohort(db, { chain: CHAIN, address: ADDRESS, tag: 'tag_made_up' }) as any
  eq(result.reason, 'unknown_holder_tag')
  eq(result.tags, [])
  eq(db.reads.length, 0)
})

Deno.test('a contract with no capture at all says so', async () => {
  const result = await readHolderCohort(fakeDb(), { chain: CHAIN, address: ADDRESS }) as any
  eq(result.capturedAt, null)
  eq(result.reason, 'no_capture')
  eq(result.tags, [])
  eq(result.asOf, null)
})

// ── compare ──────────────────────────────────────────────────────────────────

Deno.test('two captures compare per tag, and a missing side has no delta', () => {
  const a = { capturedAt: hourBack(24), tags: [
    { tag: 'tag_dev', holderCount: 2, balance: 10, ratio: 0.5 },
    { tag: 'tag_whale', holderCount: 4, balance: 90, ratio: 4.5 },
  ] }
  const b = { capturedAt: hourBack(0), tags: [
    { tag: 'tag_dev', holderCount: 5, balance: 4, ratio: 0.25 },
    { tag: 'tag_bot', holderCount: 7, balance: 1, ratio: 0.1 },
  ] }
  const result = compareHolderTags(a, b) as any
  eq(result.view, 'holder_tag_compare')
  eq(result.from, hourBack(24))
  eq(result.to, hourBack(0))
  eq(result.reason, null)
  eq(result.tags.map((t: any) => t.tag), ['tag_dev', 'tag_whale', 'tag_bot'])
  eq(result.tags[0].holderCountDelta, 3)
  eq(result.tags[0].balanceDelta, -6)
  eq(result.tags[0].ratioDelta, -0.25)
  // A tag that vanished, and one that appeared: both sides stay visible, neither invents a change.
  eq(result.tags[1].to, null)
  eq(result.tags[1].holderCountDelta, null)
  eq(result.tags[2].from, null)
  eq(result.tags[2].holderCountDelta, null)
  eq(result.tags[2].to.holderCount, 7)
})

Deno.test('an unmeasured number on either side is not a delta of zero', () => {
  const result = compareHolderTags(
    { capturedAt: hourBack(2), tags: [{ tag: 'tag_dev', holderCount: null, balance: 10, ratio: null }] },
    { capturedAt: hourBack(0), tags: [{ tag: 'tag_dev', holderCount: 4, balance: 10, ratio: 1 }] },
  ) as any
  eq(result.tags[0].holderCountDelta, null)
  eq(result.tags[0].balanceDelta, 0, 'an unchanged measured number IS a zero delta')
  eq(result.tags[0].ratioDelta, null)
})

Deno.test('comparing against a capture we do not hold says one side is missing', () => {
  const only = { capturedAt: hourBack(0), tags: [{ tag: 'tag_dev', holderCount: 1, balance: 1, ratio: 1 }] }
  const result = compareHolderTags(null, only) as any
  eq(result.from, null)
  eq(result.to, hourBack(0))
  eq(result.reason, 'one_side_missing')
  eq(result.tags[0].holderCountDelta, null)
  eq(compareHolderTags(undefined, undefined).reason, 'one_side_missing')
})
