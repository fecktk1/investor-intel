// Investor Intel — holder tags and cohort PnL capture (CMC plan proposal 20).
//
// Same contract as `capture-jobs.ts`, `capture-venues.ts` and `capture-listings.ts`:
// one function per lane, bounded by an explicit call ceiling, never throwing (a
// failure becomes `{ error }` on the result), and injecting the transport as
// `deps.request` so the module tests without a network or a database.
//
// What ONE capture does, for ONE contract on one of the four verified CMC DEX
// chains (ethereum, base, arbitrum, solana):
//   1. ONE `dexHolderTags` call — `/v1/dex/holders/tag_count`, 1 credit. It
//      answers with at most the eight `CMC_HOLDER_TAGS` rows `{tag,hc,tb,hr}`.
//   2. ONE `dexHolders` call — `/v1/dex/holders/list`, 1 credit — for each tag
//      whose reported holder count `hc` is GREATER THAN ZERO. A tag with no
//      holders is not asked about: there is nothing to list, and a call that can
//      only return an empty page is a credit spent on nothing.
//
// Upper bound for one capture: 1 + 8 = 9 credits, and only when all eight tags
// are populated. The shared transport serves a still-fresh cached snapshot for 0
// credits, so the billed total is never higher.
//
// ONE PAGE ONLY. `dexHolders` is asked for `limit` 50 rows per tag and the
// `lastId` cursor it returns is deliberately NOT followed. The stored cohort is
// therefore "the first page the provider returned for this tag", never "every
// address holding this token", and the read view says so. Paginating eight tags
// would multiply this lane's cost by the page count with no ceiling the provider
// publishes in advance.
//
// THE CLOCK IS OURS. Neither endpoint publishes an observation time: the
// provider never says when a classification, a balance or a realized gain was
// computed. `captured_at` is the hour WE asked, truncated to the hour, and both
// tables and the documentation say exactly that. Truncating makes a retried or
// double-clicked refresh inside the same hour land on the same primary key
// instead of inventing a second "measurement" of the same unchanged board.
//
// PRIVACY. Wallet rows keep ADDRESSES ONLY. No ENS name, no exchange label, no
// social handle, no clustering, no ownership claim, and no field anywhere in
// this lane may name or describe a person. CMC's tags are CMC's labels for
// addresses; `tag_kol`, `tag_dev` and `tag_insider` are provider
// classifications of an address, not statements about a human being. Every
// other field the provider sends about a holder is dropped by
// `cmcRows('dexHolders')` before it reaches this module.
//
// The small helpers (num/text, upsert, callBudget) are copied from
// `capture-listings.ts` rather than exported from `capture-jobs.ts`: other
// capture lanes are being added against that module concurrently.

import { cmcRows, planAllows, estimateCmcCredits } from '../market-assets/cmc-capabilities.ts'
import { CMC_HOLDER_TAGS, cmcDexAddress, cmcDexInteger, cmcDexNumber, cmcDexParams, type CmcDexIdentity } from '../market-assets/cmc-dex.ts'
import type { MarketAssetsContext } from '../market-assets/types.ts'
import { CAPTURE_PROVIDER, hourBucket, iso } from './capture-jobs.ts'
import type { CaptureRequest, SchedulePolicyRow } from './capture-jobs.ts'

/** Rows of `/v1/dex/holders/list` asked for per tag. One page, no cursor. */
export const HOLDER_COHORT_PER_TAG = 50
/** The `provider_schedule_policy` feature this lane answers to. There is NO cron
 * job: capture is on demand from the contract workspace. The policy row exists
 * only so an operator can switch the lane off, and as the cadence floor below. */
export const HOLDER_TAG_FEATURE = 'holder_tags'
export const HOLDER_TAG_TABLE = 'intel_holder_tag_snapshots'
export const HOLDER_COHORT_TABLE = 'intel_holder_cohort_snapshots'
/** Written rows per statement, matching the other capture lanes. */
const MAX_UPSERT_ROWS = 500

export interface HolderTagRow { tag: string; holderCount: number | null; balance: number | null; ratio: number | null }
export interface HolderTagCapture {
  capturedAt: string
  tags: HolderTagRow[]
  cohortRows: number
  credits: number
  calls?: number
  skipped?: string
  partial?: string
  error?: string
}
export interface HolderTagDeps {
  request: CaptureRequest
  policy?: SchedulePolicyRow[]
  /** Optional evidence sink. Called ONCE, with the successful `dexHolderTags`
   * response, so the caller can run the shared `normalizeCmcInvestigation` path
   * and retain `holder_tag_count` observations. It is never called for
   * `dexHolders`: a wallet list is not evidence about the token, it is a page of
   * addresses that lives in this lane's own table and nowhere else. */
  // deno-lint-ignore no-explicit-any
  record?: (capability: string, params: Record<string, unknown>, response: any) => Promise<void> | void
}
export interface HolderTagOptions {
  tags?: string[]
  perTag?: number
  now?: Date | number
  /** When present, the lane refuses below Startup instead of spending a call to
   * find out. When absent the caller has already gated (the research view does). */
  plan?: string | null
}

const num = (v: unknown): number | null => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const text = (v: unknown, max = 200): string | null => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null }
const reason = (v: unknown, fallback: string): string => text(v, 60) || fallback

/** An address is stored in the same canonical form every other DEX surface uses:
 * lower-case for EVM, exact base58 for Solana. An address that is not valid for
 * the requested chain is dropped — an unusable identity is not a holder. */
export function cohortAddress(value: unknown, platform: string): string | null {
  if (!cmcDexAddress(value, platform)) return null
  const address = String(value)
  return platform === 'solana' ? address : address.toLowerCase()
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

/** How many provider calls this context permits. A context with no explicit
 * budget still runs the lane's own ceiling; it never runs unbounded. */
const callBudget = (ctx: MarketAssetsContext, ceiling: number): number => {
  const budget = Number(ctx?.maxCalls)
  return Math.max(0, Math.min(ceiling, Number.isFinite(budget) && budget >= 0 ? Math.trunc(budget) : ceiling))
}

/** The lane is enabled unless an operator disabled its policy row. A missing row
 * means enabled: this lane has no cron schedule to run away with. */
function lanePolicy(deps: HolderTagDeps): { enabled: boolean } {
  const row = (deps.policy || []).find((r) => r?.feature === HOLDER_TAG_FEATURE && (r.provider ?? CAPTURE_PROVIDER) === CAPTURE_PROVIDER)
  return { enabled: row ? row.enabled !== false : true }
}

/** Is there already a tag snapshot for this contract in this hour? A capture is
 * idempotent within its hour, so a second refresh inside the same hour is a skip
 * and not a second set of credits. A FAILED read never blocks the capture: the
 * write is an upsert keyed on the hour, so the worst case is a rewrite of rows
 * that are already there. */
// deno-lint-ignore no-explicit-any
async function capturedThisHour(db: any, chain: string, address: string, capturedAt: string): Promise<boolean> {
  try {
    const { data, error } = await db.from(HOLDER_TAG_TABLE).select('tag')
      .eq('chain', chain).eq('contract_address', address).eq('captured_at', capturedAt).limit(1)
    if (error) return false
    return Array.isArray(data) ? data.length > 0 : !!data
  } catch { return false }
}

/** Capture the tag board and, for every populated tag, one page of its cohort.
 *
 * Returns what the capture DID, never a promise about what is true on chain:
 * `tags` is the board as reported, `cohortRows` the number of address rows
 * written, `credits` the upper bound of provider calls this run issued. */
export async function captureHolderTags(
  // deno-lint-ignore no-explicit-any
  admin: any,
  identity: CmcDexIdentity,
  ctxFor: (name: string, maxCalls: number) => MarketAssetsContext,
  deps: HolderTagDeps,
  options: HolderTagOptions = {},
): Promise<HolderTagCapture> {
  const requested = Array.isArray(options.tags) ? options.tags : CMC_HOLDER_TAGS
  // Only tags the registry knows: `cmcParams` rejects anything else anyway, and
  // an unknown tag must fail before a call is spent, not after.
  const tags = requested.filter((tag) => CMC_HOLDER_TAGS.includes(tag))
  const perTag = Math.max(1, Math.min(HOLDER_COHORT_PER_TAG, Math.trunc(Number(options.perTag)) || HOLDER_COHORT_PER_TAG))
  const capturedAt = hourBucket(options.now ?? Date.now())
  const empty = (extra: Partial<HolderTagCapture>): HolderTagCapture => ({ capturedAt, tags: [], cohortRows: 0, credits: 0, ...extra })
  let credits = 0
  try {
    if (!identity) return empty({ error: 'missing_identifier' })
    if (typeof options.plan === 'string' && !planAllows(options.plan, 'startup')) return empty({ skipped: 'plan_below_startup' })
    if (!lanePolicy(deps).enabled) return empty({ skipped: 'policy_disabled' })
    if (!tags.length) return empty({ skipped: 'no_requested_tags' })
    if (await capturedThisHour(admin, identity.chain, identity.address, capturedAt)) return empty({ skipped: 'within_cadence' })

    const ceiling = 1 + tags.length
    const ctx = ctxFor('holder-tags', ceiling)
    const budget = callBudget(ctx, ceiling)
    if (budget < 1) return empty({ skipped: 'call_budget' })

    const boardParams = cmcDexParams('dexHolderTags', identity)
    credits += estimateCmcCredits('dexHolderTags', {})
    const board = await deps.request('dexHolderTags', boardParams, ctx).catch(() => null)
    if (!board?.payload) return empty({ credits, calls: 1, error: reason(board?.reason, 'provider_unavailable') })
    // The evidence path runs on the BOARD only, and only when it succeeded.
    try { await deps.record?.('dexHolderTags', boardParams, board) } catch { /* evidence is never allowed to lose a capture */ }

    // `cmcRows` has already whitelisted the four fields and bounded the page at
    // the eight known tags. A row with no readable count is dropped: unknown is
    // not zero, and a null count cannot decide whether to spend a holders call.
    const board_rows = cmcRows('dexHolderTags', board.payload).rows
      .map((r: Record<string, unknown>) => ({
        tag: text(r.tag, 60),
        holderCount: cmcDexInteger(r.hc),
        balance: cmcDexNumber(r.tb),
        ratio: cmcDexNumber(r.hr),
      }))
      .filter((r): r is HolderTagRow & { tag: string } => !!r.tag && tags.includes(r.tag) && r.holderCount != null)
    // Provider order is not our order: iterate the REQUESTED tag order so the
    // calls a run issues, and the rows it writes, are deterministic.
    const byTag = new Map(board_rows.map((r) => [r.tag, r]))
    const tagRows = tags.map((tag) => byTag.get(tag)).filter((r): r is HolderTagRow & { tag: string } => !!r)
    if (!tagRows.length) return empty({ credits, calls: 1, skipped: 'no_reported_tags' })

    const tagWrites = tagRows.map((r) => ({
      chain: identity.chain, contract_address: identity.address, captured_at: capturedAt, tag: r.tag,
      holder_count: r.holderCount, balance: r.balance, ratio: r.ratio,
      // The provider states no unit for `hr`: fraction versus percent is
      // unconfirmed, so the column records that it is unknown rather than
      // relabelling the number. `cmc-dex.ts` documents the same for the validator.
      ratio_unit: 'unknown',
    }))

    let calls = 1
    let partial: string | null = null
    const cohortWrites: Record<string, unknown>[] = []
    for (const row of tagRows) {
      // A tag with no holders has no cohort to list. Not a failure, not a call.
      if (!row.holderCount || row.holderCount <= 0) continue
      if (calls + 1 > budget) { partial = partial || 'call_budget'; break }
      calls += 1
      const holderParams = cmcDexParams('dexHolders', identity, { tag: row.tag, limit: perTag })
      credits += estimateCmcCredits('dexHolders', { limit: String(perTag) })
      const page = await deps.request('dexHolders', holderParams, ctx).catch(() => null)
      if (!page?.payload) { partial = partial || reason(page?.reason, 'provider_unavailable'); continue }
      // No pagination: `cmcRows` reports `nextCursor` from `data.lastId` and this
      // lane deliberately ignores it. One page per tag, stated as one page.
      const seen = new Set<string>()
      // The provider ignores `limit` and returns the whole tag (253 rows for one
      // KOL tag on 2026-09-15); the requested page size is applied here, so the
      // stored cohort stays the one page this lane states it keeps.
      for (const holder of cmcRows('dexHolders', page.payload, Object.fromEntries(Object.entries(holderParams).map(([k, v]) => [k, String(v)]))).rows) {
        const wallet = cohortAddress(holder.walletAddress, identity.platform)
        if (!wallet || seen.has(wallet)) continue
        seen.add(wallet)
        cohortWrites.push({
          chain: identity.chain, contract_address: identity.address, captured_at: capturedAt, tag: row.tag,
          wallet_address: wallet,
          balance: num(holder.balance), percent: num(holder.percent),
          buy_volume_usd: num(holder.buyVolumeUsd), sell_volume_usd: num(holder.sellVolumeUsd),
          // A realized gain we could not read stays NULL. Zero is a real answer.
          realized_pnl_usd: num(holder.realizedPnlUsd),
          // The provider's own funding-source string, capped. It names a route,
          // never a person, and nothing here resolves it to an identity.
          funding_source: text(holder.fundingSource, 120),
          first_seen_at: iso(holder.firstSeenAt), last_seen_at: iso(holder.lastSeenAt),
        })
      }
    }

    // The board is written even when every cohort call failed: a tag distribution
    // we did see is not lost because a wallet page we asked for afterwards did not
    // answer. Order matters — the board row is what `within_cadence` reads.
    const written = await upsert(admin, HOLDER_TAG_TABLE, tagWrites, 'chain,contract_address,captured_at,tag')
    const cohort = written.error ? { rows: 0 } : await upsert(admin, HOLDER_COHORT_TABLE, cohortWrites, 'chain,contract_address,captured_at,tag,wallet_address')
    return {
      capturedAt,
      tags: tagRows.map((r) => ({ tag: r.tag, holderCount: r.holderCount, balance: r.balance, ratio: r.ratio })),
      cohortRows: cohort.rows, credits, calls,
      ...(partial ? { partial } : {}),
      ...(written.error || cohort.error ? { error: (written.error || cohort.error) as string } : {}),
    }
  } catch (e) {
    return empty({ credits, error: ((e as Error)?.message || 'holder_tag_capture_failed').slice(0, 200) })
  }
}
