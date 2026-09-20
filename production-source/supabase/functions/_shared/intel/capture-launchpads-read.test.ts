// What the launchpad source ADDS to the `meme_graduation` read: the chain and
// launchpad filters, the per-pad and per-chain groupings, the source list and
// the CoinGecko attribution the paid terms require.
//
// The pre-existing behaviour of the view is pinned by capture-meme-read.test.ts;
// nothing here restates it, and the tests below assert that none of it moved.

import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { readMemeGraduation } from './capture-meme-read.ts'
import { COINGECKO_ATTRIBUTION, PAD_LABELS } from './launchpad-registry.ts'

const HOUR = 3_600_000
const NOW = Math.floor((Date.now() - 7 * 86_400_000) / HOUR) * HOUR
const ago = (hours: number) => new Date(NOW - hours * HOUR).toISOString()
const SOL = (n: number) => `So1111111111111111111111111111111111111111${String(n).padStart(2, '1')}`
const BSC = (n: number) => '0x' + String(n).padStart(2, '0').repeat(20)

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

interface Row { [key: string]: unknown }
const snapshot = (over: Row): Row => ({
  platform_id: null, chain: 'solana', captured_at: ago(0), stage: 'newCreations',
  name: 'Token', symbol: 'TKN', price: 0.001, market_cap: null, first_seen_at: ago(3),
  source: 'coingecko', launchpad: 'pump-fun', graduation_pct: 12, completed_at: null,
  migration_pool: null, fdv: 4321, ...over,
})
const move = (over: Row): Row => ({
  chain: 'solana', from_stage: 'newCreations', to_stage: 'graduates', at: ago(1),
  hours_since_first_seen: 4, source: 'coingecko', launchpad: 'pump-fun', ...over,
})

Deno.test('every row carries its source and its launchpad facts', async () => {
  const db = fakeDb({
    intel_meme_stage_snapshots: [snapshot({
      contract_address: SOL(1), stage: 'graduates', graduation_pct: 100,
      completed_at: '2026-09-17T13:40:57.000Z', migration_pool: 'DestPool', fdv: 9999,
    })],
  })
  const result = await readMemeGraduation(db, { days: 7 }, NOW)
  const funnel = result.funnel as Record<string, unknown>[]
  const row = (funnel.find((f) => f.stage === 'graduates')!.contracts as Record<string, unknown>[])[0]
  eq(row.source, 'coingecko')
  eq(row.launchpad, 'pump-fun')
  eq(row.launchpadLabel, PAD_LABELS['pump-fun'])
  eq(row.graduationPct, 100)
  eq(row.completedAt, '2026-09-17T13:40:57.000Z')
  eq(row.migrationPool, 'DestPool')
  eq(row.fdv, 9999)
  const recent = (result.recent as Record<string, unknown>[])[0]
  eq(recent.launchpadLabel, PAD_LABELS['pump-fun'])
  eq(recent.stage, 'graduates')
})

Deno.test('captures counts the distinct capture hours the window holds, in total and per group', async () => {
  const db = fakeDb({
    intel_meme_stage_snapshots: [
      // One contract seen in three consecutive hours, and one Four.meme contract
      // seen in exactly one of them.
      snapshot({ contract_address: SOL(1), captured_at: ago(0) }),
      snapshot({ contract_address: SOL(1), captured_at: ago(1) }),
      snapshot({ contract_address: SOL(1), captured_at: ago(2) }),
      snapshot({ contract_address: BSC(1), chain: 'eip155:56', launchpad: 'four-meme', captured_at: ago(2) }),
    ],
  })
  const result = await readMemeGraduation(db, { days: 7 }, NOW)
  // Three hours, four rows: a capture is an HOUR, never a row.
  eq(result.captures, 3)
  const pads = result.launchpads as Record<string, unknown>[]
  eq(pads.find((p) => p.key === 'pump-fun')!.captures, 3)
  eq(pads.find((p) => p.key === 'four-meme')!.captures, 1)
  const chains = result.chains as Record<string, unknown>[]
  eq(chains.find((c) => c.key === 'eip155:56')!.captures, 1)
  // An empty window has none, and says so rather than omitting the field.
  const empty = await readMemeGraduation(fakeDb({}), { days: 7 }, NOW)
  eq(empty.captures, 0)
})

Deno.test('a row written before the source column existed reads as a CoinMarketCap row, not as unknown', async () => {
  const bare = { platform_id: 16, chain: 'solana', contract_address: SOL(2), captured_at: ago(0), stage: 'newCreations', first_seen_at: ago(1) }
  const result = await readMemeGraduation(fakeDb({ intel_meme_stage_snapshots: [bare] }), { days: 7 }, NOW)
  eq(result.sources, [{ source: 'coinmarketcap', latestCapturedAt: ago(0), rows: 1 }])
  const row = ((result.funnel as Record<string, unknown>[])[0].contracts as Record<string, unknown>[])[0]
  eq(row.source, 'coinmarketcap')
  eq(row.launchpad, null)
  eq(row.launchpadLabel, null)
})

Deno.test('sources names every lane that wrote into the window with its own newest clock', async () => {
  const db = fakeDb({
    intel_meme_stage_snapshots: [
      snapshot({ contract_address: SOL(1), captured_at: ago(0) }),
      snapshot({ contract_address: SOL(2), captured_at: ago(2) }),
      snapshot({ contract_address: SOL(3), captured_at: ago(5), source: 'coinmarketcap', launchpad: null }),
    ],
  })
  const result = await readMemeGraduation(db, { days: 7 }, NOW)
  eq(result.sources, [
    { source: 'coingecko', latestCapturedAt: ago(0), rows: 2 },
    { source: 'coinmarketcap', latestCapturedAt: ago(5), rows: 1 },
  ])
})

Deno.test('the CoinGecko attribution is part of the payload, empty answers included', async () => {
  eq(COINGECKO_ATTRIBUTION.provider, 'coingecko')
  eq(COINGECKO_ATTRIBUTION.text, 'Powered by CoinGecko')
  eq(COINGECKO_ATTRIBUTION.url, 'https://www.coingecko.com')
  const filled = await readMemeGraduation(fakeDb({ intel_meme_stage_snapshots: [snapshot({ contract_address: SOL(1) })] }), {}, NOW)
  eq(filled.attribution, COINGECKO_ATTRIBUTION)
  // A page that shows nothing still has to be able to show the notice.
  const empty = await readMemeGraduation(fakeDb(), {}, NOW)
  eq(empty.attribution, COINGECKO_ATTRIBUTION)
  eq(empty.launchpads, [])
  eq(empty.chains, [])
  eq(empty.sources, [])
  eq(empty.asOf, null)
  eq(empty.reason, null)
})

Deno.test('per-launchpad stats never average two unrelated pads together', async () => {
  const db = fakeDb({
    intel_meme_stage_snapshots: [
      // Pump.fun: two contracts first seen in the window, one of them graduated.
      snapshot({ contract_address: SOL(1), stage: 'graduates', graduation_pct: 100 }),
      snapshot({ contract_address: SOL(2), stage: 'newCreations' }),
      // Four.meme on BNB Chain: one contract, no graduate.
      snapshot({ contract_address: BSC(1), chain: 'eip155:56', launchpad: 'four-meme', stage: 'aboutGraduates', graduation_pct: 92 }),
    ],
    intel_meme_stage_transitions: [move({ contract_address: SOL(1), hours_since_first_seen: 4 })],
  })
  const result = await readMemeGraduation(db, { days: 7 }, NOW)
  const pads = result.launchpads as Record<string, unknown>[]
  const pump = pads.find((p) => p.key === 'pump-fun')!
  const four = pads.find((p) => p.key === 'four-meme')!
  eq(pump.label, 'Pump.fun')
  eq(pump.chain, 'solana')
  eq(pump.contracts, 2)
  eq(pump.cohort, { firstSeenInWindow: 2, graduatedInWindow: 1 })
  eq(pump.graduationRate, 0.5)
  eq((pump.timeToGraduate as Record<string, unknown>).median, 4)
  eq((pump.timeToGraduate as Record<string, unknown>).sample, 1)
  eq(pump.funnel, [{ stage: 'newCreations', count: 1 }, { stage: 'aboutGraduates', count: 0 }, { stage: 'graduates', count: 1 }])
  eq(four.label, 'Four.meme')
  eq(four.chain, 'eip155:56')
  // A measured zero is a zero. Four.meme has a cohort and no graduates.
  eq(four.graduationRate, 0)
  eq(four.timeToGraduate, null, 'an unmeasurable distribution is null, never an invented median')
  // and the chain grouping is the same three numbers one level up.
  const chains = result.chains as Record<string, unknown>[]
  eq(chains.find((c) => c.key === 'solana')!.label, 'Solana')
  eq(chains.find((c) => c.key === 'eip155:56')!.label, 'BNB Chain')
  eq(chains.find((c) => c.key === 'eip155:56')!.cohort, { firstSeenInWindow: 1, graduatedInWindow: 0 })
})

Deno.test('a group with no contract first seen in the window reports a null rate, not a zero', async () => {
  const db = fakeDb({
    intel_meme_stage_snapshots: [snapshot({ contract_address: SOL(4), first_seen_at: ago(24 * 30), captured_at: ago(0) })],
  })
  const result = await readMemeGraduation(db, { days: 1 }, NOW)
  const pump = (result.launchpads as Record<string, unknown>[]).find((p) => p.key === 'pump-fun')!
  eq(pump.cohort, { firstSeenInWindow: 0, graduatedInWindow: 0 })
  eq(pump.graduationRate, null)
})

Deno.test('a launchpad filter narrows the snapshots, the transitions and every derived number', async () => {
  const db = fakeDb({
    intel_meme_stage_snapshots: [
      snapshot({ contract_address: SOL(1), stage: 'graduates' }),
      snapshot({ contract_address: BSC(1), chain: 'eip155:56', launchpad: 'four-meme', stage: 'newCreations' }),
    ],
    intel_meme_stage_transitions: [
      move({ contract_address: SOL(1), hours_since_first_seen: 4 }),
      move({ contract_address: BSC(1), chain: 'eip155:56', launchpad: 'four-meme', hours_since_first_seen: 40 }),
    ],
  })
  const result = await readMemeGraduation(db, { days: 7, launchpad: 'pump-fun' }, NOW)
  eq(result.launchpad, 'pump-fun')
  eq((result.launchpads as unknown[]).length, 1)
  eq((result.chains as Record<string, unknown>[]).map((c) => c.key), ['solana'])
  eq((result.timeToGraduate as Record<string, unknown>).sample, 1)
  eq((result.timeToGraduate as Record<string, unknown>).median, 4, 'the other pad cannot move this median')
  eq((result.recent as unknown[]).length, 1)
})

Deno.test('a source filter narrows the answer to one capture lane', async () => {
  const db = fakeDb({
    intel_meme_stage_snapshots: [
      snapshot({ contract_address: SOL(1) }),
      snapshot({ contract_address: SOL(2), source: 'coinmarketcap', launchpad: null }),
    ],
  })
  const result = await readMemeGraduation(db, { days: 7, source: 'coinmarketcap' }, NOW)
  eq(result.source, 'coinmarketcap')
  eq(result.sources, [{ source: 'coinmarketcap', latestCapturedAt: ago(0), rows: 1 }])
  eq((result.launchpads as unknown[]).length, 0, 'a CoinMarketCap row names no pad, so it groups into none')
})

Deno.test('the chain filter and every field the page had before this source still answer', async () => {
  const db = fakeDb({
    intel_meme_stage_snapshots: [
      snapshot({ contract_address: SOL(1), stage: 'graduates' }),
      snapshot({ contract_address: BSC(1), chain: 'eip155:56', launchpad: 'four-meme' }),
    ],
    intel_meme_stage_transitions: [move({ contract_address: SOL(1) })],
  })
  const result = await readMemeGraduation(db, { days: 7, chain: 'solana' }, NOW)
  for (const key of ['view', 'days', 'chain', 'funnel', 'graduationRate', 'cohort', 'timeToGraduate', 'retention', 'recent', 'asOf', 'coverage', 'reason']) {
    assert(Object.hasOwn(result, key), `the pre-existing field ${key} disappeared`)
  }
  eq(result.view, 'meme_graduation')
  eq(result.chain, 'solana')
  eq(result.graduationRate, 1)
  eq((result.chains as Record<string, unknown>[]).map((c) => c.key), ['solana'])
})
