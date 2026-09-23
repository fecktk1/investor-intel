// Investor Intel: the daily RWA universe COVERAGE lane.
//
// Same contract as the other capture lanes (`capture-rwa-wrappers.ts`,
// `capture-rwa-depth.ts`): one bounded function with an explicit call and credit
// ceiling, obeying `provider_schedule_policy`, never throwing (a failure becomes
// `{ error }`), and reaching CoinMarketCap only through the injected transport.
//
// THE QUESTION. The wrapper lane keeps only assets with two or more wrappers and
// caps at 60; the universe snapshot keeps aggregates and a top 10. Neither can
// say "of the ~800 tokenised assets, how many have a token that actually
// trades", which assets appeared or vanished since yesterday, or how
// concentrated the tokenised market is by issuer. This lane stores the whole
// answered universe once a day so those three questions can be read back.
//
// WHAT ONE RUN DOES, AND WHAT IT COSTS.
//   1. Zero-credit database reads: today's `intel_rwa_asset_map_counts` row; the
//      ids from `intel_rwa_asset_map` (the rwaMap lane, 03:11 UTC) that are not
//      known to lack tokens and were seen by today's complete map run (or, when
//      today's run is missing or truncated, in the last 36 hours); this lane's own
//      newest snapshot (cadence guard) and previous snapshot (the diff).
//   2. `/v5/real-world-assets/quotes/latest` in batches of 100 rwa_ids. The
//      endpoint bills ceil(n/250), so each batch is 1 credit. Measured 2026-09-22:
//      791 eligible ids, so 8 batches and 8 CREDITS A DAY. The per-run ceiling is
//      `max_credits` on the policy row (15 by default), so the lane stops asking at
//      that many batches whatever the universe grows to, and the ids it could not
//      afford are stored as `not_returned` rather than dropped.
//   3. Writes: tokens first, then assets (the cadence guard reads the asset
//      table), then the change events, which are INSERT-only.
//
// HONESTY RULES THIS LANE KEEPS (see rwa-coverage.ts for the definitions):
//   * A failed batch, and an id the response left out, is `not_returned`. It is
//     never "no tokens", and it never produces a removal or a shelving.
//   * The first snapshot produces no events.
//   * `removed` requires the asset map itself to have stopped seeing the asset
//     before today's map run, AND today's map enumeration to be complete.

import { CAPTURE_PROVIDER, schedulePolicy, utcDate, type CaptureDeps, type JobResult } from './capture-jobs.ts'
import { cmcRows, cmcObservedAt, estimateCmcCredits } from '../market-assets/cmc-capabilities.ts'
import type { MarketAssetsContext } from '../market-assets/types.ts'
import { wrapperAssetFromQuote } from './rwa-wrapper-spread.ts'
import { MAP_TABLE, MAP_COUNT_TABLE } from './capture-rwa-underlyings.ts'
import {
  tokenCoverageState, assetCoverageState, coverageChanges,
  type CoverageAssetState, type CoverageSnapshotRow, type CoverageTokenState,
} from './rwa-coverage.ts'

export const RWA_COVERAGE_FEATURE = 'rwa_coverage'
export const COVERAGE_ASSET_TABLE = 'intel_rwa_coverage_assets'
export const COVERAGE_TOKEN_TABLE = 'intel_rwa_coverage_tokens'
export const COVERAGE_CHANGE_TABLE = 'intel_rwa_coverage_changes'

/** The pg_cron job (UTC), from migration 20260922110000_intel_rwa_universe_coverage.sql.
 * Eight minutes after the 03:11 rwaMap enumeration this lane takes its ids from,
 * on a minute no other cron job uses (checked against cron.job 2026-09-22).
 * Asserted against the migration by test. */
export const RWA_COVERAGE_CAPTURE_SCHEDULE = {
  rwa_coverage: { job: 'intel-capture-rwa-coverage-daily', cron: '19 3 * * *', cadence: 'daily', utc: '03:19' },
} as const

/** rwa_ids per quotes call. ceil(100/250) = 1 credit, and well inside the 250-row
 * ceiling `cmcRows` keeps from any one response. */
export const COVERAGE_BATCH = 100
/** Per-run credit ceiling when the policy row carries no `max_credits`. Restated
 * in the migration's policy row. 15 batches = 1,500 ids, nearly twice today's
 * 791, before the lane starts recording `not_returned` for the tail. */
export const RWA_COVERAGE_CREDIT_CEILING = 15
/** An asset the map has not seen for this long is not asked about. */
export const MAP_FRESH_HOURS = 36
/** Ids read from the map, paged 1,000 at a time (the PostgREST row ceiling). */
export const MAP_ID_CAP = 3000
const PAGE = 1000
const CADENCE_SECONDS = 86_400
const CADENCE_GRACE = 0.9
const MAX_UPSERT_ROWS = 500

const num = (v: unknown): number | null => { if (v == null || v === '' || typeof v === 'boolean') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const text = (v: unknown, max = 200): string | null => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null }
const rwaId = (v: unknown): string | null => (/^[1-9][0-9]{0,11}$/.test(String(v ?? '')) ? String(v) : null)
const iso = (v: unknown): string | null => { const t = Date.parse(String(v ?? '')); return Number.isFinite(t) ? new Date(t).toISOString() : null }

export function lanePolicy(deps: CaptureDeps): { enabled: boolean; cadenceSeconds: number; maxCredits: number } {
  const row = (deps.policy || []).find((r) => r?.feature === RWA_COVERAGE_FEATURE && (r.provider ?? CAPTURE_PROVIDER) === CAPTURE_PROVIDER)
  if (!row) return { enabled: true, cadenceSeconds: CADENCE_SECONDS, maxCredits: RWA_COVERAGE_CREDIT_CEILING }
  const policy = schedulePolicy(deps.policy, RWA_COVERAGE_FEATURE)
  const ceiling = Number(row.max_credits)
  return {
    enabled: policy.enabled,
    cadenceSeconds: policy.cadenceSeconds,
    maxCredits: Number.isFinite(ceiling) && ceiling >= 0 ? Math.trunc(ceiling) : RWA_COVERAGE_CREDIT_CEILING,
  }
}

// deno-lint-ignore no-explicit-any
async function readRows(build: () => any): Promise<{ rows: any[]; reason: string | null }> {
  try {
    const { data, error } = await build()
    if (error) return { rows: [], reason: String(error.message || error.code || error).slice(0, 200) }
    return { rows: Array.isArray(data) ? data : data ? [data] : [], reason: null }
  } catch (e) { return { rows: [], reason: ((e as Error)?.message || 'read_failed').slice(0, 200) } }
}

/** Page a read 1,000 rows at a time until a short page or the cap. */
// deno-lint-ignore no-explicit-any
async function readPaged(build: (from: number, to: number) => any, cap: number): Promise<{ rows: any[]; reason: string | null; truncated: boolean }> {
  // deno-lint-ignore no-explicit-any
  const rows: any[] = []
  while (rows.length < cap) {
    const size = Math.min(PAGE, cap - rows.length)
    const page = await readRows(() => build(rows.length, rows.length + size - 1))
    if (page.reason) return { rows, reason: page.reason, truncated: false }
    rows.push(...page.rows)
    if (page.rows.length < size) return { rows, reason: null, truncated: false }
  }
  return { rows, reason: null, truncated: true }
}

// deno-lint-ignore no-explicit-any
async function upsert(db: any, table: string, rows: Record<string, unknown>[], onConflict: string, ignoreDuplicates = false): Promise<{ rows: number; error?: string }> {
  if (!rows.length) return { rows: 0 }
  let written = 0
  for (let start = 0; start < rows.length; start += MAX_UPSERT_ROWS) {
    const chunk = rows.slice(start, start + MAX_UPSERT_ROWS)
    try {
      const { error } = await db.from(table).upsert(chunk, ignoreDuplicates ? { onConflict, ignoreDuplicates: true } : { onConflict })
      if (error) return { rows: written, error: String(error.message || error).slice(0, 200) }
      written += chunk.length
    } catch (e) { return { rows: written, error: ((e as Error)?.message || 'write_failed').slice(0, 200) } }
  }
  return { rows: written }
}

const callBudget = (ctx: MarketAssetsContext, ceiling: number): number => {
  const budget = Number(ctx?.maxCalls)
  return Math.max(0, Math.min(ceiling, Number.isFinite(budget) && budget >= 0 ? Math.trunc(budget) : ceiling))
}

interface MapEntry { rwaId: string; symbol: string | null; name: string | null; assetType: string | null; rwaRank: number | null }

/** Build one asset row and its token rows from one quotes response row. */
// deno-lint-ignore no-explicit-any
export function coverageRows(row: any, context: { snapshotDate: string; capturedAt: string; fetchedAt: string; fallback: MapEntry | null }) {
  const asset = wrapperAssetFromQuote(row)
  if (!asset) return null
  const fb = context.fallback
  const assetType = asset.assetType ?? fb?.assetType ?? null
  const tokens = asset.tokens.map((t) => {
    const state: CoverageTokenState = tokenCoverageState({ price: t.price, volume24h: t.volume24h })
    return {
      provider: CAPTURE_PROVIDER, snapshot_date: context.snapshotDate, rwa_id: asset.rwaId, crypto_id: t.cryptoId,
      asset_type: assetType,
      symbol: t.symbol, name: t.name, issuer_id: t.issuerId, issuer_name: t.issuerName,
      price: t.price, market_cap: t.marketCap, volume_24h: t.volume24h,
      token_state: state, captured_at: context.capturedAt, fetched_at: context.fetchedAt,
    }
  })
  const states = tokens.map((t) => t.token_state as CoverageTokenState)
  const assetRow = {
    provider: CAPTURE_PROVIDER, snapshot_date: context.snapshotDate, rwa_id: asset.rwaId,
    symbol: asset.symbol ?? fb?.symbol ?? null, name: asset.name ?? fb?.name ?? null,
    asset_type: assetType, rwa_rank: asset.rwaRank ?? fb?.rwaRank ?? null,
    token_count: tokens.length,
    priced_count: states.filter((s) => s !== 'listed_only').length,
    traded_count: states.filter((s) => s === 'tradeable').length,
    coverage_state: assetCoverageState(states) as CoverageAssetState,
    not_returned_reason: null as string | null,
    tokenized_market_cap: asset.tokenizedMarketCap, tokenized_volume_24h: asset.tokenizedVolume24h,
    source_observed_at: iso(asset.observedAt),
    captured_at: context.capturedAt, fetched_at: context.fetchedAt,
  }
  return { asset: assetRow, tokens }
}

/** An asset we asked about (or could not afford to ask about) and got no answer for. */
export function notReturnedRow(entry: MapEntry, reason: string, context: { snapshotDate: string; capturedAt: string; fetchedAt: string }) {
  return {
    provider: CAPTURE_PROVIDER, snapshot_date: context.snapshotDate, rwa_id: entry.rwaId,
    symbol: entry.symbol, name: entry.name, asset_type: entry.assetType, rwa_rank: entry.rwaRank,
    token_count: null as number | null, priced_count: null as number | null, traded_count: null as number | null,
    coverage_state: 'not_returned' as CoverageAssetState,
    not_returned_reason: reason.slice(0, 120) as string | null,
    tokenized_market_cap: null as number | null, tokenized_volume_24h: null as number | null, source_observed_at: null as string | null,
    captured_at: context.capturedAt, fetched_at: context.fetchedAt,
  }
}

export async function captureRwaCoverage(
  // deno-lint-ignore no-explicit-any
  admin: any,
  ctxFor: (name: string, maxCalls: number) => MarketAssetsContext,
  now: Date,
  deps: CaptureDeps,
): Promise<JobResult> {
  const job = RWA_COVERAGE_FEATURE
  const snapshotDate = utcDate(now)
  const capturedAt = new Date(now.getTime()).toISOString()
  let credits = 0
  try {
    const policy = lanePolicy(deps)
    if (!policy.enabled) return { job, rows: 0, credits: 0, skipped: 'policy_disabled' }

    // ── Cadence guard, on this lane's own newest capture. ──
    const newest = await readRows(() => admin.from(COVERAGE_ASSET_TABLE).select('snapshot_date,captured_at')
      .order('captured_at', { ascending: false }).limit(1))
    const newestAt = text(newest.rows[0]?.captured_at, 40)
    const newestMs = newestAt ? Date.parse(newestAt) : NaN
    if (Number.isFinite(newestMs) && now.getTime() - newestMs < policy.cadenceSeconds * 1000 * CADENCE_GRACE) {
      return { job, rows: 0, credits: 0, skipped: 'within_cadence', newestAt }
    }

    // ── 1. The ids, from the zero-credit map. ──
    // When today's map enumeration finished (its `all` count row exists and is
    // not truncated), the universe is exactly what that run saw: an asset the
    // run dropped is left out, so it can become a `removed` event. Otherwise the
    // 36-hour window keeps yesterday's assets in, because a missing or truncated
    // enumeration is not evidence that anything left.
    const counts = await readRows(() => admin.from(MAP_COUNT_TABLE).select('asset_type,snapshot_date,truncated,captured_at')
      .eq('asset_type', 'all').eq('snapshot_date', snapshotDate).limit(1))
    const countRow = counts.rows[0]
    const mapRunAt = iso(countRow?.captured_at)
    const mapCompleteToday = !counts.reason && !!countRow && countRow.truncated === false && !!mapRunAt
    const windowStart = new Date(now.getTime() - MAP_FRESH_HOURS * 3_600_000).toISOString()
    // Five minutes of slack below the run's own stamp: the lane writes last_seen_at
    // and the count row from one clock, and a daily job cannot overlap itself.
    const since = mapCompleteToday ? new Date(Date.parse(mapRunAt!) - 300_000).toISOString() : windowStart
    const mapRead = await readPaged((from, to) => admin.from(MAP_TABLE).select('rwa_id,symbol,name,asset_type,rwa_rank,last_seen_at')
      .not('has_tokens', 'is', false).gte('last_seen_at', since)
      .order('rwa_rank', { ascending: true, nullsFirst: false }).order('rwa_id', { ascending: true })
      .range(from, to), MAP_ID_CAP)
    if (mapRead.reason) return { job, rows: 0, credits: 0, error: `map_read_failed:${mapRead.reason}`.slice(0, 200) }
    const entries: MapEntry[] = []
    const seenIds = new Set<string>()
    for (const row of mapRead.rows) {
      const id = rwaId(row?.rwa_id)
      if (!id || seenIds.has(id)) continue
      seenIds.add(id)
      entries.push({ rwaId: id, symbol: text(row?.symbol, 50), name: text(row?.name, 200), assetType: text(row?.asset_type, 40), rwaRank: num(row?.rwa_rank) })
    }
    if (!entries.length) return { job, rows: 0, credits: 0, skipped: 'no_mapped_assets' }

    // ── 2. Quotes, in batches of 100, up to the credit ceiling. ──
    const batches: MapEntry[][] = []
    for (let i = 0; i < entries.length; i += COVERAGE_BATCH) batches.push(entries.slice(i, i + COVERAGE_BATCH))
    const ctx = ctxFor('rwa-coverage', policy.maxCredits)
    const budget = callBudget(ctx, policy.maxCredits)
    if (budget < 1) return { job, rows: 0, credits: 0, skipped: 'call_budget' }

    const context = { snapshotDate, capturedAt, fetchedAt: capturedAt }
    const byId = new Map(entries.map((e) => [e.rwaId, e]))
    const assetRows: ReturnType<typeof notReturnedRow>[] = []
    const tokenRows: Record<string, unknown>[] = []
    const failedBatches: string[] = []
    let calls = 0, observedAt: string | null = null

    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b]
      if (calls >= budget) {
        for (const entry of batch) assetRows.push(notReturnedRow(entry, 'credit_ceiling', context))
        continue
      }
      const ids = batch.map((e) => e.rwaId).join(',')
      const result = await deps.request('rwaQuotes', { rwa_id: ids }, ctx).catch(() => null)
      calls += 1
      credits += estimateCmcCredits('rwaQuotes', { rwa_id: ids })
      if (!result?.payload) {
        const reason = text(result?.reason, 80) || 'provider_unavailable'
        failedBatches.push(`${b}:${reason}`)
        for (const entry of batch) assetRows.push(notReturnedRow(entry, `batch_failed:${reason}`, context))
        continue
      }
      const answered = new Set<string>()
      for (const row of cmcRows('rwaQuotes', result.payload).rows) {
        const id = rwaId(row?.rwa_id)
        // Only ids this batch asked for; a stray row is not ours to record.
        if (!id || !batch.some((e) => e.rwaId === id) || answered.has(id)) continue
        const built = coverageRows(row, { ...context, fallback: byId.get(id) ?? null })
        if (!built) continue
        answered.add(id)
        assetRows.push(built.asset)
        tokenRows.push(...built.tokens)
      }
      for (const entry of batch) if (!answered.has(entry.rwaId)) assetRows.push(notReturnedRow(entry, 'not_in_response', context))
      const observed = cmcObservedAt(result.payload, 'rwaQuotes')
      if (observed && (!observedAt || observed < observedAt)) observedAt = observed
    }

    const answeredCount = assetRows.filter((r) => r.coverage_state !== 'not_returned').length
    if (!answeredCount) {
      return { job, rows: 0, credits, calls, snapshotDate, error: failedBatches[0] ? `all_batches_failed:${failedBatches[0]}`.slice(0, 200) : 'provider_unavailable' }
    }

    // ── 3. The diff, against the previous snapshot. Reads BEFORE today's write. ──
    const prevDateRead = await readRows(() => admin.from(COVERAGE_ASSET_TABLE).select('snapshot_date')
      .lt('snapshot_date', snapshotDate).order('snapshot_date', { ascending: false }).limit(1))
    const previousDate = text(prevDateRead.rows[0]?.snapshot_date, 10)
    let partial: string | null = failedBatches.length ? `batches_failed:${failedBatches.length}` : null
    if (entries.length > budget * COVERAGE_BATCH) partial = partial || 'credit_ceiling'
    if (mapRead.truncated) partial = partial || 'map_id_cap'

    let previous: CoverageSnapshotRow[] | null = null
    if (prevDateRead.reason) partial = partial || 'previous_read_failed'
    else if (previousDate) {
      const prevRead = await readPaged((from, to) => admin.from(COVERAGE_ASSET_TABLE).select('rwa_id,coverage_state,symbol,name,asset_type')
        .eq('snapshot_date', previousDate).order('rwa_id', { ascending: true }).range(from, to), MAP_ID_CAP * 2)
      if (prevRead.reason || prevRead.truncated) partial = partial || 'previous_read_failed'
      else previous = prevRead.rows.map((r) => ({
        rwaId: String(r.rwa_id), state: r.coverage_state as CoverageAssetState,
        symbol: text(r.symbol, 50), name: text(r.name, 200), assetType: text(r.asset_type, 40),
      }))
    }

    // Removal evidence: today's map count row, and last_seen_at for the missing ids.
    const todayRows: CoverageSnapshotRow[] = assetRows.map((r) => ({ rwaId: r.rwa_id, state: r.coverage_state, symbol: r.symbol, name: r.name, assetType: r.asset_type }))
    const todayIds = new Set(todayRows.map((r) => r.rwaId))
    const missing = (previous || []).filter((r) => !todayIds.has(r.rwaId) && r.state !== 'not_returned').map((r) => r.rwaId)
    const lastSeenAt = new Map<string, string | null>()
    let removalEvidence = mapCompleteToday
    for (let i = 0; i < missing.length && removalEvidence; i += 200) {
      const seen = await readRows(() => admin.from(MAP_TABLE).select('rwa_id,last_seen_at').in('rwa_id', missing.slice(i, i + 200)).limit(200))
      if (seen.reason) { removalEvidence = false; partial = partial || 'map_seen_read_failed'; break }
      for (const row of seen.rows) lastSeenAt.set(String(row.rwa_id), text(row.last_seen_at, 40))
    }
    const changes = coverageChanges(previous, todayRows, { mapCompleteToday: removalEvidence, mapRunAt, lastSeenAt })
    const changeRows = changes.map((c) => ({
      provider: CAPTURE_PROVIDER, snapshot_date: snapshotDate, previous_snapshot_date: previousDate,
      rwa_id: c.rwaId, change_kind: c.kind, from_state: c.fromState, to_state: c.toState,
      symbol: c.symbol, name: c.name, asset_type: c.assetType, detected_at: capturedAt,
    }))

    // ── 4. Writes. Tokens, then assets (the cadence guard reads assets), then
    //    the INSERT-only events, which ignore a duplicate from a same-day rerun.
    const tokenWrite = await upsert(admin, COVERAGE_TOKEN_TABLE, tokenRows, 'provider,rwa_id,crypto_id,snapshot_date')
    if (tokenWrite.error) return { job, rows: tokenWrite.rows, credits, calls, snapshotDate, error: tokenWrite.error }
    const assetWrite = await upsert(admin, COVERAGE_ASSET_TABLE, assetRows, 'provider,rwa_id,snapshot_date')
    if (assetWrite.error) return { job, rows: tokenWrite.rows + assetWrite.rows, credits, calls, snapshotDate, error: assetWrite.error }
    const changeWrite = await upsert(admin, COVERAGE_CHANGE_TABLE, changeRows, 'provider,snapshot_date,rwa_id,change_kind', true)

    const stateCounts: Record<string, number> = {}
    for (const r of assetRows) stateCounts[r.coverage_state] = (stateCounts[r.coverage_state] ?? 0) + 1
    return {
      job, rows: tokenWrite.rows + assetWrite.rows + changeWrite.rows, credits, calls, snapshotDate, capturedAt,
      ids: entries.length, batches: batches.length, assets: assetRows.length, tokens: tokenRows.length,
      states: stateCounts, changes: changeRows.length, previousSnapshotDate: previousDate,
      ...(observedAt ? { sourceObservedAt: observedAt } : {}),
      ...(partial ? { partial } : {}),
      ...(changeWrite.error ? { error: changeWrite.error } : {}),
    }
  } catch (e) {
    return { job, rows: 0, credits, error: ((e as Error)?.message || 'rwa_coverage_capture_failed').slice(0, 200) }
  }
}

/** Integration surface, spread into LANE_OPS in `intel-capture/index.ts`. Every
 * capability this lane uses is available from Basic upward, so the plan
 * argument is accepted and ignored. */
export const RWA_COVERAGE_OPS: Record<string, (
  // deno-lint-ignore no-explicit-any
  admin: any, ctxFor: (name: string, maxCalls: number) => MarketAssetsContext, now: Date, plan: string, deps: CaptureDeps, body?: Record<string, unknown>
) => Promise<JobResult>> = {
  rwa_coverage: (admin, ctxFor, now, _plan, deps) => captureRwaCoverage(admin, ctxFor, now, deps),
}
