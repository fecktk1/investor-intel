// Investor Intel: "Look up any tokenised asset, now".
//
// A PUBLIC, read-only answer for one real-world asset, by ticker, name or
// rwa_id, served by the intel-rwa-lookup Edge Function to anyone, signed in or
// not. It exists so a visitor (a hackathon judge on /intel/demo, or a member on
// /intel/rwa) can type a ticker and watch a real CoinMarketCap-backed answer
// arrive, with the proof for every figure beside it.
//
// WHAT IT SPENDS. Nothing per visitor, except one bounded case:
//
//   * Identity, wrappers and the premium against the anchor are STORED capture
//     rows (intel_rwa_asset_profiles, intel_rwa_wrapper_assets/_tokens,
//     intel_rwa_coverage_assets) that scheduled lanes already paid for. Reading
//     them is a database read.
//   * The latest quote goes through the same free lane as the free RWA research
//     surface (./rwa-free-read.ts): the shared response cache first with
//     maxCalls 0, never a demand stamp, and a live call only when the cache had
//     nothing usable AND intel_free_rwa_read_claim grants it from the daily
//     platform-wide budget in cmc_free_rwa_policy. The function adds a per-IP
//     hourly cap on top, so one visitor cannot spend the day's budget.
//   * KEPT INSIDE ITS WINDOW (freeRwaReadFresh). A shared copy past its one-hour
//     window is not simply served: the scheduled warm lane's ONE batched quotes
//     read of every judge-path asset answers first when it is inside its window
//     (capture-rwa-quote-warm.ts), with a receipt that names that batched
//     request; otherwise the copy is refreshed once, through the same per-IP and
//     daily gates as a miss. Only when that is refused does the old copy answer,
//     still saying it is past its window and why it was not refreshed.
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
import { freeRwaReadFresh, freeRwaSnapshotUsable, RWA_FREE_CAPABILITIES as FREE_CAPS, type FreeRwaClaim, type FreeRwaPlan, type ResearchSnapshot } from './rwa-free-read.ts'
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
  /** The free lane transport read, one pass per plan. */
  readQuote: (rwaId: string) => QuoteReader
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
 * moment of a shared-cache miss (the per-IP hourly allowance). */
export type LiveGate = boolean | (() => Promise<boolean>)
export const IP_LIVE_LIMIT_REASON = 'free_rwa_ip_hourly_limit'

/** The daily budget claim behind the per-IP gate: the gate first, so an
 * address over its hourly allowance never touches the shared budget. */
function gatedClaim(gate: LiveGate, claim: () => Promise<FreeRwaClaim>): () => Promise<FreeRwaClaim> {
  return async () => {
    const open = typeof gate === 'function' ? await gate().catch(() => false) : gate
    return open ? claim() : { allowed: false, reason: IP_LIVE_LIMIT_REASON, cap: null, used: null }
  }
}

/** Answer one parsed query. */
export async function lookupRwa(deps: LookupDeps, q: LookupQuery, live: LiveGate, timer: PhaseTimer = NO_TIMER) {
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
  // The quote: this asset's shared copy inside its window, then the warm lane's
  // batched copy inside its window, then one bounded live refresh, then the
  // newest copy with the reason; then our last good copy, then the stored
  // captures. Each step says which it was. The warm state is awaited only by
  // the steps that need it, so the shared copy is read without waiting for it.
  const snapP = timer.time('quote', () => {
    const alternate = deps.readBatch ? async () => {
      const batchIds = batchFor(await warmP, rwaId)
      if (!batchIds) return null
      const r = await deps.readBatch!(batchIds)
      return r && quoteAsset(r.payload, rwaId) ? { ...r, warmBatch: { ids: batchIds, size: batchIds.split(',').length } } : null
    } : null
    return freeRwaReadFresh(deps.readQuote(rwaId), gatedClaim(live, () => deps.claim(rwaId)), live !== false, { alternate, liveBlocked: async () => warmPlanRefusal(await warmP, now) })
  })
  const [identityCall, wrapperAsset, coverage, snap, wrapperHour] = await Promise.all([
    timer.time('identity_log', () => captureCall(db, 'intel-capture-rwa-asset-profiles', CMC_CAPABILITIES[identityCapability].path, identityClock)),
    wrapperAssetP,
    timer.time('coverage', () => rows(() => db.from('intel_rwa_coverage_assets').select('rwa_id,snapshot_date,token_count,priced_count,traded_count,coverage_state,tokenized_market_cap,tokenized_volume_24h,source_observed_at,captured_at,fetched_at')
      .eq('rwa_id', rwaId).order('captured_at', { ascending: false }).limit(1))),
    snapP,
    wrapperHourP,
  ])
  const identity = {
    value: { rwaId, symbol: str(p.symbol, 40), name: str(p.name), slug: str(p.slug, 120), assetType: str(p.asset_type, 40), rank: num(p.rwa_rank), hasTokens: typeof p.has_tokens === 'boolean' ? p.has_tokens : null, website: str(p.website, 300), primaryExchange: str(p.primary_exchange, 80), industry: str(p.industry, 120), logoUrl: /^https:\/\//.test(String(p.logo_url || '')) ? String(p.logo_url) : null },
    receipt: receipt({ capability: identityCapability, params, served: 'capture', capturedAt: identityClock, now, httpStatus: identityCall?.status, creditCount: identityCall?.credits, raw: { ...p, logo_url: undefined }, caller: 'intel-capture-rwa-asset-profiles', reason: identityCall ? null : 'call_log_not_retained' }),
  }

  const laneReason: string | null = snap?.freeShared?.reason ?? snap?.reason ?? null
  let quote: { value: ReturnType<typeof quoteFigure>; receipt: FigureReceipt } | null = null
  let tokensSource: { tokens: Record<string, unknown>[]; receipt: FigureReceipt } | null = null
  const usable = freeRwaSnapshotUsable(snap) && quoteAsset(snap.payload, rwaId)
  if (usable) {
    const r = snap.receipt || {}
    const served: Served = r.origin === 'live' ? 'live' : 'cache'
    const found = quoteAsset(snap.payload, rwaId)!
    const batch = snap.warmBatch && typeof snap.warmBatch === 'object' && typeof snap.warmBatch.ids === 'string' ? snap.warmBatch as { ids: string; size: number } : null
    const stale = served === 'cache' && snap.state === 'stale'
    // The provider's own status block leads the raw excerpt (timestamp,
    // error_code, credit_count), and a cache hit names the original call's charge.
    const status = snap.payload && typeof snap.payload === 'object' ? (snap.payload as { status?: unknown }).status : undefined
    const rc = receipt({ capability: 'rwaQuotes', params: batch ? { rwa_id: batch.ids } : params, served, capturedAt: r.fetchedAt ?? snap.provenance?.fetchedAt, now, httpStatus: r.httpStatus, creditCount: r.creditCount,
      raw: { ...(status && typeof status === 'object' ? { status } : {}), ...quoteKeep(snap.payload, rwaId) },
      // Past its window still says so, and says why this lookup did not refresh it.
      reason: stale ? 'shared_cache_past_refresh' : null, refreshReason: stale ? laneReason : null, batchSize: batch?.size ?? null,
      ...(served === 'cache' ? { originCreditCount: r.proof?.creditCount ?? null } : {}) })
    quote = { value: quoteFigure(found.quote), receipt: rc }
    tokensSource = { tokens: Array.isArray(found.asset.tokens) ? found.asset.tokens : [], receipt: rc }
    // Keeping the last good copy is bookkeeping: it happens after the answer.
    await later(deps, () => remember(db, rwaId, snap.payload, rc.capturedAt, rc.httpStatus, rc.creditCount ?? rc.originCreditCount ?? null, served))
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
  const wrappers = tokensSource ? {
    value: tokensSource.tokens.slice(0, WRAPPER_ROWS).map((t) => {
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
    }).sort((x, y) => Number(x.derivative) - Number(y.derivative)),
    receipt: tokensSource.receipt,
  } : null

  const state = quote ? 'found' : 'found_without_quote'
  return {
    ...base, state, reason: quote ? null : (laneReason ?? 'no_quote_captured'),
    asset: identity.value, alternatives: resolved.alternatives, catalogue: null,
    coverage: c ? { tokenCount: num(c.token_count), pricedCount: num(c.priced_count), tradedCount: num(c.traded_count), coverageState: str(c.coverage_state, 40), capturedAt: iso(c.captured_at) } : null,
    figures: { identity, quote, wrappers, premium },
  }
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

/** A lookup, served from the kept answer when there is a young enough one. */
export async function answerLookup(deps: LookupDeps & { answers?: AnswerStore | null }, q: LookupQuery, live: LiveGate, timer: PhaseTimer = NO_TIMER) {
  const store = deps.answers
  if (!store) return lookupRwa(deps, q, live, timer)
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
    if (refreshing) await later(deps, async () => keep(await lookupRwa(deps, q, live)))
    return reserveAnswer(kept.body, kept.builtAt, now, refreshing)
  }
  const body = await lookupRwa(deps, q, live, timer) as Record<string, unknown>
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
