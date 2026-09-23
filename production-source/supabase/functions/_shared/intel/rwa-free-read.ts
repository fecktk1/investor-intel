// Investor Intel — the real-world asset workspace on the free tier.
//
// WHAT THIS FILE DECIDES
//
// Two separate questions, kept apart on purpose:
//
//   1. WHICH SURFACE does a research capability need? researchSurfaceFor below.
//      The six real-world asset capabilities need 'rwa_research' (min_tier
//      'free'); every other provider backed capability still needs
//      'research_on_demand' (min_tier 'starter'). Nothing is ungated by this
//      file: a capability that needed a surface before still needs one.
//
//   2. HOW is a real-world asset read served to somebody who does NOT hold
//      research_on_demand? freeRwaRead below. Shared cache first, no demand
//      stamp ever, and a live provider call only inside a dedicated daily
//      platform-wide budget.
//
// WHY THE SECOND QUESTION EXISTS AT ALL
//
// Opening a surface is not the same as making it free. The RWA reads are cheap
// and heavily shared, but a visitor can still page through identifiers, and
// 'cheap per read' times 'unbounded reads' is not a number anybody has agreed
// to. So the free lane is bounded three ways at once:
//
//   * IT PREFERS THE SHARED CACHE. Every free read asks the response cache
//     first, with kind 'render' and maxCalls 0, so it cannot reach the provider
//     on that pass. A fresh or stale-but-usable row answers it for nothing.
//
//   * IT NEVER STAMPS CONNECTED DEMAND. demanded_at is the refresh worker's
//     only input, so stamping it buys a provider refresh later, asynchronously,
//     against the shared monthly budget. Both passes below set noDemand, and the
//     first also sets selectedDemand false, so a free read can never enrol a
//     cache key into the refresh loop. This is exactly the trap the long comment
//     at the requireIntelSurface call site in intel-research warns about: a
//     retained read looks free and is not. Here it is made free by removing the
//     stamp, not by asserting it away.
//
//   * A LIVE MISS IS CAPPED. Only when the cache had nothing usable does the
//     lane claim from intel_free_rwa_read_claim, a daily platform-wide credit
//     budget whose cap lives in a row (cmc_free_rwa_policy), not in this file.
//     A refused claim is not an error: the caller answers with whatever the
//     retained row said, or with the calm state that says the record has not
//     been read yet today.
//
// WHAT A HOLDER OF research_on_demand GETS: nothing from this file. Starter and
// above keep the existing demand path, the existing monthly feature budget and
// the existing live-watch refresh policy, byte for byte.

import { CMC_CAPABILITIES, estimateCmcCredits } from '../market-assets/cmc-capabilities.ts'
import type { IntelSurface } from './intel-surface-access.ts'

/** The six capabilities the /intel/rwa workspace reads, and the only ones the
 * free lane will serve. Confirmed against VIEWS.rwa in MarketResearchPage.jsx
 * (rwaList, issuers) and the evidence drawer it opens (rwaInfo, rwaQuotes,
 * rwaPairs, issuer). Kept as a literal set rather than derived from
 * capability.feature === 'rwa', because rwaMap carries feature 'metadata' and a
 * future 'rwa' registration must be an explicit decision here, not an
 * accidental one. */
export const RWA_FREE_CAPABILITIES: ReadonlySet<string> = new Set([
  'rwaList', 'rwaInfo', 'rwaQuotes', 'rwaPairs', 'issuers', 'issuer',
])

/** Which surface this research capability needs.
 *
 * Deliberately NOT a replacement for researchSurfaceRequired: that function
 * still answers whether a surface is needed at all (the four store-only reads
 * need none). This one answers which surface, for the reads that need one. */
export function researchSurfaceFor(capability: string): IntelSurface {
  return RWA_FREE_CAPABILITIES.has(capability) ? 'rwa_research' : 'research_on_demand'
}

/** Does THIS read go down the bounded free lane?
 *
 * Only when it is one of the six real-world asset capabilities AND the member
 * does not hold research_on_demand. A Starter, Pro, Elite or trial member holds
 * it, so they answer false here and keep the existing demand path, the existing
 * monthly feature budget and the existing live-watch policy, unchanged. Service
 * and cron callers hold it too (intelSurfaceAllowed lets them through), so the
 * capture lanes are untouched. */
export function useFreeRwaLane(capability: string, holdsResearchOnDemand: boolean): boolean {
  return RWA_FREE_CAPABILITIES.has(capability) && !holdsResearchOnDemand
}

/** The credit estimate this read is charged against the daily free budget.
 *
 * The same floor the reservation ledger uses, so the two agree about what a
 * request is worth. Every RWA capability comes out at 1 today (cost '250' over a
 * 25 or 250 row page, or a flat one). An unregistered capability is charged the
 * ceiling the claim accepts, so a mistake here refuses rather than undercounts. */
export function freeRwaCreditEstimate(capability: string, params: Record<string, string>): number {
  if (!CMC_CAPABILITIES[capability]) return 25
  try { return Math.max(1, Math.ceil(estimateCmcCredits(capability, params))) } catch { return 25 }
}

export interface FreeRwaClaim { allowed: boolean; reason: string | null; cap: number | null; used: number | null }

/** Claim one live provider read from the daily platform-wide free-tier budget.
 *
 * Every failure is the same answer as a spent budget: not allowed. An
 * unreadable budget must never become an unlimited one, so a thrown RPC, a
 * missing policy row and a malformed reply all refuse. */
// deno-lint-ignore no-explicit-any
export async function claimFreeRwaRead(db: any, capability: string, params: Record<string, string>): Promise<FreeRwaClaim> {
  const credits = freeRwaCreditEstimate(capability, params)
  try {
    const { data, error } = await db.rpc('intel_free_rwa_read_claim', { p_capability: capability, p_credits: credits })
    if (error || !data || typeof data !== 'object') return { allowed: false, reason: 'free_rwa_budget_unavailable', cap: null, used: null }
    const cap = Number.isFinite(Number(data.cap)) ? Number(data.cap) : null
    const used = Number.isFinite(Number(data.used)) ? Number(data.used) : null
    if (data.allowed !== true) return { allowed: false, reason: typeof data.reason === 'string' ? data.reason : 'free_rwa_budget_exhausted', cap, used }
    return { allowed: true, reason: null, cap, used }
  } catch {
    return { allowed: false, reason: 'free_rwa_budget_unavailable', cap: null, used: null }
  }
}

/** Whatever researchSnapshot returns, plus what the free lane did about it. */
// deno-lint-ignore no-explicit-any
export type ResearchSnapshot = Record<string, any>
export type FreeRwaPlan = 'shared-cache' | 'shared-live'
/** researchSnapshot, called once per pass with the plan the pass is allowed. */
export type SnapshotReader = (plan: FreeRwaPlan) => Promise<ResearchSnapshot>

/** Did this snapshot actually answer the read?
 *
 * The STATE decides, not the row count. 'fresh', 'cached' and 'stale' all mean
 * a shared snapshot answered, and an empty page under a filter nothing is listed
 * under is a real answer that must not trigger a paid retry. 'unavailable',
 * 'unsupported' and 'refreshing' mean nothing was served. */
export function freeRwaSnapshotUsable(snapshot: ResearchSnapshot | null): boolean {
  if (!snapshot) return false
  return snapshot.state === 'fresh' || snapshot.state === 'cached' || snapshot.state === 'stale'
}

/**
 * Serve one real-world asset read to a member without research_on_demand.
 *
 * Pass 1 is the shared cache, which cannot reach the provider. If it answered,
 * that is the answer. Otherwise claim from the daily budget; only a granted
 * claim runs pass 2, which may call the provider once and still stamps no
 * demand. A refused claim returns pass 1 unchanged, with the lane's own reason
 * attached so the product can say the calm, true thing about it.
 *
 * `allowLive` is false for a background poll: a client that is quietly
 * refreshing on a timer must never be the thing that spends the day's budget.
 */
export async function freeRwaRead(
  read: SnapshotReader,
  claim: () => Promise<FreeRwaClaim>,
  allowLive = true,
): Promise<ResearchSnapshot> {
  const shared = await read('shared-cache')
  const lane = (snapshot: ResearchSnapshot, extra: Record<string, unknown>) => ({
    ...snapshot,
    // The client renders its own calm state from this, so it has to be able to
    // tell 'served from the shared snapshot' from 'nothing to serve yet'. No
    // figure, holding or series is added here: only what the lane did.
    freeShared: { lane: 'rwa_research', ...extra },
    // A free read is never enrolled in the 60 second live-watch loop. Leaving
    // the paid refresh policy on the body would have the browser poll a lane
    // that deliberately does not refresh for it.
    refreshPolicy: { enabled: false, cacheReadSeconds: null, providerRefreshSeconds: null },
  })
  if (freeRwaSnapshotUsable(shared)) return lane(shared, { served: 'shared-cache' })
  if (!allowLive) return lane(shared, { served: 'retained', reason: 'free_rwa_background_read' })
  // A capability our own plan cannot serve is not a budget problem, and spending
  // on it would be spending on a refusal. The transport answers 'unsupported'
  // for an unregistered capability and for one above the verified CoinMarketCap
  // plan (rwaPairs needs Growth; the verified profile is lower), and it answers
  // that BEFORE it reaches the cache or the reservation, so a second pass would
  // return the identical refusal having consumed a slot of the free tier's day.
  if (shared.state === 'unsupported') return lane(shared, { served: 'retained', reason: shared.reason ?? 'unsupported_capability' })
  const granted = await claim()
  if (!granted.allowed) return lane(shared, { served: 'retained', reason: granted.reason })
  const live = await read('shared-live')
  return lane(live, { served: freeRwaSnapshotUsable(live) ? 'shared-live' : 'retained', reason: freeRwaSnapshotUsable(live) ? null : live.reason ?? null })
}

// ─── The public lookup's variant: refresh a copy past its window ─────────────
//
// freeRwaRead above treats a 'stale' shared copy (past its TTL, still inside
// stale_until) as an answer, so a copy read once at 08:00 is served as-is until
// 14:00. That is right for intel-research's free members, whose own path is
// unchanged. The PUBLIC lookup (intel-rwa-lookup, which the demo also uses) wants
// the figure inside its refresh window instead, still without per-visitor calls:
//
//   1. The shared copy inside its window answers, for nothing.
//   2. Otherwise a SECOND shared copy of the same figure answers, for nothing,
//      when it is inside its window: the scheduled warm lane's one batched read
//      of every asset on the judge path (capture-rwa-quote-warm.ts). Its own
//      receipt names that batched request, so nothing is passed off as a call
//      that was not made.
//   3. Otherwise ONE live refresh, through exactly the gates a miss already
//      passes: the per-IP hourly allowance, then the 200 credit daily free
//      budget. The transport's reservation lease makes concurrent readers of
//      one key share that call, and a refreshed key is inside its window for the
//      next hour, so this is at most one call per key per hour platform-wide.
//   4. When the refresh is refused or fails, the NEWEST usable copy answers,
//      with the reason, so a stale figure still says it is stale and why.
//
// `liveBlocked` short-cuts 3: a plan refusal the warm lane recorded is not asked
// again by every visitor (the transport holds the same refusal six hours).

/** Inside its refresh window: a live answer, or a cache row before expires_at. */
export function freeRwaInWindow(snapshot: ResearchSnapshot | null): boolean {
  return !!snapshot && (snapshot.state === 'fresh' || snapshot.state === 'cached')
}

const fetchedMs = (s: ResearchSnapshot | null): number => {
  const t = Date.parse(String(s?.provenance?.fetchedAt ?? s?.receipt?.fetchedAt ?? ''))
  return Number.isFinite(t) ? t : -Infinity
}

/** The newest usable copy among several, first one winning a tie. */
export function newestUsable(...list: (ResearchSnapshot | null)[]): ResearchSnapshot | null {
  let best: ResearchSnapshot | null = null
  for (const s of list) if (freeRwaSnapshotUsable(s) && (!best || fetchedMs(s) > fetchedMs(best))) best = s
  return best
}

export interface FreshReadOptions {
  /** A second shared copy of the same figure, cache only (the warm batch). */
  alternate?: (() => Promise<ResearchSnapshot | null>) | null
  /** A provider refusal already known (a recorded plan refusal): no claim, no
   * call. May be a function, asked only when a live read would be the next step,
   * so a caller can read the warm lane's state beside the shared copy instead of
   * before it. A function that throws counts as no refusal. */
  liveBlocked?: string | null | (() => Promise<string | null>)
}

export async function freeRwaReadFresh(
  read: SnapshotReader,
  claim: () => Promise<FreeRwaClaim>,
  allowLive = true,
  opts: FreshReadOptions = {},
): Promise<ResearchSnapshot> {
  const lane = (snapshot: ResearchSnapshot, extra: Record<string, unknown>) => ({
    ...snapshot,
    freeShared: { lane: 'rwa_research', ...extra },
    refreshPolicy: { enabled: false, cacheReadSeconds: null, providerRefreshSeconds: null },
  })
  const shared = await read('shared-cache')
  if (freeRwaInWindow(shared)) return lane(shared, { served: 'shared-cache' })
  let alt: ResearchSnapshot | null = null
  if (opts.alternate) { try { alt = await opts.alternate() } catch { alt = null } }
  if (freeRwaInWindow(alt)) return lane(alt!, { served: 'shared-cache' })
  const kept = newestUsable(shared, alt)
  // Nothing refreshed it: the newest copy with the reason, or the lane's own
  // unavailable body with the reason when there is no copy at all.
  const keep = (reason: string | null) => kept ? lane(kept, { served: 'shared-cache', reason }) : lane(shared, { served: 'retained', reason })
  if (!allowLive) return keep('free_rwa_background_read')
  if (shared.state === 'unsupported') return lane(shared, { served: 'retained', reason: shared.reason ?? 'unsupported_capability' })
  const blocked = typeof opts.liveBlocked === 'function' ? await opts.liveBlocked().catch(() => null) : opts.liveBlocked
  if (blocked) return keep(blocked)
  const granted = await claim()
  if (!granted.allowed) return keep(granted.reason)
  const live = await read('shared-live')
  if (freeRwaInWindow(live)) return lane(live, { served: live.state === 'fresh' ? 'shared-live' : 'shared-cache' })
  // The refresh did not land (a refusal, an outage, a lease another isolate is
  // still holding): the transport hands back the copy it had, with the reason.
  const reason = live.reason ?? 'live_read_unavailable'
  const best = newestUsable(live, kept)
  return best ? lane(best, { served: 'shared-cache', reason }) : lane(live, { served: 'retained', reason })
}
