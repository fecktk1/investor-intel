// Investor Intel — read view over the stored candle archive and its backfill
// state (goal B).
//
// Same contract as the other capture read modules: pure functions over a
// PostgREST-shaped `db`, every read bounded by an explicit row cap,
// newest-relevant first so hitting a cap loses the least useful rows, `coverage`
// reporting the window actually read, and a FAILED read reported as a reason on
// an empty result — never a silently short list and never a fabricated row.
//
// The tables are service-role only; this read runs inside `intel-capture` behind
// an authenticated Investor Intel membership check.

const CANDLE_STATES = ['pending', 'partial', 'complete', 'unavailable'] as const
/** Assets listed in one read of the archive's coverage. */
const COVERAGE_ROW_MAX = 250
const COVERAGE_CAP = 1_000

export interface Coverage { from: string | null; to: string | null; count: number; truncated?: boolean }
export interface ViewResult { view: string; asOf: string | null; coverage: Coverage; reason?: string | null; [key: string]: unknown }

export const CANDLE_VIEWS = ['candle_coverage'] as const

const num = (v: unknown): number | null => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
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

const STATE_COLUMNS = 'asset_key,provider,provider_id,cmc_id,symbol,source,state,priority,oldest_candle,newest_candle,candles,credits_spent,attempts,reason,last_attempt_at,completed_at'

// deno-lint-ignore no-explicit-any
const stateRow = (row: any) => ({
  assetKey: str(row?.asset_key, 200), provider: str(row?.provider, 40), providerId: str(row?.provider_id, 40),
  cmcId: str(row?.cmc_id, 12),
  symbol: str(row?.symbol, 50), source: str(row?.source, 60), state: str(row?.state, 20),
  priority: num(row?.priority), oldestCandle: str(row?.oldest_candle, 10), newestCandle: str(row?.newest_candle, 10),
  // A stored zero is a real count. `candles` is never null here: the column has
  // a NOT NULL default, and a row that has stored nothing has stored zero.
  candles: num(row?.candles) ?? 0, creditsSpent: num(row?.credits_spent) ?? 0,
  attempts: num(row?.attempts) ?? 0, reason: str(row?.reason, 200),
  lastAttemptAt: str(row?.last_attempt_at, 40), completedAt: str(row?.completed_at, 40),
})

/**
 * What the archive holds and what the backfill still owes.
 *
 * The totals are the point of the view: how many assets are filled, how far back
 * the oldest stored candle reaches, and how many credits the whole backfill has
 * spent against its ceiling. An empty table is an empty list with `asOf: null`.
 */
// deno-lint-ignore no-explicit-any
export async function readCandleCoverage(db: any, params: { state?: unknown; assetKey?: unknown } = {}, now: Date | number = Date.now()): Promise<ViewResult> {
  const asked = String(params.state ?? 'all').toLowerCase()
  const state = (CANDLE_STATES as readonly string[]).includes(asked) ? asked : 'all'
  const assetKey = str(params.assetKey, 200)
  const page = await readRows(() => {
    let query = db.from('market_asset_candle_backfill').select(STATE_COLUMNS)
    if (state !== 'all') query = query.eq('state', state)
    if (assetKey) query = query.eq('asset_key', assetKey)
    return query.order('priority', { ascending: true }).order('asset_key', { ascending: true }).limit(COVERAGE_CAP)
  })
  const all = page.rows.map(stateRow).filter((row) => !!row.assetKey)
  if (!all.length) {
    return {
      view: 'candle_coverage', state, rows: [],
      totals: { assets: 0, complete: 0, partial: 0, pending: 0, unavailable: 0, candles: 0, creditsSpent: 0 },
      oldestCandle: null, newestCandle: null,
      asOf: null, coverage: emptyCoverage(), reason: page.reason,
    }
  }
  const counted = (value: string) => all.filter((row) => row.state === value).length
  const dates = (key: 'oldestCandle' | 'newestCandle') => all.map((row) => row[key]).filter((v): v is string => !!v).sort()
  const stamps = all.map((row) => row.lastAttemptAt).filter((v): v is string => !!v).sort()
  return {
    view: 'candle_coverage', state,
    rows: all.slice(0, COVERAGE_ROW_MAX),
    totals: {
      assets: all.length, complete: counted('complete'), partial: counted('partial'),
      pending: counted('pending'), unavailable: counted('unavailable'),
      candles: all.reduce((sum, row) => sum + row.candles, 0),
      creditsSpent: all.reduce((sum, row) => sum + row.creditsSpent, 0),
    },
    oldestCandle: dates('oldestCandle')[0] ?? null,
    newestCandle: dates('newestCandle').at(-1) ?? null,
    asOf: stamps.at(-1) ?? null,
    coverage: { from: stamps[0] ?? null, to: stamps.at(-1) ?? null, count: page.rows.length, truncated: page.rows.length >= COVERAGE_CAP },
    reason: page.reason,
    checkedAt: new Date(now instanceof Date ? now.getTime() : now).toISOString(),
  }
}

export const CANDLE_CAPTURE_VIEWS: Record<string, (
  // deno-lint-ignore no-explicit-any
  db: any, body: Record<string, unknown>, now: number
) => Promise<ViewResult>> = {
  candle_coverage: (db, body, now) => readCandleCoverage(db, body, now),
}
