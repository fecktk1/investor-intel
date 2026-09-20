// Investor Intel — on-chain LIQUIDITY DEPTH and CROSS-CHAIN DEPLOYMENT
// RESOLUTION for tokenised real-world assets.
//
// ── THE QUESTION NOBODY ELSE IN THIS TRACK CAN ANSWER ────────────────────────
// "Is this wrapper too thin to sell?" The obvious source is
// `/v5/real-world-assets/market-pairs/list`, which is Growth tier: on this
// Startup key it is refused 1006 and is never called (see `rwaPairs` in
// cmc-capabilities.ts, tier 'growth'). Every entry that reaches for it falls
// back to 24-hour volume, which is a turnover figure and says nothing about the
// size a seller could actually clear.
//
// This lane answers from the DEX family, which IS on the Startup plan and is
// already in production here (`dexPools`, `dexHolderCount`, tier 'startup',
// probed on the owner's key 2026-09-12): resolve each RWA token's deployments,
// then read the pools of each deployment on a chain CoinMarketCap publishes DEX
// data for, and summarise the depth we actually saw.
//
// ── WHAT ONE DAILY RUN DOES, AND WHAT IT COSTS ───────────────────────────────
//   1. `rwaList` once per asset type (6 calls, params IDENTICAL to the hourly
//      `rwa` universe lane's, so the shared transport answers from ITS cache for
//      0 credits whenever that lane ran inside the hour). Gives every RWA asset,
//      its tokenised market value, and `tokens[]` with `crypto_id`.
//   2. Deployments from `market_assets.facts.deployments` — rows the daily
//      metadata pass already wrote, 0 credits. Tokens still missing one get ONE
//      bounded `metadata` call (up to `METADATA_IDS_PER_CALL` ids, 1 credit).
//   3. `dexPools` per readable deployment, at most `POOL_CALLS_PER_RUN`.
//   4. `dexHolderCount` for the deepest chain of the deepest tokens, at most
//      `HOLDER_CALLS_PER_RUN`.
// Upper bound: 6 + 1 + 60 + 20 = 87 credits a run, once a day. The typical run
// is ~81 because step 1 is a cache hit. The ceiling is restated in the
// `provider_schedule_policy` row the migration seeds.
//
// ── HONESTY RULES THIS LANE KEEPS ────────────────────────────────────────────
//   * "No pool" is never printed without naming the chains that were read. A
//     token deployed only on chains CoinMarketCap publishes no DEX data for is
//     `chain_not_covered`, NOT `no_pool_on_read_chains`.
//   * A token whose contract source shows permissioned transfers and that has no
//     pool is `issuer_redemption_only`, and that state is only reached on the
//     strength of a stored `intel_rwa_token_restrictions` row — never inferred
//     from a fund's name or from the absence of a pool alone.
//   * A token the per-run budget could not reach is `budget_deferred`. Pending
//     is never rendered as "thin".
//   * Liquidity, volume and holder count are the PROVIDER's figures, stored as
//     given. Concentration and the "size that would move this pool" readings are
//     OURS and are derived in the read module, where they are labelled as our
//     calculation with their inputs named. This lane stores no derived ratio.
//   * An address on a chain this platform cannot validate is stored VERBATIM and
//     marked unreadable. Canonicalising an address whose shape nobody checked
//     would be a claim about a chain we have no evidence for.
//
// ── THE POOL RESPONSE SHAPE ──────────────────────────────────────────────────
// `/v1/dex/token/pools` rows are read through the SAME field names the reviewed
// response contract in `cmc-dex.ts` validates and `contract-research.ts` already
// projects (`addr`, `exn`, `liqUsd`, `v24`, `t0`, `t1`, `pubAt`). No field name
// here was invented: the transport refuses a response that does not match its
// request (`dexPools` is in `CMC_DEX_SCHEMA_VALIDATED`), so a shape change is a
// refused call rather than a silently wrong row.
//
// Same contract as `capture-listings.ts`: one function per lane, bounded by an
// explicit call ceiling, obeying `provider_schedule_policy`, never throwing — a
// failure becomes `{ error }` on the result. Nothing here calls CoinMarketCap
// directly; the transport is injected as `deps.request`.

import { cmcRows, planAllows, estimateCmcCredits } from '../market-assets/cmc-capabilities.ts'
import { CMC_DEX_NETWORKS, cmcDexIdentity, cmcDexInteger, cmcDexNumber } from '../market-assets/cmc-dex.ts'
import { cmcDeployments } from '../market-assets/coinmarketcap-provider.ts'
import type { MarketAssetsContext } from '../market-assets/types.ts'
import { CAPTURE_PROVIDER, RWA_ASSET_TYPES, utcDate, schedulePolicy } from './capture-jobs.ts'
import type { CaptureDeps, JobResult } from './capture-jobs.ts'
import { ISSUER_REVIEW_SEED } from './rwa-issuer-evidence.ts'
import { currentAssertions } from './rwa-issuer-aliases.ts'

export const DEPLOYMENT_TABLE = 'intel_rwa_token_deployments'
export const DEPTH_TABLE = 'intel_rwa_depth_snapshots'

/** The pg_cron job this lane runs under. The migration schedules exactly this
 * name and minute; a test reads the migration and fails if the two disagree. */
export const RWA_DEPTH_CAPTURE_SCHEDULE = {
  rwa_depth: { job: 'intel-capture-rwa-depth-daily', cron: '34 3 * * *', cadence: 'daily', utc: '03:34' },
} as const

/** Tokens one run resolves and, budget permitting, reads pools for. The RWA
 * universe carried 254 assets on 2026-09-20 and most of them tokenise one or two
 * wrappers, so this is a deliberate top slice rather than the whole tail. */
export const TOKENS_PER_RUN = 60
/** `dexPools` calls a run may issue, one per readable deployment. 60 is the
 * bulk of the lane's budget and the number the policy row states. */
export const POOL_CALLS_PER_RUN = 60
/** `dexHolderCount` calls a run may issue. Holder count is a second credit on a
 * deployment we already paid for, so it is spent only on the deepest tokens. */
export const HOLDER_CALLS_PER_RUN = 20
/** Ids in the one metadata call that fills missing deployments. `metadata` bills
 * per 250 ids, so this whole call is one credit. */
export const METADATA_IDS_PER_CALL = 50
/** Pools kept per deployment. `dexPools` accepts `size` up to 25. */
export const POOL_PAGE_SIZE = 20
/** Pool rows retained on a depth snapshot, across every chain of one token. The
 * deepest pool is what the reading turns on; the rest are context. */
export const POOLS_PER_TOKEN = 30

/** What a depth snapshot does NOT mean. Stored on every row, because a liquidity
 * figure read without it invites exactly the conclusion the lane cannot support. */
export const DEPTH_SCOPE =
  'Pool liquidity and 24-hour pool volume are CoinMarketCap DEX figures for the pools found on the chains named here, read at the capture time on this row. They are not an executable quote, not an order book, not a slippage model and not the total liquidity of the token: a pool on a chain CoinMarketCap publishes no DEX data for is not counted, and venue liquidity held on centralised exchanges is not visible here at all.'

/** Why a token with permissioned transfers can be pool-thin and still sellable
 * through its issuer. Stored on the rows that reach that state. */
export const REDEMPTION_SCOPE =
  'The verified contract source for this token shows permissioned transfers, so the absence of a public pool is expected rather than a liquidity finding. Whether the issuer will redeem for you, at what minimum and on what timetable is an issuer term, not something this capture establishes.'

const CADENCE_GRACE = 0.9
const MAX_UPSERT_ROWS = 500
/** Cadence this lane falls back to when its policy row is missing.
 * `schedulePolicy` would default an unknown feature to one hour, which for this
 * lane means 87 credits AN HOUR. */
const LANE_CADENCE: Record<string, number> = { rwa_depth: 86400 }

function lanePolicy(deps: CaptureDeps, feature: string): { enabled: boolean; cadenceSeconds: number } {
  const row = (deps.policy || []).find((r) => r?.feature === feature && (r.provider ?? CAPTURE_PROVIDER) === CAPTURE_PROVIDER)
  if (!row) return { enabled: true, cadenceSeconds: LANE_CADENCE[feature] ?? 3600 }
  const policy = schedulePolicy(deps.policy, feature)
  return { enabled: policy.enabled, cadenceSeconds: policy.cadenceSeconds }
}

const num = (v: unknown): number | null => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
/** A money figure the table will accept. A NEGATIVE liquidity, volume or market
 * value is not a small one: it is a reading nobody can act on, and the schema
 * refuses it outright, so it is treated as ABSENT rather than stored as a number
 * or allowed to fail the whole batch. Zero is a real answer and passes through. */
const money = (v: unknown): number | null => { const n = num(v); return n == null || n < 0 ? null : n }
const text = (v: unknown, max = 200): string | null => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null }
const providerId = (v: unknown): string | null => (/^[1-9][0-9]{0,11}$/.test(String(v ?? '')) ? String(v) : null)

/** Newest value of a timestamp column, or null when the table is empty or the
 * read failed. A failed read never blocks a capture: the write is idempotent. */
// deno-lint-ignore no-explicit-any
async function newestAt(db: any, table: string, column: string): Promise<number | null> {
  try {
    const { data, error } = await db.from(table).select(column).order(column, { ascending: false }).limit(1)
    if (error) return null
    const row = Array.isArray(data) ? data[0] : data
    const parsed = Date.parse(String(row?.[column] ?? ''))
    return Number.isFinite(parsed) ? parsed : null
  } catch { return null }
}

// deno-lint-ignore no-explicit-any
async function guardJob(db: any, job: string, feature: string, deps: CaptureDeps, now: Date,
  freshness: { table: string; column: string }): Promise<JobResult | null> {
  const policy = lanePolicy(deps, feature)
  if (!policy.enabled) return { job, rows: 0, credits: 0, skipped: 'policy_disabled' }
  const newest = await newestAt(db, freshness.table, freshness.column)
  if (newest != null && now.getTime() - newest < policy.cadenceSeconds * 1000 * CADENCE_GRACE) {
    return { job, rows: 0, credits: 0, skipped: 'within_cadence', newestAt: new Date(newest).toISOString() }
  }
  return null
}

function dedupe<T>(rows: T[], key: (row: T) => string): T[] {
  const byKey = new Map<string, T>()
  for (const row of rows) byKey.set(key(row), row)
  return [...byKey.values()]
}

// deno-lint-ignore no-explicit-any
async function upsert(db: any, table: string, rows: Record<string, unknown>[], onConflict: string): Promise<{ rows: number; error?: string }> {
  if (!rows.length) return { rows: 0 }
  let written = 0
  for (let start = 0; start < rows.length; start += MAX_UPSERT_ROWS) {
    const chunk = rows.slice(start, start + MAX_UPSERT_ROWS)
    try {
      const { error } = await db.from(table).upsert(chunk, { onConflict })
      if (error) return { rows: written, error: String(error.message || error).slice(0, 200) }
      written += chunk.length
    } catch (e) { return { rows: written, error: ((e as Error)?.message || 'write_failed').slice(0, 200) } }
  }
  return { rows: written }
}

const failed = (job: string, credits: number, e: unknown): JobResult =>
  ({ job, rows: 0, credits, error: ((e as Error)?.message || 'capture_failed').slice(0, 200) })

const callBudget = (ctx: MarketAssetsContext, ceiling: number): number => {
  const budget = Number(ctx?.maxCalls)
  return Math.max(0, Math.min(ceiling, Number.isFinite(budget) && budget >= 0 ? Math.trunc(budget) : ceiling))
}

// ─── Subjects ─────────────────────────────────────────────────────────────────

/** One RWA token this lane may read, before any deployment is known.
 *
 * `tokenKey` is the storage key. `cmc:<cryptoId>` whenever CoinMarketCap names
 * the token, which is what the asset page joins on; `contract:<chain>:<address>`
 * for a PINNED contract the alias map asserts an issuer for and that has no
 * CoinMarketCap catalogue row (checked 2026-09-20: USTB, BUIDL and OUSG have
 * none; USDY does). A pinned contract is still a tokenised asset a reader may
 * hold, so it is read rather than dropped for lacking a provider id. */
export interface DepthSubject {
  tokenKey: string
  cryptoId: string | null
  symbol: string | null
  tokenName: string | null
  rwaId: string | null
  rwaName: string | null
  assetType: string | null
  issuerName: string | null
  /** The RWA asset's tokenised market value from the RWA payload, in USD. It
   * describes the UNDERLYING asset's whole tokenised float, not this token. */
  underlyingValueUsd: number | null
  /** Pinned subjects are read first and are never crowded out by the top slice. */
  pinned: boolean
  /** A contract the alias map asserted, for a subject with no provider id. */
  pinnedChain?: string
  pinnedAddress?: string
}

/** The crypto ids the dated issuer reviews name. These are the tokens this
 * platform has already published reviewed issuer facts for, so a depth figure
 * for them lands beside an issuer the reader can already see. */
export function reviewedCryptoIds(): string[] {
  return [...new Set(ISSUER_REVIEW_SEED.map((review) => providerId(review.cryptoId)).filter((v): v is string => !!v))]
}

/** Token contracts the alias map asserts an issuer for, as `{chain, address}`.
 * Read from the map's own subject strings through `cmcDexIdentity`, so a subject
 * on a chain with no verified DEX evidence is simply not returned rather than
 * being reshaped into one. */
export function assertedTokenContracts(at: number): { chain: string; address: string; label: string }[] {
  const out: { chain: string; address: string; label: string }[] = []
  for (const assertion of currentAssertions(at)) {
    if (!assertion.subject.startsWith('token:')) continue
    const identity = cmcDexIdentity(assertion.subject.slice('token:'.length))
    if (!identity) continue
    out.push({ chain: identity.chain, address: identity.address, label: text(assertion.subjectLabel, 50) || identity.address })
  }
  return dedupe(out, (row) => `${row.chain}:${row.address}`)
}

/** Every RWA token in one `rwaList` page, with the asset it wraps.
 *
 * The tokenised market value is read exactly the way `rwaAggregate` reads it in
 * capture-jobs.ts, from the same candidate fields in the same order, so the two
 * lanes cannot disagree about what "tokenised value" means. A token with no
 * `crypto_id` is skipped: without a provider id it has no identity to join to. */
// deno-lint-ignore no-explicit-any
export function subjectsFromRwaPage(rows: any[], assetType: string): DepthSubject[] {
  const out: DepthSubject[] = []
  for (const row of rows) {
    const quote = row?.quote ?? {}
    const value = num(quote.tokenized_market_cap ?? row?.tokenized_market_cap ?? quote.total_market_value ?? row?.total_market_value ?? quote.market_cap ?? row?.market_cap)
    const rwaId = providerId(row?.rwa_id)
    for (const token of (Array.isArray(row?.tokens) ? row.tokens : []).slice(0, 500)) {
      const cryptoId = providerId(token?.crypto_id)
      if (!cryptoId) continue
      out.push({
        tokenKey: `cmc:${cryptoId}`, cryptoId,
        symbol: text(token?.symbol, 50), tokenName: text(token?.name, 200),
        rwaId, rwaName: text(row?.name, 200), assetType: text(assetType, 40),
        issuerName: text(token?.issuer_name, 200),
        underlyingValueUsd: value, pinned: false,
      })
    }
  }
  return out
}

/** The bounded subject set for one run, pinned subjects first.
 *
 * ORDER IS THE BUDGET. Pinned subjects (the alias map's asserted contracts and
 * the issuer reviews' tokens) come first and can never be pushed out by a large
 * wrapper that appeared today. Everything else is ordered by the tokenised value
 * of the asset it wraps, descending, because a thin pool under a large wrapper
 * is the finding this lane exists to surface. */
export function depthSubjects(discovered: DepthSubject[], pinned: DepthSubject[], limit = TOKENS_PER_RUN): DepthSubject[] {
  const reviewed = new Set(reviewedCryptoIds())
  // A discovered token the issuer reviews name is the SAME subject as its pin,
  // and the discovered row carries the underlying asset, so it is promoted in
  // place rather than duplicated.
  const promoted = discovered.map((row) => (row.cryptoId && reviewed.has(row.cryptoId) ? { ...row, pinned: true } : row))
  const merged = dedupe([...pinned, ...promoted], (row) => row.tokenKey)
    .map((row) => ({ ...row, pinned: row.pinned || !!(row.cryptoId && reviewed.has(row.cryptoId)) }))
  return merged
    .sort((a, b) => (a.pinned === b.pinned ? (b.underlyingValueUsd ?? -1) - (a.underlyingValueUsd ?? -1) : a.pinned ? -1 : 1)
      || String(a.tokenKey).localeCompare(String(b.tokenKey)))
    .slice(0, Math.max(0, Math.trunc(limit)))
}

// ─── Deployments ──────────────────────────────────────────────────────────────

/** One deployment row, as the table holds it. */
export interface DepthDeployment {
  tokenKey: string
  platformKey: string
  platformLabel: string | null
  chain: string | null
  contractAddress: string
  dexPlatform: string | null
  dexAddress: string | null
  source: 'catalogue_facts' | 'provider_info' | 'alias_map'
}

/** Whether a reported platform is one of the four chains CoinMarketCap publishes
 * DEX data for on this plan, and the canonical address for it.
 *
 * The platform SLUG or NAME is authoritative and `cmcDexIdentity` is the single
 * gate on the address, exactly as `listingDexIdentity` does it in
 * capture-listings.ts. A platform we do not recognise returns null: that is the
 * `chain_not_covered` case, and it is a coverage fact, never an error. */
export function readableDeployment(platformSlug: unknown, platformName: unknown, chain: unknown, address: unknown): { platform: string; address: string } | null {
  const raw = String(platformSlug ?? platformName ?? '').trim().toLowerCase().replace(/\s+/g, '-')
  const slug = raw === 'arbitrum-one' ? 'arbitrum' : raw
  // The app chain id written by `cmcDeployments` is the second candidate: a row
  // whose slug we do not know may still carry a chain the app defines.
  const network = CMC_DEX_NETWORKS.find((n) => n.platform === slug)
    ?? CMC_DEX_NETWORKS.find((n) => n.platform === String(chain ?? '').trim().toLowerCase())
    ?? CMC_DEX_NETWORKS.find((n) => n.chain === String(chain ?? '').trim().toLowerCase())
  if (!network) return null
  const identity = cmcDexIdentity(`${network.chain}:${String(address ?? '').trim()}`)
  return identity ? { platform: identity.platform, address: identity.address } : null
}

/** The deployments ALREADY STORED on a `market_assets.facts` row.
 *
 * `market_assets.facts.deployments` is the output of `cmcDeployments`, written by
 * the daily metadata pass (migration 20260915004720), so it is read as
 * `AssetDeployment[]` and NOT re-parsed: the raw `contract_address[]` array the
 * provider sent is not retained on that row. Verified against production on
 * 2026-09-20: PAXG, XAUT, XAUM, CGO and NVDAon all carry
 * `facts.deployments[{platformSlug, platformName, chain, address}]`. */
// deno-lint-ignore no-explicit-any
export function storedDeployments(facts: any): { platformSlug?: unknown; platformName?: unknown; chain?: unknown; address?: unknown }[] {
  return Array.isArray(facts?.deployments) ? facts.deployments.slice(0, 200) : []
}

/** The deployments of one token.
 *
 * `catalogue_facts` reads the stored `facts.deployments` array; every other
 * source is a raw `/v2/cryptocurrency/info` row, parsed with `cmcDeployments`,
 * which is the one parser for `contract_address[]` in this repository and is
 * reused rather than reimplemented so a change to how the platform reads a
 * deployment reaches this lane too. */
// deno-lint-ignore no-explicit-any
export function deploymentRows(tokenKey: string, facts: any, source: DepthDeployment['source']): DepthDeployment[] {
  const rows: DepthDeployment[] = []
  const entries = source === 'catalogue_facts' ? storedDeployments(facts) : cmcDeployments(facts)
  for (const entry of entries) {
    const address = text(entry.address, 240)
    if (!address) continue
    const platformKey = (text(entry.platformSlug, 120) ?? text(entry.platformName, 120) ?? text(entry.chain, 120) ?? 'unreported').toLowerCase()
    const readable = readableDeployment(entry.platformSlug, entry.platformName, entry.chain, address)
    rows.push({
      tokenKey, platformKey, platformLabel: text(entry.platformName, 120) ?? text(entry.platformSlug, 120),
      chain: text(entry.chain, 120),
      // VERBATIM. Only an address on a chain we can validate is canonicalised,
      // and that canonical form is kept separately in `dexAddress`.
      contractAddress: address,
      dexPlatform: readable?.platform ?? null, dexAddress: readable?.address ?? null, source,
    })
  }
  return dedupe(rows, (row) => `${row.platformKey}|${row.contractAddress}`)
}

// ─── Pools ────────────────────────────────────────────────────────────────────

export interface DepthPool {
  chain: string
  dex: string | null
  pair: string | null
  address: string
  liquidityUsd: number | null
  volume24h: number | null
}

/** The pools of one `/v1/dex/token/pools` response, in the reviewed field names.
 *
 * The pair label is built from the two token legs the response names, in the
 * order it names them. It is a LABEL: no side is asserted to be the base or the
 * quote, because the response does not say which is which. A leg with no symbol
 * leaves the label null rather than inventing a side. */
// deno-lint-ignore no-explicit-any
export function poolRows(payload: any, platform: string): DepthPool[] {
  const data = payload?.data ?? payload
  const rows = Array.isArray(data) ? data : []
  const out: DepthPool[] = []
  for (const row of rows.slice(0, POOL_PAGE_SIZE)) {
    const address = text(row?.addr, 200)
    if (!address) continue
    const legs = [text(row?.t0?.sym, 40), text(row?.t1?.sym, 40)]
    out.push({
      chain: platform, dex: text(row?.exn, 120),
      pair: legs.every((leg) => !!leg) ? legs.join(' / ') : null,
      address,
      liquidityUsd: money(cmcDexNumber(row?.liqUsd)), volume24h: money(cmcDexNumber(row?.v24)),
    })
  }
  return dedupe(out, (row) => `${row.chain}|${row.address}`)
}

/** The depth reading over every pool found for one token, across its chains.
 *
 * Only the provider's own figures are summarised here. A pool whose liquidity
 * the provider did not report is COUNTED (it exists) but contributes nothing to
 * the total, and `liquidityPools` says how many of the pools the total was
 * actually built from — a total over 2 of 9 pools is not the token's liquidity
 * and the read view says so rather than quietly presenting it as one. */
export function depthReading(pools: DepthPool[]): {
  poolCount: number; liquidityPools: number
  totalLiquidityUsd: number | null; totalVolume24h: number | null; deepest: DepthPool | null
} {
  const priced = pools.filter((pool) => pool.liquidityUsd != null)
  const volumed = pools.filter((pool) => pool.volume24h != null)
  const deepest = priced.length
    ? priced.reduce((best, pool) => ((pool.liquidityUsd as number) > (best.liquidityUsd as number) ? pool : best))
    : null
  return {
    poolCount: pools.length, liquidityPools: priced.length,
    totalLiquidityUsd: priced.length ? priced.reduce((sum, pool) => sum + (pool.liquidityUsd as number), 0) : null,
    totalVolume24h: volumed.length ? volumed.reduce((sum, pool) => sum + (pool.volume24h as number), 0) : null,
    deepest,
  }
}

/** Which of the seven states one token's reading is in.
 *
 * The order below is the order of the tests, and it is the honesty mechanism:
 *   1. pools_read             a pool was found, so there is a depth figure.
 *   2. no_deployment_known    no contract at all was resolved for it.
 *   3. chain_not_covered      deployments exist, none on a chain we can read.
 *   4. budget_deferred        readable chains exist, the run could not reach
 *                             them. Pending, never "thin".
 *   5. provider_unavailable   every pool call for this token failed. Unknown.
 *   6. issuer_redemption_only read the chains, found nothing, and the verified
 *                             contract source shows permissioned transfers.
 *   7. no_pool_on_read_chains read the chains and found nothing, with no such
 *                             evidence. This is the only state that is a
 *                             liquidity finding, and it names its chains.
 */
export function depthState(input: {
  pools: number; readChains: number; deployments: number; attempted: number; failed: number; restricted: boolean
}): string {
  if (input.pools > 0) return 'pools_read'
  if (!input.deployments) return 'no_deployment_known'
  if (!input.readChains) return 'chain_not_covered'
  if (!input.attempted) return 'budget_deferred'
  if (input.failed >= input.attempted) return 'provider_unavailable'
  if (input.restricted) return 'issuer_redemption_only'
  return 'no_pool_on_read_chains'
}

// ─── The lane ─────────────────────────────────────────────────────────────────

const RESTRICTION_COLUMNS = 'chain,contract_address,state,kyc_gated,source_url'

/** Tokenised-asset depth capture.
 *
 * `dexPools` and `dexHolderCount` are Startup capabilities. Below Startup the
 * lane is skipped with `plan_below_startup` and never spends a call to discover
 * that, exactly the way `capture-listings.ts` handles `newListings`. */
// deno-lint-ignore no-explicit-any
export async function captureRwaDepth(db: any, ctxFor: (name: string, maxCalls: number) => MarketAssetsContext,
  now = new Date(), plan = 'basic', deps: CaptureDeps): Promise<JobResult> {
  const job = 'rwa_depth'
  let credits = 0
  try {
    if (!planAllows(plan, 'startup')) return { job, rows: 0, credits: 0, skipped: 'plan_below_startup' }
    const skip = await guardJob(db, job, 'rwa_depth', deps, now, { table: DEPTH_TABLE, column: 'captured_at' })
    if (skip) return skip
    const ceiling = RWA_ASSET_TYPES.length + 1 + POOL_CALLS_PER_RUN + HOLDER_CALLS_PER_RUN
    const ctx = ctxFor('rwa-depth', ceiling)
    const budget = callBudget(ctx, ceiling)
    if (budget < 1) return { job, rows: 0, credits: 0, skipped: 'call_budget' }
    const capturedAt = new Date(now instanceof Date ? now.getTime() : now).toISOString()
    const snapshotDate = utcDate(now)
    let calls = 0, reason: string | null = null

    // ── 1. The RWA universe. Same params as the hourly `rwa` lane, so the
    // shared transport answers from its cache for 0 credits inside the hour.
    const discovered: DepthSubject[] = []
    for (const assetType of RWA_ASSET_TYPES) {
      if (calls >= budget) { reason = reason || 'call_budget'; break }
      calls += 1
      credits += estimateCmcCredits('rwaList', { limit: '250' })
      const page = await deps.request('rwaList', { asset_type: assetType, limit: 250, start: 1 }, ctx).catch(() => null)
      if (!page?.payload) { reason = reason || text(page?.reason, 60) || 'provider_unavailable'; continue }
      discovered.push(...subjectsFromRwaPage(cmcRows('rwaList', page.payload).rows, assetType))
    }

    // ── 2. Pinned contracts from the alias map, for subjects CoinMarketCap has
    // no catalogue row for. They are read by contract, not by provider id.
    const asserted = assertedTokenContracts(now.getTime())
    const knownAddresses = new Set<string>()
    const pinned: DepthSubject[] = []

    // Deployments already stored by the daily metadata pass. Zero credits.
    const cryptoIds = [...new Set(discovered.map((row) => row.cryptoId).filter((v): v is string => !!v))]
    const catalogue = new Map<string, { facts: unknown; marketCap: number | null; symbol: string | null; name: string | null }>()
    if (cryptoIds.length) {
      try {
        const { data, error } = await db.from('market_assets').select('provider_id,symbol,name,market_cap,facts')
          .eq('source_provider', CAPTURE_PROVIDER).in('provider_id', cryptoIds.slice(0, 500)).limit(500)
        if (error) reason = reason || String(error.message || error).slice(0, 200)
        for (const row of (data || []) as Record<string, unknown>[]) {
          const id = text(row.provider_id, 40)
          if (id) catalogue.set(id, { facts: row.facts, marketCap: num(row.market_cap), symbol: text(row.symbol, 50), name: text(row.name, 200) })
        }
      } catch (e) { reason = reason || ((e as Error)?.message || 'catalogue_read_failed').slice(0, 200) }
    }
    for (const entry of catalogue.values()) {
      for (const deployment of storedDeployments(entry.facts)) knownAddresses.add(String(deployment.address ?? '').toLowerCase())
    }
    for (const contract of asserted) {
      // A pinned contract the catalogue already carries is the SAME token as its
      // CoinMarketCap row and is read through that row; only a contract with no
      // catalogue row becomes a subject of its own.
      if (knownAddresses.has(contract.address.toLowerCase())) continue
      pinned.push({
        tokenKey: `contract:${contract.chain}:${contract.address}`, cryptoId: null,
        symbol: contract.label, tokenName: null, rwaId: null, rwaName: null, assetType: null, issuerName: null,
        underlyingValueUsd: null, pinned: true, pinnedChain: contract.chain, pinnedAddress: contract.address,
      })
    }

    const subjects = depthSubjects(discovered, pinned)
    if (!subjects.length) return { job, rows: 0, credits, snapshotDate, calls, skipped: 'no_rwa_tokens', ...(reason ? { partial: reason } : {}) }

    // ── 3. Deployments. Catalogue first, then ONE bounded metadata call for the
    // tokens still missing one.
    const deployments = new Map<string, DepthDeployment[]>()
    for (const subject of subjects) {
      if (subject.pinnedChain && subject.pinnedAddress) {
        const readable = cmcDexIdentity(`${subject.pinnedChain}:${subject.pinnedAddress}`)
        deployments.set(subject.tokenKey, [{
          tokenKey: subject.tokenKey, platformKey: readable?.platform ?? subject.pinnedChain,
          platformLabel: readable?.label ?? null, chain: readable?.platform ?? null,
          contractAddress: subject.pinnedAddress, dexPlatform: readable?.platform ?? null,
          dexAddress: readable?.address ?? null, source: 'alias_map',
        }])
        continue
      }
      const entry = subject.cryptoId ? catalogue.get(subject.cryptoId) : null
      const rows = entry ? deploymentRows(subject.tokenKey, entry.facts, 'catalogue_facts') : []
      if (rows.length) deployments.set(subject.tokenKey, rows)
    }
    const missing = subjects.filter((row) => row.cryptoId && !deployments.has(row.tokenKey)).map((row) => row.cryptoId as string)
    if (missing.length && calls < budget) {
      calls += 1
      const ids = missing.slice(0, METADATA_IDS_PER_CALL)
      credits += estimateCmcCredits('metadata', { id: ids.join(',') })
      const info = await deps.request('metadata', { id: ids.join(',') }, ctx).catch(() => null)
      if (!info?.payload) reason = reason || text(info?.reason, 60) || 'metadata_unavailable'
      else {
        for (const row of cmcRows('metadata', info.payload).rows) {
          const id = providerId(row?.id)
          if (!id) continue
          const rows = deploymentRows(`cmc:${id}`, row, 'provider_info')
          if (rows.length) deployments.set(`cmc:${id}`, rows)
        }
      }
    }

    // ── 4. Transfer restrictions already read from verified contract source, so
    // "no pool" can be explained rather than merely reported. Zero credits.
    const restricted = new Set<string>()
    const restrictionRows = new Map<string, { state: string | null; kyc: boolean | null; sourceUrl: string | null }>()
    const readableAddresses = [...new Set([...deployments.values()].flat()
      .map((row) => row.dexAddress).filter((v): v is string => !!v && v.startsWith('0x')))]
    if (readableAddresses.length) {
      try {
        const { data, error } = await db.from('intel_rwa_token_restrictions').select(RESTRICTION_COLUMNS)
          .in('contract_address', readableAddresses.slice(0, 300)).limit(300)
        if (error) reason = reason || String(error.message || error).slice(0, 200)
        for (const row of (data || []) as Record<string, unknown>[]) {
          const address = text(row.contract_address, 200)
          if (!address) continue
          restrictionRows.set(address.toLowerCase(), {
            state: text(row.state, 40), kyc: row.kyc_gated === true ? true : row.kyc_gated === false ? false : null,
            sourceUrl: text(row.source_url, 500),
          })
          if (row.state === 'restricted' || row.kyc_gated === true) restricted.add(address.toLowerCase())
        }
      } catch (e) { reason = reason || ((e as Error)?.message || 'restriction_read_failed').slice(0, 200) }
    }

    // ── 5. Today's rows already captured. A token whose depth was read today
    // AND whose deployment set is unchanged is skipped, so a retried or resumed
    // run walks forward through the subject set instead of paying twice.
    const readToday = new Set<string>()
    try {
      const { data } = await db.from(DEPTH_TABLE).select('token_key,depth_state,deployment_digest')
        .eq('provider', CAPTURE_PROVIDER).eq('snapshot_date', snapshotDate).limit(1000)
      for (const row of (data || []) as Record<string, unknown>[]) {
        const key = text(row.token_key, 200)
        if (!key || row.depth_state === 'budget_deferred') continue
        if (text(row.deployment_digest, 200) === deploymentDigest(deployments.get(key) || [])) readToday.add(key)
      }
    } catch { /* an unreadable prior run only means this one does the work again */ }

    // ── 6. Pools per readable deployment, then holder counts.
    const pools = new Map<string, DepthPool[]>()
    const attempts = new Map<string, { attempted: number; failed: number }>()
    let poolCalls = 0
    for (const subject of subjects) {
      if (readToday.has(subject.tokenKey)) continue
      for (const deployment of (deployments.get(subject.tokenKey) || [])) {
        if (!deployment.dexPlatform || !deployment.dexAddress) continue
        if (poolCalls >= POOL_CALLS_PER_RUN || calls >= budget) { reason = reason || 'call_budget'; break }
        poolCalls += 1; calls += 1
        credits += estimateCmcCredits('dexPools', {})
        const attempt = attempts.get(subject.tokenKey) || { attempted: 0, failed: 0 }
        attempt.attempted += 1
        const page = await deps.request('dexPools', { platform: deployment.dexPlatform, address: deployment.dexAddress, size: POOL_PAGE_SIZE }, ctx).catch(() => null)
        if (!page?.payload) {
          attempt.failed += 1
          reason = reason || text(page?.reason, 60) || 'provider_unavailable'
        } else {
          pools.set(subject.tokenKey, [...(pools.get(subject.tokenKey) || []), ...poolRows(page.payload, deployment.dexPlatform)])
        }
        attempts.set(subject.tokenKey, attempt)
      }
      if (poolCalls >= POOL_CALLS_PER_RUN || calls >= budget) break
    }

    // Holder count on the DEEPEST chain of the deepest tokens. A second credit
    // on a deployment already paid for, so it is spent where the reading matters.
    const holders = new Map<string, { count: number; chain: string }>()
    const ranked = [...pools.entries()]
      .map(([tokenKey, list]) => ({ tokenKey, reading: depthReading(list) }))
      .filter((row) => !!row.reading.deepest)
      .sort((a, b) => (b.reading.totalLiquidityUsd ?? 0) - (a.reading.totalLiquidityUsd ?? 0))
      .slice(0, HOLDER_CALLS_PER_RUN)
    for (const row of ranked) {
      if (calls >= budget) { reason = reason || 'call_budget'; break }
      const chain = row.reading.deepest?.chain
      const deployment = (deployments.get(row.tokenKey) || []).find((d) => d.dexPlatform === chain)
      if (!deployment?.dexAddress || !deployment.dexPlatform) continue
      calls += 1
      credits += estimateCmcCredits('dexHolderCount', {})
      const count = await deps.request('dexHolderCount', { platform: deployment.dexPlatform, tokenAddress: deployment.dexAddress }, ctx).catch(() => null)
      if (!count?.payload) { reason = reason || text(count?.reason, 60) || 'provider_unavailable'; continue }
      const data = count.payload?.data ?? count.payload
      // A holder count we could not read stays absent. Zero is a real answer.
      const value = cmcDexInteger((Array.isArray(data) ? data[0] : data)?.count)
      if (value != null) holders.set(row.tokenKey, { count: value, chain: deployment.dexPlatform })
    }

    // ── 7. Write. Deployments first: a depth row that says "chain not covered"
    // is only readable beside the chains it is talking about.
    const deploymentWrite = [...deployments.values()].flat().map((row) => ({
      provider: CAPTURE_PROVIDER, token_key: row.tokenKey, platform_key: row.platformKey,
      platform_label: row.platformLabel, chain: row.chain, contract_address: row.contractAddress,
      dex_platform: row.dexPlatform, dex_address: row.dexAddress, readable: !!row.dexPlatform,
      source: row.source, captured_at: capturedAt,
    }))
    const wroteDeployments = await upsert(db, DEPLOYMENT_TABLE, deploymentWrite, 'provider,token_key,platform_key,contract_address')
    if (wroteDeployments.error) reason = reason || wroteDeployments.error

    const depthWrite = subjects.filter((subject) => !readToday.has(subject.tokenKey)).map((subject) => {
      const list = (pools.get(subject.tokenKey) || []).slice(0, POOLS_PER_TOKEN)
      const reading = depthReading(list)
      const own = deployments.get(subject.tokenKey) || []
      const readable = own.filter((row) => !!row.dexPlatform)
      const attempt = attempts.get(subject.tokenKey) || { attempted: 0, failed: 0 }
      const restrictionKey = readable.map((row) => row.dexAddress?.toLowerCase()).find((address) => address && restricted.has(address)) ?? null
      const restriction = restrictionKey ? restrictionRows.get(restrictionKey) ?? null : null
      const state = depthState({
        pools: reading.poolCount, readChains: readable.length, deployments: own.length,
        attempted: attempt.attempted, failed: attempt.failed, restricted: !!restrictionKey,
      })
      const holder = holders.get(subject.tokenKey) ?? null
      const entry = subject.cryptoId ? catalogue.get(subject.cryptoId) ?? null : null
      return {
        provider: CAPTURE_PROVIDER, token_key: subject.tokenKey, snapshot_date: snapshotDate, captured_at: capturedAt,
        crypto_id: subject.cryptoId, symbol: subject.symbol ?? entry?.symbol ?? null,
        token_name: subject.tokenName ?? entry?.name ?? null,
        rwa_id: subject.rwaId, rwa_name: subject.rwaName, asset_type: subject.assetType, issuer_name: subject.issuerName,
        // TWO different sizes, stored apart. `underlying_value_usd` is the whole
        // tokenised float of the asset this token wraps, from the RWA payload;
        // `token_market_cap` is THIS token's market cap from our own catalogue.
        // Dividing one by the other would be a number neither source reported.
        underlying_value_usd: money(subject.underlyingValueUsd), token_market_cap: money(entry?.marketCap),
        depth_state: state,
        chains_deployed: own.map((row) => row.platformLabel ?? row.platformKey),
        chains_read: [...new Set(readable.map((row) => row.dexPlatform as string))],
        chains_not_covered: own.filter((row) => !row.dexPlatform).map((row) => row.platformLabel ?? row.platformKey),
        pool_count: attempt.attempted ? reading.poolCount : null,
        liquidity_pools: attempt.attempted ? reading.liquidityPools : null,
        total_liquidity_usd: reading.totalLiquidityUsd, total_volume_24h_usd: reading.totalVolume24h,
        deepest_pool_address: reading.deepest?.address ?? null, deepest_pool_dex: reading.deepest?.dex ?? null,
        deepest_pool_chain: reading.deepest?.chain ?? null, deepest_pool_pair: reading.deepest?.pair ?? null,
        deepest_liquidity_usd: reading.deepest?.liquidityUsd ?? null, deepest_volume_24h_usd: reading.deepest?.volume24h ?? null,
        holder_count: holder?.count ?? null, holder_chain: holder?.chain ?? null,
        restriction_state: restriction?.state ?? null, restriction_kyc_gated: restriction?.kyc ?? null,
        restriction_source_url: restriction?.sourceUrl ?? null,
        pools: list,
        deployment_digest: deploymentDigest(own),
        scope: state === 'issuer_redemption_only' ? `${REDEMPTION_SCOPE} ${DEPTH_SCOPE}` : DEPTH_SCOPE,
      }
    })
    const written = await upsert(db, DEPTH_TABLE, dedupe(depthWrite, (row) => String(row.token_key)), 'provider,token_key,snapshot_date')

    return {
      job, rows: written.rows, credits, snapshotDate, capturedAt, calls,
      subjects: subjects.length, deployments: deploymentWrite.length, deploymentRows: wroteDeployments.rows,
      poolCalls, withPools: [...pools.keys()].length, holderCounts: holders.size, skippedToday: readToday.size,
      ...(reason ? { partial: reason } : {}), ...(written.error ? { error: written.error } : {}),
    }
  } catch (e) { return failed(job, credits, e) }
}

/** A stable fingerprint of one token's deployment set. It is what "the
 * deployments are unchanged" means: a token whose chains or contracts moved is
 * re-read even inside the cadence, because the old depth reading no longer
 * describes the same set of places the token lives. */
export function deploymentDigest(rows: DepthDeployment[]): string {
  return rows.map((row) => `${row.platformKey}|${row.contractAddress.toLowerCase()}`).sort().join(';').slice(0, 200)
}

/** Integration surface. The `intel-capture` Edge Function maps an op name onto
 * this, alongside the other lanes. */
export const RWA_DEPTH_CAPTURE_OPS: Record<string, (
  // deno-lint-ignore no-explicit-any
  admin: any, ctxFor: (name: string, maxCalls: number) => MarketAssetsContext, now: Date, plan: string, deps: CaptureDeps
) => Promise<JobResult>> = {
  rwa_depth: (admin, ctxFor, now, plan, deps) => captureRwaDepth(admin, ctxFor, now, plan, deps),
}
