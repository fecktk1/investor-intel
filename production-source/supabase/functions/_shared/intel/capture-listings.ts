// Investor Intel — new-listing due diligence capture lane (CMC plan proposal 21).
//
// Same contract as `capture-jobs.ts` and the Stage 3 lanes: one function per
// lane, bounded by an explicit call ceiling, obeying `provider_schedule_policy`
// (a disabled feature is skipped with `policy_disabled`, a run inside the
// feature's cadence with `within_cadence`), never throwing — a failure becomes
// `{ error }` on the result. Nothing here calls CoinMarketCap directly: the
// transport is injected as `deps.request`, so the module tests without a network
// or a database.
//
// What one daily run does:
//   1. ONE `newListings` page (`{start:1, limit:100}`) — the whole captured
//      universe of newly listed assets for the day, 1 credit.
//   2. Joins each row to a contract on a CMC DEX VERIFIED chain (ethereum, base,
//      arbitrum, solana — `CMC_DEX_NETWORKS`), through `cmcDexIdentity` so the
//      stored address is the same canonical form every other DEX surface uses.
//   3. For at most `DUE_DILIGENCE_PER_RUN` of those joined rows, `dexSecurity`
//      and `dexHolderCount` — 2 credits a row.
//
// Upper bound for a run: 1 + 25 x 2 = 51 credits. The shared transport serves a
// still-fresh cached snapshot for 0 credits, so the billed total is never higher.
//
// HONESTY RULES this lane keeps:
//   * A listing with no contract on a verified chain is STILL stored, with
//     `security_state = 'no_contract_on_verified_chain'` and null holder count
//     and security. It is a listing we saw, not a listing we can inspect.
//   * A joined row the per-run cap could not reach is stored with
//     `security_state = 'due_diligence_budget'` — pending, never "clean".
//   * A security or holder call that fails leaves NULLS and records the provider
//     reason as the state. An unknown holder count is never a zero.
//   * Only whitelisted security fields are stored, and the one free-text field
//     (an item description) is capped at 200 characters.
//
// The helpers `capture-jobs.ts` does not export (num/int/text, dedupe, upsert,
// newestAt, guardJob, failed) are copied here verbatim from `capture-categories.ts`
// rather than changing that module: other capture lanes are being added
// concurrently against it.

import { cmcRows, planAllows, estimateCmcCredits } from '../market-assets/cmc-capabilities.ts'
import { CMC_DEX_NETWORKS, cmcDexIdentity, cmcDexInteger } from '../market-assets/cmc-dex.ts'
import type { MarketAssetsContext } from '../market-assets/types.ts'
import { CAPTURE_PROVIDER, utcDate, iso, schedulePolicy } from './capture-jobs.ts'
import type { CaptureDeps, JobResult } from './capture-jobs.ts'
import { stableJson, digest } from './investigation-evidence.ts'

/** One page IS the captured universe for the day. `/v1/cryptocurrency/listings/new`
 * is priced per 250 rows, and `cmcRows` truncates a page at 250, so 100 rows is
 * the same single credit a 250-row page would cost while staying well inside the
 * number of listings a day actually produces. */
export const NEW_LISTING_LIMIT = 100
/** Security + holder count is 2 credits a row. 25 rows a day is the whole
 * due-diligence budget for this lane: 50 credits against the 1,000/month
 * `structure` feature cap, which the holder-tag and venue lanes also bill. */
export const DUE_DILIGENCE_PER_RUN = 25
/** At most this many reported security items are retained per row. */
export const SECURITY_ITEM_MAX = 50

const CADENCE_GRACE = 0.9
const MAX_UPSERT_ROWS = 500
/** Cadence a lane falls back to when its `provider_schedule_policy` row is
 * missing. `schedulePolicy` defaults an unknown feature to one hour, which for
 * this lane would be 51 credits AN HOUR, so it carries its own designed daily
 * cadence and only takes the table's when a row exists. */
const LANE_CADENCE: Record<string, number> = { listings: 86400 }

function lanePolicy(deps: CaptureDeps, feature: string): { enabled: boolean; cadenceSeconds: number } {
  const row = (deps.policy || []).find((r) => r?.feature === feature && (r.provider ?? CAPTURE_PROVIDER) === CAPTURE_PROVIDER)
  if (!row) return { enabled: true, cadenceSeconds: LANE_CADENCE[feature] ?? 3600 }
  const policy = schedulePolicy(deps.policy, feature)
  return { enabled: policy.enabled, cadenceSeconds: policy.cadenceSeconds }
}

const num = (v: unknown): number | null => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const text = (v: unknown, max = 200): string | null => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null }
/** true / false / unknown. A flag the provider did not report is null, never false. */
const flag = (v: unknown): boolean | null => (v === true || v === 1 || v === '1' ? true : v === false || v === 0 || v === '0' ? false : null)

/** Newest value of a timestamp column, or null when the table is empty or the
 * read failed. A failed read never blocks a capture: the write is idempotent. */
// deno-lint-ignore no-explicit-any
async function newestAt(db: any, table: string, column: string, filters: [string, unknown][] = []): Promise<number | null> {
  try {
    let q = db.from(table).select(column)
    for (const [key, value] of filters) q = q.eq(key, value)
    const { data, error } = await q.order(column, { ascending: false }).limit(1)
    if (error) return null
    const row = Array.isArray(data) ? data[0] : data
    const parsed = Date.parse(String(row?.[column] ?? ''))
    return Number.isFinite(parsed) ? parsed : null
  } catch { return null }
}

// deno-lint-ignore no-explicit-any
async function guardJob(db: any, job: string, feature: string, deps: CaptureDeps, now: Date,
  freshness: { table: string; column: string; filters?: [string, unknown][] }): Promise<JobResult | null> {
  const policy = lanePolicy(deps, feature)
  if (!policy.enabled) return { job, rows: 0, credits: 0, skipped: 'policy_disabled' }
  const newest = await newestAt(db, freshness.table, freshness.column, freshness.filters || [])
  if (newest != null && now.getTime() - newest < policy.cadenceSeconds * 1000 * CADENCE_GRACE) {
    return { job, rows: 0, credits: 0, skipped: 'within_cadence', newestAt: new Date(newest).toISOString() }
  }
  return null
}

/** Primary keys reject a duplicate inside one statement, so a provider page that
 * repeats an identity is collapsed to its last occurrence before the write. */
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

/** How many provider calls this context permits. A context with no explicit
 * budget still runs the lane's own ceiling; it never runs unbounded. */
const callBudget = (ctx: MarketAssetsContext, ceiling: number): number => {
  const budget = Number(ctx?.maxCalls)
  return Math.max(0, Math.min(ceiling, Number.isFinite(budget) && budget >= 0 ? Math.trunc(budget) : ceiling))
}

// ─── Platform join ────────────────────────────────────────────────────────────

/** CMC platform slugs that name a chain this platform has verified DEX evidence
 * for under a different spelling. Deliberately tiny: `arbitrum-nova` is a
 * DIFFERENT chain (eip155:42170) and must never fold onto `arbitrum`. */
export const LISTING_PLATFORM_ALIASES: Record<string, string> = { 'arbitrum-one': 'arbitrum' }

/** The contract identity of a new-listing row, or null when the row names no
 * contract on one of the four verified CMC DEX chains.
 *
 * The slug (or, failing that, the platform name) is authoritative. `platform.id`
 * on a listings payload is the CoinMarketCap id of the platform's OWN COIN — not
 * a CMC DEX platform id — so a numeric match against `CMC_DEX_NETWORKS` is only
 * trusted when the row reported no usable slug or name at all. Mapping 1 onto
 * "ethereum" for a row whose platform really is CMC asset 1 would be an invented
 * chain, and this lane never invents one. */
export function listingDexIdentity(platform: unknown): ReturnType<typeof cmcDexIdentity> {
  const row = platform && typeof platform === 'object' && !Array.isArray(platform) ? platform as Record<string, unknown> : null
  if (!row) return null
  const address = text(row.token_address, 200)
  if (!address) return null
  const raw = String(row.slug ?? row.name ?? '').trim().toLowerCase().replace(/\s+/g, '-')
  const slug = LISTING_PLATFORM_ALIASES[raw] ?? raw
  let network = slug ? CMC_DEX_NETWORKS.find((n) => n.platform === slug) ?? null : null
  if (!network && !slug) network = CMC_DEX_NETWORKS.find((n) => String(n.platformId) === String(row.id ?? '')) ?? null
  if (!network) return null
  // `cmcDexIdentity` is the single gate: it lower-cases an EVM address, checks
  // the base58 shape of a Solana mint and rejects anything else outright.
  return cmcDexIdentity(`${network.chain}:${address}`)
}

// ─── Security document ────────────────────────────────────────────────────────

/** The reviewed `/v1/dex/security/detail` document, reduced to the fields the
 * platform already reads elsewhere (`contract-research.ts` view `security`):
 * coverage (`exist`), the provider's own classification (`securityLevel`) and
 * its item list (`code`, `isHit`, `riskyLevel`, `des`).
 *
 * Everything else the provider may send is dropped: this table is not a mirror
 * of the endpoint. Item descriptions are the only free text and are capped at
 * 200 characters. Items are keyed by code, last occurrence wins, and the list is
 * sorted by code so the canonical form — and therefore the hash — cannot change
 * because the provider reordered its response. */
export function securityDocument(raw: unknown): Record<string, unknown> | null {
  const row = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null
  if (!row) return null
  const byCode = new Map<string, Record<string, unknown>>()
  // deno-lint-ignore no-explicit-any
  for (const item of (Array.isArray(row.securityItems) ? row.securityItems : []) as any[]) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const code = text(item.code, 60)
    if (!code) continue
    byCode.set(code, { code, hit: flag(item.isHit), level: num(item.riskyLevel) ?? text(item.riskyLevel, 40), description: text(item.des, 200) })
  }
  const items = [...byCode.values()].sort((a, b) => String(a.code).localeCompare(String(b.code))).slice(0, SECURITY_ITEM_MAX)
  return { exists: flag(row.exist), level: num(row.securityLevel) ?? text(row.securityLevel, 40), items }
}

/** How many of the reported items the provider marked as hit. An item whose hit
 * state is unknown is NOT counted: absence of a recorded flag is not a clean
 * contract, and this number never pretends otherwise. */
export function securityFlagCount(document: unknown): number | null {
  const doc = document && typeof document === 'object' ? document as Record<string, unknown> : null
  if (!doc || !Array.isArray(doc.items)) return null
  // deno-lint-ignore no-explicit-any
  return (doc.items as any[]).filter((item) => item?.hit === true).length
}

/** SHA-256 over the canonical whitelisted document. `stableJson` sorts object
 * keys recursively and `securityDocument` sorts the item list, so two responses
 * that differ only in key or item ORDER hash identically — which is what makes
 * "the hash changed" mean "the reported flags changed". */
export function securityHash(document: unknown): Promise<string> {
  return digest(stableJson(document))
}

// ─── The lane ─────────────────────────────────────────────────────────────────

/** A listing row reduced to the columns the table holds, before due diligence. */
// deno-lint-ignore no-explicit-any
export function newListingRow(row: any, snapshotDate: string, capturedAt: string): Record<string, unknown> | null {
  const providerId = row?.id == null ? null : String(row.id)
  if (!providerId || providerId === 'null') return null
  const identity = listingDexIdentity(row?.platform)
  const quote = row?.quote && typeof row.quote === 'object' ? row.quote as Record<string, unknown> : {}
  return {
    provider: CAPTURE_PROVIDER, provider_id: providerId, snapshot_date: snapshotDate,
    symbol: text(row?.symbol, 50), name: text(row?.name, 200), slug: text(row?.slug, 200),
    date_added: iso(row?.date_added),
    chain: identity?.chain ?? null, contract_address: identity?.address ?? null,
    price: num(quote.price), market_cap: num(quote.market_cap),
    volume_24h: num(quote.volume_24h), change_24h_pct: num(quote.percent_change_24h),
    holder_count: null, security: null, security_hash: null,
    security_state: identity ? 'due_diligence_budget' : 'no_contract_on_verified_chain',
    captured_at: capturedAt,
  }
}

/** Daily new-listing capture with bounded per-row due diligence.
 *
 * `newListings` is a Startup capability. Below Startup the lane is skipped with
 * `plan_below_startup` and never spends a call to discover that, exactly the way
 * `network_stats` handles Growth. */
// deno-lint-ignore no-explicit-any
export async function captureNewListings(db: any, ctxFor: (name: string, maxCalls: number) => MarketAssetsContext,
  now = new Date(), plan = 'basic', deps: CaptureDeps): Promise<JobResult> {
  const job = 'new_listings'
  let credits = 0
  try {
    if (!planAllows(plan, 'startup')) return { job, rows: 0, credits: 0, skipped: 'plan_below_startup' }
    const skip = await guardJob(db, job, 'listings', deps, now, { table: 'intel_new_listing_snapshots', column: 'captured_at' })
    if (skip) return skip
    const ceiling = 1 + DUE_DILIGENCE_PER_RUN * 2
    const ctx = ctxFor('new-listings', ceiling)
    const budget = callBudget(ctx, ceiling)
    if (budget < 1) return { job, rows: 0, credits: 0, skipped: 'call_budget' }

    const listingParams = { start: 1, limit: NEW_LISTING_LIMIT }
    credits += estimateCmcCredits('newListings', { start: '1', limit: String(NEW_LISTING_LIMIT) })
    const page = await deps.request('newListings', listingParams, ctx).catch(() => null)
    if (!page?.payload) return { job, rows: 0, credits, error: page?.reason || 'provider_unavailable' }

    const capturedAt = new Date(now instanceof Date ? now.getTime() : now).toISOString()
    const snapshotDate = utcDate(now)
    const rows = dedupe(
      cmcRows('newListings', page.payload).rows
        .map((row: Record<string, unknown>) => newListingRow(row, snapshotDate, capturedAt))
        .filter((row): row is Record<string, unknown> => !!row),
      (r) => String(r.provider_id),
    )
    if (!rows.length) return { job, rows: 0, credits, snapshotDate, skipped: 'no_reported_listings' }

    // Newest listing first, then by id, so the 25 rows a run inspects are a
    // deterministic choice and not whatever order the provider happened to send.
    const candidates = rows.filter((row) => !!row.contract_address)
      .sort((a, b) => String(b.date_added ?? '').localeCompare(String(a.date_added ?? '')) || String(a.provider_id).localeCompare(String(b.provider_id)))
    const inspected = candidates.slice(0, DUE_DILIGENCE_PER_RUN)

    let calls = 1, reason: string | null = null, secured = 0, holders = 0
    for (const row of inspected) {
      const identity = cmcDexIdentity(`${row.chain}:${row.contract_address}`)
      if (!identity) { row.security_state = 'invalid_contract_identity'; continue }
      if (calls + 2 > budget) { reason = reason || 'call_budget'; break }

      calls += 1
      credits += estimateCmcCredits('dexSecurity', {})
      const security = await deps.request('dexSecurity', { platformName: identity.platform, address: identity.address }, ctx).catch(() => null)
      if (!security?.payload) {
        row.security_state = text(security?.reason, 60) || 'provider_unavailable'
        reason = reason || row.security_state as string
      } else {
        // The registry documents the response as an array of at most one entry.
        const data = security.payload?.data ?? security.payload
        const document = securityDocument(Array.isArray(data) ? data[0] : data)
        if (!document) {
          row.security_state = 'no_security_record'
        } else {
          row.security = document
          row.security_hash = await securityHash(document)
          row.security_state = 'captured'
          secured += 1
        }
      }

      calls += 1
      credits += estimateCmcCredits('dexHolderCount', {})
      const count = await deps.request('dexHolderCount', { platform: identity.platform, tokenAddress: identity.address }, ctx).catch(() => null)
      if (count?.payload) {
        const data = count.payload?.data ?? count.payload
        // A holder count we could not read stays NULL. Zero is a real answer and
        // is stored as zero; it is never used to stand in for "unknown".
        const value = cmcDexInteger((Array.isArray(data) ? data[0] : data)?.count)
        if (value != null) { row.holder_count = value; holders += 1 }
      } else reason = reason || text(count?.reason, 60) || 'provider_unavailable'
    }

    const pending = candidates.length - inspected.length + inspected.filter((row) => row.security_state === 'due_diligence_budget').length
    if (pending > 0) reason = reason || 'due_diligence_budget'
    const written = await upsert(db, 'intel_new_listing_snapshots', rows, 'provider,provider_id,snapshot_date')
    return {
      job, rows: written.rows, credits, snapshotDate, capturedAt, calls,
      listings: rows.length, withContract: candidates.length, inspected: inspected.length,
      secured, holderCounts: holders, pendingDueDiligence: pending,
      ...(reason ? { partial: reason } : {}), ...(written.error ? { error: written.error } : {}),
    }
  } catch (e) { return failed(job, credits, e) }
}

/** Integration surface. The `intel-capture` Edge Function maps an op name onto
 * one of these; the reviewer wires them in alongside the other lanes. */
export const LISTING_CAPTURE_OPS: Record<string, (
  // deno-lint-ignore no-explicit-any
  admin: any, ctxFor: (name: string, maxCalls: number) => MarketAssetsContext, now: Date, plan: string, deps: CaptureDeps
) => Promise<JobResult>> = {
  new_listings: (admin, ctxFor, now, plan, deps) => captureNewListings(admin, ctxFor, now, plan, deps),
}
