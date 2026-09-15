// Investor Intel — CoinMarketCap capture jobs.
//
// One function per capture lane. Each job is bounded (a single provider page
// unless stated), never throws (a failure becomes `{ error }` in its result),
// and obeys `provider_schedule_policy`: a feature with `enabled = false` is
// skipped with `policy_disabled`, and a job whose newest stored row is younger
// than the feature's `cadence_seconds` is skipped with `within_cadence` so an
// overlapping cron run never spends a second set of credits.
//
// Nothing here calls CoinMarketCap directly: the transport is injected as
// `deps.request` (the real `requestCmc` in the Edge Function, a fake in tests),
// so the module stays pure enough to test without a network or a database.
//
// Credits reported per job are the UPPER bound — the number of provider calls
// the job may issue. The transport serves a cached snapshot for 0 credits when
// one is still fresh, so the billed total is never higher than what is reported.

import { cmcRows, cmcUsdQuote, cmcObservedAt, planAllows } from '../market-assets/cmc-capabilities.ts'
import type { MarketAssetsContext } from '../market-assets/types.ts'

export const CAPTURE_PROVIDER = 'coinmarketcap'
export const RWA_ASSET_TYPES = ['stock', 'commodity', 'currency', 'government_security', 'etf', 'real_estate'] as const
export type RwaAssetType = typeof RWA_ASSET_TYPES[number]

// deno-lint-ignore no-explicit-any
export type CaptureRequest = (name: string, params?: Record<string, unknown>, ctx?: MarketAssetsContext) => Promise<any>
/** `max_credits` is the STANDING credit ceiling for a feature, added with the
 * candle history lane: a lane that fills an archive once needs a budget it can
 * be held to across runs, not only a per-run ceiling. A lane with no ceiling in
 * its row falls back to its own documented default. */
export interface SchedulePolicyRow { provider?: string; feature: string; cadence_seconds?: number | null; enabled?: boolean | null; min_plan?: string | null; max_credits?: number | null }
export interface CaptureDeps { request: CaptureRequest; policy?: SchedulePolicyRow[] }
export interface JobResult { job: string; rows: number; credits: number; skipped?: string; error?: string; [key: string]: unknown }

// A job whose feature has no policy row still runs on the cadence the tables
// were designed for, so a deleted row degrades to the documented schedule.
const DEFAULT_CADENCE: Record<string, number> = { regime: 3600, structure: 300, rwa: 3600, attention: 3600, history: 86400, airdrops: 86400 }
// Cron fires on wall-clock minutes; a run that lands a few seconds early must
// not be mistaken for an overlapping duplicate.
const CADENCE_GRACE = 0.9
const MAX_UPSERT_ROWS = 500

const num = (v: unknown): number | null => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const int = (v: unknown): number | null => { const n = num(v); return n == null ? null : Math.trunc(n) }
const count = (v: unknown): number | null => { const n = int(v); return n == null || n < 0 ? null : n }
const text = (v: unknown, max = 200): string | null => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null }
export function iso(value: unknown): string | null {
  if (value == null || value === '') return null
  const numeric = typeof value === 'number' || /^\d{10,13}$/.test(String(value)) ? Number(value) : NaN
  const parsed = Number.isFinite(numeric) ? (numeric < 1e12 ? numeric * 1000 : numeric) : Date.parse(String(value))
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

/** Capture buckets. Every hourly row lands on the hour and every liquidation row
 * on a 5-minute mark, so the primary key absorbs a retried or overlapping run. */
export const hourBucket = (now: Date | number): string => new Date(Math.floor((now instanceof Date ? now.getTime() : now) / 3_600_000) * 3_600_000).toISOString()
export const fiveMinuteBucket = (now: Date | number): string => new Date(Math.floor((now instanceof Date ? now.getTime() : now) / 300_000) * 300_000).toISOString()
export const utcDate = (now: Date | number): string => new Date(now instanceof Date ? now.getTime() : now).toISOString().slice(0, 10)

/** Mondays (UTC), newest first, anchored at or before yesterday: the provider's
 * historical listing for the current day is still moving. */
export function backfillMondays(now: Date, weeks: number): string[] {
  const anchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 86_400_000)
  anchor.setUTCDate(anchor.getUTCDate() - ((anchor.getUTCDay() + 6) % 7))
  const dates: string[] = []
  for (let week = 0; week < Math.max(0, Math.min(520, Math.trunc(weeks))); week++) dates.push(utcDate(anchor.getTime() - week * 7 * 86_400_000))
  return dates
}

export async function loadSchedulePolicy(db: any): Promise<SchedulePolicyRow[]> {
  try {
    const { data, error } = await db.from('provider_schedule_policy')
      .select('provider,feature,cadence_seconds,enabled,min_plan,max_credits').eq('provider', CAPTURE_PROVIDER).limit(100)
    return error ? [] : ((data || []) as SchedulePolicyRow[])
  } catch { return [] }
}

export function schedulePolicy(rows: SchedulePolicyRow[] | undefined, feature: string): { enabled: boolean; cadenceSeconds: number; minPlan: string | null } {
  const row = (rows || []).find((r) => r?.feature === feature && (r.provider ?? CAPTURE_PROVIDER) === CAPTURE_PROVIDER)
  const cadence = Number(row?.cadence_seconds)
  return {
    enabled: row ? row.enabled !== false : true,
    cadenceSeconds: Number.isFinite(cadence) && cadence > 0 ? cadence : (DEFAULT_CADENCE[feature] ?? 3600),
    minPlan: row?.min_plan ?? null,
  }
}

/** Newest value of a timestamp column, or null when the table is empty or the
 * read failed. A failed read never blocks a capture: the write is idempotent. */
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

async function guardJob(db: any, job: string, feature: string, deps: CaptureDeps, now: Date,
  freshness: { table: string; column: string; filters?: [string, unknown][] }): Promise<JobResult | null> {
  const policy = schedulePolicy(deps.policy, feature)
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

// ─── 1. Market regime (hourly) ────────────────────────────────────────────────
// Fear & greed, altcoin season and global metrics are three separate 1-credit
// endpoints; one hourly row carries all three plus the latest provider clock.
export async function captureRegime(db: any, ctx: MarketAssetsContext, now = new Date(), deps: CaptureDeps): Promise<JobResult> {
  const job = 'regime'
  try {
    const skip = await guardJob(db, job, 'regime', deps, now, { table: 'intel_regime_snapshots', column: 'captured_at' })
    if (skip) return skip
    const [fear, season, global] = await Promise.all([
      deps.request('fearGreed', {}, ctx).catch(() => null),
      deps.request('altcoinSeason', {}, ctx).catch(() => null),
      deps.request('global', {}, ctx).catch(() => null),
    ])
    const credits = 3
    const fearData = fear?.payload?.data ?? null, seasonData = season?.payload?.data ?? null, globalData = global?.payload?.data ?? null
    if (fearData == null && seasonData == null && globalData == null) {
      return { job, rows: 0, credits, error: fear?.reason || season?.reason || global?.reason || 'provider_unavailable' }
    }
    const fearRow = Array.isArray(fearData) ? fearData[0] ?? {} : fearData ?? {}
    const seasonRow = Array.isArray(seasonData) ? seasonData[0] ?? {} : seasonData ?? {}
    const globalRow = Array.isArray(globalData) ? globalData[0] ?? {} : globalData ?? {}
    const quote = cmcUsdQuote(globalRow || {})
    // Each payload reports its own clock; the row records the latest of them, so
    // "as of" never claims data newer than the freshest provider observation.
    const observed = [
      fear?.payload ? cmcObservedAt(fear.payload, 'fearGreed') : null,
      season?.payload ? cmcObservedAt(season.payload, 'altcoinSeason') : null,
      global?.payload ? cmcObservedAt(global.payload, 'global') : null,
    ].filter((v): v is string => !!v).sort().at(-1) ?? null

    const row = {
      provider: CAPTURE_PROVIDER, captured_at: hourBucket(now),
      fear_greed_value: num(fearRow.value),
      fear_greed_class: text(fearRow.value_classification ?? fearRow.classification, 60),
      altcoin_season_index: num(seasonRow.altcoin_index ?? seasonRow.altcoin_season_index ?? seasonRow.value),
      btc_dominance: num(globalRow.btc_dominance), eth_dominance: num(globalRow.eth_dominance),
      total_market_cap: num(quote.total_market_cap), total_volume_24h: num(quote.total_volume_24h),
      stablecoin_market_cap: num(quote.stablecoin_market_cap ?? globalRow.stablecoin_market_cap),
      defi_market_cap: num(quote.defi_market_cap ?? globalRow.defi_market_cap),
      source_observed_at: observed,
      raw: {
        fearGreed: fearData == null ? null : { value: num(fearRow.value), classification: text(fearRow.value_classification ?? fearRow.classification, 60), updateTime: iso(fearRow.update_time ?? fearRow.last_updated) },
        altcoinSeason: seasonData == null ? null : { index: num(seasonRow.altcoin_index ?? seasonRow.altcoin_season_index ?? seasonRow.value), altcoinMarketCap: num(seasonRow.altcoin_marketcap), updateTime: iso(seasonRow.timestamp ?? seasonRow.last_updated) },
        global: globalData == null ? null : { btcDominance: num(globalRow.btc_dominance), ethDominance: num(globalRow.eth_dominance), activeCryptocurrencies: count(globalRow.active_cryptocurrencies), updateTime: iso(globalRow.last_updated ?? quote.last_updated) },
      },
    }
    const written = await upsert(db, 'intel_regime_snapshots', [row], 'provider,captured_at')
    return { job, rows: written.rows, credits, capturedAt: row.captured_at, observedAt: observed, ...(written.error ? { error: written.error } : {}) }
  } catch (e) { return failed(job, 3, e) }
}

// ─── 2. CMC100 / CMC20 index levels and constituents (hourly) ─────────────────
export async function captureIndexConstituents(db: any, ctx: MarketAssetsContext, now = new Date(), deps: CaptureDeps): Promise<JobResult> {
  const job = 'index'
  try {
    const skip = await guardJob(db, job, 'structure', deps, now, { table: 'intel_index_constituent_snapshots', column: 'captured_at' })
    if (skip) return skip
    const capturedAt = hourBucket(now)
    const rows: Record<string, unknown>[] = []
    let credits = 0, reason: string | null = null
    for (const code of ['cmc100', 'cmc20'] as const) {
      const result = await deps.request(code, {}, ctx).catch(() => null)
      credits += 1
      const data = Array.isArray(result?.payload?.data) ? result.payload.data[0] : result?.payload?.data
      if (!data) { reason = reason || result?.reason || 'provider_unavailable'; continue }
      const constituents = (Array.isArray(data.constituents) ? data.constituents : []).slice(0, 250)
        .map((c: any) => ({ id: int(c?.id), symbol: text(c?.symbol, 50), name: text(c?.name, 200), weight: num(c?.weight) }))
        .filter((c: any) => c.id != null || c.symbol != null)
      rows.push({
        index_code: code, captured_at: capturedAt,
        index_value: num(data.value), value_24h_pct: num(data.value_24h_percentage_change),
        constituents,
      })
    }
    if (!rows.length) return { job, rows: 0, credits, error: reason || 'provider_unavailable' }
    const written = await upsert(db, 'intel_index_constituent_snapshots', dedupe(rows, (r) => String(r.index_code)), 'index_code,captured_at')
    return { job, rows: written.rows, credits, capturedAt, ...(reason ? { partial: reason } : {}), ...(written.error ? { error: written.error } : {}) }
  } catch (e) { return failed(job, 2, e) }
}

// ─── 3. Tokenised real-world asset universe (hourly) ──────────────────────────
/** Issuer identity lives on the token relationships of an RWA record; a record
 * with no reported issuer contributes no issuer, never a synthetic one. */
function rwaIssuerIds(row: any): string[] {
  const ids = new Set<string>()
  for (const token of (Array.isArray(row?.tokens) ? row.tokens : [])) { const id = text(token?.issuer_id, 100); if (id) ids.add(id) }
  for (const issuer of (Array.isArray(row?.issuers) ? row.issuers : [])) { const id = text(issuer?.issuer_id ?? issuer?.id, 100); if (id) ids.add(id) }
  const direct = text(row?.issuer_id, 100); if (direct) ids.add(direct)
  return [...ids]
}

export function rwaAggregate(rows: any[]): { assetCount: number; issuers: Set<string>; value: number | null; volume: number | null; changePct: number | null; topAssets: Record<string, unknown>[] } {
  const issuers = new Set<string>()
  let value = 0, volume = 0, weighted = 0, weightBase = 0, valueSeen = false, volumeSeen = false
  const assets: { rwa_id: number | null; symbol: string | null; name: string | null; value: number | null }[] = []
  for (const row of rows) {
    const quote = row?.quote ?? {}
    const assetValue = num(quote.tokenized_market_cap ?? row?.tokenized_market_cap ?? quote.total_market_value ?? row?.total_market_value ?? quote.market_cap ?? row?.market_cap)
    const assetVolume = num(quote.volume_24h ?? row?.volume_24h ?? quote.total_volume_24h ?? row?.total_volume_24h)
    const change = num(quote.percent_change_24h ?? row?.percent_change_24h ?? quote.price_change_24h)
    if (assetValue != null && assetValue >= 0) { value += assetValue; valueSeen = true }
    if (assetVolume != null && assetVolume >= 0) { volume += assetVolume; volumeSeen = true }
    // A value-weighted change needs both a weight and a change; assets missing
    // either are left out of the average rather than counted as unchanged.
    if (assetValue != null && assetValue > 0 && change != null) { weighted += change * assetValue; weightBase += assetValue }
    for (const id of rwaIssuerIds(row)) issuers.add(id)
    assets.push({ rwa_id: int(row?.rwa_id), symbol: text(row?.symbol, 50), name: text(row?.name, 200), value: assetValue })
  }
  const topAssets = assets.filter((a) => a.value != null).sort((a, b) => (b.value as number) - (a.value as number)).slice(0, 10)
  return {
    assetCount: rows.length, issuers,
    value: valueSeen ? value : null, volume: volumeSeen ? volume : null,
    changePct: weightBase > 0 ? weighted / weightBase : null,
    topAssets,
  }
}

export async function captureRwaUniverse(db: any, ctx: MarketAssetsContext, now = new Date(), deps: CaptureDeps): Promise<JobResult> {
  const job = 'rwa'
  try {
    const skip = await guardJob(db, job, 'rwa', deps, now, { table: 'intel_rwa_universe_snapshots', column: 'captured_at' })
    if (skip) return skip
    const capturedAt = hourBucket(now)
    const rows: Record<string, unknown>[] = []
    const allIssuers = new Set<string>()
    let credits = 0, reason: string | null = null
    let allAssets = 0, allValue = 0, allVolume = 0, allWeighted = 0, allWeightBase = 0, allValueSeen = false, allVolumeSeen = false
    const allTop: Record<string, unknown>[] = []
    for (const assetType of RWA_ASSET_TYPES) {
      const result = await deps.request('rwaList', { asset_type: assetType, limit: 250, start: 1 }, ctx).catch(() => null)
      credits += 1
      if (!result?.payload) { reason = reason || result?.reason || 'provider_unavailable'; continue }
      const page = cmcRows('rwaList', result.payload).rows
      const summary = rwaAggregate(page)
      for (const id of summary.issuers) allIssuers.add(id)
      allAssets += summary.assetCount
      if (summary.value != null) { allValue += summary.value; allValueSeen = true }
      if (summary.volume != null) { allVolume += summary.volume; allVolumeSeen = true }
      if (summary.value != null && summary.value > 0 && summary.changePct != null) { allWeighted += summary.changePct * summary.value; allWeightBase += summary.value }
      allTop.push(...summary.topAssets)
      rows.push({
        provider: CAPTURE_PROVIDER, asset_type: assetType, captured_at: capturedAt,
        asset_count: summary.assetCount, issuer_count: summary.issuers.size,
        total_market_value_usd: summary.value, volume_24h_usd: summary.volume,
        change_24h_pct: summary.changePct, top_assets: summary.topAssets,
      })
    }
    if (!rows.length) return { job, rows: 0, credits, error: reason || 'provider_unavailable' }
    // The 'all' row is derived from the pages already fetched — never a seventh call.
    rows.push({
      provider: CAPTURE_PROVIDER, asset_type: 'all', captured_at: capturedAt,
      asset_count: allAssets, issuer_count: allIssuers.size,
      total_market_value_usd: allValueSeen ? allValue : null,
      volume_24h_usd: allVolumeSeen ? allVolume : null,
      change_24h_pct: allWeightBase > 0 ? allWeighted / allWeightBase : null,
      top_assets: allTop.sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0)).slice(0, 10),
    })
    const written = await upsert(db, 'intel_rwa_universe_snapshots', dedupe(rows, (r) => String(r.asset_type)), 'provider,asset_type,captured_at')
    return { job, rows: written.rows, credits, capturedAt, types: rows.length - 1, ...(reason ? { partial: reason } : {}), ...(written.error ? { error: written.error } : {}) }
  } catch (e) { return failed(job, RWA_ASSET_TYPES.length, e) }
}

// ─── 4. Daily rank history from the catalogue (no provider call) ──────────────
// The catalogue refresh already paid for today's listing; this job only records
// what it holds, so a daily rank series costs zero credits.
const CATALOGUE_COLUMNS = 'provider_id,symbol,name,market_cap_rank,current_price,market_cap,volume_24h,circulating_supply,total_supply,max_supply,num_market_pairs,change_24h_pct,change_7d_pct,as_of'

export async function captureRankDaily(db: any, _ctx: MarketAssetsContext, now = new Date(), deps: CaptureDeps): Promise<JobResult> {
  const job = 'rank_daily'
  try {
    const skip = await guardJob(db, job, 'history', deps, now, { table: 'intel_rank_history', column: 'created_at', filters: [['source', 'listings_latest']] })
    if (skip) return skip
    const snapshotDate = utcDate(now)
    const { data, error } = await db.from('market_assets').select(CATALOGUE_COLUMNS)
      .eq('source_provider', CAPTURE_PROVIDER).eq('in_current_catalog', true)
      .order('market_cap_rank', { ascending: true, nullsFirst: false }).limit(1000)
    if (error) return { job, rows: 0, credits: 0, error: String(error.message || error).slice(0, 200) }
    const catalogue = (data || []) as any[]
    if (!catalogue.length) return { job, rows: 0, credits: 0, skipped: 'catalogue_empty' }
    const rows = dedupe(catalogue.map((row) => ({
      provider: CAPTURE_PROVIDER, snapshot_date: snapshotDate, provider_id: String(row.provider_id),
      symbol: text(row.symbol, 50), name: text(row.name, 200),
      rank: (int(row.market_cap_rank) ?? 0) > 0 ? int(row.market_cap_rank) : null,
      price: num(row.current_price), market_cap: num(row.market_cap), volume_24h: num(row.volume_24h),
      circulating_supply: num(row.circulating_supply), total_supply: num(row.total_supply), max_supply: num(row.max_supply),
      // Written by market-assets-refresh since migration 20260914234442; null
      // only while a row predates it or the provider reported none.
      num_market_pairs: count(row.num_market_pairs),
      change_24h_pct: num(row.change_24h_pct), change_7d_pct: num(row.change_7d_pct),
      source: 'listings_latest', observed_at: iso(row.as_of),
    })).filter((row) => row.provider_id && row.provider_id !== 'null'), (r) => r.provider_id)
    const written = await upsert(db, 'intel_rank_history', rows, 'provider,snapshot_date,provider_id')
    // The recorded high is derived from the rows just written plus the
    // catalogue's own price, so it is another zero-credit reading rather than a
    // provider call. It runs after the upsert so today's row is already part of
    // the window it measures against, and a failure here is reported as a
    // partial: the rank history was still captured.
    const highs = await refreshRecordedHighs(db)
    return {
      job, rows: written.rows, credits: 0, snapshotDate, highsRefreshed: highs.refreshed,
      ...(written.error ? { error: written.error } : highs.error ? { partial: highs.error } : {}),
    }
  } catch (e) { return failed(job, 0, e) }
}

/** Recompute market_assets.recorded_high_* / drawdown_pct for the catalogue's
 * top 1,000. One bounded service-role statement, no provider call. Returns the
 * row count the database reports, or a reason when the call could not be made. */
export async function refreshRecordedHighs(db: any): Promise<{ refreshed: number | null; error?: string }> {
  try {
    const { data, error } = await db.rpc('intel_refresh_recorded_highs', { p_provider: CAPTURE_PROVIDER })
    if (error) return { refreshed: null, error: String(error.message || error).slice(0, 200) }
    return { refreshed: count((data as any)?.refreshed) ?? 0 }
  } catch (e) { return { refreshed: null, error: ((e as Error)?.message || 'recorded_highs_failed').slice(0, 200) } }
}

// ─── 5. Weekly rank-history backfill (listings/historical) ────────────────────
export async function backfillRankHistory(db: any, ctx: MarketAssetsContext,
  options: { weeks?: number; limit?: number; now?: Date; maxWeeksPerRun?: number } = {}, deps: CaptureDeps): Promise<JobResult> {
  const job = 'rank_backfill'
  const weeks = Math.max(1, Math.min(520, Math.trunc(Number(options.weeks) || 52)))
  const limit = Math.max(1, Math.min(250, Math.trunc(Number(options.limit) || 250)))
  const maxWeeks = Math.max(1, Math.min(52, Math.trunc(Number(options.maxWeeksPerRun) || 8)))
  const now = options.now || new Date()
  let credits = 0
  try {
    const skip = await guardJob(db, job, 'history', deps, now, { table: 'intel_rank_history', column: 'created_at', filters: [['source', 'listings_historical']] })
    if (skip) return { ...skip, remaining: null }
    const dates = backfillMondays(now, weeks)
    let fetched = 0, written = 0, remaining = 0, reason: string | null = null
    for (const date of dates) {
      let present = true
      try {
        const { data, error } = await db.from('intel_rank_history').select('provider_id')
          .eq('provider', CAPTURE_PROVIDER).eq('snapshot_date', date).eq('source', 'listings_historical').limit(1)
        // An unreadable week is treated as present: never spend credits blind.
        present = error ? true : (Array.isArray(data) ? data.length > 0 : !!data)
      } catch { present = true }
      if (present) continue
      if (fetched >= maxWeeks) { remaining += 1; continue }
      fetched += 1
      // 250 historical rows bill 3 credits (1 per 100 points).
      credits += Math.ceil(limit / 100)
      const result = await deps.request('listingsHistorical', { date, limit, start: 1 }, ctx).catch(() => null)
      if (!result?.payload) { reason = reason || result?.reason || 'provider_unavailable'; remaining += 1; continue }
      const rows = dedupe(cmcRows('listingsHistorical', result.payload).rows.map((row: any) => {
        const quote = row?.quote ?? {}
        return {
          provider: CAPTURE_PROVIDER, snapshot_date: date, provider_id: String(row?.id ?? row?.crypto_id ?? ''),
          symbol: text(row?.symbol, 50), name: text(row?.name, 200),
          rank: (int(row?.cmc_rank) ?? 0) > 0 ? int(row?.cmc_rank) : null,
          price: num(quote.price), market_cap: num(quote.market_cap), volume_24h: num(quote.volume_24h),
          circulating_supply: num(row?.circulating_supply), total_supply: num(row?.total_supply), max_supply: num(row?.max_supply),
          num_market_pairs: count(row?.num_market_pairs),
          change_24h_pct: num(quote.percent_change_24h), change_7d_pct: num(quote.percent_change_7d),
          source: 'listings_historical', observed_at: iso(quote.last_updated ?? row?.last_updated),
        }
      }).filter((row) => row.provider_id && row.provider_id !== 'null'), (r) => r.provider_id)
      const result2 = await upsert(db, 'intel_rank_history', rows, 'provider,snapshot_date,provider_id')
      written += result2.rows
      if (result2.error) { reason = reason || result2.error; remaining += 1 }
    }
    return { job, rows: written, credits, weeksCaptured: fetched, remaining, oldestWeek: dates.at(-1) ?? null, ...(reason ? { partial: reason } : {}) }
  } catch (e) { return { ...failed(job, credits, e), remaining: null } }
}

// ─── 6. Liquidations (every 5 minutes) ────────────────────────────────────────
const LIQUIDATION_FIELDS: [string, string[]][] = [
  ['liq_1h', ['total_liquidations_1h']], ['liq_4h', ['total_liquidations_4h']], ['liq_24h', ['total_liquidations_24h']],
  ['long_1h', ['long_liquidations_1h', 'total_long_liquidations_1h', 'longs_1h']],
  ['short_1h', ['short_liquidations_1h', 'total_short_liquidations_1h', 'shorts_1h']],
  ['long_24h', ['long_liquidations_24h', 'total_long_liquidations_24h', 'longs_24h']],
  ['short_24h', ['short_liquidations_24h', 'total_short_liquidations_24h', 'shorts_24h']],
]

export async function captureLiquidations(db: any, ctx: MarketAssetsContext, now = new Date(), deps: CaptureDeps): Promise<JobResult> {
  const job = 'liquidations'
  try {
    const skip = await guardJob(db, job, 'structure', deps, now, { table: 'intel_liquidation_snapshots', column: 'captured_at' })
    if (skip) return skip
    const result = await deps.request('liquidationAssets', { limit: 250, start: 1 }, ctx).catch(() => null)
    const credits = 1
    if (!result?.payload) return { job, rows: 0, credits, error: result?.reason || 'provider_unavailable' }
    const capturedAt = fiveMinuteBucket(now)
    const rows = dedupe(cmcRows('liquidationAssets', result.payload).rows.map((row: any) => {
      const quote = row?.quote ?? {}
      const values: Record<string, number | null> = {}
      // Only the fields this payload actually reports are kept; a missing long /
      // short split stays null rather than becoming an invented zero.
      for (const [column, keys] of LIQUIDATION_FIELDS) values[column] = keys.map((key) => num(quote[key] ?? row?.[key])).find((v) => v != null) ?? null
      return {
        provider_id: String(row?.id ?? row?.crypto_id ?? ''), captured_at: capturedAt,
        symbol: text(row?.symbol, 50), ...values, universe: 'covered_derivatives',
        raw: Object.fromEntries(Object.entries(values).filter(([, v]) => v != null)),
      }
    }).filter((row) => row.provider_id && row.provider_id !== 'null'), (r) => r.provider_id)
    if (!rows.length) return { job, rows: 0, credits, capturedAt, skipped: 'no_reported_assets' }
    const written = await upsert(db, 'intel_liquidation_snapshots', rows, 'provider_id,captured_at')
    return { job, rows: written.rows, credits, capturedAt, ...(written.error ? { error: written.error } : {}) }
  } catch (e) { return failed(job, 1, e) }
}

// ─── 7. Attention lists (hourly, Startup and above) ───────────────────────────
const ATTENTION_LISTS: { list: string; capability: string; params: Record<string, unknown> }[] = [
  { list: 'trending', capability: 'trending', params: { limit: 100, start: 1 } },
  { list: 'most_visited', capability: 'mostVisited', params: { limit: 100, start: 1 } },
  { list: 'gainers', capability: 'gainers', params: { limit: 100, start: 1, sort_dir: 'desc' } },
  // Losers is the same endpoint read in ascending order; without registry support
  // for sort_dir the list is skipped rather than approximated from the gainers.
  { list: 'losers', capability: 'gainers', params: { limit: 100, start: 1, sort_dir: 'asc' } },
]

export async function captureAttention(db: any, ctx: MarketAssetsContext, now = new Date(), plan = 'basic', deps: CaptureDeps): Promise<JobResult> {
  const job = 'attention'
  try {
    // A capability above the current plan is never attempted: the reason is recorded.
    if (!planAllows(plan, 'startup')) return { job, rows: 0, credits: 0, skipped: 'plan_below_startup' }
    const skip = await guardJob(db, job, 'attention', deps, now, { table: 'intel_attention_snapshots', column: 'captured_at' })
    if (skip) return skip
    const capturedAt = hourBucket(now)
    const rows: Record<string, unknown>[] = []
    let credits = 0, reason: string | null = null
    for (const entry of ATTENTION_LISTS) {
      const result = await deps.request(entry.capability, entry.params, ctx).catch(() => null)
      credits += 1
      if (!result?.payload) { reason = reason || result?.reason || 'provider_unavailable'; continue }
      const page = cmcRows(entry.capability, result.payload).rows
      page.forEach((row: any, index: number) => {
        const quote = row?.quote ?? {}
        const providerId = String(row?.id ?? row?.crypto_id ?? '')
        if (!providerId || providerId === 'null') return
        rows.push({
          list: entry.list, time_period: text(entry.params.time_period, 20) ?? '', captured_at: capturedAt,
          provider_id: providerId, symbol: text(row?.symbol, 50), rank: index + 1,
          price: num(quote.price), volume_24h: num(quote.volume_24h), change_24h_pct: num(quote.percent_change_24h),
        })
      })
    }
    if (!rows.length) return { job, rows: 0, credits, error: reason || 'provider_unavailable' }
    const written = await upsert(db, 'intel_attention_snapshots', dedupe(rows, (r) => `${r.list}|${r.time_period}|${r.provider_id}`), 'list,time_period,captured_at,provider_id')
    return { job, rows: written.rows, credits, capturedAt, ...(reason ? { partial: reason } : {}), ...(written.error ? { error: written.error } : {}) }
  } catch (e) { return failed(job, ATTENTION_LISTS.length, e) }
}

// ─── 8. Airdrops (daily, Builder and above) ───────────────────────────────────
// The airdrop table is a living list, not a time series: first_seen_at is never
// part of the payload, so the upsert leaves the original discovery time alone.
const AIRDROP_STATUSES = ['ONGOING', 'UPCOMING'] as const

export async function captureAirdrops(db: any, ctx: MarketAssetsContext, now = new Date(), plan = 'basic', deps: CaptureDeps): Promise<JobResult> {
  const job = 'airdrops'
  try {
    if (!planAllows(plan, 'builder')) return { job, rows: 0, credits: 0, skipped: 'plan_below_builder' }
    const skip = await guardJob(db, job, 'airdrops', deps, now, { table: 'intel_airdrop_snapshots', column: 'last_seen_at' })
    if (skip) return skip
    const seenAt = now.toISOString()
    const rows: Record<string, unknown>[] = []
    let credits = 0, reason: string | null = null
    for (const status of AIRDROP_STATUSES) {
      const result = await deps.request('airdrops', { status, limit: 100, start: 1 }, ctx).catch(() => null)
      credits += 1
      if (!result?.payload) { reason = reason || result?.reason || 'provider_unavailable'; continue }
      const data = result.payload?.data
      const page = Array.isArray(data) ? data : Array.isArray(data?.airdrops) ? data.airdrops : cmcRows('airdrops', result.payload).rows
      for (const row of page.slice(0, 250)) {
        const airdropId = text(row?.id, 100)
        if (!airdropId) continue
        rows.push({
          airdrop_id: airdropId, project_name: text(row?.project_name, 200),
          provider_id: row?.coin?.id != null ? String(row.coin.id) : null,
          symbol: text(row?.coin?.symbol, 50), slug: text(row?.coin?.slug, 200),
          status: text(row?.status, 40), start_date: iso(row?.start_date), end_date: iso(row?.end_date),
          total_prize: num(row?.total_prize), winner_count: count(row?.winner_count), link: text(row?.link, 500),
          last_seen_at: seenAt,
          raw: { status: text(row?.status, 40), totalPrize: num(row?.total_prize), winnerCount: count(row?.winner_count) },
        })
      }
    }
    if (!rows.length) return { job, rows: 0, credits, error: reason || 'provider_unavailable' }
    const written = await upsert(db, 'intel_airdrop_snapshots', dedupe(rows, (r) => String(r.airdrop_id)), 'airdrop_id')
    return { job, rows: written.rows, credits, seenAt, ...(reason ? { partial: reason } : {}), ...(written.error ? { error: written.error } : {}) }
  } catch (e) { return failed(job, AIRDROP_STATUSES.length, e) }
}
