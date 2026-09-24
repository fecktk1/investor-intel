// Investor Intel: the public tokenised asset lookup. Wiring only; the
// handler and its reasoning are in ./handler.ts (kept free of the Supabase
// client so its tests run without it).

import { createClient } from 'npm:@supabase/supabase-js@2'
import { requestCmc } from '../_shared/market-assets/cmc-transport.ts'
import { claimFreeRwaRead } from '../_shared/intel/rwa-free-read.ts'
import { checkAndIncrement, hashedIpKey } from '../_shared/rate-limit.ts'
import { researchParams, researchSnapshot } from '../_shared/intel/research-service.ts'
import { loadWarmState, type WarmState } from '../_shared/intel/capture-rwa-quote-warm.ts'
import { dailyTakeReason, type AnswerStore } from '../_shared/intel/rwa-lookup.ts'
import { handleLookup, type HandlerDeps } from './handler.ts'

/** The warm lane's run log changes about once an hour, so one isolate reads it
 * at most every 15 seconds rather than once per request. */
const WARM_MEMO_MS = 15_000

/** Work that runs after the response is sent: the runtime keeps the isolate
 * alive for it (EdgeRuntime.waitUntil). A failure never reaches the caller. */
function defer(work: Promise<unknown>) {
  work.catch(() => {})
  // deno-lint-ignore no-explicit-any
  const runtime = (globalThis as any).EdgeRuntime
  if (runtime && typeof runtime.waitUntil === 'function') runtime.waitUntil(work)
}

function productionDeps(): HandlerDeps {
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })
  // `refreshBefore` rides only on the live pass: the lookup's live rule, or a
  // visitor's check, declares an older shared copy past its window for it.
  const ctx = (plan: 'shared-cache' | 'shared-live', refreshBefore: string | null = null) => ({
    supabase: db, kind: (plan === 'shared-live' ? 'request' : 'render') as 'request' | 'render', selectedDemand: false, noDemand: true,
    maxCalls: plan === 'shared-live' ? 1 : 0, waitForFresh: plan === 'shared-live',
    caller: plan === 'shared-live' ? 'intel-rwa-lookup-live' : 'intel-rwa-lookup-cache', requestId: null, orgId: null, userId: null,
    ...(plan === 'shared-live' && refreshBefore ? { refreshBefore } : {}),
  })
  let warmMemo: { at: number; value: Promise<WarmState | null> } | null = null
  const warm = () => {
    if (!warmMemo || Date.now() - warmMemo.at > WARM_MEMO_MS) warmMemo = { at: Date.now(), value: loadWarmState(db) }
    return warmMemo.value
  }
  // The finished answers (rwa-lookup.ts answerLookup). Service role only; the
  // keep RPC only ever moves an answer forward in time.
  const answers: AnswerStore = {
    async read(key) {
      const { data, error } = await db.from('intel_rwa_lookup_answers').select('body,built_at').eq('query_key', key).maybeSingle()
      if (error || !data || !data.body || typeof data.built_at !== 'string') return null
      return { body: data.body, builtAt: data.built_at }
    },
    async keep(key, rwaId, body, builtAt) {
      const { error } = await db.rpc('intel_rwa_lookup_answer_keep', { p_query_key: key, p_rwa_id: rwaId == null ? null : Number(rwaId), p_body: body, p_built_at: builtAt })
      if (error) throw new Error('answer_keep_failed')
    },
  }
  return {
    db,
    defer,
    answers,
    readQuote: (rwaId, opts) => (plan) => requestCmc('rwaQuotes', { rwa_id: rwaId }, ctx(plan, opts?.refreshBefore ?? null)),
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
    // The UTC-day allowance of live calls (migration 20260924020000). Any
    // failure throws, and the handler refuses the call.
    async daily(callerKey, kind, limit, globalLimit) {
      const { data, error } = await db.rpc('intel_rwa_lookup_live_take', { p_caller_key: callerKey, p_kind: kind, p_limit: limit, p_global_limit: globalLimit })
      if (error || !data || typeof data !== 'object') throw new Error('allowance_unavailable')
      return data.allowed === true ? { allowed: true, reason: null } : { allowed: false, reason: dailyTakeReason(kind, data.reason_code) }
    },
    ipKey: hashedIpKey,
    secrets: () => [Deno.env.get('COINMARKETCAP_API_KEY'), Deno.env.get('CMC_API_KEY'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')],
  }
}

if (import.meta.main) {
  let deps: HandlerDeps | null = null
  Deno.serve((req) => handleLookup(req, deps ??= productionDeps()))
}
