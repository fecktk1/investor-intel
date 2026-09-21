// Investor Intel — contract identity resolution for portfolio holdings
// (CMC plan Stage 4, proposal 25). On-demand only.
//
// Four operations, all POST, all org-scoped and all behind the Intel
// entitlement (`requireIntelAccess` verifies the user, then org membership,
// then the entitlement — the same gate `intel-asset-facts` uses, and
// `verify_jwt` is on for this function in `supabase/config.toml`):
//
//   {op:'coverage'} — priced versus unpriced by chain for the org's OPEN book.
//                     Reads rows only; calls no provider and spends nothing.
//   {op:'resolve'}  — asks CoinMarketCap's DEX batch endpoints about the open
//                     unpriced/stale holdings that sit on a VERIFIED DEX chain
//                     and carry a contract, then writes the prices it was given.
//   {op:'entities'} — fills `entities.provider_ids.coinmarketcap` for the org's
//                     contract entities that do not have one yet. Nothing in the
//                     codebase writes that key today; `asset-resolver` reads it.
//   {op:'unprice'}  — undoes THIS feature's own writes for named holdings. Added
//                     after the first live run wrote one absurd price: a write
//                     that can distort a whole portfolio must be reversible from
//                     the UI, without a database session.
//
// THE PLAUSIBILITY GATE. The first live run priced a Base holding at $3,723,685
// a token ($372.4M for the position) from a provider aggregate over an illiquid
// pool. `holding-identity.ts` now refuses a price whose pool liquidity is under
// $1,000 or unreported, whose implied value exceeds the token's own reported
// market cap, or whose implied value exceeds $1,000,000 on a FIRST pricing.
// A refused row reports `price_implausible` with the numbers it was refused on
// and is NOT written: the holding stays unpriced, which is a known gap rather
// than a confident error.
//
// WHY THIS IS AN EDGE FUNCTION AND NOT A WORKER JOB
// The worker release is gate G2, so the portfolio-sync resolver that proposal 25
// eventually wants cannot ship yet. The migration seeds a `holding_identity`
// schedule policy row (cadence 86400) so the scheduler can adopt this lane later
// WITHOUT another migration; no cron job is created now.
//
// PRIVACY (execution plan decision 7: "only aggregate demand counters are
// stored, never who searched")
//   * `intel_holding_resolution_runs` has org_id and counters. No user column,
//     and this function passes none — a run is an organisation's spending fact.
//   * Demand is recorded through `public.intel_record_asset_demand`, whose whole
//     point is that it stores WHAT was asked about and not WHO asked.
//   * The provider contexts below deliberately carry no orgId/userId, so the
//     shared response cache is never stamped with the identity of the person who
//     pressed "Resolve now".
//
// CREDITS. Probed 2026-09-14 (docs/investor-intel/evidence/
// cmc-cost-probe-2026-09-14.json): one `dexBatch` call and one `dexPriceBatch`
// call each reported credit_count 1 for a ONE-address request. The per-member
// curve for a full 50-address batch is UNMEASURED. `credits` in every response
// is therefore the probed floor (one per provider call actually issued), never a
// promise; `cmc_request_reconcile` books the real charge inside the transport.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { requireIntelAccess } from '../_shared/intel/research-service.ts'
import { orgAuthzErrorResponse } from '../_shared/org-authz.ts'
import { requestCmc } from '../_shared/market-assets/cmc-transport.ts'
import { cmcDexAddress, cmcDexParams } from '../_shared/market-assets/cmc-dex.ts'
import {
  applyBatchAnswers, canonicalAddress, cmcPlatformForChain, coverageByChain, holdingAddress,
  HOLDING_RUN_LIMIT_MAX, planHoldingResolution, summarizeAnswers,
  type HoldingAnswer, type HoldingIdentityRow,
} from '../_shared/intel/holding-identity.ts'
import {
  CONTRACT_DEX_PRICE_SOURCE, priceContractHoldings, summarizeContractPrices,
  type ContractPriceAnswer, type ContractPriceRequest,
} from '../_shared/intel/contract-holding-price.ts'

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, ...extra, 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } })

/** Resolve runs an organisation may start per hour. Four is the on-demand rate
 * the execution plan asks for; it bounds both the spend and the write pressure
 * on a book that only changes when a wallet syncs. */
export const RESOLUTION_RUNS_PER_HOUR = 4
export const RESOLUTION_WINDOW_SECONDS = 3600
/** Entities looked up per `entities` run. One credit each (`metadata` is 1 per
 * 250 identifiers and an address lookup is one identifier). */
export const ENTITY_LOOKUP_MAX = 20
/** Holdings one `unprice` call may reset. Bounded like every other list here. */
export const UNPRICE_MAX = 50
/** The only `price_source` `unprice` will undo. This operation reverses THIS
 * feature's writes and nothing else: an exchange or Birdeye price belongs to the
 * path that wrote it. */
export const DEX_PRICE_SOURCE = 'coinmarketcap_dex'
/** Every `price_source` THIS feature writes, and therefore every one `unprice`
 * reverses. The free-DEX fallback below is this feature's write too: a price it
 * produced has to be undoable from the UI for the same reason the paid one is. */
export const UNDOABLE_PRICE_SOURCES = [DEX_PRICE_SOURCE, CONTRACT_DEX_PRICE_SOURCE]
/** A read ceiling so a very large book is truncated loudly, not silently. */
const HOLDING_ROW_LIMIT = 5000
const ENTITY_ROW_LIMIT = 500
/** Concurrent holding updates. Small enough to stay inside the function's
 * connection budget, large enough that 200 writes are not 200 round trips. */
const WRITE_CONCURRENCY = 8
/** `investor_portfolio_holdings.provider_confidence` is `double precision`
 * (migration 185), NOT a text grade: writing the string 'medium' would abort the
 * whole update with 22P02. A medium confidence is therefore written as the
 * midpoint of the 0..1 scale. See docs/investor-intel/contract-identity-resolution.md. */
export const PROVIDER_CONFIDENCE_MEDIUM = 0.5
const CREDITS_NOTE = 'Probed floor: 1 credit per provider call (dexBatch and dexPriceBatch each reported credit_count 1 for a one-address request on 2026-09-14). The per-member cost of a full 50-address batch is unmeasured; the transport reconciles the real charge.'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const HOLDING_COLUMNS = 'id,chain,contract_address,mint_or_contract,asset_symbol,normalized_symbol,name,quantity,price_status,is_closed'

// deno-lint-ignore no-explicit-any
type Db = any
export interface IdentityDeps {
  request?: typeof requestCmc
  now?: () => Date
  /** The free-DEX fallback pass, injected so a test never reaches a provider. */
  priceContracts?: typeof priceContractHoldings
}

/** One shared provider context for a whole run. `maxCalls` is the run's own
 * budget: the transport refuses a call beyond it, so a malformed plan cannot
 * spend more than the plan said it would. No orgId/userId — see PRIVACY above. */
// deno-lint-ignore no-explicit-any
const runContext = (admin: Db, maxCalls: number): any => ({
  supabase: admin, kind: 'request' as const, caller: 'holding-identity',
  jobName: 'intel-portfolio-identity', maxCalls, waitForFresh: true, _calls: 0,
})

/** The bare `data` array of a batch response, or [] when the provider answered
 * with anything else. An unusable answer is a silence, never an invented row. */
const dataArray = (payload: unknown): unknown[] => {
  const data = (payload as { data?: unknown } | null)?.data
  return Array.isArray(data) ? data : []
}

export async function readOpenHoldings(admin: Db, orgId: string, portfolioId: string | null) {
  let query = admin.from('investor_portfolio_holdings').select(HOLDING_COLUMNS).eq('org_id', orgId)
  if (portfolioId) query = query.eq('portfolio_id', portfolioId)
  // `is_closed` is nullable on legacy rows; NULL means open, exactly as the
  // partial index in the migration reads it (WHERE is_closed IS NOT TRUE).
  const { data, error } = await query.or('is_closed.is.null,is_closed.eq.false').limit(HOLDING_ROW_LIMIT)
  if (error) return { rows: null as HoldingIdentityRow[] | null, truncated: false }
  const rows = (data ?? []) as HoldingIdentityRow[]
  return { rows, truncated: rows.length >= HOLDING_ROW_LIMIT }
}

/** Runs this org already started inside the window. Returns null when the ledger
 * could not be read: an unreadable rate limit fails CLOSED, because the
 * alternative is an unbounded number of paid runs. */
async function resolutionWindow(admin: Db, orgId: string, now: Date) {
  const since = new Date(now.getTime() - RESOLUTION_WINDOW_SECONDS * 1000).toISOString()
  const { data, error } = await admin.from('intel_holding_resolution_runs')
    .select('ran_at').eq('org_id', orgId).gte('ran_at', since)
    .order('ran_at', { ascending: true }).limit(RESOLUTION_RUNS_PER_HOUR + 1)
  if (error) return null
  const runs = (data ?? []) as { ran_at: string }[]
  const oldest = runs.length ? Date.parse(runs[0].ran_at) : null
  const retryAfterSeconds = oldest != null && Number.isFinite(oldest)
    ? Math.max(1, Math.ceil((oldest + RESOLUTION_WINDOW_SECONDS * 1000 - now.getTime()) / 1000))
    : RESOLUTION_WINDOW_SECONDS
  return { count: runs.length, retryAfterSeconds }
}

/** Claim a run slot BEFORE spending, so two concurrent presses cannot both pass
 * the window check. The row is completed with the real counters afterwards. */
async function claimRun(admin: Db, orgId: string, requested: number, ranAt: string) {
  const { data, error } = await admin.from('intel_holding_resolution_runs')
    .insert({ org_id: orgId, ran_at: ranAt, requested, priced: 0, credits: 0 })
    .select('id').maybeSingle()
  if (error) return null
  return (data as { id: string } | null)?.id ?? null
}

async function completeRun(admin: Db, runId: string | null, priced: number, credits: number) {
  if (!runId) return
  const { error } = await admin.from('intel_holding_resolution_runs').update({ priced, credits }).eq('id', runId)
  if (error) console.warn('[holding-identity] run ledger update failed', error.message)
}

/** Write the price the provider gave, and nothing else. EXACTLY these eight
 * columns: a resolve run is a pricing fact, not a general holding edit. */
async function writePricedHolding(admin: Db, orgId: string, answer: HoldingAnswer, nowIso: string) {
  const { error } = await admin.from('investor_portfolio_holdings').update({
    current_price: answer.cmcDexPrice,
    current_value: answer.value,
    price_source: 'coinmarketcap_dex',
    price_status: 'priced',
    last_priced_at: nowIso,
    provider: 'coinmarketcap',
    provider_network: answer.platform,
    provider_confidence: PROVIDER_CONFIDENCE_MEDIUM,
  }).eq('id', answer.holdingId).eq('org_id', orgId)
  return error ? String(error.message ?? 'write_failed') : null
}

/** The free-DEX fallback's own write. Same eight columns, same meaning, with
 * the answering DEX reader named in `provider` and its own `price_source` so
 * `unprice` can reverse it and nothing confuses it with a paid CMC DEX price. */
async function writeContractPricedHolding(admin: Db, orgId: string, answer: ContractPriceAnswer, nowIso: string) {
  const { error } = await admin.from('investor_portfolio_holdings').update({
    current_price: answer.price,
    current_value: answer.value,
    price_source: CONTRACT_DEX_PRICE_SOURCE,
    price_status: 'priced',
    // The time the answering source observed the quote, not the time we asked.
    last_priced_at: answer.observedAt || nowIso,
    provider: answer.provider,
    provider_network: answer.chain,
    provider_confidence: PROVIDER_CONFIDENCE_MEDIUM,
  }).eq('id', answer.holdingId).eq('org_id', orgId)
  return error ? String(error.message ?? 'write_failed') : null
}

/** An identity-only match fills a BLANK label and never overwrites one: the
 * member's own naming of a position outranks the provider's. */
async function writeIdentityOnly(admin: Db, orgId: string, answer: HoldingAnswer, row: HoldingIdentityRow | undefined) {
  const patch: Record<string, string> = {}
  const blank = (v: unknown) => typeof v !== 'string' || !v.trim()
  if (answer.name && blank(row?.name)) patch.name = answer.name
  if (answer.symbol && blank(row?.asset_symbol)) patch.asset_symbol = answer.symbol
  if (!Object.keys(patch).length) return null
  const { error } = await admin.from('investor_portfolio_holdings').update(patch).eq('id', answer.holdingId).eq('org_id', orgId)
  return error ? String(error.message ?? 'write_failed') : null
}

async function inBatches<T>(items: T[], size: number, run: (item: T) => Promise<string | null>): Promise<string[]> {
  const failures: string[] = []
  for (let i = 0; i < items.length; i += size) {
    const results = await Promise.all(items.slice(i, i + size).map(run))
    for (const failure of results) if (failure) failures.push(failure)
  }
  return failures
}

/**
 * The free DEX pass, for every holding the CoinMarketCap pass did not price.
 *
 * A contract CoinMarketCap does not index answered `not_found_on_provider` and
 * the position stayed blank in the book — while the asset page showed a price
 * for that exact mint seconds later, from the free readers. Those readers are
 * asked here, through the same contract identity path the asset page uses and
 * the same plausibility gate the paid pass uses, and they cost no CoinMarketCap
 * credit.
 *
 * Holdings the paid pass could not ask about AT ALL are included: "CoinMarketCap
 * does not list this chain" is not "this token has no price".
 */
async function contractFallbackPass(
  admin: Db, orgId: string, byId: Map<string, HoldingIdentityRow>,
  plan: { skipped: { holdingId: string; chain: string; reason: string }[] }, answers: HoldingAnswer[], nowIso: string,
  priceContracts: typeof priceContractHoldings,
) {
  const requests: ContractPriceRequest[] = []
  const asked = new Set<string>()
  const unpriced = new Set(['not_found_on_provider', 'price_unavailable'])
  const add = (holdingId: string, chain: string, address: string | null, quantity: unknown) => {
    if (!address || asked.has(holdingId)) return
    asked.add(holdingId)
    const row = byId.get(holdingId)
    requests.push({
      holdingId, chain, address,
      quantity: Number(quantity ?? NaN),
      // A row that is merely stale has been priced before, so the first-pricing
      // ceiling in the gate does not apply to it.
      wasUnpriced: row?.price_status !== 'stale',
    })
  }
  for (const answer of answers) {
    if (!unpriced.has(answer.reason)) continue
    add(answer.holdingId, answer.chain, answer.address, answer.quantity)
  }
  // `over_run_limit` is a holding this run deliberately left for the next one;
  // only a chain the paid endpoints cannot be asked about is picked up here.
  for (const skipped of plan.skipped) {
    if (skipped.reason !== 'unsupported_platform') continue
    const row = byId.get(skipped.holdingId)
    if (!row) continue
    add(skipped.holdingId, skipped.chain, holdingAddress(row), row.quantity)
  }

  const priced = requests.length
    ? await priceContracts(admin, requests, {
      supabase: admin, jobName: 'intel-portfolio-identity', caller: 'holding-contract-price',
    })
    : []
  const writeErrors = await inBatches(
    priced.filter((a) => a.reason === 'priced'), WRITE_CONCURRENCY,
    (a) => writeContractPricedHolding(admin, orgId, a, nowIso),
  )
  const summary = summarizeContractPrices(priced)
  return { summary, writeErrors, report: { ...summary, priceSource: CONTRACT_DEX_PRICE_SOURCE, holdings: priced } }
}

export async function runCoverage(admin: Db, orgId: string, portfolioId: string | null, now: Date) {
  const { rows, truncated } = await readOpenHoldings(admin, orgId, portfolioId)
  if (!rows) return json({ error: 'holdings_unavailable' }, 503)
  const coverage = coverageByChain(rows)
  return json({ op: 'coverage', ...coverage, truncated, asOf: now.toISOString() })
}

export async function runResolve(
  admin: Db, orgId: string, portfolioId: string | null, limit: number | null,
  request: typeof requestCmc, now: Date, priceContracts: typeof priceContractHoldings = priceContractHoldings,
) {
  const nowIso = now.toISOString()
  const { rows, truncated } = await readOpenHoldings(admin, orgId, portfolioId)
  if (!rows) return json({ error: 'holdings_unavailable' }, 503)

  const plan = planHoldingResolution(rows, limit == null ? {} : { limit })
  const empty = {
    op: 'resolve', requested: 0, matched: 0, priced: 0, identityOnly: 0, implausible: 0,
    unsupported: plan.unsupported, notFound: 0, credits: 0, creditsNote: CREDITS_NOTE,
    calls: 0, holdings: applyBatchAnswers(plan, [], []), truncated, planTruncated: plan.truncated,
    writeErrors: [] as string[], asOf: nowIso,
  }
  const byId = new Map(rows.map((row) => [String(row.id), row]))
  // Nothing to ask CoinMarketCap means nothing to spend and no run slot
  // consumed — but it does NOT mean nothing can be priced. A book that is all
  // contracts CoinMarketCap does not list used to end here with every position
  // blank; the free DEX pass still runs, and the skipped holdings are still
  // reported with the reason they could not be asked of the paid endpoints.
  if (!plan.subjects.length) {
    const fallback = await contractFallbackPass(admin, orgId, byId, plan, [], nowIso, priceContracts)
    return json({ ...empty, priced: fallback.summary.priced, contractDex: fallback.report, writeErrors: fallback.writeErrors })
  }

  const window = await resolutionWindow(admin, orgId, now)
  if (!window) return json({ error: 'resolution_rate_unavailable' }, 503)
  if (window.count >= RESOLUTION_RUNS_PER_HOUR) {
    return json({
      error: 'resolution_rate_limited', retryAfterSeconds: window.retryAfterSeconds,
      limit: RESOLUTION_RUNS_PER_HOUR, windowSeconds: RESOLUTION_WINDOW_SECONDS, runsInWindow: window.count,
    }, 429, { 'Retry-After': String(window.retryAfterSeconds) })
  }
  const runId = await claimRun(admin, orgId, plan.requested, nowIso)
  if (!runId) return json({ error: 'resolution_rate_unavailable' }, 503)

  const ctx = runContext(admin, plan.batchGroups.length + plan.priceGroups.length)
  const reasons: string[] = []
  const batchRows: unknown[] = []
  for (const group of plan.batchGroups) {
    const result = await request('dexBatch', cmcDexParams('dexBatch', null, { platform: group.platform, addresses: group.addresses }), ctx)
    if (result.reason) reasons.push(`dexBatch:${result.reason}`)
    batchRows.push(...dataArray(result.payload))
  }
  const priceRows: unknown[] = []
  for (const group of plan.priceGroups) {
    const result = await request('dexPriceBatch', cmcDexParams('dexPriceBatch', null, { tokens: group.tokens }), ctx)
    if (result.reason) reasons.push(`dexPriceBatch:${result.reason}`)
    priceRows.push(...dataArray(result.payload))
  }

  const answers = applyBatchAnswers(plan, batchRows, priceRows)
  const summary = summarizeAnswers(answers)

  // A refused price still carried a real identity, so a blank label is still
  // filled — but not one column of pricing is written for it.
  const identityOnly = answers.filter((a) => a.reason === 'price_unavailable' || a.reason === 'price_implausible')
  const writeErrors = [
    ...await inBatches(answers.filter((a) => a.reason === 'priced'), WRITE_CONCURRENCY, (a) => writePricedHolding(admin, orgId, a, nowIso)),
    ...await inBatches(identityOnly, WRITE_CONCURRENCY, (a) => writeIdentityOnly(admin, orgId, a, byId.get(a.holdingId))),
  ]
  const fallback = await contractFallbackPass(admin, orgId, byId, plan, answers, nowIso, priceContracts)
  writeErrors.push(...fallback.writeErrors)

  // One aggregate demand counter per matched contract, never per holding and
  // never with an actor: `intel_record_asset_demand` takes no user or org.
  const demanded = new Set<string>()
  for (const answer of answers) {
    if (!answer.matched) continue
    const key = `${answer.chain}:${answer.address}`
    if (demanded.has(key)) continue
    demanded.add(key)
    const { error } = await admin.rpc('intel_record_asset_demand', {
      p_asset_key: key, p_provider: 'coinmarketcap', p_provider_id: key,
    })
    if (error) console.warn('[holding-identity] demand not recorded', error.message)
  }

  const credits = Number(ctx._calls ?? 0)
  await completeRun(admin, runId, summary.priced, credits)

  return json({
    op: 'resolve',
    requested: plan.requested,
    matched: summary.matched,
    priced: summary.priced + fallback.summary.priced,
    // The free-DEX fallback, reported separately so a reader can see which
    // prices cost a credit and which did not.
    contractDex: fallback.report,
    identityOnly: summary.identityOnly,
    implausible: summary.implausible,
    unsupported: plan.unsupported,
    notFound: summary.notFound,
    credits,
    creditsNote: CREDITS_NOTE,
    calls: credits,
    estimatedCredits: plan.estimatedCredits,
    demandRecorded: demanded.size,
    providerReasons: [...new Set(reasons)],
    holdings: answers,
    truncated,
    planTruncated: plan.truncated,
    writeErrors,
    asOf: nowIso,
  })
}

/**
 * Undo this feature's own pricing for named holdings.
 *
 * Bounded to 50 ids, scoped to the caller's org, and restricted to rows whose
 * `price_source` is still `coinmarketcap_dex` — a holding that has since been
 * repriced by the exchange or Birdeye path belongs to that path and is left
 * alone, reported as skipped rather than silently reverted.
 *
 * It is recorded in the same ledger as a paid run (auditability) but is NOT
 * refused by the rate limit: an undo must always be available, or a member who
 * spent their four runs producing a bad price would be stuck with it for an
 * hour. It spends no credits and touches at most 50 rows.
 */
export async function runUnprice(admin: Db, orgId: string, holdingIds: string[], now: Date) {
  const nowIso = now.toISOString()
  const { data, error } = await admin.from('investor_portfolio_holdings').update({
    current_price: null,
    current_value: null,
    price_source: null,
    price_status: 'unpriced',
    last_priced_at: null,
  }).eq('org_id', orgId).in('price_source', UNDOABLE_PRICE_SOURCES).in('id', holdingIds).select('id')
  if (error) return json({ error: 'unprice_failed', detail: String(error.message ?? 'write_failed') }, 503)

  const reset = ((data ?? []) as { id: string }[]).map((row) => String(row.id))
  await claimRun(admin, orgId, holdingIds.length, nowIso)
  return json({
    op: 'unprice',
    requested: holdingIds.length,
    reset: reset.length,
    // Not an error: an id that is not this org's, or no longer priced by this
    // feature, is simply not ours to reset.
    skipped: holdingIds.length - reset.length,
    holdingIds: reset,
    priceSources: UNDOABLE_PRICE_SOURCES,
    priceSource: DEX_PRICE_SOURCE,
    asOf: nowIso,
  })
}

/** CMC ids in a `/v2/cryptocurrency/info` response. The payload is a map keyed
 * by id; a row's own `id` wins over the key when both are present. */
export function cmcIdsFromMetadata(payload: unknown): string[] {
  const data = (payload as { data?: unknown } | null)?.data
  if (!data || typeof data !== 'object') return []
  const entries = Array.isArray(data)
    ? data.map((row, i) => [String(i), row] as [string, unknown])
    : Object.entries(data as Record<string, unknown>)
  const ids = new Set<string>()
  for (const [key, value] of entries) {
    for (const row of Array.isArray(value) ? value : [value]) {
      const id = (row as { id?: unknown } | null)?.id
      const candidate = id != null ? String(id) : key
      if (/^[1-9][0-9]{0,11}$/.test(candidate)) ids.add(candidate)
    }
  }
  return [...ids]
}

export async function runEntities(admin: Db, orgId: string, request: typeof requestCmc, now: Date) {
  const nowIso = now.toISOString()
  const { data, error } = await admin.from('entities')
    .select('id,chain_namespace,chain_id,contract_address,asset_id,provider_ids,display_symbol')
    .eq('org_id', orgId).eq('entity_kind', 'asset').limit(ENTITY_ROW_LIMIT)
  if (error) return json({ error: 'entities_unavailable' }, 503)

  // deno-lint-ignore no-explicit-any
  const rows = (data ?? []) as any[]
  const candidates: { id: string; chain: string; platform: string; address: string; providerIds: Record<string, unknown> }[] = []
  for (const row of rows) {
    const providerIds = row.provider_ids && typeof row.provider_ids === 'object' && !Array.isArray(row.provider_ids)
      ? row.provider_ids as Record<string, unknown> : {}
    if (providerIds.coinmarketcap != null && String(providerIds.coinmarketcap).trim()) continue
    const namespace = typeof row.chain_namespace === 'string' ? row.chain_namespace.trim().toLowerCase() : ''
    if (!namespace) continue
    // Entities key a chain as namespace + reference; only eip155 carries a numeric
    // reference that matters to the verified list. Anything else stays unsupported.
    const chain = namespace === 'eip155' ? `eip155:${String(row.chain_id ?? '').trim()}` : namespace
    const platform = cmcPlatformForChain(chain)
    if (!platform) continue
    const raw = [row.contract_address, row.asset_id].find((v) => typeof v === 'string' && v.trim())
    if (!raw || !cmcDexAddress(String(raw).trim(), platform)) continue
    candidates.push({ id: String(row.id), chain, platform, address: canonicalAddress(String(raw).trim(), platform), providerIds })
  }

  const selected = candidates.slice(0, ENTITY_LOOKUP_MAX)
  const ctx = runContext(admin, selected.length)
  const results: { entityId: string; chain: string; address: string; cmcId: string | null; reason: string }[] = []
  let updated = 0

  for (const entity of selected) {
    const result = await request('metadata', { address: entity.address }, ctx)
    const ids = cmcIdsFromMetadata(result.payload)
    if (!ids.length) { results.push({ entityId: entity.id, chain: entity.chain, address: entity.address, cmcId: null, reason: result.reason ? `provider_${result.reason}` : 'not_found_on_provider' }); continue }
    // Two ids for one address is an ambiguity, not a choice to make silently.
    if (ids.length > 1) { results.push({ entityId: entity.id, chain: entity.chain, address: entity.address, cmcId: null, reason: 'ambiguous_provider_id' }); continue }
    const { error: writeError } = await admin.from('entities')
      .update({ provider_ids: { ...entity.providerIds, coinmarketcap: ids[0] } })
      .eq('id', entity.id).eq('org_id', orgId)
    if (writeError) { results.push({ entityId: entity.id, chain: entity.chain, address: entity.address, cmcId: ids[0], reason: 'write_failed' }); continue }
    updated++
    results.push({ entityId: entity.id, chain: entity.chain, address: entity.address, cmcId: ids[0], reason: 'linked' })
  }

  return json({
    op: 'entities',
    examined: rows.length,
    eligible: candidates.length,
    requested: selected.length,
    updated,
    ambiguous: results.filter((r) => r.reason === 'ambiguous_provider_id').length,
    notFound: results.filter((r) => r.reason.startsWith('not_found') || r.reason.startsWith('provider_')).length,
    deferred: Math.max(0, candidates.length - selected.length),
    credits: Number(ctx._calls ?? 0),
    creditsNote: 'metadata is 1 credit per 250 identifiers; one address lookup is one identifier, so one credit per entity examined.',
    entities: results,
    asOf: nowIso,
  })
}

export async function handlePortfolioIdentity(
  req: Request,
  clientFactory: typeof createClient = createClient,
  deps: IdentityDeps = {},
): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: { ...corsHeaders, 'Access-Control-Max-Age': '600' } })
  const request = deps.request ?? requestCmc
  const now = deps.now ? deps.now() : new Date()
  try {
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
    if (!req.headers.get('Authorization')) return json({ error: 'unauthorized' }, 401)
    const admin = clientFactory(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const body = await req.json().catch(() => ({})) as Record<string, unknown>

    const orgId = typeof body.orgId === 'string' ? body.orgId : null
    if (!orgId || !UUID.test(orgId)) return json({ error: 'invalid_org' }, 400)
    // Verifies the user, then organization membership, then the Intel entitlement.
    await requireIntelAccess(req, clientFactory, admin, orgId)

    const portfolioId = body.portfolioId == null ? null : String(body.portfolioId)
    if (portfolioId != null && !UUID.test(portfolioId)) return json({ error: 'invalid_portfolio' }, 400)

    let limit: number | null = null
    if (body.limit != null) {
      const value = Number(body.limit)
      if (!Number.isFinite(value) || value < 1 || value > HOLDING_RUN_LIMIT_MAX) return json({ error: 'invalid_limit' }, 400)
      limit = Math.floor(value)
    }

    const op = typeof body.op === 'string' ? body.op : 'coverage'
    if (op === 'coverage') return await runCoverage(admin, orgId, portfolioId, now)
    if (op === 'resolve') return await runResolve(admin, orgId, portfolioId, limit, request, now, deps.priceContracts ?? priceContractHoldings)
    if (op === 'unprice') {
      const raw = Array.isArray(body.holdingIds) ? body.holdingIds : null
      if (!raw || !raw.length) return json({ error: 'invalid_holding_ids' }, 400)
      const ids = [...new Set(raw.map((v) => String(v)))]
      if (ids.length > UNPRICE_MAX || !ids.every((id) => UUID.test(id))) return json({ error: 'invalid_holding_ids' }, 400)
      return await runUnprice(admin, orgId, ids, now)
    }
    if (op === 'entities') {
      // An entities run spends one credit per entity, so it shares the resolve
      // window: four paid runs an hour for the organisation, whichever op.
      const window = await resolutionWindow(admin, orgId, now)
      if (!window) return json({ error: 'resolution_rate_unavailable' }, 503)
      if (window.count >= RESOLUTION_RUNS_PER_HOUR) {
        return json({
          error: 'resolution_rate_limited', retryAfterSeconds: window.retryAfterSeconds,
          limit: RESOLUTION_RUNS_PER_HOUR, windowSeconds: RESOLUTION_WINDOW_SECONDS, runsInWindow: window.count,
        }, 429, { 'Retry-After': String(window.retryAfterSeconds) })
      }
      const runId = await claimRun(admin, orgId, 0, now.toISOString())
      if (!runId) return json({ error: 'resolution_rate_unavailable' }, 503)
      const response = await runEntities(admin, orgId, request, now)
      const payload = await response.clone().json().catch(() => ({})) as Record<string, unknown>
      await completeRun(admin, runId, 0, Number(payload.credits ?? 0))
      return response
    }
    return json({ error: 'invalid_op' }, 400)
  } catch (e) {
    const denied = orgAuthzErrorResponse(e, corsHeaders)
    if (denied) return denied
    return json({ error: (e as Error)?.message || 'portfolio_identity_failed' }, 500)
  }
}

if (import.meta.main) Deno.serve((req) => handlePortfolioIdentity(req))
