import { assertEquals as eq } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  resolveAsset,
  RESOLUTIONS_PER_HOUR,
  __resetResolverRateLimitForTests,
  decodeAbiString,
  decodeAbiUint,
  type ResolverDeps,
} from './asset-resolver.ts'

// ── Fakes ────────────────────────────────────────────────────────────────────
// A PostgREST-shaped stub: it records the tables read and the filters applied so
// a test can assert "the catalogue answered and nothing else was touched".

type TableRows = Record<string, unknown[]>

function fakeAdmin(tables: TableRows = {}) {
  const reads: string[] = []
  const rpcCalls: { name: string; params: Record<string, unknown> }[] = []
  const client = {
    reads,
    rpcCalls,
    from(table: string) {
      reads.push(table)
      const filters: { column: string; values: string[] }[] = []
      const q: Record<string, unknown> = {}
      const chain = () => q
      q.select = chain
      q.limit = () => ({ data: match(tables[table] || [], filters), error: null })
      q.eq = (column: string, value: unknown) => { filters.push({ column, values: [String(value)] }); return q }
      q.in = (column: string, values: unknown[]) => { filters.push({ column, values: values.map(String) }); return q }
      q.or = (clause: string) => { filters.push({ column: '__or', values: [clause] }); return q }
      return q
    },
    rpc(name: string, params: Record<string, unknown>) {
      rpcCalls.push({ name, params })
      return Promise.resolve({ data: null, error: null })
    },
  }
  return client
}

// `.or()` clauses are `platforms->>slug.eq.value`; the fake matches them the way
// PostgREST would, so the resolver's real filter shape is exercised.
function match(rows: unknown[], filters: { column: string; values: string[] }[]): unknown[] {
  return rows.filter((row) => filters.every((f) => {
    const record = row as Record<string, unknown>
    if (f.column === '__or') {
      return f.values[0].split(',').some((clause) => {
        const m = /^platforms->>([a-z0-9._-]+)\.eq\.(.+)$/.exec(clause)
        if (!m) return false
        const platforms = (record.platforms || {}) as Record<string, unknown>
        return String(platforms[m[1]] ?? '') === m[2]
      })
    }
    return f.values.includes(String(record[f.column] ?? ''))
  }))
}

function spyDeps(overrides: Partial<ResolverDeps> = {}) {
  const calls: string[] = []
  const deps: Partial<ResolverDeps> = {
    now: (() => { let t = 0; return () => (t += 5) })(),
    // deno-lint-ignore no-explicit-any
    requestCmc: ((name: string) => { calls.push(`cmc:${name}`); return Promise.resolve({ payload: null, state: 'unavailable', reason: 'not_found', provenance: {} }) }) as any,
    // deno-lint-ignore no-explicit-any
    searchTokens: ((q: string) => { calls.push(`searchTokens:${q}`); return Promise.resolve([]) }) as any,
    // deno-lint-ignore no-explicit-any
    getTokenPairs: ((c: string) => { calls.push(`getTokenPairs:${c}`); return Promise.resolve(null) }) as any,
    // deno-lint-ignore no-explicit-any
    getTokenInfo: ((c: string) => { calls.push(`getTokenInfo:${c}`); return Promise.resolve(null) }) as any,
    // deno-lint-ignore no-explicit-any
    getTokenMetadata: ((c: string) => { calls.push(`getTokenMetadata:${c}`); return Promise.resolve(null) }) as any,
    rpcCall: ((url: string) => { calls.push(`rpc:${url}`); return Promise.resolve({}) }),
    ...overrides,
  }
  return { calls, deps }
}

const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const TON_JETTON = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'

const step = (result: { provenance: { step: string; outcome: string; detail?: string }[] }, name: string) =>
  result.provenance.find((p) => p.step === name)

function reset() { __resetResolverRateLimitForTests() }

// ── Tests ────────────────────────────────────────────────────────────────────

Deno.test('a catalogued contract resolves without a single provider call', async () => {
  reset()
  const admin = fakeAdmin({
    market_assets: [{
      source_provider: 'coinmarketcap', provider_id: '825', symbol: 'USDT', name: 'Tether USDt',
      image_url: 'https://cmc/825.png', in_current_catalog: true,
      platforms: { ethereum: USDT.toLowerCase(), tron: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' },
    }],
  })
  const { calls, deps } = spyDeps()
  const result = await resolveAsset(admin, { query: USDT, chain: 'ethereum', userId: 'u1', deps })

  eq(result.status, 'resolved')
  eq(result.identity?.kind, 'cmc')
  eq(result.identity?.providerId, '825')
  eq(result.identity?.symbol, 'USDT')
  eq(result.identity?.chain, 'ethereum')
  eq(result.identity?.address, USDT.toLowerCase())
  eq(result.identity?.canonicalKey, `eip155:1/erc20:${USDT.toLowerCase()}`)
  eq(result.identity?.route, '/intel/markets/USDT?provider=coinmarketcap&id=825')
  eq(step(result, 'catalogue')?.outcome, 'hit')
  // Step 4 always runs once for a CMC-listable namespace, but only to confirm
  // the canonical id — with the id already known it asks by id, not by address.
  eq(calls, ['cmc:metadata'])
  eq(step(result, 'dexscreener')?.outcome, 'skipped')
  eq(step(result, 'rpc')?.outcome, 'skipped')
})

Deno.test('an EVM address on two chains returns candidates sorted by liquidity, no identity', async () => {
  reset()
  const admin = fakeAdmin()
  const { deps } = spyDeps({
    // deno-lint-ignore no-explicit-any
    searchTokens: (() => Promise.resolve([
      { chain: 'base', tokenAddress: USDC_BASE, symbol: 'WRAP', name: 'Wrapped', liquidityUsd: 12_000 },
      { chain: 'ethereum', tokenAddress: USDC_BASE, symbol: 'WRAP', name: 'Wrapped', liquidityUsd: 980_000 },
      { chain: 'base', tokenAddress: USDC_BASE, symbol: 'WRAP', name: 'Wrapped', liquidityUsd: 4_000 },
    ])) as any,
  })
  const result = await resolveAsset(admin, { query: USDC_BASE, userId: 'u2', deps })

  eq(result.status, 'ambiguous')
  eq(result.identity, null)
  eq(result.reason, 'chain_selection_required')
  eq(result.candidates.map((c) => c.chain), ['ethereum', 'base'])
  eq(result.candidates[0].liquidityUsd, 980_000)
  eq(result.candidates[1].liquidityUsd, 12_000)
  eq(result.candidates[0].route, `/intel/markets/WRAP?provider=contract&id=${encodeURIComponent(`ethereum:${USDC_BASE}`)}`)
  eq(result.demandRecorded, false)
  eq(admin.rpcCalls.length, 0)
})

Deno.test('a Solana mint resolves through cmc_metadata with every deployment', async () => {
  reset()
  const admin = fakeAdmin()
  const { calls, deps } = spyDeps({
    // deno-lint-ignore no-explicit-any
    requestCmc: ((name: string, params: Record<string, string>) => {
      calls.push(`cmc:${name}:${params.address || params.id}`)
      if (name !== 'metadata') return Promise.resolve({ payload: null, reason: 'unsupported' })
      return Promise.resolve({
        payload: {
          data: {
            '3408': {
              id: 3408, name: 'USDC', symbol: 'USDC', logo: 'https://cmc/3408.png',
              contract_address: [
                { contract_address: USDC_SOL, platform: { name: 'Solana', coin: { slug: 'solana' } } },
                { contract_address: USDC_BASE, platform: { name: 'Base', coin: { slug: 'base' } } },
              ],
            },
          },
        },
      })
    }) as any,
  })
  const result = await resolveAsset(admin, { query: USDC_SOL, userId: 'u3', deps })

  eq(result.status, 'resolved')
  eq(result.identity?.kind, 'cmc')
  eq(result.identity?.providerId, '3408')
  eq(result.identity?.chain, 'solana')
  eq(result.identity?.canonicalKey, `solana:mainnet/token:${USDC_SOL}`)
  eq(result.identity?.deployments.map((d) => d.chain), ['solana', 'base'])
  eq(result.identity?.deployments.every((d) => d.source === 'cmc_metadata'), true)
  eq(step(result, 'cmc_metadata')?.outcome, 'hit')
  eq(calls.filter((c) => c.startsWith('cmc:metadata')).length, 1)
  eq(admin.rpcCalls[0].params.p_asset_key, 'cmc:3408')
})

Deno.test('a TON jetton resolves through cmc_metadata', async () => {
  reset()
  const admin = fakeAdmin()
  const { deps } = spyDeps({
    // deno-lint-ignore no-explicit-any
    requestCmc: ((name: string) => {
      if (name !== 'metadata') return Promise.resolve({ payload: null, reason: 'unsupported' })
      return Promise.resolve({
        payload: {
          data: [{
            id: 11419, name: 'Toncoin', symbol: 'TON', logo: 'https://cmc/11419.png',
            contract_address: [{ contract_address: TON_JETTON, platform: { name: 'TON', coin: { slug: 'toncoin' } } }],
          }],
        },
      })
    }) as any,
  })
  const result = await resolveAsset(admin, { query: TON_JETTON, userId: 'u4', deps })

  eq(result.status, 'resolved')
  eq(result.kind, 'ton')
  eq(result.identity?.providerId, '11419')
  eq(result.identity?.symbol, 'TON')
  eq(result.identity?.chain, 'ton')
  eq(result.identity?.deployments[0].chain, 'ton')
  eq(step(result, 'cmc_metadata')?.outcome, 'hit')
})

Deno.test('a CMC address rejection is a skipped step, never a resolver error', async () => {
  reset()
  const admin = fakeAdmin()
  const { deps } = spyDeps({
    // deno-lint-ignore no-explicit-any
    requestCmc: (() => Promise.reject(new Error('invalid_contract_address'))) as any,
  })
  const result = await resolveAsset(admin, { query: TON_JETTON, userId: 'u5', deps })
  eq(step(result, 'cmc_metadata')?.outcome, 'skipped')
  eq(step(result, 'cmc_metadata')?.detail, 'cmc_address_format_unsupported')
  eq(result.status, 'unresolved')
})

Deno.test('a valid Base address nothing answers is unresolved, with a truthful contract route', async () => {
  reset()
  const admin = fakeAdmin()
  const { deps } = spyDeps({
    rpcCall: (() => Promise.resolve([])),
  })
  const result = await resolveAsset(admin, { query: USDC_BASE, chain: 'base', orgId: 'org-1', userId: 'u6', deps })

  eq(result.status, 'unresolved')
  eq(result.reason, 'no_source_answered')
  eq(result.identity?.kind, 'contract')
  eq(result.identity?.symbol, null)
  eq(result.identity?.name, null)
  eq(result.identity?.address, USDC_BASE)
  eq(result.identity?.chain, 'base')
  eq(result.identity?.route, `/intel/markets/${USDC_BASE}?provider=contract&id=${encodeURIComponent(`base:${USDC_BASE}`)}`)
  eq(result.demandRecorded, false)
  eq(admin.rpcCalls.length, 0)
  // Every step is accounted for and none of them claimed a hit.
  eq(result.provenance.map((p) => p.step), [
    'catalogue', 'entities', 'memecoin', 'cmc_metadata', 'cmc_dex', 'dexscreener', 'geckoterminal', 'birdeye', 'rpc',
  ])
  eq(result.provenance.some((p) => p.outcome === 'hit'), false)
  eq(step(result, 'catalogue')?.outcome, 'miss')
  eq(step(result, 'entities')?.outcome, 'miss')
  eq(step(result, 'memecoin')?.outcome, 'miss')
  eq(step(result, 'dexscreener')?.outcome, 'miss')
})

Deno.test('an invalid query reaches no provider and no table', async () => {
  reset()
  for (const query of ['', 'BTC', "'; DROP TABLE entities; --", 'https://example.com/x', '0xdead']) {
    const admin = fakeAdmin()
    const { calls, deps } = spyDeps()
    const result = await resolveAsset(admin, { query, userId: 'u7', deps })
    eq(result.status, 'invalid')
    eq(result.identity, null)
    eq(result.provenance.length, 0)
    eq(calls.length, 0, `${query} caused ${calls.join(',')}`)
    eq(admin.reads.length, 0)
    eq(admin.rpcCalls.length, 0)
  }
})

Deno.test('the 31st resolution in an hour is rate limited', async () => {
  reset()
  const admin = fakeAdmin()
  for (let i = 0; i < RESOLUTIONS_PER_HOUR; i++) {
    const { deps } = spyDeps()
    const result = await resolveAsset(admin, { query: USDC_BASE, chain: 'base', userId: 'burst', deps })
    eq(result.status, 'unresolved', `attempt ${i + 1}`)
  }
  const { calls, deps } = spyDeps()
  const limited = await resolveAsset(admin, { query: USDC_BASE, chain: 'base', userId: 'burst', deps })
  eq(limited.status, 'rate_limited')
  eq(limited.reason, 'rate_limited')
  eq(limited.provenance.length, 0)
  eq(calls.length, 0)
  // Another user is unaffected.
  const other = await resolveAsset(admin, { query: USDC_BASE, chain: 'base', userId: 'someone-else', deps: spyDeps().deps })
  eq(other.status, 'unresolved')
})

Deno.test('demand is recorded once per resolution with the contract key', async () => {
  reset()
  const admin = fakeAdmin({
    memecoin_latest_tokens: [{
      chain: 'base', token_address: USDC_BASE, symbol: 'DEGEN', name: 'Degen',
      image_url: 'https://img/degen.png', liquidity_usd: 50_000, price_usd: 0.01,
    }],
  })
  const { deps } = spyDeps()
  const result = await resolveAsset(admin, { query: USDC_BASE, chain: 'base', userId: 'u8', deps })

  eq(result.status, 'resolved')
  eq(result.identity?.kind, 'contract')
  eq(result.identity?.symbol, 'DEGEN')
  eq(result.demandRecorded, true)
  eq(admin.rpcCalls.length, 1)
  eq(admin.rpcCalls[0].name, 'intel_record_asset_demand')
  eq(admin.rpcCalls[0].params, { p_asset_key: `base:${USDC_BASE}`, p_provider: 'contract', p_provider_id: `base:${USDC_BASE}` })
  // Nothing about who searched is ever passed.
  eq(Object.keys(admin.rpcCalls[0].params).some((k) => /user|org|actor/i.test(k)), false)
})

Deno.test('an org entity answers without any provider call but never invents a market', async () => {
  reset()
  const admin = fakeAdmin({
    entities: [{
      org_id: 'org-1', chain_namespace: 'eip155', chain_id: '8453', contract_address: USDC_BASE,
      display_symbol: 'AERO', asset_id: USDC_BASE, provider_ids: { coinmarketcap: '29270' },
    }],
  })
  const { deps } = spyDeps()
  const result = await resolveAsset(admin, { query: USDC_BASE, chain: 'base', orgId: 'org-1', userId: 'u9', deps })

  eq(step(result, 'entities')?.outcome, 'hit')
  eq(result.status, 'resolved')
  eq(result.identity?.chain, 'base')
  // The org row supplied a CMC id, so the route is the canonical CMC page.
  eq(result.identity?.kind, 'cmc')
  eq(result.identity?.providerId, '29270')
})

Deno.test('entities are skipped entirely when no org is supplied', async () => {
  reset()
  const admin = fakeAdmin({ entities: [{ chain_namespace: 'eip155', chain_id: '8453', contract_address: USDC_BASE, display_symbol: 'AERO' }] })
  const { deps } = spyDeps()
  const result = await resolveAsset(admin, { query: USDC_BASE, chain: 'base', userId: 'u10', deps })
  eq(step(result, 'entities')?.outcome, 'skipped')
  eq(step(result, 'entities')?.detail, 'no_org')
  eq(admin.reads.includes('entities'), false)
})

Deno.test('the RPC step is the last resort and reads the contract itself', async () => {
  reset()
  const admin = fakeAdmin()
  const urls: string[] = []
  const { deps } = spyDeps({
    rpcCall: ((url: string) => {
      urls.push(url)
      return Promise.resolve([
        { id: 1, result: '0x' + '0'.repeat(62) + '20' + '0'.repeat(62) + '05' + Buffer('Aerod') },
        { id: 2, result: '0x' + '0'.repeat(62) + '20' + '0'.repeat(62) + '04' + Buffer('AERO') },
        { id: 3, result: '0x0000000000000000000000000000000000000000000000000000000000000012' },
        { id: 4, result: '0x00000000000000000000000000000000000000000000000000000000000f4240' },
      ])
    }),
  })
  const result = await resolveAsset(admin, { query: USDC_BASE, chain: 'base', userId: 'u11', deps })

  eq(urls, ['https://mainnet.base.org'])
  eq(step(result, 'rpc')?.outcome, 'hit')
  eq(result.identity?.symbol, 'AERO')
  eq(result.identity?.name, 'Aerod')
  eq(result.identity?.decimals, 18)
  eq(result.status, 'resolved')
})

Deno.test('namespaces with no RPC adapter say so rather than guessing', async () => {
  reset()
  const admin = fakeAdmin()
  const { deps } = spyDeps()
  const result = await resolveAsset(admin, { query: 'wrap.near', userId: 'u12', deps })
  eq(step(result, 'rpc')?.outcome, 'skipped')
  eq(step(result, 'rpc')?.detail, 'no_rpc_adapter')
  eq(result.status, 'unresolved')
})

Deno.test('ABI decoding handles dynamic strings, bytes32 names and uints', () => {
  eq(decodeAbiString('0x' + '0'.repeat(62) + '20' + '0'.repeat(62) + '04' + Buffer('AERO')), 'AERO')
  eq(decodeAbiString('0x' + Buffer('MKR').padEnd(64, '0')), 'MKR')
  eq(decodeAbiString('0x'), null)
  eq(decodeAbiString('not-hex'), null)
  eq(decodeAbiUint('0x12'), 18)
  eq(decodeAbiUint('0x'), null)
})

/** Hex-encode ASCII, right-padded to a 32-byte word. */
function Buffer(value: string): string {
  const hex = [...value].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
  return hex.padEnd(64, '0')
}
