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
    // deno-lint-ignore no-explicit-any
    indexAsset: ((_admin: unknown, identity: any) => {
      calls.push(`index:${identity?.provider}:${identity?.providerId}`)
      return Promise.resolve({ indexed: true, demanded: identity?.kind === 'cmc', reasons: [] })
    }) as any,
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
  eq(calls, ['cmc:metadata', 'index:coinmarketcap:825'])
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

Deno.test('a resolved asset is indexed, and the index is a tenth provenance entry', async () => {
  reset()
  const admin = fakeAdmin({
    memecoin_latest_tokens: [{ chain: 'base', token_address: USDC_BASE, symbol: 'DEGEN', name: 'Degen', liquidity_usd: 50_000 }],
  })
  const seen: unknown[] = []
  const { deps } = spyDeps({
    // deno-lint-ignore no-explicit-any
    indexAsset: ((_admin: unknown, identity: unknown, options: unknown) => {
      seen.push({ identity, options })
      return Promise.resolve({ indexed: true, demanded: false, reasons: [] })
    }) as any,
  })
  const result = await resolveAsset(admin, { query: USDC_BASE, chain: 'base', orgId: 'org-1', userId: 'u13', deps })

  eq(result.status, 'resolved')
  eq(result.indexed, { inserted: true, demanded: false })
  // The ladder is still nine steps; `index` is appended after them.
  eq(result.provenance.length, 10)
  eq(result.provenance[9].step, 'index')
  eq(result.provenance[9].outcome, 'hit')
  eq(seen.length, 1)
  // The org and user reach the indexer only so the worker can recheck that
  // member's access before it refreshes; the demand ledger stays anonymous.
  eq((seen[0] as { options: Record<string, unknown> }).options.orgId, 'org-1')
  eq((seen[0] as { options: Record<string, unknown> }).options.userId, 'u13')
})

Deno.test('an index that already has the asset, or fails outright, never changes the resolution', async () => {
  reset()
  const admin = fakeAdmin({
    memecoin_latest_tokens: [{ chain: 'base', token_address: USDC_BASE, symbol: 'DEGEN', name: 'Degen', liquidity_usd: 50_000 }],
  })
  const existing = await resolveAsset(admin, {
    query: USDC_BASE, chain: 'base', userId: 'u14',
    // deno-lint-ignore no-explicit-any
    deps: spyDeps({ indexAsset: (() => Promise.resolve({ indexed: false, demanded: true, reasons: ['already_indexed'] })) as any }).deps,
  })
  eq(existing.status, 'resolved')
  eq(existing.indexed, { inserted: false, demanded: true })
  eq(step(existing, 'index')?.outcome, 'miss')
  eq(step(existing, 'index')?.detail, 'already_indexed')

  reset()
  const broken = await resolveAsset(admin, {
    query: USDC_BASE, chain: 'base', userId: 'u15',
    // deno-lint-ignore no-explicit-any
    deps: spyDeps({ indexAsset: (() => Promise.reject(new Error('postgrest_down'))) as any }).deps,
  })
  eq(broken.status, 'resolved')
  eq(broken.identity?.symbol, 'DEGEN')
  eq(broken.indexed, { inserted: false, demanded: false })
  eq(step(broken, 'index')?.outcome, 'error')
  eq(step(broken, 'index')?.detail, 'index_failed:postgrest_down')
})

Deno.test('nothing is indexed when nothing was resolved', async () => {
  reset()
  const admin = fakeAdmin()
  const { calls, deps } = spyDeps()
  const unresolved = await resolveAsset(admin, { query: USDC_BASE, chain: 'base', userId: 'u16', deps })
  eq(unresolved.status, 'unresolved')
  eq(unresolved.indexed, { inserted: false, demanded: false })
  eq(unresolved.provenance.some((p) => p.step === 'index'), false)
  eq(calls.some((c) => c.startsWith('index:')), false)
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

Deno.test('the RPC step is the last resort, reads the contract itself, and claims no market', async () => {
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
  // The chain named the token; no market source did. That is identity_only, and
  // it is still indexed and demanded — searchable, with nothing pricing it.
  eq(result.status, 'identity_only')
  eq(result.reason, 'no_market_source')
  eq(result.indexed, { inserted: true, demanded: false })
  eq(result.demandRecorded, true)
})

Deno.test('namespaces with no RPC adapter say so rather than guessing', async () => {
  reset()
  const admin = fakeAdmin()
  const { deps } = spyDeps()
  // Move coin types are Sui and Aptos; neither chain has a metadata adapter we
  // have verified, so the step is skipped with a reason, not attempted.
  const result = await resolveAsset(admin, { query: '0x2::sui::SUI', chain: 'sui', userId: 'u12', deps })
  eq(step(result, 'rpc')?.outcome, 'skipped')
  eq(step(result, 'rpc')?.detail, 'no_rpc_adapter')
  eq(result.status, 'unresolved')
})

// ── The long tail: one adapter per namespace, and identity_only ──────────────

Deno.test('a NEAR token resolves through its adapter as identity_only', async () => {
  reset()
  const admin = fakeAdmin()
  const urls: string[] = []
  const { deps } = spyDeps({
    rpcCall: ((url: string, body: unknown) => {
      urls.push(url)
      // deno-lint-ignore no-explicit-any
      const method = (body as any)?.params?.method_name
      const bytes = (value: unknown) => [...new TextEncoder().encode(JSON.stringify(value))]
      if (method === 'ft_metadata') {
        return Promise.resolve({ result: { result: bytes({ spec: 'ft-1.0.0', name: 'Wrapped NEAR fungible token', symbol: 'wNEAR', decimals: 24 }) } })
      }
      return Promise.resolve({ result: { result: bytes('1000000') } })
    }),
  })
  const result = await resolveAsset(admin, { query: 'wrap.near', userId: 'near-1', deps })

  eq(step(result, 'rpc')?.outcome, 'hit')
  eq(step(result, 'rpc')?.detail, 'near:wNEAR')
  eq(result.status, 'identity_only')
  eq(result.reason, 'no_market_source')
  eq(result.identity?.kind, 'contract')
  eq(result.identity?.chain, 'near')
  eq(result.identity?.symbol, 'wNEAR')
  eq(result.identity?.name, 'Wrapped NEAR fungible token')
  eq(result.identity?.decimals, 24)
  eq(result.identity?.deployments, [{ chain: 'near', address: 'wrap.near', source: 'rpc' }])
  eq(result.identity?.route, '/intel/markets/wNEAR?provider=contract&id=near%3Awrap.near')
  eq([...new Set(urls)], ['https://rpc.mainnet.near.org'])
  // Indexed and demanded like any other resolution.
  eq(result.indexed.inserted, true)
  eq(admin.rpcCalls[0].params.p_asset_key, 'near:wrap.near')
})

Deno.test('a Cardano policy id is chain-bound and reaches the Cardano adapter', async () => {
  reset()
  const admin = fakeAdmin()
  const policy = '8db269c3ec630e06ae29f74bc39edd1f87c819f1056206e879a1cd61'
  const assetName = '446a65644d6963726f555344'
  const { deps } = spyDeps({
    rpcCall: ((url: string) => {
      if (!url.endsWith('/asset_info')) return Promise.reject(new Error(`unexpected:${url}`))
      return Promise.resolve([{
        policy_id: policy, asset_name: assetName, asset_name_ascii: 'DjedMicroUSD', total_supply: '4231150000000',
        token_registry_metadata: { name: 'Djed', ticker: 'DJED', decimals: 6 },
      }])
    }),
  })
  const result = await resolveAsset(admin, { query: `${policy}.${assetName}`, userId: 'ada-1', deps })

  eq(result.kind, 'cardano')
  eq(result.identity?.chain, 'cardano')
  eq(result.identity?.symbol, 'DJED')
  eq(result.identity?.name, 'Djed')
  eq(result.status, 'identity_only')
  eq(step(result, 'rpc')?.detail, 'cardano:DJED')
})

Deno.test('every long-tail namespace reaches an adapter instead of no_rpc_adapter', async () => {
  // A Tron account id also fits the Solana mint shape, so the paste is
  // chain-ambiguous until a hint picks one — exactly as the detector intends.
  // Every other namespace here is unambiguous and carries no hint.
  const pastes: [string, string, string, string?][] = [
    ['ton', TON_JETTON, 'toncenter.com'],
    ['tron', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'trongrid.io', 'tron'],
    ['xrpl', 'USD.rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B', 'xrplcluster.com'],
    ['stellar', 'USDC-GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN', 'horizon.stellar.org'],
    ['near', 'wrap.near', 'rpc.mainnet.near.org'],
    ['cardano', '29d222ce763455e3d7a09a665ce554f00ac89d2e99a1a83415e5c0d6', 'api.koios.rest'],
    ['injective', 'ibc/C4CFF46FD6DE35CA4CF4CE031E643C8FDC9BA4B99AE598E9B0ED98FE3A2319F9', 'lcd.injective.network'],
  ]
  for (const [chain, query, host, hint] of pastes) {
    reset()
    const urls: string[] = []
    // Every endpoint answers "nothing here": the step must be a miss with the
    // real endpoint contacted, never a skip.
    const { deps } = spyDeps({ rpcCall: ((url: string) => { urls.push(url); return Promise.resolve({}) }) })
    const result = await resolveAsset(fakeAdmin(), { query, chain: hint ?? null, userId: `tail-${chain}`, deps })
    eq(step(result, 'rpc')?.outcome, 'miss', `${chain}: ${step(result, 'rpc')?.detail}`)
    eq(step(result, 'rpc')?.detail, 'no_chain_metadata', chain)
    eq(urls.some((u) => u.includes(host)), true, `${chain} did not contact ${host}: ${urls.join(',')}`)
    eq(result.status, 'unresolved', chain)
  }
})

Deno.test('an adapter transport failure is an error entry, never a failed resolution', async () => {
  reset()
  const admin = fakeAdmin()
  const { deps } = spyDeps({ rpcCall: (() => Promise.reject(new Error('rpc_http_503'))) })
  const result = await resolveAsset(admin, { query: TON_JETTON, userId: 'ton-2', deps })
  eq(step(result, 'rpc')?.outcome, 'error')
  eq(step(result, 'rpc')?.detail, 'rpc_http_503')
  eq(result.status, 'unresolved')
  eq(result.identity?.chain, 'ton')
})

Deno.test('a per-call failure inside an adapter keeps the fields the other calls returned', async () => {
  reset()
  // NEAR and Tron issue their calls in parallel and swallow a single failure, so
  // one endpoint hiccup does not erase an identity the others supplied.
  const { deps } = spyDeps({
    rpcCall: ((_url: string, body: unknown) => {
      // deno-lint-ignore no-explicit-any
      if ((body as any)?.params?.method_name === 'ft_total_supply') return Promise.reject(new Error('near_timeout'))
      const bytes = [...new TextEncoder().encode(JSON.stringify({ name: 'Wrapped NEAR', symbol: 'wNEAR', decimals: 24 }))]
      return Promise.resolve({ result: { result: bytes } })
    }),
  })
  const result = await resolveAsset(fakeAdmin(), { query: 'wrap.near', userId: 'near-3', deps })
  eq(step(result, 'rpc')?.outcome, 'hit')
  eq(result.identity?.symbol, 'wNEAR')
  eq(result.status, 'identity_only')
})

Deno.test('a market source keeps the status resolved, and a CMC identity is never identity-only', async () => {
  reset()
  // A DEX snapshot answered: this asset has a market, so it stays `resolved`.
  const withMarket = fakeAdmin({
    memecoin_latest_tokens: [{ chain: 'base', token_address: USDC_BASE, symbol: 'DEGEN', name: 'Degen', liquidity_usd: 50_000 }],
  })
  const priced = await resolveAsset(withMarket, { query: USDC_BASE, chain: 'base', userId: 'mix-1', deps: spyDeps().deps })
  eq(priced.status, 'resolved')
  eq(priced.reason, null)

  reset()
  // An org entity supplied a CoinMarketCap id and no market source answered.
  // A CMC id always has a canonical market route, so it is not identity-only.
  const withEntity = fakeAdmin({
    entities: [{
      org_id: 'org-1', chain_namespace: 'eip155', chain_id: '8453', contract_address: USDC_BASE,
      display_symbol: 'AERO', provider_ids: { coinmarketcap: '29270' },
    }],
  })
  const cmc = await resolveAsset(withEntity, { query: USDC_BASE, chain: 'base', orgId: 'org-1', userId: 'mix-2', deps: spyDeps().deps })
  eq(cmc.identity?.kind, 'cmc')
  eq(cmc.status, 'resolved')
})

Deno.test('intel-asset-resolve maps identity_only to HTTP 200', async () => {
  // The Edge Function answers 400 for `invalid`, 429 for `rate_limited` and 200
  // for everything else. This pins that identity_only is not special-cased into
  // a failure code — a searchable asset must not reach the client as an error.
  const source = await Deno.readTextFile(new URL('../../intel-asset-resolve/index.ts', import.meta.url))
  eq(source.includes("result.status === 'invalid' ? 400 : result.status === 'rate_limited' ? 429 : 200"), true)
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
