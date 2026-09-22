// Investor Intel public demo: the free RWA research reads (and the two shared
// market reads, global and listings), from the shared cache ONLY.
//
// The /intel/rwa workspace reads six real-world asset capabilities through
// intel-research. For a member without research_on_demand those reads take the
// bounded free lane (./rwa-free-read.ts): the shared response cache first, then,
// only if a daily platform budget grants it, one live call. The demo snapshot
// must never spend, so this reader runs the lane with a claim that is always
// refused and a live pass that throws if it is ever reached. What comes back is
// exactly the body intel-research returns for a served shared-cache read, or,
// for a capability our plan cannot serve, the same 'unsupported' answer a
// member sees. Anything else (nothing cached yet) is left out of the snapshot.
//
// The cache pass itself is requestCmc with kind 'render', maxCalls 0 and
// noDemand: it cannot reach the provider and it stamps no demand, so reading
// the snapshot's inputs buys no refresh later either.

import { researchParams, researchSnapshot } from './research-service.ts'
import { freeRwaRead, RWA_FREE_CAPABILITIES, type FreeRwaClaim } from './rwa-free-read.ts'
import type { ResearchCacheReader } from './demo-snapshot-builder.ts'

// deno-lint-ignore no-explicit-any
type Db = any

const REFUSED: FreeRwaClaim = { allowed: false, reason: 'demo_snapshot_cache_only', cap: null, used: null }

/** The two market reads of /intel/market-context and /intel/discovery. They are
 * not in the free RWA lane, so they are served from the same shared response
 * cache through the same 'shared-cache' pass (kind 'render', maxCalls 0,
 * noDemand): the stored record when one is there, never a provider call. */
export const SHARED_CACHE_MARKET_CAPABILITIES: ReadonlySet<string> = new Set(['global', 'listings'])

// deno-lint-ignore no-explicit-any
const served = (body: any) => !!body && body.state !== 'unavailable' && !!body.provenance?.fetchedAt
  && !!body.data && (!Array.isArray(body.data.rows) || body.data.rows.length > 0)

/** Injectable for tests; the real one is researchSnapshot. */
export type SnapshotFn = typeof researchSnapshot

export function cacheOnlyResearchReader(db: Db, snapshot: SnapshotFn = researchSnapshot): ResearchCacheReader {
  return async (capability, input) => {
    const market = SHARED_CACHE_MARKET_CAPABILITIES.has(capability)
    if (!RWA_FREE_CAPABILITIES.has(capability) && !market) return null
    let params: Record<string, string>
    try { params = researchParams(capability, input) } catch { return null }
    if (market) {
      // No user, no org, and the pass that cannot reach the provider.
      const body = await snapshot(db, capability, params, null, undefined, undefined, false, 'shared-cache')
      return served(body) ? body : null
    }
    const body = await freeRwaRead(
      (plan) => {
        if (plan !== 'shared-cache') throw new Error('demo_snapshot_live_pass_forbidden')
        // No user, no org: the free lane's shared record is the same for every reader.
        return snapshot(db, capability, params, null, undefined, undefined, false, 'shared-cache')
      },
      async () => REFUSED,
      true,
    )
    if (body?.freeShared?.served === 'shared-cache') return body
    if (body?.state === 'unsupported') return body
    return null
  }
}
