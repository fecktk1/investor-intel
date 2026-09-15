import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  captureMemeStages, memeCandidates, hoursBetween, MEME_CAPTURE_OPS,
  MEME_PLATFORM_ORDER, MEME_PAGE_SIZE, MEME_MAX_CALLS, MEME_STAGES,
} from './capture-meme.ts'

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
const nothing = () => ok(memePayload({}))

/** Only solana answers; the other three return an empty board. */
const onlySolana = (rows: Partial<Record<typeof MEME_STAGES[number], unknown[]>>) =>
  fakeRequest((_n, params) => String(params.platformIds) === '16' ? ok(memePayload(rows)) : nothing())

Deno.test('the probe order is solana, base, ethereum, arbitrum and the page size is 25', async () => {
  const { request, calls } = onlySolana({ newCreations: [memeRow(16, SOL, 'AAA')] })
  const db = fakeDb()
  const result = await captureMemeStages(db, ctxFor, NOW, 'startup', { request, policy: [] })
  eq(calls.map((c) => String(c.params.platformIds)), ['16', '199', '1', '51'])
  eq(MEME_PLATFORM_ORDER, ['solana', 'base', 'ethereum', 'arbitrum'])
  eq(calls.every((c) => c.name === 'dexMeme' && Number(c.params.pageSize) === MEME_PAGE_SIZE && c.params.interval === '24h'), true)
  eq(result.credits, MEME_MAX_CALLS, 'one credit a platform')
  eq(result.rows, 1)
})

Deno.test('stage detection keeps the furthest stage when one response names a contract twice', () => {
  const payload = memePayload({
    newCreations: [memeRow(16, SOL, 'AAA')],
    graduates: [memeRow(16, SOL, 'AAA')],
  })
  const candidates = memeCandidates(payload, 16)
  eq(candidates.length, 1)
  eq(candidates[0].stage, 'graduates')
  eq(candidates[0].chain, 'solana')
  eq(candidates[0].address, SOL)
})

Deno.test('a row whose platform does not match the request is dropped, not repaired', () => {
  // A base row inside a solana answer: the response would be about another chain.
  eq(memeCandidates(memePayload({ newCreations: [memeRow(199, EVM, 'BBB')] }), 16).length, 0)
  eq(memeCandidates(memePayload({ newCreations: [memeRow(199, EVM, 'BBB')] }), 199).length, 1)
})

Deno.test('a first sighting sets first_seen_at to this hour and writes no transition', async () => {
  const writes: Record<string, unknown[]> = {}
  const { request } = onlySolana({ newCreations: [memeRow(16, SOL, 'AAA')] })
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
  const { request } = onlySolana({ graduates: [memeRow(16, SOL, 'AAA')] })
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
  const { request } = onlySolana({ newCreations: [memeRow(16, SOL, 'AAA')] })
  const result = await captureMemeStages(db, ctxFor, NOW, 'startup', { request, policy: [] })
  eq(result.transitions, 0)
  eq(writes.intel_meme_stage_transitions, undefined)
})

Deno.test('re-running the same hour is idempotent: the run never reads its own rows back', async () => {
  const tables: Record<string, unknown[]> = {}
  const first: Record<string, unknown[]> = {}
  const { request } = onlySolana({ newCreations: [memeRow(16, SOL, 'AAA')] })
  // deno-lint-ignore no-explicit-any
  const db = fakeDb(tables as any, first)
  await captureMemeStages(db, ctxFor, NOW, 'startup', { request, policy: [] })
  const second: Record<string, unknown[]> = {}
  const { request: request2 } = onlySolana({ graduates: [memeRow(16, SOL, 'AAA')] })
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
  const { request, calls } = onlySolana({ newCreations: [memeRow(16, SOL, 'AAA')] })
  const db = fakeDb({ intel_meme_stage_snapshots: [{ chain: 'solana', contract_address: SOL, captured_at: new Date(NOW.getTime() - 60_000).toISOString(), stage: 'newCreations', first_seen_at: hourBefore(2) }] })
  const result = await captureMemeStages(db, ctxFor, NOW, 'startup', { request, policy: [] })
  eq(result.skipped, 'within_cadence')
  eq(calls.length, 0)
  eq(result.credits, 0)
})

Deno.test('a disabled policy row skips the lane', async () => {
  const { request, calls } = onlySolana({ newCreations: [memeRow(16, SOL, 'AAA')] })
  const result = await captureMemeStages(fakeDb(), ctxFor, NOW, 'startup', { request, policy: [{ feature: 'meme_stages', enabled: false }] })
  eq(result.skipped, 'policy_disabled')
  eq(calls.length, 0)
})

Deno.test('below Startup the lane spends nothing', async () => {
  const { request, calls } = onlySolana({ newCreations: [memeRow(16, SOL, 'AAA')] })
  const result = await captureMemeStages(fakeDb(), ctxFor, NOW, 'builder', { request, policy: [] })
  eq(result.skipped, 'plan_below_startup')
  eq(result.credits, 0)
  eq(calls.length, 0)
})

Deno.test('a platform that does not answer is recorded and the others still run', async () => {
  const writes: Record<string, unknown[]> = {}
  const { request } = fakeRequest((_n, params) =>
    String(params.platformIds) === '16' ? { payload: null, state: 'unavailable', reason: 'provider_unavailable' }
      : String(params.platformIds) === '199' ? ok(memePayload({ graduates: [memeRow(199, EVM, 'BBB')] }))
        : nothing())
  const result = await captureMemeStages(fakeDb({}, writes), ctxFor, NOW, 'startup', { request, policy: [] })
  const platforms = result.platforms as Record<string, unknown>[]
  eq(platforms.find((p) => p.platform === 'solana')?.state, 'unavailable')
  eq(platforms.find((p) => p.platform === 'base')?.state, 'captured')
  eq(platforms.find((p) => p.platform === 'ethereum')?.state, 'empty')
  eq(result.rows, 1)
  eq(result.partial, 'provider_unavailable', 'a failed platform is never silent')
  eq((writes.intel_meme_stage_snapshots as Record<string, unknown>[])[0].chain, 'eip155:8453')
})

Deno.test('a call budget below the platform count stops after the budget', async () => {
  const { request, calls } = onlySolana({ newCreations: [memeRow(16, SOL, 'AAA')] })
  const result = await captureMemeStages(fakeDb(), (name, _max) => ctxFor(name, 2), NOW, 'startup', { request, policy: [] })
  eq(calls.length, 2)
  const platforms = result.platforms as Record<string, unknown>[]
  eq(platforms.filter((p) => p.state === 'skipped').length, 2)
  eq(platforms.filter((p) => p.reason === 'call_budget').length, 2)
})

Deno.test('several contracts and chains in one run', async () => {
  const writes: Record<string, unknown[]> = {}
  const { request } = fakeRequest((_n, params) =>
    String(params.platformIds) === '16' ? ok(memePayload({ newCreations: [memeRow(16, SOL, 'AAA')], aboutGraduates: [] }))
      : String(params.platformIds) === '1' ? ok(memePayload({ graduates: [memeRow(1, EVM, 'BBB'), memeRow(1, EVM2, 'CCC')] }))
        : nothing())
  const result = await captureMemeStages(fakeDb({}, writes), ctxFor, NOW, 'startup', { request, policy: [] })
  eq(result.rows, 3)
  const rows = writes.intel_meme_stage_snapshots as Record<string, unknown>[]
  eq(new Set(rows.map((r) => r.chain)).size, 2)
  eq(rows.filter((r) => r.stage === 'graduates').length, 2)
})

Deno.test('hoursBetween is null rather than negative', () => {
  eq(hoursBetween(hourBefore(3), CAPTURED), 3)
  eq(hoursBetween(CAPTURED, hourBefore(3)), null)
  eq(hoursBetween(null, CAPTURED), null)
  eq(hoursBetween('nonsense', CAPTURED), null)
})

Deno.test('the lane is reachable as the meme_stages op', async () => {
  eq(Object.keys(MEME_CAPTURE_OPS), ['meme_stages'])
  const { request } = onlySolana({ newCreations: [memeRow(16, SOL, 'AAA')] })
  const result = await MEME_CAPTURE_OPS.meme_stages(fakeDb(), ctxFor, NOW, 'startup', { request, policy: [] })
  eq(result.job, 'meme_stages')
  assert(result.capturedAt)
})
