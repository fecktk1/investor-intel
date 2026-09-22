import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  captureRwaDepth, depthReading, depthState, deploymentDigest, deploymentRows, depthSubjects,
  poolRows, readableDeployment, reviewedCryptoIds, subjectsFromWrapperCapture, assertedTokenContracts,
  DEPTH_TABLE, DEPLOYMENT_TABLE, DEPTH_CREDIT_CEILING, POOL_CALLS_PER_RUN, HOLDER_CALLS_PER_RUN,
  TOKENS_PER_RUN, POOL_PAGE_SIZE, RWA_DEPTH_CAPTURE_OPS, RWA_DEPTH_CAPTURE_SCHEDULE,
  WRAPPER_ASSET_TABLE, WRAPPER_TOKEN_TABLE,
} from './capture-rwa-depth.ts'

const NOW = new Date(Math.floor((Date.now() - 7 * 86_400_000) / 3_600_000) * 3_600_000)
const DAY = NOW.toISOString().slice(0, 10)
const EVM = '0x' + 'A'.repeat(40)
const EVM2 = '0x' + 'B'.repeat(40)
const SOL = 'So11111111111111111111111111111111111111112'

/** Minimal PostgREST-shaped fake, copied from capture-listings.test.ts: eq/in
 * filters, order, limit and upsert. Every chain in the lane ends in one of them. */
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

/** The WRAPPER CAPTURE, in the shape the two tables actually hold. Verified
 * against production on 2026-09-20: `intel_rwa_wrapper_tokens` held 311 rows and
 * `intel_rwa_wrapper_assets` the 50 assets they wrap, all at one `captured_at`.
 *
 * This is where the depth lane's subjects come from, because
 * `/v5/real-world-assets/assets/list` has no `tokens` key at all. */
const WRAPPER_AT = new Date(Math.floor((NOW.getTime() - 3_600_000) / 3_600_000) * 3_600_000).toISOString()
const wrapperAsset = (rwaId: number, name: string, value: number, assetType = 'commodity') =>
  ({ provider: 'coinmarketcap', captured_at: WRAPPER_AT, rwa_id: String(rwaId), name, asset_type: assetType, tokenized_market_cap: value })
const wrapperToken = (rwaId: number, cryptoId: number, symbol: string, marketCap: number, issuer = 'Issuer') =>
  ({
    provider: 'coinmarketcap', captured_at: WRAPPER_AT, rwa_id: String(rwaId), crypto_id: String(cryptoId),
    symbol, name: `${symbol} token`, issuer_name: issuer, market_cap: marketCap, volume_24h: 1_000,
  })
/** The two wrapper tables as one seed, so every lane test starts from a capture. */
const wrapperSeed = (assets: Record<string, unknown>[], tokens: Record<string, unknown>[]) =>
  ({ [WRAPPER_ASSET_TABLE]: assets, [WRAPPER_TOKEN_TABLE]: tokens })
/** A pool row in the reviewed `/v1/dex/token/pools` field names. */
const poolRow = (addr: string, liq: number | null, v24: number | null, exn = 'Uniswap V3') =>
  ({ addr, exn, liqUsd: liq, v24, t0: { addr: EVM, sym: 'XAUT' }, t1: { addr: EVM2, sym: 'USDC' }, pubAt: 1_700_000_000 })

// ── Pure functions ────────────────────────────────────────────────────────────

Deno.test('a verified DEX chain is readable and its address is canonical; everything else is coverage, not an error', () => {
  eq(readableDeployment('ethereum', 'Ethereum', 'ethereum', EVM), { platform: 'ethereum', address: EVM.toLowerCase() })
  eq(readableDeployment('arbitrum-one', 'Arbitrum One', null, EVM), { platform: 'arbitrum', address: EVM.toLowerCase() })
  eq(readableDeployment('solana', 'Solana', 'solana', SOL), { platform: 'solana', address: SOL })
  // A Solana mint is base58 and case significant: it is NOT lower-cased.
  assert(readableDeployment('solana', 'Solana', 'solana', SOL)!.address === SOL)
  // Real chains this plan publishes no DEX data for. Null is coverage.
  eq(readableDeployment('xdc-network', 'XDC Network', null, EVM), null)
  eq(readableDeployment('bnb', 'BNB Smart Chain (BEP20)', 'bnb', EVM), null)
  eq(readableDeployment('sui', 'Sui Network', 'sui', '0x9d29::xaum::XAUM'), null)
  // arbitrum-nova is a DIFFERENT chain and must never fold onto arbitrum.
  eq(readableDeployment('arbitrum-nova', 'Arbitrum Nova', null, EVM), null)
  // A verified chain with an address of the wrong shape is not an identity.
  eq(readableDeployment('ethereum', 'Ethereum', 'ethereum', SOL), null)
  eq(readableDeployment('solana', 'Solana', 'solana', EVM), null)
})

Deno.test('deployments are read through cmcDeployments and keep the verbatim address beside the canonical one', () => {
  // The PRODUCTION shape of market_assets.facts.deployments, taken from XAUM
  // (CoinMarketCap 34212) on 2026-09-20. The daily metadata pass stores the
  // PARSED array, not the provider's raw contract_address[].
  const rows = deploymentRows('cmc:34212', {
    deployments: [
      { platformSlug: 'ethereum', platformName: 'Ethereum', chain: 'ethereum', address: '0x2103E845C5E135493Bb6c2A4f0B8651956eA8682' },
      { platformSlug: 'bnb', platformName: 'BNB Smart Chain (BEP20)', chain: 'bnb', address: '0x23AE4fd8E7844cdBc97775496eBd0E8248656028' },
      { platformSlug: 'sui', platformName: 'Sui Network', chain: 'sui', address: '0x9d297676e7a4b771ab023291377b2adfaa4938fb::xaum::XAUM' },
    ],
  }, 'catalogue_facts')
  eq(rows.length, 3)
  const ethereum = rows.find((r) => r.platformKey === 'ethereum')!
  // Verbatim, mixed case, beside the lower-cased canonical form.
  eq(ethereum.contractAddress, '0x2103E845C5E135493Bb6c2A4f0B8651956eA8682')
  eq(ethereum.dexAddress, '0x2103e845c5e135493bb6c2a4f0b8651956ea8682')
  eq(ethereum.dexPlatform, 'ethereum')
  // An unreadable chain keeps its address and its label and claims no platform.
  const sui = rows.find((r) => r.platformKey === 'sui')!
  eq(sui.dexPlatform, null)
  eq(sui.dexAddress, null)
  eq(sui.platformLabel, 'Sui Network')
  eq(sui.contractAddress, '0x9d297676e7a4b771ab023291377b2adfaa4938fb::xaum::XAUM')
})

Deno.test('subjects come from the wrapper capture, and a token with no crypto_id is not one', () => {
  const subjects = subjectsFromWrapperCapture([
    wrapperToken(1, 4705, 'PAXG', 1_894_589_902, 'Paxos'),
    { ...wrapperToken(1, 0, 'NOID', 1), crypto_id: null },
    // The same token twice in one capture is one subject, not two.
    wrapperToken(1, 4705, 'PAXG', 1_894_589_902, 'Paxos'),
  ], [wrapperAsset(1, 'Gold', 4_700_000_000)])
  eq(subjects.length, 1)
  eq(subjects[0].tokenKey, 'cmc:4705')
  eq(subjects[0].rwaName, 'Gold')
  eq(subjects[0].assetType, 'commodity')
  eq(subjects[0].issuerName, 'Paxos')
  // TWO sizes, kept apart: the asset's whole tokenised float and this token's cap.
  eq(subjects[0].underlyingValueUsd, 4_700_000_000)
  eq(subjects[0].tokenMarketCap, 1_894_589_902)
  // A token whose asset row is missing from the capture is still a subject: it is
  // a wrapper somebody holds, and the asset fields are honestly null.
  const orphan = subjectsFromWrapperCapture([wrapperToken(99, 5176, 'XAUt', 1)], [])
  eq(orphan.length, 1)
  eq(orphan[0].rwaName, null)
  eq(orphan[0].underlyingValueUsd, null)
  // The list figure answers when the quotes figure is absent.
  const listOnly = subjectsFromWrapperCapture([wrapperToken(1, 4705, 'PAXG', 1)],
    [{ ...wrapperAsset(1, 'Gold', 0), tokenized_market_cap: null, list_tokenized_market_cap: 12_345 }])
  eq(listOnly[0].underlyingValueUsd, 12_345)
})

Deno.test('pinned subjects come first and a reviewed token is promoted rather than duplicated', () => {
  const reviewed = reviewedCryptoIds()
  assert(reviewed.includes('4705'), 'the issuer reviews name PAX Gold')
  const discovered = [
    ...subjectsFromWrapperCapture([wrapperToken(9, 99999, 'SPCX', 9e9)], [wrapperAsset(9, 'SpaceX', 9e9, 'stock')]),
    ...subjectsFromWrapperCapture([wrapperToken(1, 4705, 'PAXG', 1e6)], [wrapperAsset(1, 'Gold', 1e6)]),
  ]
  const pinned = [{
    tokenKey: 'contract:eip155:1:' + EVM.toLowerCase(), cryptoId: null, symbol: 'BUIDL', tokenName: null,
    rwaId: null, rwaName: null, assetType: null, issuerName: null, underlyingValueUsd: null, pinned: true,
    pinnedChain: 'eip155:1', pinnedAddress: EVM.toLowerCase(),
  }]
  const subjects = depthSubjects(discovered, pinned)
  eq(subjects.length, 3, 'the reviewed token is promoted in place, never added twice')
  // THE TOKEN'S OWN market cap is the rank, not the asset's tokenised float: a
  // thin wrapper of a large asset is the finding, and the token is what is held.
  const ranked = depthSubjects([
    { ...discovered[0], tokenMarketCap: 10, underlyingValueUsd: 9e9 },
    { ...discovered[1], pinned: false, tokenMarketCap: 5_000, underlyingValueUsd: 1 },
  ], [])
  eq(ranked.map((row) => row.tokenKey), ['cmc:4705', 'cmc:99999'])
  // PAXG wraps the SMALLER asset here, and is still ahead of SpaceX because the
  // issuer reviews name it. Order is the budget.
  eq(subjects.map((s) => s.tokenKey).slice(0, 2).includes('cmc:4705'), true)
  eq(subjects.at(-1)!.tokenKey, 'cmc:99999')
  eq(subjects.filter((s) => s.pinned).length, 2)
  eq(depthSubjects(discovered, pinned, 1).length, 1)
})

Deno.test('the alias map contributes only contracts on a chain the platform can validate', () => {
  const contracts = assertedTokenContracts(Date.now())
  assert(contracts.length > 0, 'the dated alias map asserts at least one token contract')
  for (const contract of contracts) {
    assert(/^(eip155:[1-9][0-9]*|solana)$/.test(contract.chain), contract.chain)
    assert(contract.label.length > 0)
  }
})

Deno.test('pool rows are read in the reviewed field names; a pool with no liquidity still exists', () => {
  const pools = poolRows({ data: [poolRow(EVM2, 250_000, 10_000), poolRow('0x' + 'c'.repeat(40), null, null), { exn: 'x' }] }, 'ethereum')
  eq(pools.length, 2, 'a row with no pool address is not a pool')
  eq(pools[0], {
    chain: 'ethereum', dex: 'Uniswap V3', pair: 'XAUT / USDC', address: EVM2, liquidityUsd: 250_000, volume24h: 10_000,
    // The legs are stored with their ADDRESSES since 2026-09-20. Without them the
    // board cannot tell a USDC pool from a pool against a token that merely calls
    // itself USDC, which is the defect the first production run exposed.
    t0: { addr: EVM, sym: 'XAUT', liqUsd: null }, t1: { addr: EVM2, sym: 'USDC', liqUsd: null },
  })
  eq(pools[1].liquidityUsd, null)
  // The page is bounded by the size the request asked for.
  eq(poolRows({ data: Array.from({ length: 40 }, (_, i) => poolRow('0x' + String(i).padStart(40, 'd'), 1, 1)) }, 'ethereum').length, POOL_PAGE_SIZE)
  // A leg with no symbol leaves the pair unnamed rather than inventing a side.
  eq(poolRows({ data: [{ ...poolRow(EVM2, 1, 1), t1: { addr: EVM2 } }] }, 'ethereum')[0].pair, null)
  // EVERY legal "no pool" shape reads as zero pools, not as a broken answer. The
  // provider refused three of these for a credit each on 2026-09-20.
  for (const empty of [{ data: null }, { data: [] }, { data: {} }, { data: { pools: [] } }, { status: { error_code: 0 } }]) {
    eq(poolRows(empty, 'ethereum').length, 0, JSON.stringify(empty))
  }
  // A documented container that DOES carry rows is read through the same helper
  // the transport's validator uses, so the two can never disagree.
  eq(poolRows({ data: { pools: [poolRow(EVM2, 7, 1)] } }, 'ethereum')[0].liquidityUsd, 7)
})

Deno.test('the depth reading sums only reported liquidity and says how many pools it was built from', () => {
  const reading = depthReading([
    { chain: 'ethereum', dex: 'a', pair: null, address: '0x1', liquidityUsd: 100, volume24h: 5 },
    { chain: 'ethereum', dex: 'b', pair: null, address: '0x2', liquidityUsd: null, volume24h: null },
    { chain: 'base', dex: 'c', pair: null, address: '0x3', liquidityUsd: 900, volume24h: null },
  ])
  eq(reading.poolCount, 3)
  eq(reading.liquidityPools, 2, 'a pool with no reported liquidity is counted but adds nothing')
  eq(reading.totalLiquidityUsd, 1000)
  eq(reading.totalVolume24h, 5)
  eq(reading.deepest?.address, '0x3')
  // Nothing reported is null, never zero.
  const none = depthReading([{ chain: 'ethereum', dex: null, pair: null, address: '0x1', liquidityUsd: null, volume24h: null }])
  eq(none.totalLiquidityUsd, null)
  eq(none.deepest, null)
  // A real zero is a real answer and is the deepest pool when it is the only one.
  const zero = depthReading([{ chain: 'ethereum', dex: null, pair: null, address: '0x1', liquidityUsd: 0, volume24h: 0 }])
  eq(zero.totalLiquidityUsd, 0)
  eq(zero.deepest?.liquidityUsd, 0)
})

Deno.test('every honest state is reachable and none of them is ever confused with another', () => {
  const base = { pools: 0, readChains: 0, deployments: 0, attempted: 0, failed: 0, restricted: false }
  eq(depthState({ ...base, pools: 2, readChains: 1, deployments: 1, attempted: 1 }), 'pools_read')
  eq(depthState(base), 'no_deployment_known')
  eq(depthState({ ...base, deployments: 3 }), 'chain_not_covered')
  eq(depthState({ ...base, deployments: 1, readChains: 1 }), 'budget_deferred')
  eq(depthState({ ...base, deployments: 1, readChains: 1, attempted: 2, failed: 2 }), 'provider_unavailable')
  eq(depthState({ ...base, deployments: 1, readChains: 1, attempted: 1, restricted: true }), 'issuer_redemption_only')
  eq(depthState({ ...base, deployments: 1, readChains: 1, attempted: 1 }), 'no_pool_on_read_chains')
  // Permissioned transfers never turn a chain we could not read into a claim.
  eq(depthState({ ...base, deployments: 1, restricted: true }), 'chain_not_covered')
})

Deno.test('the deployment digest is order independent and case insensitive on the address', () => {
  // The SAME two deployments from the two sources: the stored catalogue array and
  // the provider's raw info row. A digest that differed between them would make
  // every token look changed the first time it fell back to a metadata call.
  const a = deploymentRows('cmc:1', { deployments: [
    { platformSlug: 'ethereum', platformName: 'Ethereum', chain: 'ethereum', address: EVM },
    { platformSlug: 'base', platformName: 'Base', chain: 'base', address: EVM2 },
  ] }, 'catalogue_facts')
  const b = deploymentRows('cmc:1', { contract_address: [
    { contract_address: EVM2.toLowerCase(), platform: { name: 'Base', coin: { slug: 'base' } } },
    { contract_address: EVM.toLowerCase(), platform: { name: 'Ethereum', coin: { slug: 'ethereum' } } },
  ] }, 'provider_info')
  eq(deploymentDigest(a), deploymentDigest(b))
  assert(deploymentDigest(a) !== deploymentDigest(a.slice(0, 1)))
})

// ── The lane ──────────────────────────────────────────────────────────────────
Deno.test('below Startup the lane spends nothing to discover it cannot run', async () => {
  const { request, calls } = fakeRequest(() => null)
  const result = await captureRwaDepth(fakeDb(), ctxFor, NOW, 'builder', { request })
  eq(result.skipped, 'plan_below_startup')
  eq(result.credits, 0)
  eq(calls.length, 0)
})

Deno.test('a disabled policy row stops the lane, and a run inside the cadence skips it', async () => {
  const { request, calls } = fakeRequest(() => null)
  eq((await captureRwaDepth(fakeDb(), ctxFor, NOW, 'startup', { request, policy: [{ feature: 'rwa_depth', enabled: false }] })).skipped, 'policy_disabled')
  const fresh = fakeDb({ [DEPTH_TABLE]: [{ captured_at: new Date(NOW.getTime() - 60_000).toISOString() }] })
  eq((await captureRwaDepth(fresh, ctxFor, NOW, 'startup', { request })).skipped, 'within_cadence')
  eq(calls.length, 0, 'neither skip costs a provider call')
})

Deno.test('one full run discovers subjects from our own store, reads pools and explains every state', async () => {
  const writes: Record<string, unknown[]> = {}
  const db = fakeDb({
    ...wrapperSeed(
      [wrapperAsset(1, 'Gold', 4_700_000_000), wrapperAsset(3, 'US Treasury', 1_000_000_000, 'government_security')],
      [
        wrapperToken(1, 4705, 'PAXG', 1_894_589_902, 'Paxos'),
        wrapperToken(1, 20245, 'CGO', 5_000_000, 'Comtech Gold'),
        wrapperToken(3, 30001, 'FUND', 900_000_000, 'A Sponsor'),
      ],
    ),
    market_assets: [
      // PAXG: one readable Ethereum deployment with pools.
      { source_provider: 'coinmarketcap', provider_id: '4705', symbol: 'PAXG', name: 'PAX Gold', market_cap: 2_000_000_000,
        facts: { deployments: [{ platformSlug: 'ethereum', platformName: 'Ethereum', chain: 'ethereum', address: EVM }] } },
      // CGO: XDC only. A real chain this plan publishes no DEX pools for.
      { source_provider: 'coinmarketcap', provider_id: '20245', symbol: 'CGO', name: 'Comtech Gold', market_cap: 5_000_000,
        facts: { deployments: [{ platformSlug: 'xdc-network', platformName: 'XDC Network', chain: null, address: EVM2 }] } },
      // A permissioned fund: readable chain, no pool, and a restriction row.
      { source_provider: 'coinmarketcap', provider_id: '30001', symbol: 'FUND', name: 'A Permissioned Fund', market_cap: 900_000_000,
        facts: { deployments: [{ platformSlug: 'ethereum', platformName: 'Ethereum', chain: 'ethereum', address: '0x' + 'e'.repeat(40) }] } },
    ],
    intel_rwa_token_restrictions: [
      { chain: 'ethereum', contract_address: '0x' + 'e'.repeat(40), state: 'restricted', kyc_gated: true, source_url: 'https://etherscan.io/address/x' },
    ],
  }, writes)

  const { request, calls } = fakeRequest((name, params) => {
    if (name === 'dexPools') {
      if (params.address === EVM.toLowerCase()) {
        return { payload: { data: [poolRow(EVM2, 900_000, 40_000), poolRow('0x' + 'f'.repeat(40), 100_000, 2_000, 'Curve')] } }
      }
      // A permissioned fund with no public pool. This is the production shape
      // that used to be refused as malformed for a credit.
      return { payload: { status: { error_code: 0 }, data: null } }
    }
    if (name === 'dexHolderCount') return { payload: { data: { count: 4321, platformId: 1, tokenAddress: params.tokenAddress } } }
    if (name === 'metadata') return { payload: { data: {} } }
    return null
  })

  const result = await captureRwaDepth(db, ctxFor, NOW, 'startup', { request })
  eq(result.error, undefined)
  eq(result.snapshotDate, DAY)
  // NOT ONE universe call. `/v5/real-world-assets/assets/list` has no tokens[],
  // and it was billed live rather than answered from cache, so the lane reads
  // its subjects out of the wrapper capture instead.
  eq(calls.filter((c) => c.name === 'rwaList').length, 0)
  eq(calls.filter((c) => c.name === 'dexPools').length, 2, 'PAXG and FUND; CGO has no readable chain')
  eq(calls.filter((c) => c.name === 'dexHolderCount').length, 1)
  eq(calls.filter((c) => c.name === 'metadata').length, 0, 'the catalogue already held every deployment')
  eq(result.credits, 3)
  eq(result.subjects, 3)
  // The shape of the empty answer is recorded, because only a real run can tell
  // us which of the legal empty shapes the provider sends.
  eq((result.poolShapes as Record<string, number>)['empty:null'], 1)
  eq((result.poolShapes as Record<string, number>).pools, 1)
  eq(result.emptyPoolReads, 1)
  eq(result.withPools, 1, 'a zero-pool read is not a token with pools')

  const depth = (writes[DEPTH_TABLE] || []) as Record<string, unknown>[]
  const byKey = new Map(depth.map((row) => [String(row.token_key), row]))
  const paxg = byKey.get('cmc:4705')!
  eq(paxg.depth_state, 'pools_read')
  eq(paxg.pool_count, 2)
  eq(paxg.liquidity_pools, 2)
  eq(paxg.total_liquidity_usd, 1_000_000)
  eq(paxg.deepest_liquidity_usd, 900_000)
  eq(paxg.deepest_pool_dex, 'Uniswap V3')
  eq(paxg.deepest_pool_pair, 'XAUT / USDC')
  eq(paxg.deepest_pool_chain, 'ethereum')
  eq(paxg.holder_count, 4321)
  eq(paxg.chains_read, ['ethereum'])
  eq(paxg.token_market_cap, 2_000_000_000)
  eq(paxg.underlying_value_usd, 4_700_000_000)
  eq(paxg.issuer_name, 'Paxos')
  eq(paxg.asset_type, 'commodity')
  // NO derived ratio is stored: concentration and exitability are the read
  // module's, so a formula change cannot leave a stale number behind.
  assert(!('concentration_pct' in paxg))
  assert(!('exitability' in paxg))

  const cgo = byKey.get('cmc:20245')!
  eq(cgo.depth_state, 'chain_not_covered')
  eq(cgo.chains_not_covered, ['XDC Network'])
  eq(cgo.pool_count, null, 'no call was made, so the pool count is unknown and not zero')
  eq(cgo.total_liquidity_usd, null)

  const fund = byKey.get('cmc:30001')!
  eq(fund.depth_state, 'issuer_redemption_only')
  eq(fund.restriction_state, 'restricted')
  eq(fund.restriction_kyc_gated, true)
  eq(fund.pool_count, 0, 'a call was made and the provider reported no pool')
  assert(String(fund.scope).length > 60)

  // Deployments are written for every chain, readable or not.
  const deployments = (writes[DEPLOYMENT_TABLE] || []) as Record<string, unknown>[]
  eq(deployments.filter((row) => row.readable === true).length, 2)
  eq(deployments.filter((row) => row.readable === false).length, 1)
  eq(deployments.find((row) => row.platform_key === 'xdc-network')!.dex_platform, null)
})

Deno.test('a read that finds no pool anywhere reaches the finding rather than provider_unavailable', async () => {
  // The production run of 2026-09-20: three permissioned funds, three refusals,
  // three credits and not one usable row. Now the same answer is a finding.
  const writes: Record<string, unknown[]> = {}
  const db = fakeDb({
    ...wrapperSeed([wrapperAsset(3, 'US Treasury', 1e9, 'government_security')], [wrapperToken(3, 30001, 'FUND', 9e8)]),
    market_assets: [{ source_provider: 'coinmarketcap', provider_id: '30001', symbol: 'FUND', name: 'A Fund', market_cap: 1,
      facts: { deployments: [{ platformSlug: 'ethereum', platformName: 'Ethereum', chain: 'ethereum', address: EVM }] } }],
  }, writes)
  const { request } = fakeRequest((name) => (name === 'dexPools' ? { payload: { data: { pools: [] } } } : null))
  const result = await captureRwaDepth(db, ctxFor, NOW, 'startup', { request })
  const row = ((writes[DEPTH_TABLE] || []) as Record<string, unknown>[])[0]
  // No restriction row is stored for this contract, so the state is the plain
  // liquidity finding and it names the chain it read.
  eq(row.depth_state, 'no_pool_on_read_chains')
  eq(row.chains_read, ['ethereum'])
  eq(row.pool_count, 0)
  eq(result.partial, 'no_pools_on_any_read_chain')
  eq((result.poolShapes as Record<string, number>)['empty:{pools:array[0]}'], 1)
})

Deno.test('an empty wrapper capture is a stated reason, never an unexplained empty run', async () => {
  const writes: Record<string, unknown[]> = {}
  const db = fakeDb({ market_assets: [] }, writes)
  const { request, calls } = fakeRequest(() => null)
  const result = await captureRwaDepth(db, ctxFor, NOW, 'startup', { request })
  eq(result.partial, 'no_wrapper_capture_yet')
  eq(result.skipped, 'no_rwa_tokens')
  eq(result.credits, 0)
  eq(calls.length, 0, 'an empty store costs nothing to discover')
  eq((writes[DEPTH_TABLE] || []).length, 0)
})

Deno.test('the alias map subjects are still read when the wrapper lane has not run', async () => {
  // Run at the real clock, because an assertion is dated and is not yet current
  // at the frozen NOW the other lane tests use.
  const at = new Date()
  assert(assertedTokenContracts(at.getTime()).length > 0, 'the dated alias map asserts contracts today')
  const writes: Record<string, unknown[]> = {}
  const db = fakeDb({ market_assets: [] }, writes)
  const { request, calls } = fakeRequest((name) => (name === 'dexPools' ? { payload: { data: [poolRow(EVM2, 3, 1)] } } : null))
  const result = await captureRwaDepth(db, ctxFor, at, 'startup', { request })
  // An unrun wrapper lane does not empty this board: the pinned contracts the
  // alias map asserts are subjects in their own right and are read.
  eq(result.partial, 'no_wrapper_capture_yet')
  assert((result.subjects as number) > 0, 'the alias map contributes subjects of its own')
  assert(calls.filter((c) => c.name === 'dexPools').length > 0)
  assert((writes[DEPTH_TABLE] || []).length > 0)
})

Deno.test('a token with no stored deployments costs exactly one metadata call for the whole set', async () => {
  const writes: Record<string, unknown[]> = {}
  const db = fakeDb({
    ...wrapperSeed([wrapperAsset(9, 'SpaceX', 2e8, 'stock')], [wrapperToken(9, 11, 'AAA', 20), wrapperToken(9, 12, 'BBB', 10)]),
    market_assets: [],
  }, writes)
  const { request, calls } = fakeRequest((name) => {
    if (name === 'metadata') {
      return { payload: { data: {
        11: { id: 11, contract_address: [{ contract_address: EVM, platform: { name: 'Base', coin: { slug: 'base' } } }] },
        12: { id: 12, contract_address: [] },
      } } }
    }
    if (name === 'dexPools') return { payload: { data: [poolRow(EVM2, 12_345, 1_000)] } }
    if (name === 'dexHolderCount') return { payload: { data: { count: 0 } } }
    return null
  })
  const result = await captureRwaDepth(db, ctxFor, NOW, 'startup', { request })
  eq(calls.filter((c) => c.name === 'metadata').length, 1)
  eq(calls.find((c) => c.name === 'metadata')!.params, { id: '11,12' })
  const depth = (writes[DEPTH_TABLE] || []) as Record<string, unknown>[]
  eq(depth.find((row) => row.token_key === 'cmc:11')!.depth_state, 'pools_read')
  eq(depth.find((row) => row.token_key === 'cmc:12')!.depth_state, 'no_deployment_known')
  // A holder count of zero is a real answer and is stored as zero.
  eq(depth.find((row) => row.token_key === 'cmc:11')!.holder_count, 0)
  // The token cap comes off the wrapper capture when our own catalogue has no row.
  eq(depth.find((row) => row.token_key === 'cmc:11')!.token_market_cap, 20)
  eq(result.error, undefined)
})

Deno.test('the per-run ceiling is enforced, and a token it does not reach is pending rather than thin', async () => {
  const writes: Record<string, unknown[]> = {}
  // 80 tokens, each with one readable Ethereum deployment.
  const many = Array.from({ length: 80 }, (_, i) => ({
    source_provider: 'coinmarketcap', provider_id: String(1000 + i), symbol: `T${i}`, name: `Token ${i}`, market_cap: 1000,
    facts: { deployments: [{ platformSlug: 'ethereum', platformName: 'Ethereum', chain: 'ethereum', address: '0x' + String(i).padStart(40, '1') }] },
  }))
  const db = fakeDb({
    ...wrapperSeed(
      many.map((_, i) => wrapperAsset(100 + i, `Asset ${i}`, 1e9 - i, 'stock')),
      many.map((row, i) => wrapperToken(100 + i, Number(row.provider_id), String(row.symbol), 1e9 - i)),
    ),
    market_assets: many,
  }, writes)
  const { request, calls } = fakeRequest((name) => {
    if (name === 'dexPools') return { payload: { data: [poolRow(EVM2, 5_000, 100)] } }
    if (name === 'dexHolderCount') return { payload: { data: { count: 7 } } }
    return null
  })
  const result = await captureRwaDepth(db, ctxFor, NOW, 'startup', { request })
  eq(result.subjects, TOKENS_PER_RUN, 'the subject set is bounded')
  eq(calls.filter((c) => c.name === 'dexPools').length, Math.min(TOKENS_PER_RUN, POOL_CALLS_PER_RUN))
  eq(calls.filter((c) => c.name === 'dexHolderCount').length, HOLDER_CALLS_PER_RUN)
  assert((result.credits as number) <= DEPTH_CREDIT_CEILING)
  const depth = (writes[DEPTH_TABLE] || []) as Record<string, unknown>[]
  eq(depth.length, TOKENS_PER_RUN)
  // Every subject got a row, and nothing the budget reached is mislabelled.
  assert(depth.every((row) => ['pools_read', 'budget_deferred'].includes(String(row.depth_state))))
})

Deno.test('a token already read today with an unchanged deployment set is not paid for twice', async () => {
  const writes: Record<string, unknown[]> = {}
  const facts = { deployments: [{ platformSlug: 'ethereum', platformName: 'Ethereum', chain: 'ethereum', address: EVM }] }
  const digest = deploymentDigest(deploymentRows('cmc:4705', facts, 'catalogue_facts'))
  const db = fakeDb({
    ...wrapperSeed([wrapperAsset(1, 'Gold', 1e9)], [wrapperToken(1, 4705, 'PAXG', 1e9)]),
    market_assets: [{ source_provider: 'coinmarketcap', provider_id: '4705', symbol: 'PAXG', name: 'PAX Gold', market_cap: 1, facts }],
    // A row from EARLIER today for the same deployment set. `captured_at` is
    // outside the cadence so the guard does not skip the whole run.
    [DEPTH_TABLE]: [{ provider: 'coinmarketcap', token_key: 'cmc:4705', snapshot_date: DAY, depth_state: 'pools_read', deployment_digest: digest, captured_at: new Date(NOW.getTime() - 2 * 86_400_000).toISOString() }],
  }, writes)
  const { request, calls } = fakeRequest((name) => (name === 'dexPools' ? { payload: { data: [poolRow(EVM2, 1, 1)] } } : null))
  const result = await captureRwaDepth(db, ctxFor, NOW, 'startup', { request })
  eq(result.skippedToday, 1)
  eq(calls.filter((c) => c.name === 'dexPools').length, 0)
  eq((writes[DEPTH_TABLE] || []).length, 0, 'the existing row is left alone')
})

Deno.test('a snapshot that established nothing does not count as read, so a later run today retries it', async () => {
  // PRODUCTION, 2026-09-20: three tokens were stored `provider_unavailable`
  // because a no-pool answer was being refused. Treating that as "already read"
  // would have frozen the unknown for the rest of the UTC day.
  const facts = { deployments: [{ platformSlug: 'ethereum', platformName: 'Ethereum', chain: 'ethereum', address: EVM }] }
  const digest = deploymentDigest(deploymentRows('cmc:4705', facts, 'catalogue_facts'))
  const stale = new Date(NOW.getTime() - 2 * 86_400_000).toISOString()
  for (const state of ['provider_unavailable', 'budget_deferred']) {
    const writes: Record<string, unknown[]> = {}
    const db = fakeDb({
      ...wrapperSeed([wrapperAsset(1, 'Gold', 1e9)], [wrapperToken(1, 4705, 'PAXG', 1e9)]),
      market_assets: [{ source_provider: 'coinmarketcap', provider_id: '4705', symbol: 'PAXG', name: 'PAX Gold', market_cap: 1, facts }],
      [DEPTH_TABLE]: [{ provider: 'coinmarketcap', token_key: 'cmc:4705', snapshot_date: DAY, depth_state: state, deployment_digest: digest, captured_at: stale }],
    }, writes)
    const { request, calls } = fakeRequest((name) => (name === 'dexPools' ? { payload: { data: [poolRow(EVM2, 1, 1)] } } : null))
    const result = await captureRwaDepth(db, ctxFor, NOW, 'startup', { request })
    eq(result.skippedToday, 0, state)
    eq(calls.filter((c) => c.name === 'dexPools').length, 1, state)
    eq(((writes[DEPTH_TABLE] || [])[0] as Record<string, unknown>).depth_state, 'pools_read', state)
  }
})

Deno.test('a failed pool read leaves the depth unknown rather than reporting it as thin', async () => {
  const writes: Record<string, unknown[]> = {}
  const db = fakeDb({
    ...wrapperSeed([wrapperAsset(1, 'Gold', 1e9)], [wrapperToken(1, 4705, 'PAXG', 1e9)]),
    market_assets: [{ source_provider: 'coinmarketcap', provider_id: '4705', symbol: 'PAXG', name: 'PAX Gold', market_cap: 1,
      facts: { deployments: [{ platformSlug: 'ethereum', platformName: 'Ethereum', chain: 'ethereum', address: EVM }] } }],
  }, writes)
  const { request } = fakeRequest((name) => (name === 'dexPools' ? { payload: null, reason: 'rate_limited' } : null))
  const result = await captureRwaDepth(db, ctxFor, NOW, 'startup', { request })
  eq(result.partial, 'rate_limited')
  eq((result.poolShapes as Record<string, number>)['refused:rate_limited'], 1)
  const row = ((writes[DEPTH_TABLE] || []) as Record<string, unknown>[]).find((r) => r.token_key === 'cmc:4705')!
  eq(row.depth_state, 'provider_unavailable')
  eq(row.total_liquidity_usd, null)
})

Deno.test('the op surface is registered and the schedule constant matches the migration', async () => {
  eq(Object.keys(RWA_DEPTH_CAPTURE_OPS), ['rwa_depth'])
  const migration = await Deno.readTextFile(new URL('../../../migrations/20260920151000_intel_rwa_depth.sql', import.meta.url))
  const schedule = RWA_DEPTH_CAPTURE_SCHEDULE.rwa_depth
  assert(migration.includes(`cron.schedule('${schedule.job}', '${schedule.cron}'`), 'the migration schedules the job this module names')
  assert(migration.includes(`'op','${'rwa_depth'}'`), 'the cron body posts this lane\'s op')
  // The credit ceiling the policy row states is the one the constants add up to,
  // and it no longer carries the six rwaList calls this lane does not make.
  eq(DEPTH_CREDIT_CEILING, 1 + POOL_CALLS_PER_RUN + HOLDER_CALLS_PER_RUN)
  assert(migration.includes(`'rwa_depth', 86400, true, 'startup', ${DEPTH_CREDIT_CEILING}`), 'the policy row states the lane\'s own ceiling')
  assert(!/rwaList per asset type/.test(migration), 'the policy row no longer claims a universe call')
  // Both tables the lane writes are created by the migration it names.
  assert(migration.includes(`CREATE TABLE public.${DEPTH_TABLE}`))
  assert(migration.includes(`CREATE TABLE public.${DEPLOYMENT_TABLE}`))
})
