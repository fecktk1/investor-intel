// Investor Intel RWA universe coverage read views.
//
// Same contract as the other lane read modules: pure functions over a
// PostgREST-shaped `db`, every read bounded by an explicit row cap and paged at
// the 1,000-row PostgREST ceiling, `coverage` reporting what was actually read,
// and an empty table answering `asOf: null` rather than an error or a made-up row.
//
// Three views over the rows the daily `rwa_coverage` lane writes:
//   rwa_coverage          the universe headline and the expected-ticker watch
//   rwa_universe_changes  dated listed / removed / became_tradeable / shelved events
//   rwa_concentration     issuer concentration (HHI, effective issuers, top-5) and
//                         chain share on the newest token snapshot
//
// Served on the `capture_views` surface (free, precomputed): opening the page
// spends no provider credit whoever opens it.

import { RWA_COVERAGE_CAPTURE_SCHEDULE, COVERAGE_ASSET_TABLE, COVERAGE_TOKEN_TABLE, COVERAGE_CHANGE_TABLE } from './capture-rwa-coverage.ts'
import { MAP_COUNT_TABLE } from './capture-rwa-underlyings.ts'
import {
  EXPECTED_RWA_TICKERS, COVERAGE_ASSET_STATES, COVERAGE_CHANGE_KINDS,
  resolveExpectedTicker, tickerCountsAsPresent, issuerGroupKey, concentration, chainShare,
  type TickerSighting, type ConcentrationInput,
} from './rwa-coverage.ts'

export interface Coverage { from: string | null; to: string | null; count: number; truncated?: boolean }
export interface ViewResult { view: string; asOf: string | null; coverage: Coverage; reason?: string | null; [key: string]: unknown }

export const RWA_COVERAGE_VIEWS = ['rwa_coverage', 'rwa_universe_changes', 'rwa_concentration'] as const

export const CATALOGUE_TABLE = 'market_assets'
export const DEPLOYMENT_TABLE = 'intel_rwa_token_deployments'

const PAGE = 1000
/** Asset rows of one day. 791 today; the lane's own ceiling is 3,000 ids. */
const ASSET_CAP = 5000
/** Token rows of one day. */
const TOKEN_CAP = 10000
/** Change events over at most 30 days. */
const CHANGE_CAP = 2000
const MAX_DAYS = 30
const DEFAULT_DAYS = 7

export const CONCENTRATION_FORMULA =
  'HHI = sum over issuers of (issuer market cap / total market cap)^2 x 10,000; effective issuers = 1 / sum of squared shares; top-5 share = sum of the five largest shares. Tokens with no reported market cap, or with neither an issuer id nor an issuer name, are excluded and counted.'

const num = (v: unknown): number | null => { if (v == null || v === '' || typeof v === 'boolean') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const str = (v: unknown, max = 400): string | null => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null }
const at = (now: Date | number): number => (now instanceof Date ? now.getTime() : now)
const emptyCoverage = (): Coverage => ({ from: null, to: null, count: 0 })

// deno-lint-ignore no-explicit-any
async function readRows(build: () => any): Promise<{ rows: any[]; reason: string | null }> {
  try {
    const { data, error } = await build()
    if (error) return { rows: [], reason: String(error.message || error.code || error).slice(0, 200) }
    return { rows: Array.isArray(data) ? data : data ? [data] : [], reason: null }
  } catch (e) { return { rows: [], reason: ((e as Error)?.message || 'read_failed').slice(0, 200) } }
}

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

/** The newest snapshot date in a table, and the one before it. */
// deno-lint-ignore no-explicit-any
async function snapshotDates(db: any, table: string): Promise<{ newest: string | null; previous: string | null; reason: string | null }> {
  const newestRead = await readRows(() => db.from(table).select('snapshot_date').order('snapshot_date', { ascending: false }).limit(1))
  const newest = str(newestRead.rows[0]?.snapshot_date, 10)
  if (!newest) return { newest: null, previous: null, reason: newestRead.reason }
  const prevRead = await readRows(() => db.from(table).select('snapshot_date').lt('snapshot_date', newest).order('snapshot_date', { ascending: false }).limit(1))
  return { newest, previous: str(prevRead.rows[0]?.snapshot_date, 10), reason: newestRead.reason || prevRead.reason }
}

const tickerSymbols = (): string[] => [...new Set(EXPECTED_RWA_TICKERS.flatMap((t) => [t.symbol, t.symbol.toLowerCase()]))]

// ─── rwa_coverage ────────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
export async function readRwaCoverage(db: any, _params: Record<string, unknown> = {}, now: Date | number = Date.now()): Promise<ViewResult> {
  const dates = await snapshotDates(db, COVERAGE_ASSET_TABLE)
  const asOf = dates.newest
  const generatedAt = new Date(at(now)).toISOString()

  // The expected-ticker watch is answered even before the first snapshot: the
  // catalogue alone can say a fund is absent or seen under another name.
  const symbols = tickerSymbols()
  const [catalogueRead, tokenRead] = await Promise.all([
    readRows(() => db.from(CATALOGUE_TABLE).select('source_provider,provider_id,symbol,name,market_cap,volume_24h,in_current_catalog')
      .in('symbol', symbols).limit(200)),
    asOf
      ? readRows(() => db.from(COVERAGE_TOKEN_TABLE).select('rwa_id,crypto_id,symbol,name,market_cap,volume_24h,token_state')
          .eq('snapshot_date', asOf).in('symbol', symbols).limit(200))
      : Promise.resolve({ rows: [], reason: null }),
  ])
  const sightings: TickerSighting[] = [
    ...catalogueRead.rows.filter((r) => r?.in_current_catalog !== false).map((r) => ({
      source: 'market_assets' as const, sourceProvider: str(r?.source_provider, 40), id: str(r?.provider_id, 120),
      symbol: str(r?.symbol, 50), name: str(r?.name, 200), marketCap: num(r?.market_cap), volume24h: num(r?.volume_24h),
    })),
    ...tokenRead.rows.map((r) => ({
      source: 'rwa_coverage' as const, sourceProvider: 'coinmarketcap', id: str(r?.crypto_id, 20),
      symbol: str(r?.symbol, 50), name: str(r?.name, 200), marketCap: num(r?.market_cap), volume24h: num(r?.volume_24h),
    })),
  ]
  const expected = EXPECTED_RWA_TICKERS.map((t) => resolveExpectedTicker(t, sightings))
  const watch = {
    tickers: expected,
    presentCount: expected.filter((e) => tickerCountsAsPresent(e.state)).length,
    inUniverseCount: expected.filter((e) => e.inRwaUniverse).length,
    reason: catalogueRead.reason || tokenRead.reason,
  }

  if (!asOf) {
    return {
      view: 'rwa_coverage', headline: null, states: {}, byType: [], expected: watch,
      schedule: RWA_COVERAGE_CAPTURE_SCHEDULE, asOf: null, coverage: emptyCoverage(), reason: dates.reason, generatedAt,
    }
  }

  const [assetRead, countRead] = await Promise.all([
    readPaged((from, to) => db.from(COVERAGE_ASSET_TABLE)
      .select('rwa_id,asset_type,token_count,priced_count,traded_count,coverage_state,captured_at')
      .eq('snapshot_date', asOf).order('rwa_id', { ascending: true }).range(from, to), ASSET_CAP),
    readRows(() => db.from(MAP_COUNT_TABLE).select('asset_type,snapshot_date,asset_count,with_tokens_count,truncated,captured_at')
      .eq('asset_type', 'all').eq('snapshot_date', asOf).limit(1)),
  ])
  const rows = assetRead.rows
  const states: Record<string, number> = Object.fromEntries(COVERAGE_ASSET_STATES.map((s) => [s, 0]))
  const types = new Map<string, { assetType: string; assets: number; withTokens: number; tradeable: number; notReturned: number }>()
  let withTokens = 0, noTradeable = 0, notReturned = 0
  for (const row of rows) {
    const state = str(row?.coverage_state, 40) || 'not_returned'
    states[state] = (states[state] ?? 0) + 1
    const type = str(row?.asset_type, 40) || 'unknown'
    const bucket = types.get(type) ?? { assetType: type, assets: 0, withTokens: 0, tradeable: 0, notReturned: 0 }
    bucket.assets += 1
    if (state === 'not_returned') { notReturned += 1; bucket.notReturned += 1 }
    else if ((num(row?.token_count) ?? 0) > 0) {
      withTokens += 1
      bucket.withTokens += 1
      if (state === 'tradeable') bucket.tradeable += 1
      else noTradeable += 1
    }
    types.set(type, bucket)
  }
  const countRow = countRead.rows[0]
  const mapTruncated = countRow ? countRow.truncated === true : null
  const capturedAt = rows.map((r) => str(r?.captured_at, 40)).filter((v): v is string => !!v).sort().at(-1) ?? null

  return {
    view: 'rwa_coverage',
    headline: {
      // Assets answered with at least one token, and of those, how many have no
      // token with reported trading. `truncated` is true whenever the headline is
      // a floor: the map enumeration stopped at its page ceiling, some assets were
      // not returned, or this read hit its own cap.
      withTokens, noTradeable, notReturned,
      assets: rows.length,
      mapWithTokens: num(countRow?.with_tokens_count),
      mapTruncated,
      truncated: mapTruncated === true || notReturned > 0 || assetRead.truncated,
    },
    states,
    byType: [...types.values()].sort((a, b) => b.assets - a.assets || a.assetType.localeCompare(b.assetType)),
    expected: watch,
    schedule: RWA_COVERAGE_CAPTURE_SCHEDULE,
    capturedAt,
    asOf,
    previousSnapshotDate: dates.previous,
    coverage: { from: asOf, to: asOf, count: rows.length, truncated: assetRead.truncated },
    reason: assetRead.reason || countRead.reason || dates.reason,
    generatedAt,
  }
}

// ─── rwa_universe_changes ────────────────────────────────────────────────────

export function clampDays(value: unknown): number {
  const n = Math.trunc(Number(value))
  return Number.isFinite(n) && n >= 1 ? Math.min(MAX_DAYS, n) : DEFAULT_DAYS
}

// deno-lint-ignore no-explicit-any
export async function readRwaUniverseChanges(db: any, params: Record<string, unknown> = {}, now: Date | number = Date.now()): Promise<ViewResult> {
  const days = clampDays(params?.days)
  const generatedAt = new Date(at(now)).toISOString()
  const dates = await snapshotDates(db, COVERAGE_ASSET_TABLE)
  // Events exist only between two snapshots. Until there are two, the feed is not
  // "no changes": it is not comparable yet, and says so.
  const comparable = !!(dates.newest && dates.previous)
  const empty = Object.fromEntries(COVERAGE_CHANGE_KINDS.map((k) => [k, [] as unknown[]]))
  if (!comparable) {
    return {
      view: 'rwa_universe_changes', days, comparable: false, rows: [], groups: empty,
      counts: Object.fromEntries(COVERAGE_CHANGE_KINDS.map((k) => [k, 0])),
      schedule: RWA_COVERAGE_CAPTURE_SCHEDULE,
      asOf: dates.newest, snapshotDates: { newest: dates.newest, previous: dates.previous },
      coverage: emptyCoverage(), reason: dates.reason, generatedAt,
    }
  }
  const newestMs = Date.parse(`${dates.newest}T00:00:00.000Z`)
  const from = new Date(newestMs - (days - 1) * 86_400_000).toISOString().slice(0, 10)
  const read = await readRows(() => db.from(COVERAGE_CHANGE_TABLE)
    .select('snapshot_date,previous_snapshot_date,rwa_id,change_kind,from_state,to_state,symbol,name,asset_type,detected_at')
    .gte('snapshot_date', from).order('snapshot_date', { ascending: false }).limit(CHANGE_CAP))
  const rows = read.rows.map((r) => ({
    snapshotDate: str(r?.snapshot_date, 10), previousSnapshotDate: str(r?.previous_snapshot_date, 10),
    rwaId: str(r?.rwa_id, 20), kind: str(r?.change_kind, 40), fromState: str(r?.from_state, 40), toState: str(r?.to_state, 40),
    symbol: str(r?.symbol, 50), name: str(r?.name, 200), assetType: str(r?.asset_type, 40), detectedAt: str(r?.detected_at, 40),
  })).sort((a, b) => String(b.snapshotDate).localeCompare(String(a.snapshotDate)) || String(a.symbol ?? a.rwaId).localeCompare(String(b.symbol ?? b.rwaId)))
  const groups = Object.fromEntries(COVERAGE_CHANGE_KINDS.map((k) => [k, rows.filter((r) => r.kind === k)]))
  return {
    view: 'rwa_universe_changes', days, comparable: true, rows, groups,
    counts: Object.fromEntries(COVERAGE_CHANGE_KINDS.map((k) => [k, groups[k].length])),
    schedule: RWA_COVERAGE_CAPTURE_SCHEDULE,
    asOf: dates.newest, snapshotDates: { newest: dates.newest, previous: dates.previous },
    coverage: { from, to: dates.newest, count: rows.length, truncated: read.rows.length >= CHANGE_CAP },
    reason: read.reason || dates.reason,
    generatedAt,
  }
}

// ─── rwa_concentration ───────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
export async function readRwaConcentration(db: any, _params: Record<string, unknown> = {}, now: Date | number = Date.now()): Promise<ViewResult> {
  const generatedAt = new Date(at(now)).toISOString()
  const dates = await snapshotDates(db, COVERAGE_TOKEN_TABLE)
  const asOf = dates.newest
  if (!asOf) {
    return {
      view: 'rwa_concentration', overall: null, byType: [], chains: null, formula: CONCENTRATION_FORMULA,
      schedule: RWA_COVERAGE_CAPTURE_SCHEDULE, asOf: null, coverage: emptyCoverage(), reason: dates.reason, generatedAt,
    }
  }
  const tokenRead = await readPaged((from, to) => db.from(COVERAGE_TOKEN_TABLE)
    .select('rwa_id,crypto_id,asset_type,symbol,issuer_id,issuer_name,market_cap')
    .eq('snapshot_date', asOf).order('rwa_id', { ascending: true }).order('crypto_id', { ascending: true }).range(from, to), TOKEN_CAP)
  const tokens = tokenRead.rows

  const input = (r: Record<string, unknown>): ConcentrationInput => ({
    group: issuerGroupKey(r?.issuer_id, r?.issuer_name),
    weight: num(r?.market_cap),
    label: str(r?.issuer_name, 200) ?? str(r?.issuer_id, 100),
  })
  const overall = concentration(tokens.map(input))
  const types = [...new Set(tokens.map((r) => str(r?.asset_type, 40) || 'unknown'))]
  const byType = types.map((type) => ({ assetType: type, ...concentration(tokens.filter((r) => (str(r?.asset_type, 40) || 'unknown') === type).map(input), 5) }))
    .sort((a, b) => b.totalWeight - a.totalWeight || a.assetType.localeCompare(b.assetType))

  // Chain share: deployments already stored by the depth lane. A token appears in
  // several asset rows only once here, keyed by its crypto id.
  const byCrypto = new Map<string, number | null>()
  for (const r of tokens) {
    const id = str(r?.crypto_id, 20)
    if (id && !byCrypto.has(id)) byCrypto.set(id, num(r?.market_cap))
  }
  const keys = [...byCrypto.keys()].map((id) => `cmc:${id}`)
  const chainsByToken = new Map<string, Set<string>>()
  const labels = new Map<string, string>()
  let deploymentReason: string | null = null
  for (let i = 0; i < keys.length; i += 200) {
    const read = await readRows(() => db.from(DEPLOYMENT_TABLE).select('token_key,platform_key,platform_label')
      .in('token_key', keys.slice(i, i + 200)).limit(2000))
    if (read.reason) { deploymentReason = read.reason; break }
    for (const row of read.rows) {
      const id = String(row?.token_key ?? '').replace(/^cmc:/, '')
      const platform = str(row?.platform_key, 120)
      if (!id || !platform) continue
      chainsByToken.set(id, (chainsByToken.get(id) ?? new Set()).add(platform))
      const label = str(row?.platform_label, 120)
      if (label && !labels.has(platform)) labels.set(platform, label)
    }
  }
  const share = chainShare([...byCrypto.entries()].map(([cryptoId, weight]) => ({ cryptoId, weight, chains: [...(chainsByToken.get(cryptoId) ?? [])] })))
  const chains = deploymentReason ? null : {
    ...share,
    chains: share.chains.map((c) => ({ ...c, label: labels.get(c.chain) ?? c.chain })),
    tokens: byCrypto.size,
  }

  return {
    view: 'rwa_concentration',
    overall, byType, chains,
    formula: CONCENTRATION_FORMULA,
    weight: 'market_cap',
    schedule: RWA_COVERAGE_CAPTURE_SCHEDULE,
    asOf,
    coverage: { from: asOf, to: asOf, count: tokens.length, truncated: tokenRead.truncated },
    reason: tokenRead.reason || deploymentReason || dates.reason,
    generatedAt,
  }
}

/** Integration surface consumed by `intel-capture/index.ts`, keyed by view name. */
export const RWA_COVERAGE_CAPTURE_VIEWS: Record<string, (
  // deno-lint-ignore no-explicit-any
  db: any, body: Record<string, unknown>, now: number
) => Promise<ViewResult>> = {
  rwa_coverage: (db, body, now) => readRwaCoverage(db, body, now),
  rwa_universe_changes: (db, body, now) => readRwaUniverseChanges(db, body, now),
  rwa_concentration: (db, body, now) => readRwaConcentration(db, body, now),
}
