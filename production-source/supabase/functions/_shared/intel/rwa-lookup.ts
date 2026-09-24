// Investor Intel: "Look up any tokenised asset".
//
// A PUBLIC, read-only answer for one real-world asset, by ticker, name or
// rwa_id, served by the intel-rwa-lookup Edge Function to anyone, signed in or
// not. It exists so a visitor (a hackathon judge on /intel/demo, or a member on
// /intel/rwa) can type a ticker and watch a real CoinMarketCap-backed answer
// arrive, with the proof for every figure beside it, and a plain statement of
// whether THIS answer's quote came from a live call or from the store.
//
// WHAT IT SPENDS. Nothing per visitor, except one bounded case:
//
//   * Identity, wrappers and the premium against the anchor are STORED capture
//     rows (intel_rwa_asset_profiles, intel_rwa_wrapper_assets/_tokens,
//     intel_rwa_coverage_assets) that scheduled lanes already paid for. Reading
//     them is a database read.
//   * The latest quote: the newest shared copy (this asset's own, or the warm
//     lane's ONE batched quotes read of every judge-path asset,
//     capture-rwa-quote-warm.ts) answers while it is younger than the live rule
//     allows (readLookupQuote, decideQuoteRead: ten minutes). Otherwise, or when
//     the visitor presses "Check CoinMarketCap now", ONE live /v5 quotes call is
//     made through the governed transport (reservation, receipt, proof), never a
//     demand stamp, and only through every gate: the per-IP hourly allowance, the
//     per-IP and everybody's UTC-day allowance (intel_rwa_lookup_live_take), and
//     the 200 credit daily free RWA budget (intel_free_rwa_read_claim). When a
//     gate refuses, the newest copy answers and the page says why no call was
//     made. A rebuild behind a kept answer never calls.
//
// WHAT IT NEVER DOES. It never reads the caller's token, never writes demand,
// never calls AI, and never returns "no data" for an asset we know: when a live
// miss fails (the event key reverts to the Basic plan after 30 Sep 2026 and the
// RWA endpoints may then refuse with 402/1003) it serves the newest copy it has,
// with its age and the honest reason. The key never appears in any output: the
// reproduce line carries only the literal shell variable $CMC_API_KEY, and the
// finished body is scrubbed against the configured key before it is sent.

//
// HOW FAST IT ANSWERS. Every read above is a round trip to the database, and
// under load each one can take a second or more (a lookup took 15 s on 23 Sep
// while the hourly derived-market job ran). So the reads that do not depend on
// each other run side by side (the warm lane's state beside the resolution; the
// identity call log, the wrapper and coverage captures, the quote and the
// wrapper rows all at once), bookkeeping writes happen after the answer is sent
// (`defer`), and a finished answer is kept per query (`answers`): the next
// visitor is served that answer at once, re-aged to the moment it is served,
// while a fresh one is assembled behind it (answerLookup).

import { isDerivativeReference } from './rwa-wrapper-spread.ts'
import { CMC_CAPABILITIES } from '../market-assets/cmc-capabilities.ts'
import { cmcReproduceCommand } from '../market-assets/cmc-reproduce.ts'
import { freeRwaInWindow, freeRwaReadFresh, freeRwaSnapshotUsable, newestUsable, RWA_FREE_CAPABILITIES as FREE_CAPS, type FreeRwaClaim, type FreeRwaPlan, type ResearchSnapshot } from './rwa-free-read.ts'
import { warmPlanRefusal, type WarmState } from './capture-rwa-quote-warm.ts'
import { NO_TIMER, type PhaseTimer } from './server-timing.ts'

export const LOOKUP_VERSION = 1
export const ATTRIBUTION = 'Data provided by CoinMarketCap.com'
export const LOOKUP_MAX_QUERY = 60
/** Every request, per IP: generous for a person typing, useless for a scraper. */
export const LOOKUP_RATE = { limit: 30, windowSeconds: 60 }
/** Live reads per IP per hour, counted only at a shared-cache miss (at 1 credit
 * each, one address can use at most a tenth of the 200 credit free day).
 * The daily free budget still bounds the total. */
export const LOOKUP_LIVE_RATE = { limit: 20, windowSeconds: 3600 }
/** Live calls per UTC day (public.intel_rwa_lookup_live_take), per address and
 * for everybody together, on top of the hourly allowance above and the 200
 * credit free RWA budget. 'auto' is the lookup's own live rule; 'check' is a
 * visitor pressing "Check CoinMarketCap now". Tests lower them; production
 * never does. Together they stay well inside the free budget, which the warm
 * lane (about 47 credits a day) also draws on. */
export const LOOKUP_DAILY_ALLOWANCE = { auto: { perIp: 30, all: 100 }, check: { perIp: 5, all: 40 } } as const
export type LiveKind = 'auto' | 'check'
/** public.intel_rwa_lookup_live_take's reason_code, as the lookup's reason. */
export function dailyTakeReason(kind: LiveKind, code: unknown): string {
  if (code === 'daily_cap_reached') return kind === 'check' ? 'lookup_check_daily_limit' : 'lookup_live_daily_limit'
  if (code === 'all_daily_cap_reached') return kind === 'check' ? 'lookup_check_all_daily_limit' : 'lookup_live_all_daily_limit'
  return 'lookup_allowance_unavailable'
}
const ALTERNATIVES = 4
const WRAPPER_ROWS = 40
const RAW_CHARS = 2400

/** The one shape the query may take: letters and digits first, then letters,
 * digits, spaces and . & ' ( ) -. No %, _, * or comma, so it can never become a
 * wildcard or a filter in the PostgREST query it is used in. */
const QUERY_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} .&'()-]{0,59}$/u

export type LookupQuery = { kind: 'rwa_id'; value: string; text: string } | { kind: 'text'; value: string; text: string }

/** Validate and classify the raw query. Throws Error('invalid_query') on
 * anything else. An rwa_id is 1 to 9 digits; everything else is a ticker, slug
 * or name. */
export function parseLookupQuery(input: unknown): LookupQuery {
  if (typeof input !== 'string') throw new Error('invalid_query')
  const text = input.normalize('NFC').replace(/\s+/g, ' ').trim()
  if (!text || text.length > LOOKUP_MAX_QUERY || !QUERY_PATTERN.test(text)) throw new Error('invalid_query')
  if (/^[0-9]{1,9}$/.test(text)) {
    if (Number(text) < 1) throw new Error('invalid_query')
    return { kind: 'rwa_id', value: String(Number(text)), text }
  }
  return { kind: 'text', value: text, text }
}

// ─── Receipts ────────────────────────────────────────────────────────────────

export type Served = 'live' | 'cache' | 'retained' | 'capture' | 'unavailable'
export interface FigureReceipt {
  capability: string
  endpoint: string | null
  params: Record<string, string>
  /** live: a provider call answered THIS request. cache: the shared response
   * cache inside its window. retained: the newest copy we kept after a failed
   * or refused live read. capture: a stored row a scheduled lane wrote. */
  served: Served
  capturedAt: string | null
  ageSeconds: number | null
  httpStatus: number | null
  creditCount: number | null
  /** 'this_call' only for a live read: the exact request that produced it.
   * Otherwise the same request for this asset, to check the figure yourself. */
  curl: string | null
  curlMeaning: 'this_call' | 'same_request' | null
  raw: unknown
  rawTruncated: boolean
  /** A capture run's call log, when the figure came from one. */
  caller?: string | null
  /** Shared cache only: the credit_count CoinMarketCap reported on the call that
   * filled the cache, from that call's stored response (the transport receipt's
   * proof). creditCount stays this lookup's own charge, which a cache hit never
   * has. Null when the stored response reported none. */
  originCreditCount?: number | null
  /** The figure came from the warm lane's one batched read of this many assets;
   * `params` then IS that batched request, and the raw excerpt is this asset's
   * part of its response. Absent for a read of this asset alone. */
  batchSize?: number | null
  /** A copy past its window: why this lookup did not refresh it (the per-IP
   * allowance, the daily budget, a plan refusal, a failed call). */
  refreshReason?: string | null
  reason: string | null
}

const iso = (v: unknown): string | null => { if (v == null || v === '') return null; const t = Date.parse(String(v)); return Number.isFinite(t) ? new Date(t).toISOString() : null }
const num = (v: unknown): number | null => { if (v == null || v === '' || typeof v === 'boolean') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const str = (v: unknown, max = 200): string | null => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null }
const age = (at: string | null, now: number): number | null => at ? Math.max(0, Math.round((now - Date.parse(at)) / 1000)) : null

/** A JSON excerpt small enough to read on a phone: long prose dropped, strings
 * cut at 160 characters, arrays at five items, depth at seven. */
export function trimRaw(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') return value.length > 160 ? `${value.slice(0, 160)}…` : value
  if (depth >= 7) return Array.isArray(value) ? `[${value.length} items]` : '{…}'
  if (Array.isArray(value)) {
    const out: unknown[] = value.slice(0, 5).map((v) => trimRaw(v, depth + 1))
    if (value.length > 5) out.push(`… ${value.length - 5} more`)
    return out
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'description' || k === 'about') { out[k] = v == null ? v : '[omitted]'; continue }
      out[k] = trimRaw(v, depth + 1)
    }
    return out
  }
  return null
}

function rawExcerpt(value: unknown): { raw: unknown; rawTruncated: boolean } {
  const trimmed = trimRaw(value)
  const text = JSON.stringify(trimmed) ?? 'null'
  const full = JSON.stringify(value) ?? 'null'
  if (text.length <= RAW_CHARS) return { raw: trimmed, rawTruncated: text !== full }
  return { raw: `${text.slice(0, RAW_CHARS)}…`, rawTruncated: true }
}

/** The curl line for one registered capability and its params. Built through
 * cmcReproduceCommand, so it is byte for byte the request the transport sends,
 * with the key as the literal $CMC_API_KEY. */
export function reproduceLine(capability: string, params: Record<string, string>): string | null {
  const spec = CMC_CAPABILITIES[capability]
  if (!spec) return null
  return cmcReproduceCommand({ origin: 'live', keyMode: 'keyed', provider: 'coinmarketcap', capability, endpoint: spec.path, parameters: params })
}

function receipt(input: {
  capability: string; params: Record<string, string>; served: Served; capturedAt: unknown; now: number
  httpStatus?: unknown; creditCount?: unknown; raw?: unknown; reason?: string | null; caller?: string | null; originCreditCount?: unknown
  batchSize?: number | null; refreshReason?: string | null
}): FigureReceipt {
  const capturedAt = iso(input.capturedAt)
  const excerpt = input.raw === undefined ? { raw: null, rawTruncated: false } : rawExcerpt(input.raw)
  const curl = reproduceLine(input.capability, input.params)
  const batched = input.batchSize != null && input.batchSize > 1
  return {
    capability: input.capability, endpoint: CMC_CAPABILITIES[input.capability]?.path ?? null, params: input.params,
    served: input.served, capturedAt, ageSeconds: age(capturedAt, input.now),
    httpStatus: num(input.httpStatus), creditCount: num(input.creditCount),
    curl, curlMeaning: curl ? (input.served === 'live' ? 'this_call' : 'same_request') : null,
    // A batched read's excerpt is this asset's part of a larger response.
    ...excerpt, ...(batched ? { rawTruncated: true, batchSize: input.batchSize } : {}),
    ...(input.caller !== undefined ? { caller: input.caller } : {}),
    ...(input.originCreditCount !== undefined ? { originCreditCount: num(input.originCreditCount) } : {}),
    ...(input.refreshReason ? { refreshReason: input.refreshReason } : {}), reason: input.reason ?? null,
  }
}

// ─── Storage reads ───────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
type Db = any
// deno-lint-ignore no-explicit-any
async function rows(build: () => any): Promise<{ rows: any[]; failed: boolean }> {
  try {
    const { data, error } = await build()
    if (error) return { rows: [], failed: true }
    return { rows: Array.isArray(data) ? data : data ? [data] : [], failed: false }
  } catch { return { rows: [], failed: true } }
}

const PROFILE_COLUMNS = 'rwa_id,slug,symbol,name,asset_type,rwa_rank,has_tokens,logo_url,website,primary_exchange,industry,cik,provider_capability,captured_at,provider_fetched_at'

export interface Resolution { asset: Record<string, unknown> | null; alternatives: Record<string, unknown>[]; failed: boolean; catalogue: { count: number | null; capturedAt: string | null } }

const assetRef = (r: Record<string, unknown>) => ({ rwaId: String(r.rwa_id), symbol: str(r.symbol, 40), name: str(r.name), assetType: str(r.asset_type, 40) })

/** Resolve a query against the stored rwaInfo catalogue: exact rwa_id, then
 * exact ticker, then slug, then exact name, then a name or ticker prefix. Rank
 * orders ties, so NVDA is Nvidia. Never a provider call. */
export async function resolveRwa(db: Db, q: LookupQuery): Promise<Resolution> {
  const table = () => db.from('intel_rwa_asset_profiles').select(PROFILE_COLUMNS)
  const ranked = (b: Db) => b.order('rwa_rank', { ascending: true, nullsFirst: false }).limit(ALTERNATIVES + 1)
  const attempts: (() => Db)[] = q.kind === 'rwa_id'
    ? [() => table().eq('rwa_id', q.value).limit(1)]
    : [
      () => ranked(table().ilike('symbol', q.value)),
      () => ranked(table().eq('slug', q.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))),
      () => ranked(table().ilike('name', q.value)),
      () => ranked(table().ilike('symbol', `${q.value}%`)),
      () => ranked(table().ilike('name', `${q.value}%`)),
    ]
  let failed = false
  for (const attempt of attempts) {
    const read = await rows(attempt)
    failed ||= read.failed
    if (read.rows.length) return { asset: read.rows[0], alternatives: read.rows.slice(1).map(assetRef), failed, catalogue: { count: null, capturedAt: null } }
  }
  // Nothing matched: say how large the catalogue we searched was, and when it
  // was last captured, so "not found" is a statement about a known list.
  const [count, newest] = await Promise.all([
    (async () => { try { const { count: n, error } = await db.from('intel_rwa_asset_profiles').select('rwa_id', { count: 'exact', head: true }); return error ? null : num(n) } catch { return null } })(),
    rows(() => db.from('intel_rwa_asset_profiles').select('captured_at').order('captured_at', { ascending: false }).limit(1)),
  ])
  return { asset: null, alternatives: [], failed: failed || newest.failed, catalogue: { count, capturedAt: iso(newest.rows[0]?.captured_at) } }
}

/** The capture run call that most plausibly wrote a stored row: the newest call
 * by that caller to that endpoint within an hour before the row's clock (and a
 * few minutes after, for rows stamped at run start). Only status, credits and
 * time leave this function. Null when the log no longer holds it. */
export async function captureCall(db: Db, caller: string, endpoint: string, at: string | null): Promise<{ status: number | null; credits: number | null; ts: string | null } | null> {
  if (!at) return null
  const t = Date.parse(at)
  const read = await rows(() => db.from('provider_call_logs').select('status_code,credits_or_cu,ts,cache_status')
    .eq('provider', 'coinmarketcap').eq('caller', caller).eq('endpoint', endpoint)
    .gte('ts', new Date(t - 3600_000).toISOString()).lte('ts', new Date(t + 600_000).toISOString())
    .order('ts', { ascending: false }).limit(10))
  const row = read.rows.find((r) => r?.cache_status === 'live') ?? read.rows[0]
  return row ? { status: num(row.status_code), credits: num(row.credits_or_cu), ts: iso(row.ts) } : null
}

// ─── The quote ───────────────────────────────────────────────────────────────

/** One rwaQuotes read in the free lane's shape (the transport result). */
export type QuoteReader = (plan: FreeRwaPlan) => Promise<ResearchSnapshot>

/** One asset of an rwaQuotes body, and its USD quote: the asset with this
 * rwa_id when one is named (a batched body carries many), else the first. */
export function quoteAsset(payload: unknown, rwaId?: string | null): { asset: Record<string, unknown>; quote: Record<string, unknown> | null } | null {
  // deno-lint-ignore no-explicit-any
  const data = (payload as any)?.data
  const list = Array.isArray(data?.rwa_assets) ? data.rwa_assets : Array.isArray(data) ? data : null
  const asset = rwaId ? list?.find((a: Record<string, unknown>) => a && String(a.rwa_id) === String(rwaId)) : list?.[0]
  if (!asset || typeof asset !== 'object') return null
  const quotes = Array.isArray(asset.quotes) ? asset.quotes : []
  return { asset, quote: quotes.find((q: Record<string, unknown>) => q?.symbol === 'USD') ?? quotes[0] ?? null }
}

/** The part of an rwaQuotes body worth keeping as the last good answer: the
 * asset, its quotes and up to WRAPPER_ROWS tokens. Prose never. */
export function quoteKeep(payload: unknown, rwaId?: string | null): Record<string, unknown> | null {
  const found = quoteAsset(payload, rwaId)
  if (!found) return null
  const { asset } = found
  const tokens = Array.isArray(asset.tokens) ? asset.tokens.slice(0, WRAPPER_ROWS) : []
  return { data: { rwa_assets: [{ rwa_id: asset.rwa_id, name: asset.name, slug: asset.slug, symbol: asset.symbol, quotes: asset.quotes ?? [], tokens }] } }
}

/** The newest last-good copy of this asset's quote. */
async function lastGood(db: Db, rwaId: string) {
  const read = await rows(() => db.from('intel_rwa_lookup_last_good').select('rwa_id,payload,fetched_at,http_status,credit_count,served_as').eq('rwa_id', rwaId).limit(1))
  return read.rows[0] ?? null
}

/** Keep this answer as the asset's last good copy. Best effort: the RPC only
 * ever moves a row forward in time, and a failure changes nothing visible. */
async function remember(db: Db, rwaId: string, payload: unknown, fetchedAt: string | null, httpStatus: number | null, creditCount: number | null, served: string) {
  const keep = quoteKeep(payload, rwaId)
  if (!keep || !fetchedAt) return
  try { await db.rpc('intel_rwa_lookup_remember', { p_rwa_id: Number(rwaId), p_payload: keep, p_fetched_at: fetchedAt, p_http_status: httpStatus, p_credit_count: creditCount, p_served_as: served }) } catch { /* best effort */ }
}

// ─── The answer ──────────────────────────────────────────────────────────────

export interface LookupDeps {
  db: Db
  now?: () => number
  /** The free lane transport read, one pass per plan. `refreshBefore` (live
   * pass only): a shared copy fetched before it counts as past its window, so
   * the pass refreshes it (MarketAssetsContext.refreshBefore). */
  readQuote: (rwaId: string, opts?: { refreshBefore?: string | null }) => QuoteReader
  /** Claim one live read from the daily free budget. */
  claim: (rwaId: string) => Promise<FreeRwaClaim>
  /** The warm lane's newest finished run (loadWarmState). Optional: without it
   * there is no batched copy to consult and no recorded refusal to honour. */
  warm?: () => Promise<WarmState | null>
  /** The warm lane's batched rwaQuotes entry, cache only (never a call). */
  readBatch?: (ids: string) => Promise<ResearchSnapshot>
  /** Run bookkeeping after the answer is sent (EdgeRuntime.waitUntil in the
   * function). Absent, it is awaited in line, which is what the tests rely on. */
  defer?: (work: Promise<unknown>) => void
}

/** Bookkeeping that must never delay or fail an answer. */
async function later(deps: { defer?: (work: Promise<unknown>) => void }, work: () => Promise<unknown>): Promise<void> {
  const run = (async () => { try { await work() } catch { /* best effort */ } })()
  if (deps.defer) { try { deps.defer(run) } catch { await run } return }
  await run
}

/** The warm state, never a failure: an unreadable run log is simply none. */
async function warmState(deps: { warm?: () => Promise<WarmState | null> }): Promise<WarmState | null> {
  if (!deps.warm) return null
  try { return await deps.warm() } catch { return null }
}
/** The batched entry's id list when it carries this asset, else null. */
const batchFor = (warm: WarmState | null, rwaId: string): string | null =>
  warm?.batchIds && warm.batchIds.split(',').includes(rwaId) ? warm.batchIds : null

const quoteFigure = (q: Record<string, unknown> | null) => q ? {
  averageTokenizedPrice: num(q.average_tokenized_price), tokenizedMarketCap: num(q.tokenized_market_cap),
  tokenizedVolume24h: num(q.tokenized_volume_24h), lastUpdated: iso(q.last_updated),
} : null

/** Whether a live read may be attempted: false, or a gate asked only at the
 * moment a live read would be made (the per-IP allowances). A gate may say why
 * it is closed; a bare false is the hourly per-IP allowance. */
export type GateVerdict = boolean | { ok: boolean; reason?: string | null }
export type LiveGate = boolean | (() => Promise<GateVerdict>)
export const IP_LIVE_LIMIT_REASON = 'free_rwa_ip_hourly_limit'

/** The daily budget claim behind the per-IP gate: the gate first, so an
 * address over its allowance never touches the shared budget. */
function gatedClaim(gate: LiveGate, claim: () => Promise<FreeRwaClaim>, closedReason = IP_LIVE_LIMIT_REASON): () => Promise<FreeRwaClaim> {
  return async () => {
    const verdict: GateVerdict = typeof gate === 'function' ? await gate().catch(() => false) : gate
    const open = typeof verdict === 'object' && verdict ? verdict.ok === true : verdict === true
    const reason = typeof verdict === 'object' && verdict && verdict.reason ? verdict.reason : closedReason
    return open ? claim() : { allowed: false, reason, cap: null, used: null }
  }
}

// ─── Live or stored: the one rule, stated with every answer ─────────────────
//
// Reviewers of the demo read "Live lookup" and saw a shared-cache answer every
// time. The lookup now makes ONE real /v5 quotes call whenever the copy it holds
// might be older than CoinMarketCap's newest data, and otherwise answers from
// the store and says so, with CoinMarketCap's own last_updated beside it.
//
// HOW OFTEN COINMARKETCAP UPDATES AN RWA QUOTE. Measured, not assumed: every
// live /v5/real-world-assets/quotes/latest call in the shared cache on 23 and 24
// Sep 2026 carried a quotes[].last_updated one to two minutes before the call
// (fetched 01:14:01 → 01:11:59, 23:15:03 → 23:13:59, 20:47:02 → 20:45:01,
// 16:23:25 → 16:21:59, 14:46:20 → 14:44:59, 02:47:01 → 02:45:59 UTC). The
// "twice a day, 08:45:59 and 20:45:59" pattern on the wrapper board is our own:
// the six-hourly wrapper lane reads a shared copy whose stale_until is exactly
// six hours after its fetch, so every other run is served the previous run's
// copy while the transport refreshes it in the background (the 14:00 capture
// stored 08:45:59 prices, while the call its run triggered at 14:47:01 got
// fresh ones). So no RWA quote here has a known slower cadence, and the rule
// is the short age limit: a copy retrieved more than LOOKUP_LIVE_AFTER_MS ago
// is refreshed by one call. A cadence of fixed daily slots is still supported
// (decideQuoteRead, `slotsUtc`), so a measured slot schedule is a one-line
// change, but none is claimed without evidence.

/** A stored quote retrieved longer ago than this is refreshed by one live call. */
export const LOOKUP_LIVE_AFTER_MS = 10 * 60_000
export interface QuoteCadence {
  /** Daily UTC times ('HH:MM' or 'HH:MM:SS') at which the provider publishes, or
   *  null when it updates continuously as far as we have measured. */
  slotsUtc: readonly string[] | null
  liveAfterMs: number
}
export const RWA_QUOTE_CADENCE: QuoteCadence = { slotsUtc: null, liveAfterMs: LOOKUP_LIVE_AFTER_MS }
export const CHECK_LIMIT_REASON = 'lookup_check_daily_limit'
/** A live pass that found a copy another request had just fetched. */
export const CONCURRENT_REASON = 'refreshed_concurrently'

export type QuoteReadWhy = 'asked' | 'no_copy' | 'copy_older_than_limit' | 'cmc_update_due' | 'copy_recent' | 'cmc_not_updated_since'
export interface QuoteDecision { mode: 'live' | 'stored'; why: QuoteReadWhy; expectedUpdateAt: string | null }

/** The newest daily slot at or before `now`, as epoch ms, or null. */
export function newestSlotBefore(slotsUtc: readonly string[], now: number): number | null {
  const day = Math.floor(now / 86_400_000) * 86_400_000
  let best: number | null = null
  for (const slot of slotsUtc) {
    const m = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(slot)
    if (!m) continue
    const offset = ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3] ?? 0)) * 1000
    for (const at of [day + offset, day - 86_400_000 + offset]) if (at <= now && (best == null || at > best)) best = at
  }
  return best
}

/** Live or stored, for the copy in hand. Pure.
 *   asked                  the visitor pressed "Check CoinMarketCap now"
 *   no_copy                nothing usable is held
 *   cmc_update_due         (slot cadence) the copy's last_updated is before the
 *                          newest slot, so the provider has newer prices
 *   cmc_not_updated_since  (slot cadence) it is not: a call would return the same
 *   copy_older_than_limit  retrieved more than liveAfterMs ago
 *   copy_recent            retrieved inside liveAfterMs */
export function decideQuoteRead(input: { retrievedAt: string | null; sourceUpdatedAt: string | null; now: number; asked?: boolean; cadence?: QuoteCadence }): QuoteDecision {
  const cadence = input.cadence ?? RWA_QUOTE_CADENCE
  const retrieved = Date.parse(String(input.retrievedAt ?? ''))
  const updated = Date.parse(String(input.sourceUpdatedAt ?? ''))
  const slot = cadence.slotsUtc?.length ? newestSlotBefore(cadence.slotsUtc, input.now) : null
  const expectedUpdateAt = slot == null ? null : new Date(slot).toISOString()
  if (input.asked) return { mode: 'live', why: 'asked', expectedUpdateAt }
  if (!Number.isFinite(retrieved)) return { mode: 'live', why: 'no_copy', expectedUpdateAt }
  if (slot != null && Number.isFinite(updated)) {
    return updated >= slot ? { mode: 'stored', why: 'cmc_not_updated_since', expectedUpdateAt } : { mode: 'live', why: 'cmc_update_due', expectedUpdateAt }
  }
  return input.now - retrieved > cadence.liveAfterMs
    ? { mode: 'live', why: 'copy_older_than_limit', expectedUpdateAt }
    : { mode: 'stored', why: 'copy_recent', expectedUpdateAt }
}

const snapFetchedAt = (s: ResearchSnapshot | null): string | null => iso(s?.provenance?.fetchedAt ?? s?.receipt?.fetchedAt)
const snapUpdatedAt = (s: ResearchSnapshot | null, rwaId: string): string | null => {
  if (!s || !freeRwaSnapshotUsable(s)) return null
  const q = quoteAsset(s.payload, rwaId)?.quote
  return iso(q?.last_updated)
}

export interface QuoteReadOutcome { snap: ResearchSnapshot; decision: QuoteDecision; refusal: string | null }

/** This asset's quote for one lookup: the newest shared copy (this asset's own,
 * or the warm lane's batched one), then the rule above, then, when it says
 * live, ONE call through every gate (the per-IP allowance, the daily
 * allowance, a recorded plan refusal, the free RWA budget), made through the
 * governed transport. Every refusal serves the newest copy with its reason. */
export async function readLookupQuote(deps: LookupDeps, rwaId: string, live: LiveGate, now: number, opts: { asked?: boolean; warmP?: Promise<WarmState | null> } = {}): Promise<QuoteReadOutcome> {
  const asked = opts.asked === true
  const warmP = opts.warmP ?? warmState(deps)
  const lane = (snapshot: ResearchSnapshot, extra: Record<string, unknown>) => ({
    ...snapshot, freeShared: { lane: 'rwa_research', ...extra },
    refreshPolicy: { enabled: false, cacheReadSeconds: null, providerRefreshSeconds: null },
  })
  const decide = (s: ResearchSnapshot | null) => decideQuoteRead({ retrievedAt: s && freeRwaSnapshotUsable(s) ? snapFetchedAt(s) : null, sourceUpdatedAt: snapUpdatedAt(s, rwaId), now, asked })
  const shared = await deps.readQuote(rwaId)('shared-cache')
  let best: ResearchSnapshot | null = freeRwaSnapshotUsable(shared) ? shared : null
  let decision = decide(best)
  // The warm lane's batched copy can be newer than this asset's own. It is only
  // asked when this asset's copy would not answer on its own.
  if (!(decision.mode === 'stored' && freeRwaInWindow(best)) && deps.readBatch) {
    let alt: ResearchSnapshot | null = null
    try {
      const batchIds = batchFor(await warmP, rwaId)
      if (batchIds) {
        const r = await deps.readBatch(batchIds)
        alt = r && quoteAsset(r.payload, rwaId) ? { ...r, warmBatch: { ids: batchIds, size: batchIds.split(',').length } } : null
      }
    } catch { alt = null }
    best = newestUsable(shared, alt)
    decision = decide(best)
  }
  const keep = (reason: string | null): QuoteReadOutcome => ({
    snap: best ? lane(best, { served: 'shared-cache', reason }) : lane(shared, { served: 'retained', reason }), decision, refusal: reason,
  })
  if (decision.mode === 'stored') return { snap: lane(best!, { served: 'shared-cache' }), decision, refusal: null }
  if (live === false) return keep('free_rwa_background_read')
  if (shared.state === 'unsupported') return { snap: lane(shared, { served: 'retained', reason: shared.reason ?? 'unsupported_capability' }), decision, refusal: shared.reason ?? 'unsupported_capability' }
  let blocked: string | null = null
  try { blocked = warmPlanRefusal(await warmP, now) } catch { blocked = null }
  if (blocked) return keep(blocked)
  const granted = await gatedClaim(live, () => deps.claim(rwaId), asked ? CHECK_LIMIT_REASON : IP_LIVE_LIMIT_REASON)()
  if (!granted.allowed) return keep(granted.reason ?? 'live_read_unavailable')
  // The rule's own age limit lets a copy another visitor fetched a moment ago
  // answer without a second call; a visitor's check always asks the provider.
  const refreshBefore = new Date(decision.why === 'copy_older_than_limit' ? now - RWA_QUOTE_CADENCE.liveAfterMs : now).toISOString()
  const read = await deps.readQuote(rwaId, { refreshBefore })('shared-live')
  if (read.state === 'fresh') return { snap: lane(read, { served: 'shared-live' }), decision, refusal: null }
  if (freeRwaInWindow(read)) return { snap: lane(read, { served: 'shared-cache' }), decision, refusal: CONCURRENT_REASON }
  const reason = read.reason ?? 'live_read_unavailable'
  const after = newestUsable(read, best)
  return { snap: after ? lane(after, { served: 'shared-cache', reason }) : lane(read, { served: 'retained', reason }), decision, refusal: reason }
}

/** What answered the quote for THIS request, in the words the page states
 * beside it. Recomputed every time an answer is served. */
export function quoteReadOf(outcome: QuoteReadOutcome | null, quote: { value: ReturnType<typeof quoteFigure>; receipt: FigureReceipt } | null, asked: boolean) {
  const live = quote?.receipt?.served === 'live'
  return {
    mode: live ? 'live' as const : 'stored' as const,
    why: outcome?.decision.why ?? null,
    asked,
    refusal: live ? null : (outcome?.refusal ?? null),
    retrievedAt: quote?.receipt?.capturedAt ?? null,
    sourceUpdatedAt: quote?.value?.lastUpdated ?? null,
    served: quote?.receipt?.served ?? null,
    liveAfterSeconds: Math.round(RWA_QUOTE_CADENCE.liveAfterMs / 1000),
    expectedUpdateAt: outcome?.decision.expectedUpdateAt ?? null,
  }
}

/** The quote figure (and the wrapper tokens it carries) from a usable snapshot. */
function quoteFromSnapshot(snap: ResearchSnapshot, rwaId: string, now: number): { quote: { value: ReturnType<typeof quoteFigure>; receipt: FigureReceipt }; tokens: Record<string, unknown>[]; payload: unknown } | null {
  if (!freeRwaSnapshotUsable(snap) || !quoteAsset(snap.payload, rwaId)) return null
  const laneReason: string | null = snap?.freeShared?.reason ?? snap?.reason ?? null
  const r = snap.receipt || {}
  const served: Served = r.origin === 'live' ? 'live' : 'cache'
  const found = quoteAsset(snap.payload, rwaId)!
  const batch = snap.warmBatch && typeof snap.warmBatch === 'object' && typeof snap.warmBatch.ids === 'string' ? snap.warmBatch as { ids: string; size: number } : null
  const stale = served === 'cache' && snap.state === 'stale'
  // The provider's own status block leads the raw excerpt (timestamp,
  // error_code, credit_count), and a cache hit names the original call's charge.
  const status = snap.payload && typeof snap.payload === 'object' ? (snap.payload as { status?: unknown }).status : undefined
  const rc = receipt({ capability: 'rwaQuotes', params: batch ? { rwa_id: batch.ids } : { rwa_id: rwaId }, served, capturedAt: r.fetchedAt ?? snap.provenance?.fetchedAt, now, httpStatus: r.httpStatus, creditCount: r.creditCount,
    raw: { ...(status && typeof status === 'object' ? { status } : {}), ...quoteKeep(snap.payload, rwaId) },
    // Past its window still says so, and says why this lookup did not refresh it.
    reason: stale ? 'shared_cache_past_refresh' : null, refreshReason: stale ? laneReason : null, batchSize: batch?.size ?? null,
    ...(served === 'cache' ? { originCreditCount: r.proof?.creditCount ?? null } : {}) })
  return { quote: { value: quoteFigure(found.quote), receipt: rc }, tokens: Array.isArray(found.asset.tokens) ? found.asset.tokens : [], payload: snap.payload }
}

/** The wrapper rows: the quote's (or the capture's) tokens, with the capture
 * hour's premium per token. Derivative prices are listed after the wrappers. */
function wrapperRows(tokens: Record<string, unknown>[], premiumByToken: Map<string, Record<string, unknown>>) {
  return tokens.slice(0, WRAPPER_ROWS).map((t) => {
    const id = String(t.crypto_id ?? '')
    const cap = premiumByToken.get(id)
    return {
      cryptoId: /^[1-9][0-9]{0,11}$/.test(id) ? id : null, symbol: str(t.symbol, 40), name: str(t.name), issuerName: str(t.issuer_name),
      price: num(t.price), marketCap: num(t.market_cap), volume24h: num(t.volume_24h),
      // The premium is the capture hour's measurement, never recomputed here
      // against a price from another clock.
      premiumBps: cap ? num(cap.premium_bps) : null, wrapperState: cap ? str(cap.wrapper_state, 40) : null,
      // A derivative price (issuer "NA (Derivatives)") is not a wrapper anyone
      // holds: flagged here and listed after the wrappers, never dropped.
      derivative: isDerivativeReference({ issuerId: t.issuer_id, issuerName: t.issuer_name, name: t.name }) || cap?.wrapper_state === 'derivative_reference',
    }
  }).sort((x, y) => Number(x.derivative) - Number(y.derivative))
}

/** Answer one parsed query. `asked`: the visitor pressed "Check CoinMarketCap
 * now", so the quote is read live whatever its age (still through every gate). */
export async function lookupRwa(deps: LookupDeps, q: LookupQuery, live: LiveGate, timer: PhaseTimer = NO_TIMER, opts: { asked?: boolean } = {}) {
  const asked = opts.asked === true
  const now = (deps.now ?? Date.now)()
  const db = deps.db
  const servedAt = new Date(now).toISOString()
  const base = { version: LOOKUP_VERSION, query: q.text, servedAt, attribution: ATTRIBUTION, provider: 'coinmarketcap' }
  // The warm lane's state names no asset, so it is read beside the resolution.
  const warmP = timer.time('warm_state', () => warmState(deps))
  const resolved = await timer.time('resolve', () => resolveRwa(db, q))
  if (!resolved.asset) {
    const nothing = resolved.failed && resolved.catalogue.count == null
    return {
      ...base, state: nothing ? 'unavailable' : 'not_found', asset: null, alternatives: [],
      reason: nothing ? 'catalogue_unavailable' : 'no_rwa_match',
      catalogue: { ...resolved.catalogue, capability: 'rwaInfo', endpoint: CMC_CAPABILITIES.rwaInfo.path },
      figures: null,
    }
  }
  const p = resolved.asset as Record<string, unknown>
  const rwaId = String(p.rwa_id)
  const params = { rwa_id: rwaId }

  // Identity: the stored rwaInfo capture.
  const identityCapability = typeof p.provider_capability === 'string' && CMC_CAPABILITIES[p.provider_capability] ? p.provider_capability : 'rwaInfo'
  const identityClock = iso(p.provider_fetched_at) ?? iso(p.captured_at)
  // Everything below needs only the rwa_id, so it is all read at once: the
  // identity call log, the wrapper and coverage captures, the quote, and (as
  // soon as the wrapper capture names its hour) that hour's wrapper rows and
  // call log. Nothing is read that the sequential version did not read.
  const wrapperAssetP = rows(() => db.from('intel_rwa_wrapper_assets').select('rwa_id,captured_at,fetched_at,anchor_kind,anchor_price,anchor_observed_at,anchor_reason,anchor_members,wrapper_count,liquid_count,widest_premium_bps,widest_discount_bps,dispersion_bps,weighted_spread_bps,cheapest_premium_bps,average_tokenized_price,tokenized_market_cap,tokenized_volume_24h,source_observed_at,scope')
    .eq('rwa_id', rwaId).order('captured_at', { ascending: false }).limit(1))
  const wrapperHourP = timer.time('wrappers', async () => {
    const w = (await wrapperAssetP).rows[0] ?? null
    if (!w) return null
    const [tokens, call] = await Promise.all([
      rows(() => db.from('intel_rwa_wrapper_tokens').select('crypto_id,symbol,name,issuer_name,price,normalised_price,market_cap,volume_24h,wrapper_state,premium_bps,accrual_gap_bps,in_anchor,state_reason')
        .eq('rwa_id', rwaId).eq('captured_at', w.captured_at).order('market_cap', { ascending: false, nullsFirst: false }).limit(WRAPPER_ROWS)),
      captureCall(db, 'intel-capture-rwa-wrappers', CMC_CAPABILITIES.rwaQuotes.path, iso(w.fetched_at) ?? iso(w.captured_at)),
    ])
    return { tokens, call }
  })
  // The quote: the newest shared copy (this asset's own, or the warm lane's
  // batched one), and ONE live call when the rule above says the copy may be
  // older than CoinMarketCap's newest data; then the newest copy with the
  // reason; then our last good copy, then the stored captures. Each step says
  // which it was. The warm state is awaited only by the steps that need it, so
  // the shared copy is read without waiting for it.
  const outcomeP = timer.time('quote', () => readLookupQuote(deps, rwaId, live, now, { asked, warmP }))
  const [identityCall, wrapperAsset, coverage, outcome, wrapperHour] = await Promise.all([
    timer.time('identity_log', () => captureCall(db, 'intel-capture-rwa-asset-profiles', CMC_CAPABILITIES[identityCapability].path, identityClock)),
    wrapperAssetP,
    timer.time('coverage', () => rows(() => db.from('intel_rwa_coverage_assets').select('rwa_id,snapshot_date,token_count,priced_count,traded_count,coverage_state,tokenized_market_cap,tokenized_volume_24h,source_observed_at,captured_at,fetched_at')
      .eq('rwa_id', rwaId).order('captured_at', { ascending: false }).limit(1))),
    outcomeP,
    wrapperHourP,
  ])
  const snap = outcome.snap
  const identity = {
    value: { rwaId, symbol: str(p.symbol, 40), name: str(p.name), slug: str(p.slug, 120), assetType: str(p.asset_type, 40), rank: num(p.rwa_rank), hasTokens: typeof p.has_tokens === 'boolean' ? p.has_tokens : null, website: str(p.website, 300), primaryExchange: str(p.primary_exchange, 80), industry: str(p.industry, 120), logoUrl: /^https:\/\//.test(String(p.logo_url || '')) ? String(p.logo_url) : null },
    receipt: receipt({ capability: identityCapability, params, served: 'capture', capturedAt: identityClock, now, httpStatus: identityCall?.status, creditCount: identityCall?.credits, raw: { ...p, logo_url: undefined }, caller: 'intel-capture-rwa-asset-profiles', reason: identityCall ? null : 'call_log_not_retained' }),
  }

  const laneReason: string | null = snap?.freeShared?.reason ?? snap?.reason ?? null
  let quote: { value: ReturnType<typeof quoteFigure>; receipt: FigureReceipt } | null = null
  let tokensSource: { tokens: Record<string, unknown>[]; receipt: FigureReceipt } | null = null
  const fromSnap = quoteFromSnapshot(snap, rwaId, now)
  if (fromSnap) {
    const rc = fromSnap.quote.receipt
    quote = fromSnap.quote
    tokensSource = { tokens: fromSnap.tokens, receipt: rc }
    // Keeping the last good copy is bookkeeping: it happens after the answer.
    await later(deps, () => remember(db, rwaId, fromSnap.payload, rc.capturedAt, rc.httpStatus, rc.creditCount ?? rc.originCreditCount ?? null, rc.served))
  } else {
    const kept = await lastGood(db, rwaId)
    const found = kept ? quoteAsset(kept.payload) : null
    if (kept && found) {
      const rc = receipt({ capability: 'rwaQuotes', params, served: 'retained', capturedAt: kept.fetched_at, now, httpStatus: kept.http_status, creditCount: kept.credit_count, raw: kept.payload, reason: laneReason ?? 'live_read_unavailable' })
      quote = { value: quoteFigure(found.quote), receipt: rc }
      tokensSource = { tokens: Array.isArray(found.asset.tokens) ? found.asset.tokens : [], receipt: rc }
    }
  }
  const w = wrapperAsset.rows[0] ?? null
  const c = coverage.rows[0] ?? null
  if (!quote) {
    // The stored captures: the wrapper lane holds a tokenised price; the daily
    // coverage lane holds tokenised value and volume for every listed asset.
    const pick = w && (!c || Date.parse(w.captured_at) >= Date.parse(c.captured_at)) ? 'wrappers' : c ? 'coverage' : null
    if (pick) {
      const row = pick === 'wrappers' ? w : c
      const caller = pick === 'wrappers' ? 'intel-capture-rwa-wrappers' : 'intel-capture-rwa-coverage'
      const call = await captureCall(db, caller, CMC_CAPABILITIES.rwaQuotes.path, iso(row.fetched_at) ?? iso(row.captured_at))
      quote = {
        value: { averageTokenizedPrice: num(row.average_tokenized_price), tokenizedMarketCap: num(row.tokenized_market_cap), tokenizedVolume24h: num(row.tokenized_volume_24h), lastUpdated: iso(row.source_observed_at) },
        receipt: receipt({ capability: 'rwaQuotes', params, served: 'capture', capturedAt: row.captured_at, now, httpStatus: call?.status, creditCount: call?.credits, raw: row, caller, reason: laneReason ?? 'live_read_unavailable' }),
      }
    }
  }

  // Wrappers and the premium: the newest wrapper capture hour for this asset.
  let premium = null
  const premiumByToken = new Map<string, Record<string, unknown>>()
  if (w && wrapperHour) {
    const { tokens, call } = wrapperHour
    for (const t of tokens.rows) premiumByToken.set(String(t.crypto_id), t)
    const pr = receipt({ capability: 'rwaQuotes', params, served: 'capture', capturedAt: w.captured_at, now, httpStatus: call?.status, creditCount: call?.credits, raw: { asset: w, tokens: tokens.rows }, caller: 'intel-capture-rwa-wrappers', reason: tokens.failed ? 'wrapper_rows_unavailable' : null })
    premium = {
      value: {
        anchorKind: str(w.anchor_kind, 40), anchorPrice: num(w.anchor_price), anchorObservedAt: iso(w.anchor_observed_at), anchorReason: str(w.anchor_reason),
        wrapperCount: num(w.wrapper_count), liquidCount: num(w.liquid_count),
        widestPremiumBps: num(w.widest_premium_bps), widestDiscountBps: num(w.widest_discount_bps), dispersionBps: num(w.dispersion_bps), weightedSpreadBps: num(w.weighted_spread_bps),
      },
      receipt: pr,
    }
    if (!tokensSource && tokens.rows.length) tokensSource = { tokens: tokens.rows, receipt: pr }
  }
  const wrappers = tokensSource ? { value: wrapperRows(tokensSource.tokens, premiumByToken), receipt: tokensSource.receipt } : null

  const state = quote ? 'found' : 'found_without_quote'
  return {
    ...base, state, reason: quote ? null : (laneReason ?? 'no_quote_captured'),
    asset: identity.value, alternatives: resolved.alternatives, catalogue: null,
    coverage: c ? { tokenCount: num(c.token_count), pricedCount: num(c.priced_count), tradedCount: num(c.traded_count), coverageState: str(c.coverage_state, 40), capturedAt: iso(c.captured_at) } : null,
    figures: { identity, quote, wrappers, premium },
    // What answered the quote for THIS request, stated beside it on the page.
    quoteRead: quoteReadOf(outcome, quote, asked),
  }
}

/** A kept answer with the quote this request read put in: the quote figure, and
 * the wrapper rows its tokens carry, with the capture hour's premium per token
 * taken from the kept rows (premiums are never recomputed against a new price).
 * Nothing usable read: the kept quote stays, and the request's reason is said. */
export function spliceQuote(body: Record<string, unknown>, outcome: QuoteReadOutcome, rwaId: string, now: number, asked: boolean): { body: Record<string, unknown>; changed: boolean; payload: unknown } {
  // deno-lint-ignore no-explicit-any
  const figures = { ...((body.figures && typeof body.figures === 'object' ? body.figures : {}) as Record<string, any>) }
  const built = quoteFromSnapshot(outcome.snap, rwaId, now)
  if (!built) return { body: { ...body, quoteRead: quoteReadOf(outcome, figures.quote ?? null, asked) }, changed: false, payload: null }
  const premiumByToken = new Map<string, Record<string, unknown>>()
  for (const w of Array.isArray(figures.wrappers?.value) ? figures.wrappers.value : []) {
    if (w?.cryptoId) premiumByToken.set(String(w.cryptoId), { premium_bps: w.premiumBps, wrapper_state: w.wrapperState })
  }
  figures.quote = built.quote
  if (built.tokens.length) figures.wrappers = { value: wrapperRows(built.tokens, premiumByToken), receipt: built.quote.receipt }
  const changed = built.quote.receipt.served === 'live' || built.quote.receipt.capturedAt !== (body.figures as { quote?: { receipt?: { capturedAt?: unknown } } } | null)?.quote?.receipt?.capturedAt
  return { body: { ...body, state: 'found', reason: null, figures, quoteRead: quoteReadOf(outcome, built.quote, asked) }, changed, payload: built.payload }
}

// ─── The stored answer: serve the finished answer first, refresh behind it ───
//
// A lookup is a dozen database reads. Under load (23 Sep, while the hourly
// derived-market job ran) that was 15 seconds for SGOV, and a visitor clicking a
// suggested ticker waited the whole time for figures that were all stored rows
// or shared-cache copies anyway. So the finished answer for each query is kept
// (public.intel_rwa_lookup_answers). The next visitor for that query is served
// it at once, re-aged to now, and a fresh answer is assembled behind it:
//
//   * younger than ANSWER_REFRESH_MS: served as it is, nothing rebuilt;
//   * younger than ANSWER_SERVE_MAX_MS: served, and rebuilt after the response
//     (EdgeRuntime.waitUntil) through exactly the gates a lookup passes;
//   * older, or none: assembled now, then kept.
//
// Nothing is passed off as newer than it is. Each figure keeps its own capture
// time, and its age is recomputed at the moment of serving. A figure whose
// receipt said a live call answered it says, when served again, that no call
// was made for THIS lookup, with the original call's charge named as the
// origin's (the same rule the shared cache follows). The body says it is a
// stored answer, when it was assembled and whether a newer one is on its way.

export const ANSWER_REFRESH_MS = 60_000
export const ANSWER_SERVE_MAX_MS = 15 * 60_000

export interface StoredAnswer { body: Record<string, unknown>; builtAt: string }
export interface AnswerStore {
  read: (key: string) => Promise<StoredAnswer | null>
  keep: (key: string, rwaId: string | null, body: Record<string, unknown>, builtAt: string) => Promise<void>
}

/** The stored answer's key: the rwa_id, or the query text in lower case. */
export const answerKey = (q: LookupQuery): string => q.kind === 'rwa_id' ? `id:${q.value}` : `q:${q.value.toLowerCase()}`

const STORABLE = new Set(['found', 'found_without_quote'])

/** One figure receipt, served again now. */
export function reservedReceipt(r: FigureReceipt, now: number): FigureReceipt {
  const ageSeconds = age(r.capturedAt, now)
  if (r.served !== 'live') return { ...r, ageSeconds }
  return { ...r, served: 'cache', ageSeconds, originCreditCount: r.creditCount ?? null, creditCount: null, curlMeaning: r.curl ? 'same_request' : null }
}

/** A kept answer, as it is served now. */
export function reserveAnswer(body: Record<string, unknown>, builtAt: string, now: number, refreshing: boolean): Record<string, unknown> {
  // deno-lint-ignore no-explicit-any
  const figures = (body.figures && typeof body.figures === 'object' ? body.figures : {}) as Record<string, any>
  const out: Record<string, unknown> = {}
  for (const [name, figure] of Object.entries(figures)) {
    out[name] = figure && typeof figure === 'object' && figure.receipt ? { ...figure, receipt: reservedReceipt(figure.receipt, now) } : figure
  }
  return {
    ...body, servedAt: new Date(now).toISOString(), figures: out,
    stored: { builtAt: iso(builtAt), ageSeconds: age(iso(builtAt), now), refreshing },
  }
}

/** A lookup, served from the kept answer when there is a young enough one.
 *
 * The kept answer is re-judged on every request by the live rule
 * (decideQuoteRead on its quote's retrieval time and CoinMarketCap's
 * last_updated). While the rule says stored, the answer is served at once, as
 * before, and says so. When it says live (or the visitor asked), this request
 * reads the quote through readLookupQuote (one call, every gate) and the result
 * is put into the kept answer; the rest of the answer is stored capture rows
 * that no call would change. A rebuild behind the answer never calls the
 * provider: a live call is only ever made for a request that shows its receipt. */
export async function answerLookup(deps: LookupDeps & { answers?: AnswerStore | null }, q: LookupQuery, live: LiveGate, timer: PhaseTimer = NO_TIMER, opts: { asked?: boolean } = {}) {
  const asked = opts.asked === true
  const store = deps.answers
  if (!store) return lookupRwa(deps, q, live, timer, { asked })
  const key = answerKey(q)
  const keep = (body: Record<string, unknown>) => STORABLE.has(String(body.state)) && typeof body.servedAt === 'string'
    ? store.keep(key, (body.asset as { rwaId?: string } | null)?.rwaId ?? null, body, body.servedAt)
    : Promise.resolve()
  const kept = await timer.time('stored_answer', () => store.read(key).catch(() => null))
  const now = (deps.now ?? Date.now)()
  const built = kept ? Date.parse(kept.builtAt) : NaN
  const ageMs = Number.isFinite(built) ? now - built : Infinity
  if (kept && kept.body && STORABLE.has(String(kept.body.state)) && ageMs >= -60_000 && ageMs <= ANSWER_SERVE_MAX_MS) {
    const refreshing = ageMs >= ANSWER_REFRESH_MS
    const rebuild = () => later(deps, async () => keep(await lookupRwa(deps, q, false)))
    const served = reserveAnswer(kept.body, kept.builtAt, now, refreshing)
    // deno-lint-ignore no-explicit-any
    const keptQuote = (kept.body.figures as Record<string, any> | null)?.quote ?? null
    const rwaId = (kept.body.asset as { rwaId?: unknown } | null)?.rwaId
    const decision = decideQuoteRead({ retrievedAt: keptQuote?.receipt?.capturedAt ?? null, sourceUpdatedAt: keptQuote?.value?.lastUpdated ?? null, now, asked })
    if (decision.mode === 'stored' || typeof rwaId !== 'string' || !/^[1-9][0-9]{0,11}$/.test(rwaId)) {
      if (refreshing) await rebuild()
      // deno-lint-ignore no-explicit-any
      return { ...served, quoteRead: quoteReadOf({ snap: {}, decision, refusal: null }, (served.figures as Record<string, any>)?.quote ?? null, asked) }
    }
    const outcome = await timer.time('live_quote', () => readLookupQuote(deps, rwaId, live, now, { asked }))
    const spliced = spliceQuote(served, outcome, rwaId, now, asked)
    if (spliced.changed) {
      // deno-lint-ignore no-explicit-any
      const rc = (spliced.body.figures as Record<string, any>).quote.receipt as FigureReceipt
      await later(deps, () => remember(deps.db, rwaId, spliced.payload, rc.capturedAt, rc.httpStatus, rc.creditCount ?? rc.originCreditCount ?? null, rc.served))
    }
    // A newer quote is a newer answer: assembled behind this one and kept.
    if (spliced.changed || refreshing) await rebuild()
    return spliced.body
  }
  const body = await lookupRwa(deps, q, live, timer, { asked }) as Record<string, unknown>
  await later(deps, () => keep(body))
  return body
}

/** Replace every occurrence of a secret in a serialised body. The lookup never
 * puts the key anywhere, and this is the check that keeps it that way. */
export function scrubSecrets(text: string, secrets: (string | null | undefined)[]): string {
  let out = text
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join('[redacted]')
  return out
}

// ─── The research reads, as a free member gets them ──────────────────────────
//
// The same endpoint also answers the six real-world asset research reads the
// /intel/rwa workspace makes (rwaList, rwaInfo, rwaQuotes, rwaPairs, issuers,
// issuer) for a caller with no account, EXACTLY as intel-research answers a
// free member: researchParams validation, freeRwaRead over researchSnapshot
// (shared cache first, never a demand stamp, a live miss only on a granted
// intel_free_rwa_read_claim from the same 200 credit daily cmc_free_rwa_policy),
// and the same body shape. The only additions are the per-IP limits in the
// handler, and a kept last good body per (capability, params) so that a failed
// live miss after the plan change still answers with a dated copy and a reason.


export interface ResearchDeps {
  db: Db
  now?: () => number
  /** researchSnapshot(db, capability, params, null, undefined, undefined, false, plan) */
  readResearch: (capability: string, params: Record<string, string>) => (plan: FreeRwaPlan) => Promise<ResearchSnapshot>
  claimResearch: (capability: string, params: Record<string, string>) => Promise<FreeRwaClaim>
  /** research-service.ts researchParams: the same validation intel-research applies. */
  researchParams: (capability: string, input: unknown) => Record<string, string>
  /** The warm lane's newest finished run (loadWarmState). Optional. */
  warm?: () => Promise<WarmState | null>
  /** The warm lane's batched rwaQuotes entry as a research body, shared cache
   * only: researchSnapshot(db, 'rwaQuotes', { rwa_id: ids }, ..., 'shared-cache',
   * { repairRelationships: false }). Optional: without it no batch is consulted. */
  readBatchResearch?: (ids: string) => Promise<ResearchSnapshot>
  /** As LookupDeps.defer. */
  defer?: (work: Promise<unknown>) => void
}

/** One asset's part of the warm lane's batched rwaQuotes research body: the same
 * body intel-research builds, its rows narrowed to the asset asked for. The
 * receipt, provenance and source reference are the batched read's own, so the
 * drawer names the request that actually answered it. Null when unusable. */
export function batchResearchBody(body: ResearchSnapshot | null, rwaId: string, size: number): ResearchSnapshot | null {
  if (!body || !freeRwaSnapshotUsable(body)) return null
  const rows = Array.isArray(body.data?.rows) ? body.data.rows.filter((r: Record<string, unknown>) => String(r?.rwa_id) === rwaId) : []
  if (!rows.length) return null
  return { ...body, data: { ...body.data, rows, total: rows.length, hasMore: false }, warmBatch: { size, rwaId } }
}

export class ResearchRequestError extends Error {}

/** Validate a research request body: capability, params, readMode only. */
export function parseResearchRequest(body: Record<string, unknown>, researchParams: ResearchDeps['researchParams']) {
  const keys = Object.keys(body)
  if (keys.some((k) => !['capability', 'params', 'readMode'].includes(k))) throw new ResearchRequestError('invalid_request')
  const capability = typeof body.capability === 'string' ? body.capability : ''
  if (!FREE_CAPS.has(capability)) throw new ResearchRequestError('unsupported_capability')
  if (body.readMode != null && body.readMode !== 'retained') throw new ResearchRequestError('invalid_read_mode')
  let params: Record<string, string>
  try { params = researchParams(capability, body.params) } catch (e) { throw new ResearchRequestError((e as Error)?.message || 'invalid_parameters') }
  const paramsKey = JSON.stringify(params)
  if (paramsKey.length > 500) throw new ResearchRequestError('invalid_parameters')
  return { capability, params, paramsKey, cacheOnly: body.readMode === 'retained' }
}

const MAX_KEPT_BODY = 200_000

export async function researchRwa(deps: ResearchDeps, req: { capability: string; params: Record<string, string>; paramsKey: string; cacheOnly: boolean }, live: LiveGate) {
  const now = (deps.now ?? Date.now)()
  const { db, capability, params } = { db: deps.db, ...req }
  // A single-asset quote can also be answered by the warm lane's batched entry.
  // The warm state is read beside the shared copy and awaited only by the steps
  // that need it (the batch, and a known plan refusal before a live read).
  const warmP = warmState(deps)
  const single = capability === 'rwaQuotes' && /^[1-9][0-9]{0,11}$/.test(params.rwa_id ?? '') ? params.rwa_id : null
  const alternate = single && deps.readBatchResearch ? async () => {
    const batchIds = batchFor(await warmP, single)
    return batchIds ? batchResearchBody(await deps.readBatchResearch!(batchIds), single, batchIds.split(',').length) : null
  } : null
  const snap = await freeRwaReadFresh(deps.readResearch(capability, params), gatedClaim(live, () => deps.claimResearch(capability, params)), live !== false && !req.cacheOnly,
    { alternate, liveBlocked: async () => warmPlanRefusal(await warmP, now) })
  if (freeRwaSnapshotUsable(snap)) {
    const fetchedAt = iso(snap?.provenance?.fetchedAt) ?? iso(snap?.receipt?.fetchedAt)
    const text = JSON.stringify(snap)
    if (fetchedAt && text.length <= MAX_KEPT_BODY) {
      await later(deps, async () => {
        const { error } = await db.rpc('intel_rwa_lookup_research_remember', { p_capability: capability, p_params_key: req.paramsKey, p_body: snap, p_fetched_at: fetchedAt })
        if (error) throw new Error('research_remember_failed')
      })
    }
    return snap
  }
  // Nothing usable, and the lane said why. Serve the newest kept copy of this
  // exact read, dated, with that reason; only when none was ever kept does the
  // caller get the lane's own unavailable body (which carries the reason too).
  const reason: string | null = snap?.freeShared?.reason ?? snap?.reason ?? null
  const kept = await rows(() => db.from('intel_rwa_lookup_research_last_good').select('body,fetched_at').eq('capability', capability).eq('params_key', req.paramsKey).limit(1))
  const row = kept.rows[0]
  if (!row?.body || typeof row.body !== 'object') return snap
  const fetchedAt = iso(row.fetched_at)
  const ageSeconds = age(fetchedAt, now)
  const body = row.body as ResearchSnapshot
  return {
    ...body,
    state: 'stale',
    reason: reason ?? 'live_read_unavailable',
    // A kept copy is a stored copy: it made no call for this read, and its age is
    // measured now. The original HTTP status stays; the charge belonged to the
    // original call and is not claimed again here.
    receipt: body.receipt && typeof body.receipt === 'object' ? { ...body.receipt, origin: 'cache', creditCount: null, elapsedMs: null, reservation: null, cacheAgeSeconds: ageSeconds } : null,
    freeShared: { lane: 'rwa_research', served: 'retained', reason: reason ?? 'live_read_unavailable', keptAt: fetchedAt, ageSeconds },
    refreshPolicy: { enabled: false, cacheReadSeconds: null, providerRefreshSeconds: null },
  }
}
