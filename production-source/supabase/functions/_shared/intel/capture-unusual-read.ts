// Investor Intel — the "unusual for this asset" read view.
//
// Same contract as the other capture read modules: pure functions over a
// PostgREST-shaped `db`, every read bounded by an explicit row cap, a FAILED
// read reported as a reason on an empty result, and an empty result that says
// WHY in words rather than leaving a blank table.
//
// The table is service-role only; this read runs inside `intel-capture` behind
// the authenticated Investor Intel membership check, on the FREE `capture_views`
// surface. Nothing here calls a provider: the scores were precomputed by the
// hourly lane and every reader sees the same stored answer, which is what makes
// a free surface free.
//
// TWO THINGS ARE READ LIVE RATHER THAN STORED, on purpose:
//   * LOGOS come from the catalogue, so a re-cached image reaches the surface
//     without a rescore and this table never holds a URL that can rot.
//   * THE EVIDENCE STANDARD verdict (`metric_agreement`) is read here, for the
//     rows actually returned, not written by the lane. The verdict is about the
//     LIVE 24-hour window of price, market capitalisation and volume; a copy
//     written hourly would be staler than one read now, and the four-way verdict
//     belongs to `metric-agreement.ts`, not to this table. It is read with
//     bounded concurrency for at most AGREEMENT_ROW_MAX rows, and a failed read
//     leaves the verdict ABSENT rather than asserting `unmeasured`: the surface's
//     chip renders nothing for an absent verdict, which is the honest state for
//     "not looked up" as against "looked up and nothing was measured".

import { metricAgreementReceipt } from './metric-agreement.ts'
import { readMetricAgreement } from './metric-agreement-read.ts'
import { MIN_SAMPLE_DAYS, UNUSUAL_WINDOW_DAYS, DEFAULT_LIQUIDITY_FLOOR_USD } from './unusual-moves.ts'

export const UNUSUAL_VIEWS = ['unusual_moves'] as const

/** Scored rows one read may return. The archive holds under 100 assets, so this
 * is the whole scored set with headroom; the surface pages inside it. */
const SCORE_ROW_CAP = 400
/** Rows the surface shows by default. */
export const UNUSUAL_DEFAULT_LIMIT = 25
export const UNUSUAL_MAX_LIMIT = 100
/** Rows the evidence-standard verdict is looked up for. Two bounded reads per
 * row at about 15 ms each, so the whole lookup is well under a second. */
export const AGREEMENT_ROW_MAX = 25
const AGREEMENT_CONCURRENCY = 8
/** Catalogue rows one logo read may return. */
const CATALOGUE_ROW_CAP = 400

export interface Coverage { from: string | null; to: string | null; count: number; truncated?: boolean }
export interface ViewResult { view: string; asOf: string | null; coverage: Coverage; reason?: string | null; [key: string]: unknown }

const num = (v: unknown): number | null => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const int = (v: unknown): number | null => { const n = num(v); return n == null ? null : Math.trunc(n) }
const str = (v: unknown, max = 200): string | null => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null }
const emptyCoverage = (): Coverage => ({ from: null, to: null, count: 0 })

// deno-lint-ignore no-explicit-any
async function readRows(build: () => any): Promise<{ rows: any[]; reason: string | null }> {
  try {
    const { data, error } = await build()
    if (error) return { rows: [], reason: String(error.message || error.code || error).slice(0, 200) }
    return { rows: Array.isArray(data) ? data : data ? [data] : [], reason: null }
  } catch (e) { return { rows: [], reason: ((e as Error)?.message || 'read_failed').slice(0, 200) } }
}

const SCORE_COLUMNS = [
  'asset_key', 'subject_day', 'cmc_id', 'symbol', 'name', 'captured_at', 'scored', 'reason',
  'sample_days', 'required_days', 'is_market_reference', 'move_pct', 'volume', 'lead_window_days',
  'move_percentile', 'move_exceeded', 'median_abs_pct', 'mad_pct', 'robust_z',
  'volume_percentile', 'volume_robust_z', 'beta', 'beta_n', 'residual_pct', 'market_move_pct',
  'liquidity_usd', 'market_cap', 'market_cap_rank', 'catalogue_as_of', 'windows',
].join(',')

/** One stored window, as the surface reads it. Kept a separate mapping from the
 * row so an expanded row and a lead column can never disagree about a figure. */
// deno-lint-ignore no-explicit-any
const windowOut = (w: any) => ({
  days: int(w?.days), n: int(w?.n) ?? 0,
  medianAbsPct: num(w?.medianAbsPct), madPct: num(w?.madPct),
  robustZ: num(w?.robustZ), robustZReason: str(w?.robustZReason, 40),
  percentile: num(w?.percentile), exceeded: int(w?.exceeded),
  volumeN: int(w?.volumeN) ?? 0,
  volumeRobustZ: num(w?.volumeRobustZ), volumeRobustZReason: str(w?.volumeRobustZReason, 40),
  volumePercentile: num(w?.volumePercentile), volumeExceeded: int(w?.volumeExceeded),
  beta: num(w?.beta), betaN: int(w?.betaN) ?? 0, betaReason: str(w?.betaReason, 40),
  marketMovePct: num(w?.marketMovePct), residualPct: num(w?.residualPct),
  // The bins the scorer published, kept exactly as they were computed: the chart
  // draws edges a caller states and never re-derives them.
  distribution: (Array.isArray(w?.distribution) ? w.distribution : [])
    // deno-lint-ignore no-explicit-any
    .map((bin: any) => ({ from: num(bin?.from), to: num(bin?.to), count: int(bin?.count) ?? 0 }))
    .filter((bin: { from: number | null; to: number | null }) => bin.from != null && bin.to != null),
  subjectBin: int(w?.subjectBin),
})

// deno-lint-ignore no-explicit-any
const scoreOut = (row: any) => ({
  assetKey: str(row?.asset_key, 200), subjectDay: str(row?.subject_day, 10),
  cmcId: str(row?.cmc_id, 12), symbol: str(row?.symbol, 50), name: str(row?.name, 200),
  capturedAt: str(row?.captured_at, 40),
  scored: row?.scored === true, reason: str(row?.reason, 60),
  sampleDays: int(row?.sample_days) ?? 0, requiredDays: int(row?.required_days) ?? MIN_SAMPLE_DAYS,
  isMarketReference: row?.is_market_reference === true,
  movePct: num(row?.move_pct), volume: num(row?.volume),
  leadWindowDays: int(row?.lead_window_days),
  percentile: num(row?.move_percentile), exceeded: int(row?.move_exceeded),
  medianAbsPct: num(row?.median_abs_pct), madPct: num(row?.mad_pct), robustZ: num(row?.robust_z),
  volumePercentile: num(row?.volume_percentile), volumeRobustZ: num(row?.volume_robust_z),
  beta: num(row?.beta), betaN: int(row?.beta_n), residualPct: num(row?.residual_pct),
  marketMovePct: num(row?.market_move_pct),
  liquidityUsd: num(row?.liquidity_usd), marketCap: num(row?.market_cap), marketCapRank: int(row?.market_cap_rank),
  catalogueAsOf: str(row?.catalogue_as_of, 40),
  windows: (Array.isArray(row?.windows) ? row.windows : []).map(windowOut).filter((w: { days: number | null }) => w.days != null),
})

export type UnusualRow = ReturnType<typeof scoreOut> & {
  imageUrl?: string | null
  fallbackImageUrl?: string | null
  metricAgreement?: ReturnType<typeof metricAgreementReceipt> | null
}

/** Verdicts for the returned rows, in bounded batches. A failure on one row
 * leaves that row's verdict absent and never fails the view. */
// deno-lint-ignore no-explicit-any
async function attachAgreement(db: any, rows: UnusualRow[], now: number): Promise<number> {
  const targets = rows.slice(0, AGREEMENT_ROW_MAX).filter((row) => !!row.cmcId)
  let attached = 0
  for (let start = 0; start < targets.length; start += AGREEMENT_CONCURRENCY) {
    const batch = targets.slice(start, start + AGREEMENT_CONCURRENCY)
    await Promise.all(batch.map(async (row) => {
      try {
        const result = await readMetricAgreement(db, `market:coinmarketcap:${row.cmcId}`, now)
        row.metricAgreement = metricAgreementReceipt(result)
        attached += 1
      } catch { /* absent, not 'unmeasured': the surface says nothing rather than something wrong */ }
    }))
  }
  return attached
}

/**
 * The unusual-move ranking for the newest scored day.
 *
 * Sorted by percentile then by liquidity, which is the order the pure module's
 * `compareUnusual` states; the database applies it so a truncated read loses the
 * least interesting rows rather than an arbitrary slice. The refusals are
 * returned as counts plus the named short-history assets, so the section can say
 * what it left out and why instead of quietly showing a shorter list.
 */
// deno-lint-ignore no-explicit-any
export async function readUnusualMoves(db: any, params: Record<string, unknown> = {}, now: Date | number = Date.now()): Promise<ViewResult> {
  const nowMs = now instanceof Date ? now.getTime() : now
  const limit = Math.max(1, Math.min(UNUSUAL_MAX_LIMIT, Math.trunc(Number(params.limit) || UNUSUAL_DEFAULT_LIMIT)))
  const askedDay = /^\d{4}-\d{2}-\d{2}$/.test(String(params.day ?? '')) ? String(params.day) : null
  const base = {
    view: 'unusual_moves' as const,
    windowDays: [...UNUSUAL_WINDOW_DAYS], leadWindowDays: 90,
    minSampleDays: MIN_SAMPLE_DAYS, liquidityFloorUsd: DEFAULT_LIQUIDITY_FLOOR_USD,
  }

  // The newest scored day, unless the caller named one. Read separately so the
  // main read is ONE day rather than a window the row cap could slice across
  // two days and silently mix.
  let day = askedDay
  if (!day) {
    const newest = await readRows(() => db.from('intel_unusual_move_scores').select('subject_day')
      .order('subject_day', { ascending: false }).limit(1))
    if (newest.reason) return { ...base, rows: [], excluded: {}, shortHistory: [], marketReference: null, asOf: null, coverage: emptyCoverage(), reason: newest.reason }
    day = str(newest.rows[0]?.subject_day, 10)
  }
  if (!day) {
    return { ...base, rows: [], excluded: {}, shortHistory: [], marketReference: null, asOf: null, coverage: emptyCoverage(), reason: null, empty: 'no_scored_day' }
  }

  const page = await readRows(() => db.from('intel_unusual_move_scores').select(SCORE_COLUMNS)
    .eq('subject_day', day)
    .order('scored', { ascending: false })
    .order('move_percentile', { ascending: false, nullsFirst: false })
    .order('liquidity_usd', { ascending: false, nullsFirst: false })
    .order('asset_key', { ascending: true })
    .limit(SCORE_ROW_CAP))
  if (page.reason) return { ...base, subjectDay: day, rows: [], excluded: {}, shortHistory: [], marketReference: null, asOf: null, coverage: emptyCoverage(), reason: page.reason }

  const all = page.rows.map(scoreOut).filter((row) => !!row.assetKey)
  const scored = all.filter((row) => row.scored)
  const refused = all.filter((row) => !row.scored)

  // Refusal counts, plus the short-history assets by name: "insufficient
  // history, 12 of 30 days" is only useful when the reader can see which asset.
  const excluded: Record<string, number> = {}
  for (const row of refused) { const key = row.reason || 'unknown'; excluded[key] = (excluded[key] ?? 0) + 1 }
  const shortHistory = refused.filter((row) => row.reason === 'insufficient_history')
    .sort((a, b) => b.sampleDays - a.sampleDays).slice(0, 12)
    .map((row) => ({ symbol: row.symbol, name: row.name, cmcId: row.cmcId, sampleDays: row.sampleDays, requiredDays: row.requiredDays }))

  const rows: UnusualRow[] = scored.slice(0, limit).map((row) => ({ ...row }))
  const stamps = all.map((row) => row.capturedAt).filter((v): v is string => !!v).sort()

  // Logos for the returned rows only, from the catalogue, in one request.
  if (rows.length) {
    const ids = [...new Set(rows.map((row) => row.cmcId).filter((v): v is string => !!v))]
    if (ids.length) {
      const logos = await readRows(() => db.from('market_assets').select('provider_id,cached_image_url,image_url')
        .eq('source_provider', 'coinmarketcap').in('provider_id', ids).limit(CATALOGUE_ROW_CAP))
      const byId = new Map<string, { cached: string | null; original: string | null }>()
      for (const logo of logos.rows) {
        const id = str(logo?.provider_id, 12)
        if (id) byId.set(id, { cached: str(logo?.cached_image_url, 500), original: str(logo?.image_url, 500) })
      }
      for (const row of rows) {
        const logo = row.cmcId ? byId.get(row.cmcId) : null
        row.imageUrl = logo?.cached ?? logo?.original ?? null
        row.fallbackImageUrl = logo?.original ?? null
      }
    }
  }

  const agreementRows = await attachAgreement(db, rows, nowMs)

  // The market reference's own scored day, so the residual column has something
  // to be relative TO on the page rather than a number with no anchor.
  const reference = all.find((row) => row.isMarketReference) ?? null

  return {
    ...base,
    subjectDay: day,
    rows,
    scoredAssets: scored.length,
    trackedAssets: all.length,
    excluded, shortHistory,
    agreementRows,
    marketReference: reference
      ? { symbol: reference.symbol, name: reference.name, cmcId: reference.cmcId, movePct: reference.movePct }
      : null,
    asOf: stamps.at(-1) ?? null,
    coverage: { from: stamps[0] ?? null, to: stamps.at(-1) ?? null, count: page.rows.length, truncated: page.rows.length >= SCORE_ROW_CAP },
    reason: null,
    checkedAt: new Date(nowMs).toISOString(),
  }
}

export const UNUSUAL_CAPTURE_VIEWS: Record<string, (
  // deno-lint-ignore no-explicit-any
  db: any, body: Record<string, unknown>, now: number
) => Promise<ViewResult>> = {
  unusual_moves: (db, body, now) => readUnusualMoves(db, body, now),
}
