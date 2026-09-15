// Investor Intel — display-currency capture (CMC plan proposal 26).
//
// Everything Investor Intel stores is denominated in USD. Nothing in this lane
// changes that: it only records, once an hour, what one US dollar is worth in
// each of the thirty supported reader currencies, so the app can convert AT
// DISPLAY TIME and never has to re-denominate a stored figure.
//
// Cost: ONE `/v2/tools/price-conversion` call an hour (`amount=1, symbol=USD,
// convert=<the thirty codes>`), 1 credit — 24 credits a day. The provider's
// `/v1/fiat/map` endpoint is deliberately NOT called: the only thing it adds is
// the name and sign of each currency, which for a fixed thirty-code list is a
// static table (`FX_CURRENCIES` in capture-fx-read.ts). Calling it daily would
// buy nothing and cost a credit a day.
//
// Like every other capture lane this module never throws (a failure becomes
// `{ error }`), obeys `provider_schedule_policy` (feature `fx`), and is
// idempotent: rows are keyed on the hour bucket and upserted, so an overlapping
// or retried cron run overwrites rather than duplicates.
//
// INTEGRATION NOTE for the reviewer wiring this into `intel-capture/index.ts`:
// `cmcParams` in `_shared/market-assets/cmc-capabilities.ts` currently caps the
// `convert` list at THREE symbols. This lane sends `FX_CONVERT_BATCH` (30) in
// one call as the plan specifies, which needs that cap raised to at least 30
// (the provider allows 120 on a paid plan). This module must not edit the
// registry, so the cap is the one prerequisite for the lane. If the cap has to
// stay where it is, lowering `FX_CONVERT_BATCH` to 3 is the only change needed
// here — the loop below already splits the list and counts a credit per call.

import { planAllows } from '../market-assets/cmc-capabilities.ts'
import type { MarketAssetsContext } from '../market-assets/types.ts'
import { CAPTURE_PROVIDER, schedulePolicy, hourBucket, iso, type CaptureDeps, type JobResult } from './capture-jobs.ts'

/** The supported reader currencies, in the order the settings select renders
 * them. USD is first and is always stored as exactly 1: it is the base. */
export const FX_CODES = [
  'USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD',
  'KRW', 'INR', 'BRL', 'MXN', 'ZAR', 'TRY', 'SEK', 'NOK', 'DKK', 'PLN',
  'CZK', 'HUF', 'AED', 'SAR', 'ILS', 'THB', 'IDR', 'PHP', 'VND', 'NGN',
] as const
export type FxCode = typeof FX_CODES[number]

export const FX_BASE = 'USD'
export const FX_FEATURE = 'fx'
export const FX_TABLE = 'intel_fx_rates'
/** Symbols per conversion call. The provider accepts 120 on a paid plan, so the
 * whole list is one call and one credit. See the integration note above. */
export const FX_CONVERT_BATCH = 30
const DEFAULT_CADENCE_SECONDS = 3600
// Cron fires on wall-clock minutes; a run a few seconds early is not a duplicate.
const CADENCE_GRACE = 0.9

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
/** A rate is a strictly positive finite number. Zero, a negative, NaN or a
 * string the provider could not price all mean "no rate", never 0 and never 1. */
const rateOf = (v: unknown): number | null => {
  const n = num(v)
  return n != null && n > 0 ? n : null
}

/** Newest capture instant, or null when the table is empty or unreadable. A
 * failed read never blocks the capture: the write is idempotent anyway. */
// deno-lint-ignore no-explicit-any
async function newestCapturedAt(db: any): Promise<number | null> {
  try {
    const { data, error } = await db.from(FX_TABLE).select('captured_at')
      .eq('base', FX_BASE).order('captured_at', { ascending: false }).limit(1)
    if (error) return null
    const row = Array.isArray(data) ? data[0] : data
    const parsed = Date.parse(String(row?.captured_at ?? ''))
    return Number.isFinite(parsed) ? parsed : null
  } catch { return null }
}

// deno-lint-ignore no-explicit-any
async function upsertRates(db: any, rows: Record<string, unknown>[]): Promise<{ rows: number; error?: string }> {
  if (!rows.length) return { rows: 0 }
  try {
    const { error } = await db.from(FX_TABLE).upsert(rows, { onConflict: 'base,quote,captured_at' })
    if (error) return { rows: 0, error: String(error.message || error).slice(0, 200) }
    return { rows: rows.length }
  } catch (e) { return { rows: 0, error: ((e as Error)?.message || 'write_failed').slice(0, 200) } }
}

/** The `quote` map of a price-conversion payload, whichever shape it arrives in
 * (the provider answers with a single object, and has historically answered with
 * a one-element array for the same request). */
// deno-lint-ignore no-explicit-any
function conversionQuotes(payload: any): { quote: Record<string, any>; lastUpdated: string | null } {
  const data = payload?.data
  const row = Array.isArray(data) ? data[0] : data
  const quote = row?.quote && typeof row.quote === 'object' ? row.quote : {}
  return { quote, lastUpdated: iso(row?.last_updated) }
}

/**
 * Hourly FX capture. One conversion call covers every supported currency, so
 * the hour's thirty rows cost a single credit.
 *
 * A currency the provider did not price is simply ABSENT from the hour — it is
 * never stored as 0 (free) or 1 (par with the dollar), either of which would
 * silently misprice every figure on the reader's screen.
 */
export async function captureFx(
  // deno-lint-ignore no-explicit-any
  admin: any,
  ctxFor: (name: string, maxCalls: number) => MarketAssetsContext,
  now: Date = new Date(),
  plan = 'basic',
  deps: CaptureDeps = { request: () => Promise.resolve(null) },
): Promise<JobResult> {
  const job = FX_FEATURE
  const calls = Math.max(1, Math.ceil(FX_CODES.length / FX_CONVERT_BATCH))
  try {
    const policy = schedulePolicy(deps.policy, FX_FEATURE)
    if (!policy.enabled) return { job, rows: 0, credits: 0, skipped: 'policy_disabled' }
    const minPlan = policy.minPlan || 'basic'
    // deno-lint-ignore no-explicit-any
    if (!planAllows(plan, minPlan as any)) return { job, rows: 0, credits: 0, skipped: `plan_below_${minPlan}` }

    const cadenceSeconds = policy.cadenceSeconds > 0 ? policy.cadenceSeconds : DEFAULT_CADENCE_SECONDS
    const newest = await newestCapturedAt(admin)
    if (newest != null && now.getTime() - newest < cadenceSeconds * 1000 * CADENCE_GRACE) {
      return { job, rows: 0, credits: 0, skipped: 'within_cadence', newestAt: new Date(newest).toISOString() }
    }

    const capturedAt = hourBucket(now)
    const ctx = ctxFor('fx', calls)
    const quotes: Record<string, unknown> = {}
    let lastUpdated: string | null = null
    let credits = 0, reason: string | null = null
    for (let start = 0; start < FX_CODES.length; start += FX_CONVERT_BATCH) {
      const batch = FX_CODES.slice(start, start + FX_CONVERT_BATCH)
      const result = await deps.request('priceConversion', { amount: 1, symbol: FX_BASE, convert: batch.join(',') }, ctx).catch(() => null)
      credits += 1
      if (!result?.payload) { reason = reason || result?.reason || 'provider_unavailable'; continue }
      const conversion = conversionQuotes(result.payload)
      lastUpdated = lastUpdated || conversion.lastUpdated
      for (const [code, value] of Object.entries(conversion.quote)) quotes[String(code).toUpperCase()] = value
    }

    const rows: Record<string, unknown>[] = []
    for (const code of FX_CODES) {
      if (code === FX_BASE) continue
      // deno-lint-ignore no-explicit-any
      const entry = quotes[code] as any
      const rate = rateOf(entry?.price)
      if (rate == null) continue
      rows.push({ base: FX_BASE, quote: code, captured_at: capturedAt, rate, observed_at: iso(entry?.last_updated) ?? lastUpdated })
    }
    // The base is stored explicitly so a reader on USD reads the same table as
    // everyone else, but only when the hour actually priced something: a lone
    // USD=1 row would read as "rates captured" while every conversion is missing.
    if (!rows.length) return { job, rows: 0, credits, capturedAt, error: reason || 'provider_unavailable' }
    rows.unshift({ base: FX_BASE, quote: FX_BASE, captured_at: capturedAt, rate: 1, observed_at: lastUpdated })

    const written = await upsertRates(admin, rows)
    const missing = FX_CODES.filter((code) => !rows.some((row) => row.quote === code))
    return {
      job, rows: written.rows, credits, capturedAt,
      currencies: rows.length,
      ...(missing.length ? { missing } : {}),
      ...(reason ? { partial: reason } : {}),
      ...(written.error ? { error: written.error } : {}),
    }
  } catch (e) {
    return { job, rows: 0, credits: calls, error: ((e as Error)?.message || 'capture_failed').slice(0, 200) }
  }
}

/** Integration surface consumed by `intel-capture/index.ts`. Keyed by op name. */
export const FX_CAPTURE_OPS: Record<string, (
  // deno-lint-ignore no-explicit-any
  admin: any,
  ctxFor: (name: string, maxCalls: number) => MarketAssetsContext,
  now: Date,
  plan: string,
  deps: CaptureDeps,
) => Promise<JobResult>> = { fx: captureFx }

export { CAPTURE_PROVIDER }
