// Investor Intel — launchpad stage capture lane (CoinGecko onchain / GeckoTerminal).
//
// WHY THIS EXISTS. `/intel/graduation` has exactly one source today, the
// CoinMarketCap `meme_stages` lane, and on this account `/v1/dex/meme/list`
// answers 200, one credit and three EMPTY arrays every hour (three separate
// corrections to that request are recorded in `capture-meme.ts`; the tables were
// still at 0 rows on 2026-09-17). This lane fills the SAME two tables from real
// launchpads through CoinGecko's onchain API. It does not touch the CMC lane,
// its request, its policy row or its cron job.
//
// WHAT ONE RUN DOES, in order, all of it bounded by ONE shared call counter:
//   1. VERIFIES the dex registry of each network (`networks/{net}/dexes`, cached
//      24 h). A pad id this platform believes in is written into a row only if
//      the registry ANSWERED and NAMED it. A network whose registry could not be
//      read this run writes nothing at all and says so.
//   2. Reads new pools per network — `pools/megafilter` once when a paid key is
//      configured and it is entitled, otherwise `networks/{net}/new_pools` paged
//      — and keeps only the pools whose dex is a confirmed pad or a confirmed
//      graduation destination.
//   3. Re-polls the newest contracts we already track per pad that have not
//      completed yet, so a GRADUATION is observed. This step is not optional:
//      a graduated token LEAVES the pad's new_pools feed, so a lane that only
//      read new_pools would watch every cohort vanish and would report a
//      graduation rate of zero forever.
//   4. Batches every address through `networks/{net}/tokens/multi/<=30 addresses>`
//      for the bonding-curve facts, classifies the stage, and upserts snapshots
//      and transitions with the same first_seen_at carry-forward and the same
//      "a transition always moves" rule the CMC lane uses. The helpers are
//      IMPORTED from `capture-meme.ts` (`priorSnapshots`, `upsert`, `dedupe`,
//      `hoursBetween`), not copied.
//
// HONESTY RULES this lane keeps (the same ones the tables were built on):
//   * The source publishes no clock for a discovery list. `captured_at` is OUR
//     capture time floored to the hour.
//   * `first_seen_at` is the first hour WE saw the contract in any stage, from
//     EITHER lane. It is never a deployment time and never a pool creation time.
//   * `completed_at` is the SOURCE's graduation time. A graduation we observed
//     whose time the source did not publish keeps NULL. We never substitute our
//     own clock for it.
//   * `graduation_pct` is stored as published, including the small NEGATIVE
//     values pump-fun publishes at the very start of a curve (verified -4.8 on
//     2026-09-17). A value outside -100..100 is stored as NULL and counted on the
//     run line as `graduationPctOutOfBand`; it is never clamped into range.
//   * A contract another lane already wrote for THIS hour is not overwritten.
//     The primary key is (chain, contract_address, captured_at) with `source`
//     naming the first writer, so this lane MERGES: it fills only the fields
//     that are still NULL and leaves stage, price, market cap and source alone.
//     It writes no transition for such a contract either — the stage is not ours
//     to move.
//   * An empty answer is a result. Nothing is written, one `intel_launchpad_capture`
//     line still names every network and every pad with its row count and reason.
//
// NOTHING HERE HOLDS A KEY. The transport is `fetchCoingeckoOnchain` in
// `../market-assets/coingecko-provider.ts`, which picks the pro, demo or public
// host, attaches the key header, and logs a `provider_call_logs` receipt through
// `marketAssetsGet`. It is injected as `deps.onchain` so this module tests
// without a network.
//
// LICENSING. CoinGecko's paid terms permit charging for a product that
// integrates the API, forbid redistributing API access, require a visible
// "Powered by CoinGecko" attribution where the data is shown, and require cached
// values to be refreshed within 24 hours. This lane stores OUR hourly
// observations as derived history, exposes no raw feed, runs hourly (well inside
// the 24-hour rule), and the read half hands the page the attribution object it
// must render.

import { hourBucket } from './capture-jobs.ts'
import type { CaptureDeps, JobResult, SchedulePolicyRow } from './capture-jobs.ts'
import { dedupe, hoursBetween, priorSnapshots, upsert, MEME_STAGES } from './capture-meme.ts'
import type { MemeStage } from './capture-meme.ts'
import { coingeckoOnchainTier, fetchCoingeckoOnchain } from '../market-assets/coingecko-provider.ts'
import type { MarketAssetsContext } from '../market-assets/types.ts'
import { GRADUATION_NEAR_PCT, LAUNCHPAD_NETWORKS, LAUNCHPAD_PADS, LAUNCHPAD_REJECTED, PAD_LABELS } from './launchpad-registry.ts'
import type { LaunchpadNetwork, LaunchpadPad } from './launchpad-registry.ts'

export const LAUNCHPAD_JOB = 'launchpad_stages'
/** `provider_schedule_policy.provider` for this lane's row. NOT 'coinmarketcap':
 * the CMC plan and credit line say nothing about a CoinGecko key. */
export const LAUNCHPAD_POLICY_PROVIDER = 'coingecko'
/** The value written into `source` on every row this lane owns. */
export const LAUNCHPAD_SOURCE = 'coingecko'

// The registry of networks, launchpads and human labels lives in
// `launchpad-registry.ts` so the READ half can use the labels without pulling
// this module's transport, HTTP client and key handling into its graph. It is
// re-exported here so a caller that already imports the lane keeps working.
export { LAUNCHPAD_NETWORKS, LAUNCHPAD_PADS, LAUNCHPAD_REJECTED, PAD_LABELS, GRADUATION_NEAR_PCT }
export type { LaunchpadNetwork, LaunchpadPad }

// ─── Bounds ──────────────────────────────────────────────────────────────────
/** Per-run call ceiling when the policy row carries no `max_credits`. Also the
 * value the migration seeds into that column. */
export const LAUNCHPAD_MAX_CALLS = 40
/** Keyless, every call shares a 30-requests-a-minute public allowance with
 * everything else on this egress, so the ceiling is lower AND paced. */
export const KEYLESS_MAX_CALLS = 24
export const KEYLESS_SPACING_MS = 2100
/** Dex registry pages read per network. Verified 2026-09-17: solana 1 page (33
 * ids, page 2 answers 400), bsc 2, base 2, robinhood 1. */
export const REGISTRY_PAGES = 3
/** Cached for a day: a launchpad is not listed and delisted inside an hour, and
 * a fresh registry read every hour would spend a third of the run's budget on a
 * list that does not move. */
export const REGISTRY_TTL_MS = 24 * 3600_000
/** new_pools pages per network. The ceiling is the documented maximum; the
 * default is what one run actually asks for. */
export const NEW_POOL_PAGE_CEILING = 5
export const NEW_POOL_PAGES = 3
/** The source's own batch size for `tokens/multi`. */
export const TOKENS_PER_CALL = 30
/** Newest tracked, not-yet-completed contracts re-polled per pad. */
export const TRACKED_PER_PAD = 60
/** and the ceiling across all pads, so a growing pad list cannot grow the run. */
export const TRACKED_ADDRESS_CEILING = 240
/** Snapshot rows scanned to find them. */
export const TRACKED_ROW_CAP = 4000
/** How far back a contract is still worth re-polling. A pad token that has not
 * completed in a week is not going to. */
export const TRACKED_WINDOW_HOURS = 168
/** Stop STARTING calls this far into the invocation. The Edge Function's own
 * budget is 100 s and the cron post allows 110 s. */
export const RUN_BUDGET_MS = 80_000
/** Bound on the same-hour merge read and on one upsert batch. */
const SAME_HOUR_CAP = 2000

const CADENCE_GRACE = 0.9
const LANE_CADENCE_SECONDS = 3600

// ─── Small pure helpers ──────────────────────────────────────────────────────

const text = (v: unknown, max = 200): string | null => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null }
const num = (v: unknown): number | null => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const iso = (v: unknown): string | null => { const t = Date.parse(String(v ?? '')); return Number.isFinite(t) ? new Date(t).toISOString() : null }

export function chunk<T>(rows: readonly T[], size: number): T[][] {
  const out: T[][] = []
  const step = Math.max(1, Math.trunc(size))
  for (let i = 0; i < rows.length; i += step) out.push(rows.slice(i, i + step))
  return out
}

/** The SAME shapes the table CHECKs enforce. An address this refuses is dropped,
 * never repaired: a row the database would reject is a row we do not have. */
const ADDRESS_SHAPES: Record<string, RegExp> = {
  evm: /^0x[0-9a-f]{40}$/,
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
}
export function normalizeAddress(kind: 'evm' | 'solana', raw: unknown): string | null {
  const value = String(raw ?? '').trim()
  if (!value) return null
  const candidate = kind === 'evm' ? value.toLowerCase() : value
  return ADDRESS_SHAPES[kind].test(candidate) ? candidate : null
}

/** `relationships.base_token.data.id` is `<network>_<address>`; the network
 * prefix is stripped against the network we asked for, so a row from a network
 * we did not ask about cannot be filed under one we did. */
export function splitTokenId(network: string, id: unknown): string | null {
  const value = String(id ?? '').trim()
  const prefix = `${network}_`
  return value.startsWith(prefix) ? value.slice(prefix.length) : null
}

export interface LaunchpadDetails {
  graduationPct: number | null
  completed: boolean | null
  completedAt: string | null
  migrationPool: string | null
  /** true when the published percentage was outside -100..100 and was therefore
   * dropped rather than clamped. */
  outOfBand: boolean
}

/** `attributes.launchpad_details`, read without repair. A token with no
 * launchpad_details at all (a pad with no bonding curve) yields every field
 * null and `completed: null` — which is "no curve was published", not "it did
 * not complete". */
export function readLaunchpadDetails(raw: unknown): LaunchpadDetails {
  const d = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const pctRaw = num(d.graduation_percentage)
  const outOfBand = pctRaw != null && (pctRaw < -100 || pctRaw > 100)
  return {
    graduationPct: outOfBand ? null : pctRaw,
    completed: typeof d.completed === 'boolean' ? d.completed : null,
    completedAt: iso(d.completed_at),
    migrationPool: text(d.migrated_destination_pool_address, 120),
    outOfBand,
  }
}

/**
 * The three stage rules, and nothing else:
 *
 *   graduates       `completed` is true. Also: the token was found on a
 *                   CONFIRMED graduation destination AMM and we already track
 *                   it (`onDestination`) — a pad's feed drops a token the moment
 *                   it migrates, so the destination sighting IS the evidence.
 *   aboutGraduates  not completed, and the published percentage is >= 80.
 *   newCreations    everything else, INCLUDING a null percentage. A pad with no
 *                   bonding curve publishes none, and "we do not know how far
 *                   along it is" is a new creation, never a near-graduate.
 */
export function classifyStage(details: LaunchpadDetails, onDestination = false): MemeStage {
  if (details.completed === true) return 'graduates'
  if (onDestination) return 'graduates'
  if (details.graduationPct != null && details.graduationPct >= GRADUATION_NEAR_PCT) return 'aboutGraduates'
  return 'newCreations'
}

// ─── Response readers ────────────────────────────────────────────────────────

/** Ids named by one page of `networks/{network}/dexes`. An unreadable page
 * yields an empty set, and the caller treats "registry did not answer" as a
 * refusal to write, never as "no pads exist". */
// deno-lint-ignore no-explicit-any
export function dexIdsFrom(payload: any): string[] {
  const rows = Array.isArray(payload?.data) ? payload.data : []
  const ids: string[] = []
  for (const row of rows) { const id = text(row?.id, 120); if (id) ids.push(id) }
  return ids
}

export interface LaunchpadPool {
  poolAddress: string | null
  dex: string
  tokenAddress: string
  createdAt: string | null
  priceUsd: number | null
  marketCap: number | null
  fdv: number | null
}

/** One `new_pools` (or `megafilter`) page → the pools whose dex is one of
 * `allowed` and whose base token address is a shape the tables accept. A pool on
 * any other dex is DROPPED, never attributed to a pad it did not name. */
// deno-lint-ignore no-explicit-any
export function poolsFrom(payload: any, network: LaunchpadNetwork, allowed: ReadonlySet<string>): { pools: LaunchpadPool[]; dropped: number } {
  const rows = Array.isArray(payload?.data) ? payload.data : []
  const pools: LaunchpadPool[] = []
  let dropped = 0
  for (const row of rows) {
    const dex = text(row?.relationships?.dex?.data?.id, 120)
    if (!dex || !allowed.has(dex)) { dropped += 1; continue }
    const rawAddress = splitTokenId(network.network, row?.relationships?.base_token?.data?.id)
    const tokenAddress = normalizeAddress(network.address, rawAddress)
    if (!tokenAddress) { dropped += 1; continue }
    const a = row?.attributes ?? {}
    pools.push({
      poolAddress: text(a.address, 120),
      dex,
      tokenAddress,
      createdAt: iso(a.pool_created_at),
      priceUsd: num(a.base_token_price_usd),
      marketCap: num(a.market_cap_usd),
      fdv: num(a.fdv_usd),
    })
  }
  return { pools, dropped }
}

export interface LaunchpadToken {
  address: string
  name: string | null
  symbol: string | null
  priceUsd: number | null
  marketCap: number | null
  fdv: number | null
  details: LaunchpadDetails
}

/** One `tokens/multi` answer → one entry per token whose address is a shape the
 * tables accept. */
// deno-lint-ignore no-explicit-any
export function tokensFrom(payload: any, network: LaunchpadNetwork): { tokens: LaunchpadToken[]; dropped: number } {
  const rows = Array.isArray(payload?.data) ? payload.data : []
  const tokens: LaunchpadToken[] = []
  let dropped = 0
  for (const row of rows) {
    const a = row?.attributes ?? {}
    const address = normalizeAddress(network.address, a.address)
    if (!address) { dropped += 1; continue }
    tokens.push({
      address,
      name: text(a.name, 200),
      symbol: text(a.symbol, 50),
      priceUsd: num(a.price_usd),
      marketCap: num(a.market_cap_usd),
      fdv: num(a.fdv_usd),
      details: readLaunchpadDetails(a.launchpad_details),
    })
  }
  return { tokens, dropped }
}

// ─── Transport surface ───────────────────────────────────────────────────────

export interface OnchainRequestOpts { endpoint: string; cacheKey: string; ttlMs?: number; ctx?: MarketAssetsContext }
// deno-lint-ignore no-explicit-any
export type OnchainRequest = (path: string, opts: OnchainRequestOpts) => Promise<any>

export interface LaunchpadDeps extends CaptureDeps {
  /** Defaults to `fetchCoingeckoOnchain`, which owns the key and writes the
   * `provider_call_logs` receipt. Injected in tests. */
  onchain?: OnchainRequest
  /** Defaults to `coingeckoOnchainTier()`. */
  tier?: 'pro' | 'demo' | 'geckoterminal'
  /** Injected so tests do not wait out the keyless pacing. */
  sleep?: (ms: number) => Promise<void>
  /** Injected so a test can pin the wall clock the run budget is measured on. */
  clock?: () => number
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// ─── Policy ──────────────────────────────────────────────────────────────────

/**
 * This lane's own `provider_schedule_policy` row.
 *
 * `loadSchedulePolicy` in capture-jobs.ts filters on provider 'coinmarketcap',
 * so a 'coingecko' row never reaches `deps.policy` and every keyless lane in
 * this tree silently runs as if its row said `enabled = true`. This lane reads
 * its own row instead, so DISABLING IT IN THE DATABASE ACTUALLY DISABLES IT.
 * An unreadable table is not a reason to stop capturing: the documented
 * defaults stand and the run says `policyUnavailable`.
 */
// deno-lint-ignore no-explicit-any
export async function loadLaunchpadPolicy(db: any): Promise<{ rows: SchedulePolicyRow[]; reason: string | null }> {
  try {
    const { data, error } = await db.from('provider_schedule_policy')
      .select('provider,feature,cadence_seconds,enabled,min_plan,max_credits')
      .eq('provider', LAUNCHPAD_POLICY_PROVIDER).limit(50)
    if (error) return { rows: [], reason: String(error.message || error).slice(0, 200) }
    return { rows: Array.isArray(data) ? data as SchedulePolicyRow[] : [], reason: null }
  } catch (e) { return { rows: [], reason: ((e as Error)?.message || 'policy_read_failed').slice(0, 200) } }
}

export function launchpadPolicy(rows: SchedulePolicyRow[] | undefined): { enabled: boolean; cadenceSeconds: number; maxCalls: number } {
  const row = (rows || []).find((r) => r?.feature === LAUNCHPAD_JOB && r.provider === LAUNCHPAD_POLICY_PROVIDER)
  if (!row) return { enabled: true, cadenceSeconds: LANE_CADENCE_SECONDS, maxCalls: LAUNCHPAD_MAX_CALLS }
  const cadence = Number(row.cadence_seconds)
  const ceiling = Number(row.max_credits)
  return {
    enabled: row.enabled !== false,
    cadenceSeconds: Number.isFinite(cadence) && cadence > 0 ? cadence : LANE_CADENCE_SECONDS,
    maxCalls: Number.isFinite(ceiling) && ceiling > 0 ? Math.trunc(ceiling) : LAUNCHPAD_MAX_CALLS,
  }
}

/** Newest CoinGecko capture, or null. Filtered by source so the CoinMarketCap
 * lane writing at :37 can never make this lane skip its own run at :41. */
// deno-lint-ignore no-explicit-any
async function newestCoingeckoCapture(db: any): Promise<number | null> {
  try {
    const { data, error } = await db.from('intel_meme_stage_snapshots')
      .select('captured_at').eq('source', LAUNCHPAD_SOURCE)
      .order('captured_at', { ascending: false }).limit(1)
    if (error) return null
    const row = Array.isArray(data) ? data[0] : data
    const parsed = Date.parse(String(row?.captured_at ?? ''))
    return Number.isFinite(parsed) ? parsed : null
  } catch { return null }
}

// ─── Reads over our own snapshots ────────────────────────────────────────────

export interface TrackedContract { chain: string; address: string; launchpad: string | null }

/**
 * The newest contracts we already track per pad that are NOT yet `graduates`.
 *
 * Bounded twice: `TRACKED_PER_PAD` newest per pad, then `TRACKED_ADDRESS_CEILING`
 * across all pads, drawn ROUND-ROBIN so a busy pad cannot starve a quiet one out
 * of the re-poll. Without this step no graduation is ever observed: a graduated
 * token disappears from its pad's new_pools feed.
 */
// deno-lint-ignore no-explicit-any
export async function trackedContracts(db: any, capturedAt: string): Promise<{ byNetwork: Map<string, TrackedContract[]>; truncated: boolean; reason: string | null }> {
  const byNetwork = new Map<string, TrackedContract[]>()
  const windowStart = new Date(Date.parse(capturedAt) - TRACKED_WINDOW_HOURS * 3600_000).toISOString()
  let rows: Record<string, unknown>[] = []
  try {
    const { data, error } = await db.from('intel_meme_stage_snapshots')
      .select('chain,contract_address,launchpad,stage,captured_at')
      .eq('source', LAUNCHPAD_SOURCE).gte('captured_at', windowStart).lt('captured_at', capturedAt)
      .order('captured_at', { ascending: false }).limit(TRACKED_ROW_CAP)
    if (error) return { byNetwork, truncated: false, reason: String(error.message || error).slice(0, 200) }
    rows = Array.isArray(data) ? data : data ? [data] : []
  } catch (e) { return { byNetwork, truncated: false, reason: ((e as Error)?.message || 'tracked_read_failed').slice(0, 200) } }

  // Rows arrive newest first, so the FIRST sighting of a contract is its newest
  // snapshot and decides whether it is still worth re-polling.
  const seen = new Set<string>()
  const byPad = new Map<string, TrackedContract[]>()
  for (const row of rows) {
    const chain = text(row?.chain, 60), address = text(row?.contract_address, 200)
    if (!chain || !address) continue
    const key = `${chain}|${address}`
    if (seen.has(key)) continue
    seen.add(key)
    if (text(row?.stage, 40) === 'graduates') continue
    const launchpad = text(row?.launchpad, 120)
    const padKey = `${chain}|${launchpad ?? ''}`
    const bucket = byPad.get(padKey) ?? []
    if (bucket.length >= TRACKED_PER_PAD) continue
    bucket.push({ chain, address, launchpad })
    byPad.set(padKey, bucket)
  }
  // Round-robin across pads up to the global ceiling.
  const buckets = [...byPad.values()]
  let taken = 0
  for (let index = 0; taken < TRACKED_ADDRESS_CEILING; index++) {
    let placed = false
    for (const bucket of buckets) {
      if (index >= bucket.length) continue
      const entry = bucket[index]
      const network = LAUNCHPAD_NETWORKS.find((n) => n.chain === entry.chain)
      placed = true
      if (!network) continue
      const list = byNetwork.get(network.network) ?? []
      list.push(entry)
      byNetwork.set(network.network, list)
      taken += 1
      if (taken >= TRACKED_ADDRESS_CEILING) break
    }
    if (!placed) break
  }
  return { byNetwork, truncated: rows.length >= TRACKED_ROW_CAP, reason: null }
}

/** Writable columns of a snapshot row, so a merge can rewrite the whole row
 * without losing a field another lane wrote. */
const SNAPSHOT_WRITE_COLUMNS = 'platform_id,chain,contract_address,captured_at,stage,name,symbol,price,market_cap,first_seen_at,source,launchpad,graduation_pct,completed_at,migration_pool,fdv'

/** Rows another lane (or an earlier run of this one) already wrote for THIS
 * capture hour. The primary key is shared, so this is the read that turns a
 * would-be overwrite into a merge. */
// deno-lint-ignore no-explicit-any
async function sameHourRows(db: any, chain: string, addresses: string[], capturedAt: string): Promise<{ byAddress: Map<string, Record<string, unknown>>; reason: string | null }> {
  const byAddress = new Map<string, Record<string, unknown>>()
  if (!addresses.length) return { byAddress, reason: null }
  try {
    const { data, error } = await db.from('intel_meme_stage_snapshots')
      .select(SNAPSHOT_WRITE_COLUMNS)
      .eq('chain', chain).eq('captured_at', capturedAt).in('contract_address', addresses)
      .limit(SAME_HOUR_CAP)
    if (error) return { byAddress, reason: String(error.message || error).slice(0, 200) }
    for (const row of (Array.isArray(data) ? data : data ? [data] : [])) {
      const address = text(row?.contract_address, 200)
      if (address) byAddress.set(address, row as Record<string, unknown>)
    }
    return { byAddress, reason: null }
  } catch (e) { return { byAddress, reason: ((e as Error)?.message || 'same_hour_read_failed').slice(0, 200) } }
}

/**
 * Merge a row another source already wrote for this hour.
 *
 * Fills ONLY the fields that are still null and keeps everything else, `source`
 * and `stage` included. Exported so the rule is testable on its own, because it
 * is the one place where two lanes could corrupt each other's rows.
 */
export function mergeExisting(existing: Record<string, unknown>, mine: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing }
  for (const field of ['platform_id', 'launchpad', 'graduation_pct', 'completed_at', 'migration_pool', 'fdv', 'name', 'symbol', 'price', 'market_cap']) {
    if (merged[field] == null && mine[field] != null) merged[field] = mine[field]
  }
  return merged
}

// ─── Run lines ───────────────────────────────────────────────────────────────

export interface LaunchpadNetworkLine {
  network: string; chain: string; label: string
  state: 'captured' | 'empty' | 'registry_unavailable' | 'pools_unavailable' | 'call_budget' | 'skipped'
  reason: string | null
  confirmedPads: string[]
  rejectedPads: string[]
  pools: number
  tokens: number
  rows: number
  transitions: number
  merged: number
  dropped: number
  calls: number
}
export interface LaunchpadPadLine { network: string; dex: string; label: string; role: 'pad' | 'destination'; rows: number; reason: string | null }

function logCapture(entry: Record<string, unknown>): void {
  try { console.info(JSON.stringify({ intel_launchpad_capture: entry })) } catch { /* a log must never fail a capture */ }
}

// ─── The lane ────────────────────────────────────────────────────────────────

/**
 * Hourly launchpad stage capture.
 *
 * `plan` is accepted to match the lane-op signature and is DELIBERATELY unused:
 * the CoinMarketCap plan tier is not this lane's gate. Gating a CoinGecko lane
 * on a CoinMarketCap plan is exactly the mistake that leaves a page empty for a
 * reason nobody can find.
 */
// deno-lint-ignore no-explicit-any
export async function captureLaunchpadStages(db: any, ctxFor: (name: string, maxCalls: number) => MarketAssetsContext,
  now = new Date(), _plan = 'basic', deps: LaunchpadDeps = { request: () => Promise.resolve(null) }): Promise<JobResult> {
  const job = LAUNCHPAD_JOB
  let calls = 0
  try {
    const loaded = await loadLaunchpadPolicy(db)
    const policy = launchpadPolicy(loaded.rows.length ? loaded.rows : deps.policy)
    if (!policy.enabled) return { job, rows: 0, credits: 0, skipped: 'policy_disabled' }

    const newest = await newestCoingeckoCapture(db)
    if (newest != null && now.getTime() - newest < policy.cadenceSeconds * 1000 * CADENCE_GRACE) {
      return { job, rows: 0, credits: 0, skipped: 'within_cadence', newestAt: new Date(newest).toISOString() }
    }

    const tier = deps.tier ?? coingeckoOnchainTier()
    const keyless = tier === 'geckoterminal'
    // Keyless we share a 30-a-minute public allowance, so the ceiling comes down
    // AND every live call is paced. With a key the transport's own retry and
    // budget rules already apply and the full ceiling stands.
    const ceiling = Math.max(1, keyless ? Math.min(policy.maxCalls, KEYLESS_MAX_CALLS) : policy.maxCalls)
    const ctx = ctxFor('launchpad-stages', ceiling)
    const contextBudget = Number(ctx?.maxCalls)
    const budget = Math.max(0, Math.min(ceiling, Number.isFinite(contextBudget) && contextBudget >= 0 ? Math.trunc(contextBudget) : ceiling))
    if (budget < 1) return { job, rows: 0, credits: 0, skipped: 'call_budget' }

    const onchain = deps.onchain ?? ((path: string, opts: OnchainRequestOpts) => fetchCoingeckoOnchain(path, opts))
    const sleep = deps.sleep ?? defaultSleep
    const clock = deps.clock ?? (() => Date.now())
    const startedAt = clock()
    const capturedAt = hourBucket(now)

    let budgetExhausted = false
    let live = 0
    /** One bounded call. Returns null when the budget or the wall clock is out,
     * and says so through `budgetExhausted` so a short run is never reported as
     * an empty source. */
    // deno-lint-ignore no-explicit-any
    const ask = async (path: string, opts: Omit<OnchainRequestOpts, 'ctx'>): Promise<any | null> => {
      if (calls >= budget || clock() - startedAt > RUN_BUDGET_MS) { budgetExhausted = true; return null }
      if (keyless && live > 0) await sleep(KEYLESS_SPACING_MS)
      calls += 1
      live += 1
      return await onchain(path, { ...opts, ctx }).catch(() => null)
    }

    const networkLines: LaunchpadNetworkLine[] = []
    const padLines: LaunchpadPadLine[] = []
    const snapshots: Record<string, unknown>[] = []
    const transitions: Record<string, unknown>[] = []
    let reason: string | null = loaded.reason
    let graduationPctOutOfBand = 0
    let priorTruncated = false

    // ── tracked contracts, read once for the whole run ──
    const tracked = await trackedContracts(db, capturedAt)
    priorTruncated = priorTruncated || tracked.truncated
    reason = reason || tracked.reason

    // ── megafilter: probed ONCE, never assumed ──
    // The shared transport gives back null for a 400, a 401, a 403 and a dead
    // socket alike, so a refusal and a failure are the same answer here: stop
    // using megafilter for this run and page new_pools instead. Probing once
    // rather than per network means an unentitled key costs one call an hour,
    // not four.
    let megafilter: boolean | null = keyless ? false : null
    let megafilterReason: string | null = keyless ? 'keyless_host' : null

    for (const network of LAUNCHPAD_NETWORKS) {
      const line: LaunchpadNetworkLine = {
        network: network.network, chain: network.chain, label: network.label,
        state: 'skipped', reason: 'call_budget',
        confirmedPads: [], rejectedPads: [], pools: 0, tokens: 0, rows: 0, transitions: 0, merged: 0, dropped: 0, calls: 0,
      }
      networkLines.push(line)
      const callsBefore = calls
      const wanted = LAUNCHPAD_PADS.filter((p) => p.network === network.network)

      // ── 1. registry verification. No registry, no rows. ──
      const registry = new Set<string>()
      let registryOk = false
      for (let page = 1; page <= REGISTRY_PAGES; page++) {
        const payload = await ask(`networks/${encodeURIComponent(network.network)}/dexes?page=${page}`, {
          endpoint: '/onchain/networks/{network}/dexes', cacheKey: `${network.network}/dexes:p${page}`, ttlMs: REGISTRY_TTL_MS,
        })
        if (!payload) break
        registryOk = true
        const ids = dexIdsFrom(payload)
        for (const id of ids) registry.add(id)
        // A short page is the end of the registry; solana answers 400 on page 2.
        if (ids.length < 20) break
      }
      if (!registryOk) {
        line.state = budgetExhausted ? 'call_budget' : 'registry_unavailable'
        line.reason = budgetExhausted ? 'call_budget' : 'dex_registry_unavailable'
        line.calls = calls - callsBefore
        for (const pad of wanted) padLines.push({ network: pad.network, dex: pad.dex, label: pad.label, role: pad.role, rows: 0, reason: line.reason })
        continue
      }
      const confirmed = wanted.filter((p) => registry.has(p.dex))
      const rejected = wanted.filter((p) => !registry.has(p.dex))
      line.confirmedPads = confirmed.map((p) => p.dex)
      line.rejectedPads = rejected.map((p) => p.dex)
      for (const pad of rejected) padLines.push({ network: pad.network, dex: pad.dex, label: pad.label, role: pad.role, rows: 0, reason: 'absent_from_registry' })
      if (!confirmed.length) {
        line.state = 'empty'
        line.reason = 'no_confirmed_launchpads'
        line.calls = calls - callsBefore
        continue
      }
      const padIds = new Set(confirmed.filter((p) => p.role === 'pad').map((p) => p.dex))
      const destinationIds = new Set(confirmed.filter((p) => p.role === 'destination').map((p) => p.dex))
      const allowed = new Set([...padIds, ...destinationIds])

      // ── 2. new pools ──
      const pools: LaunchpadPool[] = []
      let poolsOk = false
      if (megafilter !== false) {
        // Megafilter is asked for the PADS only, so on this path a graduation
        // destination pool is never seen. Nothing is lost: a graduation is
        // confirmed by `launchpad_details.completed` on the tracked re-poll,
        // and the destination sighting is only ever a second witness.
        const dexes = [...padIds].join(',')
        const payload = await ask(
          `pools/megafilter?networks=${encodeURIComponent(network.network)}&dexes=${encodeURIComponent(dexes)}&sort=pool_created_at_desc&page=1`,
          { endpoint: '/onchain/pools/megafilter', cacheKey: `megafilter:${network.network}:${dexes}` },
        )
        if (payload) {
          megafilter = true
          poolsOk = true
          const read = poolsFrom(payload, network, allowed)
          pools.push(...read.pools)
          line.dropped += read.dropped
        } else if (!budgetExhausted) {
          megafilter = false
          megafilterReason = 'megafilter_unavailable'
        }
      }
      if (!poolsOk) {
        for (let page = 1; page <= Math.min(NEW_POOL_PAGES, NEW_POOL_PAGE_CEILING); page++) {
          const payload = await ask(`networks/${encodeURIComponent(network.network)}/new_pools?page=${page}`, {
            endpoint: '/onchain/networks/{network}/new_pools', cacheKey: `${network.network}/new_pools:p${page}`,
          })
          if (!payload) break
          poolsOk = true
          const read = poolsFrom(payload, network, allowed)
          pools.push(...read.pools)
          line.dropped += read.dropped
          if (!Array.isArray(payload?.data) || payload.data.length < 20) break
        }
      }
      if (!poolsOk) {
        line.state = budgetExhausted ? 'call_budget' : 'pools_unavailable'
        line.reason = budgetExhausted ? 'call_budget' : 'new_pools_unavailable'
        line.calls = calls - callsBefore
        continue
      }
      line.pools = pools.length

      // A pad pool names the pad the token was created on. A DESTINATION pool
      // names no pad, and its token counts only if we already track it — so a
      // destination can confirm a graduation but can never invent a cohort
      // member out of an AMM listing.
      const trackedHere = tracked.byNetwork.get(network.network) ?? []
      const trackedAddresses = new Set(trackedHere.map((t) => t.address))
      const padOf = new Map<string, string>()
      const onDestination = new Map<string, string>()
      for (const pool of pools) {
        if (padIds.has(pool.dex)) {
          if (!padOf.has(pool.tokenAddress)) padOf.set(pool.tokenAddress, pool.dex)
        } else if (destinationIds.has(pool.dex) && trackedAddresses.has(pool.tokenAddress)) {
          if (pool.poolAddress && !onDestination.has(pool.tokenAddress)) onDestination.set(pool.tokenAddress, pool.poolAddress)
        }
      }
      for (const entry of trackedHere) if (entry.launchpad && !padOf.has(entry.address)) padOf.set(entry.address, entry.launchpad)

      // ── 3. the addresses this network will ask about ──
      const addresses = [...new Set([
        ...pools.filter((p) => padIds.has(p.dex)).map((p) => p.tokenAddress),
        ...[...onDestination.keys()],
        ...trackedHere.map((t) => t.address),
      ])]
      if (!addresses.length) {
        line.state = 'empty'
        line.reason = 'no_launchpad_pools'
        line.calls = calls - callsBefore
        continue
      }

      // ── 4. tokens/multi, 30 at a time ──
      const tokens: LaunchpadToken[] = []
      for (const batch of chunk(addresses, TOKENS_PER_CALL)) {
        const payload = await ask(`networks/${encodeURIComponent(network.network)}/tokens/multi/${batch.map(encodeURIComponent).join(',')}`, {
          endpoint: '/onchain/networks/{network}/tokens/multi/{addresses}', cacheKey: `${network.network}/tokens/multi:${batch.join(',')}`,
        })
        if (!payload) break
        const read = tokensFrom(payload, network)
        tokens.push(...read.tokens)
        line.dropped += read.dropped
      }
      line.tokens = tokens.length
      if (!tokens.length) {
        line.state = budgetExhausted ? 'call_budget' : 'empty'
        line.reason = budgetExhausted ? 'call_budget' : 'no_token_facts'
        line.calls = calls - callsBefore
        continue
      }

      // ── 5. classify, carry first_seen_at forward, merge, stage rows ──
      const seenAddresses = tokens.map((t) => t.address)
      const prior = await priorSnapshots(db, network.chain, seenAddresses, capturedAt)
      priorTruncated = priorTruncated || prior.truncated
      reason = reason || prior.reason
      const current = await sameHourRows(db, network.chain, seenAddresses, capturedAt)
      reason = reason || current.reason

      const rowsPerPad = new Map<string, number>()
      for (const token of tokens) {
        if (token.details.outOfBand) graduationPctOutOfBand += 1
        const destinationPool = onDestination.get(token.address) ?? null
        const stage = classifyStage(token.details, !!destinationPool)
        const launchpad = padOf.get(token.address) ?? null
        const previous = prior.byAddress.get(token.address)
        const firstSeenAt = previous?.firstSeenAt || capturedAt
        const mine: Record<string, unknown> = {
          platform_id: null,
          chain: network.chain,
          contract_address: token.address,
          captured_at: capturedAt,
          stage,
          name: token.name,
          symbol: token.symbol,
          price: token.priceUsd,
          market_cap: token.marketCap,
          first_seen_at: firstSeenAt,
          source: LAUNCHPAD_SOURCE,
          launchpad,
          graduation_pct: token.details.graduationPct,
          // The SOURCE's clock, or nothing. Observing a migration does not give
          // us permission to stamp it with our own capture hour.
          completed_at: token.details.completedAt,
          migration_pool: token.details.migrationPool ?? destinationPool,
          fdv: token.fdv,
        }
        const existing = current.byAddress.get(token.address)
        if (existing) {
          // Another lane owns this hour's row. Fill its gaps, move nothing.
          snapshots.push(mergeExisting(existing, mine))
          line.merged += 1
          continue
        }
        snapshots.push(mine)
        if (launchpad) rowsPerPad.set(launchpad, (rowsPerPad.get(launchpad) ?? 0) + 1)
        // No previous snapshot is not a transition: there is no stage to move from.
        if (previous?.stage && previous.stage !== stage) {
          line.transitions += 1
          transitions.push({
            chain: network.chain, contract_address: token.address,
            from_stage: previous.stage, to_stage: stage, at: capturedAt,
            hours_since_first_seen: hoursBetween(firstSeenAt, capturedAt),
            source: LAUNCHPAD_SOURCE, launchpad,
            graduation_pct: token.details.graduationPct,
            completed_at: token.details.completedAt,
            migration_pool: token.details.migrationPool ?? destinationPool,
            fdv: token.fdv,
          })
        }
      }
      line.rows = tokens.length - line.merged
      line.state = line.rows || line.merged ? 'captured' : 'empty'
      line.reason = line.state === 'captured' ? null : 'no_rows'
      line.calls = calls - callsBefore
      for (const pad of confirmed) padLines.push({ network: pad.network, dex: pad.dex, label: pad.label, role: pad.role, rows: rowsPerPad.get(pad.dex) ?? 0, reason: null })
    }

    const state = snapshots.length ? 'captured'
      : networkLines.some((l) => l.state === 'registry_unavailable' || l.state === 'pools_unavailable') ? 'unavailable'
      : budgetExhausted ? 'call_budget' : 'empty'

    logCapture({
      lane: LAUNCHPAD_JOB, source: LAUNCHPAD_SOURCE, tier, capturedAt,
      calls, budget, state, reason: reason ?? null,
      megafilter: megafilter === true ? 'used' : megafilterReason ?? 'not_probed',
      contracts: snapshots.length, transitions: transitions.length,
      graduationPctOutOfBand, trackedTruncated: tracked.truncated,
      networks: networkLines, pads: padLines,
    })

    if (!snapshots.length) {
      return {
        job, rows: 0, credits: 0, capturedAt, calls, tier, networks: networkLines, pads: padLines,
        ...(state === 'unavailable' ? { error: 'launchpad_sources_unavailable' } : { skipped: state === 'call_budget' ? 'call_budget' : 'no_launchpad_contracts' }),
      }
    }

    const wroteSnapshots = await upsert(db, 'intel_meme_stage_snapshots',
      dedupe(snapshots, (r) => `${r.chain}|${r.contract_address}`), 'chain,contract_address,captured_at')
    const wroteTransitions = transitions.length
      ? await upsert(db, 'intel_meme_stage_transitions', dedupe(transitions, (r) => `${r.chain}|${r.contract_address}`), 'chain,contract_address,at')
      : { rows: 0 }
    const error = wroteSnapshots.error || wroteTransitions.error || null
    return {
      job, rows: wroteSnapshots.rows, credits: 0, capturedAt, calls, tier,
      networks: networkLines, pads: padLines,
      transitions: wroteTransitions.rows, contracts: snapshots.length,
      merged: networkLines.reduce((sum, l) => sum + l.merged, 0),
      graduationPctOutOfBand,
      ...(priorTruncated ? { priorTruncated: true } : {}),
      ...(budgetExhausted ? { callBudgetExhausted: true } : {}),
      ...(reason ? { partial: reason } : {}), ...(error ? { error } : {}),
    }
  } catch (e) {
    return { job, rows: 0, credits: 0, calls, error: ((e as Error)?.message || 'capture_failed').slice(0, 200) }
  }
}

/** Integration surface, wired into `LANE_OPS` in `intel-capture/index.ts`. */
export const LAUNCHPAD_CAPTURE_OPS: Record<string, (
  // deno-lint-ignore no-explicit-any
  admin: any, ctxFor: (name: string, maxCalls: number) => MarketAssetsContext, now: Date, plan: string, deps: CaptureDeps
) => Promise<JobResult>> = {
  launchpad_stages: (admin, ctxFor, now, plan, deps) => captureLaunchpadStages(admin, ctxFor, now, plan, deps as LaunchpadDeps),
}

/** Re-exported so the read half and the tests use one list of stage names. */
export { MEME_STAGES }
