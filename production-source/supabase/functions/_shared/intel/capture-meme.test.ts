import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  captureMemeStages, MEME_SOURCE, memeCandidates, stageBreakdown, hoursBetween, MEME_CAPTURE_OPS,
  MEME_PLATFORM_ORDER, MEME_LIMIT, MEME_MAX_CALLS, MEME_PLATFORM_ID, MEME_PROTOCOLS, MEME_STAGES,
} from './capture-meme.ts'
import { cmcParams, cmcRequestBody } from '../market-assets/cmc-capabilities.ts'
import { validateCmcDexResponse } from '../market-assets/cmc-dex.ts'

const HOUR = 3_600_000
// A week in the past keeps every stamp behind the real clock.
const NOW = new Date(Math.floor((Date.now() - 7 * 86_400_000) / HOUR) * HOUR)
const CAPTURED = NOW.toISOString()
const hourBefore = (n: number) => new Date(NOW.getTime() - n * HOUR).toISOString()
const EVM = '0x' + 'b'.repeat(40)
const EVM2 = '0x' + 'c'.repeat(40)
const SOL = 'So11111111111111111111111111111111111111112'

/** Minimal PostgREST-shaped fake: eq/lt/gte/in filters, order, limit and upsert. */
// deno-lint-ignore no-explicit-any
function fakeDb(tables: Record<string, any[]> = {}, writes: Record<string, any[]> = {}, errors: Record<string, string> = {}) {
  const compare = (a: unknown, b: unknown) => {
    const [x, y] = [Number(a), Number(b)]
    return Number.isFinite(x) && Number.isFinite(y) ? x - y : String(a ?? '').localeCompare(String(b ?? ''))
  }
  return {
    upserts: writes,
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
// deno-lint-ignore no-explicit-any
function fakeRequest(handler: (name: string, params: Record<string, unknown>) => any) {
  const calls: { name: string; params: Record<string, unknown> }[] = []
  // deno-lint-ignore no-explicit-any
  const request = (name: string, params: Record<string, unknown> = {}, _ctx?: any) => {
    calls.push({ name, params })
    return Promise.resolve(handler(name, params))
  }
  return { request, calls }
}

/** A `/v1/dex/meme/list` row, in the provider's short-key shape. */
const memeRow = (platformId: number, addr: string, sym: string, price = 0.002, mcap = 50_000) =>
  ({ pid: platformId, addr, n: `${sym} token`, sym, p: price, pt: NOW.getTime(), mcap })
const memePayload = (stages: Partial<Record<typeof MEME_STAGES[number], unknown[]>>) =>
  ({ data: { newCreations: stages.newCreations ?? [], aboutGraduates: stages.aboutGraduates ?? [], graduates: stages.graduates ?? [] } })
const ok = (payload: unknown) => ({ payload, state: 'fresh', reason: null, provenance: { provider: 'coinmarketcap', fetchedAt: CAPTURED } })

/** Every launchpad answers the same board. Rows are merged by contract, so the
 * same answer twice is the same contracts once. */
const board = (rows: Partial<Record<typeof MEME_STAGES[number], unknown[]>>) =>
  fakeRequest(() => ok(memePayload(rows)))
/** A different board per launchpad protocol, which is what the provider does. */
const boards = (byProtocol: Record<number, Partial<Record<typeof MEME_STAGES[number], unknown[]>>>) =>
  fakeRequest((_name, params) => ok(memePayload(byProtocol[Number(params.protocol)] ?? {})))
const protocolLines = (result: Record<string, unknown>) => result.protocols as Record<string, unknown>[]

Deno.test('one call per launchpad protocol, each with the platform and the documented `limit`', async () => {
  const { request, calls } = board({ newCreations: [memeRow(16, SOL, 'AAA')] })
  const db = fakeDb()
  const result = await captureMemeStages(db, ctxFor, NOW, 'startup', { request, policy: [] })
  // Pump.fun and Moonshot: the launchpads whose code the provider publishes and
  // whose chain this platform verifies. Four.meme (2001) is on BNB, so it is not asked.
  eq(MEME_MAX_CALLS, 2)
  eq(MEME_PROTOCOLS.map((p) => p.protocol), [1001, 1002])
  eq(MEME_PROTOCOLS.some((p) => p.protocol === 2001), false, 'Four.meme launches on a chain this platform does not verify')
  eq(calls.length, 2, 'the board is published per launchpad; asking without one answered empty')
  eq(calls.map((c) => c.name), ['dexMeme', 'dexMeme'])
  eq(calls.map((c) => Number(c.params.protocol)), [1001, 1002])
  for (const call of calls) {
    eq(Number(call.params.limit), MEME_LIMIT)
    // `platformIds` is still sent: dropping it is what the 403 streak followed.
    eq(String(call.params.platformIds), String(MEME_PLATFORM_ID))
    // The fields the endpoint never read are still not sent.
    eq(Object.keys(call.params).some((k) => ['interval', 'pageSize', 'nextPageIndex'].includes(k)), false)
  }
  eq(result.credits, 2, 'one credit per launchpad asked')
  eq(result.calls, 2)
  // The same contract from two launchpads is one contract, not two rows.
  eq(result.rows, 1)
  eq(protocolLines(result).map((p) => [p.protocol, p.state, p.rows]), [[1001, 'captured', 1], [1002, 'captured', 1]])
  eq(MEME_PLATFORM_ORDER, ['solana', 'base', 'ethereum', 'arbitrum'])
})

Deno.test('each launchpad answers on its own line, and the furthest stage wins across them', async () => {
  const writes: Record<string, unknown[]> = {}
  // Pump.fun reports the contract as a new creation; Moonshot reports the same
  // contract as a graduate, and a second contract of its own.
  const { request, calls } = boards({
    1001: { newCreations: [memeRow(16, SOL, 'AAA')] },
    1002: { graduates: [memeRow(16, SOL, 'AAA'), memeRow(1, EVM, 'BBB')] },
  })
  const result = await captureMemeStages(fakeDb({}, writes), ctxFor, NOW, 'startup', { request, policy: [] })
  eq(calls.length, 2)
  eq(result.rows, 2)
  const rows = writes.intel_meme_stage_snapshots as Record<string, unknown>[]
  eq(rows.find((r) => r.contract_address === SOL)?.stage, 'graduates', 'the furthest stage wins across launchpads')
  eq(protocolLines(result).map((p) => [p.launchpad, p.state, p.rows]), [['pump_fun', 'captured', 1], ['moonshot', 'captured', 2]])
})

Deno.test('a launchpad that answers nothing says so beside one that answered', async () => {
  const { request } = boards({ 1001: { graduates: [memeRow(16, SOL, 'AAA')] }, 1002: {} })
  const result = await captureMemeStages(fakeDb(), ctxFor, NOW, 'startup', { request, policy: [] })
  eq(result.rows, 1)
  // A still-empty launchpad is named, with its own reason, so the run says WHICH
  // question was asked and what came back rather than looking silent.
  eq(protocolLines(result).map((p) => [p.protocol, p.state, p.reason]), [[1001, 'captured', null], [1002, 'empty', 'provider_reported_empty']])
})

Deno.test('a narrowed call budget stops at the launchpads it may ask, and says which it skipped', async () => {
  const { request, calls } = board({ newCreations: [memeRow(16, SOL, 'AAA')] })
  const result = await captureMemeStages(fakeDb(), (name, _max) => ctxFor(name, 1), NOW, 'startup', { request, policy: [] })
  eq(calls.length, 1, 'the lane never asks one launchpad more than its budget')
  eq(result.credits, 1)
  eq(protocolLines(result).map((p) => [p.protocol, p.state, p.reason]), [[1001, 'captured', null], [1002, 'skipped', 'call_budget']])
})

Deno.test('the registry sends the platform and the documented limit, and nothing else', () => {
  // The fields this endpoint never read stay refused.
  for (const key of ['interval', 'pageSize', 'nextPageIndex']) {
    let threw = ''
    try { cmcParams('dexMeme', { [key]: '16' }) } catch (e) { threw = (e as Error).message }
    eq(threw, `invalid_parameter:${key}`, key)
  }
  // An unverified platform is refused rather than asked about.
  let platform = ''
  try { cmcParams('dexMeme', { platformIds: '56' }) } catch (e) { platform = (e as Error).message }
  eq(platform, 'unverified_dex_platform')
  // Only a PUBLISHED launchpad code may be asked for; anything else is refused
  // rather than guessed at.
  let protocol = ''
  try { cmcParams('dexMeme', { protocol: 42 }) } catch (e) { protocol = (e as Error).message }
  eq(protocol, 'unverified_meme_protocol')
  // The registry accepts every published code, including the one this lane does
  // not ask about: which launchpads to ask is the lane's decision, not the
  // transport's, and the transport never defaults one.
  eq(cmcParams('dexMeme', { protocol: 2001 }).protocol, '2001')
  // The shape that is sent: a verified platform id and the documented limit.
  eq(cmcParams('dexMeme', {}), { platformIds: String(MEME_PLATFORM_ID), limit: String(MEME_LIMIT) })
  // `limit` and `protocol` are int32 in the body; `platformIds` travels as the
  // string the other discovery bodies use, the shape the provider answered 200 to.
  eq(cmcRequestBody('dexMeme', cmcParams('dexMeme', {})), { platformIds: String(MEME_PLATFORM_ID), limit: MEME_LIMIT })
  eq(cmcRequestBody('dexMeme', cmcParams('dexMeme', { protocol: 1001 })), { platformIds: String(MEME_PLATFORM_ID), protocol: 1001, limit: MEME_LIMIT })
  eq(cmcRequestBody('dexMeme', cmcParams('dexMeme', { platformIds: '199', protocol: 1002, limit: 10 })), { platformIds: '199', protocol: 1002, limit: 10 })
})

Deno.test('the validator accepts a multi-chain board and rejects an unbounded or malformed one', () => {
  const params = cmcParams('dexMeme', {})
  // Rows from a chain we do not verify are a LEGAL answer here: no platform was pinned.
  eq(validateCmcDexResponse('dexMeme', memePayload({ newCreations: [memeRow(16, SOL, 'AAA'), { pid: 56, addr: 'bnb-token-1' }] }), params), true)
  // A row claiming a verified platform must carry a valid address for it.
  eq(validateCmcDexResponse('dexMeme', memePayload({ newCreations: [memeRow(16, EVM, 'AAA')] }), params), false)
  // A missing stage array, and a page longer than the limit, are both rejected.
  eq(validateCmcDexResponse('dexMeme', { data: { newCreations: [], graduates: [] } }, params), false)
  eq(validateCmcDexResponse('dexMeme', memePayload({ newCreations: Array.from({ length: 3 }, () => memeRow(16, SOL, 'AAA')) }), { limit: '2' }), false)
  // An unbounded question has no bounded answer.
  eq(validateCmcDexResponse('dexMeme', memePayload({}), {}), false)
  eq(validateCmcDexResponse('dexMeme', memePayload({}), params), true, 'an empty board is a valid answer')
})

Deno.test('stage detection keeps the furthest stage when one response names a contract twice', () => {
  const payload = memePayload({
    newCreations: [memeRow(16, SOL, 'AAA')],
    graduates: [memeRow(16, SOL, 'AAA')],
  })
  const { candidates } = memeCandidates(payload)
  eq(candidates.length, 1)
  eq(candidates[0].stage, 'graduates')
  eq(candidates[0].chain, 'solana')
  eq(candidates[0].address, SOL)
  eq(candidates[0].platform, 'solana')
})

Deno.test('a row is attributed to the platform it names, and an unverified chain is dropped', () => {
  const mixed = memeCandidates(memePayload({ newCreations: [memeRow(199, EVM, 'BBB'), memeRow(16, SOL, 'AAA')] }))
  eq(mixed.candidates.map((c) => c.platform).sort(), ['base', 'solana'])
  eq(mixed.dropped, 0)
  // BNB Chain is not one of the four verified networks; the row is dropped, never repaired.
  const bnb = memeCandidates(memePayload({ newCreations: [{ pid: 56, addr: EVM, n: 'x', sym: 'X' }] }))
  eq(bnb.candidates.length, 0)
  eq(bnb.dropped, 1)
})

Deno.test('a first sighting sets first_seen_at to this hour and writes no transition', async () => {
  const writes: Record<string, unknown[]> = {}
  const { request } = board({ newCreations: [memeRow(16, SOL, 'AAA')] })
  const db = fakeDb({}, writes)
  const result = await captureMemeStages(db, ctxFor, NOW, 'startup', { request, policy: [] })
  const snapshot = (writes.intel_meme_stage_snapshots as Record<string, unknown>[])[0]
  eq(snapshot.first_seen_at, CAPTURED)
  eq(snapshot.captured_at, CAPTURED)
  eq(snapshot.stage, 'newCreations')
  eq(snapshot.platform_id, 16)
  eq(snapshot.chain, 'solana')
  eq(writes.intel_meme_stage_transitions, undefined, 'there is no stage to move from')
  eq(result.transitions, 0)
})

Deno.test('first_seen_at is carried forward and a changed stage writes a transition', async () => {
  const writes: Record<string, unknown[]> = {}
  const db = fakeDb({
    intel_meme_stage_snapshots: [
      { chain: 'solana', contract_address: SOL, captured_at: hourBefore(5), stage: 'newCreations', first_seen_at: hourBefore(5) },
      { chain: 'solana', contract_address: SOL, captured_at: hourBefore(1), stage: 'aboutGraduates', first_seen_at: hourBefore(5) },
    ],
  }, writes)
  const { request } = board({ graduates: [memeRow(16, SOL, 'AAA')] })
  const result = await captureMemeStages(db, ctxFor, NOW, 'startup', { request, policy: [] })
  const snapshot = (writes.intel_meme_stage_snapshots as Record<string, unknown>[])[0]
  eq(snapshot.first_seen_at, hourBefore(5), 'the first sighting is five hours ago, not now')
  eq(snapshot.stage, 'graduates')
  const move = (writes.intel_meme_stage_transitions as Record<string, unknown>[])[0]
  eq(move.from_stage, 'aboutGraduates', 'the move is from the NEWEST previous snapshot')
  eq(move.to_stage, 'graduates')
  eq(move.at, CAPTURED)
  eq(move.hours_since_first_seen, 5)
  eq(result.transitions, 1)
})

Deno.test('a stage that did not change writes no transition', async () => {
  const writes: Record<string, unknown[]> = {}
  const db = fakeDb({
    intel_meme_stage_snapshots: [{ chain: 'solana', contract_address: SOL, captured_at: hourBefore(1), stage: 'newCreations', first_seen_at: hourBefore(3) }],
  }, writes)
  const { request } = board({ newCreations: [memeRow(16, SOL, 'AAA')] })
  const result = await captureMemeStages(db, ctxFor, NOW, 'startup', { request, policy: [] })
  eq(result.transitions, 0)
  eq(writes.intel_meme_stage_transitions, undefined)
})

Deno.test('re-running the same hour is idempotent: the run never reads its own rows back', async () => {
  const tables: Record<string, unknown[]> = {}
  const first: Record<string, unknown[]> = {}
  const { request } = board({ newCreations: [memeRow(16, SOL, 'AAA')] })
  // deno-lint-ignore no-explicit-any
  const db = fakeDb(tables as any, first)
  await captureMemeStages(db, ctxFor, NOW, 'startup', { request, policy: [] })
  const second: Record<string, unknown[]> = {}
  const { request: request2 } = board({ graduates: [memeRow(16, SOL, 'AAA')] })
  // deno-lint-ignore no-explicit-any
  const db2 = fakeDb(tables as any, second, {})
  // The cadence guard is what normally stops an overlapping run; shorten it and
  // run half an hour later — the same capture hour — to prove the hour itself is
  // safe to rewrite.
  const later = new Date(NOW.getTime() + 30 * 60_000)
  const result = await captureMemeStages(db2, ctxFor, later, 'startup', { request: request2, policy: [{ feature: 'meme_stages', cadence_seconds: 1, enabled: true }] })
  eq(result.rows, 1)
  const rewritten = (second.intel_meme_stage_snapshots as Record<string, unknown>[])[0]
  eq(rewritten.captured_at, CAPTURED)
  eq(rewritten.first_seen_at, CAPTURED, 'the hour it already wrote is not its own predecessor')
  eq(second.intel_meme_stage_transitions, undefined, 'rewriting an hour invents no transition')
})

Deno.test('the cadence guard skips a run inside the hour', async () => {
  const { request, calls } = board({ newCreations: [memeRow(16, SOL, 'AAA')] })
  // `source` is on the fixture because it is NOT NULL DEFAULT 'coinmarketcap' on
  // the table: a row this lane wrote always carries it, and the guard now filters
  // on it so another lane's row cannot stop this one.
  const db = fakeDb({ intel_meme_stage_snapshots: [{ chain: 'solana', contract_address: SOL, captured_at: new Date(NOW.getTime() - 60_000).toISOString(), stage: 'newCreations', first_seen_at: hourBefore(2), source: MEME_SOURCE }] })
  const result = await captureMemeStages(db, ctxFor, NOW, 'startup', { request, policy: [] })
  eq(result.skipped, 'within_cadence')
  eq(calls.length, 0)
  eq(result.credits, 0)
})

Deno.test('a disabled policy row skips the lane', async () => {
  const { request, calls } = board({ newCreations: [memeRow(16, SOL, 'AAA')] })
  const result = await captureMemeStages(fakeDb(), ctxFor, NOW, 'startup', { request, policy: [{ feature: 'meme_stages', enabled: false }] })
  eq(result.skipped, 'policy_disabled')
  eq(calls.length, 0)
})

Deno.test('below Startup the lane spends nothing', async () => {
  const { request, calls } = board({ newCreations: [memeRow(16, SOL, 'AAA')] })
  const result = await captureMemeStages(fakeDb(), ctxFor, NOW, 'builder', { request, policy: [] })
  eq(result.skipped, 'plan_below_startup')
  eq(result.credits, 0)
  eq(calls.length, 0)
})

Deno.test('a provider that does not answer is an error, never a stored zero', async () => {
  const writes: Record<string, unknown[]> = {}
  const { request } = fakeRequest(() => ({ payload: null, state: 'unavailable', reason: 'provider_unavailable' }))
  const result = await captureMemeStages(fakeDb({}, writes), ctxFor, NOW, 'startup', { request, policy: [] })
  eq(result.rows, 0)
  eq(result.error, 'provider_unavailable', 'a failed run is never silent')
  eq(result.skipped, undefined, 'an unavailable provider is not a clean skip')
  eq(writes.intel_meme_stage_snapshots, undefined, 'nothing is written when nothing was read')
  const platforms = result.platforms as Record<string, unknown>[]
  eq(platforms.map((p) => p.state), ['unavailable', 'unavailable', 'unavailable', 'unavailable'])
})

Deno.test('a refusal already remembered by the transport costs the lane nothing', async () => {
  // The transport holds an entitlement refusal in its negative cache for six
  // hours, so the hourly run is answered without a provider call. The receipt
  // says where the answer came from, and the lane must not report a credit for it.
  const { request, calls } = fakeRequest(() => ({
    payload: null, state: 'unavailable', reason: 'insufficient_entitlement',
    receipt: { capability: 'dexMeme', origin: 'negative-cache', httpStatus: 403, creditCount: null },
  }))
  const result = await captureMemeStages(fakeDb(), ctxFor, NOW, 'startup', { request, policy: [] })
  eq(calls.length, 2, 'the lane still asks; the transport is what declines to spend')
  eq(result.credits, 0, 'a remembered refusal is not an hourly credit')
  eq(result.rows, 0)
  eq(result.error, 'insufficient_entitlement', 'the refusal keeps its own name on the result')
})

Deno.test('an empty board is an honest empty capture with its reason, not a no-op', async () => {
  const writes: Record<string, unknown[]> = {}
  const { request, calls } = board({})
  const result = await captureMemeStages(fakeDb({}, writes), ctxFor, NOW, 'startup', { request, policy: [] })
  eq(calls.length, 2, 'the credits were spent, so the run is reported')
  eq(result.rows, 0)
  eq(result.credits, 2)
  eq(result.skipped, 'provider_reported_empty')
  eq(protocolLines(result).every((p) => p.state === 'empty' && p.reason === 'provider_reported_empty'), true)
  eq(result.error, undefined, 'an empty answer is not a failure')
  assert(result.capturedAt, 'the empty capture still names the hour it covers')
  eq(writes.intel_meme_stage_snapshots, undefined)
  // Every platform and every stage is still accounted for, as a zero with a reason.
  const stages = result.stages as Record<string, unknown>[]
  eq(stages.length, 12)
  eq(stages.every((s) => s.rows === 0 && s.reason === 'provider_reported_empty'), true)
})

Deno.test('a board of unverified chains only says so rather than reading as empty', async () => {
  const { request } = board({ newCreations: [{ pid: 56, addr: EVM, n: 'x', sym: 'X' }] })
  const result = await captureMemeStages(fakeDb(), ctxFor, NOW, 'startup', { request, policy: [] })
  eq(result.rows, 0)
  // Both launchpads answered the same unverified row, and both say so.
  eq(result.dropped, 2)
  eq(result.skipped, 'unverified_platforms_only')
  eq(protocolLines(result).map((p) => [p.state, p.dropped]), [['empty', 1], ['empty', 1]])
})

Deno.test('a call budget of zero stops the lane before it spends', async () => {
  const { request, calls } = board({ newCreations: [memeRow(16, SOL, 'AAA')] })
  const result = await captureMemeStages(fakeDb(), (name, _max) => ctxFor(name, 0), NOW, 'startup', { request, policy: [] })
  eq(calls.length, 0)
  eq(result.skipped, 'call_budget')
  eq(result.credits, 0)
})

Deno.test('one answer is split across the chains its rows name', async () => {
  const writes: Record<string, unknown[]> = {}
  const { request, calls } = board({
    newCreations: [memeRow(16, SOL, 'AAA')],
    graduates: [memeRow(1, EVM, 'BBB'), memeRow(1, EVM2, 'CCC')],
  })
  const result = await captureMemeStages(fakeDb({}, writes), ctxFor, NOW, 'startup', { request, policy: [] })
  eq(calls.length, 2)
  eq(result.rows, 3)
  const rows = writes.intel_meme_stage_snapshots as Record<string, unknown>[]
  eq(new Set(rows.map((r) => r.chain)).size, 2)
  eq(rows.filter((r) => r.stage === 'graduates').length, 2)
  eq(new Set(rows.filter((r) => r.stage === 'graduates').map((r) => r.chain)), new Set(['eip155:1']))
  const platforms = result.platforms as Record<string, unknown>[]
  eq(platforms.find((p) => p.platform === 'solana')?.rows, 1)
  eq(platforms.find((p) => p.platform === 'ethereum')?.rows, 2)
  eq(platforms.find((p) => p.platform === 'base')?.state, 'empty')
})

Deno.test('the stage breakdown covers every platform and stage, zeros included', () => {
  const lines = stageBreakdown([], 'provider_reported_empty')
  eq(lines.length, MEME_PLATFORM_ORDER.length * MEME_STAGES.length)
  eq(lines[0], { platform: 'solana', stage: 'newCreations', rows: 0, reason: 'provider_reported_empty' })
  eq(new Set(lines.map((l) => l.platform)).size, 4)
  eq(new Set(lines.map((l) => l.stage)).size, 3)
})

Deno.test('hoursBetween is null rather than negative', () => {
  eq(hoursBetween(hourBefore(3), CAPTURED), 3)
  eq(hoursBetween(CAPTURED, hourBefore(3)), null)
  eq(hoursBetween(null, CAPTURED), null)
  eq(hoursBetween('nonsense', CAPTURED), null)
})

Deno.test('the lane is reachable as the meme_stages op', async () => {
  eq(Object.keys(MEME_CAPTURE_OPS), ['meme_stages'])
  const { request } = board({ newCreations: [memeRow(16, SOL, 'AAA')] })
  const result = await MEME_CAPTURE_OPS.meme_stages(fakeDb(), ctxFor, NOW, 'startup', { request, policy: [] })
  eq(result.job, 'meme_stages')
  assert(result.capturedAt)
})

Deno.test('a CoinGecko or TronGrid row in this hour does not make the CoinMarketCap lane skip', async () => {
  // THE BUG THIS PINS. `intel_meme_stage_snapshots` is written by three lanes.
  // Until 2026-09-17 this lane's freshness guard read "the newest row of the
  // table" with no source filter, so once the CoinGecko lane started writing at
  // :41 the CoinMarketCap lane at :37 skipped with `within_cadence` and never
  // asked the provider again. Verified in production that day: 116 CoinGecko
  // rows and 3 TronGrid rows at one capture hour, and 0 CoinMarketCap rows.
  // A fixed clock five minutes into an hour. With the real clock, the own-lane row
  // stamped at the top of the hour fell outside the 0.9 × 3600 s cadence grace
  // whenever the test ran in minutes :54 to :59, and the last assertion failed.
  const now = new Date('2026-09-23T12:05:00.000Z')
  const thisHour = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000).toISOString()
  const db = fakeDb({
    intel_meme_stage_snapshots: [
      { chain: 'solana', contract_address: 'A', captured_at: thisHour, source: 'coingecko' },
      { chain: 'tron', contract_address: 'B', captured_at: thisHour, source: 'trongrid' },
    ],
  })
  let asked = 0
  const result = await captureMemeStages(db, ctxFor, now, 'startup', {
    request: () => { asked += 1; return Promise.resolve({ payload: { data: { newCreations: [], aboutGraduates: [], graduates: [] } } }) },
  })
  eq(result.skipped !== 'within_cadence', true, `skipped on another lane's row: ${result.skipped}`)
  eq(asked > 0, true, 'the lane has to actually ask the provider')

  // Its OWN row in the same hour still stops it, which is the guard working.
  const mine = fakeDb({
    intel_meme_stage_snapshots: [{ chain: 'solana', contract_address: 'A', captured_at: thisHour, source: 'coinmarketcap' }],
  })
  let askedAgain = 0
  const skipped = await captureMemeStages(mine, ctxFor, now, 'startup', {
    request: () => { askedAgain += 1; return Promise.resolve(null) },
  })
  eq(skipped.skipped, 'within_cadence')
  eq(askedAgain, 0, 'a skipped run spends nothing')
  eq(MEME_SOURCE, 'coinmarketcap')
})
