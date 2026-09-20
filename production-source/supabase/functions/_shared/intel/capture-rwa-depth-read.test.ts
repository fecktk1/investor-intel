import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  concentrationPct, contractList, exitabilitySizes, readRwaDepth, readRwaTokenDepth,
  DEPTH_ENDPOINTS, EXITABILITY_FRACTIONS, EXITABILITY_METHOD, READ_CHAINS, RWA_DEPTH_CAPTURE_VIEWS,
} from './capture-rwa-depth-read.ts'
import { DEPTH_TABLE, DEPLOYMENT_TABLE, DEPTH_SCOPE } from './capture-rwa-depth.ts'

const NOW = Date.now()
const DAY = new Date(NOW).toISOString().slice(0, 10)
const YESTERDAY = new Date(NOW - 86_400_000).toISOString().slice(0, 10)
const EVM = '0x' + 'a'.repeat(40)
const EVM2 = '0x' + 'b'.repeat(40)

// deno-lint-ignore no-explicit-any
function fakeDb(tables: Record<string, any[]> = {}, errors: Record<string, string> = {}) {
  const compare = (a: unknown, b: unknown) => String(a ?? '').localeCompare(String(b ?? ''))
  return {
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
      }
      return q
    },
  }
}

const depthRow = (over: Record<string, unknown> = {}) => ({
  provider: 'coinmarketcap', token_key: 'cmc:4705', snapshot_date: DAY,
  captured_at: new Date(NOW - 3_600_000).toISOString(),
  crypto_id: '4705', symbol: 'PAXG', token_name: 'PAX Gold',
  rwa_id: '1', rwa_name: 'Gold', asset_type: 'commodity', issuer_name: 'Paxos',
  underlying_value_usd: 4_700_000_000, token_market_cap: 2_000_000_000,
  depth_state: 'pools_read',
  chains_deployed: ['Ethereum'], chains_read: ['ethereum'], chains_not_covered: [],
  pool_count: 3, liquidity_pools: 2,
  total_liquidity_usd: 1_000_000, total_volume_24h_usd: 42_000,
  deepest_pool_address: EVM2, deepest_pool_dex: 'Uniswap V3', deepest_pool_chain: 'ethereum',
  deepest_pool_pair: 'PAXG / USDC', deepest_liquidity_usd: 900_000, deepest_volume_24h_usd: 40_000,
  holder_count: 4321, holder_chain: 'ethereum',
  restriction_state: null, restriction_kyc_gated: null, restriction_source_url: null,
  pools: [{ chain: 'ethereum', dex: 'Uniswap V3', pair: 'PAXG / USDC', address: EVM2, liquidityUsd: 900_000, volume24h: 40_000 }],
  scope: DEPTH_SCOPE,
  ...over,
})

const deployment = (over: Record<string, unknown> = {}) => ({
  provider: 'coinmarketcap', token_key: 'cmc:4705', platform_key: 'ethereum', platform_label: 'Ethereum',
  chain: 'ethereum', contract_address: EVM, dex_platform: 'ethereum', dex_address: EVM,
  readable: true, source: 'catalogue_facts', captured_at: new Date(NOW - 3_600_000).toISOString(),
  ...over,
})

// ── Our two derived readings ───────────────────────────────────────────────────

Deno.test('concentration is a share of what we found, and one pool is honestly 100 percent', () => {
  eq(concentrationPct(900_000, 1_000_000), 90)
  eq(concentrationPct(500, 500), 100)
  // Provider rounding cannot produce a share above 100.
  eq(concentrationPct(1_100, 1_000), 100)
  // Nothing to divide is null, never zero.
  eq(concentrationPct(null, 1_000), null)
  eq(concentrationPct(900, null), null)
  eq(concentrationPct(0, 0), null)
})

Deno.test('the exitability sizes are one and five percent of the deepest pool and nothing more', () => {
  eq(EXITABILITY_FRACTIONS, [1, 5])
  eq(exitabilitySizes(1_000_000), [{ pct: 1, usd: 10_000 }, { pct: 5, usd: 50_000 }])
  // A pool of zero, or one with no reported size, has no comparable size.
  eq(exitabilitySizes(0), null)
  eq(exitabilitySizes(null), null)
  // The method sentence refuses the slippage reading outright.
  assert(EXITABILITY_METHOD.includes('Our calculation'))
  assert(EXITABILITY_METHOD.includes('not a slippage estimate'))
})

// ── The board ──────────────────────────────────────────────────────────────────

Deno.test('an empty table is an empty board with a reason and the schedule, never an error', async () => {
  const result = await readRwaDepth(fakeDb(), {}, NOW)
  eq(result.rows, [])
  eq(result.asOf, null)
  eq((result.cohort as Record<string, unknown>).count, 0)
  eq((result.schedule as Record<string, Record<string, string>>).rwa_depth.utc, '03:34')
  eq(result.readChains, READ_CHAINS)
  assert(READ_CHAINS.includes('Ethereum') && READ_CHAINS.includes('Solana'))
  eq((result.attribution as Record<string, unknown>).label, 'CoinMarketCap')
  eq((result.attribution as Record<string, unknown>).endpoints, DEPTH_ENDPOINTS)
})

Deno.test('a failed read is a reason on an intact result, never a silently short list', async () => {
  const result = await readRwaDepth(fakeDb({}, { [DEPTH_TABLE]: 'permission denied' }), {}, NOW)
  eq(result.rows, [])
  eq(result.reason, 'permission denied')
})

Deno.test('the board carries the derived readings, the contracts and the cohort over the whole window', async () => {
  const db = fakeDb({
    [DEPTH_TABLE]: [
      depthRow(),
      // An older snapshot of the SAME token: only the newest is shown.
      depthRow({ snapshot_date: YESTERDAY, total_liquidity_usd: 1, deepest_liquidity_usd: 1 }),
      depthRow({ token_key: 'cmc:20245', crypto_id: '20245', symbol: 'CGO', rwa_name: 'Gold',
        depth_state: 'chain_not_covered', chains_deployed: ['XDC Network'], chains_read: [], chains_not_covered: ['XDC Network'],
        pool_count: null, liquidity_pools: null, total_liquidity_usd: null, total_volume_24h_usd: null,
        deepest_pool_address: null, deepest_liquidity_usd: null, deepest_pool_dex: null, deepest_pool_chain: null,
        deepest_pool_pair: null, deepest_volume_24h_usd: null, holder_count: null, holder_chain: null, pools: [] }),
      depthRow({ token_key: 'cmc:30001', crypto_id: '30001', symbol: 'FUND',
        depth_state: 'issuer_redemption_only', pool_count: 0, liquidity_pools: 0,
        total_liquidity_usd: null, deepest_pool_address: null, deepest_liquidity_usd: null,
        restriction_state: 'restricted', restriction_kyc_gated: true, restriction_source_url: 'https://etherscan.io/address/x',
        pools: [] }),
      depthRow({ token_key: 'cmc:40001', crypto_id: '40001', symbol: 'PEND', depth_state: 'budget_deferred',
        pool_count: null, total_liquidity_usd: null, deepest_pool_address: null, deepest_liquidity_usd: null, pools: [] }),
    ],
    [DEPLOYMENT_TABLE]: [
      deployment(),
      deployment({ token_key: 'cmc:20245', platform_key: 'xdc-network', platform_label: 'XDC Network', chain: null,
        contract_address: '0x8f9920283470F52128bF11B0c14E798bE704fD15', dex_platform: null, dex_address: null, readable: false }),
    ],
  })
  const result = await readRwaDepth(db, {}, NOW)
  const rows = result.rows as Record<string, unknown>[]
  eq(rows.length, 4, 'one row per token, from its newest snapshot')
  // Depth first, and the newest snapshot won over the older one.
  eq(rows[0].tokenKey, 'cmc:4705')
  eq(rows[0].totalLiquidityUsd, 1_000_000)
  eq(rows[0].concentrationPct, 90)
  eq(rows[0].exitability, [{ pct: 1, usd: 9_000 }, { pct: 5, usd: 45_000 }])
  eq(rows[0].liquidityPools, 2)
  eq((rows[0].deepestPool as Record<string, unknown>).pair, 'PAXG / USDC')
  eq(rows[0].contracts, [{ chain: 'Ethereum', chainKey: 'ethereum', address: EVM, readable: true, dexPlatform: 'ethereum' }])
  // A pending token sorts last and carries no liquidity claim.
  eq(rows.at(-1)!.tokenKey, 'cmc:40001')
  eq(rows.at(-1)!.totalLiquidityUsd, null)
  eq(rows.at(-1)!.concentrationPct, null)
  eq(rows.at(-1)!.exitability, null)
  // The unreadable chain keeps its contract and says so.
  const cgo = rows.find((row) => row.tokenKey === 'cmc:20245')!
  eq((cgo.contracts as Record<string, unknown>[])[0].readable, false)
  eq(cgo.chainsNotCovered, ['XDC Network'])
  // The permissioned fund carries the evidence that explains its missing pool.
  const fund = rows.find((row) => row.tokenKey === 'cmc:30001')!
  eq((fund.restriction as Record<string, unknown>).kycGated, true)
  eq((fund.restriction as Record<string, unknown>).sourceUrl, 'https://etherscan.io/address/x')

  const cohort = result.cohort as Record<string, number>
  eq(cohort.count, 4)
  eq(cohort.withPools, 1)
  eq(cohort.withoutPools, 0)
  eq(cohort.permissioned, 1)
  eq(cohort.notCovered, 1)
  eq(cohort.pending, 1)
  eq(cohort.totalLiquidityUsd, 1_000_000)
  assert(String(result.scope).length > 60)
  assert(result.asOf != null)
})

Deno.test('a contract list is bounded, readable chains first, and the overflow is counted not dropped', () => {
  const many = Array.from({ length: 15 }, (_, i) => deployment({
    platform_key: `chain-${String(i).padStart(2, '0')}`, platform_label: `Chain ${i}`,
    contract_address: '0x' + String(i).padStart(40, '9'), dex_platform: null, dex_address: null, readable: false,
  })).map((row) => ({
    tokenKey: row.token_key, platformKey: row.platform_key, platformLabel: row.platform_label,
    chain: row.chain, contractAddress: row.contract_address, dexPlatform: row.dex_platform,
    readable: row.readable, source: row.source, capturedAt: row.captured_at,
  }))
  const readable = { ...many[0], platformKey: 'ethereum', platformLabel: 'Ethereum', readable: true, dexPlatform: 'ethereum' }
  const listed = contractList([...many, readable])
  eq(listed.contracts.length, 12)
  eq(listed.contracts[0].chain, 'Ethereum', 'a readable chain is first, wherever it arrived')
  eq(listed.chainsOmitted, 4)
  eq(contractList([]).contracts, [])
  eq(contractList([]).chainsOmitted, 0)
  // The deployment table keys on the VERBATIM address, so a provider that
  // re-cases one leaves two rows for one contract. Printing both would tell a
  // reader they hold two different tokens: the newest row wins.
  const mixed = [
    { tokenKey: 'cmc:1', platformKey: 'ethereum', platformLabel: 'Ethereum', chain: 'ethereum', contractAddress: EVM.toUpperCase().replace('0X', '0x'), dexPlatform: 'ethereum', readable: true, source: 'provider_info', capturedAt: new Date(NOW).toISOString() },
    { tokenKey: 'cmc:1', platformKey: 'ethereum', platformLabel: 'Ethereum', chain: 'ethereum', contractAddress: EVM, dexPlatform: 'ethereum', readable: true, source: 'catalogue_facts', capturedAt: new Date(NOW - 86_400_000).toISOString() },
  ]
  eq(contractList(mixed).contracts.length, 1)
  eq(contractList(mixed).contracts[0].address, mixed[0].contractAddress)
})

// ── One token, for the asset page ──────────────────────────────────────────────

Deno.test('a token with no capture answers captured:false, which is the normal answer', async () => {
  const empty = await readRwaTokenDepth(fakeDb(), { cryptoId: '1' }, NOW)
  eq(empty.captured, false)
  eq(empty.token, null)
  eq(empty.reason, null)
  // No id at all is a named refusal, not a silent empty read.
  const none = await readRwaTokenDepth(fakeDb(), {}, NOW)
  eq(none.captured, false)
  eq(none.reason, 'no_token_selected')
  // A non-numeric id is never used as a filter.
  eq((await readRwaTokenDepth(fakeDb(), { cryptoId: '0; drop table' }, NOW)).reason, 'no_token_selected')
})

Deno.test('a captured token answers with its own newest row, its contracts and the method', async () => {
  const db = fakeDb({
    [DEPTH_TABLE]: [depthRow(), depthRow({ snapshot_date: YESTERDAY, total_liquidity_usd: 5, deepest_liquidity_usd: 5 })],
    [DEPLOYMENT_TABLE]: [deployment()],
  })
  const result = await readRwaTokenDepth(db, { cryptoId: '4705' }, NOW)
  eq(result.captured, true)
  const token = result.token as Record<string, unknown>
  eq(token.symbol, 'PAXG')
  eq(token.totalLiquidityUsd, 1_000_000, 'the newest snapshot, not the oldest')
  eq(token.concentrationPct, 90)
  eq((token.contracts as Record<string, unknown>[])[0].address, EVM)
  eq(result.exitabilityMethod, EXITABILITY_METHOD)
  eq((result.attribution as Record<string, unknown>).label, 'CoinMarketCap')
  eq(result.asOf, token.capturedAt)
  // `providerId` is the alias the asset page passes.
  eq((await readRwaTokenDepth(db, { providerId: '4705' }, NOW)).captured, true)
})

Deno.test('both views are registered on the lane surface', () => {
  eq(Object.keys(RWA_DEPTH_CAPTURE_VIEWS).sort(), ['rwa_depth', 'rwa_token_depth'])
})
