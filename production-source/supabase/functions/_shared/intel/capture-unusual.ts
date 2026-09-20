// Investor Intel — the "unusual for this asset" capture lane.
//
// ZERO PROVIDER CREDITS. This lane calls nothing. It reads three tables we
// already own — the stored daily candle archive (`market_asset_candles`), the
// archive's identity queue (`market_asset_candle_backfill`) and the catalogue
// (`market_assets`) — hands them to the pure scorer in `unusual-moves.ts`, and
// writes one row per asset per scored day. It is registered with its own
// `local` provider row in `provider_schedule_policy` rather than a CoinMarketCap
// one, because a lane that can never spend a credit must not be counted against
// the CoinMarketCap budget or throttled by the credit calibration.
//
// WHY THE COMPUTATION LIVES HERE AND NOT IN SQL. The maths is a median, a median
// absolute deviation, an empirical percentile and an ordinary least squares
// slope over about 9,000 numbers. In SQL that is four ordered-set aggregates and
// a self-join per asset inside a service-role RPC, and a service-role RPC is
// held to the 8-second statement timeout (see the Postgres guard notes). In
// TypeScript it is one bounded paged read and a loop, it is unit-testable
// without a database, and the same function scores a single asset for an asset
// page later. The DATABASE still does the part it is best at: the window filter
// and the ordering.
//
// MEASURED SIZE (production, 2026-09-20). The 95-day daily window is 8,855 rows
// across 97 asset keys. `max_rows = 1000` in supabase/config.toml is the server's
// silent ceiling on any one PostgREST request, so the read PAGES with `.range()`
// exactly as `candle-archive.ts` does; nine pages cover the window. The heaviest
// page (offset 8,000) plans and executes in 24 ms on the
// `market_asset_candles_recent_idx` index, so the whole read is well under a
// second and the run as a whole is a few seconds against a 100-second budget.
// The lane reports `truncated` if the archive ever outgrows ROW_CAP rather than
// silently scoring a partial window.
//
// ONE ROW PER ASSET PER SCORED DAY, not per hour. The scored day is the newest
// COMPLETE UTC day in the archive, so it changes once a day; twenty-four hourly
// rows would be twenty-four copies of one answer. The lane still runs hourly and
// UPSERTS, which buys three things a daily-only run would not: a late or failed
// candle append is picked up within the hour, the catalogue turnover behind the
// ranking is refreshed, and `captured_at` records when the row was last
// recomputed. Retention keeps 30 days, which is a real history of how unusual
// each day was rather than a day of duplicates.

import type { MarketAssetsContext } from '../market-assets/types.ts'
import type { CaptureDeps, JobResult, SchedulePolicyRow } from './capture-jobs.ts'
import {
  DEFAULT_LIQUIDITY_FLOOR_USD, MIN_SAMPLE_DAYS, UNUSUAL_WINDOW_DAYS,
  dailyReturns, scoreUnusualMove, windowOf,
  type DailyClose, type DailyReturn, type UnusualScore,
} from './unusual-moves.ts'

/** This lane's provider in `provider_schedule_policy`. Not 'coinmarketcap': it
 * spends no CoinMarketCap credit and must not be stretched by that account's
 * credit calibration. */
export const UNUSUAL_PROVIDER = 'local'
export const UNUSUAL_FEATURE = 'unusual_moves'
/** Default cadence when the policy row is missing: hourly, matching the cron. */
const DEFAULT_CADENCE_SECONDS = 3600
const CADENCE_GRACE = 0.9

/** Trailing calendar days of candles read. 95 covers the 90-day window plus the
 * subject day and a few days of slack for a weekend gap in a venue series. */
export const UNUSUAL_WINDOW_LOOKBACK_DAYS = 95
/** Rows one PostgREST request may return. Not a preference: `max_rows = 1000`
 * is the server's own silent ceiling. */
const PAGE_ROWS = 1_000
/** Total rows one run may read from the archive. The production window is 8,855,
 * so this is roughly a fourfold headroom; hitting it is reported, never hidden. */
export const UNUSUAL_ROW_CAP = 40_000
/** Identity and catalogue rows one run may read. The archive holds under 100
 * assets; the cap is the same fourfold headroom. */
const IDENTITY_ROW_CAP = 1_000
const MAX_UPSERT_ROWS = 500

/** The asset the market-relative residual is measured against. Bitcoin is
 * identified by its CoinMarketCap id, not by a hard-coded key, so a change of
 * canonical chain identity cannot silently leave the residual measured against
 * nothing. The literal is the fallback for a run where the catalogue read failed. */
export const MARKET_REFERENCE_CMC_ID = '1'
export const MARKET_REFERENCE_FALLBACK_KEY = 'bip122:native:BTC'

/** Provider precedence inside the archive, matching `candle-archive.ts`: a
 * traded venue beats an aggregate, the aggregate beats nothing. Two sources may
 * both hold a day; the read picks one deterministically so the same window
 * always yields the same series. */
const PROVIDER_RANK: Record<string, number> = {
  binance: 0, coinbase: 1, kraken: 2, kucoin: 3, coinmarketcap: 4, coinmarketcap_kline: 5, coingecko: 6,
}
const providerRank = (provider: unknown) => PROVIDER_RANK[String(provider)] ?? 99

const num = (v: unknown): number | null => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
/** A quantity the table's CHECKs require to be non-negative. A negative reading
 * is not clamped to zero (that would invent a figure): it is dropped, because a
 * negative turnover is a broken reading, and one broken row must not reject the
 * whole 500-row write. */
const quantity = (v: unknown): number | null => { const n = num(v); return n == null || n < 0 ? null : n }
/** The catalogue id shape the table accepts. A row whose identity does not match
 * is skipped rather than carried into a write the constraint would reject. */
const CMC_ID = /^[1-9][0-9]{0,9}$/
const int = (v: unknown): number | null => { const n = num(v); return n == null ? null : Math.trunc(n) }
const text = (v: unknown, max = 200): string | null => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null }
const utcDate = (now: Date | number): string => new Date(now instanceof Date ? now.getTime() : now).toISOString().slice(0, 10)
export const hourBucket = (now: Date | number): string =>
  new Date(Math.floor((now instanceof Date ? now.getTime() : now) / 3_600_000) * 3_600_000).toISOString()

/** Tags from a catalogue row's `categories`, whatever shape it arrived in. A
 * malformed value yields no tags rather than a thrown run: an asset with
 * unreadable tags is scored, which is the safe direction for a gate that only
 * ever REMOVES assets. */
export function catalogueTags(categories: unknown): string[] {
  if (Array.isArray(categories)) return categories.map((tag) => String(tag ?? '')).filter(Boolean)
  if (typeof categories === 'string') {
    try { const parsed = JSON.parse(categories); return Array.isArray(parsed) ? parsed.map((t) => String(t ?? '')).filter(Boolean) : [] } catch { return [] }
  }
  return []
}

/** One PostgREST page at a time until the window is exhausted or the cap binds.
 * A SHORT page is the end of the window; a full page may not be, so it asks
 * again. This is the `candle-archive.ts` rule, restated because the silent
 * `max_rows` truncation it exists to defeat is the same one here. */
// deno-lint-ignore no-explicit-any
async function readPaged(build: (from: number, to: number) => any, cap: number): Promise<{ rows: any[]; reason: string | null; truncated: boolean }> {
  // deno-lint-ignore no-explicit-any
  const rows: any[] = []
  try {
    while (rows.length < cap) {
      const size = Math.min(PAGE_ROWS, cap - rows.length)
      const { data, error } = await build(rows.length, rows.length + size - 1)
      if (error) return { rows: [], reason: String(error.message || error.code || error).slice(0, 200), truncated: false }
      const page = Array.isArray(data) ? data : data ? [data] : []
      rows.push(...page)
      if (page.length < size) return { rows, reason: null, truncated: false }
      if (rows.length >= cap) return { rows, reason: null, truncated: true }
    }
    return { rows, reason: null, truncated: true }
  } catch (e) { return { rows: [], reason: ((e as Error)?.message || 'read_failed').slice(0, 200), truncated: false } }
}

/** The stored daily window, reduced to one close and volume per asset per UTC
 * day by the provider precedence above. */
export function seriesByAsset(rows: readonly Record<string, unknown>[]): Map<string, DailyClose[]> {
  // asset -> day -> {close, volume, rank}
  const chosen = new Map<string, Map<string, { close: number; volume: number | null; rank: number }>>()
  for (const row of rows) {
    const assetKey = text(row?.asset_key, 200)
    const close = num(row?.close)
    if (!assetKey || close == null || close <= 0) continue
    const day = String(row?.candle_time ?? '').slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
    const rank = providerRank(row?.provider)
    let days = chosen.get(assetKey)
    if (!days) { days = new Map(); chosen.set(assetKey, days) }
    const held = days.get(day)
    if (!held || rank < held.rank) days.set(day, { close, volume: num(row?.volume), rank })
  }
  const out = new Map<string, DailyClose[]>()
  for (const [assetKey, days] of chosen) {
    out.set(assetKey, [...days.entries()]
      .map(([day, value]) => ({ day, close: value.close, volume: value.volume }))
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)))
  }
  return out
}

export interface AssetIdentity { assetKey: string; cmcId: string; symbol: string | null }

/** One archive key per catalogue asset.
 *
 * Two archive keys can point at the same CoinMarketCap listing: the chain-native
 * key a venue filled and the `cmc:<id>` key the aggregate filled. Production
 * carried this for Bitcoin, Chainlink, Pepe and eight others on 2026-09-20, and
 * without this step each of them appeared TWICE in the ranking with slightly
 * different closes, which is worse than not shipping the section. The key with
 * the longer stored series wins, and the archive provider precedence settles a
 * tie, so the choice is deterministic. */
export function preferOneKeyPerAsset(
  identities: readonly AssetIdentity[],
  series: Map<string, DailyClose[]>,
): AssetIdentity[] {
  const best = new Map<string, { identity: AssetIdentity; days: number }>()
  for (const identity of identities) {
    const days = (series.get(identity.assetKey) || []).length
    if (!days) continue
    const held = best.get(identity.cmcId)
    if (!held || days > held.days || (days === held.days && identity.assetKey < held.identity.assetKey)) {
      best.set(identity.cmcId, { identity, days })
    }
  }
  return [...best.values()].map((entry) => entry.identity)
}

/** The lane's own policy row. `loadSchedulePolicy` in capture-jobs.ts reads
 * `coinmarketcap` rows only, so this lane loads its own, exactly as the
 * launchpad and SunPump lanes do for theirs. */
// deno-lint-ignore no-explicit-any
export async function loadUnusualPolicy(db: any): Promise<SchedulePolicyRow | null> {
  try {
    const { data, error } = await db.from('provider_schedule_policy')
      .select('provider,feature,cadence_seconds,enabled,min_plan,max_credits')
      .eq('provider', UNUSUAL_PROVIDER).eq('feature', UNUSUAL_FEATURE).limit(1)
    if (error) return null
    const row = Array.isArray(data) ? data[0] : data
    return (row as SchedulePolicyRow) ?? null
  } catch { return null }
}

/** One stored row. The figures are the ones the surface prints; the windows ride
 * along as jsonb so a reader can expand a row without a second read and without
 * this table growing a column per window per metric. */
export function scoreRow(
  score: UnusualScore,
  identity: { assetKey: string; cmcId: string; symbol: string | null; name: string | null },
  catalogue: { liquidityUsd: number | null; marketCap: number | null; rank: number | null; asOf: string | null },
  capturedAt: string,
  leadWindow = 90,
): Record<string, unknown> | null {
  if (!score.subjectDay) return null
  const lead = windowOf(score, leadWindow)
  return {
    asset_key: identity.assetKey, subject_day: score.subjectDay,
    cmc_id: identity.cmcId, symbol: identity.symbol, name: identity.name,
    captured_at: capturedAt,
    scored: score.scored, reason: score.reason,
    sample_days: score.sampleDays, required_days: score.requiredDays,
    is_market_reference: score.isMarketReference,
    move_pct: score.movePct, volume: quantity(score.volume),
    lead_window_days: score.scored ? leadWindow : null,
    // The lead window's figures are columns so the ranking and the alert read
    // can order and filter on them without unpacking jsonb on every row.
    move_percentile: lead?.percentile ?? null,
    move_exceeded: lead?.exceeded ?? null,
    median_abs_pct: lead?.medianAbsPct ?? null,
    mad_pct: lead?.madPct ?? null,
    robust_z: lead?.robustZ ?? null,
    volume_percentile: lead?.volumePercentile ?? null,
    volume_robust_z: lead?.volumeRobustZ ?? null,
    beta: lead?.beta ?? null,
    beta_n: lead?.betaN ?? null,
    residual_pct: lead?.residualPct ?? null,
    market_move_pct: lead?.marketMovePct ?? null,
    liquidity_usd: quantity(catalogue.liquidityUsd), market_cap: quantity(catalogue.marketCap), market_cap_rank: catalogue.rank,
    catalogue_as_of: catalogue.asOf,
    windows: score.windows,
  }
}

// deno-lint-ignore no-explicit-any
async function upsert(db: any, rows: Record<string, unknown>[]): Promise<{ rows: number; error?: string }> {
  if (!rows.length) return { rows: 0 }
  let written = 0
  for (let start = 0; start < rows.length; start += MAX_UPSERT_ROWS) {
    const chunk = rows.slice(start, start + MAX_UPSERT_ROWS)
    try {
      const { error } = await db.from('intel_unusual_move_scores').upsert(chunk, { onConflict: 'asset_key,subject_day' })
      if (error) return { rows: written, error: String(error.message || error).slice(0, 200) }
      written += chunk.length
    } catch (e) { return { rows: written, error: ((e as Error)?.message || 'write_failed').slice(0, 200) } }
  }
  return { rows: written }
}

const CANDLE_COLUMNS = 'asset_key,provider,candle_time,close,volume'
const IDENTITY_COLUMNS = 'asset_key,cmc_id,symbol'
const CATALOGUE_COLUMNS = 'provider_id,symbol,name,market_cap_rank,market_cap,volume_24h,categories,as_of'

/**
 * Score every archive asset's newest complete day against its own history.
 *
 * Zero credits, three reads plus one write. The result reports what it scored,
 * what it refused and why, so a reader of the job log can see the shape of the
 * run without opening the table.
 */
// deno-lint-ignore no-explicit-any
export async function captureUnusualMoves(db: any, now = new Date(), options: { liquidityFloorUsd?: number } = {}): Promise<JobResult> {
  const job = 'unusual_moves'
  try {
    const policy = await loadUnusualPolicy(db)
    if (policy && policy.enabled === false) return { job, rows: 0, credits: 0, skipped: 'policy_disabled' }
    const cadence = num(policy?.cadence_seconds) ?? DEFAULT_CADENCE_SECONDS
    // The freshness guard reads this lane's own newest capture clock, so an
    // overlapping cron tick never repeats the work of the one before it.
    const newest = await (async () => {
      try {
        const { data, error } = await db.from('intel_unusual_move_scores').select('captured_at')
          .order('captured_at', { ascending: false }).limit(1)
        if (error) return null
        const row = Array.isArray(data) ? data[0] : data
        const parsed = Date.parse(String(row?.captured_at ?? ''))
        return Number.isFinite(parsed) ? parsed : null
      } catch { return null }
    })()
    if (newest != null && cadence > 0 && now.getTime() - newest < cadence * 1000 * CADENCE_GRACE) {
      return { job, rows: 0, credits: 0, skipped: 'within_cadence', newestAt: new Date(newest).toISOString() }
    }

    const from = new Date(now.getTime() - UNUSUAL_WINDOW_LOOKBACK_DAYS * 86_400_000).toISOString()
    const candles = await readPaged((lo, hi) => db.from('market_asset_candles').select(CANDLE_COLUMNS)
      .eq('candle_interval', '1d').gte('candle_time', from)
      .order('asset_key', { ascending: true }).order('candle_time', { ascending: true })
      .range(lo, hi), UNUSUAL_ROW_CAP)
    if (candles.reason) return { job, rows: 0, credits: 0, error: candles.reason }
    if (!candles.rows.length) return { job, rows: 0, credits: 0, skipped: 'archive_empty' }

    const series = seriesByAsset(candles.rows)

    const identityRead = await readPaged((lo, hi) => db.from('market_asset_candle_backfill').select(IDENTITY_COLUMNS)
      .not('cmc_id', 'is', null).order('asset_key', { ascending: true }).range(lo, hi), IDENTITY_ROW_CAP)
    if (identityRead.reason) return { job, rows: 0, credits: 0, error: identityRead.reason }
    const identities = preferOneKeyPerAsset(identityRead.rows
      .map((row) => ({ assetKey: text(row?.asset_key, 200) || '', cmcId: text(row?.cmc_id, 12) || '', symbol: text(row?.symbol, 50) }))
      .filter((row) => row.assetKey && CMC_ID.test(row.cmcId)), series)
    if (!identities.length) return { job, rows: 0, credits: 0, skipped: 'no_catalogue_identity' }

    // One catalogue read for the assets in hand. `.in()` over about 100 ids is a
    // single request; the cap keeps it one request if the archive grows.
    const cmcIds = [...new Set(identities.map((i) => i.cmcId))].slice(0, IDENTITY_ROW_CAP)
    const catalogueRead = await readPaged((lo, hi) => db.from('market_assets').select(CATALOGUE_COLUMNS)
      .eq('source_provider', 'coinmarketcap').in('provider_id', cmcIds)
      .order('provider_id', { ascending: true }).range(lo, hi), IDENTITY_ROW_CAP)
    if (catalogueRead.reason) return { job, rows: 0, credits: 0, error: catalogueRead.reason }
    const catalogue = new Map<string, Record<string, unknown>>()
    for (const row of catalogueRead.rows) { const id = text(row?.provider_id, 12); if (id) catalogue.set(id, row) }

    // The market reference, resolved through the catalogue id rather than named.
    const referenceKey = identities.find((i) => i.cmcId === MARKET_REFERENCE_CMC_ID)?.assetKey ?? MARKET_REFERENCE_FALLBACK_KEY
    const marketReturns: DailyReturn[] = dailyReturns(series.get(referenceKey) || [])

    const capturedAt = hourBucket(now)
    const floor = num(options.liquidityFloorUsd) ?? DEFAULT_LIQUIDITY_FLOOR_USD
    const rows: Record<string, unknown>[] = []
    const refusals: Record<string, number> = {}
    let scored = 0, unscorable = 0
    for (const identity of identities) {
      const cat = catalogue.get(identity.cmcId)
      const score = scoreUnusualMove({
        assetKey: identity.assetKey,
        series: series.get(identity.assetKey) || [],
        marketReturns, marketKey: referenceKey,
        liquidityUsd: num(cat?.volume_24h),
        tags: catalogueTags(cat?.categories),
        symbol: text(cat?.symbol, 50) ?? identity.symbol,
        liquidityFloorUsd: floor,
        minSampleDays: MIN_SAMPLE_DAYS,
        windowDays: UNUSUAL_WINDOW_DAYS,
      })
      const row = scoreRow(score, {
        assetKey: identity.assetKey, cmcId: identity.cmcId,
        symbol: text(cat?.symbol, 50) ?? identity.symbol, name: text(cat?.name, 200),
      }, {
        liquidityUsd: num(cat?.volume_24h), marketCap: num(cat?.market_cap),
        rank: (int(cat?.market_cap_rank) ?? 0) > 0 ? int(cat?.market_cap_rank) : null,
        asOf: text(cat?.as_of, 40),
      }, capturedAt)
      // An asset with fewer than two consecutive stored days has no day to date a
      // row by, so it is counted rather than written against a synthetic day.
      if (!row) { unscorable += 1; continue }
      if (score.scored) scored += 1
      else refusals[score.reason || 'unknown'] = (refusals[score.reason || 'unknown'] ?? 0) + 1
      rows.push(row)
    }

    const written = await upsert(db, rows)
    return {
      job, rows: written.rows, credits: 0, capturedAt,
      subjectDay: rows.map((r) => String(r.subject_day)).sort().at(-1) ?? null,
      assets: identities.length, scored, refused: refusals, unscorable,
      archiveRows: candles.rows.length, runDay: utcDate(now),
      ...(candles.truncated ? { partial: 'archive_row_cap_reached' } : {}),
      ...(written.error ? { error: written.error } : {}),
    }
  } catch (e) {
    return { job, rows: 0, credits: 0, error: ((e as Error)?.message || 'capture_failed').slice(0, 200) }
  }
}

/** Integration surface consumed by `intel-capture/index.ts`. Keyed by op name.
 * The lane takes no provider transport, so the injected `ctxFor`, `plan` and
 * `deps` are unused: it cannot spend a credit even by mistake. */
export const UNUSUAL_CAPTURE_OPS: Record<string, (
  // deno-lint-ignore no-explicit-any
  admin: any, ctxFor: (name: string, maxCalls: number) => MarketAssetsContext, now: Date, plan: string, deps: CaptureDeps, body?: Record<string, unknown>
) => Promise<JobResult>> = {
  unusual_moves: (admin, _ctxFor, now, _plan, _deps, body) =>
    captureUnusualMoves(admin, now, { liquidityFloorUsd: num(body?.liquidityFloorUsd) ?? undefined }),
}
