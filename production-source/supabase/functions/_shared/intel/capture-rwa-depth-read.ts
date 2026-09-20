// Investor Intel — read views over the tokenised-asset depth capture tables.
//
// Two views, one lane:
//   `rwa_depth`        the ranked board for /intel/structure.
//   `rwa_token_depth`  one token, for the asset page, keyed by its CoinMarketCap
//                      id. A token with no capture answers `captured: false`,
//                      never an error, so the asset page can render nothing at
//                      all rather than an empty block.
//
// Same contract as every other capture read module: pure functions over a
// PostgREST-shaped `db`, bounded by explicit row caps, newest-first so hitting a
// cap loses the OLDEST rows, and a FAILED read reported as a reason on an
// otherwise intact result rather than as an empty list. The tables are
// service-role only, so this runs inside `intel-capture` behind an authenticated
// Investor Intel membership check.
//
// ── EVERY DERIVED FIGURE IS OURS AND SAYS SO ─────────────────────────────────
// The lane stores only what CoinMarketCap reported. Three readings are computed
// here, and each names its inputs:
//
//   concentrationPct  the deepest pool's liquidity as a percent of the total
//                     liquidity of the pools we read. 100 means one pool is the
//                     whole of what we found.
//   exitability       the USD size that is 1 and 5 percent of the DEEPEST pool's
//                     reported liquidity. It is a SIZE RELATIVE TO A POOL, and
//                     the copy says exactly that. It is NOT a slippage estimate:
//                     no curve, no fee tier, no reserve split and no price
//                     impact is modelled, because none of that is in the data.
//   liquidityCoverage how many of the pools found actually reported liquidity. A
//                     total built from 2 of 9 pools is not the token's
//                     liquidity, and the board says so instead of implying it.
//
// The one thing this module must never do is turn a pool reading into a claim
// about what a seller would receive. `EXITABILITY_METHOD` is rendered beside the
// figure and is the whole of the method.

import { CMC_DEX_NETWORKS } from '../market-assets/cmc-dex.ts'
import { DEPTH_TABLE, DEPLOYMENT_TABLE, RWA_DEPTH_CAPTURE_SCHEDULE } from './capture-rwa-depth.ts'

/** Rows one board read may pull. One row per token per day; the subject set is
 * bounded at 60 a run, so 30 days of captures is well inside this. */
const DEPTH_CAP = 4_000
/** Tokens returned to the caller. */
const DEPTH_ROW_MAX = 200
/** Deployment rows one read may pull. */
const DEPLOYMENT_CAP = 2_000
/** Contracts listed per token. A token deployed on more chains than this has the
 * rest counted, never silently dropped: `chainsOmitted` says how many. */
const CONTRACTS_PER_TOKEN = 12
/** How far back a board read looks for the newest capture of each token. A token
 * the lane stopped reaching is still shown, with its own capture date, rather
 * than disappearing from the board. */
const DEPTH_WINDOW_DAYS = 14

/** The two fractions of the deepest pool the board reports, and the sentence
 * that is the entire method behind them. */
export const EXITABILITY_FRACTIONS = [1, 5] as const
export const EXITABILITY_METHOD =
  'Our calculation, not the provider\'s: one and five percent of the deepest pool\'s reported liquidity at the capture time on this row. It is a rough sense of the size at which a sale starts to be large relative to that one pool. It is not a slippage estimate and not a quote: no curve, no fee tier, no reserve split and no price impact is modelled, because none of those is in the data.'

/** What the provider's own depth figures do not mean. Restated here so the view
 * carries it even for a token whose stored row predates the column. */
export const DEPTH_FALLBACK_SCOPE =
  'Pool liquidity and 24-hour pool volume are CoinMarketCap DEX figures for the pools found on the chains named on this row. They are not an executable quote, not an order book and not the token\'s total liquidity: liquidity on centralised venues and on chains CoinMarketCap publishes no DEX data for is not visible here.'

/** Which chains this lane is able to read at all, named so "no pool found" is
 * never printed without its coverage. Taken from the verified DEX registry
 * rather than restated, so a chain added there appears in the copy by itself. */
export const READ_CHAINS: string[] = CMC_DEX_NETWORKS.map((network) => network.label)

/** The endpoints every figure on these views came from, named on the page. */
export const DEPTH_ENDPOINTS = [
  '/v5/real-world-assets/assets/list', '/v2/cryptocurrency/info', '/v1/dex/token/pools', '/v1/dex/holders/count',
] as const

export interface Coverage { from: string | null; to: string | null; count: number; truncated?: boolean }
export interface ViewResult { view: string; asOf: string | null; coverage: Coverage; reason?: string | null; [key: string]: unknown }

const num = (v: unknown): number | null => { if (v == null || v === '' || typeof v === 'boolean') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const int = (v: unknown): number | null => { const n = num(v); return n == null ? null : Math.trunc(n) }
const str = (v: unknown, max = 200): string | null => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null }
const list = (v: unknown, max = 40): string[] => (Array.isArray(v) ? v.map((x) => str(x, 200)).filter((x): x is string => !!x).slice(0, max) : [])
const at = (now: Date | number): number => (now instanceof Date ? now.getTime() : now)
const sinceDay = (now: Date | number, days: number): string => new Date(at(now) - days * 86_400_000).toISOString().slice(0, 10)
const emptyCoverage = (): Coverage => ({ from: null, to: null, count: 0 })

// deno-lint-ignore no-explicit-any
async function readRows(build: () => any): Promise<{ rows: any[]; reason: string | null }> {
  try {
    const { data, error } = await build()
    if (error) return { rows: [], reason: String(error.message || error.code || error).slice(0, 200) }
    return { rows: Array.isArray(data) ? data : data ? [data] : [], reason: null }
  } catch (e) { return { rows: [], reason: ((e as Error)?.message || 'read_failed').slice(0, 200) } }
}

/** The deepest pool's share of the liquidity we found, in percent.
 *
 * Null when there is nothing to divide: no total, a total of zero, or no deepest
 * pool. A single pool is 100 percent, which is a real and important reading, not
 * a missing one. */
export function concentrationPct(deepest: unknown, total: unknown): number | null {
  const top = num(deepest), sum = num(total)
  if (top == null || sum == null || sum <= 0) return null
  return Math.min(100, (top / sum) * 100)
}

/** The 1 and 5 percent sizes of the deepest pool. OUR calculation; see
 * `EXITABILITY_METHOD`, which travels with it on every payload. */
export function exitabilitySizes(deepestLiquidityUsd: unknown): { pct: number; usd: number }[] | null {
  const deepest = num(deepestLiquidityUsd)
  if (deepest == null || deepest <= 0) return null
  return EXITABILITY_FRACTIONS.map((pct) => ({ pct, usd: (deepest * pct) / 100 }))
}

const DEPTH_COLUMNS = 'token_key,snapshot_date,captured_at,crypto_id,symbol,token_name,rwa_id,rwa_name,asset_type,issuer_name,underlying_value_usd,token_market_cap,depth_state,chains_deployed,chains_read,chains_not_covered,pool_count,liquidity_pools,total_liquidity_usd,total_volume_24h_usd,deepest_pool_address,deepest_pool_dex,deepest_pool_chain,deepest_pool_pair,deepest_liquidity_usd,deepest_volume_24h_usd,holder_count,holder_chain,restriction_state,restriction_kyc_gated,restriction_source_url,pools,scope'
const DEPLOYMENT_COLUMNS = 'token_key,platform_key,platform_label,chain,contract_address,dex_platform,dex_address,readable,source,captured_at'

// deno-lint-ignore no-explicit-any
const pool = (row: any) => ({
  chain: str(row?.chain, 40), dex: str(row?.dex, 120), pair: str(row?.pair, 100),
  address: str(row?.address, 200), liquidityUsd: num(row?.liquidityUsd), volume24h: num(row?.volume24h),
})

// deno-lint-ignore no-explicit-any
function depthRow(row: any) {
  const deepestLiquidity = num(row?.deepest_liquidity_usd)
  const total = num(row?.total_liquidity_usd)
  return {
    tokenKey: str(row?.token_key, 200), snapshotDate: str(row?.snapshot_date, 10), capturedAt: str(row?.captured_at, 40),
    cryptoId: str(row?.crypto_id, 20), symbol: str(row?.symbol, 50), tokenName: str(row?.token_name, 200),
    rwaId: str(row?.rwa_id, 20), rwaName: str(row?.rwa_name, 200), assetType: str(row?.asset_type, 40),
    issuerName: str(row?.issuer_name, 200),
    underlyingValueUsd: num(row?.underlying_value_usd), tokenMarketCap: num(row?.token_market_cap),
    state: str(row?.depth_state, 40),
    chainsDeployed: list(row?.chains_deployed), chainsRead: list(row?.chains_read), chainsNotCovered: list(row?.chains_not_covered),
    poolCount: int(row?.pool_count), liquidityPools: int(row?.liquidity_pools),
    totalLiquidityUsd: total, totalVolume24hUsd: num(row?.total_volume_24h_usd),
    deepestPool: row?.deepest_pool_address
      ? {
        address: str(row.deepest_pool_address, 200), dex: str(row.deepest_pool_dex, 120),
        chain: str(row.deepest_pool_chain, 40), pair: str(row.deepest_pool_pair, 100),
        liquidityUsd: deepestLiquidity, volume24h: num(row.deepest_volume_24h_usd),
      }
      : null,
    // OUR readings. Both are recomputed from the stored provider figures on every
    // read, so a formula change can never leave a stale derived number behind.
    concentrationPct: concentrationPct(deepestLiquidity, total),
    exitability: exitabilitySizes(deepestLiquidity),
    holderCount: int(row?.holder_count), holderChain: str(row?.holder_chain, 40),
    restriction: row?.restriction_state
      ? { state: str(row.restriction_state, 40), kycGated: row.restriction_kyc_gated === true, sourceUrl: str(row.restriction_source_url, 500) }
      : null,
    pools: (Array.isArray(row?.pools) ? row.pools : []).slice(0, 30).map(pool),
    scope: str(row?.scope, 2000) || DEPTH_FALLBACK_SCOPE,
  }
}

// deno-lint-ignore no-explicit-any
const deploymentRow = (row: any) => ({
  tokenKey: str(row?.token_key, 200), platformKey: str(row?.platform_key, 120),
  platformLabel: str(row?.platform_label, 120) || str(row?.platform_key, 120),
  chain: str(row?.chain, 120), contractAddress: str(row?.contract_address, 240),
  dexPlatform: str(row?.dex_platform, 40), readable: row?.readable === true,
  source: str(row?.source, 40), capturedAt: str(row?.captured_at, 40),
})

/** The newest capture of every token, with its deployments attached.
 *
 * A token appears once, from its newest snapshot inside the window. Ordering is
 * by total liquidity descending with the tokens we could not read LAST, so a
 * board whose top rows are pending never looks like a board of thin tokens. */
// deno-lint-ignore no-explicit-any
async function loadDepth(db: any, now: Date | number, filter?: { cryptoId?: string | null; tokenKey?: string | null }) {
  const page = await readRows(() => {
    let q = db.from(DEPTH_TABLE).select(DEPTH_COLUMNS).eq('provider', 'coinmarketcap')
      .gte('snapshot_date', sinceDay(now, DEPTH_WINDOW_DAYS))
    if (filter?.cryptoId) q = q.eq('crypto_id', filter.cryptoId)
    if (filter?.tokenKey) q = q.eq('token_key', filter.tokenKey)
    return q.order('snapshot_date', { ascending: false }).limit(filter ? 40 : DEPTH_CAP)
  })
  const all = page.rows.map(depthRow).filter((row) => !!row.tokenKey)
  const newest = new Map<string, ReturnType<typeof depthRow>>()
  for (const row of all) if (!newest.has(row.tokenKey as string)) newest.set(row.tokenKey as string, row)
  return { rows: [...newest.values()], scanned: page.rows.length, reason: page.reason }
}

// deno-lint-ignore no-explicit-any
async function loadDeployments(db: any, tokenKeys: string[]) {
  if (!tokenKeys.length) return { byToken: new Map<string, ReturnType<typeof deploymentRow>[]>(), reason: null as string | null }
  const page = await readRows(() => db.from(DEPLOYMENT_TABLE).select(DEPLOYMENT_COLUMNS)
    .eq('provider', 'coinmarketcap').in('token_key', tokenKeys.slice(0, 400))
    .order('captured_at', { ascending: false }).limit(DEPLOYMENT_CAP))
  const byToken = new Map<string, ReturnType<typeof deploymentRow>[]>()
  for (const row of page.rows.map(deploymentRow)) {
    if (!row.tokenKey) continue
    byToken.set(row.tokenKey, [...(byToken.get(row.tokenKey) || []), row])
  }
  return { byToken, reason: page.reason }
}

/** Deployments as the page prints them: readable chains first, then the rest,
 * each with its copyable contract. Bounded, and the overflow is COUNTED.
 *
 * Deduplicated on (chain, address-ignoring-case) with the NEWEST capture kept.
 * The deployment table stores the address exactly as the provider published it
 * and that is part of its primary key, so a provider that re-cases an address
 * leaves two rows for one contract. Printing both would tell a reader they hold
 * two different tokens. The rows arrive newest-first from the read. */
export function contractList(rows: ReturnType<typeof deploymentRow>[] = []) {
  const unique = new Map<string, ReturnType<typeof deploymentRow>>()
  for (const row of rows) {
    const key = `${row.platformKey}|${String(row.contractAddress ?? '').toLowerCase()}`
    if (!unique.has(key)) unique.set(key, row)
  }
  const ordered = [...unique.values()].sort((a, b) => (a.readable === b.readable ? String(a.platformLabel ?? '').localeCompare(String(b.platformLabel ?? '')) : a.readable ? -1 : 1))
  return {
    contracts: ordered.slice(0, CONTRACTS_PER_TOKEN).map((row) => ({
      chain: row.platformLabel, chainKey: row.platformKey, address: row.contractAddress,
      readable: row.readable, dexPlatform: row.dexPlatform,
    })),
    chainsOmitted: Math.max(0, ordered.length - CONTRACTS_PER_TOKEN),
  }
}

/** Rank: readable depth first, deepest first; then everything we could not read,
 * by the tokenised value of the asset it wraps, so a large wrapper with no pool
 * is near the top of its own group rather than lost at the bottom of the board. */
const RANK_GROUP: Record<string, number> = { pools_read: 0, no_pool_on_read_chains: 1, issuer_redemption_only: 2, chain_not_covered: 3, no_deployment_known: 4, provider_unavailable: 5, budget_deferred: 6 }

/** The board for /intel/structure. */
// deno-lint-ignore no-explicit-any
export async function readRwaDepth(db: any, _params: Record<string, unknown> = {}, now: Date | number = Date.now()): Promise<ViewResult> {
  const depth = await loadDepth(db, now)
  if (!depth.rows.length) {
    return {
      view: 'rwa_depth', rows: [],
      cohort: { count: 0, withPools: 0, withoutPools: 0, permissioned: 0, notCovered: 0, pending: 0, totalLiquidityUsd: null },
      readChains: [...READ_CHAINS], schedule: RWA_DEPTH_CAPTURE_SCHEDULE,
      exitabilityMethod: EXITABILITY_METHOD, scope: DEPTH_FALLBACK_SCOPE,
      attribution: { label: 'CoinMarketCap', endpoints: DEPTH_ENDPOINTS },
      asOf: null, coverage: emptyCoverage(), reason: depth.reason,
    }
  }
  const deployments = await loadDeployments(db, depth.rows.map((row) => row.tokenKey as string))
  const rows = depth.rows
    .map((row) => ({ ...row, ...contractList(deployments.byToken.get(row.tokenKey as string) || []) }))
    .sort((a, b) => (RANK_GROUP[String(a.state)] ?? 9) - (RANK_GROUP[String(b.state)] ?? 9)
      || (b.totalLiquidityUsd ?? -1) - (a.totalLiquidityUsd ?? -1)
      || (b.underlyingValueUsd ?? -1) - (a.underlyingValueUsd ?? -1)
      || String(a.tokenKey).localeCompare(String(b.tokenKey)))
    .slice(0, DEPTH_ROW_MAX)
  const stamps = depth.rows.map((row) => row.capturedAt).filter((v): v is string => !!v).sort()
  const priced = depth.rows.filter((row) => row.totalLiquidityUsd != null)
  return {
    view: 'rwa_depth', rows,
    // Measured over every token captured in the window, before the row cap, so
    // the summary describes the capture rather than the visible table.
    cohort: {
      count: depth.rows.length,
      withPools: depth.rows.filter((row) => row.state === 'pools_read').length,
      withoutPools: depth.rows.filter((row) => row.state === 'no_pool_on_read_chains').length,
      permissioned: depth.rows.filter((row) => row.state === 'issuer_redemption_only').length,
      notCovered: depth.rows.filter((row) => row.state === 'chain_not_covered' || row.state === 'no_deployment_known').length,
      pending: depth.rows.filter((row) => row.state === 'budget_deferred' || row.state === 'provider_unavailable').length,
      totalLiquidityUsd: priced.length ? priced.reduce((sum, row) => sum + (row.totalLiquidityUsd as number), 0) : null,
    },
    readChains: [...READ_CHAINS], schedule: RWA_DEPTH_CAPTURE_SCHEDULE,
    exitabilityMethod: EXITABILITY_METHOD,
    scope: rows[0]?.scope || DEPTH_FALLBACK_SCOPE,
    attribution: { label: 'CoinMarketCap', endpoints: DEPTH_ENDPOINTS },
    asOf: stamps.at(-1) ?? null,
    coverage: { from: stamps[0] ?? null, to: stamps.at(-1) ?? null, count: depth.scanned, truncated: depth.scanned >= DEPTH_CAP },
    reason: depth.reason || deployments.reason,
  }
}

/** One token, for the asset page.
 *
 * `captured: false` with no row is the normal answer for the overwhelming
 * majority of assets: this lane covers tokenised real-world assets, and an asset
 * page for anything else renders nothing at all rather than an empty block
 * saying a figure is missing. */
// deno-lint-ignore no-explicit-any
export async function readRwaTokenDepth(db: any, params: Record<string, unknown> = {}, now: Date | number = Date.now()): Promise<ViewResult> {
  const cryptoId = /^[1-9][0-9]{0,11}$/.test(String(params.cryptoId ?? params.providerId ?? '')) ? String(params.cryptoId ?? params.providerId) : null
  const tokenKey = str(params.tokenKey, 200)
  if (!cryptoId && !tokenKey) {
    return { view: 'rwa_token_depth', captured: false, token: null, asOf: null, coverage: emptyCoverage(), reason: 'no_token_selected' }
  }
  const depth = await loadDepth(db, now, { cryptoId, tokenKey })
  const row = depth.rows[0] ?? null
  if (!row) {
    return {
      view: 'rwa_token_depth', captured: false, token: null,
      readChains: [...READ_CHAINS], schedule: RWA_DEPTH_CAPTURE_SCHEDULE,
      asOf: null, coverage: emptyCoverage(), reason: depth.reason,
    }
  }
  const deployments = await loadDeployments(db, [row.tokenKey as string])
  return {
    view: 'rwa_token_depth', captured: true,
    token: { ...row, ...contractList(deployments.byToken.get(row.tokenKey as string) || []) },
    readChains: [...READ_CHAINS], schedule: RWA_DEPTH_CAPTURE_SCHEDULE,
    exitabilityMethod: EXITABILITY_METHOD, scope: row.scope,
    attribution: { label: 'CoinMarketCap', endpoints: DEPTH_ENDPOINTS },
    asOf: row.capturedAt,
    coverage: { from: row.capturedAt, to: row.capturedAt, count: depth.scanned },
    reason: depth.reason || deployments.reason,
  }
}

/** Integration surface. The reviewer wires these into the Edge Function's read
 * half alongside `readCaptureView`. */
export const RWA_DEPTH_CAPTURE_VIEWS: Record<string, (
  // deno-lint-ignore no-explicit-any
  db: any, body: Record<string, unknown>, now: number
) => Promise<ViewResult>> = {
  rwa_depth: (db, body, now) => readRwaDepth(db, body, now),
  rwa_token_depth: (db, body, now) => readRwaTokenDepth(db, body, now),
}
