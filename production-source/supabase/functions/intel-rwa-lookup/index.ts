// Investor Intel: public "Look up any tokenised asset, now". Wiring only; the
// handler and its reasoning are in ./handler.ts (kept free of the Supabase
// client so its tests run without it).

import { createClient } from 'npm:@supabase/supabase-js@2'
import { requestCmc } from '../_shared/market-assets/cmc-transport.ts'
import { claimFreeRwaRead } from '../_shared/intel/rwa-free-read.ts'
import { checkAndIncrement, hashedIpKey } from '../_shared/rate-limit.ts'
import { researchParams, researchSnapshot } from '../_shared/intel/research-service.ts'
import { loadWarmState, type WarmState } from '../_shared/intel/capture-rwa-quote-warm.ts'
import { handleLookup, type HandlerDeps } from './handler.ts'

/** The warm lane's run log changes about once an hour, so one isolate reads it
 * at most every 15 seconds rather than once per request. */
const WARM_MEMO_MS = 15_000

function productionDeps(): HandlerDeps {
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })
  const ctx = (plan: 'shared-cache' | 'shared-live') => ({
    supabase: db, kind: (plan === 'shared-live' ? 'request' : 'render') as 'request' | 'render', selectedDemand: false, noDemand: true,
    maxCalls: plan === 'shared-live' ? 1 : 0, waitForFresh: plan === 'shared-live',
    caller: plan === 'shared-live' ? 'intel-rwa-lookup-live' : 'intel-rwa-lookup-cache', requestId: null, orgId: null, userId: null,
  })
  let warmMemo: { at: number; value: Promise<WarmState | null> } | null = null
  const warm = () => {
    if (!warmMemo || Date.now() - warmMemo.at > WARM_MEMO_MS) warmMemo = { at: Date.now(), value: loadWarmState(db) }
    return warmMemo.value
  }
  return {
    db,
    readQuote: (rwaId) => (plan) => requestCmc('rwaQuotes', { rwa_id: rwaId }, ctx(plan)),
    claim: (rwaId) => claimFreeRwaRead(db, 'rwaQuotes', { rwa_id: rwaId }),
    // The warm lane's batched entry is read from the shared cache only: this
    // endpoint never refreshes it (the lane does, on its own budget claim).
    warm,
    readBatch: (ids) => requestCmc('rwaQuotes', { rwa_id: ids }, ctx('shared-cache')),
    // The research reads, exactly as intel-research serves a free member: no
    // user, no org, the free lane's plan, the same claim.
    readResearch: (capability, params) => (plan) => researchSnapshot(db, capability, params, null, undefined, undefined, false, plan),
    // The warm batch as a research body, cache only. Its relationship-index
    // repair already ran when the lane filled it, so a reread skips it.
    readBatchResearch: (ids) => researchSnapshot(db, 'rwaQuotes', { rwa_id: ids }, null, undefined, undefined, false, 'shared-cache', { repairRelationships: false }),
    claimResearch: (capability, params) => claimFreeRwaRead(db, capability, params),
    researchParams,
    limit: (key, limit, windowSeconds, opts) => checkAndIncrement(db, key, limit, windowSeconds, opts),
    ipKey: hashedIpKey,
    secrets: () => [Deno.env.get('COINMARKETCAP_API_KEY'), Deno.env.get('CMC_API_KEY'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')],
  }
}

if (import.meta.main) {
  let deps: HandlerDeps | null = null
  Deno.serve((req) => handleLookup(req, deps ??= productionDeps()))
}
