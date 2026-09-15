// Investor Intel — read views over the CoinMarketCap capture tables.
//
// Pure functions over a PostgREST-shaped `db`, so every view is testable with a
// fake client. The capture tables are service-role only: these reads run inside
// the `intel-capture` Edge Function behind an authenticated Intel membership
// check, never from the browser.
//
// Every read is bounded by an explicit row cap and ordered newest-first before
// it is reversed, so hitting a cap loses the OLDEST rows, never the newest, and
// `coverage` reports the window actually read ({from, to, count}) together with
// `truncated`. An empty table is an empty series with `asOf: null` — never an
// error, and never a fabricated zero point.

const MAX_POINTS = 400
const REGIME_RANGES: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 }
// One hourly row per day of range, with headroom for a catch-up backfill.
const REGIME_CAPS: Record<string, number> = { '7d': 400, '30d': 900, '90d': 2400, '1y': 9000 }
const RANK_TOP_MAX = 50, RANK_WEEKS_MAX = 26
const RWA_CAP = 5100, INDEX_CAP = 2000
const LIQUIDATION_ID_MAX = 10, LIQUIDATION_CAP = 4000
const LIQUIDATION_TOTAL_IDS = 3, LIQUIDATION_TOTAL_CAP = 6200

const ATTENTION_LISTS = ['trending', 'most_visited', 'gainers', 'losers'] as const
const ATTENTION_HOURS_MAX = 168, ATTENTION_CAP = 3000, ATTENTION_STAMP_CAP = 2000

export const CAPTURE_VIEWS = ['regime', 'regime_at', 'rank_map', 'rwa_universe', 'index_constituents', 'liquidations', 'attention'] as const
export type CaptureView = typeof CAPTURE_VIEWS[number]

export interface Coverage { from: string | null; to: string | null; count: number; truncated?: boolean }
export interface ViewResult { view: string; asOf: string | null; coverage: Coverage; reason?: string | null; [key: string]: unknown }

const num = (v: unknown): number | null => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const str = (v: unknown, max = 200): string | null => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null }
const at = (now: Date | number): number => (now instanceof Date ? now.getTime() : now)
const since = (now: Date | number, days: number): string => new Date(at(now) - days * 86_400_000).toISOString()
const emptyCoverage = (): Coverage => ({ from: null, to: null, count: 0 })

/** Bounded read. A failed read is reported as a reason on an empty result; the
 * caller renders "unavailable", never a silently short series. */
async function readRows(build: () => any): Promise<{ rows: any[]; reason: string | null }> {
  try {
    const { data, error } = await build()
    if (error) return { rows: [], reason: String(error.message || error.code || error).slice(0, 200) }
    return { rows: Array.isArray(data) ? data : data ? [data] : [], reason: null }
  } catch (e) { return { rows: [], reason: ((e as Error)?.message || 'read_failed').slice(0, 200) } }
}

/** Even-stride downsample that always keeps the first and last observation. */
export function samplePoints<T>(rows: T[], max = MAX_POINTS): T[] {
  if (rows.length <= max || max < 2) return rows.slice(0, Math.max(0, max))
  const step = rows.length / max, out: T[] = []
  for (let i = 0; i < max; i++) out.push(rows[Math.min(rows.length - 1, Math.floor(i * step))])
  out[out.length - 1] = rows[rows.length - 1]
  return out
}

function coverageOf(rows: { capturedAt?: string | null; date?: string | null }[], cap: number): Coverage {
  const stamps = rows.map((r) => r.capturedAt ?? r.date ?? null).filter((v): v is string => !!v).sort()
  return { from: stamps[0] ?? null, to: stamps.at(-1) ?? null, count: rows.length, truncated: rows.length >= cap }
}

/** Newest-first reads are reversed once here, so every series is chronological. */
const chronological = <T extends { capturedAt?: string | null; date?: string | null }>(rows: T[]): T[] =>
  [...rows].sort((a, b) => String(a.capturedAt ?? a.date ?? '').localeCompare(String(b.capturedAt ?? b.date ?? '')))

// ─── regime ───────────────────────────────────────────────────────────────────
const REGIME_COLUMNS = 'captured_at,fear_greed_value,fear_greed_class,altcoin_season_index,btc_dominance,eth_dominance,total_market_cap,total_volume_24h,stablecoin_market_cap,defi_market_cap,source_observed_at'
const regimePoint = (row: any) => ({
  capturedAt: str(row?.captured_at, 40), fearGreed: num(row?.fear_greed_value), fearGreedClass: str(row?.fear_greed_class, 60),
  altcoinSeason: num(row?.altcoin_season_index), btcDominance: num(row?.btc_dominance), ethDominance: num(row?.eth_dominance),
  totalMarketCap: num(row?.total_market_cap), totalVolume24h: num(row?.total_volume_24h),
  stablecoinMarketCap: num(row?.stablecoin_market_cap), defiMarketCap: num(row?.defi_market_cap),
  observedAt: str(row?.source_observed_at, 40),
})

export async function readRegime(db: any, params: { range?: string } = {}, now: Date | number = Date.now()): Promise<ViewResult> {
  const range = REGIME_RANGES[String(params.range || '30d')] ? String(params.range || '30d') : '30d'
  const cap = REGIME_CAPS[range]
  const { rows, reason } = await readRows(() => db.from('intel_regime_snapshots').select(REGIME_COLUMNS)
    .gte('captured_at', since(now, REGIME_RANGES[range])).order('captured_at', { ascending: false }).limit(cap))
  const points = chronological(rows.map(regimePoint))
  return { view: 'regime', range, series: samplePoints(points), asOf: points.at(-1)?.capturedAt ?? null, coverage: coverageOf(points, cap), reason }
}

// ─── regime_at ────────────────────────────────────────────────────────────────
export async function readRegimeAt(db: any, params: { date?: string } = {}, _now: Date | number = Date.now()): Promise<ViewResult> {
  const raw = String(params.date || '')
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? Date.parse(`${raw}T00:00:00Z`) : Date.parse(raw)
  if (!Number.isFinite(parsed)) return { view: 'regime_at', date: null, regime: null, top: [], asOf: null, coverage: emptyCoverage(), reason: 'invalid_date' }
  const target = new Date(parsed).toISOString(), day = target.slice(0, 10)
  const [before, after] = await Promise.all([
    readRows(() => db.from('intel_regime_snapshots').select(REGIME_COLUMNS).lte('captured_at', target).order('captured_at', { ascending: false }).limit(1)),
    readRows(() => db.from('intel_regime_snapshots').select(REGIME_COLUMNS).gte('captured_at', target).order('captured_at', { ascending: true }).limit(1)),
  ])
  // The closest capture on either side of the requested instant; a day with no
  // capture reports the nearest one it has rather than an invented row.
  const candidates = [...before.rows, ...after.rows].map(regimePoint).filter((row) => row.capturedAt)
  const regime = candidates.sort((a, b) => Math.abs(Date.parse(a.capturedAt!) - parsed) - Math.abs(Date.parse(b.capturedAt!) - parsed))[0] ?? null
  const historical = await readRows(() => db.from('intel_rank_history')
    .select('provider_id,symbol,name,rank,price,market_cap,volume_24h,change_24h_pct,source,snapshot_date')
    .eq('snapshot_date', day).eq('source', 'listings_historical').order('rank', { ascending: true }).limit(10))
  // A day inside the daily-capture window has no historical listing; the daily
  // row for the same date is labelled as what it is.
  const fallback = historical.rows.length ? { rows: [], reason: null } : await readRows(() => db.from('intel_rank_history')
    .select('provider_id,symbol,name,rank,price,market_cap,volume_24h,change_24h_pct,source,snapshot_date')
    .eq('snapshot_date', day).eq('source', 'listings_latest').order('rank', { ascending: true }).limit(10))
  const top = [...historical.rows, ...fallback.rows].map((row: any) => ({
    providerId: str(row?.provider_id, 40), symbol: str(row?.symbol, 50), name: str(row?.name, 200),
    rank: num(row?.rank), price: num(row?.price), marketCap: num(row?.market_cap),
    volume24h: num(row?.volume_24h), change24hPct: num(row?.change_24h_pct), source: str(row?.source, 40),
  }))
  return {
    view: 'regime_at', date: day, regime, top, asOf: regime?.capturedAt ?? null,
    coverage: { from: regime?.capturedAt ?? null, to: regime?.capturedAt ?? null, count: (regime ? 1 : 0) + top.length },
    reason: before.reason || after.reason || historical.reason || fallback.reason,
  }
}

// ─── rank_map ─────────────────────────────────────────────────────────────────
const RANK_COLUMNS = 'provider_id,symbol,snapshot_date,rank'
const weeklyDates = (latest: string, weeks: number): string[] => {
  const anchor = new Date(`${latest}T00:00:00Z`)
  anchor.setUTCDate(anchor.getUTCDate() - ((anchor.getUTCDay() + 6) % 7))
  const dates = new Set<string>([latest])
  for (let week = 0; week < weeks; week++) dates.add(new Date(anchor.getTime() - week * 7 * 86_400_000).toISOString().slice(0, 10))
  return [...dates].sort().reverse()
}

export async function readRankMap(db: any, params: { top?: number; weeks?: number } = {}, _now: Date | number = Date.now()): Promise<ViewResult> {
  const top = Math.max(1, Math.min(RANK_TOP_MAX, Math.trunc(Number(params.top) || 25)))
  const weeks = Math.max(1, Math.min(RANK_WEEKS_MAX, Math.trunc(Number(params.weeks) || 12)))
  const latest = await readRows(() => db.from('intel_rank_history').select('snapshot_date').order('snapshot_date', { ascending: false }).limit(1))
  const latestDate = str(latest.rows[0]?.snapshot_date, 10)
  if (!latestDate) return { view: 'rank_map', series: [], entries: [], exits: [], dates: [], asOf: null, coverage: emptyCoverage(), reason: latest.reason }
  const dates = weeklyDates(latestDate, weeks)
  const current = await readRows(() => db.from('intel_rank_history').select(RANK_COLUMNS)
    .eq('snapshot_date', latestDate).gt('rank', 0).order('rank', { ascending: true }).limit(top))
  const ids = current.rows.map((row: any) => str(row?.provider_id, 40)).filter((v): v is string => !!v)
  if (!ids.length) return { view: 'rank_map', series: [], entries: [], exits: [], dates, asOf: latestDate, coverage: emptyCoverage(), reason: current.reason }
  const cap = ids.length * dates.length + 50
  const [history, previous] = await Promise.all([
    readRows(() => db.from('intel_rank_history').select(RANK_COLUMNS).in('provider_id', ids).in('snapshot_date', dates)
      .order('snapshot_date', { ascending: false }).limit(cap)),
    dates[1]
      ? readRows(() => db.from('intel_rank_history').select(RANK_COLUMNS).eq('snapshot_date', dates[1]).gt('rank', 0).order('rank', { ascending: true }).limit(top))
      : Promise.resolve({ rows: [] as any[], reason: null }),
  ])
  const symbols = new Map<string, string | null>()
  for (const row of [...current.rows, ...history.rows]) { const id = str(row?.provider_id, 40); if (id && !symbols.has(id)) symbols.set(id, str(row?.symbol, 50)) }
  const byAsset = new Map<string, { date: string; rank: number | null }[]>()
  for (const row of history.rows) {
    const id = str(row?.provider_id, 40), date = str(row?.snapshot_date, 10)
    if (!id || !date) continue
    byAsset.set(id, [...(byAsset.get(id) || []), { date, rank: num(row?.rank) }])
  }
  const series = ids.map((id) => ({
    providerId: id, symbol: symbols.get(id) ?? null,
    points: (byAsset.get(id) || []).sort((a, b) => a.date.localeCompare(b.date)),
  }))
  const previousIds = previous.rows.map((row: any) => str(row?.provider_id, 40)).filter((v): v is string => !!v)
  // Entries and exits are only meaningful once a previous week exists; with one
  // captured week both lists stay empty rather than declaring every asset new.
  const comparable = previousIds.length > 0
  return {
    view: 'rank_map', top, dates, series,
    entries: comparable ? ids.filter((id) => !previousIds.includes(id)).map((id) => ({ providerId: id, symbol: symbols.get(id) ?? null })) : [],
    exits: comparable ? previousIds.filter((id) => !ids.includes(id)).map((id) => ({ providerId: id, symbol: null })) : [],
    previousDate: comparable ? dates[1] : null,
    asOf: latestDate,
    coverage: { from: dates.at(-1) ?? null, to: latestDate, count: history.rows.length, truncated: history.rows.length >= cap },
    reason: current.reason || history.reason || previous.reason,
  }
}

// ─── rwa_universe ─────────────────────────────────────────────────────────────
export async function readRwaUniverse(db: any, params: { days?: number } = {}, now: Date | number = Date.now()): Promise<ViewResult> {
  const days = Math.max(1, Math.min(90, Math.trunc(Number(params.days) || 30)))
  const [series, latest] = await Promise.all([
    readRows(() => db.from('intel_rwa_universe_snapshots')
      .select('asset_type,captured_at,asset_count,issuer_count,total_market_value_usd,volume_24h_usd,change_24h_pct')
      .gte('captured_at', since(now, days)).order('captured_at', { ascending: false }).limit(RWA_CAP)),
    readRows(() => db.from('intel_rwa_universe_snapshots')
      .select('asset_type,captured_at,asset_count,issuer_count,total_market_value_usd,volume_24h_usd,change_24h_pct,top_assets')
      .order('captured_at', { ascending: false }).limit(7)),
  ])
  const point = (row: any) => ({
    capturedAt: str(row?.captured_at, 40), assetCount: num(row?.asset_count), issuerCount: num(row?.issuer_count),
    totalMarketValueUsd: num(row?.total_market_value_usd), volume24hUsd: num(row?.volume_24h_usd), change24hPct: num(row?.change_24h_pct),
  })
  const byType = new Map<string, any[]>()
  for (const row of series.rows) {
    const type = str(row?.asset_type, 40); if (!type) continue
    byType.set(type, [...(byType.get(type) || []), point(row)])
  }
  const latestByType: Record<string, unknown> = {}
  for (const row of latest.rows) {
    const type = str(row?.asset_type, 40); if (!type || latestByType[type]) continue
    latestByType[type] = { ...point(row), topAssets: Array.isArray(row?.top_assets) ? row.top_assets.slice(0, 10) : [] }
  }
  const all = [...byType.values()].flat()
  return {
    view: 'rwa_universe', days, latest: latestByType,
    series: [...byType.entries()].map(([assetType, points]) => ({ assetType, points: samplePoints(chronological(points), 200) })),
    asOf: chronological(all).at(-1)?.capturedAt ?? null,
    coverage: coverageOf(all, RWA_CAP), reason: series.reason || latest.reason,
  }
}

// ─── index_constituents ───────────────────────────────────────────────────────
export async function readIndexConstituents(db: any, params: { days?: number } = {}, now: Date | number = Date.now()): Promise<ViewResult> {
  const days = Math.max(1, Math.min(90, Math.trunc(Number(params.days) || 30)))
  const [series, latest] = await Promise.all([
    readRows(() => db.from('intel_index_constituent_snapshots').select('index_code,captured_at,index_value,value_24h_pct')
      .gte('captured_at', since(now, days)).order('captured_at', { ascending: false }).limit(INDEX_CAP)),
    readRows(() => db.from('intel_index_constituent_snapshots').select('index_code,captured_at,index_value,value_24h_pct,constituents')
      .order('captured_at', { ascending: false }).limit(2)),
  ])
  const point = (row: any) => ({ capturedAt: str(row?.captured_at, 40), value: num(row?.index_value), change24hPct: num(row?.value_24h_pct) })
  const byCode = new Map<string, any[]>()
  for (const row of series.rows) {
    const code = str(row?.index_code, 20); if (!code) continue
    byCode.set(code, [...(byCode.get(code) || []), point(row)])
  }
  const latestByCode: Record<string, unknown> = {}
  for (const row of latest.rows) {
    const code = str(row?.index_code, 20); if (!code || latestByCode[code]) continue
    latestByCode[code] = { ...point(row), constituents: Array.isArray(row?.constituents) ? row.constituents.slice(0, 250) : [] }
  }
  const all = [...byCode.values()].flat()
  return {
    view: 'index_constituents', days, latest: latestByCode,
    series: [...byCode.entries()].map(([indexCode, points]) => ({ indexCode, points: samplePoints(chronological(points), 200) })),
    asOf: chronological(all).at(-1)?.capturedAt ?? null,
    coverage: coverageOf(all, INDEX_CAP), reason: series.reason || latest.reason,
  }
}

// ─── liquidations ─────────────────────────────────────────────────────────────
const LIQUIDATION_COLUMNS = 'provider_id,captured_at,symbol,liq_1h,liq_4h,liq_24h,long_1h,short_1h,long_24h,short_24h'

export async function readLiquidations(db: any, params: { providerIds?: unknown; hours?: number } = {}, now: Date | number = Date.now()): Promise<ViewResult> {
  const ids = [...new Set((Array.isArray(params.providerIds) ? params.providerIds : String(params.providerIds ?? '').split(','))
    .map((v) => str(v, 40)).filter((v): v is string => !!v))].slice(0, LIQUIDATION_ID_MAX)
  if (!ids.length) return { view: 'liquidations', rows: [], series: [], asOf: null, coverage: emptyCoverage(), reason: 'no_asset_selected' }
  const hours = Math.max(1, Math.min(24, Math.trunc(Number(params.hours) || 24)))
  // The per-asset window is 5-minute resolution; the 7-day hourly total reads the
  // first three requested assets, which is the widest window a bounded read covers.
  const totalIds = ids.slice(0, LIQUIDATION_TOTAL_IDS)
  const [recent, week] = await Promise.all([
    readRows(() => db.from('intel_liquidation_snapshots').select(LIQUIDATION_COLUMNS).in('provider_id', ids)
      .gte('captured_at', new Date(at(now) - hours * 3_600_000).toISOString()).order('captured_at', { ascending: false }).limit(LIQUIDATION_CAP)),
    readRows(() => db.from('intel_liquidation_snapshots').select('provider_id,captured_at,liq_1h').in('provider_id', totalIds)
      .gte('captured_at', since(now, 7)).order('captured_at', { ascending: false }).limit(LIQUIDATION_TOTAL_CAP)),
  ])
  const byAsset = new Map<string, { symbol: string | null; points: any[] }>()
  for (const row of recent.rows) {
    const id = str(row?.provider_id, 40); if (!id) continue
    const entry = byAsset.get(id) || { symbol: str(row?.symbol, 50), points: [] }
    entry.points.push({
      capturedAt: str(row?.captured_at, 40), liq1h: num(row?.liq_1h), liq4h: num(row?.liq_4h), liq24h: num(row?.liq_24h),
      long1h: num(row?.long_1h), short1h: num(row?.short_1h), long24h: num(row?.long_24h), short24h: num(row?.short_24h),
    })
    byAsset.set(id, entry)
  }
  // Rolling 1-hour windows overlap, so one sample per asset per hour is summed
  // across assets; samples inside the same hour are never added together.
  const perHour = new Map<string, Map<string, { capturedAt: string; value: number | null }>>()
  for (const row of week.rows) {
    const id = str(row?.provider_id, 40), capturedAt = str(row?.captured_at, 40)
    if (!id || !capturedAt) continue
    const hour = `${capturedAt.slice(0, 13)}:00:00.000Z`
    const bucket = perHour.get(hour) || new Map()
    const existing = bucket.get(id)
    if (!existing || capturedAt < existing.capturedAt) bucket.set(id, { capturedAt, value: num(row?.liq_1h) })
    perHour.set(hour, bucket)
  }
  const series = [...perHour.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([hour, bucket]) => {
    const values = [...bucket.values()].map((v) => v.value).filter((v): v is number => v != null)
    return { hour, total: values.length ? values.reduce((sum, v) => sum + v, 0) : null, assets: bucket.size }
  })
  const rows = [...byAsset.entries()].map(([providerId, entry]) => ({ providerId, symbol: entry.symbol, points: samplePoints(chronological(entry.points), 300) }))
  const stamps = recent.rows.map((row: any) => str(row?.captured_at, 40)).filter((v): v is string => !!v).sort()
  return {
    view: 'liquidations', hours, providerIds: ids, totalProviderIds: totalIds, rows,
    series: samplePoints(series, MAX_POINTS),
    asOf: stamps.at(-1) ?? null,
    coverage: { from: stamps[0] ?? null, to: stamps.at(-1) ?? null, count: recent.rows.length, truncated: recent.rows.length >= LIQUIDATION_CAP || week.rows.length >= LIQUIDATION_TOTAL_CAP },
    reason: recent.reason || week.reason,
  }
}

// ─── attention ────────────────────────────────────────────────────────────────

/** One asset's presence on the provider's attention lists over the last
 * `hours` (default 24, at most 168). `captures` are the hourly capture stamps
 * in the window, read from the rank-1 rows of every list, so an hour in which
 * the asset was on no list can be told apart from an hour nobody captured.
 * Only aggregate list membership is read; nothing about who looked. */
export async function readAttention(db: any, params: { providerId?: unknown; hours?: unknown } = {}, now: Date | number = Date.now()): Promise<ViewResult> {
  const providerId = str(params.providerId, 40)
  const hours = Math.max(1, Math.min(ATTENTION_HOURS_MAX, Math.trunc(Number(params.hours) || 24)))
  const lists: Record<string, { capturedAt: string | null; rank: number | null; timePeriod: string | null }[]> =
    Object.fromEntries(ATTENTION_LISTS.map((list) => [list, []]))
  if (!providerId) return { view: 'attention', providerId: null, hours, lists, captures: [], asOf: null, coverage: emptyCoverage(), reason: 'no_asset_selected' }
  const floor = new Date(at(now) - hours * 3_600_000).toISOString()
  const [own, stamps] = await Promise.all([
    readRows(() => db.from('intel_attention_snapshots').select('list,time_period,captured_at,rank').eq('provider_id', providerId)
      .gte('captured_at', floor).order('captured_at', { ascending: false }).limit(ATTENTION_CAP)),
    readRows(() => db.from('intel_attention_snapshots').select('captured_at').eq('rank', 1)
      .gte('captured_at', floor).order('captured_at', { ascending: false }).limit(ATTENTION_STAMP_CAP)),
  ])
  for (const row of own.rows) {
    const list = str(row?.list, 40)
    if (!list || !Object.hasOwn(lists, list)) continue
    lists[list].push({ capturedAt: str(row?.captured_at, 40), rank: num(row?.rank), timePeriod: str(row?.time_period, 20) })
  }
  for (const list of Object.keys(lists)) lists[list] = chronological(lists[list])
  const captures = [...new Set(stamps.rows.map((row: any) => str(row?.captured_at, 40)).filter((v): v is string => !!v))].sort()
  return {
    view: 'attention', providerId, hours, lists, captures,
    asOf: captures.at(-1) ?? null,
    coverage: { from: captures[0] ?? null, to: captures.at(-1) ?? null, count: own.rows.length, truncated: own.rows.length >= ATTENTION_CAP || stamps.rows.length >= ATTENTION_STAMP_CAP },
    reason: own.reason || stamps.reason,
  }
}

/** Single entry point used by the Edge Function; an unknown view is reported as
 * a reason on an empty result, never as a thrown error. */
export async function readCaptureView(db: any, view: string, params: Record<string, unknown> = {}, now: Date | number = Date.now()): Promise<ViewResult> {
  switch (view) {
    case 'regime': return await readRegime(db, params as any, now)
    case 'regime_at': return await readRegimeAt(db, params as any, now)
    case 'rank_map': return await readRankMap(db, params as any, now)
    case 'rwa_universe': return await readRwaUniverse(db, params as any, now)
    case 'index_constituents': return await readIndexConstituents(db, params as any, now)
    case 'liquidations': return await readLiquidations(db, params as any, now)
    case 'attention': return await readAttention(db, params as any, now)
    default: return { view: String(view || ''), series: [], asOf: null, coverage: emptyCoverage(), reason: 'unsupported_view' }
  }
}
