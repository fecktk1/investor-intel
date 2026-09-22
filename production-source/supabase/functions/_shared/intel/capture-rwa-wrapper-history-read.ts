// Investor Intel RWA wrapper premium HISTORY read view.
//
// Same contract as the other lane read modules: pure functions over a
// PostgREST-shaped `db`, every read bounded by an explicit row cap and ordered
// newest first so a cap loses the OLDEST rows, `coverage` reporting what was
// actually read, and an empty table answered with an empty series, never an
// error and never a fabricated point.
//
// TWO SOURCES, ALWAYS LABELLED.
//   'capture'              The six-hourly live wrapper lane: rows in
//                          `intel_rwa_wrapper_assets` / `intel_rwa_wrapper_tokens`.
//   'ohlcv_reconstructed'  `intel_rwa_wrapper_premium_backfill`: the daily close
//                          run through the same arithmetic, only ever for days
//                          BEFORE the asset's first live capture (the table's own
//                          CHECK guarantees it). Every point carries its source,
//                          and the payload carries the boundary between them.
//
// FREE. Served through `capture_views` (free, precomputed_shared): every row was
// already paid for by a scheduled or operator lane; opening the chart spends no
// provider credit whoever opens it.

import { ASSET_TABLE, TOKEN_TABLE, RWA_WRAPPER_CAPTURE_SCHEDULE } from './capture-rwa-wrappers.ts'
import { BACKFILL_TABLE, BACKFILL_METHOD } from './capture-rwa-wrapper-backfill.ts'
import { samplePoints } from './capture-read.ts'
import { nyseClosedDays, NYSE_HOLIDAY_YEARS, EQUITY_CALENDAR_SOURCE } from './investigation-sessions.ts'
import { WRAPPER_SPREAD_SCOPE } from './rwa-wrapper-spread.ts'

export interface Coverage { from: string | null; to: string | null; count: number; truncated?: boolean }
export interface ViewResult { view: string; asOf: string | null; coverage: Coverage; reason?: string | null; [key: string]: unknown }

export const RWA_WRAPPER_HISTORY_VIEW_NAMES = ['rwa_wrapper_history'] as const
/** The only ranges the view answers, in days. */
export const HISTORY_RANGES = [30, 90, 180, 365] as const
export const HISTORY_DEFAULT_DAYS = 90
/** Live wrapper rows for ONE asset. At most ~11 wrappers x 4 captures a day, so
 * 8,000 rows is about half a year for the widest asset; a longer range is marked
 * truncated and loses its oldest live rows, never its newest. */
export const HISTORY_TOKEN_CAP = 8_000
/** Live asset rows for ONE asset: 4 a day for a year, with headroom. */
const HISTORY_ASSET_CAP = 2_000
/** Reconstructed rows for ONE asset: 90 days x a dozen wrappers, with headroom. */
const HISTORY_BACKFILL_CAP = 3_000
/** Points per series after downsampling. */
export const HISTORY_POINT_CAP = 400
/** Assets offered in the selector: one capture hour holds at most 60. */
const SELECTOR_ROWS = 200
const DAY = 86_400_000
const ID = /^[1-9][0-9]{0,11}$/

const num = (v: unknown): number | null => { if (v == null || v === '' || typeof v === 'boolean') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const str = (v: unknown, max = 200): string | null => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null }
const at = (now: Date | number): number => (now instanceof Date ? now.getTime() : now)
const stamp = (v: unknown): number | null => { const t = Date.parse(String(v ?? '')); return Number.isFinite(t) ? t : null }
const emptyCoverage = (): Coverage => ({ from: null, to: null, count: 0 })

// deno-lint-ignore no-explicit-any
async function readRows(build: () => any): Promise<{ rows: any[]; reason: string | null }> {
  try {
    const { data, error } = await build()
    if (error) return { rows: [], reason: String(error.message || error.code || error).slice(0, 200) }
    return { rows: Array.isArray(data) ? data : data ? [data] : [], reason: null }
  } catch (e) { return { rows: [], reason: ((e as Error)?.message || 'read_failed').slice(0, 200) } }
}

/** Validate the two parameters. Anything else is refused with a reason rather
 * than coerced: a range the surface did not offer is a bug, not a request. */
export function historyParams(params: Record<string, unknown> = {}): { rwaId: string | null; days: number; reason: string | null } {
  const rawId = params.rwaId ?? params.rwa_id
  const rwaId = rawId == null || rawId === '' ? null : (ID.test(String(rawId)) ? String(rawId) : undefined)
  const rawDays = params.days
  const days = rawDays == null || rawDays === '' ? HISTORY_DEFAULT_DAYS : Number(rawDays)
  if (rwaId === undefined) return { rwaId: null, days: HISTORY_DEFAULT_DAYS, reason: 'invalid_rwa_id' }
  if (!(HISTORY_RANGES as readonly number[]).includes(days)) return { rwaId: rwaId ?? null, days: HISTORY_DEFAULT_DAYS, reason: 'invalid_days' }
  return { rwaId: rwaId ?? null, days, reason: null }
}

/** Which days to shade, and what the shading does and does not model. */
export function closedCalendar(assetType: string | null, fromMs: number, toMs: number) {
  if (assetType === 'stock' || assetType === 'etf') {
    return {
      kind: 'nyse', days: nyseClosedDays(fromMs, toMs), sourceUrl: EQUITY_CALENDAR_SOURCE, holidayYears: NYSE_HOLIDAY_YEARS,
      note: 'nyse_weekends_and_holidays',
    }
  }
  if (assetType === 'commodity') {
    return {
      kind: 'weekends_only',
      days: nyseClosedDays(fromMs, toMs).filter((d) => d.kind === 'weekend'),
      sourceUrl: null, holidayYears: null, note: 'comex_holidays_not_modelled',
    }
  }
  return { kind: 'none', days: [], sourceUrl: null, holidayYears: null, note: 'no_calendar_for_asset_type' }
}

/** Merge consecutive closed days into spans, so a weekend is one band rather
 * than two touching ones. `from` is the first day's start, `to` the last day's end. */
export function closedSpans(days: { date: string; kind: string }[]): { from: number; to: number; kind: string }[] {
  const spans: { from: number; to: number; kind: string }[] = []
  for (const day of [...days].sort((a, b) => a.date.localeCompare(b.date))) {
    const start = Date.parse(`${day.date}T00:00:00Z`)
    const last = spans.at(-1)
    if (last && last.to + 1 === start) { last.to = start + DAY - 1; if (day.kind === 'holiday') last.kind = 'holiday' }
    else spans.push({ from: start, to: start + DAY - 1, kind: day.kind })
  }
  return spans
}

// deno-lint-ignore no-explicit-any
async function assetSelector(db: any): Promise<{ assets: Record<string, unknown>[]; reason: string | null }> {
  const read = await readRows(() => db.from(ASSET_TABLE).select('rwa_id,captured_at,symbol,name,asset_type,wrapper_count,dispersion_bps')
    .order('captured_at', { ascending: false }).limit(SELECTOR_ROWS))
  const newest = read.rows.map((row) => str(row?.captured_at, 40)).filter((v): v is string => !!v).sort().at(-1) ?? null
  const assets = read.rows.filter((row) => str(row?.captured_at, 40) === newest)
    .map((row) => ({ rwaId: str(row?.rwa_id, 20), symbol: str(row?.symbol, 50), name: str(row?.name), assetType: str(row?.asset_type, 40), wrapperCount: num(row?.wrapper_count), dispersionBps: num(row?.dispersion_bps) }))
    .filter((row) => row.rwaId)
    .sort((a, b) => (b.dispersionBps ?? -1) - (a.dispersionBps ?? -1) || Number(a.rwaId) - Number(b.rwaId))
  return { assets, reason: read.reason }
}

// deno-lint-ignore no-explicit-any
export async function readRwaWrapperHistory(db: any, params: Record<string, unknown> = {}, now: Date | number = Date.now()): Promise<ViewResult> {
  const view = 'rwa_wrapper_history'
  const nowMs = at(now)
  const parsed = historyParams(params)
  const selector = await assetSelector(db)
  const base = {
    view, ranges: [...HISTORY_RANGES], days: parsed.days, rwaId: parsed.rwaId, assets: selector.assets,
    method: BACKFILL_METHOD, scope: WRAPPER_SPREAD_SCOPE, schedule: RWA_WRAPPER_CAPTURE_SCHEDULE,
    generatedAt: new Date(nowMs).toISOString(),
  }
  if (parsed.reason) return { ...base, asset: null, wrappers: [], anchor: [], calendar: null, asOf: null, coverage: emptyCoverage(), reason: parsed.reason }
  // No asset named: the selector alone, and the surface picks one.
  if (!parsed.rwaId) return { ...base, asset: null, wrappers: [], anchor: [], calendar: null, asOf: null, coverage: emptyCoverage(), reason: selector.reason ?? 'no_asset_selected' }

  const rwaId = parsed.rwaId
  const fromMs = nowMs - parsed.days * DAY
  const fromIso = new Date(fromMs).toISOString()
  const fromDay = fromIso.slice(0, 10)
  const [assetRead, tokenRead, backfillRead] = await Promise.all([
    readRows(() => db.from(ASSET_TABLE)
      .select('rwa_id,captured_at,symbol,name,asset_type,anchor_kind,anchor_price,anchor_reason,anchor_members,dispersion_bps,weighted_spread_bps,cheapest_crypto_id,cheapest_premium_bps')
      .eq('rwa_id', rwaId).gte('captured_at', fromIso).order('captured_at', { ascending: false }).limit(HISTORY_ASSET_CAP)),
    readRows(() => db.from(TOKEN_TABLE)
      .select('crypto_id,captured_at,symbol,name,wrapper_state,premium_bps,accrual_gap_bps,in_anchor,volume_24h')
      .eq('rwa_id', rwaId).gte('captured_at', fromIso).order('captured_at', { ascending: false }).limit(HISTORY_TOKEN_CAP)),
    readRows(() => db.from(BACKFILL_TABLE)
      .select('crypto_id,day,method,symbol,name,wrapper_state,premium_bps,accrual_gap_bps,in_anchor,volume_24h,anchor_kind,anchor_price,anchor_reason,anchor_members,asset_dispersion_bps,asset_weighted_spread_bps,wrapper_set_captured_at')
      .eq('rwa_id', rwaId).eq('method', BACKFILL_METHOD).gte('day', fromDay).order('day', { ascending: false }).limit(HISTORY_BACKFILL_CAP)),
  ])

  const liveStamps = assetRead.rows.map((row) => stamp(row?.captured_at)).filter((v): v is number => v != null).sort((a, b) => a - b)
  const newestAsset = assetRead.rows.find((row) => stamp(row?.captured_at) === liveStamps.at(-1)) ?? null
  const selected = selector.assets.find((a) => a.rwaId === rwaId) ?? null
  const assetType = str(newestAsset?.asset_type, 40) ?? (selected?.assetType as string | null) ?? null
  // The first live capture inside the window. Reconstructed points are only ever
  // before it; a reconstructed row at or after it would be a schema violation,
  // and is dropped here as a second guard rather than drawn.
  const liveFrom = liveStamps[0] ?? null

  // ── Per-wrapper series ──
  type Point = { t: number; premiumBps: number | null; accrualGapBps: number | null; state: string | null; inAnchor: boolean; source: 'capture' | 'ohlcv_reconstructed' }
  const series = new Map<string, { cryptoId: string; symbol: string | null; name: string | null; latestState: string | null; latestT: number; points: Point[] }>()
  const entry = (cryptoId: string, symbol: string | null, name: string | null) => {
    if (!series.has(cryptoId)) series.set(cryptoId, { cryptoId, symbol, name, latestState: null, latestT: -Infinity, points: [] })
    const s = series.get(cryptoId)!
    s.symbol ||= symbol; s.name ||= name
    return s
  }
  for (const row of tokenRead.rows) {
    const cryptoId = str(row?.crypto_id, 20), t = stamp(row?.captured_at)
    if (!cryptoId || t == null) continue
    const s = entry(cryptoId, str(row?.symbol, 50), str(row?.name))
    s.points.push({ t, premiumBps: num(row?.premium_bps), accrualGapBps: num(row?.accrual_gap_bps), state: str(row?.wrapper_state, 40), inAnchor: row?.in_anchor === true, source: 'capture' })
    if (t > s.latestT) { s.latestT = t; s.latestState = str(row?.wrapper_state, 40) }
  }
  let reconstructedDropped = 0
  const backfillAnchors = new Map<number, Record<string, unknown>>()
  for (const row of backfillRead.rows) {
    const cryptoId = str(row?.crypto_id, 20), t = stamp(`${String(row?.day ?? '').slice(0, 10)}T00:00:00Z`)
    if (!cryptoId || t == null) continue
    if (liveFrom != null && t >= Math.floor(liveFrom / DAY) * DAY) { reconstructedDropped += 1; continue }
    const s = entry(cryptoId, str(row?.symbol, 50), str(row?.name))
    s.points.push({ t, premiumBps: num(row?.premium_bps), accrualGapBps: num(row?.accrual_gap_bps), state: str(row?.wrapper_state, 40), inAnchor: row?.in_anchor === true, source: 'ohlcv_reconstructed' })
    if (!backfillAnchors.has(t)) {
      backfillAnchors.set(t, {
        t, anchorKind: str(row?.anchor_kind, 40), anchorPrice: num(row?.anchor_price), anchorReason: str(row?.anchor_reason, 120),
        anchorMembers: num(row?.anchor_members), dispersionBps: num(row?.asset_dispersion_bps), weightedSpreadBps: num(row?.asset_weighted_spread_bps),
        source: 'ohlcv_reconstructed',
      })
    }
    if (s.latestT === -Infinity) s.latestState = str(row?.wrapper_state, 40)
  }

  let downsampled = false
  const cheapest = str(newestAsset?.cheapest_crypto_id, 20)
  const wrappers = [...series.values()].map((s) => {
    const ordered = s.points.sort((a, b) => a.t - b.t)
    const points = samplePoints(ordered, HISTORY_POINT_CAP)
    if (points.length < ordered.length) downsampled = true
    return {
      cryptoId: s.cryptoId, symbol: s.symbol, name: s.name, latestState: s.latestState,
      cheapestLiquid: s.cryptoId === cheapest,
      captured: ordered.filter((p) => p.source === 'capture').length,
      reconstructed: ordered.filter((p) => p.source === 'ohlcv_reconstructed').length,
      points,
    }
  }).sort((a, b) => Number(b.cheapestLiquid) - Number(a.cheapestLiquid) || (b.captured + b.reconstructed) - (a.captured + a.reconstructed) || Number(a.cryptoId) - Number(b.cryptoId))

  // ── The asset's anchor series, reconstructed days first, then live captures ──
  const liveAnchor = assetRead.rows.map((row) => ({
    t: stamp(row?.captured_at), anchorKind: str(row?.anchor_kind, 40), anchorPrice: num(row?.anchor_price), anchorReason: str(row?.anchor_reason, 120),
    anchorMembers: num(row?.anchor_members), dispersionBps: num(row?.dispersion_bps), weightedSpreadBps: num(row?.weighted_spread_bps),
    source: 'capture',
  })).filter((row) => row.t != null)
  const anchorAll = [...backfillAnchors.values(), ...liveAnchor].sort((a, b) => Number(a.t) - Number(b.t))
  const anchor = samplePoints(anchorAll, HISTORY_POINT_CAP)
  if (anchor.length < anchorAll.length) downsampled = true

  const reconstructedDays = [...backfillAnchors.keys()].sort((a, b) => a - b)
  const allT = [...reconstructedDays, ...liveStamps].sort((a, b) => a - b)
  const truncated = tokenRead.rows.length >= HISTORY_TOKEN_CAP || assetRead.rows.length >= HISTORY_ASSET_CAP || backfillRead.rows.length >= HISTORY_BACKFILL_CAP

  return {
    ...base,
    asset: {
      rwaId, symbol: str(newestAsset?.symbol, 50) ?? (selected?.symbol as string | null) ?? null,
      name: str(newestAsset?.name) ?? (selected?.name as string | null) ?? null, assetType,
      cheapestCryptoId: cheapest, anchorKind: str(newestAsset?.anchor_kind, 40),
    },
    wrappers, anchor,
    boundary: {
      // Where the reconstruction ends and the live history begins.
      liveFrom: liveFrom != null ? new Date(liveFrom).toISOString() : null,
      reconstructedFrom: reconstructedDays.length ? new Date(reconstructedDays[0]).toISOString() : null,
      reconstructedTo: reconstructedDays.length ? new Date(reconstructedDays.at(-1)! + DAY - 1).toISOString() : null,
      reconstructedDays: reconstructedDays.length, reconstructedDropped,
    },
    calendar: (() => { const c = closedCalendar(assetType, fromMs, nowMs); return { ...c, spans: closedSpans(c.days) } })(),
    downsampled, truncated,
    asOf: liveStamps.length ? new Date(liveStamps.at(-1)!).toISOString() : null,
    coverage: {
      from: allT.length ? new Date(allT[0]).toISOString() : null,
      to: allT.length ? new Date(allT.at(-1)!).toISOString() : null,
      count: tokenRead.rows.length + backfillRead.rows.length, truncated,
    },
    reason: assetRead.reason || tokenRead.reason || backfillRead.reason || selector.reason,
  }
}

/** Integration surface consumed by `intel-capture/index.ts`, keyed by view name.
 * Spread into LANE_VIEWS beside RWA_WRAPPER_CAPTURE_VIEWS. */
export const RWA_WRAPPER_HISTORY_VIEWS: Record<string, (
  // deno-lint-ignore no-explicit-any
  db: any, body: Record<string, unknown>, now: number
) => Promise<ViewResult>> = {
  rwa_wrapper_history: (db, body, now) => readRwaWrapperHistory(db, body, now),
}
/** The same map under the name the other lane read modules use. */
export const RWA_WRAPPER_HISTORY_CAPTURE_VIEWS = RWA_WRAPPER_HISTORY_VIEWS
