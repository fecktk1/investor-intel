import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  captureNewListings, listingDexIdentity, securityDocument, securityFlagCount, securityHash, newListingRow,
  LISTING_CAPTURE_OPS, NEW_LISTING_LIMIT, DUE_DILIGENCE_PER_RUN, SECURITY_ITEM_MAX,
} from './capture-listings.ts'

// A week in the past keeps every provider timestamp behind the real clock.
const NOW = new Date(Math.floor((Date.now() - 7 * 86_400_000) / 3_600_000) * 3_600_000)
const DAY = NOW.toISOString().slice(0, 10)
const minus = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
const EVM = '0x' + 'A'.repeat(40)
const SOL = 'So11111111111111111111111111111111111111112'

/** Minimal PostgREST-shaped fake: eq/gte/lte/in filters, order, limit and upsert.
 * Every chain in the job ends in `.limit()` or `.upsert()`. */
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
            if (op === 'gte') return compare(v, operand) >= 0
            if (op === 'lte') return compare(v, operand) <= 0
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
        gte: (k: string, v: any) => { filters.push([k, 'gte', v]); return q },
        // deno-lint-ignore no-explicit-any
        lte: (k: string, v: any) => { filters.push([k, 'lte', v]); return q },
        // deno-lint-ignore no-explicit-any
        in: (k: string, v: any[]) => { filters.push([k, 'in', v]); return q },
        // deno-lint-ignore no-explicit-any
        order: (column: string, options: any = {}) => { ordering = { column, ascending: options?.ascending !== false }; return q },
        limit: (max: number) => Promise.resolve(run(max)),
        // deno-lint-ignore no-explicit-any
        upsert: (rows: any[]) => { (writes[table] ||= []).push(...rows); return Promise.resolve({ error: null }) },
      }
      return q
    },
  }
}

const ctxFor = (name: string, maxCalls: number) => ({ jobName: 'test', caller: name, kind: 'job' as const, maxCalls })
/** Records every provider call so the lane's call ceiling is checked, not assumed. */
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

/** `/v1/cryptocurrency/listings/new` rows: the generic `cmcRows` tail, so each
 * row carries `quote` picked from `quote.USD` by `cmcUsdQuote`. */
const listing = (id: number, platform: Record<string, unknown> | null = { id: 1027, name: 'Ethereum', slug: 'ethereum', symbol: 'ETH', token_address: EVM }) => ({
  id, name: `Asset ${id}`, symbol: `A${id}`, slug: `asset-${id}`,
  date_added: new Date(NOW.getTime() - id * 60_000).toISOString(),
  ...(platform ? { platform } : { platform: null }),
  quote: { USD: { price: 0.5 + id, volume_24h: 1000 * id, market_cap: 1e6 * id, percent_change_24h: -3.5, last_updated: minus(600_000) } },
})
const listingsPayload = (rows: unknown[]) => ({ data: rows })

/** `/v1/dex/security/detail` answers with an array of at most one entry. */
const securityPayload = (items: unknown[], over: Record<string, unknown> = {}) => ({
  data: [{ tokenContractAddress: EVM.toLowerCase(), platformId: 1, exist: true, securityLevel: 2, securityItems: items, ...over }],
})
const holderPayload = (count: unknown) => ({ data: { tokenAddress: EVM.toLowerCase(), platformId: 1, count } })

const ITEM = { code: 'honeypot', isHit: false, riskyLevel: 1, des: 'Not a honeypot.' }

/** The handler most tests use: listings, then security and holder count per row. */
const allGood = (name: string) => name === 'newListings' ? { payload: listingsPayload([listing(1), listing(2)]) }
  : name === 'dexSecurity' ? { payload: securityPayload([ITEM]) }
  : { payload: holderPayload(413) }

// ─── platform join ────────────────────────────────────────────────────────────

Deno.test('a listing joins a contract only on one of the four verified DEX chains', () => {
  eq(listingDexIdentity({ slug: 'ethereum', token_address: EVM })?.chain, 'eip155:1')
  eq(listingDexIdentity({ slug: 'base', token_address: EVM })?.chain, 'eip155:8453')
  eq(listingDexIdentity({ slug: 'arbitrum', token_address: EVM })?.chain, 'eip155:42161')
  eq(listingDexIdentity({ slug: 'solana', token_address: SOL })?.chain, 'solana')
  // The canonical form is what every other DEX surface uses: an EVM address is lower-cased.
  eq(listingDexIdentity({ slug: 'ethereum', token_address: EVM })?.address, EVM.toLowerCase())
  eq(listingDexIdentity({ slug: 'solana', token_address: SOL })?.address, SOL, 'a Solana mint is case-sensitive and is not folded')
})

Deno.test('an unverified chain, a missing address and a malformed address all refuse to join', () => {
  eq(listingDexIdentity({ slug: 'binance-smart-chain', token_address: EVM }), null)
  eq(listingDexIdentity({ slug: 'arbitrum-nova', token_address: EVM }), null, 'Arbitrum Nova is a different chain and never folds onto Arbitrum')
  eq(listingDexIdentity({ slug: 'ethereum', token_address: '' }), null)
  eq(listingDexIdentity({ slug: 'ethereum' }), null)
  eq(listingDexIdentity({ slug: 'ethereum', token_address: 'not-an-address' }), null)
  eq(listingDexIdentity({ slug: 'solana', token_address: EVM }), null, 'an EVM address is not a Solana mint')
  eq(listingDexIdentity(null), null)
  eq(listingDexIdentity('ethereum'), null)
})

Deno.test('the platform name and the arbitrum-one spelling are accepted; a numeric id never overrides a slug', () => {
  eq(listingDexIdentity({ name: 'Base', token_address: EVM })?.chain, 'eip155:8453', 'the display name is folded to a slug')
  eq(listingDexIdentity({ slug: 'arbitrum-one', token_address: EVM })?.chain, 'eip155:42161')
  // `platform.id` on a listings payload is the CMC id of the platform's own COIN.
  // Ethereum is 1027 there, while DEX platform 1 is Ethereum: reading the number
  // as a DEX platform id when a slug exists would invent a chain.
  eq(listingDexIdentity({ id: 1, slug: 'binance-smart-chain', token_address: EVM }), null, 'a slug that names an unverified chain wins over a numeric id')
  eq(listingDexIdentity({ id: 16, token_address: SOL })?.chain, 'solana', 'with no slug or name at all the DEX platform id is the only evidence left')
})

// ─── security document ────────────────────────────────────────────────────────

Deno.test('the stored security document keeps only whitelisted fields and caps free text', () => {
  const doc = securityDocument({
    tokenContractAddress: EVM, platformId: 1, exist: true, securityLevel: 3, creatorAddress: '0xowner',
    securityItems: [{ code: 'mintable', isHit: true, riskyLevel: 3, des: 'x'.repeat(500), extra: 'dropped' }],
  })!
  eq(Object.keys(doc).sort(), ['exists', 'items', 'level'])
  eq(doc.exists, true)
  eq(doc.level, 3)
  assert(!('creatorAddress' in doc), 'an address the provider volunteers is not stored by this lane')
  // deno-lint-ignore no-explicit-any
  const item = (doc.items as any[])[0]
  eq(Object.keys(item).sort(), ['code', 'description', 'hit', 'level'])
  eq(item.description.length, 200, 'the one free-text field is capped at 200 characters')
  assert(!('extra' in item))
})

Deno.test('an unreported flag is unknown, never false, and an item with no code is not an item', () => {
  const doc = securityDocument({ exist: null, securityItems: [{ code: 'a', isHit: true }, { code: 'b' }, { isHit: true }, null, 'x'] })!
  eq(doc.exists, null, 'coverage the provider did not state is unknown')
  eq(doc.level, null)
  // deno-lint-ignore no-explicit-any
  eq((doc.items as any[]).map((i) => `${i.code}:${i.hit}`), ['a:true', 'b:null'], 'an item with no code cannot be keyed and is dropped')
  eq(securityDocument(null), null)
  eq(securityDocument([]), null)
})

Deno.test('the item list is keyed by code, bounded, and sorted so a reorder is not a change', () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ code: `c${String(i).padStart(3, '0')}`, isHit: i % 2 === 0 }))
  // deno-lint-ignore no-explicit-any
  const items = securityDocument({ securityItems: many })!.items as any[]
  eq(items.length, SECURITY_ITEM_MAX)
  eq(items[0].code, 'c000')
  eq(items.map((i) => i.code).join(','), [...items].map((i) => i.code).sort().join(','), 'always sorted by code')
  // deno-lint-ignore no-explicit-any
  const dup = securityDocument({ securityItems: [{ code: 'a', isHit: false }, { code: 'a', isHit: true }] })!.items as any[]
  eq(dup.length, 1)
  eq(dup[0].hit, true, 'a repeated code collapses to its last occurrence')
})

Deno.test('the flag count counts only reported hits, and an uninspected row has no count at all', () => {
  eq(securityFlagCount(securityDocument({ securityItems: [{ code: 'a', isHit: true }, { code: 'b', isHit: false }, { code: 'c' }] })), 1)
  eq(securityFlagCount(securityDocument({ securityItems: [] })), 0, 'an inspected contract with no flags is a real zero')
  eq(securityFlagCount(null), null, 'a contract nobody inspected has no flag count')
  eq(securityFlagCount({}), null)
})

Deno.test('the hash is stable across key and item order and moves when a flag moves', async () => {
  const a = await securityHash(securityDocument({ exist: true, securityLevel: 2, securityItems: [ITEM, { code: 'mintable', isHit: false, riskyLevel: 1, des: 'No.' }] }))
  const reordered = await securityHash(securityDocument({ securityItems: [{ des: 'No.', riskyLevel: 1, isHit: false, code: 'mintable' }, { des: 'Not a honeypot.', riskyLevel: 1, isHit: false, code: 'honeypot' }], securityLevel: 2, exist: true }))
  eq(a, reordered, 'the same flags in a different key and item order hash identically')
  assert(/^[0-9a-f]{64}$/.test(a), 'a sha-256 in lower-case hex')
  const changed = await securityHash(securityDocument({ exist: true, securityLevel: 2, securityItems: [{ ...ITEM, isHit: true }, { code: 'mintable', isHit: false, riskyLevel: 1, des: 'No.' }] }))
  assert(a !== changed, 'a changed hit is a changed hash')
})

// ─── the lane ─────────────────────────────────────────────────────────────────

Deno.test('the new-listings lane is skipped below Startup and never spends a call to find out', async () => {
  const { request, calls } = fakeRequest(allGood)
  for (const plan of ['basic', 'builder']) {
    const result = await captureNewListings(fakeDb(), ctxFor, NOW, plan, { request, policy: [] })
    eq(result.job, 'new_listings')
    eq(result.skipped, 'plan_below_startup')
    eq(result.credits, 0)
  }
  eq(calls.length, 0)
})

Deno.test('one run is one listings page plus security and holder count for each joined row', async () => {
  const { request, calls } = fakeRequest(allGood)
  const writes: Record<string, unknown[]> = {}
  const result = await captureNewListings(fakeDb({}, writes), ctxFor, NOW, 'startup', { request, policy: [] })
  eq(result.rows, 2)
  eq(result.credits, 5, 'one listings page (1) plus two rows x (dexSecurity + dexHolderCount)')
  eq(result.snapshotDate, DAY)
  eq(result.listings, 2)
  eq(result.withContract, 2)
  eq(result.inspected, 2)
  eq(result.secured, 2)
  eq(result.holderCounts, 2)
  eq(result.pendingDueDiligence, 0)
  eq(result.partial, undefined)
  eq(calls.map((c) => c.name), ['newListings', 'dexSecurity', 'dexHolderCount', 'dexSecurity', 'dexHolderCount'])
  eq(calls[0].params, { start: 1, limit: NEW_LISTING_LIMIT })
  eq(calls[1].params, { platformName: 'ethereum', address: EVM.toLowerCase() }, 'dexSecurity is keyed by platformName + address')
  eq(calls[2].params, { platform: 'ethereum', tokenAddress: EVM.toLowerCase() }, 'dexHolderCount is keyed by platform + tokenAddress')

  const rows = writes.intel_new_listing_snapshots as Record<string, unknown>[]
  eq(rows.length, 2)
  eq(rows[0].provider, 'coinmarketcap')
  eq(rows[0].provider_id, '1')
  eq(rows[0].snapshot_date, DAY)
  eq(rows[0].symbol, 'A1')
  eq(rows[0].slug, 'asset-1')
  eq(rows[0].chain, 'eip155:1')
  eq(rows[0].contract_address, EVM.toLowerCase())
  eq(rows[0].price, 1.5)
  eq(rows[0].market_cap, 1e6)
  eq(rows[0].volume_24h, 1000)
  eq(rows[0].change_24h_pct, -3.5)
  eq(rows[0].holder_count, 413)
  eq(rows[0].security_state, 'captured')
  assert(/^[0-9a-f]{64}$/.test(String(rows[0].security_hash)))
  eq(securityFlagCount(rows[0].security), 0)
})

Deno.test('a listing with no contract on a verified chain is still stored, with nothing invented', async () => {
  const { request, calls } = fakeRequest((name) => name === 'newListings'
    ? { payload: listingsPayload([listing(1, null), listing(2, { id: 1839, slug: 'binance-smart-chain', token_address: EVM }), listing(3)]) }
    : allGood(name))
  const writes: Record<string, unknown[]> = {}
  const result = await captureNewListings(fakeDb({}, writes), ctxFor, NOW, 'startup', { request, policy: [] })
  eq(result.rows, 3, 'every listing is stored, inspected or not')
  eq(result.withContract, 1)
  eq(result.inspected, 1)
  eq(result.credits, 3, 'only the one joined row costs due diligence')
  eq(calls.filter((c) => c.name !== 'newListings').length, 2)
  const rows = writes.intel_new_listing_snapshots as Record<string, unknown>[]
  const off = rows.filter((r) => r.security_state === 'no_contract_on_verified_chain')
  eq(off.length, 2)
  eq(off.map((r) => [r.chain, r.contract_address, r.holder_count, r.security, r.security_hash]),
    [[null, null, null, null, null], [null, null, null, null, null]], 'no chain, no count, no document — never a zero')
})

Deno.test('the per-run due-diligence cap holds and the rest of the cohort is stored as pending', async () => {
  const { request, calls } = fakeRequest((name) => name === 'newListings'
    ? { payload: listingsPayload(Array.from({ length: 40 }, (_, i) => listing(i + 1))) }
    : allGood(name))
  const writes: Record<string, unknown[]> = {}
  const result = await captureNewListings(fakeDb({}, writes), ctxFor, NOW, 'startup', { request, policy: [] })
  eq(result.rows, 40, 'the whole cohort is stored')
  eq(result.inspected, DUE_DILIGENCE_PER_RUN)
  eq(result.credits, 1 + DUE_DILIGENCE_PER_RUN * 2, '51 credits is the run ceiling')
  eq(calls.filter((c) => c.name === 'dexSecurity').length, DUE_DILIGENCE_PER_RUN)
  eq(calls.filter((c) => c.name === 'dexHolderCount').length, DUE_DILIGENCE_PER_RUN)
  eq(result.pendingDueDiligence, 15)
  eq(result.partial, 'due_diligence_budget')
  const rows = writes.intel_new_listing_snapshots as Record<string, unknown>[]
  eq(rows.filter((r) => r.security_state === 'captured').length, DUE_DILIGENCE_PER_RUN)
  eq(rows.filter((r) => r.security_state === 'due_diligence_budget').length, 15, 'the tail is pending, never reported as clean')
  // Newest listing first: `listing(1)` is the newest (date_added = NOW - 1 minute).
  eq(calls[1].params.address, EVM.toLowerCase())
  eq(rows.find((r) => r.provider_id === '1')?.security_state, 'captured')
  eq(rows.find((r) => r.provider_id === '40')?.security_state, 'due_diligence_budget')
})

Deno.test('a context call budget stops the lane mid-cohort without losing the cohort', async () => {
  const { request, calls } = fakeRequest((name) => name === 'newListings'
    ? { payload: listingsPayload([listing(1), listing(2), listing(3)]) }
    : allGood(name))
  const writes: Record<string, unknown[]> = {}
  const result = await captureNewListings(fakeDb({}, writes), () => ({ maxCalls: 4 }), NOW, 'startup', { request, policy: [] })
  eq(calls.length, 3, 'one page plus one complete pair; a third call would break the pair')
  eq(result.rows, 3)
  eq(result.credits, 3)
  eq(result.partial, 'call_budget')
  const rows = writes.intel_new_listing_snapshots as Record<string, unknown>[]
  eq(rows.filter((r) => r.security_state === 'captured').length, 1)
  eq(rows.filter((r) => r.security_state === 'due_diligence_budget').length, 2)

  const broke = await captureNewListings(fakeDb(), () => ({ maxCalls: 0 }), NOW, 'startup', { request, policy: [] })
  eq(broke.skipped, 'call_budget')
  eq(broke.credits, 0)
})

Deno.test('a failed security or holder call leaves nulls and records the reason, never a zero', async () => {
  const { request } = fakeRequest((name) => name === 'newListings' ? { payload: listingsPayload([listing(1), listing(2)]) }
    : name === 'dexSecurity' ? { payload: null, reason: 'rate_limited' }
    : { payload: null, reason: 'http_500' })
  const writes: Record<string, unknown[]> = {}
  const result = await captureNewListings(fakeDb({}, writes), ctxFor, NOW, 'startup', { request, policy: [] })
  eq(result.rows, 2)
  eq(result.credits, 5, 'a failed call still consumed its budget')
  eq(result.secured, 0)
  eq(result.holderCounts, 0)
  eq(result.partial, 'rate_limited')
  const rows = writes.intel_new_listing_snapshots as Record<string, unknown>[]
  eq(rows.map((r) => [r.security_state, r.holder_count, r.security_hash]),
    [['rate_limited', null, null], ['rate_limited', null, null]], 'the reason is recorded and nothing is filled in')
})

Deno.test('an empty security answer and an unreadable holder count are distinguished from a clean contract', async () => {
  const { request } = fakeRequest((name) => name === 'newListings' ? { payload: listingsPayload([listing(1)]) }
    : name === 'dexSecurity' ? { payload: { data: [] } }
    : { payload: holderPayload('not a number') })
  const writes: Record<string, unknown[]> = {}
  await captureNewListings(fakeDb({}, writes), ctxFor, NOW, 'startup', { request, policy: [] })
  const row = (writes.intel_new_listing_snapshots as Record<string, unknown>[])[0]
  eq(row.security_state, 'no_security_record', 'no record is not a clean record')
  eq(row.security, null)
  eq(row.holder_count, null, 'an unreadable count stays null')
})

Deno.test('a zero holder count is stored as zero, because zero is a real answer', async () => {
  const { request } = fakeRequest((name) => name === 'newListings' ? { payload: listingsPayload([listing(1)]) }
    : name === 'dexSecurity' ? { payload: securityPayload([ITEM]) } : { payload: holderPayload(0) })
  const writes: Record<string, unknown[]> = {}
  await captureNewListings(fakeDb({}, writes), ctxFor, NOW, 'startup', { request, policy: [] })
  eq((writes.intel_new_listing_snapshots as Record<string, unknown>[])[0].holder_count, 0)
})

Deno.test('the lane honours its cadence, a disabled policy row and an empty page', async () => {
  const { request, calls } = fakeRequest(allGood)
  const fresh = await captureNewListings(fakeDb({ intel_new_listing_snapshots: [{ captured_at: minus(3_600_000) }] }), ctxFor, NOW, 'startup', { request, policy: [] })
  eq(fresh.skipped, 'within_cadence', 'with no policy row the lane keeps its designed DAILY cadence, not the hourly default')
  eq(fresh.newestAt, minus(3_600_000))

  const disabled = await captureNewListings(fakeDb(), ctxFor, NOW, 'startup', { request, policy: [{ feature: 'listings', cadence_seconds: 86400, enabled: false }] })
  eq(disabled.skipped, 'policy_disabled')
  eq(calls.length, 0, 'a skipped run never reaches the provider')

  const empty = await captureNewListings(fakeDb(), ctxFor, NOW, 'startup',
    { request: (name: string) => Promise.resolve(name === 'newListings' ? { payload: { data: [] } } : allGood(name)), policy: [] })
  eq(empty.skipped, 'no_reported_listings')
  eq(empty.credits, 1)
})

Deno.test('an unavailable page, a throwing transport and a failed write are reported without throwing', async () => {
  const down = await captureNewListings(fakeDb(), ctxFor, NOW, 'startup', { request: () => Promise.resolve({ payload: null, reason: 'plan_denied' }), policy: [] })
  eq(down.rows, 0)
  eq(down.error, 'plan_denied')
  eq(down.credits, 1, 'the call was attempted, so its credit ceiling is reported')

  const exploded = await captureNewListings(fakeDb(), ctxFor, NOW, 'startup', { request: () => { throw new Error('boom') }, policy: [] })
  eq(exploded.rows, 0)
  eq(exploded.error, 'boom', 'a transport that throws is reported, never re-thrown')

  const { request } = fakeRequest(allGood)
  const broken = {
    // deno-lint-ignore no-explicit-any
    from: (_t: string) => ({ select: () => ({ order: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }) }), upsert: () => Promise.resolve({ error: { message: 'write_denied' } }) } as any),
  }
  // deno-lint-ignore no-explicit-any
  const write = await captureNewListings(broken as any, ctxFor, NOW, 'startup', { request, policy: [] })
  eq(write.error, 'write_denied')
})

Deno.test('a repeated provider id collapses to one row, and a row with no id is dropped', async () => {
  const { request } = fakeRequest((name) => name === 'newListings'
    ? { payload: listingsPayload([{ ...listing(1), symbol: 'FIRST' }, { ...listing(1), symbol: 'SECOND' }, { symbol: 'NO ID', platform: null }]) }
    : allGood(name))
  const writes: Record<string, unknown[]> = {}
  const result = await captureNewListings(fakeDb({}, writes), ctxFor, NOW, 'startup', { request, policy: [] })
  eq(result.rows, 1)
  eq((writes.intel_new_listing_snapshots as Record<string, unknown>[])[0].symbol, 'SECOND', 'the last occurrence wins')
})

Deno.test('a row projection keeps no field the table does not hold', () => {
  const row = newListingRow({ ...listing(7), tags: ['meme'], num_market_pairs: 3, cmc_rank: 900 }, DAY, NOW.toISOString())!
  eq(Object.keys(row).sort(), [
    'captured_at', 'chain', 'change_24h_pct', 'contract_address', 'date_added', 'holder_count',
    'market_cap', 'name', 'price', 'provider', 'provider_id', 'security', 'security_hash', 'security_state', 'slug', 'snapshot_date', 'symbol', 'volume_24h',
  ])
  eq(newListingRow({ symbol: 'X' }, DAY, NOW.toISOString()), null)
  eq(newListingRow({ id: null }, DAY, NOW.toISOString()), null)
})

Deno.test('the capture ops surface exposes exactly the one lane', async () => {
  eq(Object.keys(LISTING_CAPTURE_OPS), ['new_listings'])
  const { request } = fakeRequest(allGood)
  const writes: Record<string, unknown[]> = {}
  const viaOp = await LISTING_CAPTURE_OPS.new_listings(fakeDb({}, writes), ctxFor, NOW, 'startup', { request, policy: [] })
  eq(viaOp.job, 'new_listings')
  eq(viaOp.rows, 2)
  eq((await LISTING_CAPTURE_OPS.new_listings(fakeDb(), ctxFor, NOW, 'basic', { request, policy: [] })).skipped, 'plan_below_startup')
})
