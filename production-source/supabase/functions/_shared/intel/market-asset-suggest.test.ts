import { assert, assertEquals } from 'jsr:@std/assert@1'
import { handleMarkets } from '../../intel-markets/index.ts'
import { suggestMarketAssets, SUGGEST_DEFAULT_LIMIT, SUGGEST_MAX_LIMIT, contractReadings, splitChainPrefix } from './market-asset-suggest.ts'

// ── The catalogue stand-in ───────────────────────────────────────────────────
// One in-memory `market_assets` table that applies the three filters the suggest
// probes actually use (eq, ilike, or on platforms->>slug) plus order and limit,
// so ranking is exercised against real filtering rather than a fixed answer.
type Row = Record<string, unknown>
const asset = (over: Row): Row => ({
  source_provider: 'coingecko', provider_id: 'x', symbol: 'X', normalized_symbol: 'X', name: 'X',
  primary_chain: null, market_cap: null, market_cap_rank: null, image_url: null, cached_image_url: null,
  platforms: {}, in_current_catalog: true, ...over,
})

const SOL_CMC = asset({ source_provider: 'coinmarketcap', provider_id: '5426', symbol: 'SOL', normalized_symbol: 'SOL', name: 'Solana', primary_chain: 'solana', market_cap: 59_207_303_672, market_cap_rank: 7 })
const SOL_CG = asset({ source_provider: 'coingecko', provider_id: 'solana', symbol: 'SOL', normalized_symbol: 'SOL', name: 'Solana', primary_chain: 'solana', market_cap: 58_492_858_523, market_cap_rank: 7 })
const SOL_TOMATO = asset({ source_provider: 'coingecko', provider_id: 'sol-the-trophy-tomato', symbol: 'SOL', normalized_symbol: 'SOL', name: 'Sol The Trophy Tomato', market_cap: 281_690, market_cap_rank: 652 })
const SOLAR = asset({ source_provider: 'coingecko', provider_id: 'solar', symbol: 'SXP', normalized_symbol: 'SXP', name: 'Solar', market_cap: 12_000_000 })
const USDC = asset({ source_provider: 'coinmarketcap', provider_id: '3408', symbol: 'USDC', normalized_symbol: 'USDC', name: 'USDC', primary_chain: 'ethereum', market_cap: 40_000_000_000, platforms: { ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' } })

function catalogue(rows: Row[], { fail = false } = {}) {
  const reads: Record<string, unknown>[] = []
  const like = (pattern: string, value: string) => {
    // The probes only ever send `text%`, `%text%` and escaped wildcards.
    const escaped = pattern.replace(/\\([%_])/g, '\u0000$1')
    const body = escaped.replace(/[.*+?^${}()|[\]]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.').replace(/\u0000(.)/g, '$1')
    return new RegExp(`^${body}$`, 'i').test(value)
  }
  const table = () => {
    let out = [...rows]
    const filters: string[] = []
    // deno-lint-ignore no-explicit-any
    const q: any = {}
    q.select = () => q
    q.eq = (column: string, value: unknown) => { filters.push(`eq:${column}`); out = out.filter((r) => String(r[column] ?? '') === String(value)); return q }
    q.ilike = (column: string, pattern: string) => { filters.push(`ilike:${column}`); out = out.filter((r) => like(pattern, String(r[column] ?? ''))); return q }
    q.or = (clause: string) => {
      filters.push('or:platforms')
      const wanted = clause.split(',').map((part) => {
        const [lhs, value] = part.split('.eq.')
        return { slug: lhs.replace('platforms->>', ''), value }
      })
      out = out.filter((r) => wanted.some((w) => String((r.platforms as Row)?.[w.slug] ?? '').toLowerCase() === String(w.value).toLowerCase()))
      return q
    }
    // deno-lint-ignore no-explicit-any
    q.order = (column: string, options: any) => { out = [...out].sort((a, b) => (Number(b[column] ?? -Infinity) - Number(a[column] ?? -Infinity)) * (options?.ascending ? -1 : 1)); return q }
    q.limit = (n: number) => { out = out.slice(0, n); reads.push({ filters: [...filters], limit: n, returned: out.length }); return Promise.resolve(fail ? { data: null, error: { message: 'down' } } : { data: out, error: null }) }
    return q
  }
  return { from: () => ({ select: () => table().select() }), reads }
}

// ── Detection reuse ──────────────────────────────────────────────────────────
Deno.test('A chain prefix is only honoured for a chain the registry carries', () => {
  assertEquals(splitChainPrefix('base:0xdeadbeef'), { chain: 'base', address: '0xdeadbeef' })
  assertEquals(splitChainPrefix('nowhere:0xdeadbeef'), null)
  assertEquals(splitChainPrefix('SOL'), null)
})

Deno.test('Contract readings come from the shared identifier detection, not a second parser', () => {
  const evm = contractReadings('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')
  assert(evm.length > 1, 'a bare EVM address reads as several chains')
  assertEquals(contractReadings('base:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'), [{ chain: 'base', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' }])
  assertEquals(contractReadings('So11111111111111111111111111111111111111112').map((r) => r.chain), ['solana'])
  // A ticker is not an identity: no contract probe is ever built from one.
  assertEquals(contractReadings('SOL'), [])
})

// ── Ranking ──────────────────────────────────────────────────────────────────
Deno.test('A ticker ranks its exact symbol matches first and collapses one asset carried by two catalogues', async () => {
  const db = catalogue([SOL_CMC, SOL_CG, SOL_TOMATO, SOLAR, USDC])
  const result = await suggestMarketAssets(db, 'SOL')
  assertEquals(result.error, null)
  assertEquals(result.matches.map((m) => `${m.sourceProvider}:${m.providerId}:${m.match}`), [
    'coinmarketcap:5426:symbol_exact',
    'coingecko:sol-the-trophy-tomato:symbol_exact',
    'coingecko:solar:name_prefix',
  ])
  // Solana is ONE asset: the CoinMarketCap row is kept and CoinGecko is named
  // rather than offered as a second, different asset.
  assertEquals(result.matches[0].alsoIn, ['coingecko'])
  assertEquals(result.matches[0].displayName, 'Solana')
  assertEquals(result.matches[0].marketCap, 59_207_303_672)
  assertEquals(result.matches[0].href, '/intel/markets/SOL?provider=coinmarketcap&id=5426')
  // The larger market cap leads inside the same match strength.
  assert((result.matches[0].marketCap ?? 0) > (result.matches[1].marketCap ?? 0))
})

Deno.test('A project name matches exactly and outranks every prefix and contains match', async () => {
  const db = catalogue([SOL_CMC, SOL_CG, SOL_TOMATO, SOLAR])
  const result = await suggestMarketAssets(db, 'solana')
  assertEquals(result.matches[0].match, 'name_exact')
  assertEquals(result.matches[0].providerId, '5426')
  assertEquals(result.matches.filter((m) => m.match === 'name_exact').length, 1)
  // "Sol The Trophy Tomato" does not contain "solana" and is not offered.
  assertEquals(result.matches.some((m) => m.providerId === 'sol-the-trophy-tomato'), false)
})

Deno.test('A pasted contract the catalogue carries answers as that catalogue asset', async () => {
  const db = catalogue([SOL_CMC, USDC])
  const result = await suggestMarketAssets(db, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')
  assertEquals(result.matches.length, 1)
  assertEquals(result.matches[0].match, 'contract')
  assertEquals(result.matches[0].href, '/intel/markets/USDC?provider=coinmarketcap&id=3408')
})

Deno.test('An address no catalogue carries keeps a route only when one chain can be read from it', async () => {
  const solana = await suggestMarketAssets(catalogue([SOL_CMC]), 'So11111111111111111111111111111111111111112')
  assertEquals(solana.matches.length, 1)
  assertEquals(solana.matches[0].sourceProvider, 'contract')
  assertEquals(solana.matches[0].providerId, 'solana:So11111111111111111111111111111111111111112')
  assertEquals(solana.matches[0].marketCap, null)
  // A bare EVM address reads as many chains, so it is never turned into a list
  // of guesses; the paste box resolver remains the way in.
  const evm = await suggestMarketAssets(catalogue([SOL_CMC]), '0x1111111111111111111111111111111111111111')
  assertEquals(evm.matches, [])
})

Deno.test('Typed punctuation cannot reshape the catalogue filter and wildcards stay literal', async () => {
  const db = catalogue([SOL_CMC, SOL_CG, SOL_TOMATO, SOLAR])
  const injected = await suggestMarketAssets(db, 'sol",name.eq.Solar')
  // The unsafe characters are dropped, so the text searched is plain.
  assertEquals(injected.q, 'solname.eq.Solar')
  assertEquals(injected.matches, [])
  const wildcard = await suggestMarketAssets(db, '%')
  assertEquals(wildcard.error, 'invalid_query')
  const wildcardPair = await suggestMarketAssets(db, '%%')
  assertEquals(wildcardPair.matches, [])
})

Deno.test('The query and limit are bounded before anything is read', async () => {
  const db = catalogue([SOL_CMC])
  assertEquals((await suggestMarketAssets(db, 's')).error, 'invalid_query')
  assertEquals((await suggestMarketAssets(db, '   ')).error, 'invalid_query')
  assertEquals((await suggestMarketAssets(db, null)).error, 'invalid_query')
  assertEquals(db.reads.length, 0, 'an invalid query never reaches the catalogue')
  assertEquals((await suggestMarketAssets(db, 'SOL')).limit, SUGGEST_DEFAULT_LIMIT)
  assertEquals((await suggestMarketAssets(db, 'SOL', 500)).limit, SUGGEST_MAX_LIMIT)
  assertEquals((await suggestMarketAssets(db, 'SOL', 0)).limit, SUGGEST_DEFAULT_LIMIT)
  // Every probe is bounded: a keystroke reads a page, never the catalogue.
  assert(db.reads.every((read) => Number(read.limit) <= 25))
})

Deno.test('An unreadable catalogue is reported rather than answered as no matches', async () => {
  const result = await suggestMarketAssets(catalogue([SOL_CMC], { fail: true }), 'SOL')
  assertEquals(result.error, 'catalogue_unavailable')
  assertEquals(result.matches, [])
})

// ── The op on intel-markets: auth, gating and cost ───────────────────────────
function handlerFixture({ member = true, allowed = true, surface = true, rows = [SOL_CMC, SOL_CG, SOL_TOMATO] as Row[] } = {}) {
  const rpcs: string[] = []
  const store = catalogue(rows)
  const db = {
    auth: { getUser: () => Promise.resolve({ data: { user: { id: 'verified-user' } }, error: null }) },
    // deno-lint-ignore no-explicit-any
    from: (table: string) => {
      if (table === 'market_assets') return store.from().select()
      // deno-lint-ignore no-explicit-any
      const q: any = { select: () => q, eq: () => q, maybeSingle: () => Promise.resolve({ data: table === 'org_members' && member ? { org_id: 'org' } : table === 'profiles' ? { is_super_admin: false } : null }) }
      return q
    },
    rpc: (name: string) => {
      rpcs.push(name)
      if (name === 'can_access_intel') return Promise.resolve({ data: allowed, error: null })
      if (name === 'intel_surface_allowed') return Promise.resolve({ data: surface, error: null })
      return Promise.resolve({ data: { records: [], total: 0, page: 0, limit: 50 }, error: null })
    },
  }
  return { factory: () => db, chains: () => Promise.resolve({ rows: [], unavailable: false }), rpcs, reads: store.reads }
}
const suggestRequest = (body: Record<string, unknown>, header = 'Bearer fixture-user') =>
  new Request('https://fixture.test/intel-markets', { method: 'POST', headers: { Authorization: header, 'Content-Type': 'application/json' }, body: JSON.stringify({ orgId: 'org', op: 'suggest', ...body }) })
async function withEnv(fn: () => Promise<void>) {
  const keys = { SUPABASE_URL: 'https://fixture.test', SUPABASE_ANON_KEY: 'fixture-anon' }
  const before = Object.fromEntries(Object.keys(keys).map((k) => [k, Deno.env.get(k)]))
  try { for (const [k, v] of Object.entries(keys)) Deno.env.set(k, v); await fn() }
  finally { for (const [k, v] of Object.entries(before)) if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v) }
}

Deno.test('Suggest answers the free market_boards surface with catalogue fields only and no provider call', () => withEnv(async () => {
  const f = handlerFixture()
  const fetched: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = ((input: unknown) => { fetched.push(String(input)); return Promise.resolve(new Response('{}', { status: 503 })) }) as typeof fetch
  try {
    const r = await handleMarkets(suggestRequest({ q: 'SOL' }), f.factory, f.chains)
    assertEquals(r.status, 200)
    const body = await r.json()
    assertEquals(body.suggest, true)
    assertEquals(body.q, 'SOL')
    assertEquals(body.limit, 8)
    assertEquals(body.matches[0].providerId, '5426')
    // Only catalogue fields ride in the response: nothing here needs a quote,
    // a candle or any other read a member would be charged for.
    assertEquals(Object.keys(body.matches[0]).sort(), ['alsoIn', 'chain', 'displayName', 'href', 'imageUrl', 'marketCap', 'match', 'normalizedSymbol', 'providerId', 'rank', 'sourceProvider', 'symbol'])
    // The entitlement and the surface are both checked, and the heavy screen is not run.
    assertEquals(f.rpcs, ['can_access_intel', 'intel_surface_allowed'])
    assertEquals(fetched, [])
    assertEquals(r.headers.get('Cache-Control'), 'private, no-store')
  } finally { globalThis.fetch = original }
}))

Deno.test('Suggest refuses an unverified caller, another organization and a locked surface before reading the catalogue', () => withEnv(async () => {
  const anonymous = handlerFixture()
  assertEquals((await handleMarkets(suggestRequest({ q: 'SOL' }, ''), anonymous.factory, anonymous.chains)).status, 401)
  assertEquals(anonymous.reads.length, 0)

  const outsider = handlerFixture({ member: false })
  assertEquals((await handleMarkets(suggestRequest({ q: 'SOL' }), outsider.factory, outsider.chains)).status, 403)
  assertEquals(outsider.reads.length, 0)

  const expired = handlerFixture({ allowed: false })
  assertEquals((await handleMarkets(suggestRequest({ q: 'SOL' }), expired.factory, expired.chains)).status, 403)
  assertEquals(expired.reads.length, 0)

  const locked = handlerFixture({ surface: false })
  const r = await handleMarkets(suggestRequest({ q: 'SOL' }), locked.factory, locked.chains)
  assertEquals(r.status, 403)
  assertEquals(await r.json(), { error: 'intel_surface_locked', surface: 'market_boards' })
  assertEquals(locked.reads.length, 0, 'a locked surface never reads the withheld data')
}))

Deno.test('Suggest rejects a query too short to search without touching the catalogue', () => withEnv(async () => {
  const f = handlerFixture()
  const r = await handleMarkets(suggestRequest({ q: 'S' }), f.factory, f.chains)
  assertEquals(r.status, 400)
  assertEquals(await r.json(), { error: 'invalid_query' })
  assertEquals(f.reads.length, 0)
}))
