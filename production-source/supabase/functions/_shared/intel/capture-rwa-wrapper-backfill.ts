// Investor Intel RWA wrapper premium backfill lane.
//
// The six-hourly wrapper lane (`capture-rwa-wrappers.ts`) has kept every capture
// since it started on 2026-09-20, so the premium history from then on already
// exists. This lane reconstructs the part BEFORE it: up to 90 days per wrapper,
// from CoinMarketCap's daily OHLCV close and daily volume, run through exactly
// the same `wrapperSpread()` the live lane uses. Nothing about the arithmetic is
// re-implemented here; only the inputs differ, and every row says so in its
// `method` column ('ohlcv_daily_close_reconstructed').
//
// Same contract as the other capture lanes: one bounded function, explicit call
// and credit ceilings, obeys `provider_schedule_policy`, never throws (a failure
// becomes `{ error }`), and reaches CoinMarketCap only through `deps.request`.
//
// WHAT IT REFUSES, BEFORE ANY CALL.
//   * `CMC_ALLOW_HISTORICAL_RETENTION` other than 'true': retained history is a
//     licence question, and a reconstruction is retained history.
//   * A plan below Startup: OHLCV historical is a Startup capability.
//   * A disabled policy row. The row is inserted disabled.
//
// WHAT ONE RUN COSTS.
//   ONE crypto id per `/v2/cryptocurrency/ohlcv/historical` call, count=90,
//   interval=daily, time_period=daily. The registry prices OHLCV at one credit
//   per 100 points, so each call is 1 credit. One id per call is REQUIRED, not
//   preferred: `estimateCmcCredits` reads `count` before `id`, so a comma-joined
//   call would be estimated at one credit while billing one per id.
//   At most RWA_WRAPPER_BACKFILL_IDS_PER_RUN = 60 ids per run, so 60 credits,
//   and the whole backfill is held to a STANDING ceiling (policy `max_credits`,
//   default 400) summed from `credits_spent` in the state table.
//   Measured 2026-09-22: 316 wrappers across 51 assets, so about 316 credits once.
//
// HOW AN ASSET-DAY IS REBUILT.
//   The wrapper set, names, issuers and the asset's own symbol come from that
//   asset's FIRST live capture hour: the observation nearest to the window being
//   reconstructed. Each day then gets a `WrapperAssetInput` whose tokens are the
//   wrappers that have a close for that day (close as the price, the day's USD
//   volume as the 24-hour volume). A wrapper with no candle that day is ABSENT
//   from that day, never carried forward. Only days strictly before the asset's
//   first live capture day are written, so a reconstruction never competes with
//   a live row.
//
// WHY AN ASSET IS WRITTEN WHOLE OR NOT AT ALL. The anchor of an asset-day is a
//   median over its wrappers. If one wrapper's call failed, the other wrappers'
//   rows would be measured against an anchor that is missing a member, and the
//   table is append-only, so that could never be corrected. So a transport
//   failure on any wrapper writes NOTHING for the asset: the fetched wrappers
//   stay pending (their credits recorded), the failed one is marked failed, and
//   the next run refetches the asset. After RWA_WRAPPER_BACKFILL_MAX_ATTEMPTS a
//   failed wrapper stops being retried and the asset is rebuilt without it.
//
// STATE TRANSITIONS (intel_rwa_wrapper_backfill_state):
//   (none)   -> pending    seeded from the live tables, ignoring duplicates
//   pending  -> complete   at least one reconstructed day was written
//   pending  -> no_data    the provider answered, but with no usable close
//                          before the asset's first live capture
//   pending  -> failed     the call did not answer, or the write failed;
//                          retried while attempts < MAX_ATTEMPTS
//   pending  -> pending    fetched, but another wrapper of the asset failed

import { CAPTURE_PROVIDER, iso, schedulePolicy, type CaptureDeps, type JobResult } from './capture-jobs.ts'
import { cmcRows, cmcUsdQuote, estimateCmcCredits, planAllows } from '../market-assets/cmc-capabilities.ts'
import { cmcPolicyEnvironment, loadCmcOperatingSettings } from '../market-assets/cmc-operating-settings.ts'
import type { MarketAssetsContext } from '../market-assets/types.ts'
import { cmcOhlcvBars } from './cmc-chart.ts'
import { ASSET_TABLE, TOKEN_TABLE } from './capture-rwa-wrappers.ts'
import { wrapperSpread, LIQUIDITY_FLOOR_USD, type WrapperAssetInput, type WrapperTokenInput } from './rwa-wrapper-spread.ts'

export const RWA_WRAPPER_BACKFILL_FEATURE = 'rwa_wrapper_backfill'
export const BACKFILL_TABLE = 'intel_rwa_wrapper_premium_backfill'
export const BACKFILL_STATE_TABLE = 'intel_rwa_wrapper_backfill_state'
export const BACKFILL_METHOD = 'ohlcv_daily_close_reconstructed'
/** Wrapper ids (so ohlcv calls, so credits) one run may spend. */
export const RWA_WRAPPER_BACKFILL_IDS_PER_RUN = 60
/** The standing ceiling across every run, used when the policy row carries no
 * `max_credits`. */
export const RWA_WRAPPER_BACKFILL_CREDIT_CEILING = 400
/** Daily points one call asks for. ceil(90/100) = 1 credit. */
export const RWA_WRAPPER_BACKFILL_DAYS = 90
/** A wrapper whose call failed this many times is no longer retried. */
export const RWA_WRAPPER_BACKFILL_MAX_ATTEMPTS = 3
/** Pause before an in-run retry of a failed wrapper, multiplied by the round. */
const RETRY_PAUSE_MS = 750
/** Live asset rows read, oldest first, to find each asset's first capture hour.
 * The lane captures at most 60 assets four times a day, so 5,000 rows is the
 * first three weeks of the live history: every asset first seen in that window
 * is found. An asset first captured later is not seeded; see the report. */
export const RWA_WRAPPER_BACKFILL_SEED_ROWS = 5_000
const TOKEN_SEED_ROWS = 5_000
const STATE_ROWS = 2_000
const MAX_INSERT_ROWS = 500
const DAY = 86_400_000
const ID = /^[1-9][0-9]{0,11}$/

export interface RwaWrapperBackfillDeps extends CaptureDeps {
  /** Source-policy reader (licence switches). Defaults to the operating profile
   * row plus the Edge environment, exactly as the other retained-history paths
   * read it. Injected so the refusal is testable. */
  sourcePolicy?: (key: string) => string | undefined
  liquidityFloorUsd?: number
  /** Pause between in-run retries of a failed wrapper. Injected so tests do not wait. */
  sleep?: (ms: number) => Promise<void>
}

const num = (v: unknown): number | null => { if (v == null || v === '' || typeof v === 'boolean') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const text = (v: unknown, max = 200): string | null => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null }
const idOf = (v: unknown): string | null => (ID.test(String(v ?? '')) ? String(v) : null)
const dayKey = (ms: number): string => new Date(Math.floor(ms / DAY) * DAY).toISOString().slice(0, 10)

// deno-lint-ignore no-explicit-any
async function readRows(build: () => any): Promise<{ rows: any[]; reason: string | null }> {
  try {
    const { data, error } = await build()
    if (error) return { rows: [], reason: String(error.message || error.code || error).slice(0, 200) }
    return { rows: Array.isArray(data) ? data : data ? [data] : [], reason: null }
  } catch (e) { return { rows: [], reason: ((e as Error)?.message || 'read_failed').slice(0, 200) } }
}

/** INSERT ... ON CONFLICT DO NOTHING. The backfill table grants INSERT and no
 * UPDATE, so a plain upsert would be refused; ignoring duplicates needs INSERT
 * only, and makes a repeated asset-day a no-op rather than a rewrite. */
// deno-lint-ignore no-explicit-any
async function insertIgnoring(db: any, table: string, rows: Record<string, unknown>[], onConflict: string): Promise<{ rows: number; error?: string }> {
  if (!rows.length) return { rows: 0 }
  let written = 0
  for (let start = 0; start < rows.length; start += MAX_INSERT_ROWS) {
    const chunk = rows.slice(start, start + MAX_INSERT_ROWS)
    try {
      const { error } = await db.from(table).upsert(chunk, { onConflict, ignoreDuplicates: true })
      if (error) return { rows: written, error: String(error.message || error).slice(0, 200) }
      written += chunk.length
    } catch (e) { return { rows: written, error: ((e as Error)?.message || 'write_failed').slice(0, 200) } }
  }
  return { rows: written }
}

// deno-lint-ignore no-explicit-any
async function saveState(db: any, cryptoId: string, patch: Record<string, unknown>): Promise<string | null> {
  try {
    const { error } = await db.from(BACKFILL_STATE_TABLE).update(patch).eq('crypto_id', cryptoId)
    return error ? String(error.message || error).slice(0, 200) : null
  } catch (e) { return ((e as Error)?.message || 'state_write_failed').slice(0, 200) }
}

/** Switch and standing ceiling. `max_credits` is the STANDING ceiling, the
 * convention the candle history lane set for a lane that fills an archive once. */
export function backfillPolicy(deps: CaptureDeps): { enabled: boolean; maxCredits: number } {
  const row = (deps.policy || []).find((r) => r?.feature === RWA_WRAPPER_BACKFILL_FEATURE && (r.provider ?? CAPTURE_PROVIDER) === CAPTURE_PROVIDER)
  const ceiling = Number(row?.max_credits)
  return {
    // No row at all is treated as DISABLED, unlike the scheduled lanes: this lane
    // spends credits on retained history and must be switched on deliberately.
    enabled: row ? schedulePolicy(deps.policy, RWA_WRAPPER_BACKFILL_FEATURE).enabled : false,
    maxCredits: row?.max_credits != null && Number.isFinite(ceiling) && ceiling >= 0 ? Math.trunc(ceiling) : RWA_WRAPPER_BACKFILL_CREDIT_CEILING,
  }
}

/** The exact request for one wrapper. Exported so the test proves the credit
 * estimate is 1 and the call carries one id. */
export function backfillParams(cryptoId: string): Record<string, string> {
  return { id: cryptoId, count: String(RWA_WRAPPER_BACKFILL_DAYS), interval: 'daily', time_period: 'daily' }
}

// ─── Seed: each asset's first live capture hour and its wrapper set ───────────

export interface SeedAsset {
  rwaId: string
  firstCapturedAt: string
  symbol: string | null
  name: string | null
  assetType: string | null
  rwaRank: number | null
  wrappers: Map<string, { symbol: string | null; name: string | null; issuerId: string | null; issuerName: string | null }>
}

/** Pure. The first capture hour per asset from rows read oldest first, and the
 * wrappers captured for that asset in that hour. */
// deno-lint-ignore no-explicit-any
export function seedAssets(assetRows: any[], tokenRows: any[]): Map<string, SeedAsset> {
  const assets = new Map<string, SeedAsset>()
  const sorted = [...assetRows].sort((a, b) => String(a?.captured_at ?? '').localeCompare(String(b?.captured_at ?? '')))
  for (const row of sorted) {
    const rwaId = idOf(row?.rwa_id)
    const hour = iso(row?.captured_at)
    if (!rwaId || !hour || assets.has(rwaId)) continue
    assets.set(rwaId, {
      rwaId, firstCapturedAt: hour, symbol: text(row?.symbol, 50), name: text(row?.name, 200),
      assetType: text(row?.asset_type, 40), rwaRank: num(row?.rwa_rank), wrappers: new Map(),
    })
  }
  for (const row of tokenRows) {
    const asset = assets.get(idOf(row?.rwa_id) ?? '')
    const cryptoId = idOf(row?.crypto_id)
    if (!asset || !cryptoId || iso(row?.captured_at) !== asset.firstCapturedAt || asset.wrappers.has(cryptoId)) continue
    asset.wrappers.set(cryptoId, {
      symbol: text(row?.symbol, 50), name: text(row?.name, 200),
      issuerId: text(row?.issuer_id, 100), issuerName: text(row?.issuer_name, 200),
    })
  }
  return assets
}

// ─── One wrapper's daily closes ───────────────────────────────────────────────

export interface DailyClose { day: string; openAt: number; close: number; volume: number | null; marketCap: number | null }

/** Pure. Completed daily candles for ONE id, strictly before `beforeDay`, with
 * the provider's own market cap for the same candle where it reported one. A
 * candle without a positive close is not a price and is dropped. */
export function dailyCloses(payload: unknown, cryptoId: string, beforeDay: string, now: number): DailyClose[] {
  const bars = cmcOhlcvBars(payload, cryptoId, null, DAY)
  const caps = new Map<number, number | null>()
  for (const row of cmcRows('ohlcv', payload).rows.filter((r) => String(r.id) === cryptoId)) {
    for (const point of Array.isArray(row.quotes) ? row.quotes : []) {
      const t = Date.parse(point?.time_open)
      const cap = num(cmcUsdQuote(point)?.market_cap)
      if (Number.isFinite(t)) caps.set(t, cap != null && cap >= 0 ? cap : null)
    }
  }
  const out: DailyClose[] = []
  for (const bar of bars) {
    const close = num(bar.c)
    if (close == null || close <= 0) continue
    if (bar.t + DAY - 1 > now) continue
    const day = dayKey(bar.t)
    if (day >= beforeDay) continue
    const volume = num(bar.v)
    out.push({ day, openAt: bar.t, close, volume: volume != null && volume >= 0 ? volume : null, marketCap: caps.get(bar.t) ?? null })
  }
  return out
}

/** Pure. Rebuild every asset-day from the wrappers' closes and run the live
 * lane's own `wrapperSpread()` on it. One row per wrapper that has a close on
 * that day. */
export function reconstructAsset(
  asset: SeedAsset,
  closes: Map<string, DailyClose[]>,
  context: { fetchedAt: string; floor: number; sourceRefs: Map<string, string> },
): Record<string, unknown>[] {
  const byDay = new Map<string, Map<string, DailyClose>>()
  for (const [cryptoId, list] of closes) {
    for (const close of list) {
      if (!byDay.has(close.day)) byDay.set(close.day, new Map())
      byDay.get(close.day)!.set(cryptoId, close)
    }
  }
  const rows: Record<string, unknown>[] = []
  for (const day of [...byDay.keys()].sort()) {
    const present = byDay.get(day)!
    const tokens: WrapperTokenInput[] = [...present.entries()].map(([cryptoId, close]) => {
      const meta = asset.wrappers.get(cryptoId)
      return {
        cryptoId, symbol: meta?.symbol ?? null, name: meta?.name ?? null,
        issuerId: meta?.issuerId ?? null, issuerName: meta?.issuerName ?? null,
        price: close.close, marketCap: close.marketCap, volume24h: close.volume,
      }
    })
    const input: WrapperAssetInput = {
      rwaId: asset.rwaId, symbol: asset.symbol, name: asset.name, assetType: asset.assetType, rwaRank: asset.rwaRank,
      averageTokenizedPrice: null, tokenizedMarketCap: null, tokenizedVolume24h: null, observedAt: null, tokens,
    }
    // No NAV: the reconstruction never reads a historical net asset value, so the
    // anchor is the liquid wrapper median or none, exactly as the schema allows.
    const spread = wrapperSpread(input, { nav: null, liquidityFloorUsd: context.floor })
    for (const token of spread.tokens) {
      const close = present.get(token.cryptoId)!
      rows.push({
        provider: CAPTURE_PROVIDER, rwa_id: asset.rwaId, crypto_id: token.cryptoId, day, method: BACKFILL_METHOD,
        symbol: token.symbol, name: token.name,
        close_price: close.close, normalised_price: token.normalisedPrice,
        volume_24h: token.volume24h, market_cap: token.marketCap,
        unit_state: token.unitState, unit_factor: token.unitFactor,
        wrapper_state: token.state, state_reason: token.reason,
        premium_bps: token.premiumBps, accrual_gap_bps: token.accrualGapBps, in_anchor: token.inAnchor,
        anchor_kind: spread.anchorKind, anchor_price: spread.anchorPrice, anchor_members: spread.anchorMembers,
        anchor_reason: spread.anchorReason,
        asset_dispersion_bps: spread.dispersionBps, asset_weighted_spread_bps: spread.weightedSpreadBps,
        volume_floor_usd: context.floor,
        wrapper_set_captured_at: asset.firstCapturedAt,
        bar_open_at: new Date(close.openAt).toISOString(),
        source_ref: context.sourceRefs.get(token.cryptoId) ?? `coinmarketcap:ohlcv:${token.cryptoId}:daily:${RWA_WRAPPER_BACKFILL_DAYS}`,
        fetched_at: context.fetchedAt,
      })
    }
  }
  return rows
}

// ─── The lane ─────────────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
async function defaultSourcePolicy(db: any, now: number): Promise<(key: string) => string | undefined> {
  const settings = await loadCmcOperatingSettings(db, now)
  return cmcPolicyEnvironment(settings, (key) => { try { return Deno.env.get(key) } catch { return undefined } }, now)
}

export async function captureRwaWrapperBackfill(
  // deno-lint-ignore no-explicit-any
  db: any,
  ctxFor: (name: string, maxCalls: number) => MarketAssetsContext,
  now: Date,
  plan: string,
  deps: RwaWrapperBackfillDeps,
  body: Record<string, unknown> = {},
): Promise<JobResult> {
  const job = RWA_WRAPPER_BACKFILL_FEATURE
  const at = now instanceof Date ? now.getTime() : Number(now)
  const fetchedAt = new Date(at).toISOString()
  let credits = 0
  try {
    const policy = backfillPolicy(deps)
    if (!policy.enabled) return { job, rows: 0, credits: 0, skipped: 'policy_disabled' }
    const sourcePolicy = deps.sourcePolicy ?? await defaultSourcePolicy(db, at)
    if (sourcePolicy('CMC_ALLOW_HISTORICAL_RETENTION') !== 'true') return { job, rows: 0, credits: 0, skipped: 'historical_retention_not_permitted' }
    if (!planAllows(String(plan || 'basic'), 'startup')) return { job, rows: 0, credits: 0, skipped: 'plan_below_startup', plan }
    const onlyAsset = body?.rwaId != null ? idOf(body.rwaId) : null
    if (body?.rwaId != null && !onlyAsset) return { job, rows: 0, credits: 0, error: 'invalid_rwa_id' }

    // ── Seed from the live tables. Zero credits.
    const assetRead = await readRows(() => db.from(ASSET_TABLE).select('rwa_id,captured_at,symbol,name,asset_type,rwa_rank')
      .order('captured_at', { ascending: true }).limit(RWA_WRAPPER_BACKFILL_SEED_ROWS))
    if (assetRead.reason) return { job, rows: 0, credits: 0, error: `seed_read_failed:${assetRead.reason}`.slice(0, 200) }
    const hours = [...new Set([...seedAssets(assetRead.rows, []).values()].map((a) => a.firstCapturedAt))]
    const tokenRead = hours.length
      ? await readRows(() => db.from(TOKEN_TABLE).select('rwa_id,crypto_id,captured_at,symbol,name,issuer_id,issuer_name')
          .in('captured_at', hours).order('captured_at', { ascending: true }).limit(TOKEN_SEED_ROWS))
      : { rows: [], reason: null }
    if (tokenRead.reason) return { job, rows: 0, credits: 0, error: `seed_read_failed:${tokenRead.reason}`.slice(0, 200) }
    const seeds = seedAssets(assetRead.rows, tokenRead.rows)
    const seedRows: Record<string, unknown>[] = []
    for (const asset of seeds.values()) {
      for (const cryptoId of asset.wrappers.keys()) {
        seedRows.push({ crypto_id: cryptoId, provider: CAPTURE_PROVIDER, rwa_id: asset.rwaId, state: 'pending', wrapper_set_captured_at: asset.firstCapturedAt })
      }
    }
    const seeded = await insertIgnoring(db, BACKFILL_STATE_TABLE, seedRows, 'crypto_id')
    if (seeded.error) return { job, rows: 0, credits: 0, error: `seed_write_failed:${seeded.error}`.slice(0, 200) }

    // ── State: the standing spend and the queue, from one read.
    const stateRead = await readRows(() => db.from(BACKFILL_STATE_TABLE)
      .select('crypto_id,rwa_id,state,credits_spent,attempts').order('rwa_id', { ascending: true }).limit(STATE_ROWS))
    if (stateRead.reason) return { job, rows: 0, credits: 0, error: `state_read_failed:${stateRead.reason}`.slice(0, 200) }
    const spentToDate = stateRead.rows.reduce((sum, row) => sum + (num(row?.credits_spent) ?? 0), 0)
    const budget = Math.max(0, Math.min(RWA_WRAPPER_BACKFILL_IDS_PER_RUN, policy.maxCredits - spentToDate))
    const stateById = new Map(stateRead.rows.map((row) => [String(row?.crypto_id), row]))
    const queued = new Map<string, string[]>()
    for (const row of stateRead.rows) {
      const cryptoId = idOf(row?.crypto_id), rwaId = idOf(row?.rwa_id)
      if (!cryptoId || !rwaId || (onlyAsset && rwaId !== onlyAsset)) continue
      const state = String(row?.state)
      const retry = state === 'failed' && (num(row?.attempts) ?? 0) < RWA_WRAPPER_BACKFILL_MAX_ATTEMPTS
      if (state !== 'pending' && !retry) continue
      if (!queued.has(rwaId)) queued.set(rwaId, [])
      queued.get(rwaId)!.push(cryptoId)
    }
    const base = { seeded: seedRows.length, creditCeiling: policy.maxCredits, creditsSpentToDate: spentToDate }
    if (!queued.size) return { job, rows: 0, credits: 0, skipped: 'queue_empty', ...base }
    if (budget <= 0) return { job, rows: 0, credits: 0, skipped: 'credit_ceiling_reached', ...base }

    const floor = Number.isFinite(Number(deps.liquidityFloorUsd)) && Number(deps.liquidityFloorUsd) >= 0 ? Number(deps.liquidityFloorUsd) : LIQUIDITY_FLOOR_USD
    const ctx = ctxFor('rwa-wrapper-backfill', RWA_WRAPPER_BACKFILL_IDS_PER_RUN)
    let rows = 0, calls = 0, assetsDone = 0, complete = 0, noData = 0, failed = 0
    let stopped: string | null = null
    const stateErrors: string[] = []
    const note = (e: string | null) => { if (e) stateErrors.push(e) }

    for (const [rwaId, ids] of [...queued.entries()].sort(([a], [b]) => Number(a) - Number(b))) {
      const asset = seeds.get(rwaId)
      // Without the wrapper set the names are unknown, and the accrual guard keys
      // on the name: rebuilding blind could publish an accrual as a premium.
      if (!asset || ids.some((id) => !asset.wrappers.has(id))) {
        for (const id of ids) note(await saveState(db, id, { state: 'failed', reason: 'wrapper_set_unavailable', attempts: RWA_WRAPPER_BACKFILL_MAX_ATTEMPTS, updated_at: fetchedAt }))
        failed += ids.length
        continue
      }
      const perId = estimateCmcCredits('ohlcv', backfillParams(ids[0]))
      // The asset is fetched whole or not at all this run.
      if (credits + perId * ids.length > budget) { stopped = 'credit_budget'; break }
      const beforeDay = dayKey(Date.parse(asset.firstCapturedAt))
      const closes = new Map<string, DailyClose[]>()
      const sourceRefs = new Map<string, string>()
      const outcome = new Map<string, { spent: number; failure: string | null; tries: number }>()
      const fetchOne = async (cryptoId: string) => {
        const params = backfillParams(cryptoId)
        // deno-lint-ignore no-explicit-any
        const response: any = await deps.request('ohlcv', params, ctx).catch(() => null)
        calls += 1
        // Credits count only for a request that reached the provider.
        const spent = response?.payload || response?.provenance?.fetchedAt ? estimateCmcCredits('ohlcv', params) : 0
        credits += spent
        const prior = outcome.get(cryptoId)
        const record = { spent: (prior?.spent ?? 0) + spent, tries: (prior?.tries ?? 0) + 1, failure: null as string | null }
        if (!response?.payload) { record.failure = text(response?.reason, 80) || 'provider_unavailable'; outcome.set(cryptoId, record); return }
        closes.set(cryptoId, dailyCloses(response.payload, cryptoId, beforeDay, at))
        const receipt = text(response?.receipt?.id ?? response?.provenance?.receiptId, 80)
        sourceRefs.set(cryptoId, `coinmarketcap:ohlcv:${cryptoId}:daily:${RWA_WRAPPER_BACKFILL_DAYS}:${text(response?.provenance?.fetchedAt, 40) || fetchedAt}${receipt ? `:${receipt}` : ''}`.slice(0, 300))
        outcome.set(cryptoId, record)
      }
      for (const cryptoId of ids) await fetchOne(cryptoId)
      // A wrapper that failed is retried HERE, in the same run, up to its attempt
      // limit. Its siblings already answered and are never fetched (or paid for)
      // again: a wrapper that still fails is closed as failed and the asset is
      // rebuilt from the wrappers that answered, exactly as the terminal path did.
      const priorAttempts = (cryptoId: string) => num(stateById.get(cryptoId)?.attempts) ?? 0
      for (let round = 1; round < RWA_WRAPPER_BACKFILL_MAX_ATTEMPTS; round++) {
        const retry = ids.filter((id) => outcome.get(id)?.failure && priorAttempts(id) + (outcome.get(id)?.tries ?? 0) < RWA_WRAPPER_BACKFILL_MAX_ATTEMPTS)
        if (!retry.length || credits + perId * retry.length > budget) break
        await (deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))))(RETRY_PAUSE_MS * round)
        for (const cryptoId of retry) await fetchOne(cryptoId)
      }
      assetsDone += 1
      const bump = (cryptoId: string) => (num(stateById.get(cryptoId)?.credits_spent) ?? 0) + (outcome.get(cryptoId)?.spent ?? 0)
      const tries = (cryptoId: string) => priorAttempts(cryptoId) + (outcome.get(cryptoId)?.tries ?? 1)

      const failedIds = ids.filter((id) => outcome.get(id)?.failure)
      for (const cryptoId of failedIds) {
        failed += 1
        note(await saveState(db, cryptoId, { state: 'failed', reason: outcome.get(cryptoId)!.failure, attempts: Math.max(tries(cryptoId), RWA_WRAPPER_BACKFILL_MAX_ATTEMPTS), credits_spent: bump(cryptoId), updated_at: fetchedAt }))
      }
      const answered = ids.filter((id) => !outcome.get(id)?.failure)
      if (!answered.length) continue

      const built = reconstructAsset(asset, closes, { fetchedAt, floor, sourceRefs })
      const write = await insertIgnoring(db, BACKFILL_TABLE, built, 'provider,rwa_id,crypto_id,day,method')
      if (write.error) {
        for (const cryptoId of answered) note(await saveState(db, cryptoId, { state: 'failed', reason: `write_failed:${write.error}`.slice(0, 200), attempts: tries(cryptoId), credits_spent: bump(cryptoId), updated_at: fetchedAt }))
        failed += answered.length
        continue
      }
      rows += write.rows
      for (const cryptoId of answered) {
        const days = built.filter((row) => row.crypto_id === cryptoId).map((row) => String(row.day)).sort()
        if (days.length) {
          complete += 1
          note(await saveState(db, cryptoId, { state: 'complete', reason: null, attempts: tries(cryptoId), credits_spent: bump(cryptoId), days_written: days.length, first_day: days[0], last_day: days.at(-1), updated_at: fetchedAt }))
        } else {
          noData += 1
          const raw = closes.get(cryptoId)?.length ?? 0
          note(await saveState(db, cryptoId, { state: 'no_data', reason: raw ? 'no_close_before_live_capture' : 'no_daily_close_reported', attempts: tries(cryptoId), credits_spent: bump(cryptoId), days_written: 0, first_day: null, last_day: null, updated_at: fetchedAt }))
        }
      }
    }

    return {
      job, rows, credits, calls, assets: assetsDone, complete, noData, failed, ...base,
      creditsSpentToDate: spentToDate + credits, budgetExhausted: stopped === 'credit_budget',
      ...(stopped ? { partial: stopped } : {}),
      ...(stateErrors.length ? { error: `state_write_failed:${stateErrors[0]}`.slice(0, 200) } : {}),
    }
  } catch (e) {
    return { job, rows: 0, credits, error: ((e as Error)?.message || 'rwa_wrapper_backfill_failed').slice(0, 200) }
  }
}

/** Integration surface, wired in `intel-capture/index.ts` beside the other lanes.
 * `body.rwaId` optionally limits a run to one asset, for an operator check. */
export const RWA_WRAPPER_BACKFILL_OPS: Record<string, (
  // deno-lint-ignore no-explicit-any
  admin: any, ctxFor: (name: string, maxCalls: number) => MarketAssetsContext, now: Date, plan: string, deps: CaptureDeps, body?: Record<string, unknown>
) => Promise<JobResult>> = {
  rwa_wrapper_backfill: (admin, ctxFor, now, plan, deps, body) =>
    captureRwaWrapperBackfill(admin, ctxFor, now, plan, deps as RwaWrapperBackfillDeps, body ?? {}),
}
