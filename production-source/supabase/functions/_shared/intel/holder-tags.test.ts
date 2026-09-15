import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { captureHolderTags, cohortAddress, HOLDER_COHORT_TABLE, HOLDER_COHORT_PER_TAG, HOLDER_TAG_TABLE } from './holder-tags.ts'
import { CMC_HOLDER_TAGS, cmcDexIdentity } from '../market-assets/cmc-dex.ts'
import { hourBucket } from './capture-jobs.ts'

const IDENTITY = cmcDexIdentity(`eip155:8453:0x${'ab'.repeat(20)}`)!
const SOLANA = cmcDexIdentity('solana:So11111111111111111111111111111111111111112')!
// A whole UTC hour plus 32 minutes: every assertion about the stored clock is
// then also an assertion that the lane floored it.
const NOW = new Date(Math.floor((Date.now() - 3 * 86_400_000) / 3_600_000) * 3_600_000 + 32 * 60_000)
const HOUR = hourBucket(NOW)

const evm = (n: number) => `0x${n.toString(16).padStart(40, '0')}`

/** `/v1/dex/holders/tag_count` as probed: data.holders of {tag,hc,tb,hr}. */
const board = (rows: [string, number, number, number][]) => ({ data: { holders: rows.map(([tag, hc, tb, hr]) => ({ tag, hc, tb, hr })) } })
/** `/v1/dex/holders/list` as probed: data.holders plus a cursor we never follow. */
// deno-lint-ignore no-explicit-any
const holders = (rows: any[], lastId?: string) => ({ data: { holders: rows, ...(lastId ? { lastId } : {}) } })
// deno-lint-ignore no-explicit-any
const holder = (address: string, extra: Record<string, any> = {}) => ({
  walletAddress: address, balance: 1000, percent: 1.5, buyUsd: 500, sellUsd: 100,
  realizedPnl: 400, fundingSource: 'bridge', firstActiveTime: '2026-01-01T00:00:00Z', lastActiveTime: '2026-02-01T00:00:00Z',
  // Everything below must be dropped before it reaches the table.
  name: 'Whale Wallet', owner: 'A Person', symbol: 'TKN', riskFlags: ['x'], ...extra,
})

/** Minimal PostgREST-shaped fake: eq filters, limit and upsert. */
// deno-lint-ignore no-explicit-any
function fakeDb(tables: Record<string, any[]> = {}, upsertError?: Record<string, string>) {
  // deno-lint-ignore no-explicit-any
  const upserts: Record<string, any[]> = {}
  return {
    upserts,
    from(table: string) {
      // deno-lint-ignore no-explicit-any
      const filters: [string, any][] = []
      // deno-lint-ignore no-explicit-any
      const q: any = {
        select: () => q,
        // deno-lint-ignore no-explicit-any
        eq: (k: string, v: any) => { filters.push([k, v]); return q },
        order: () => q,
        limit: (max: number) => {
          const rows = (tables[table] || []).filter((row) => filters.every(([k, v]) => String(row?.[k] ?? '') === String(v ?? '')))
          return Promise.resolve({ data: rows.slice(0, max), error: null })
        },
        // deno-lint-ignore no-explicit-any
        upsert: (rows: any[]) => {
          if (upsertError?.[table]) return Promise.resolve({ data: null, error: { message: upsertError[table] } })
          upserts[table] = [...(upserts[table] || []), ...rows]
          return Promise.resolve({ data: rows, error: null })
        },
      }
      return q
    },
  }
}

// deno-lint-ignore no-explicit-any
function fakeRequest(answers: Record<string, any>) {
  // deno-lint-ignore no-explicit-any
  const calls: { name: string; params: any }[] = []
  // deno-lint-ignore no-explicit-any
  const request = (name: string, params: any) => {
    calls.push({ name, params })
    const key = name === 'dexHolders' ? `dexHolders:${params.tag}` : name
    const answer = Object.prototype.hasOwnProperty.call(answers, key) ? answers[key] : answers[name]
    if (answer === undefined) return Promise.resolve({ payload: null, reason: 'not_configured', state: 'unavailable' })
    if (answer instanceof Error) return Promise.reject(answer)
    return Promise.resolve(answer)
  }
  return { request, calls }
}

const ok = (payload: unknown) => ({ payload, state: 'fresh', reason: null, provenance: { fetchedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString() } })
const ctxFor = (_name: string, maxCalls: number) => ({ maxCalls })

Deno.test('one board call plus one holders call per populated tag, on a floored clock', async () => {
  const db = fakeDb()
  const { request, calls } = fakeRequest({
    dexHolderTags: ok(board([['tag_dev', 2, 10, 0.5], ['tag_sniper', 0, 0, 0], ['tag_whale', 3, 90, 4.5]])),
    'dexHolders:tag_dev': ok(holders([holder(evm(1)), holder(evm(2))])),
    'dexHolders:tag_whale': ok(holders([holder(evm(3), { realizedPnl: -25 })], 'cursor-we-ignore')),
  })
  const result = await captureHolderTags(db, IDENTITY, ctxFor, { request }, { now: NOW })

  eq(result.capturedAt, HOUR)
  assert(HOUR.endsWith(':00:00.000Z'), 'the stored clock is an hour mark')
  eq(result.credits, 3, '1 board + 2 populated tags')
  eq(result.calls, 3)
  eq(result.skipped, undefined)
  eq(result.error, undefined)
  // The zero-count tag is still part of the board, it just costs no holders call.
  eq(result.tags.map((t) => t.tag), ['tag_dev', 'tag_sniper', 'tag_whale'])
  eq(calls.filter((c) => c.name === 'dexHolders').map((c) => c.params.tag), ['tag_dev', 'tag_whale'])
  eq(calls[0].params, { platform: 'base', tokenAddress: IDENTITY.address })
  eq(calls[1].params.limit, String(HOLDER_COHORT_PER_TAG))
  assert(!('lastId' in calls[1].params), 'the first page is the whole request')

  const tagRows = db.upserts[HOLDER_TAG_TABLE]
  eq(tagRows.length, 3)
  eq(tagRows[0], { chain: 'eip155:8453', contract_address: IDENTITY.address, captured_at: HOUR, tag: 'tag_dev', holder_count: 2, balance: 10, ratio: 0.5, ratio_unit: 'unknown' })
  eq(tagRows.every((r) => r.ratio_unit === 'unknown'), true, 'the holding-ratio unit is never invented')

  const cohort = db.upserts[HOLDER_COHORT_TABLE]
  eq(result.cohortRows, 3)
  eq(cohort.length, 3)
  eq(cohort[0], {
    chain: 'eip155:8453', contract_address: IDENTITY.address, captured_at: HOUR, tag: 'tag_dev',
    wallet_address: evm(1), balance: 1000, percent: 1.5, buy_volume_usd: 500, sell_volume_usd: 100,
    realized_pnl_usd: 400, funding_source: 'bridge',
    first_seen_at: '2026-01-01T00:00:00.000Z', last_seen_at: '2026-02-01T00:00:00.000Z',
  })
  eq(cohort.at(-1)!.realized_pnl_usd, -25, 'a realized loss is a measurement')
  // Nothing that could name a person survives the whitelist.
  for (const row of cohort) for (const key of Object.keys(row)) assert(!['name', 'owner', 'label', 'ens', 'handle', 'symbol', 'riskFlags'].includes(key), `cohort row carries ${key}`)
})

Deno.test('a second capture inside the same hour is a skip, not a second set of credits', async () => {
  const db = fakeDb({ [HOLDER_TAG_TABLE]: [{ chain: IDENTITY.chain, contract_address: IDENTITY.address, captured_at: HOUR, tag: 'tag_dev' }] })
  const { request, calls } = fakeRequest({ dexHolderTags: ok(board([['tag_dev', 2, 10, 0.5]])) })
  const result = await captureHolderTags(db, IDENTITY, ctxFor, { request }, { now: NOW })
  eq(result.skipped, 'within_cadence')
  eq(result.credits, 0)
  eq(result.tags, [])
  eq(calls.length, 0)
  eq(db.upserts[HOLDER_TAG_TABLE], undefined)
})

Deno.test('a failed holders page keeps the tag board and reports the partial', async () => {
  const db = fakeDb()
  const { request } = fakeRequest({
    dexHolderTags: ok(board([['tag_dev', 2, 10, 0.5], ['tag_whale', 3, 90, 4.5]])),
    'dexHolders:tag_dev': { payload: null, state: 'unavailable', reason: 'refresh_required' },
    'dexHolders:tag_whale': ok(holders([holder(evm(7))])),
  })
  const result = await captureHolderTags(db, IDENTITY, ctxFor, { request }, { now: NOW })
  eq(result.partial, 'refresh_required')
  eq(result.error, undefined)
  eq(result.tags.length, 2, 'the classification we did see is not lost')
  eq(db.upserts[HOLDER_TAG_TABLE].length, 2)
  eq(result.cohortRows, 1)
  eq(db.upserts[HOLDER_COHORT_TABLE].map((r) => r.tag), ['tag_whale'])
})

Deno.test('a thrown holders call is a partial, not a lost capture', async () => {
  const db = fakeDb()
  const { request } = fakeRequest({
    dexHolderTags: ok(board([['tag_dev', 2, 10, 0.5]])),
    'dexHolders:tag_dev': new Error('socket'),
  })
  const result = await captureHolderTags(db, IDENTITY, ctxFor, { request }, { now: NOW })
  eq(result.partial, 'provider_unavailable')
  eq(db.upserts[HOLDER_TAG_TABLE].length, 1)
  eq(result.cohortRows, 0)
})

Deno.test('a failed board writes nothing and spends one credit', async () => {
  const db = fakeDb()
  const { request, calls } = fakeRequest({ dexHolderTags: { payload: null, state: 'unavailable', reason: 'credential_unavailable' } })
  const result = await captureHolderTags(db, IDENTITY, ctxFor, { request }, { now: NOW })
  eq(result.error, 'credential_unavailable')
  eq(result.credits, 1)
  eq(calls.length, 1)
  eq(db.upserts[HOLDER_TAG_TABLE], undefined)
})

Deno.test('a board with no readable counts spends nothing further', async () => {
  const db = fakeDb()
  const { request, calls } = fakeRequest({ dexHolderTags: ok({ data: { holders: [{ tag: 'tag_dev', hc: null, tb: 1, hr: 1 }, { tag: 'not_a_tag', hc: 5 }] } }) })
  const result = await captureHolderTags(db, IDENTITY, ctxFor, { request }, { now: NOW })
  eq(result.skipped, 'no_reported_tags', 'an unknown count is not a zero, and an unknown tag is not a tag')
  eq(calls.length, 1)
  eq(result.credits, 1)
})

Deno.test('the plan gate and the operator switch both refuse before any call', async () => {
  const db = fakeDb()
  const below = fakeRequest({ dexHolderTags: ok(board([['tag_dev', 2, 10, 0.5]])) })
  eq((await captureHolderTags(db, IDENTITY, ctxFor, { request: below.request }, { now: NOW, plan: 'basic' })).skipped, 'plan_below_startup')
  eq(below.calls.length, 0)
  const off = fakeRequest({ dexHolderTags: ok(board([['tag_dev', 2, 10, 0.5]])) })
  const result = await captureHolderTags(db, IDENTITY, ctxFor, { request: off.request, policy: [{ feature: 'holder_tags', enabled: false }] }, { now: NOW })
  eq(result.skipped, 'policy_disabled')
  eq(off.calls.length, 0)
  eq(result.credits, 0)
})

Deno.test('a call budget below the ceiling stops the run instead of overspending', async () => {
  const db = fakeDb()
  const { request, calls } = fakeRequest({
    dexHolderTags: ok(board([['tag_dev', 2, 10, 0.5], ['tag_whale', 3, 90, 4.5]])),
    'dexHolders:tag_dev': ok(holders([holder(evm(4))])),
  })
  // Two calls total: the board and exactly one cohort page.
  const result = await captureHolderTags(db, IDENTITY, ctxFor.bind(null), { request }, { now: NOW })
  eq(result.calls, 3)
  const tight = await captureHolderTags(db, IDENTITY, () => ({ maxCalls: 2 }), { request }, { now: NOW })
  eq(tight.partial, 'call_budget')
  eq(tight.credits, 2)
  eq(calls.filter((c) => c.name === 'dexHolders').length, 3)
})

Deno.test('only the tag board reaches the evidence sink', async () => {
  const db = fakeDb()
  const { request } = fakeRequest({
    dexHolderTags: ok(board([['tag_dev', 2, 10, 0.5]])),
    'dexHolders:tag_dev': ok(holders([holder(evm(5))])),
  })
  const recorded: string[] = []
  await captureHolderTags(db, IDENTITY, ctxFor, { request, record: (capability) => { recorded.push(capability) } }, { now: NOW })
  eq(recorded, ['dexHolderTags'], 'a wallet page is never normalised as evidence about the token')
})

Deno.test('a throwing evidence sink never loses the capture', async () => {
  const db = fakeDb()
  const { request } = fakeRequest({
    dexHolderTags: ok(board([['tag_dev', 1, 10, 0.5]])),
    'dexHolders:tag_dev': ok(holders([holder(evm(6))])),
  })
  const result = await captureHolderTags(db, IDENTITY, ctxFor, { request, record: () => { throw Error('storage down') } }, { now: NOW })
  eq(result.error, undefined)
  eq(result.cohortRows, 1)
})

Deno.test('a failed tag write stops the cohort write and is reported', async () => {
  const db = fakeDb({}, { [HOLDER_TAG_TABLE]: 'permission denied' })
  const { request } = fakeRequest({
    dexHolderTags: ok(board([['tag_dev', 1, 10, 0.5]])),
    'dexHolders:tag_dev': ok(holders([holder(evm(8))])),
  })
  const result = await captureHolderTags(db, IDENTITY, ctxFor, { request }, { now: NOW })
  eq(result.error, 'permission denied')
  eq(result.cohortRows, 0)
  eq(db.upserts[HOLDER_COHORT_TABLE], undefined, 'no cohort row survives a board that was not stored')
})

Deno.test('addresses are canonical for their chain, and an unusable one is dropped', async () => {
  eq(cohortAddress(`0x${'AB'.repeat(20)}`, 'base'), `0x${'ab'.repeat(20)}`)
  eq(cohortAddress('So11111111111111111111111111111111111111112', 'solana'), 'So11111111111111111111111111111111111111112')
  eq(cohortAddress('So11111111111111111111111111111111111111112', 'base'), null)
  eq(cohortAddress('not-an-address', 'base'), null)
  eq(cohortAddress(null, 'base'), null)

  const db = fakeDb()
  const { request } = fakeRequest({
    dexHolderTags: ok(board([['tag_kol', 4, 10, 0.5]])),
    'dexHolders:tag_kol': ok(holders([
      holder('So11111111111111111111111111111111111111112'),
      holder(`0x${'CD'.repeat(20)}`),
      holder(`0x${'cd'.repeat(20)}`),
      holder('rubbish'),
    ])),
  })
  const result = await captureHolderTags(db, IDENTITY, ctxFor, { request }, { now: NOW })
  eq(result.cohortRows, 1, 'a Solana mint is not a Base address, and one address is one row')
  eq(db.upserts[HOLDER_COHORT_TABLE][0].wallet_address, `0x${'cd'.repeat(20)}`)
})

Deno.test('a Solana contract keeps base58 addresses exactly as they are', async () => {
  const db = fakeDb()
  const mint = 'So11111111111111111111111111111111111111112'
  const { request } = fakeRequest({
    dexHolderTags: ok(board([['tag_bot', 1, 10, 0.5]])),
    'dexHolders:tag_bot': ok(holders([holder(mint)])),
  })
  await captureHolderTags(db, SOLANA, ctxFor, { request }, { now: NOW })
  eq(db.upserts[HOLDER_COHORT_TABLE][0].wallet_address, mint)
  eq(db.upserts[HOLDER_TAG_TABLE][0].chain, 'solana')
})

Deno.test('the requested tag list bounds the run and unknown tags never reach the provider', async () => {
  const db = fakeDb()
  const { request, calls } = fakeRequest({
    dexHolderTags: ok(board([['tag_dev', 2, 10, 0.5], ['tag_whale', 3, 90, 4.5]])),
    'dexHolders:tag_whale': ok(holders([holder(evm(9))])),
  })
  const result = await captureHolderTags(db, IDENTITY, ctxFor, { request }, { now: NOW, tags: ['tag_whale', 'tag_not_registered'] })
  eq(result.tags.map((t) => t.tag), ['tag_whale'])
  eq(calls.filter((c) => c.name === 'dexHolders').map((c) => c.params.tag), ['tag_whale'])
  eq(await captureHolderTags(db, IDENTITY, ctxFor, { request }, { now: NOW, tags: ['nope'] }).then((r) => r.skipped), 'no_requested_tags')
  eq(CMC_HOLDER_TAGS.length, 8, 'the eight probed classifications are the whole ceiling')
})
