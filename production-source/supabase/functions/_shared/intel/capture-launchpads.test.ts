import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  captureLaunchpadStages, classifyStage, readLaunchpadDetails, normalizeAddress, splitTokenId,
  poolsFrom, tokensFrom, dexIdsFrom, chunk, mergeExisting, launchpadPolicy, trackedContracts,
  LAUNCHPAD_CAPTURE_OPS, LAUNCHPAD_NETWORKS, LAUNCHPAD_PADS, LAUNCHPAD_REJECTED, LAUNCHPAD_JOB,
  LAUNCHPAD_SOURCE, LAUNCHPAD_POLICY_PROVIDER, LAUNCHPAD_MAX_CALLS, KEYLESS_MAX_CALLS,
  NEW_POOL_PAGES, NEW_POOL_PAGE_CEILING, REGISTRY_PAGES, TOKENS_PER_CALL, GRADUATION_NEAR_PCT,
} from './capture-launchpads.ts'
import type { LaunchpadNetwork } from './capture-launchpads.ts'
import { PAD_LABELS } from './launchpad-registry.ts'

const HOUR = 3_600_000
const NOW = new Date(Math.floor((Date.now() - 7 * 86_400_000) / HOUR) * HOUR)
const CAPTURED = NOW.toISOString()
const hourBefore = (n: number) => new Date(NOW.getTime() - n * HOUR).toISOString()

const SOLANA = LAUNCHPAD_NETWORKS.find((n) => n.network === 'solana')! as LaunchpadNetwork
const S1 = '6JL8po5CKmmcLRQN912udcQNLMhaa56C9X6cUDBX1yq6'
const S2 = 'AZ3rVyLvWFAF9tYVY9n6LeSuvAhfCGKr1tcGux3spump'
const S3 = '7tZhRrsDusUvifQsADNHuaKkGtHyXhfxSkf4ZiPSpump'
const POOL = 'WwBZ6dqyCPYWSh37D7rNYaM7GznVmipv7H3JVaieU58'

/** Minimal PostgREST-shaped fake: eq/lt/gte/in filters, order, limit and upsert.
 * Copied from capture-meme.test.ts, which is where the two lanes' shared write
 * contract is already pinned. */
// deno-lint-ignore no-explicit-any
function fakeDb(tables: Record<string, any[]> = {}, writes: Record<string, any[]> = {}, errors: Record<string, string> = {}) {
  const compare = (a: unknown, b: unknown) => {
    const [x, y] = [Number(a), Number(b)]
    return Number.isFinite(x) && Number.isFinite(y) ? x - y : String(a ?? '').localeCompare(String(b ?? ''))
  }
  return {
    upserts: writes,
    tables,
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
            if (op === 'lt') return compare(v, operand) < 0
            if (op === 'gte') return compare(v, operand) >= 0
            // deno-lint-ignore no-explicit-any
            if (op === 'in') return (operand as any[]).some((o) => String(o) === String(v))
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
        lt: (k: string, v: any) => { filters.push([k, 'lt', v]); return q },
        // deno-lint-ignore no-explicit-any
        gte: (k: string, v: any) => { filters.push([k, 'gte', v]); return q },
        // deno-lint-ignore no-explicit-any
        in: (k: string, v: any[]) => { filters.push([k, 'in', v]); return q },
        // deno-lint-ignore no-explicit-any
        order: (column: string, options: any = {}) => { ordering = { column, ascending: options?.ascending !== false }; return q },
        limit: (max: number) => Promise.resolve(run(max)),
        // deno-lint-ignore no-explicit-any
        upsert: (rows: any[]) => { (writes[table] ||= []).push(...rows); (tables[table] ||= []).push(...rows); return Promise.resolve({ error: null }) },
      }
      return q
    },
  }
}

const ctxFor = (name: string, maxCalls: number) => ({ jobName: 'test', caller: name, kind: 'job' as const, maxCalls })

interface AskLog { path: string; endpoint: string; cacheKey: string; ctx: unknown; ttlMs?: number }
// deno-lint-ignore no-explicit-any
function fakeOnchain(route: (path: string) => any) {
  const calls: AskLog[] = []
  // deno-lint-ignore no-explicit-any
  const onchain = (path: string, opts: any) => {
    calls.push({ path, endpoint: opts.endpoint, cacheKey: opts.cacheKey, ctx: opts.ctx, ttlMs: opts.ttlMs })
    return Promise.resolve(route(path))
  }
  return { calls, onchain }
}

const deps = (onchain: ReturnType<typeof fakeOnchain>['onchain'], extra: Record<string, unknown> = {}) => ({
  request: () => Promise.resolve(null),
  onchain,
  tier: 'geckoterminal' as const,
  sleep: () => Promise.resolve(),
  ...extra,
})

const pool = (dex: string, address: string, poolAddress = POOL) => ({
  id: `solana_${poolAddress}`,
  attributes: { address: poolAddress, pool_created_at: hourBefore(1), base_token_price_usd: '0.0001', market_cap_usd: null, fdv_usd: '1234.5' },
  relationships: { dex: { data: { id: dex } }, base_token: { data: { id: `solana_${address}` } } },
})
const token = (address: string, details: Record<string, unknown> | null, extra: Record<string, unknown> = {}) => ({
  attributes: {
    address, name: 'Name', symbol: 'SYM', price_usd: '0.0001', market_cap_usd: null, fdv_usd: '1234.5',
    launchpad_details: details, ...extra,
  },
})
const registry = (ids: string[]) => ({ data: ids.map((id) => ({ id })) })
/** Base58 has no 0, O, I or l, so a generated address has to be built out of the
 * alphabet the CHECK actually accepts or the lane correctly drops it. */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const solAddress = (i: number) => S1.slice(0, -2) + B58[Math.floor(i / 58) % 58] + B58[i % 58]

/** Answers every network but solana with an empty-but-successful registry, so a
 * test can think about one network without the other three looking broken. */
function soloSolana(route: (path: string) => unknown) {
  return (path: string) => {
    if (!path.startsWith('networks/solana/') && !path.startsWith('pools/')) return registry([])
    return route(path)
  }
}

// ─── stage rules ─────────────────────────────────────────────────────────────

Deno.test('the three stage rules, the 80 threshold, a null percentage and a completed token', () => {
  const at = (pct: number | null, completed: boolean | null) =>
    classifyStage({ graduationPct: pct, completed, completedAt: null, migrationPool: null, outOfBand: false })
  eq(GRADUATION_NEAR_PCT, 80)
  eq(at(0, false), 'newCreations')
  eq(at(79.999, false), 'newCreations')
  eq(at(80, false), 'aboutGraduates', 'the threshold is inclusive')
  eq(at(99.9, false), 'aboutGraduates')
  eq(at(100, true), 'graduates')
  eq(at(12, true), 'graduates', 'completed wins over any percentage')
  // A pad with no bonding curve publishes no percentage. "We do not know how far
  // along it is" is a new creation, never a near-graduate.
  eq(at(null, false), 'newCreations')
  eq(at(null, null), 'newCreations')
  // Verified live on 2026-09-17: pump-fun publishes small negative percentages
  // at the very start of a curve.
  eq(at(-4.8, false), 'newCreations')
})

Deno.test('a tracked token seen on a graduation destination is a graduate even without a completed flag', () => {
  const details = { graduationPct: null, completed: null, completedAt: null, migrationPool: null, outOfBand: false }
  eq(classifyStage(details, false), 'newCreations')
  eq(classifyStage(details, true), 'graduates')
})

Deno.test('launchpad_details is read without repair, and an out-of-band percentage becomes null rather than a clamp', () => {
  const read = readLaunchpadDetails({ graduation_percentage: 100, completed: true, completed_at: '2026-09-17T13:40:57.000Z', migrated_destination_pool_address: POOL })
  eq(read.graduationPct, 100)
  eq(read.completed, true)
  eq(read.completedAt, '2026-09-17T13:40:57.000Z')
  eq(read.migrationPool, POOL)
  eq(read.outOfBand, false)

  const negative = readLaunchpadDetails({ graduation_percentage: -4.8, completed: false })
  eq(negative.graduationPct, -4.8, 'a published negative is stored, not floored to zero')
  eq(negative.outOfBand, false)

  const wild = readLaunchpadDetails({ graduation_percentage: 4200, completed: false })
  eq(wild.graduationPct, null)
  eq(wild.outOfBand, true)

  const none = readLaunchpadDetails(null)
  eq(none, { graduationPct: null, completed: null, completedAt: null, migrationPool: null, outOfBand: false })
})

// ─── response readers ────────────────────────────────────────────────────────

Deno.test('an address the tables would reject is dropped, never repaired', () => {
  eq(normalizeAddress('evm', '0x' + 'A'.repeat(40)), '0x' + 'a'.repeat(40), 'EVM addresses are lowercased')
  eq(normalizeAddress('evm', '0x' + 'z'.repeat(40)), null)
  eq(normalizeAddress('evm', '0xabc'), null)
  eq(normalizeAddress('solana', S1), S1)
  eq(normalizeAddress('solana', '0Ol'), null)
  eq(normalizeAddress('solana', ''), null)
  eq(splitTokenId('solana', `solana_${S1}`), S1)
  eq(splitTokenId('solana', `bsc_${S1}`), null, 'a row from another network is never filed under this one')
  eq(splitTokenId('solana', null), null)
})

Deno.test('only pools on an allowed dex with a usable base token survive', () => {
  const payload = {
    data: [
      pool('pump-fun', S1),
      pool('some-other-amm', S2),
      { ...pool('pump-fun', S3), relationships: { dex: { data: { id: 'pump-fun' } }, base_token: { data: { id: 'solana_!!bad!!' } } } },
    ],
  }
  const read = poolsFrom(payload, SOLANA, new Set(['pump-fun']))
  eq(read.pools.length, 1)
  eq(read.pools[0].tokenAddress, S1)
  eq(read.pools[0].dex, 'pump-fun')
  eq(read.pools[0].fdv, 1234.5)
  eq(read.dropped, 2)
  eq(poolsFrom(null, SOLANA, new Set(['pump-fun'])), { pools: [], dropped: 0 })
})

Deno.test('tokens/multi is read into typed facts and dex registry pages into ids', () => {
  const read = tokensFrom({ data: [token(S1, { graduation_percentage: 6.03, completed: false }), token('nope!', null)] }, SOLANA)
  eq(read.tokens.length, 1)
  eq(read.tokens[0].address, S1)
  eq(read.tokens[0].fdv, 1234.5)
  eq(read.tokens[0].marketCap, null, 'a null market cap stays null before graduation')
  eq(read.tokens[0].details.graduationPct, 6.03)
  eq(read.dropped, 1)
  eq(dexIdsFrom(registry(['pump-fun', 'pumpswap'])), ['pump-fun', 'pumpswap'])
  eq(dexIdsFrom(null), [])
  eq(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
})

// ─── the registry is evidence, not decoration ────────────────────────────────

Deno.test('a pad the live dex registry does not name writes nothing and is reported as rejected', async () => {
  const writes: Record<string, unknown[]> = {}
  const fake = fakeOnchain(soloSolana((path) => {
    // The registry answers, and deliberately omits pump-fun.
    if (path.startsWith('networks/solana/dexes')) return registry(['raydium', 'orca'])
    if (path.startsWith('networks/solana/new_pools')) return { data: [pool('pump-fun', S1)] }
    return { data: [token(S1, { graduation_percentage: 10, completed: false })] }
  }))
  const result = await captureLaunchpadStages(fakeDb({}, writes), ctxFor, NOW, 'basic', deps(fake.onchain))
  eq(result.rows, 0)
  eq(writes.intel_meme_stage_snapshots, undefined, 'no row is written for an unconfirmed pad')
  const solana = (result.networks as Record<string, unknown>[]).find((n) => n.network === 'solana')!
  eq(solana.state, 'empty')
  eq(solana.reason, 'no_confirmed_launchpads')
  eq(solana.confirmedPads, [])
  assert((solana.rejectedPads as string[]).includes('pump-fun'))
  assert(!fake.calls.some((c) => c.path.startsWith('networks/solana/new_pools')), 'an unconfirmed network is never asked for pools')
})

Deno.test('a dex registry that does not answer stops the network entirely rather than trusting the hard-coded list', async () => {
  const writes: Record<string, unknown[]> = {}
  const fake = fakeOnchain(soloSolana((path) => path.startsWith('networks/solana/dexes') ? null : { data: [pool('pump-fun', S1)] }))
  const result = await captureLaunchpadStages(fakeDb({}, writes), ctxFor, NOW, 'basic', deps(fake.onchain))
  const solana = (result.networks as Record<string, unknown>[]).find((n) => n.network === 'solana')!
  eq(solana.state, 'registry_unavailable')
  eq(solana.reason, 'dex_registry_unavailable')
  eq(writes.intel_meme_stage_snapshots, undefined)
  eq(result.error, 'launchpad_sources_unavailable')
})

Deno.test('the registry read is cached for a day and every call carries the logging context', async () => {
  const fake = fakeOnchain(soloSolana((path) =>
    path.startsWith('networks/solana/dexes') ? registry(['pump-fun']) : path.startsWith('networks/solana/new_pools') ? { data: [] } : { data: [] }))
  await captureLaunchpadStages(fakeDb(), ctxFor, NOW, 'basic', deps(fake.onchain))
  const registryCall = fake.calls.find((c) => c.path === 'networks/solana/dexes?page=1')!
  eq(registryCall.endpoint, '/onchain/networks/{network}/dexes')
  eq(registryCall.ttlMs, 24 * 3600_000)
  // The ctx is what carries `supabase` into marketAssetsGet, which is what
  // writes the provider_call_logs receipt. A call without it spends silently.
  for (const call of fake.calls) assert(call.ctx != null, `${call.path} was asked without a receipt context`)
  for (const call of fake.calls) assert(call.cacheKey.length > 0)
})

// ─── bounds ──────────────────────────────────────────────────────────────────

Deno.test('new_pools paging stops at the lane bound even when every page is full', async () => {
  const full = { data: Array.from({ length: 20 }, (_, i) => pool('pump-fun', solAddress(i))) }
  const fake = fakeOnchain(soloSolana((path) => {
    if (path.startsWith('networks/solana/dexes')) return registry(['pump-fun'])
    if (path.startsWith('networks/solana/new_pools')) return full
    return { data: [] }
  }))
  await captureLaunchpadStages(fakeDb(), ctxFor, NOW, 'basic', deps(fake.onchain))
  const pages = fake.calls.filter((c) => c.path.startsWith('networks/solana/new_pools'))
  eq(pages.length, NEW_POOL_PAGES)
  assert(NEW_POOL_PAGES <= NEW_POOL_PAGE_CEILING)
  eq(pages.at(-1)!.path, `networks/solana/new_pools?page=${NEW_POOL_PAGES}`)
})

Deno.test('registry paging stops at its bound, and a short page ends it early', async () => {
  const fullRegistry = registry(Array.from({ length: 20 }, (_, i) => `dex-${i}`).concat(['pump-fun']))
  const many = fakeOnchain(soloSolana((path) => path.startsWith('networks/solana/dexes') ? fullRegistry : { data: [] }))
  await captureLaunchpadStages(fakeDb(), ctxFor, NOW, 'basic', deps(many.onchain))
  eq(many.calls.filter((c) => c.path.startsWith('networks/solana/dexes')).length, REGISTRY_PAGES)

  const short = fakeOnchain(soloSolana((path) => path.startsWith('networks/solana/dexes') ? registry(['pump-fun']) : { data: [] }))
  await captureLaunchpadStages(fakeDb(), ctxFor, NOW, 'basic', deps(short.onchain))
  eq(short.calls.filter((c) => c.path.startsWith('networks/solana/dexes')).length, 1)
})

Deno.test('the call ceiling stops the run and the run says so instead of reporting an empty source', async () => {
  const writes: Record<string, unknown[]> = {}
  const fake = fakeOnchain(soloSolana((path) => {
    if (path.startsWith('networks/solana/dexes')) return registry(['pump-fun'])
    if (path.startsWith('networks/solana/new_pools')) return { data: [pool('pump-fun', S1)] }
    return { data: [token(S1, { graduation_percentage: 10, completed: false })] }
  }))
  const result = await captureLaunchpadStages(fakeDb({}, writes), (n, _m) => ctxFor(n, 2), NOW, 'basic', deps(fake.onchain))
  eq(fake.calls.length, 2, 'the ceiling is the number of calls, not a suggestion')
  eq(result.skipped, 'call_budget')
  eq(writes.intel_meme_stage_snapshots, undefined)
  // A keyless run is capped below the policy ceiling because the public host's
  // allowance is shared.
  assert(KEYLESS_MAX_CALLS < LAUNCHPAD_MAX_CALLS)
})

Deno.test('addresses are batched thirty at a time', async () => {
  const addresses = Array.from({ length: 31 }, (_, i) => solAddress(i))
  const fake = fakeOnchain(soloSolana((path) => {
    if (path.startsWith('networks/solana/dexes')) return registry(['pump-fun'])
    if (path.startsWith('networks/solana/new_pools')) return { data: addresses.map((a) => pool('pump-fun', a)) }
    return { data: [] }
  }))
  await captureLaunchpadStages(fakeDb(), ctxFor, NOW, 'basic', deps(fake.onchain))
  const batches = fake.calls.filter((c) => c.path.includes('/tokens/multi/'))
  eq(batches.length, 2)
  eq(batches[0].path.split('/tokens/multi/')[1].split(',').length, TOKENS_PER_CALL)
  eq(batches[1].path.split('/tokens/multi/')[1].split(',').length, 1)
})

// ─── writes ──────────────────────────────────────────────────────────────────

const solanaRun = (tokens: Record<string, unknown>[], pools = [pool('pump-fun', S1)]) => soloSolana((path) => {
  if (path.startsWith('networks/solana/dexes')) return registry(['pump-fun', 'pumpswap'])
  if (path.startsWith('networks/solana/new_pools')) return { data: pools }
  if (path.includes('/tokens/multi/')) return { data: tokens }
  return { data: [] }
})

Deno.test('a first sighting writes a snapshot and no transition', async () => {
  const writes: Record<string, unknown[]> = {}
  const fake = fakeOnchain(solanaRun([token(S1, { graduation_percentage: 6.03, completed: false })]))
  const result = await captureLaunchpadStages(fakeDb({}, writes), ctxFor, NOW, 'basic', deps(fake.onchain))
  eq(result.rows, 1)
  const row = writes.intel_meme_stage_snapshots[0] as Record<string, unknown>
  eq(row.chain, 'solana')
  eq(row.contract_address, S1)
  eq(row.captured_at, CAPTURED)
  eq(row.stage, 'newCreations')
  eq(row.source, LAUNCHPAD_SOURCE)
  eq(row.launchpad, 'pump-fun')
  eq(row.graduation_pct, 6.03)
  eq(row.platform_id, null, 'the CMC DEX platform id is never invented')
  eq(row.first_seen_at, CAPTURED, 'a contract we have never seen is first seen now')
  eq(row.fdv, 1234.5)
  eq(row.completed_at, null)
  eq(writes.intel_meme_stage_transitions, undefined, 'there is no stage to move from')
})

Deno.test('a stage that moves writes a transition, carries first_seen_at forward and keeps the source clock', async () => {
  const writes: Record<string, unknown[]> = {}
  const db = fakeDb({
    intel_meme_stage_snapshots: [{
      chain: 'solana', contract_address: S2, captured_at: hourBefore(3), stage: 'newCreations',
      first_seen_at: hourBefore(5), source: LAUNCHPAD_SOURCE, launchpad: 'pump-fun',
    }],
  }, writes)
  const fake = fakeOnchain(solanaRun([token(S2, {
    graduation_percentage: 100, completed: true, completed_at: '2026-09-17T13:40:57.000Z', migrated_destination_pool_address: POOL,
  })], [pool('pump-fun', S2)]))
  const result = await captureLaunchpadStages(db, ctxFor, NOW, 'basic', deps(fake.onchain))
  eq(result.rows, 1)
  const snapshot = writes.intel_meme_stage_snapshots[0] as Record<string, unknown>
  eq(snapshot.stage, 'graduates')
  eq(snapshot.first_seen_at, hourBefore(5))
  eq(snapshot.completed_at, '2026-09-17T13:40:57.000Z', 'the SOURCE clock, never our capture hour')
  eq(snapshot.migration_pool, POOL)
  const move = writes.intel_meme_stage_transitions[0] as Record<string, unknown>
  eq(move.from_stage, 'newCreations')
  eq(move.to_stage, 'graduates')
  eq(move.at, CAPTURED)
  eq(move.hours_since_first_seen, 5)
  eq(move.source, LAUNCHPAD_SOURCE)
  eq(move.launchpad, 'pump-fun')
})

Deno.test('a stage that stays put writes no transition', async () => {
  const writes: Record<string, unknown[]> = {}
  const db = fakeDb({
    intel_meme_stage_snapshots: [{
      chain: 'solana', contract_address: S1, captured_at: hourBefore(1), stage: 'newCreations',
      first_seen_at: hourBefore(1), source: LAUNCHPAD_SOURCE, launchpad: 'pump-fun',
    }],
  }, writes)
  const fake = fakeOnchain(solanaRun([token(S1, { graduation_percentage: 6, completed: false })]))
  await captureLaunchpadStages(db, ctxFor, NOW, 'basic', deps(fake.onchain))
  eq(writes.intel_meme_stage_transitions, undefined)
})

Deno.test('a graduation is observed by re-polling a contract that has left the pad feed', async () => {
  const writes: Record<string, unknown[]> = {}
  const db = fakeDb({
    intel_meme_stage_snapshots: [{
      chain: 'solana', contract_address: S3, captured_at: hourBefore(2), stage: 'aboutGraduates',
      first_seen_at: hourBefore(4), source: LAUNCHPAD_SOURCE, launchpad: 'pump-fun',
    }],
  }, writes)
  // new_pools no longer carries S3 at all: it graduated and left the feed. The
  // destination AMM pool is what names it, and the lane re-polls it anyway.
  const fake = fakeOnchain(solanaRun(
    [token(S3, { graduation_percentage: null, completed: null })],
    [pool('pumpswap', S3, 'DestinationPool11111111111111111111111111111')],
  ))
  const result = await captureLaunchpadStages(db, ctxFor, NOW, 'basic', deps(fake.onchain))
  eq(result.rows, 1)
  const snapshot = writes.intel_meme_stage_snapshots[0] as Record<string, unknown>
  eq(snapshot.stage, 'graduates')
  eq(snapshot.launchpad, 'pump-fun', 'the pad it came from, not the AMM it moved to')
  eq(snapshot.migration_pool, 'DestinationPool11111111111111111111111111111')
  eq(snapshot.completed_at, null, 'the source published no time, so none is invented')
  eq((writes.intel_meme_stage_transitions[0] as Record<string, unknown>).to_stage, 'graduates')
})

Deno.test('a destination pool for a contract we do not track invents nothing', async () => {
  const writes: Record<string, unknown[]> = {}
  const fake = fakeOnchain(solanaRun([], [pool('pumpswap', S2, 'DestinationPool11111111111111111111111111111')]))
  const result = await captureLaunchpadStages(fakeDb({}, writes), ctxFor, NOW, 'basic', deps(fake.onchain))
  eq(result.rows, 0)
  eq(writes.intel_meme_stage_snapshots, undefined)
  assert(!fake.calls.some((c) => c.path.includes('/tokens/multi/')), 'an untracked AMM listing is not a cohort member')
})

Deno.test('a row another source already wrote for this hour is merged, never overwritten', async () => {
  const writes: Record<string, unknown[]> = {}
  const existing = {
    platform_id: 16, chain: 'solana', contract_address: S1, captured_at: CAPTURED, stage: 'aboutGraduates',
    name: 'CMC Name', symbol: 'CMC', price: 9, market_cap: 5, first_seen_at: hourBefore(6),
    source: 'coinmarketcap', launchpad: null, graduation_pct: null, completed_at: null, migration_pool: null, fdv: null,
  }
  const db = fakeDb({ intel_meme_stage_snapshots: [existing] }, writes)
  const fake = fakeOnchain(solanaRun([token(S1, { graduation_percentage: 12, completed: false })]))
  const result = await captureLaunchpadStages(db, ctxFor, NOW, 'basic', deps(fake.onchain))
  const row = writes.intel_meme_stage_snapshots[0] as Record<string, unknown>
  eq(row.source, 'coinmarketcap', 'the first writer keeps the row')
  eq(row.stage, 'aboutGraduates', 'the stage is not ours to move')
  eq(row.name, 'CMC Name')
  eq(row.price, 9)
  eq(row.platform_id, 16)
  eq(row.launchpad, 'pump-fun', 'a NULL field is filled')
  eq(row.graduation_pct, 12)
  eq(row.fdv, 1234.5)
  eq(result.merged, 1)
  eq(writes.intel_meme_stage_transitions, undefined, 'a merged row never writes a transition')
})

Deno.test('mergeExisting fills only nulls', () => {
  const merged = mergeExisting(
    { source: 'coinmarketcap', stage: 'newCreations', launchpad: null, fdv: 2, name: null },
    { source: 'coingecko', stage: 'graduates', launchpad: 'pump-fun', fdv: 99, name: 'Mine' },
  )
  eq(merged.source, 'coinmarketcap')
  eq(merged.stage, 'newCreations')
  eq(merged.launchpad, 'pump-fun')
  eq(merged.fdv, 2)
  eq(merged.name, 'Mine')
})

// ─── policy and cadence ──────────────────────────────────────────────────────

Deno.test('the lane reads its own coingecko policy row, and a disabled row actually disables it', async () => {
  const fake = fakeOnchain(solanaRun([token(S1, { graduation_percentage: 6, completed: false })]))
  const db = fakeDb({
    provider_schedule_policy: [{ provider: LAUNCHPAD_POLICY_PROVIDER, feature: LAUNCHPAD_JOB, cadence_seconds: 3600, enabled: false, max_credits: 40 }],
  })
  const result = await captureLaunchpadStages(db, ctxFor, NOW, 'basic', deps(fake.onchain))
  eq(result.skipped, 'policy_disabled')
  eq(fake.calls.length, 0)
  // A coinmarketcap row of the same name must not reach this lane.
  eq(launchpadPolicy([{ provider: 'coinmarketcap', feature: LAUNCHPAD_JOB, enabled: false }]).enabled, true)
  eq(launchpadPolicy(undefined), { enabled: true, cadenceSeconds: 3600, maxCalls: LAUNCHPAD_MAX_CALLS })
  eq(launchpadPolicy([{ provider: 'coingecko', feature: LAUNCHPAD_JOB, cadence_seconds: 900, enabled: true, max_credits: 7 }]),
    { enabled: true, cadenceSeconds: 900, maxCalls: 7 })
})

Deno.test('a CoinGecko capture inside the cadence is skipped, and a CoinMarketCap one is not mistaken for ours', async () => {
  const fresh = fakeOnchain(solanaRun([]))
  const skipped = await captureLaunchpadStages(
    fakeDb({ intel_meme_stage_snapshots: [{ chain: 'solana', contract_address: S1, captured_at: new Date(NOW.getTime() - 5 * 60_000).toISOString(), source: LAUNCHPAD_SOURCE, stage: 'newCreations', first_seen_at: hourBefore(1) }] }),
    ctxFor, NOW, 'basic', deps(fresh.onchain))
  eq(skipped.skipped, 'within_cadence')
  eq(fresh.calls.length, 0)

  const other = fakeOnchain(solanaRun([token(S1, { graduation_percentage: 6, completed: false })]))
  const ran = await captureLaunchpadStages(
    fakeDb({ intel_meme_stage_snapshots: [{ chain: 'solana', contract_address: S2, captured_at: new Date(NOW.getTime() - 5 * 60_000).toISOString(), source: 'coinmarketcap', stage: 'newCreations', first_seen_at: hourBefore(1) }] }),
    ctxFor, NOW, 'basic', deps(other.onchain))
  eq(ran.skipped, undefined)
  eq(ran.rows, 1)
})

// ─── megafilter ──────────────────────────────────────────────────────────────

Deno.test('megafilter is probed once on a keyed host and the whole run falls back when it refuses', async () => {
  const fake = fakeOnchain(soloSolana((path) => {
    if (path.startsWith('pools/megafilter')) return null
    if (path.includes('/dexes')) return registry(['pump-fun'])
    if (path.includes('/new_pools')) return { data: [] }
    return { data: [] }
  }))
  await captureLaunchpadStages(fakeDb(), ctxFor, NOW, 'basic', deps(fake.onchain, { tier: 'pro' }))
  eq(fake.calls.filter((c) => c.path.startsWith('pools/megafilter')).length, 1, 'an unentitled key costs one call a run, not one per network')
  assert(fake.calls.some((c) => c.path.startsWith('networks/solana/new_pools')))
})

Deno.test('a keyless run never asks for megafilter at all', async () => {
  const fake = fakeOnchain(solanaRun([]))
  await captureLaunchpadStages(fakeDb(), ctxFor, NOW, 'basic', deps(fake.onchain))
  eq(fake.calls.filter((c) => c.path.startsWith('pools/megafilter')).length, 0)
})

// ─── the tracked re-poll ─────────────────────────────────────────────────────

Deno.test('tracked contracts exclude graduates and are grouped by the network their chain names', async () => {
  const rows = [
    { source: LAUNCHPAD_SOURCE, chain: 'solana', contract_address: S1, launchpad: 'pump-fun', stage: 'newCreations', captured_at: hourBefore(1) },
    { source: LAUNCHPAD_SOURCE, chain: 'solana', contract_address: S2, launchpad: 'pump-fun', stage: 'graduates', captured_at: hourBefore(1) },
    { source: LAUNCHPAD_SOURCE, chain: 'eip155:56', contract_address: '0x' + 'a'.repeat(40), launchpad: 'four-meme', stage: 'aboutGraduates', captured_at: hourBefore(2) },
    { source: LAUNCHPAD_SOURCE, chain: 'eip155:999', contract_address: '0x' + 'b'.repeat(40), launchpad: 'nope', stage: 'newCreations', captured_at: hourBefore(2) },
    { source: 'coinmarketcap', chain: 'solana', contract_address: S3, launchpad: null, stage: 'newCreations', captured_at: hourBefore(1) },
  ]
  const tracked = await trackedContracts(fakeDb({ intel_meme_stage_snapshots: rows }), CAPTURED)
  eq(tracked.byNetwork.get('solana')?.map((t) => t.address), [S1], 'graduates and rows another source owns are not re-polled')
  eq(tracked.byNetwork.get('bsc')?.length, 1)
  eq(tracked.byNetwork.get('base'), undefined)
  eq(tracked.reason, null)
})

// ─── the registry as a claim ─────────────────────────────────────────────────

Deno.test('every covered pad names a known network and a human label, and nothing is both covered and rejected', () => {
  const networks = new Set(LAUNCHPAD_NETWORKS.map((n) => n.network))
  const covered = new Set(LAUNCHPAD_PADS.map((p) => p.dex))
  eq(LAUNCHPAD_PADS.length, new Set(LAUNCHPAD_PADS.map((p) => `${p.network}|${p.dex}`)).size)
  for (const pad of LAUNCHPAD_PADS) {
    assert(networks.has(pad.network), `${pad.dex} names an unknown network`)
    assert(pad.label && pad.label !== pad.dex, `${pad.dex} has no human label`)
    eq(PAD_LABELS[pad.dex], pad.label)
  }
  for (const rejected of LAUNCHPAD_REJECTED) {
    assert(!covered.has(rejected.dex), `${rejected.dex} is both covered and rejected`)
    assert(rejected.reason.length > 0)
  }
  // Every network must have at least one pad, or it is a network we ask about
  // for nothing.
  for (const network of LAUNCHPAD_NETWORKS) {
    assert(LAUNCHPAD_PADS.some((p) => p.network === network.network && p.role === 'pad'), `${network.network} has no launchpad`)
  }
  eq(LAUNCHPAD_CAPTURE_OPS.launchpad_stages !== undefined, true)
  eq(Object.keys(LAUNCHPAD_CAPTURE_OPS), [LAUNCHPAD_JOB])
})

Deno.test('the lane is reachable through its op with the lane-op signature', async () => {
  const writes: Record<string, unknown[]> = {}
  const fake = fakeOnchain(solanaRun([token(S1, { graduation_percentage: 90, completed: false })]))
  const result = await LAUNCHPAD_CAPTURE_OPS.launchpad_stages(fakeDb({}, writes), ctxFor, NOW, 'basic', deps(fake.onchain))
  eq(result.job, LAUNCHPAD_JOB)
  eq(result.credits, 0, 'this lane spends no CoinMarketCap credit')
  eq((writes.intel_meme_stage_snapshots[0] as Record<string, unknown>).stage, 'aboutGraduates')
})

Deno.test('a failing write is reported, never thrown', async () => {
  const fake = fakeOnchain(solanaRun([token(S1, { graduation_percentage: 6, completed: false })]))
  const db = fakeDb({}, {}, {})
  // deno-lint-ignore no-explicit-any
  const broken: any = { from: (table: string) => table === 'intel_meme_stage_snapshots' ? { ...db.from(table), upsert: () => Promise.resolve({ error: { message: 'nope' } }) } : db.from(table) }
  const result = await captureLaunchpadStages(broken, ctxFor, NOW, 'basic', deps(fake.onchain))
  eq(result.error, 'nope')
  eq(result.rows, 0)
})
