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
// ── THE OTHER SIDE OF THE POOL DECIDES WHETHER A POOL COUNTS ─────────────────
// CoinMarketCap's `liqUsd` values BOTH legs, so a pool against a token nobody can
// value reports a large USD figure that no seller could take out. On 2026-09-20
// that put `XAUt / GOLDGR` at $16.5M with $812 of daily volume at the top of
// XAUt's board, and `u / SLVon` at $10.4M with zero volume at the top of SLVon's,
// while SLVon's real USDC pool held $0.56M.
//
// So every headline figure on these views - the total, the deepest pool,
// concentration, the exit sizes, the scatter point and the ranking - is built
// ONLY from pools whose counter leg is a recognised quote asset on that chain or
// another tokenised asset we have captured, matched by CONTRACT ADDRESS (see
// rwa-counter-leg.ts). The rest are returned in their own group, with the
// sentence that says why they are separate.
//
// THREE CLASSIFICATION STATES, and the third is the honest one:
//   `classified`     the capture stored a class per pool. Used as stored.
//   `classified_on_read`  the row carries leg ADDRESSES but no stored class (a
//                    capture written between the lane change and the migration,
//                    which the deploy order makes a safety net rather than a
//                    normal path). Classified here from the same STATIC quote
//                    allowlist, and from the tokenised assets whose deployments
//                    this same read already loaded. That last part is narrower
//                    than the capture's, which reads the whole deployment table,
//                    so the fallback fails CLOSED: a legitimate pool can drop out
//                    of the headline, never a junk one into it.
//   `unclassified`   the row has no leg addresses at all, which is every row
//                    captured before 2026-09-20. The stored pair label is two
//                    SYMBOLS and a worthless token can call itself USDC, so
//                    nothing is inferred: the provider's own totals are shown
//                    with UNCLASSIFIED_SCOPE beside them.
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
import { DEPTH_TABLE, DEPLOYMENT_TABLE, RWA_DEPTH_CAPTURE_SCHEDULE, WRAPPER_TOKEN_TABLE } from './capture-rwa-depth.ts'
import {
  COUNTED_SCOPE, EXIT_LIQUIDITY_SCOPE, POOL_CLASSIFICATION, UNCLASSIFIED_SCOPE, UNRECOGNISED_SCOPE,
  classifiedTotals, classifyStoredPools, poolsClassifiable, quoteAllowlist, quoteKey,
} from './rwa-counter-leg.ts'
import type { ClassifiablePool, CounterClass } from './rwa-counter-leg.ts'

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

/** The endpoints every figure on these views came from, named on the page.
 *
 * The two RWA endpoints are where the token identities and the tokenised values
 * originate: since 2026-09-20 the depth lane takes them from the wrapper lane's
 * stored capture rather than calling for them itself, but the figures are still
 * the provider's from those two paths and the page says so. */
export const DEPTH_ENDPOINTS = [
  '/v5/real-world-assets/quotes/latest', '/v5/real-world-assets/assets/list',
  '/v2/cryptocurrency/info', '/v1/dex/token/pools', '/v1/dex/holders/count',
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

const DEPTH_COLUMNS = 'token_key,snapshot_date,captured_at,crypto_id,symbol,token_name,rwa_id,rwa_name,asset_type,issuer_name,underlying_value_usd,token_market_cap,depth_state,chains_deployed,chains_read,chains_not_covered,pool_count,liquidity_pools,total_liquidity_usd,total_volume_24h_usd,deepest_pool_address,deepest_pool_dex,deepest_pool_chain,deepest_pool_pair,deepest_liquidity_usd,deepest_volume_24h_usd,holder_count,holder_chain,restriction_state,restriction_kyc_gated,restriction_source_url,pools,scope,pool_classification,recognised_pool_count,recognised_liquidity_pools,recognised_liquidity_usd,recognised_volume_24h_usd,unrecognised_pool_count,unrecognised_liquidity_usd,deepest_recognised_address,deepest_recognised_dex,deepest_recognised_chain,deepest_recognised_pair,deepest_recognised_liquidity_usd,deepest_recognised_volume_24h_usd,exit_liquidity_usd,exit_liquidity_pools'
const DEPLOYMENT_COLUMNS = 'token_key,platform_key,platform_label,chain,contract_address,dex_platform,dex_address,readable,source,captured_at'

/** The classes a pool element may carry, as stored. Anything else is treated as
 * absent rather than passed through: a class the reader does not know is not a
 * class the board may count. */
const COUNTER_CLASS = new Set<CounterClass>(['recognised_quote', 'tokenised_asset', 'unrecognised'])
const counterClass = (value: unknown): CounterClass | null =>
  COUNTER_CLASS.has(String(value ?? '') as CounterClass) ? String(value) as CounterClass : null

// deno-lint-ignore no-explicit-any
const leg = (row: any) => ({ addr: str(row?.addr, 200), sym: str(row?.sym, 40), liqUsd: num(row?.liqUsd) })

// deno-lint-ignore no-explicit-any
const pool = (row: any): ClassifiablePool => ({
  chain: str(row?.chain, 40), dex: str(row?.dex, 120), pair: str(row?.pair, 100),
  address: str(row?.address, 200), liquidityUsd: num(row?.liquidityUsd), volume24h: num(row?.volume24h),
  // Legs and class are absent on every row captured before 2026-09-20.
  t0: leg(row?.t0), t1: leg(row?.t1),
  counterClass: counterClass(row?.counterClass), counterAddress: str(row?.counterAddress, 200),
  counterSymbol: str(row?.counterSymbol, 40), exitLiquidityUsd: num(row?.exitLiquidityUsd),
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
    holderCount: int(row?.holder_count), holderChain: str(row?.holder_chain, 40),
    restriction: row?.restriction_state
      ? { state: str(row.restriction_state, 40), kycGated: row.restriction_kyc_gated === true, sourceUrl: str(row.restriction_source_url, 500) }
      : null,
    pools: ((Array.isArray(row?.pools) ? row.pools : []) as unknown[]).slice(0, 60).map(pool),
    // The counter-leg split as the capture stored it. `storedClassification` is
    // null on every row captured before the lane read leg addresses.
    storedClassification: str(row?.pool_classification, 40),
    storedSplit: {
      countedPools: int(row?.recognised_pool_count), countedLiquidityPools: int(row?.recognised_liquidity_pools),
      countedLiquidityUsd: num(row?.recognised_liquidity_usd), countedVolume24hUsd: num(row?.recognised_volume_24h_usd),
      unrecognisedPools: int(row?.unrecognised_pool_count), unrecognisedLiquidityUsd: num(row?.unrecognised_liquidity_usd),
      exitLiquidityUsd: num(row?.exit_liquidity_usd), exitLiquidityPools: int(row?.exit_liquidity_pools),
      deepestCounted: row?.deepest_recognised_address
        ? {
          address: str(row.deepest_recognised_address, 200), dex: str(row.deepest_recognised_dex, 120),
          chain: str(row.deepest_recognised_chain, 40), pair: str(row.deepest_recognised_pair, 100),
          liquidityUsd: num(row.deepest_recognised_liquidity_usd), volume24h: num(row.deepest_recognised_volume_24h_usd),
        }
        : null,
    },
    // Provider deepest, kept beside the counted one: for XAUt on 2026-09-20 this
    // is the GOLDGR pool the board must NOT present as depth, and naming it is
    // how a reader sees what was excluded and why.
    providerDeepestLiquidityUsd: deepestLiquidity,
    scope: str(row?.scope, 4000) || DEPTH_FALLBACK_SCOPE,
  }
}

export type DepthRow = ReturnType<typeof depthRow>
/** Which of the three classification states a row is in. */
export type ClassificationState = 'classified' | 'classified_on_read' | 'unclassified'

/**
 * Put the counter-leg split, and OUR readings over it, onto one row.
 *
 * The readings are recomputed on every read from the stored provider figures, so
 * a formula change can never leave a stale derived number behind. What changed on
 * 2026-09-20 is WHICH pools they are computed over: only the pools whose other
 * leg can be valued.
 *
 * `subjectAddresses` are the token's own readable deployments, needed only for
 * the `classified_on_read` path, where the pool carries leg addresses but no
 * stored class and the counter leg still has to be told from the subject leg.
 */
export function withCounterLegSplit(
  row: DepthRow,
  ctx: { quotes: ReturnType<typeof quoteAllowlist>; rwaAddresses: Set<string>; subjectAddresses: Set<string> },
) {
  const stored = row.storedClassification === POOL_CLASSIFICATION
  const classifiable = poolsClassifiable(row.pools)
  const state: ClassificationState = stored ? 'classified' : classifiable ? 'classified_on_read' : 'unclassified'
  const pools = stored || !classifiable ? row.pools : classifyStoredPools(row.pools, ctx)

  if (state === 'unclassified') {
    // Nothing is inferred from a pair label. The provider's own figures are
    // presented as the provider's, with the sentence that says so.
    return {
      ...row, pools,
      classification: state,
      countedLiquidityUsd: null, countedVolume24hUsd: null, countedPools: null, countedLiquidityPools: null,
      deepestPool: row.deepestPool, unrecognisedPools: [], unrecognisedPoolCount: null, unrecognisedLiquidityUsd: null,
      exitLiquidityUsd: null, exitLiquidityPools: null,
      concentrationPct: concentrationPct(row.providerDeepestLiquidityUsd, row.totalLiquidityUsd),
      exitability: exitabilitySizes(row.providerDeepestLiquidityUsd),
      classificationNote: UNCLASSIFIED_SCOPE,
    }
  }

  // Stored totals are preferred when the capture computed them: they were taken
  // over every pool the run saw, and the stored `pools` array is capped at 30.
  // Recomputing from the cap would quietly shrink a token with a long tail.
  const computed = classifiedTotals(pools)
  const split = stored && row.storedSplit.countedPools != null ? row.storedSplit : computed
  const deepest = (stored && row.storedSplit.deepestCounted) || computed.deepestCounted || null
  const deepestLiquidity = num(deepest?.liquidityUsd)
  return {
    ...row, pools,
    classification: state,
    // A row classified HERE was stored with the pre-classification scope, so the
    // two sentences that explain the split are prepended rather than left off.
    // A row the capture classified already carries both and is untouched.
    scope: row.scope.includes(COUNTED_SCOPE) ? row.scope : `${COUNTED_SCOPE} ${UNRECOGNISED_SCOPE} ${row.scope}`,
    countedPools: split.countedPools ?? null,
    countedLiquidityPools: split.countedLiquidityPools ?? null,
    countedLiquidityUsd: split.countedLiquidityUsd ?? null,
    countedVolume24hUsd: split.countedVolume24hUsd ?? null,
    // THE deepest pool, for every surface. The provider's own deepest stays on
    // `providerDeepestLiquidityUsd` and is named in the excluded group instead.
    deepestPool: deepest
      ? {
        address: str(deepest.address, 200), dex: str(deepest.dex, 120), chain: str(deepest.chain, 40),
        pair: str(deepest.pair, 100), liquidityUsd: deepestLiquidity, volume24h: num(deepest.volume24h),
      }
      : null,
    // Listed, never counted, and never silently dropped: the group is returned in
    // full within the row's own pool cap, deepest first.
    unrecognisedPools: pools.filter((entry) => entry.counterClass === 'unrecognised')
      .sort((a, b) => (num(b.liquidityUsd) ?? -1) - (num(a.liquidityUsd) ?? -1)),
    unrecognisedPoolCount: split.unrecognisedPools ?? null,
    unrecognisedLiquidityUsd: split.unrecognisedLiquidityUsd ?? null,
    exitLiquidityUsd: split.exitLiquidityUsd ?? null,
    exitLiquidityPools: split.exitLiquidityPools ?? null,
    // OUR readings, now over the counted pools only.
    concentrationPct: concentrationPct(deepestLiquidity, split.countedLiquidityUsd),
    exitability: exitabilitySizes(deepestLiquidity),
    classificationNote: null,
  }
}

export type SplitDepthRow = ReturnType<typeof withCounterLegSplit>

/** Whether a token's only pools are ones we cannot value. It is its own state,
 * not "no pool": there ARE pools, and telling a reader there are none would be
 * as wrong as counting them. */
export function onlyUnrecognised(row: SplitDepthRow): boolean {
  return row.classification !== 'unclassified' && row.state === 'pools_read'
    && (row.countedPools ?? 0) === 0 && (row.unrecognisedPoolCount ?? 0) > 0
}

// deno-lint-ignore no-explicit-any
const deploymentRow = (row: any) => ({
  tokenKey: str(row?.token_key, 200), platformKey: str(row?.platform_key, 120),
  platformLabel: str(row?.platform_label, 120) || str(row?.platform_key, 120),
  chain: str(row?.chain, 120), contractAddress: str(row?.contract_address, 240),
  dexPlatform: str(row?.dex_platform, 40),
  // The canonical address, kept off the printed contract list and used only to
  // tell a pool's subject leg from its counter leg.
  dexAddress: str(row?.dex_address, 240),
  readable: row?.readable === true,
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

/** Everything needed to classify a counter leg on read, built from rows we have
 * already loaded. The quote allowlist is the STATIC half only: a read never
 * issues an extra query to classify a pool, and the capture's stored class is the
 * authority for every row written since the lane change. */
function classifyContext(byToken: Map<string, ReturnType<typeof deploymentRow>[]>) {
  const quotes = quoteAllowlist()
  const rwaAddresses = new Set<string>()
  for (const rows of byToken.values()) {
    for (const row of rows) {
      const key = row.readable ? quoteKey(row.dexPlatform, row.dexAddress) : ''
      if (key) rwaAddresses.add(key)
    }
  }
  const subjectsFor = (tokenKey: string): Set<string> => new Set((byToken.get(tokenKey) || [])
    .filter((row) => row.readable).map((row) => quoteKey(row.dexPlatform, row.dexAddress)).filter(Boolean))
  return { quotes, rwaAddresses, subjectsFor }
}

/** Wrapper-token rows one read may pull for the all-venue volume join. The
 * wrapper lane writes one row per (asset, token) every six hours, about 300 a
 * capture on 2026-09-20; filtered to the board's own tokens and to the last
 * `PROVIDER_VOLUME_WINDOW_HOURS`, this is far above what a read can reach, and
 * the read is newest-first so hitting it loses the OLDEST captures. */
const PROVIDER_VOLUME_CAP = 2_000
/** How old a wrapper capture may be and still stand beside a depth row. Two
 * days is eight six-hourly captures: a token the wrapper lane stopped naming is
 * reported as missing rather than paired with a week-old figure. */
const PROVIDER_VOLUME_WINDOW_HOURS = 48
const PROVIDER_ID = /^[1-9][0-9]{0,11}$/

/** Why a row has no all-venue volume beside it. */
export const PROVIDER_VOLUME_REASONS = ['no_provider_id', 'not_in_recent_wrapper_capture', 'wrapper_read_failed'] as const

/**
 * CoinMarketCap's own 24-hour volume for each token, from the wrapper lane's
 * newest capture (`/v5/real-world-assets/quotes/latest`, `tokens[].volume_24h`).
 *
 * This is ALL-VENUE turnover, centralised exchanges included, and it is the
 * second scenario the exit simulator shows beside the on-chain recognised-pool
 * volume. It is a join over a table we already hold: zero credits, one bounded
 * read. A failed read never breaks the depth view: every row keeps its depth
 * figures and carries null volume with `providerVolumeReason` saying why.
 */
// deno-lint-ignore no-explicit-any
export async function attachProviderVolume<T extends { cryptoId: string | null }>(db: any, rows: T[], now: Date | number) {
  const ids = [...new Set(rows.map((row) => row.cryptoId).filter((id): id is string => !!id && PROVIDER_ID.test(id)))].slice(0, 400)
  const found = new Map<string, { volume: number | null; capturedAt: string | null }>()
  let reason: string | null = null
  if (ids.length) {
    const since = new Date(at(now) - PROVIDER_VOLUME_WINDOW_HOURS * 3_600_000).toISOString()
    const page = await readRows(() => db.from(WRAPPER_TOKEN_TABLE).select('crypto_id,volume_24h,captured_at')
      .eq('provider', 'coinmarketcap').in('crypto_id', ids).gte('captured_at', since)
      .order('captured_at', { ascending: false }).limit(PROVIDER_VOLUME_CAP))
    reason = page.reason
    // Newest capture wins. One token can sit under more than one asset in the
    // same capture; the figure is the token's own, so the first seen is kept.
    for (const entry of page.rows) {
      const id = str(entry?.crypto_id, 20)
      if (!id || found.has(id)) continue
      found.set(id, { volume: num(entry?.volume_24h), capturedAt: str(entry?.captured_at, 40) })
    }
  }
  const joined = rows.map((row) => {
    const hit = row.cryptoId ? found.get(row.cryptoId) : undefined
    const rowReason = hit ? null
      : !row.cryptoId || !PROVIDER_ID.test(row.cryptoId) ? 'no_provider_id'
      : reason ? 'wrapper_read_failed' : 'not_in_recent_wrapper_capture'
    return {
      ...row,
      providerVolume24hUsd: hit?.volume ?? null,
      providerVolumeCapturedAt: hit?.capturedAt ?? null,
      providerVolumeReason: rowReason,
    }
  })
  return { rows: joined, reason }
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
      cohort: {
        count: 0, withPools: 0, withoutPools: 0, permissioned: 0, notCovered: 0, pending: 0,
        totalLiquidityUsd: null, countedLiquidityUsd: null, unrecognisedLiquidityUsd: null,
        onlyUnrecognised: 0, unclassified: 0,
      },
      readChains: [...READ_CHAINS], schedule: RWA_DEPTH_CAPTURE_SCHEDULE,
      exitabilityMethod: EXITABILITY_METHOD, scope: DEPTH_FALLBACK_SCOPE,
      countedScope: COUNTED_SCOPE, unrecognisedScope: UNRECOGNISED_SCOPE, exitLiquidityScope: EXIT_LIQUIDITY_SCOPE,
      attribution: { label: 'CoinMarketCap', endpoints: DEPTH_ENDPOINTS },
      asOf: null, coverage: emptyCoverage(), reason: depth.reason,
    }
  }
  const deployments = await loadDeployments(db, depth.rows.map((row) => row.tokenKey as string))
  const ctx = classifyContext(deployments.byToken)
  const split = depth.rows.map((row) => withCounterLegSplit(row, {
    quotes: ctx.quotes, rwaAddresses: ctx.rwaAddresses, subjectAddresses: ctx.subjectsFor(row.tokenKey as string),
  }))
  const rows = split
    .map((row) => ({ ...row, ...contractList(deployments.byToken.get(row.tokenKey as string) || []), onlyUnrecognised: onlyUnrecognised(row) }))
    // RANKED BY WHAT CAN BE SOLD. The counted total, not the provider's, so a
    // token whose size is one pool against a token nobody can value does not sit
    // at the top of a board about where things can be sold. A row whose capture
    // predates classification keeps the provider's total as its rank key and
    // carries the sentence saying so.
    .sort((a, b) => (RANK_GROUP[String(a.state)] ?? 9) - (RANK_GROUP[String(b.state)] ?? 9)
      || ((b.countedLiquidityUsd ?? b.totalLiquidityUsd) ?? -1) - ((a.countedLiquidityUsd ?? a.totalLiquidityUsd) ?? -1)
      || (b.underlyingValueUsd ?? -1) - (a.underlyingValueUsd ?? -1)
      || String(a.tokenKey).localeCompare(String(b.tokenKey)))
    .slice(0, DEPTH_ROW_MAX)
  const volume = await attachProviderVolume(db, rows, now)
  const stamps = depth.rows.map((row) => row.capturedAt).filter((v): v is string => !!v).sort()
  const sum = (field: 'countedLiquidityUsd' | 'unrecognisedLiquidityUsd' | 'totalLiquidityUsd'): number | null => {
    const values = split.map((row) => row[field]).filter((value): value is number => value != null)
    return values.length ? values.reduce((total, value) => total + value, 0) : null
  }
  return {
    view: 'rwa_depth', rows: volume.rows,
    // Measured over every token captured in the window, before the row cap, so
    // the summary describes the capture rather than the visible table.
    cohort: {
      count: split.length,
      withPools: split.filter((row) => row.state === 'pools_read').length,
      withoutPools: split.filter((row) => row.state === 'no_pool_on_read_chains').length,
      permissioned: split.filter((row) => row.state === 'issuer_redemption_only').length,
      notCovered: split.filter((row) => row.state === 'chain_not_covered' || row.state === 'no_deployment_known').length,
      pending: split.filter((row) => row.state === 'budget_deferred' || row.state === 'provider_unavailable').length,
      // The headline is the COUNTED liquidity. The provider's own total stays
      // beside it so the size of what was excluded is visible rather than
      // implied, and the two are never added together.
      countedLiquidityUsd: sum('countedLiquidityUsd'),
      unrecognisedLiquidityUsd: sum('unrecognisedLiquidityUsd'),
      totalLiquidityUsd: sum('totalLiquidityUsd'),
      onlyUnrecognised: split.filter(onlyUnrecognised).length,
      unclassified: split.filter((row) => row.classification === 'unclassified').length,
    },
    readChains: [...READ_CHAINS], schedule: RWA_DEPTH_CAPTURE_SCHEDULE,
    exitabilityMethod: EXITABILITY_METHOD,
    countedScope: COUNTED_SCOPE, unrecognisedScope: UNRECOGNISED_SCOPE, exitLiquidityScope: EXIT_LIQUIDITY_SCOPE,
    scope: rows[0]?.scope || DEPTH_FALLBACK_SCOPE,
    attribution: { label: 'CoinMarketCap', endpoints: DEPTH_ENDPOINTS },
    // The all-venue volume join. Its failure is reported here and per row, and
    // is deliberately NOT folded into `reason`: the depth read itself answered.
    providerVolume: { reason: volume.reason, windowHours: PROVIDER_VOLUME_WINDOW_HOURS },
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
  const ctx = classifyContext(deployments.byToken)
  const token = withCounterLegSplit(row, {
    quotes: ctx.quotes, rwaAddresses: ctx.rwaAddresses, subjectAddresses: ctx.subjectsFor(row.tokenKey as string),
  })
  const volume = await attachProviderVolume(db, [token], now)
  return {
    view: 'rwa_token_depth', captured: true,
    token: {
      ...volume.rows[0], ...contractList(deployments.byToken.get(row.tokenKey as string) || []),
      onlyUnrecognised: onlyUnrecognised(token),
    },
    providerVolume: { reason: volume.reason, windowHours: PROVIDER_VOLUME_WINDOW_HOURS },
    readChains: [...READ_CHAINS], schedule: RWA_DEPTH_CAPTURE_SCHEDULE,
    exitabilityMethod: EXITABILITY_METHOD, scope: row.scope,
    countedScope: COUNTED_SCOPE, unrecognisedScope: UNRECOGNISED_SCOPE, exitLiquidityScope: EXIT_LIQUIDITY_SCOPE,
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
