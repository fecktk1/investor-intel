// Investor Intel — exchange-reserve and venue-share capture lanes (CMC plan
// proposals 15 and 16).
//
// Two daily jobs written to the same contract as `capture-jobs.ts`: each one is
// bounded, never throws (a failure becomes `{ error }` or a `partial` reason on
// the result), obeys `provider_schedule_policy` — a disabled feature is skipped
// with `policy_disabled`, and a run whose newest stored row is younger than the
// feature's `cadence_seconds` is skipped with `within_cadence` — and reports the
// UPPER bound of provider calls it may issue as `credits`. The transport serves
// a still-fresh shared snapshot for 0 credits, so the billed total is never
// higher than the reported one.
//
// Nothing here calls CoinMarketCap directly: the transport arrives as
// `deps.request` (the real `requestCmc` in the Edge Function, a fake in tests)
// and the per-call context comes from `ctxFor(name, maxCalls)`, exactly as
// `intel-capture/index.ts` builds it for every other lane.
//
// Capability names are resolved from the registry BY PATH rather than hard
// coded, because the registry is owned elsewhere: whatever name
// `/v1/exchange/listings/latest` is eventually registered under, this lane picks
// it up with no edit here. Until it is registered the venue-share lane captures
// the derivatives half from the registered `/v5/exchange/derivatives/list` and
// reports `spot_listings_capability_unregistered` — it never invents a spot row.
//
// The three helpers `capture-jobs.ts` keeps private (`upsert`, `dedupe`,
// `failed`, and the freshness probe behind `guardJob`) are copied here rather
// than exported from there: three capture lanes land concurrently and that file
// belongs to none of them.

import { CMC_CAPABILITIES, cmcRows, planAllows } from '../market-assets/cmc-capabilities.ts'
import type { MarketAssetsContext } from '../market-assets/types.ts'
import { CAPTURE_PROVIDER, iso, schedulePolicy, utcDate, type CaptureDeps, type JobResult, type SchedulePolicyRow } from './capture-jobs.ts'

export type CtxFor = (name: string, maxCalls: number) => MarketAssetsContext

/** Cadence these two tables were designed for, used only when the feature has
 * no `provider_schedule_policy` row at all. A row always wins. */
const DEFAULT_CADENCE: Record<string, number> = { exchange_reserves: 86400, venue_share: 86400 }
const CADENCE_GRACE = 0.9
const MAX_UPSERT_ROWS = 500

/** Reserve capture bounds: the ten largest spot venues, one `exchangeAssets`
 * call each, at most 250 assets stored per venue (largest by USD value). */
export const RESERVE_EXCHANGES = 10
export const RESERVE_ASSETS_PER_EXCHANGE = 250
/** An exchange reports one row per wallet, not per asset — a large venue can
 * report thousands. The page is read whole (bounded) and aggregated here. */
const MAX_WALLET_ROWS = 6000
/** Venue share: one row per venue per kind per day. */
export const VENUE_SHARE_EXCHANGES = 100

const num = (v: unknown): number | null => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const int = (v: unknown): number | null => { const n = num(v); return n == null ? null : Math.trunc(n) }
const count = (v: unknown): number | null => { const n = int(v); return n == null || n < 0 ? null : n }
const text = (v: unknown, max = 200): string | null => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null }

/** The registry is owned by another lane; capabilities are looked up by the
 * documented provider path so a rename or a late registration needs no edit. */
export function capabilityForPath(path: string): string | null {
  for (const [name, spec] of Object.entries(CMC_CAPABILITIES)) if (spec?.path === path) return name
  return null
}

export const EXCHANGE_MAP_CAPABILITY = capabilityForPath('/v1/exchange/map')
export const EXCHANGE_LISTINGS_CAPABILITY = capabilityForPath('/v1/exchange/listings/latest')
export const EXCHANGE_ASSETS_CAPABILITY = capabilityForPath('/v1/exchange/assets')
export const DERIVATIVE_EXCHANGES_CAPABILITY = capabilityForPath('/v5/exchange/derivatives/list')

// ─── helpers copied from capture-jobs.ts (private there) ──────────────────────

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

/** `schedulePolicy` defaults an unknown feature to one hour; these two lanes are
 * daily, so the policy row's `cadence_seconds` is read directly and the daily
 * default applies only when the feature has no row. */
export function venuePolicy(rows: SchedulePolicyRow[] | undefined, feature: string): { enabled: boolean; cadenceSeconds: number; minPlan: string | null } {
  const base = schedulePolicy(rows, feature)
  const row = (rows || []).find((r) => r?.feature === feature && (r.provider ?? CAPTURE_PROVIDER) === CAPTURE_PROVIDER)
  const cadence = Number(row?.cadence_seconds)
  return { ...base, cadenceSeconds: Number.isFinite(cadence) && cadence > 0 ? cadence : (DEFAULT_CADENCE[feature] ?? 86400) }
}

// deno-lint-ignore no-explicit-any
async function guardJob(db: any, job: string, feature: string, deps: CaptureDeps, now: Date,
  freshness: { table: string; column: string }): Promise<JobResult | null> {
  const policy = venuePolicy(deps.policy, feature)
  if (!policy.enabled) return { job, rows: 0, credits: 0, skipped: 'policy_disabled' }
  const newest = await newestAt(db, freshness.table, freshness.column)
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

/** A capability above the current plan is never attempted; the reason is
 * recorded instead, exactly as the attention and airdrop lanes do. */
function planBlock(job: string, capability: string | null, plan: string): JobResult | null {
  const tier = capability ? CMC_CAPABILITIES[capability]?.tier : null
  if (!tier || planAllows(plan, tier)) return null
  return { job, rows: 0, credits: 0, skipped: `plan_below_${tier}` }
}

// ─── exchange selection ───────────────────────────────────────────────────────

export interface VenueExchange { exchangeId: number; slug: string | null; name: string | null; volume24h: number | null; numMarketPairs: number | null }

// deno-lint-ignore no-explicit-any
export function exchangeFromRow(row: any): VenueExchange | null {
  const exchangeId = int(row?.id ?? row?.exchange_id)
  if (exchangeId == null || exchangeId < 1) return null
  const quote = row?.quote ?? {}
  return {
    exchangeId,
    slug: text(row?.slug ?? row?.exchange_slug, 200),
    name: text(row?.name ?? row?.exchange_name, 200),
    volume24h: num(quote.volume_24h ?? row?.volume_24h ?? quote.spot_volume_24h ?? row?.spot_volume_24h),
    numMarketPairs: count(row?.num_market_pairs ?? row?.market_pairs ?? quote.num_market_pairs),
  }
}

/** The ten largest spot venues. The listings endpoint carries the 24 h volume,
 * so the order is recomputed here rather than trusted; the exchange map has no
 * volume field at all and is taken in the order the provider sorted it. */
export async function selectTopExchanges(ctxFor: CtxFor, deps: CaptureDeps, limit: number, plan = 'basic'):
  Promise<{ exchanges: VenueExchange[]; credits: number; source: string | null; reason: string | null }> {
  // The listing endpoint sits above Startup (probed 2026-09-15); below its
  // tier the map is the selection source and no credit is spent finding out.
  if (EXCHANGE_LISTINGS_CAPABILITY && !planBlock('select', EXCHANGE_LISTINGS_CAPABILITY, plan)) {
    // `exchangeListings` (registered 2026-09-15) accepts `sort`; the page is
    // still ordered locally by the reported volume so a provider default
    // order can never change which venues are chosen.
    const result = await deps.request(EXCHANGE_LISTINGS_CAPABILITY, { limit: VENUE_SHARE_EXCHANGES, start: 1, sort: 'volume_24h' }, ctxFor('exchange-listings', 1)).catch(() => null)
    if (result?.payload) {
      const rows = cmcRows(EXCHANGE_LISTINGS_CAPABILITY, result.payload).rows
        // A delisted venue holds no current reserves, whichever list reports it.
        .filter((row) => row?.is_active == null || Number(row.is_active) === 1)
        .map(exchangeFromRow).filter((v): v is VenueExchange => !!v)
        .sort((a, b) => (b.volume24h ?? -1) - (a.volume24h ?? -1))
      if (rows.length) return { exchanges: rows.slice(0, limit), credits: 1, source: EXCHANGE_LISTINGS_CAPABILITY, reason: null }
    }
    return { exchanges: [], credits: 1, source: EXCHANGE_LISTINGS_CAPABILITY, reason: result?.reason || 'provider_unavailable' }
  }
  if (!EXCHANGE_MAP_CAPABILITY) return { exchanges: [], credits: 0, source: null, reason: 'exchange_capability_unregistered' }
  const result = await deps.request(EXCHANGE_MAP_CAPABILITY, { listing_status: 'active', sort: 'volume_24h', limit: VENUE_SHARE_EXCHANGES, start: 1 }, ctxFor('exchange-map', 1)).catch(() => null)
  if (!result?.payload) return { exchanges: [], credits: 1, source: EXCHANGE_MAP_CAPABILITY, reason: result?.reason || 'provider_unavailable' }
  const rows = cmcRows(EXCHANGE_MAP_CAPABILITY, result.payload).rows
    // The map reports `is_active`; a delisted venue holds no current reserves.
    .filter((row) => row?.is_active == null || Number(row.is_active) === 1)
    .map(exchangeFromRow).filter((v): v is VenueExchange => !!v)
  return { exchanges: rows.slice(0, limit), credits: 1, source: EXCHANGE_MAP_CAPABILITY, reason: rows.length ? null : 'no_reported_exchanges' }
}

// ─── 1. Exchange reserves (daily, 1 + 10 credits) ─────────────────────────────

export interface ReserveAsset {
  providerId: string; platformSymbol: string; symbol: string | null; name: string | null
  balance: number | null; usdValue: number | null; walletCount: number
  priceUsd: number | null; platformName: string | null; platformId: number | null
}

/** One row per (asset, platform) out of a page of per-wallet holdings. Balances
 * and USD values are summed across wallets; a wallet with no reported address
 * still counts as one holding rather than collapsing into another. */
// deno-lint-ignore no-explicit-any
export function aggregateWallets(walletRows: any[]): ReserveAsset[] {
  const byAsset = new Map<string, ReserveAsset & { wallets: Set<string> }>()
  walletRows.forEach((row, index) => {
    const currency = row?.currency ?? {}
    const platform = row?.platform ?? {}
    const providerId = text(currency.crypto_id ?? currency.id, 40)
    if (!providerId || providerId === 'null') return
    // The unique index folds a missing platform symbol into '', so the write
    // stores '' directly and the aggregation key matches it exactly.
    const platformSymbol = text(platform.symbol, 50) ?? ''
    const key = `${providerId}|${platformSymbol}`
    const balance = num(row?.balance)
    const price = num(currency.price_usd ?? currency.price)
    const reported = num(row?.usd_value ?? row?.balance_usd)
    const entry = byAsset.get(key) ?? {
      providerId, platformSymbol, symbol: text(currency.symbol, 50), name: text(currency.name, 200),
      balance: null, usdValue: null, walletCount: 0, priceUsd: price,
      platformName: text(platform.name, 200), platformId: int(platform.crypto_id ?? platform.id),
      wallets: new Set<string>(),
    }
    if (balance != null) entry.balance = (entry.balance ?? 0) + balance
    const usd = reported ?? (balance != null && price != null ? balance * price : null)
    if (usd != null) entry.usdValue = (entry.usdValue ?? 0) + usd
    if (entry.priceUsd == null) entry.priceUsd = price
    entry.wallets.add(text(row?.wallet_address, 200) ?? `row:${index}`)
    byAsset.set(key, entry)
  })
  return [...byAsset.values()].map(({ wallets, ...asset }) => ({ ...asset, walletCount: wallets.size }))
}

/** Largest first, with unpriced assets after every priced one — the 250-asset
 * bound then drops the smallest holdings, never the largest. */
const byUsdValue = (a: ReserveAsset, b: ReserveAsset) => (b.usdValue ?? -1) - (a.usdValue ?? -1)

export async function captureExchangeReserves(
  // deno-lint-ignore no-explicit-any
  admin: any, ctxFor: CtxFor, now = new Date(), plan = 'basic', deps: CaptureDeps,
): Promise<JobResult> {
  const job = 'exchange_reserves'
  let credits = 0
  try {
    if (!EXCHANGE_ASSETS_CAPABILITY) return { job, rows: 0, credits: 0, skipped: 'exchange_assets_capability_unregistered' }
    const blocked = planBlock(job, EXCHANGE_ASSETS_CAPABILITY, plan)
    if (blocked) return blocked
    const skip = await guardJob(admin, job, 'exchange_reserves', deps, now, { table: 'intel_exchange_reserve_snapshots', column: 'created_at' })
    if (skip) return skip

    const snapshotDate = utcDate(now)
    const selection = await selectTopExchanges(ctxFor, deps, RESERVE_EXCHANGES, plan)
    credits += selection.credits
    if (!selection.exchanges.length) return { job, rows: 0, credits, snapshotDate, error: selection.reason || 'no_reported_exchanges' }

    const rows: Record<string, unknown>[] = []
    let reason: string | null = selection.reason
    let captured = 0, truncatedVenues = 0
    for (const exchange of selection.exchanges) {
      const result = await deps.request(EXCHANGE_ASSETS_CAPABILITY, { id: exchange.exchangeId }, ctxFor('exchange-assets', 1)).catch(() => null)
      credits += 1
      if (!result?.payload) { reason = reason || result?.reason || 'provider_unavailable'; continue }
      // `cmcRows` caps a page at 250 rows, which on this endpoint would drop
      // WALLETS (and therefore reserves), not assets — the raw page is read
      // whole under its own bound and aggregated before anything is dropped.
      const data = result.payload?.data
      const page = Array.isArray(data) ? data : cmcRows(EXCHANGE_ASSETS_CAPABILITY, result.payload).rows
      if (page.length > MAX_WALLET_ROWS) truncatedVenues += 1
      const assets = aggregateWallets(page.slice(0, MAX_WALLET_ROWS)).sort(byUsdValue)
      if (!assets.length) continue
      captured += 1
      for (const asset of assets.slice(0, RESERVE_ASSETS_PER_EXCHANGE)) {
        rows.push({
          exchange_id: exchange.exchangeId, snapshot_date: snapshotDate,
          provider_id: asset.providerId, platform_symbol: asset.platformSymbol,
          exchange_slug: exchange.slug, symbol: asset.symbol,
          balance: asset.balance, usd_value: asset.usdValue, wallet_count: asset.walletCount,
          raw: {
            priceUsd: asset.priceUsd, name: asset.name,
            platformName: asset.platformName, platformId: asset.platformId,
            exchangeName: exchange.name, assets: assets.length, source: EXCHANGE_ASSETS_CAPABILITY,
          },
        })
      }
    }
    if (!rows.length) return { job, rows: 0, credits, snapshotDate, error: reason || 'no_reported_reserves' }
    const written = await upsert(admin, 'intel_exchange_reserve_snapshots',
      dedupe(rows, (r) => `${r.exchange_id}|${r.provider_id}|${r.platform_symbol}`), 'exchange_id,snapshot_date,provider_id,platform_symbol')
    return {
      job, rows: written.rows, credits, snapshotDate,
      exchanges: captured, requested: selection.exchanges.length, source: selection.source,
      ...(truncatedVenues ? { walletPagesTruncated: truncatedVenues } : {}),
      ...(reason ? { partial: reason } : {}), ...(written.error ? { error: written.error } : {}),
    }
  } catch (e) { return failed(job, credits, e) }
}

// ─── 2. Venue share (daily, 1 credit) ─────────────────────────────────────────

/** Derivative figures live under different names across the spot listing and
 * the derivatives list; only a reported figure is stored, never a zero. */
// deno-lint-ignore no-explicit-any
const firstNumber = (row: any, quote: any, keys: string[]): number | null =>
  keys.map((key) => num(quote?.[key] ?? row?.[key])).find((v) => v != null) ?? null

const DERIVATIVE_VOLUME_KEYS = ['derivative_volume_24h', 'derivatives_volume_24h', 'futures_volume_24h', 'volume_24h']
const OPEN_INTEREST_KEYS = ['open_interest', 'open_interest_usd', 'total_open_interest']

export interface VenueShareRow { kind: 'spot' | 'derivatives'; exchangeId: number; slug: string | null; volume24h: number | null; openInterest: number | null; numMarketPairs: number | null; observedAt: string | null }

/** Spot rows from the exchange listing; a derivatives row is added only for a
 * venue whose listing actually reports a derivative volume or open interest. */
// deno-lint-ignore no-explicit-any
export function venueRowsFromListings(page: any[], limit = VENUE_SHARE_EXCHANGES): VenueShareRow[] {
  const out: VenueShareRow[] = []
  for (const row of page.slice(0, limit)) {
    const exchangeId = int(row?.id ?? row?.exchange_id)
    if (exchangeId == null || exchangeId < 1) continue
    const quote = row?.quote ?? {}
    const slug = text(row?.slug ?? row?.exchange_slug, 200)
    const observedAt = iso(quote.last_updated ?? row?.last_updated)
    out.push({
      kind: 'spot', exchangeId, slug,
      volume24h: num(quote.volume_24h ?? row?.volume_24h ?? quote.spot_volume_24h ?? row?.spot_volume_24h),
      openInterest: null,
      numMarketPairs: count(row?.num_market_pairs ?? row?.market_pairs),
      observedAt,
    })
    const derivativeVolume = firstNumber(row, quote, DERIVATIVE_VOLUME_KEYS.slice(0, -1))
    const openInterest = firstNumber(row, quote, OPEN_INTEREST_KEYS)
    if (derivativeVolume == null && openInterest == null) continue
    out.push({
      kind: 'derivatives', exchangeId, slug,
      volume24h: derivativeVolume, openInterest,
      numMarketPairs: count(row?.num_derivative_market_pairs ?? row?.derivative_market_pairs),
      observedAt,
    })
  }
  return out
}

/** The registered derivatives list is the fallback for the derivatives half
 * while `/v1/exchange/listings/latest` is unregistered. */
// deno-lint-ignore no-explicit-any
export function venueRowsFromDerivatives(page: any[], limit = VENUE_SHARE_EXCHANGES): VenueShareRow[] {
  const out: VenueShareRow[] = []
  for (const row of page.slice(0, limit)) {
    const exchangeId = int(row?.exchange_id ?? row?.id)
    if (exchangeId == null || exchangeId < 1) continue
    const quote = row?.quote ?? {}
    out.push({
      kind: 'derivatives', exchangeId,
      slug: text(row?.exchange_slug ?? row?.slug, 200),
      volume24h: firstNumber(row, quote, DERIVATIVE_VOLUME_KEYS),
      openInterest: firstNumber(row, quote, OPEN_INTEREST_KEYS),
      numMarketPairs: count(row?.num_market_pairs ?? row?.market_pairs),
      observedAt: iso(quote.last_updated ?? row?.last_updated),
    })
  }
  return out
}

export async function captureVenueShare(
  // deno-lint-ignore no-explicit-any
  admin: any, ctxFor: CtxFor, now = new Date(), plan = 'basic', deps: CaptureDeps,
): Promise<JobResult> {
  const job = 'venue_share'
  let credits = 0
  try {
    // The spot listing is above Startup (probed 2026-09-15); below its tier the
    // derivatives list still gives the OI half, and the spot half is reported
    // as the gap it is.
    const listingAllowed = !!EXCHANGE_LISTINGS_CAPABILITY && !planBlock(job, EXCHANGE_LISTINGS_CAPABILITY, plan)
    const capability = listingAllowed ? EXCHANGE_LISTINGS_CAPABILITY : DERIVATIVE_EXCHANGES_CAPABILITY
    if (!capability) return { job, rows: 0, credits: 0, skipped: 'venue_capability_unregistered' }
    const blocked = planBlock(job, capability, plan)
    if (blocked) return blocked
    const spotGap = EXCHANGE_LISTINGS_CAPABILITY ? (listingAllowed ? null : 'spot_listings_above_plan') : 'spot_listings_capability_unregistered'
    const skip = await guardJob(admin, job, 'venue_share', deps, now, { table: 'intel_venue_share_snapshots', column: 'created_at' })
    if (skip) return skip

    const snapshotDate = utcDate(now)
    const result = await deps.request(capability, { limit: VENUE_SHARE_EXCHANGES, start: 1 }, ctxFor('venue-share', 1)).catch(() => null)
    credits += 1
    if (!result?.payload) return { job, rows: 0, credits, snapshotDate, error: result?.reason || 'provider_unavailable' }
    const page = cmcRows(capability, result.payload).rows
    const venues = capability === EXCHANGE_LISTINGS_CAPABILITY ? venueRowsFromListings(page) : venueRowsFromDerivatives(page)
    if (!venues.length) return { job, rows: 0, credits, snapshotDate, skipped: 'no_reported_venues' }

    const rows = venues.map((venue) => ({
      kind: venue.kind, exchange_id: venue.exchangeId, snapshot_date: snapshotDate,
      exchange_slug: venue.slug, volume_24h: venue.volume24h, open_interest: venue.openInterest,
      num_market_pairs: venue.numMarketPairs, observed_at: venue.observedAt,
    }))
    const written = await upsert(admin, 'intel_venue_share_snapshots',
      dedupe(rows, (r) => `${r.kind}|${r.exchange_id}`), 'kind,exchange_id,snapshot_date')
    const spot = rows.filter((row) => row.kind === 'spot').length
    return {
      job, rows: written.rows, credits, snapshotDate, source: capability,
      spot, derivatives: rows.length - spot,
      // A missing spot half is a reported gap, never a silently short capture.
      ...(spotGap ? { partial: spotGap } : {}),
      ...(written.error ? { error: written.error } : {}),
    }
  } catch (e) { return failed(job, credits, e) }
}

/** Integration surface for `intel-capture/index.ts`: one entry per op name, all
 * sharing the signature the other lanes use. */
export const VENUE_CAPTURE_OPS: Record<string, (
  // deno-lint-ignore no-explicit-any
  admin: any, ctxFor: CtxFor, now: Date, plan: string, deps: CaptureDeps) => Promise<JobResult>> = {
  exchange_reserves: (admin, ctxFor, now, plan, deps) => captureExchangeReserves(admin, ctxFor, now, plan, deps),
  venue_share: (admin, ctxFor, now, plan, deps) => captureVenueShare(admin, ctxFor, now, plan, deps),
}

export const VENUE_CAPTURE_OP_NAMES = Object.keys(VENUE_CAPTURE_OPS) as ['exchange_reserves', 'venue_share']
