// Investor Intel — read views over the exchange-reserve and venue-share capture
// tables.
//
// Pure functions over a PostgREST-shaped `db`, testable with a fake client and
// written to the same contract as `capture-read.ts`: every read is bounded by an
// explicit row cap, `coverage` reports the window actually read
// ({from, to, count, truncated}), a failed read comes back as a `reason` on an
// empty result, and an empty table is an empty series with `asOf: null` — never
// an error and never a fabricated zero point.
//
// Both tables are DAY-keyed and wide (a reserve day is up to ten venues by 250
// assets), so neither view sweeps the whole window in one read. Each samples the
// window into a bounded number of calendar days and reads those days exactly:
// a day with no capture contributes a null point rather than an interpolated
// one, and a day is never assembled from a partially-read page.

import type { ViewResult, Coverage } from './capture-read.ts'
export type { ViewResult, Coverage } from './capture-read.ts'

/** Reserves: ten venues by 250 assets is 2 500 rows on a full day. */
const RESERVE_DAY_CAP = 2600
const RESERVE_TOP_ASSETS = 12
const RESERVE_POINTS = 14
const RESERVE_DAYS = [7, 30, 90]
/** Venue share: at most 100 venues per kind per day. */
const VENUE_DAY_CAP = 220
const VENUE_TOP_EXCHANGES = 10
const VENUE_POINTS = 20
const VENUE_DAYS = [30, 90, 365]
const VENUE_KINDS = ['spot', 'derivatives']

const num = (v: unknown): number | null => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const str = (v: unknown, max = 200): string | null => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null }
const int = (v: unknown): number | null => { const n = num(v); return n == null ? null : Math.trunc(n) }
const emptyCoverage = (): Coverage => ({ from: null, to: null, count: 0 })
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
const msOf = (date: string): number => Date.parse(`${date}T00:00:00Z`)
const share = (part: number | null, total: number | null): number | null =>
  part == null || total == null || total <= 0 ? null : (part / total) * 100

/** One of a fixed set of day windows; anything else falls back to the default. */
const oneOf = (value: unknown, allowed: number[], fallback: number): number => {
  const n = Math.trunc(Number(value))
  return allowed.includes(n) ? n : fallback
}

/** Bounded read. A failed read is reported as a reason on an empty result; the
 * caller renders "unavailable", never a silently short series. */
// deno-lint-ignore no-explicit-any
async function readRows(build: () => any): Promise<{ rows: any[]; reason: string | null }> {
  try {
    const { data, error } = await build()
    if (error) return { rows: [], reason: String(error.message || error.code || error).slice(0, 200) }
    return { rows: Array.isArray(data) ? data : data ? [data] : [], reason: null }
  } catch (e) { return { rows: [], reason: ((e as Error)?.message || 'read_failed').slice(0, 200) } }
}

/** Calendar days to read: `latest` first, then an even stride back across the
 * window, always including the oldest day so the drift anchor is covered. */
export function sampleDays(latest: string, days: number, points: number): string[] {
  const end = msOf(latest)
  if (!Number.isFinite(end)) return []
  const oldest = end - (days - 1) * 86_400_000
  const wanted = Math.max(2, Math.min(points, days))
  const step = (days - 1) / (wanted - 1)
  const out = new Set<string>()
  for (let i = 0; i < wanted; i++) out.add(dayOf(end - Math.round(i * step) * 86_400_000))
  out.add(dayOf(oldest))
  return [...out].sort().reverse()
}

// ─── exchange_reserves ────────────────────────────────────────────────────────

const RESERVE_COLUMNS = 'exchange_id,snapshot_date,provider_id,platform_symbol,exchange_slug,symbol,balance,usd_value,wallet_count'

interface ReserveRow { exchangeId: number; slug: string | null; providerId: string; platformSymbol: string; symbol: string | null; balance: number | null; usdValue: number | null; walletCount: number | null }
interface CompositionEntry {
  providerId: string | null; symbol: string | null; platformSymbol: string | null
  balance: number | null; usdValue: number | null; walletCount: number | null; sharePct: number | null
  priorUsdValue: number | null; driftUsdValue: number | null; driftPct: number | null
}

// deno-lint-ignore no-explicit-any
const reserveRow = (row: any): ReserveRow | null => {
  const exchangeId = int(row?.exchange_id)
  const providerId = str(row?.provider_id, 40)
  if (exchangeId == null || !providerId) return null
  return {
    exchangeId, slug: str(row?.exchange_slug, 200), providerId,
    platformSymbol: str(row?.platform_symbol, 50) ?? '', symbol: str(row?.symbol, 50),
    balance: num(row?.balance), usdValue: num(row?.usd_value), walletCount: num(row?.wallet_count),
  }
}
const assetKey = (row: ReserveRow): string => `${row.providerId}|${row.platformSymbol}`

/** One day of reserve rows, largest holdings first so a capped page loses the
 * smallest positions. `truncated` says the day's total is a floor, not a total. */
// deno-lint-ignore no-explicit-any
async function readReserveDay(db: any, date: string, exchangeId: number | null): Promise<{ rows: ReserveRow[]; truncated: boolean; reason: string | null }> {
  const { rows, reason } = await readRows(() => {
    let q = db.from('intel_exchange_reserve_snapshots').select(RESERVE_COLUMNS).eq('snapshot_date', date)
    if (exchangeId != null) q = q.eq('exchange_id', exchangeId)
    return q.order('usd_value', { ascending: false }).limit(RESERVE_DAY_CAP)
  })
  return { rows: rows.map(reserveRow).filter((v): v is ReserveRow => !!v), truncated: rows.length >= RESERVE_DAY_CAP, reason }
}

const totalUsd = (rows: ReserveRow[]): number | null => {
  const values = rows.map((row) => row.usdValue).filter((v): v is number => v != null)
  return values.length ? values.reduce((sum, v) => sum + v, 0) : null
}

export async function readExchangeReserves(
  // deno-lint-ignore no-explicit-any
  db: any, params: { days?: unknown; exchangeId?: unknown } = {}, now: Date | number = Date.now(),
): Promise<ViewResult> {
  const view = 'exchange_reserves'
  const days = oneOf(params.days, RESERVE_DAYS, 30)
  const exchangeId = int(params.exchangeId)
  const empty = (reason: string | null): ViewResult =>
    ({ view, days, exchangeId, exchanges: [], series: [], priorDate: null, asOf: null, coverage: emptyCoverage(), reason })

  const latest = await readRows(() => {
    let q = db.from('intel_exchange_reserve_snapshots').select('snapshot_date')
    if (exchangeId != null) q = q.eq('exchange_id', exchangeId)
    // The provider's day never runs ahead of the clock; a row dated in the
    // future would be a capture bug, not a newer observation.
    return q.lte('snapshot_date', dayOf(now instanceof Date ? now.getTime() : now)).order('snapshot_date', { ascending: false }).limit(1)
  })
  const latestDate = str(latest.rows[0]?.snapshot_date, 10)
  if (!latestDate) return empty(latest.reason)

  const priorDate = dayOf(msOf(latestDate) - days * 86_400_000)
  const dates = [...new Set([...sampleDays(latestDate, days, RESERVE_POINTS), priorDate])].sort().reverse()
  const reads = await Promise.all(dates.map((date) => readReserveDay(db, date, exchangeId)))
  const byDate = new Map(dates.map((date, i) => [date, reads[i]]))
  const reason = reads.map((r) => r.reason).find((v) => v) ?? latest.reason ?? null

  const today = byDate.get(latestDate) ?? { rows: [], truncated: false, reason: null }
  const prior = byDate.get(priorDate) ?? { rows: [], truncated: false, reason: null }
  const priorByExchange = new Map<number, ReserveRow[]>()
  for (const row of prior.rows) priorByExchange.set(row.exchangeId, [...(priorByExchange.get(row.exchangeId) || []), row])

  const currentByExchange = new Map<number, ReserveRow[]>()
  for (const row of today.rows) currentByExchange.set(row.exchangeId, [...(currentByExchange.get(row.exchangeId) || []), row])

  const exchanges = [...currentByExchange.entries()].map(([id, rows]) => {
    const sorted = [...rows].sort((a, b) => (b.usdValue ?? -1) - (a.usdValue ?? -1))
    const total = totalUsd(sorted)
    const priorRows = priorByExchange.get(id) || []
    // "Missing" means the venue has no capture at all on the earlier day: every
    // drift is then null. A day that exists but does not list an asset leaves
    // that asset's drift null too — an absence is never read as a zero balance.
    const priorAvailable = priorRows.length > 0
    const priorTotal = priorAvailable ? totalUsd(priorRows) : null
    const priorByAsset = new Map(priorRows.map((row) => [assetKey(row), row]))
    const top = sorted.slice(0, RESERVE_TOP_ASSETS)
    const rest = sorted.slice(RESERVE_TOP_ASSETS)
    const composition: CompositionEntry[] = top.map((row) => {
      const before = priorAvailable ? priorByAsset.get(assetKey(row))?.usdValue ?? null : null
      return {
        providerId: row.providerId, symbol: row.symbol, platformSymbol: row.platformSymbol || null,
        balance: row.balance, usdValue: row.usdValue, walletCount: row.walletCount,
        sharePct: share(row.usdValue, total),
        priorUsdValue: before,
        driftUsdValue: before == null || row.usdValue == null ? null : row.usdValue - before,
        driftPct: before == null || before <= 0 || row.usdValue == null ? null : ((row.usdValue - before) / before) * 100,
      }
    })
    const restUsd = totalUsd(rest)
    // "other" is exact: the earlier day's total less the earlier value of the
    // twelve named assets, so it needs no extra read and invents nothing.
    const priorTop = priorAvailable
      ? top.map((row) => priorByAsset.get(assetKey(row))?.usdValue ?? null).filter((v): v is number => v != null).reduce((sum, v) => sum + v, 0)
      : null
    const priorRest = priorTotal != null && priorTop != null ? priorTotal - priorTop : null
    if (rest.length) {
      composition.push({
        providerId: null, symbol: 'other', platformSymbol: null,
        balance: null, usdValue: restUsd, walletCount: null,
        sharePct: share(restUsd, total),
        priorUsdValue: priorRest,
        driftUsdValue: priorRest == null || restUsd == null ? null : restUsd - priorRest,
        driftPct: priorRest == null || priorRest <= 0 || restUsd == null ? null : ((restUsd - priorRest) / priorRest) * 100,
      })
    }
    return {
      exchangeId: id, exchangeSlug: sorted[0]?.slug ?? null,
      totalUsdValue: total, assetCount: sorted.length, otherAssetCount: rest.length,
      priorAvailable, priorTotalUsdValue: priorTotal,
      driftUsdValue: priorTotal == null || total == null ? null : total - priorTotal,
      driftPct: priorTotal == null || priorTotal <= 0 || total == null ? null : ((total - priorTotal) / priorTotal) * 100,
      composition,
    }
  }).sort((a, b) => (b.totalUsdValue ?? -1) - (a.totalUsdValue ?? -1))

  const series = dates.slice().sort().map((date) => {
    const day = byDate.get(date)
    const rows = day?.rows ?? []
    const perExchange = new Map<number, ReserveRow[]>()
    for (const row of rows) perExchange.set(row.exchangeId, [...(perExchange.get(row.exchangeId) || []), row])
    return {
      date, total: rows.length ? totalUsd(rows) : null, exchanges: perExchange.size,
      truncated: day?.truncated === true,
      byExchange: [...perExchange.entries()].map(([id, exchangeRows]) => ({ exchangeId: id, total: totalUsd(exchangeRows) }))
        .sort((a, b) => (b.total ?? -1) - (a.total ?? -1)),
    }
  })

  const covered = series.filter((point) => point.total != null || point.exchanges > 0)
  return {
    view, days, exchangeId, priorDate, dates: dates.slice().sort(),
    exchanges, series, asOf: latestDate,
    coverage: {
      from: covered[0]?.date ?? null, to: covered.at(-1)?.date ?? null,
      count: reads.reduce((sum, read) => sum + read.rows.length, 0),
      truncated: reads.some((read) => read.truncated),
    },
    reason,
  }
}

// ─── venue_share ──────────────────────────────────────────────────────────────

const VENUE_COLUMNS = 'kind,exchange_id,snapshot_date,exchange_slug,volume_24h,open_interest,num_market_pairs,observed_at'

interface VenueRow { exchangeId: number; slug: string | null; volume24h: number | null; openInterest: number | null; numMarketPairs: number | null; observedAt: string | null }
interface SharePoint {
  date: string; total: number; venues: number; truncated: boolean
  shares: { exchangeId: number; value: number | null; sharePct: number | null }[]
  other: { value: number | null; sharePct: number | null; venues: number }
}

// deno-lint-ignore no-explicit-any
const venueRow = (row: any): VenueRow | null => {
  const exchangeId = int(row?.exchange_id)
  if (exchangeId == null) return null
  return {
    exchangeId, slug: str(row?.exchange_slug, 200), volume24h: num(row?.volume_24h),
    openInterest: num(row?.open_interest), numMarketPairs: num(row?.num_market_pairs),
    observedAt: str(row?.observed_at, 40),
  }
}

const sumOf = (values: (number | null)[]): number | null => {
  const present = values.filter((v): v is number => v != null)
  return present.length ? present.reduce((sum, v) => sum + v, 0) : null
}

export async function readVenueShare(
  // deno-lint-ignore no-explicit-any
  db: any, params: { days?: unknown; kind?: unknown } = {}, now: Date | number = Date.now(),
): Promise<ViewResult> {
  const view = 'venue_share'
  const days = oneOf(params.days, VENUE_DAYS, 30)
  const kind = VENUE_KINDS.includes(String(params.kind || '')) ? String(params.kind) : 'spot'
  const empty = (reason: string | null): ViewResult =>
    ({ view, days, kind, exchanges: [], series: [], oiSeries: [], pairs: [], asOf: null, coverage: emptyCoverage(), reason })

  const latest = await readRows(() => db.from('intel_venue_share_snapshots').select('snapshot_date').eq('kind', kind)
    .lte('snapshot_date', dayOf(now instanceof Date ? now.getTime() : now))
    .order('snapshot_date', { ascending: false }).limit(1))
  const latestDate = str(latest.rows[0]?.snapshot_date, 10)
  if (!latestDate) return empty(latest.reason)

  const dates = sampleDays(latestDate, days, VENUE_POINTS)
  const reads = await Promise.all(dates.map((date) => readRows(() => db.from('intel_venue_share_snapshots')
    .select(VENUE_COLUMNS).eq('kind', kind).eq('snapshot_date', date)
    .order('volume_24h', { ascending: false }).limit(VENUE_DAY_CAP))))
  const byDate = new Map(dates.map((date, i) => [date, {
    rows: reads[i].rows.map(venueRow).filter((v): v is VenueRow => !!v),
    truncated: reads[i].rows.length >= VENUE_DAY_CAP,
  }]))
  const reason = reads.map((r) => r.reason).find((v) => v) ?? latest.reason ?? null

  const today = byDate.get(latestDate)?.rows ?? []
  const ranked = [...today].sort((a, b) => (b.volume24h ?? -1) - (a.volume24h ?? -1))
  const top = ranked.slice(0, VENUE_TOP_EXCHANGES)
  const topIds = top.map((row) => row.exchangeId)
  const latestTotal = sumOf(ranked.map((row) => row.volume24h))
  const latestOiTotal = sumOf(ranked.map((row) => row.openInterest))
  const slugs = new Map<number, string | null>()
  for (const [, day] of byDate) for (const row of day.rows) if (!slugs.has(row.exchangeId)) slugs.set(row.exchangeId, row.slug)

  const exchanges = top.map((row) => ({
    exchangeId: row.exchangeId, exchangeSlug: row.slug,
    volume24h: row.volume24h, sharePct: share(row.volume24h, latestTotal),
    openInterest: row.openInterest, oiSharePct: share(row.openInterest, latestOiTotal),
    numMarketPairs: row.numMarketPairs, observedAt: row.observedAt,
  }))

  const ordered = dates.slice().sort()
  const point = (date: string, field: 'volume24h' | 'openInterest'): SharePoint | null => {
    const day = byDate.get(date)
    const rows = day?.rows ?? []
    const values = rows.map((row) => row[field])
    const total = sumOf(values)
    if (!rows.length || total == null) return null
    const named = rows.filter((row) => topIds.includes(row.exchangeId))
    const rest = rows.filter((row) => !topIds.includes(row.exchangeId))
    const restValue = sumOf(rest.map((row) => row[field]))
    return {
      date, total, venues: rows.length, truncated: day?.truncated === true,
      shares: topIds.map((id) => {
        const row = named.find((r) => r.exchangeId === id)
        // A venue absent from that day's capture has no share; it is never
        // carried forward from a neighbouring day.
        return { exchangeId: id, value: row?.[field] ?? null, sharePct: row ? share(row[field] ?? null, total) : null }
      }),
      other: { value: restValue, sharePct: share(restValue, total), venues: rest.length },
    }
  }
  const series = ordered.map((date) => point(date, 'volume24h')).filter((v): v is SharePoint => !!v)
  const oiSeries = ordered.map((date) => point(date, 'openInterest')).filter((v): v is SharePoint => !!v)

  const pairs = topIds.map((id) => ({
    exchangeId: id, exchangeSlug: slugs.get(id) ?? null,
    points: ordered.map((date) => {
      const row = (byDate.get(date)?.rows ?? []).find((r) => r.exchangeId === id)
      return { date, numMarketPairs: row?.numMarketPairs ?? null }
    }),
  }))

  const covered = ordered.filter((date) => (byDate.get(date)?.rows.length ?? 0) > 0)
  return {
    view, days, kind, dates: ordered, exchanges, series, oiSeries, pairs,
    totalVolume24h: latestTotal, totalOpenInterest: latestOiTotal,
    asOf: latestDate,
    coverage: {
      from: covered[0] ?? null, to: covered.at(-1) ?? null,
      count: [...byDate.values()].reduce((sum, day) => sum + day.rows.length, 0),
      truncated: [...byDate.values()].some((day) => day.truncated),
    },
    reason,
  }
}

/** Integration surface for `intel-capture/index.ts`: one entry per view name,
 * each taking the raw request body so the function needs no per-view plumbing. */
export const VENUE_CAPTURE_VIEWS: Record<string, (
  // deno-lint-ignore no-explicit-any
  db: any, body: Record<string, unknown>, now: number) => Promise<ViewResult>> = {
  exchange_reserves: (db, body, now) => readExchangeReserves(db, body as { days?: unknown; exchangeId?: unknown }, now),
  venue_share: (db, body, now) => readVenueShare(db, body as { days?: unknown; kind?: unknown }, now),
}

export const VENUE_CAPTURE_VIEW_NAMES = Object.keys(VENUE_CAPTURE_VIEWS) as ['exchange_reserves', 'venue_share']
