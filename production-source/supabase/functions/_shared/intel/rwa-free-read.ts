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
