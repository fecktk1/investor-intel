// Tests for the contract identity resolution function (proposal 25). Run:
//   deno test --allow-all --no-check supabase/functions/intel-portfolio-identity/index.test.ts
//
// The handler is proved end to end against a PostgREST-shaped fake and a fake
// `requestCmc`, because the parts that can hurt a member's book are all side
// effects: which columns a resolve run writes, which chains it is willing to
// ask about, how often it may spend, and what it records about who asked.

import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'

Deno.env.set('SUPABASE_URL', 'https://example.supabase.co')
Deno.env.set('SUPABASE_ANON_KEY', 'anon-key')
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service-key')

const { handlePortfolioIdentity, cmcIdsFromMetadata, PROVIDER_CONFIDENCE_MEDIUM, RESOLUTION_RUNS_PER_HOUR } =
  await import('./index.ts')

const ORG = '11111111-1111-4111-8111-111111111111'
const OTHER_ORG = '22222222-2222-4222-8222-222222222222'
const PORTFOLIO = '33333333-3333-4333-8333-333333333333'
const USER = '44444444-4444-4444-8444-444444444444'
const NOW = new Date('2026-09-15T12:00:00Z')

const BASE_A = '0x4ed4e862860bed51a9570b96d89af5e1b0efefed'
const BASE_B = '0x0000000000000000000000000000000000000b02'
const BNB_TOKEN = '0x0000000000000000000000000000000000000b11'
const SOL_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

interface Write { table: string; patch: Record<string, unknown>; filters: Record<string, unknown>; matched: string[] }
interface Insert { table: string; row: Record<string, unknown> }

/** PostgREST-shaped stand-in: select/insert/update with eq, gte, or, order and
 * limit, plus rpc. Everything written is recorded so a test can assert on the
 * EXACT patch that would reach the database. */
// deno-lint-ignore no-explicit-any
function fakeDb(tables: Record<string, any[]> = {}, errors: Record<string, string> = {}) {
  const writes: Write[] = []
  const inserts: Insert[] = []
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = []
  let insertSeq = 0

  // deno-lint-ignore no-explicit-any
  const build = (table: string, op: 'select' | 'update' | 'insert', payload: any): any => {
    const filters: [string, string, unknown][] = []
    let limitN: number | null = null
    let orExpr: string | null = null

    const matching = () => {
      let rows = [...(tables[table] ?? [])]
      for (const [kind, column, value] of filters) {
        if (kind === 'eq') rows = rows.filter((r) => String(r?.[column] ?? '') === String(value ?? ''))
        if (kind === 'gte') rows = rows.filter((r) => String(r?.[column] ?? '') >= String(value))
        if (kind === 'in') rows = rows.filter((r) => (value as unknown[]).some((v) => String(v) === String(r?.[column] ?? '')))
      }
      // The only `or` this function uses is the open-position predicate.
      if (orExpr === 'is_closed.is.null,is_closed.eq.false') rows = rows.filter((r) => r?.is_closed !== true)
      else if (orExpr) throw new Error(`unexpected or(): ${orExpr}`)
      return rows
    }

    const evaluate = (single: boolean) => {
      const key = `${table}:${op}`
      if (errors[key]) return { data: null, error: { message: errors[key] } }
      const eqFilters = Object.fromEntries(filters.filter((f) => f[0] === 'eq').map((f) => [f[1], f[2]]))
      if (op === 'update') {
        const rows = matching()
        writes.push({ table, patch: payload, filters: eqFilters, matched: rows.map((r) => String(r.id)) })
        // PostgREST applies the patch to every matching row; `.select()` returns them.
        for (const row of rows) Object.assign(row, payload)
        return single ? { data: rows[0] ?? null, error: null } : { data: rows.map((r) => ({ id: r.id })), error: null }
      }
      if (op === 'insert') {
        const row = { id: `row-${++insertSeq}`, ...payload }
        tables[table] = [...(tables[table] ?? []), row]
        inserts.push({ table, row })
        return single ? { data: { id: row.id }, error: null } : { data: [row], error: null }
      }
      let rows = matching()
      if (limitN != null) rows = rows.slice(0, limitN)
      return single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null }
    }

    // deno-lint-ignore no-explicit-any
    const b: any = {
      select() { return b },
      eq(c: string, v: unknown) { filters.push(['eq', c, v]); return b },
      gte(c: string, v: unknown) { filters.push(['gte', c, v]); return b },
      in(c: string, v: unknown[]) { filters.push(['in', c, v]); return b },
      or(expr: string) { orExpr = expr; return b },
      order() { return b },
      limit(n: number) { limitN = n; return b },
      maybeSingle() { return Promise.resolve(evaluate(true)) },
      then(ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) { return Promise.resolve(evaluate(false)).then(ok, bad) },
    }
    return b
  }

  return {
    writes, inserts, rpcCalls, tables,
    from(table: string) {
      return {
        // deno-lint-ignore no-explicit-any
        select(_cols?: string) { return build(table, 'select', null) },
        // deno-lint-ignore no-explicit-any
        update(patch: any) { return build(table, 'update', patch) },
        // deno-lint-ignore no-explicit-any
        insert(patch: any) { return build(table, 'insert', patch) },
      }
    },
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args })
      if (name === 'can_access_intel') return Promise.resolve({ data: true, error: null })
      return Promise.resolve({ data: null, error: null })
    },
  }
}

// deno-lint-ignore no-explicit-any
function clientFactoryFor(db: any) {
  // deno-lint-ignore no-explicit-any
  return (_url: string, _key: string, options?: any) => {
    if (options?.global?.headers?.Authorization) {
      return { auth: { getUser: () => Promise.resolve({ data: { user: { id: USER } }, error: null }) } }
    }
    return db
  }
}

function fakeProvider(answers: Record<string, unknown>) {
  const calls: { name: string; params: Record<string, unknown> }[] = []
  // deno-lint-ignore no-explicit-any
  const request = (name: string, params: Record<string, unknown>, ctx?: any) => {
    calls.push({ name, params })
    if (ctx) ctx._calls = (ctx._calls ?? 0) + 1
    const payload = answers[name] ?? null
    return Promise.resolve({ payload, state: payload ? 'fresh' : 'unavailable', reason: payload ? null : 'provider_unavailable', provenance: {} })
  }
  // deno-lint-ignore no-explicit-any
  return { calls, request: request as any }
}

const post = (body: unknown) =>
  new Request('https://edge.test/intel-portfolio-identity', {
    method: 'POST', headers: { Authorization: 'Bearer user-jwt', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })

const holding = (over: Record<string, unknown>) => ({
  id: 'h', org_id: ORG, portfolio_id: PORTFOLIO, chain: 'base', contract_address: BASE_A,
  mint_or_contract: null, asset_symbol: null, normalized_symbol: null, name: null,
  quantity: 2, price_status: 'unpriced', is_closed: false, ...over,
})

const MEMBERSHIP = { org_members: [{ user_id: USER, org_id: ORG }], profiles: [{ id: USER, is_super_admin: false }] }

// deno-lint-ignore no-explicit-any
const call = (db: any, body: unknown, provider?: ReturnType<typeof fakeProvider>) =>
  handlePortfolioIdentity(post(body), clientFactoryFor(db) as never, { request: provider?.request, now: () => NOW })

Deno.test('coverage reports the open book by chain and calls no provider', async () => {
  const db = fakeDb({
    ...MEMBERSHIP,
    investor_portfolio_holdings: [
      holding({ id: 'b1' }), holding({ id: 'b2', price_status: 'priced' }),
      holding({ id: 'n1', chain: 'bnb', contract_address: BNB_TOKEN }),
      holding({ id: 'closed', is_closed: true }),
      // Another org's row must never appear in this org's coverage.
      holding({ id: 'other', org_id: OTHER_ORG }),
    ],
  })
  const provider = fakeProvider({})
  const response = await call(db, { op: 'coverage', orgId: ORG }, provider)
  eq(response.status, 200)
  const body = await response.json()

  eq(body.op, 'coverage')
  eq(body.asOf, NOW.toISOString())
  eq(body.chains.map((c: { chain: string }) => c.chain), ['base', 'bnb'])
  eq(body.totals.total, 3)
  eq(body.totals.priced, 1)
  eq(body.totals.unpriced, 2)
  eq(body.chains[1].supported, false)
  eq(body.chains[1].reason, 'unsupported_platform')
  eq(provider.calls.length, 0)
  eq(db.writes.length, 0)
  eq(db.inserts.length, 0)
})

Deno.test('coverage can be narrowed to one portfolio', async () => {
  const db = fakeDb({
    ...MEMBERSHIP,
    investor_portfolio_holdings: [
      holding({ id: 'mine' }),
      holding({ id: 'elsewhere', portfolio_id: '55555555-5555-4555-8555-555555555555' }),
    ],
  })
  const body = await (await call(db, { op: 'coverage', orgId: ORG, portfolioId: PORTFOLIO })).json()
  eq(body.totals.total, 1)
})

Deno.test('resolve writes exactly the eight pricing columns, and only for this org', async () => {
  const db = fakeDb({
    ...MEMBERSHIP,
    investor_portfolio_holdings: [holding({ id: 'h1', quantity: 3 })],
  })
  const provider = fakeProvider({
    dexBatch: { data: [{ pid: 199, addr: BASE_A, n: 'Degen', sym: 'DEGEN', p: 0.01, liqUsd: 120_000, mcap: 15_000_000 }] },
    dexPriceBatch: { data: [{ pid: 199, a: BASE_A, p: 0.02 }] },
  })
  const body = await (await call(db, { op: 'resolve', orgId: ORG }, provider)).json()

  eq(body.op, 'resolve')
  eq([body.requested, body.matched, body.priced, body.identityOnly, body.notFound], [1, 1, 1, 0, 0])
  eq(body.credits, 2)
  assert(String(body.creditsNote).includes('floor'))
  eq(body.holdings[0].cmcDexPrice, 0.02)
  eq(body.holdings[0].priceFrom, 'dexPriceBatch')

  const priceWrite = db.writes.find((w) => w.table === 'investor_portfolio_holdings')!
  eq(Object.keys(priceWrite.patch).sort(), [
    'current_price', 'current_value', 'last_priced_at', 'price_source', 'price_status',
    'provider', 'provider_confidence', 'provider_network',
  ])
  eq(priceWrite.patch.current_price, 0.02)
  eq(priceWrite.patch.current_value, 0.06)
  eq(priceWrite.patch.price_source, 'coinmarketcap_dex')
  eq(priceWrite.patch.price_status, 'priced')
  eq(priceWrite.patch.last_priced_at, NOW.toISOString())
  eq(priceWrite.patch.provider, 'coinmarketcap')
  eq(priceWrite.patch.provider_network, 'base')
  // `provider_confidence` is double precision: a text grade would abort the update.
  eq(priceWrite.patch.provider_confidence, PROVIDER_CONFIDENCE_MEDIUM)
  eq(typeof priceWrite.patch.provider_confidence, 'number')
  // Every write is scoped to the holding AND the org the caller was authorised for.
  eq(priceWrite.filters, { id: 'h1', org_id: ORG })
})

Deno.test('an identity-only match fills a blank label and never overwrites one', async () => {
  const db = fakeDb({
    ...MEMBERSHIP,
    investor_portfolio_holdings: [
      holding({ id: 'blank', contract_address: BASE_A }),
      holding({ id: 'named', contract_address: BASE_B, asset_symbol: 'MYTAG', name: 'My name for it' }),
    ],
  })
  const provider = fakeProvider({
    dexBatch: { data: [
      { pid: 199, addr: BASE_A, n: 'Alpha', sym: 'ALPHA', p: null, liqUsd: 90_000 },
      { pid: 199, addr: BASE_B, n: 'Beta', sym: 'BETA', p: null, liqUsd: 90_000 },
    ] },
    dexPriceBatch: { data: [] },
  })
  const body = await (await call(db, { op: 'resolve', orgId: ORG }, provider)).json()

  eq([body.priced, body.identityOnly, body.matched], [0, 2, 2])
  for (const h of body.holdings) { eq(h.reason, 'price_unavailable'); eq(h.cmcDexPrice, null) }

  const holdingWrites = db.writes.filter((w) => w.table === 'investor_portfolio_holdings')
  eq(holdingWrites.length, 1, 'the holding that already had both labels is not touched')
  eq(holdingWrites[0].filters.id, 'blank')
  eq(holdingWrites[0].patch, { name: 'Alpha', asset_symbol: 'ALPHA' })
  // No price column is written when there is no price.
  eq(Object.keys(holdingWrites[0].patch).some((k) => k.startsWith('price') || k === 'current_price'), false)
})

Deno.test('unsupported chains are reported, never asked about', async () => {
  const db = fakeDb({
    ...MEMBERSHIP,
    investor_portfolio_holdings: [
      holding({ id: 'base', contract_address: BASE_A }),
      holding({ id: 'bnb', chain: 'bnb', contract_address: BNB_TOKEN }),
      holding({ id: 'avax', chain: 'avalanche', contract_address: BNB_TOKEN }),
      holding({ id: 'op', chain: 'optimism', contract_address: BNB_TOKEN }),
      holding({ id: 'sol', chain: 'solana', contract_address: SOL_MINT }),
    ],
  })
  const provider = fakeProvider({ dexBatch: { data: [] }, dexPriceBatch: { data: [] } })
  const body = await (await call(db, { op: 'resolve', orgId: ORG }, provider)).json()

  eq(body.unsupported, [{ chain: 'avalanche', count: 1 }, { chain: 'bnb', count: 1 }, { chain: 'optimism', count: 1 }])
  eq(body.requested, 2, 'only the base and solana holdings are asked about')
  const platforms = provider.calls.filter((c) => c.name === 'dexBatch').map((c) => c.params.platform)
  eq(platforms.sort(), ['base', 'solana'])
  const asked = JSON.stringify(provider.calls)
  eq(asked.includes(BNB_TOKEN), false, 'no unverified-chain address reaches the provider')
  const unsupportedAnswers = body.holdings.filter((h: { reason: string }) => h.reason === 'unsupported_platform')
  eq(unsupportedAnswers.length, 3)
  eq(db.writes.filter((w: Write) => w.table === 'investor_portfolio_holdings').length, 0)
})

Deno.test('demand is recorded once per contract and carries no actor', async () => {
  const db = fakeDb({
    ...MEMBERSHIP,
    investor_portfolio_holdings: [
      holding({ id: 'h1', contract_address: BASE_A }),
      // A second holding of the same contract is one demand, not two.
      holding({ id: 'h2', contract_address: BASE_A, portfolio_id: '55555555-5555-4555-8555-555555555555' }),
      holding({ id: 'h3', contract_address: BASE_B }),
    ],
  })
  const provider = fakeProvider({
    dexBatch: { data: [{ pid: 199, addr: BASE_A, sym: 'A', p: 1, liqUsd: 70_000, mcap: 4_000_000 }] },
    dexPriceBatch: { data: [{ pid: 199, a: BASE_A, p: 1 }] },
  })
  const body = await (await call(db, { op: 'resolve', orgId: ORG }, provider)).json()

  const demand = db.rpcCalls.filter((r) => r.name === 'intel_record_asset_demand')
  eq(demand.length, 1, 'the contract nobody answered about is not demanded')
  eq(demand[0].args, { p_asset_key: `base:${BASE_A}`, p_provider: 'coinmarketcap', p_provider_id: `base:${BASE_A}` })
  eq(Object.keys(demand[0].args).some((k) => /user|org|actor|who/i.test(k)), false)
  eq(body.demandRecorded, 1)

  // The run ledger records the organisation and the counters, never a person.
  const run = db.inserts.find((i) => i.table === 'intel_holding_resolution_runs')!
  eq(Object.keys(run.row).sort(), ['credits', 'id', 'org_id', 'priced', 'ran_at', 'requested'])
  eq(run.row.org_id, ORG)
  eq(Object.keys(run.row).some((k) => /user|actor/i.test(k)), false)
  const ledgerUpdate = db.writes.find((w) => w.table === 'intel_holding_resolution_runs')!
  eq(ledgerUpdate.patch, { priced: 2, credits: 2 })
})

Deno.test('a fifth run inside the hour is refused with a retry window and spends nothing', async () => {
  const runs = []
  for (let i = 0; i < RESOLUTION_RUNS_PER_HOUR; i++) {
    runs.push({ id: `r${i}`, org_id: ORG, ran_at: new Date(NOW.getTime() - (50 - i) * 60_000).toISOString() })
  }
  const db = fakeDb({
    ...MEMBERSHIP,
    investor_portfolio_holdings: [holding({ id: 'h1' })],
    intel_holding_resolution_runs: runs,
  })
  const provider = fakeProvider({ dexBatch: { data: [] }, dexPriceBatch: { data: [] } })
  const response = await call(db, { op: 'resolve', orgId: ORG }, provider)

  eq(response.status, 429)
  const body = await response.json()
  eq(body.error, 'resolution_rate_limited')
  eq(body.limit, RESOLUTION_RUNS_PER_HOUR)
  eq(body.runsInWindow, RESOLUTION_RUNS_PER_HOUR)
  // The oldest run in the window was 50 minutes ago, so 10 minutes remain.
  eq(body.retryAfterSeconds, 600)
  eq(response.headers.get('Retry-After'), '600')
  eq(provider.calls.length, 0)
  eq(db.inserts.length, 0)
  eq(db.writes.length, 0)
})

Deno.test('runs that have aged out of the window do not count', async () => {
  const db = fakeDb({
    ...MEMBERSHIP,
    investor_portfolio_holdings: [holding({ id: 'h1' })],
    intel_holding_resolution_runs: [0, 1, 2, 3].map((i) => ({
      id: `old${i}`, org_id: ORG, ran_at: new Date(NOW.getTime() - (61 + i) * 60_000).toISOString(),
    })),
  })
  const provider = fakeProvider({ dexBatch: { data: [] }, dexPriceBatch: { data: [] } })
  const response = await call(db, { op: 'resolve', orgId: ORG }, provider)
  eq(response.status, 200)
  eq(db.inserts.length, 1)
})

Deno.test('an unreadable rate ledger fails closed', async () => {
  const db = fakeDb(
    { ...MEMBERSHIP, investor_portfolio_holdings: [holding({ id: 'h1' })] },
    { 'intel_holding_resolution_runs:select': 'connection lost' },
  )
  const provider = fakeProvider({ dexBatch: { data: [] } })
  const response = await call(db, { op: 'resolve', orgId: ORG }, provider)
  eq(response.status, 503)
  eq((await response.json()).error, 'resolution_rate_unavailable')
  eq(provider.calls.length, 0)
})

Deno.test('nothing to resolve spends nothing and claims no run slot', async () => {
  const db = fakeDb({
    ...MEMBERSHIP,
    investor_portfolio_holdings: [
      holding({ id: 'priced', price_status: 'priced' }),
      holding({ id: 'bnb', chain: 'bnb', contract_address: BNB_TOKEN }),
    ],
  })
  const provider = fakeProvider({})
  const body = await (await call(db, { op: 'resolve', orgId: ORG }, provider)).json()
  eq(body.requested, 0)
  eq(body.credits, 0)
  eq(body.unsupported, [{ chain: 'bnb', count: 1 }])
  eq(body.holdings.length, 1)
  eq(body.holdings[0].reason, 'unsupported_platform')
  eq(provider.calls.length, 0)
  eq(db.inserts.length, 0)
})

Deno.test('a provider outage is reported, and nothing is written', async () => {
  const db = fakeDb({ ...MEMBERSHIP, investor_portfolio_holdings: [holding({ id: 'h1' })] })
  const provider = fakeProvider({})
  const body = await (await call(db, { op: 'resolve', orgId: ORG }, provider)).json()
  eq(body.priced, 0)
  eq(body.notFound, 1)
  eq(body.holdings[0].reason, 'not_found_on_provider')
  eq(body.providerReasons, ['dexBatch:provider_unavailable', 'dexPriceBatch:provider_unavailable'])
  eq(db.writes.filter((w: Write) => w.table === 'investor_portfolio_holdings').length, 0)
})

Deno.test('entities links only an unambiguous single id and keeps the other provider ids', async () => {
  const db = fakeDb({
    ...MEMBERSHIP,
    entities: [
      { id: 'e1', org_id: ORG, entity_kind: 'asset', chain_namespace: 'eip155', chain_id: '8453', contract_address: BASE_A, provider_ids: { coingecko: 'degen-base' } },
      { id: 'e2', org_id: ORG, entity_kind: 'asset', chain_namespace: 'eip155', chain_id: '8453', contract_address: BASE_B, provider_ids: {} },
      { id: 'e3', org_id: ORG, entity_kind: 'asset', chain_namespace: 'solana', chain_id: 'mainnet', contract_address: SOL_MINT, provider_ids: {} },
      // Already linked: never re-asked.
      { id: 'linked', org_id: ORG, entity_kind: 'asset', chain_namespace: 'eip155', chain_id: '1', contract_address: BASE_A, provider_ids: { coinmarketcap: '3408' } },
      // Unverified chain: never asked.
      { id: 'bnb', org_id: ORG, entity_kind: 'asset', chain_namespace: 'eip155', chain_id: '56', contract_address: BNB_TOKEN, provider_ids: {} },
      // Another org.
      { id: 'other', org_id: OTHER_ORG, entity_kind: 'asset', chain_namespace: 'eip155', chain_id: '8453', contract_address: BASE_A, provider_ids: {} },
    ],
  })
  let call$ = 0
  const answers = [
    { data: { '34067': { id: 34067, symbol: 'DEGEN' } } },          // e1: one id
    { data: { '1': { id: 1 }, '2': { id: 2 } } },                    // e2: ambiguous
    { data: {} },                                                     // e3: nothing
  ]
  // deno-lint-ignore no-explicit-any
  const calls: any[] = []
  // deno-lint-ignore no-explicit-any
  const request = ((name: string, params: Record<string, unknown>, ctx?: any) => {
    calls.push({ name, params })
    if (ctx) ctx._calls = (ctx._calls ?? 0) + 1
    return Promise.resolve({ payload: answers[call$++] ?? null, state: 'fresh', reason: null, provenance: {} })
  }) as never
  const response = await handlePortfolioIdentity(post({ op: 'entities', orgId: ORG }), clientFactoryFor(db) as never, { request, now: () => NOW })
  const body = await response.json()

  eq(body.op, 'entities')
  eq(body.eligible, 3)
  eq(body.requested, 3)
  eq(body.updated, 1)
  eq(body.ambiguous, 1)
  eq(body.notFound, 1)
  eq(body.credits, 3)
  eq(calls.map((c) => c.name), ['metadata', 'metadata', 'metadata'])
  eq(calls.map((c) => c.params.address), [BASE_A, BASE_B, SOL_MINT])

  const entityWrites = db.writes.filter((w) => w.table === 'entities')
  eq(entityWrites.length, 1, 'only the unambiguous match is written')
  eq(entityWrites[0].filters, { id: 'e1', org_id: ORG })
  eq(entityWrites[0].patch, { provider_ids: { coingecko: 'degen-base', coinmarketcap: '34067' } })
})

Deno.test('cmc ids come from the row id, then the map key, and never from junk', () => {
  eq(cmcIdsFromMetadata({ data: { '34067': { id: 34067 } } }), ['34067'])
  eq(cmcIdsFromMetadata({ data: { '34067': {} } }), ['34067'])
  eq(cmcIdsFromMetadata({ data: { '34067': [{ id: 9 }, { id: 9 }] } }), ['9'])
  eq(cmcIdsFromMetadata({ data: { abc: { id: 'not-a-number' } } }), [])
  eq(cmcIdsFromMetadata({ data: { '0': { id: 0 } } }), [])
  eq(cmcIdsFromMetadata({ data: null }), [])
  eq(cmcIdsFromMetadata(null), [])
})

Deno.test('an implausible price is reported and NOT written', async () => {
  // The live case: $3,723,685 a token for 100 tokens of a $1.8M-cap asset.
  const db = fakeDb({
    ...MEMBERSHIP,
    investor_portfolio_holdings: [
      holding({ id: 'streamgpt', contract_address: BASE_A, quantity: 100 }),
      holding({ id: 'thin', contract_address: BASE_B, quantity: 1 }),
    ],
  })
  const provider = fakeProvider({
    dexBatch: { data: [
      { pid: 199, addr: BASE_A, n: 'StreamGPT', sym: 'STREAMGPT', p: 3_723_685, liqUsd: 42_000, mcap: 1_800_000 },
      { pid: 199, addr: BASE_B, n: 'Thin', sym: 'THIN', p: 4, liqUsd: 12 },
    ] },
    dexPriceBatch: { data: [{ pid: 199, a: BASE_A, p: 3_723_685 }] },
  })
  const body = await (await call(db, { op: 'resolve', orgId: ORG }, provider)).json()

  eq([body.priced, body.implausible, body.identityOnly, body.matched], [0, 2, 0, 2])
  const streamgpt = body.holdings.find((h: { holdingId: string }) => h.holdingId === 'streamgpt')
  eq(streamgpt.reason, 'price_implausible')
  eq(streamgpt.value, null)
  eq(streamgpt.implausible, {
    price: 3_723_685, liquidityUsd: 42_000, marketCapUsd: 1_800_000,
    impliedValue: 372_368_500, rule: 'value_exceeds_market_cap',
  })
  eq(body.holdings.find((h: { holdingId: string }) => h.holdingId === 'thin').implausible.rule, 'liquidity_below_floor')

  // Not one pricing column reaches the database; the identity label still does.
  const holdingWrites = db.writes.filter((w) => w.table === 'investor_portfolio_holdings')
  for (const write of holdingWrites) {
    eq(Object.keys(write.patch).sort(), ['asset_symbol', 'name'])
  }
  eq(db.tables.investor_portfolio_holdings.find((r: { id: string }) => r.id === 'streamgpt').price_status, 'unpriced')
  eq(db.tables.investor_portfolio_holdings.find((r: { id: string }) => r.id === 'streamgpt').current_price, undefined)
  // The run ledger records that the run priced nothing.
  eq(db.writes.find((w) => w.table === 'intel_holding_resolution_runs')!.patch, { priced: 0, credits: 2 })
})

Deno.test('unprice resets only this feature\'s own writes, in this org', async () => {
  const H1 = '66666666-6666-4666-8666-666666666666'
  const H2 = '77777777-7777-4777-8777-777777777777'
  const H3 = '88888888-8888-4888-8888-888888888888'
  const H4 = '99999999-9999-4999-8999-999999999999'
  const db = fakeDb({
    ...MEMBERSHIP,
    investor_portfolio_holdings: [
      holding({ id: H1, price_status: 'priced', price_source: 'coinmarketcap_dex', current_price: 3_723_685, current_value: 372_368_500, last_priced_at: '2026-09-15T11:00:00Z' }),
      holding({ id: H2, price_status: 'priced', price_source: 'coinmarketcap_dex', current_price: 1, current_value: 2 }),
      // Priced by another path: not ours to revert.
      holding({ id: H3, price_status: 'priced', price_source: 'birdeye_snapshot', current_price: 9, current_value: 18 }),
      // Another org's row, even if the id is supplied.
      holding({ id: H4, org_id: OTHER_ORG, price_status: 'priced', price_source: 'coinmarketcap_dex', current_price: 9 }),
    ],
  })
  const body = await (await call(db, { op: 'unprice', orgId: ORG, holdingIds: [H1, H2, H3, H4, H1] })).json()

  eq(body.op, 'unprice')
  eq(body.requested, 4, 'duplicate ids are collapsed before anything is touched')
  eq(body.reset, 2)
  eq(body.skipped, 2)
  eq(body.holdingIds.sort(), [H1, H2].sort())
  eq(body.priceSource, 'coinmarketcap_dex')

  const write = db.writes.find((w) => w.table === 'investor_portfolio_holdings')!
  eq(Object.keys(write.patch).sort(), ['current_price', 'current_value', 'last_priced_at', 'price_source', 'price_status'])
  eq(write.patch.price_status, 'unpriced')
  eq(write.patch.current_price, null)
  eq(write.patch.current_value, null)
  eq(write.patch.price_source, null)
  eq(write.patch.last_priced_at, null)
  eq(write.filters, { org_id: ORG, price_source: 'coinmarketcap_dex' })
  eq(write.matched.sort(), [H1, H2].sort())

  const rows = db.tables.investor_portfolio_holdings
  eq(rows.find((r: { id: string }) => r.id === H1).current_price, null)
  eq(rows.find((r: { id: string }) => r.id === H3).current_price, 9, 'the Birdeye price is untouched')
  eq(rows.find((r: { id: string }) => r.id === H4).current_price, 9, 'the other org is untouched')
  // Recorded in the same ledger, spending nothing.
  const run = db.inserts.find((i) => i.table === 'intel_holding_resolution_runs')!
  eq([run.row.requested, run.row.priced, run.row.credits], [4, 0, 0])
})

Deno.test('an undo is never refused by the rate limit', async () => {
  const H1 = '66666666-6666-4666-8666-666666666666'
  const db = fakeDb({
    ...MEMBERSHIP,
    investor_portfolio_holdings: [holding({ id: H1, price_status: 'priced', price_source: 'coinmarketcap_dex', current_price: 5 })],
    // The organisation has already spent every run in the window.
    intel_holding_resolution_runs: [0, 1, 2, 3].map((i) => ({ id: `r${i}`, org_id: ORG, ran_at: new Date(NOW.getTime() - i * 60_000).toISOString() })),
  })
  const response = await call(db, { op: 'unprice', orgId: ORG, holdingIds: [H1] })
  eq(response.status, 200, 'a bad write must always be reversible')
  eq((await response.json()).reset, 1)
})

Deno.test('unprice is bounded and takes only well-formed ids', async () => {
  const db = fakeDb({ ...MEMBERSHIP, investor_portfolio_holdings: [] })
  const factory = clientFactoryFor(db) as never
  const tooMany = Array.from({ length: 51 }, (_, i) => `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`)
  const cases: unknown[] = [
    { op: 'unprice', orgId: ORG },
    { op: 'unprice', orgId: ORG, holdingIds: [] },
    { op: 'unprice', orgId: ORG, holdingIds: ['not-a-uuid'] },
    { op: 'unprice', orgId: ORG, holdingIds: tooMany },
  ]
  for (const body of cases) {
    const response = await handlePortfolioIdentity(post(body), factory, { now: () => NOW })
    eq(response.status, 400)
    eq((await response.json()).error, 'invalid_holding_ids')
  }
  eq(db.writes.length, 0)
  eq(db.inserts.length, 0)
})

Deno.test('malformed and unauthenticated requests never reach the book', async () => {
  const db = fakeDb({ ...MEMBERSHIP, investor_portfolio_holdings: [holding({ id: 'h1' })] })
  const factory = clientFactoryFor(db) as never

  const anonymous = await handlePortfolioIdentity(
    new Request('https://edge.test/x', { method: 'POST', body: '{}' }), factory, { now: () => NOW })
  eq(anonymous.status, 401)

  const cases: [unknown, string][] = [
    [{ op: 'resolve' }, 'invalid_org'],
    [{ op: 'resolve', orgId: 'not-a-uuid' }, 'invalid_org'],
    [{ op: 'resolve', orgId: ORG, portfolioId: 'nope' }, 'invalid_portfolio'],
    [{ op: 'resolve', orgId: ORG, limit: 0 }, 'invalid_limit'],
    [{ op: 'resolve', orgId: ORG, limit: 9999 }, 'invalid_limit'],
    [{ op: 'delete_everything', orgId: ORG }, 'invalid_op'],
  ]
  for (const [body, error] of cases) {
    const response = await handlePortfolioIdentity(post(body), factory, { now: () => NOW })
    assert([400].includes(response.status), `${error} should be a 400`)
    eq((await response.json()).error, error)
  }
  eq(db.writes.length, 0)

  const wrongMethod = await handlePortfolioIdentity(
    new Request('https://edge.test/x', { method: 'GET', headers: { Authorization: 'Bearer user-jwt' } }), factory, { now: () => NOW })
  eq(wrongMethod.status, 405)
})

Deno.test('a member of another organisation is refused before any read', async () => {
  const db = fakeDb({ org_members: [], profiles: [{ id: USER, is_super_admin: false }], investor_portfolio_holdings: [holding({ id: 'h1' })] })
  const response = await call(db, { op: 'resolve', orgId: OTHER_ORG })
  eq(response.status, 403)
  eq(db.writes.length, 0)
})

Deno.test('a failed write is reported rather than counted as success', async () => {
  const db = fakeDb(
    { ...MEMBERSHIP, investor_portfolio_holdings: [holding({ id: 'h1' })] },
    { 'investor_portfolio_holdings:update': 'permission denied' },
  )
  const provider = fakeProvider({
    dexBatch: { data: [{ pid: 199, addr: BASE_A, sym: 'A', p: 1, liqUsd: 70_000, mcap: 4_000_000 }] },
    dexPriceBatch: { data: [{ pid: 199, a: BASE_A, p: 1 }] },
  })
  const body = await (await call(db, { op: 'resolve', orgId: ORG }, provider)).json()
  eq(body.writeErrors, ['permission denied'])
})
