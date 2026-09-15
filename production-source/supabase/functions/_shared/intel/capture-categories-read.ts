// Investor Intel — read views over the category, airdrop and network-stat
// capture tables (CMC plan proposals 22, 27 and 29).
//
// Same contract as `capture-read.ts`: pure functions over a PostgREST-shaped
// `db`, every read bounded by an explicit row cap, ordered newest-first so that
// hitting a cap loses the OLDEST rows, and `coverage` reporting the window
// actually read ({from, to, count}) with `truncated`. An empty table is an empty
// series with `asOf: null` — never an error, and never a fabricated zero point.
//
// The tables are service-role only; these reads run inside the `intel-capture`
// Edge Function behind an authenticated Intel membership check.

const MAX_POINTS = 200
const CATEGORY_DAYS = [1, 7, 30]
const CATEGORY_TOP_MAX = 60, CATEGORY_TOP_DEFAULT = 30
/** 30 categories x 720 hourly points is the widest window the series covers. */
const CATEGORY_SERIES_CAP = CATEGORY_TOP_MAX * 720
const MEMBER_MIN = 5, MEMBER_CAP = 12_000
const CATALOGUE_ID_MAX = 1500, CATALOGUE_CHUNK = 200
const AIRDROP_CAP = 500, AIRDROP_DAYS_MAX = 365
const NETWORK_CAP = 300

export interface Coverage { from: string | null; to: string | null; count: number; truncated?: boolean }
export interface ViewResult { view: string; asOf: string | null; coverage: Coverage; reason?: string | null; [key: string]: unknown }

export const CATEGORY_VIEWS = ['categories', 'category_disagreement', 'airdrops', 'network_stats'] as const
export type CategoryView = typeof CATEGORY_VIEWS[number]

const num = (v: unknown): number | null => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const str = (v: unknown, max = 200): string | null => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null }
const at = (now: Date | number): number => (now instanceof Date ? now.getTime() : now)
const since = (now: Date | number, days: number): string => new Date(at(now) - days * 86_400_000).toISOString()
const emptyCoverage = (): Coverage => ({ from: null, to: null, count: 0 })

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

/** Even-stride downsample that always keeps the first and last observation. */
export function samplePoints<T>(rows: T[], max = MAX_POINTS): T[] {
  if (rows.length <= max || max < 2) return rows.slice(0, Math.max(0, max))
  const step = rows.length / max, out: T[] = []
  for (let i = 0; i < max; i++) out.push(rows[Math.min(rows.length - 1, Math.floor(i * step))])
  out[out.length - 1] = rows[rows.length - 1]
  return out
}

const chronological = <T extends { capturedAt?: string | null }>(rows: T[]): T[] =>
  [...rows].sort((a, b) => String(a.capturedAt ?? '').localeCompare(String(b.capturedAt ?? '')))

// ─── categories ───────────────────────────────────────────────────────────────
const CATEGORY_COLUMNS = 'category_id,captured_at,name,title,num_tokens,avg_price_change,market_cap,market_cap_change,volume,volume_change,observed_at'

// deno-lint-ignore no-explicit-any
const categoryRow = (row: any) => ({
  categoryId: str(row?.category_id, 100), name: str(row?.name, 200), title: str(row?.title, 200),
  capturedAt: str(row?.captured_at, 40), numTokens: num(row?.num_tokens),
  avgPriceChange24hPct: num(row?.avg_price_change), marketCap: num(row?.market_cap),
  marketCapChange24hPct: num(row?.market_cap_change), volume24h: num(row?.volume),
  volumeChange24hPct: num(row?.volume_change), observedAt: str(row?.observed_at, 40),
})

/** Latest board plus a market-cap series per category. `days` is 1, 7 or 30;
 * anything else falls back to 30 rather than widening the read. */
// deno-lint-ignore no-explicit-any
export async function readCategories(db: any, params: { days?: unknown; top?: unknown } = {}, now: Date | number = Date.now()): Promise<ViewResult> {
  const requested = Math.trunc(Number(params.days))
  const days = CATEGORY_DAYS.includes(requested) ? requested : 30
  const top = Math.max(1, Math.min(CATEGORY_TOP_MAX, Math.trunc(Number(params.top) || CATEGORY_TOP_DEFAULT)))
  const latest = await readRows(() => db.from('intel_category_snapshots').select('captured_at').order('captured_at', { ascending: false }).limit(1))
  const capturedAt = str(latest.rows[0]?.captured_at, 40)
  if (!capturedAt) return { view: 'categories', days, top, rows: [], series: [], asOf: null, coverage: emptyCoverage(), reason: latest.reason }
  const board = await readRows(() => db.from('intel_category_snapshots').select(CATEGORY_COLUMNS)
    .eq('captured_at', capturedAt).order('market_cap', { ascending: false, nullsFirst: false }).limit(top))
  const rows = board.rows.map(categoryRow).filter((row) => !!row.categoryId)
  const ids = rows.map((row) => row.categoryId).filter((v): v is string => !!v)
  if (!ids.length) return { view: 'categories', days, top, rows: [], series: [], asOf: capturedAt, coverage: emptyCoverage(), reason: board.reason }
  const cap = Math.min(CATEGORY_SERIES_CAP, ids.length * 24 * days + 100)
  const history = await readRows(() => db.from('intel_category_snapshots').select('category_id,captured_at,market_cap,market_cap_change')
    .in('category_id', ids).gte('captured_at', since(now, days)).order('captured_at', { ascending: false }).limit(cap))
  const byCategory = new Map<string, { capturedAt: string | null; marketCap: number | null; change24hPct: number | null }[]>()
  for (const row of history.rows) {
    const id = str(row?.category_id, 100); if (!id) continue
    byCategory.set(id, [...(byCategory.get(id) || []),
      { capturedAt: str(row?.captured_at, 40), marketCap: num(row?.market_cap), change24hPct: num(row?.market_cap_change) }])
  }
  const names = new Map(rows.map((row) => [row.categoryId as string, row.name]))
  const stamps = history.rows.map((row) => str(row?.captured_at, 40)).filter((v): v is string => !!v).sort()
  return {
    view: 'categories', days, top, rows,
    series: ids.map((id) => ({ categoryId: id, name: names.get(id) ?? null, points: samplePoints(chronological(byCategory.get(id) || []), MAX_POINTS) })),
    asOf: capturedAt,
    coverage: { from: stamps[0] ?? null, to: stamps.at(-1) ?? capturedAt, count: history.rows.length, truncated: history.rows.length >= cap },
    reason: latest.reason || board.reason || history.reason,
  }
}

// ─── category_disagreement ────────────────────────────────────────────────────
/** Normaliser v1: lower-case, drop everything that is not a letter or a digit,
 * then fold a short list of known spellings of the same idea onto one key. The
 * version is returned with the result so a later normaliser is a visible change,
 * never a silent re-interpretation of an old comparison. */
const CATEGORY_ALIASES: Record<string, string> = {
  decentralizedfinancedefi: 'defi', decentralizedfinance: 'defi', defi: 'defi',
  layer1: 'layer1', layerone: 'layer1', l1: 'layer1', smartcontractplatform: 'layer1',
  layer2: 'layer2', layertwo: 'layer2', l2: 'layer2', scaling: 'layer2',
  nonfungibletokensnft: 'nft', nonfungibletoken: 'nft', nfts: 'nft', nft: 'nft',
  memetoken: 'memes', memetokens: 'memes', meme: 'memes', memes: 'memes',
  artificialintelligence: 'ai', aibigdata: 'ai', ai: 'ai',
}

export const NORMALISER_VERSION = 'v1'

export function normaliseCategory(value: unknown): string | null {
  const raw = value == null ? '' : String(value).toLowerCase().replace(/[^a-z0-9]+/g, '')
  if (!raw) return null
  return CATEGORY_ALIASES[raw] ?? raw
}

/** The catalogue row of an asset, keyed by its CoinMarketCap provider id. The
 * `categories` column is a JSON string array; a row that carries none is not
 * evidence of disagreement, so it is counted as unknown. */
// deno-lint-ignore no-explicit-any
async function catalogueCategories(db: any, ids: string[]): Promise<{ byId: Map<string, Set<string>>; reason: string | null }> {
  const byId = new Map<string, Set<string>>()
  let reason: string | null = null
  for (let start = 0; start < ids.length; start += CATALOGUE_CHUNK) {
    const chunk = ids.slice(start, start + CATALOGUE_CHUNK)
    const page = await readRows(() => db.from('market_assets').select('provider_id,categories')
      .eq('source_provider', 'coinmarketcap').in('provider_id', chunk).limit(CATALOGUE_CHUNK))
    reason = reason || page.reason
    for (const row of page.rows) {
      const id = str(row?.provider_id, 40); if (!id) continue
      const raw = Array.isArray(row?.categories) ? row.categories : []
      byId.set(id, new Set(raw.map(normaliseCategory).filter((v: string | null): v is string => !!v)))
    }
  }
  return { byId, reason }
}

/** For every captured category with at least `MEMBER_MIN` members, how many of
 * those members carry the same normalised category on their own catalogue row.
 * A member with no catalogue row, or a row with no categories at all, is counted
 * as `unknown`: absence of a label is never counted as agreement OR as conflict,
 * and `share` is over the members that could actually be compared. */
// deno-lint-ignore no-explicit-any
export async function readCategoryDisagreement(db: any, params: { minMembers?: unknown } = {}, _now: Date | number = Date.now()): Promise<ViewResult> {
  const minMembers = Math.max(2, Math.min(50, Math.trunc(Number(params.minMembers) || MEMBER_MIN)))
  const latest = await readRows(() => db.from('intel_category_members').select('snapshot_date').order('snapshot_date', { ascending: false }).limit(1))
  const snapshotDate = str(latest.rows[0]?.snapshot_date, 10)
  if (!snapshotDate) return { view: 'category_disagreement', rows: [], normaliser: NORMALISER_VERSION, asOf: null, coverage: emptyCoverage(), reason: latest.reason }
  const members = await readRows(() => db.from('intel_category_members').select('category_id,provider_id,symbol')
    .eq('snapshot_date', snapshotDate).limit(MEMBER_CAP))
  const byCategory = new Map<string, { providerId: string; symbol: string | null }[]>()
  for (const row of members.rows) {
    const id = str(row?.category_id, 100), providerId = str(row?.provider_id, 40)
    if (!id || !providerId) continue
    byCategory.set(id, [...(byCategory.get(id) || []), { providerId, symbol: str(row?.symbol, 50) }])
  }
  const kept = [...byCategory.entries()].filter(([, list]) => list.length >= minMembers)
  // Category names come from the board, never from the membership rows.
  const names = await readRows(() => db.from('intel_category_snapshots').select('category_id,name,captured_at')
    .order('captured_at', { ascending: false }).limit(CATEGORY_TOP_MAX * 4))
  const nameById = new Map<string, string | null>()
  for (const row of names.rows) { const id = str(row?.category_id, 100); if (id && !nameById.has(id)) nameById.set(id, str(row?.name, 200)) }

  const ids = [...new Set(kept.flatMap(([, list]) => list.map((m) => m.providerId)))].slice(0, CATALOGUE_ID_MAX)
  const catalogue = await catalogueCategories(db, ids)
  const rows = kept.map(([categoryId, list]) => {
    const name = nameById.get(categoryId) ?? null
    const target = normaliseCategory(name ?? categoryId)
    let agreeing = 0, disagreeing = 0, unknown = 0
    for (const member of list) {
      const labels = catalogue.byId.get(member.providerId)
      if (!labels || labels.size === 0) { unknown += 1; continue }
      if (target && labels.has(target)) agreeing += 1; else disagreeing += 1
    }
    const known = agreeing + disagreeing
    return {
      categoryId, name, members: list.length, agreeing, disagreeing, unknown,
      share: known > 0 ? agreeing / known : null,
    }
  }).sort((a, b) => (a.share ?? 2) - (b.share ?? 2) || b.members - a.members)
  return {
    view: 'category_disagreement', rows, normaliser: NORMALISER_VERSION, minMembers,
    comparedAssets: ids.length, catalogueRows: catalogue.byId.size,
    asOf: snapshotDate,
    coverage: { from: snapshotDate, to: snapshotDate, count: members.rows.length, truncated: members.rows.length >= MEMBER_CAP },
    reason: latest.reason || members.reason || names.reason || catalogue.reason,
  }
}

// ─── airdrops ─────────────────────────────────────────────────────────────────
const AIRDROP_COLUMNS = 'airdrop_id,project_name,provider_id,symbol,slug,status,start_date,end_date,total_prize,winner_count,link,first_seen_at,last_seen_at'
const AIRDROP_STATUSES = ['ongoing', 'upcoming', 'all']

/** past / live / upcoming from the dates the provider reported. When it reported
 * neither date the recorded status is used, and an unrecognised status leaves the
 * lane null rather than guessing at a calendar position. */
export function airdropLane(startMs: number | null, endMs: number | null, status: string | null, nowMs: number): 'past' | 'live' | 'upcoming' | null {
  if (endMs != null && endMs < nowMs) return 'past'
  if (startMs != null && startMs > nowMs) return 'upcoming'
  if (startMs != null || endMs != null) return 'live'
  const s = (status || '').toLowerCase()
  return s === 'ongoing' ? 'live' : s === 'upcoming' ? 'upcoming' : s === 'ended' || s === 'completed' ? 'past' : null
}

// deno-lint-ignore no-explicit-any
export async function readAirdrops(db: any, params: { status?: unknown; days?: unknown; providerIds?: unknown } = {}, now: Date | number = Date.now()): Promise<ViewResult> {
  const requested = String(params.status ?? 'all').toLowerCase()
  const status = AIRDROP_STATUSES.includes(requested) ? requested : 'all'
  const days = Math.max(1, Math.min(AIRDROP_DAYS_MAX, Math.trunc(Number(params.days) || 90)))
  const held = new Set((Array.isArray(params.providerIds) ? params.providerIds : String(params.providerIds ?? '').split(','))
    .map((v) => str(v, 40)).filter((v): v is string => !!v))
  const nowMs = at(now), floor = nowMs - days * 86_400_000
  const page = await readRows(() => db.from('intel_airdrop_snapshots').select(AIRDROP_COLUMNS)
    .order('start_date', { ascending: false, nullsFirst: false }).limit(AIRDROP_CAP))
  const all = page.rows.map((row) => {
    const startMs = Date.parse(String(row?.start_date ?? '')), endMs = Date.parse(String(row?.end_date ?? ''))
    const start = Number.isFinite(startMs) ? startMs : null, end = Number.isFinite(endMs) ? endMs : null
    const providerId = str(row?.provider_id, 40)
    return {
      airdropId: str(row?.airdrop_id, 100), projectName: str(row?.project_name, 200), providerId,
      symbol: str(row?.symbol, 50), slug: str(row?.slug, 200), status: str(row?.status, 40),
      startDate: str(row?.start_date, 40), endDate: str(row?.end_date, 40),
      totalPrize: num(row?.total_prize), winnerCount: num(row?.winner_count), link: str(row?.link, 500),
      lastSeenAt: str(row?.last_seen_at, 40),
      lane: airdropLane(start, end, str(row?.status, 40), nowMs),
      ...(providerId && held.has(providerId) ? { held: true } : {}),
      _start: start,
    }
  }).filter((row) => !!row.airdropId)
  // A finished airdrop leaves the window `days` after it started; one that has
  // not started yet always stays, and one with no dates at all is never hidden.
  const inWindow = all.filter((row) => row._start == null || row._start >= floor || row.lane === 'upcoming')
  const rows = inWindow.filter((row) => status === 'all' || (status === 'ongoing' ? row.lane === 'live' : row.lane === 'upcoming'))
    .sort((a, b) => (a._start ?? Number.POSITIVE_INFINITY) - (b._start ?? Number.POSITIVE_INFINITY))
    // deno-lint-ignore no-explicit-any
    .map(({ _start: _drop, ...row }: any) => row)
  const seen = page.rows.map((row) => str(row?.last_seen_at, 40)).filter((v): v is string => !!v).sort()
  return {
    view: 'airdrops', status, days, rows,
    lanes: {
      past: inWindow.filter((row) => row.lane === 'past').length,
      live: inWindow.filter((row) => row.lane === 'live').length,
      upcoming: inWindow.filter((row) => row.lane === 'upcoming').length,
    },
    heldProviderIds: [...held],
    asOf: seen.at(-1) ?? null,
    coverage: { from: seen[0] ?? null, to: seen.at(-1) ?? null, count: page.rows.length, truncated: page.rows.length >= AIRDROP_CAP },
    reason: page.reason,
  }
}

// ─── network_stats ────────────────────────────────────────────────────────────
const NETWORK_COLUMNS = 'provider_id,captured_at,symbol,hashrate_24h,difficulty,tps_24h,pending_transactions,total_blocks,total_transactions,block_reward_static'

/** The newest row per chain. The capture lane only runs on a Growth plan, so an
 * empty table is an honest "not available on this plan" — never a flat series. */
// deno-lint-ignore no-explicit-any
export async function readNetworkStats(db: any, _params: Record<string, unknown> = {}, _now: Date | number = Date.now()): Promise<ViewResult> {
  const page = await readRows(() => db.from('intel_network_stats_snapshots').select(NETWORK_COLUMNS)
    .order('captured_at', { ascending: false }).limit(NETWORK_CAP))
  const byAsset = new Map<string, Record<string, unknown>>()
  for (const row of page.rows) {
    const id = str(row?.provider_id, 40); if (!id || byAsset.has(id)) continue
    byAsset.set(id, {
      providerId: id, capturedAt: str(row?.captured_at, 40), symbol: str(row?.symbol, 50),
      hashrate24h: num(row?.hashrate_24h), difficulty: num(row?.difficulty), tps24h: num(row?.tps_24h),
      pendingTransactions: num(row?.pending_transactions), totalBlocks: num(row?.total_blocks),
      totalTransactions: num(row?.total_transactions), blockRewardStatic: num(row?.block_reward_static),
    })
  }
  const rows = [...byAsset.values()]
  if (!rows.length) return { view: 'network_stats', rows: [], asOf: null, coverage: emptyCoverage(), reason: page.reason || 'plan_below_growth' }
  const stamps = rows.map((row) => String(row.capturedAt ?? '')).filter(Boolean).sort()
  return {
    view: 'network_stats', rows, asOf: stamps.at(-1) ?? null,
    coverage: { from: stamps[0] ?? null, to: stamps.at(-1) ?? null, count: page.rows.length, truncated: page.rows.length >= NETWORK_CAP },
    reason: page.reason,
  }
}

/** Integration surface. The reviewer wires these into the Edge Function's read
 * half alongside `readCaptureView`. */
export const CATEGORY_CAPTURE_VIEWS: Record<string, (
  // deno-lint-ignore no-explicit-any
  db: any, body: Record<string, unknown>, now: number
) => Promise<ViewResult>> = {
  categories: (db, body, now) => readCategories(db, body, now),
  category_disagreement: (db, body, now) => readCategoryDisagreement(db, body, now),
  airdrops: (db, body, now) => readAirdrops(db, body, now),
  network_stats: (db, body, now) => readNetworkStats(db, body, now),
}
