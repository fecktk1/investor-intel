// Investor Intel public demo: the network answer for every backend request.
//
// In the demo, both Supabase data clients and window.fetch route every request
// for the backend host here. Each request is answered from one of these places:
//
//   1. the daily snapshot (./demo-snapshot.js), for Edge Function calls whose
//      key (supabase/functions/_shared/intel/demo-snapshot-key.ts) it holds;
//   2. the synthetic visitor (./demo-identity.js), for the auth, profile,
//      membership and access reads every signed-in page makes on boot;
//   3. the in-memory store (./demo-store.js), for every table the visitor can
//      write to, and the asset chart's working state (intel-chart-workspace
//      working_get / working_save): it starts empty and is gone on reload.
//
// Two more snapshot answers carry SHARED data only: a GET of one of the shared
// tables in DEMO_REST_TABLES (the builder replayed the same query on the
// server), and a shared argument-only RPC in DEMO_SHARED_RPCS. A personal table
// is never among them; it is always the in-memory store.
//
// Anything else is "not in today's demo snapshot": a JSON error with code
// 'demo_not_in_snapshot' that the pages already render as a reason.
//
// The only network traffic the demo makes to the backend host is:
//   * the snapshot reader's credential-free GETs of public objects in the
//     intel-demo bucket, through the ORIGINAL fetch the reader was given; and
//   * exactly two public Edge Functions (DEMO_PUBLIC_FUNCTIONS), through the
//     `forwardPublic` the runtime supplies:
//       - DEMO_LIVE_FUNCTION (intel-rwa-lookup, the public tokenised asset
//         endpoint), for the tokenised asset lookup ({ q }, always live) and a
//         SNAPSHOT MISS of one of the six real-world asset research reads of
//         /intel/rwa (DEMO_FORWARDED_RESEARCH), which that endpoint answers
//         exactly as intel-research answers a free member. The same read is
//         also forwarded when the snapshot DOES hold it but its copy is past its
//         refresh window (researchCopyPastWindow): the snapshot is built once a
//         day, so its copies age through the day, while the endpoint serves the
//         shared copy the warm lane keeps inside its window. The newer of the two
//         answers; an unreachable or older answer leaves the snapshot copy;
//       - DEMO_READ_FUNCTION (intel-demo-read), for a snapshot copy of a
//         SHARED CAPTURE VIEW (the wrapper board, the market structure panels,
//         every intel-capture read the snapshot holds) that is past its lane's
//         cadence (captureCopyPastWindow in
//         supabase/functions/_shared/intel/demo-capture-views.ts): the endpoint
//         reads the same view from the capture tables, as intel-capture does for
//         a member, and the NEWER capture answers; an older, refused or
//         unreachable answer leaves the snapshot copy, which states its own
//         time. Each view is checked at most once every CAPTURE_CHECK_TTL_MS.
//         The unsearched Markets screen is refreshed the same way (read
//         'screen' with no search) once its copy is older than the catalogue's
//         window (screenCopyPastWindow).
//         The same endpoint answers a SNAPSHOT MISS of a
//         visitor's own search and the asset it opens (demoReadFor below): the
//         Markets search and typeahead, the workspace search, and the asset
//         page's detail, candles, quote, history, facts, profile, venue,
//         identity, depth, attention, contract evidence and news reads. That endpoint answers them from
//         stored and cache-only data, and ONLY for an asset one of our capture
//         lanes actively tracks: the allowlist is enforced on the server, and an
//         untracked asset comes back as 403 'demo_untracked', which the pages
//         render as a calm sentence, never as a failed read.
//     Every forwarded body is rebuilt from the allowed fields alone (orgId and
//     everything else dropped), and the request carries the anon key only:
//     never the visitor's token, never cookies (credentials 'omit').
//     Every other function, and every other miss, is still answered here and
//     never forwarded.

import {
  DEMO_REST_TABLES, DEMO_SHARED_RPCS, demoRestKey, demoRestRefusal, demoRpcKey, demoSnapshotKey,
} from '../../../supabase/functions/_shared/intel/demo-snapshot-key.ts'
import { EntityResolveRefusal, normalizeEntity } from '../../../supabase/functions/_shared/entity-resolver.ts'
import { RWA_FREE_CAPABILITIES } from '../../../supabase/functions/_shared/intel/rwa-free-read.ts'
import { cmcDexIdentity } from '../../../supabase/functions/_shared/market-assets/cmc-dex.ts'
import {
  captureCopyPastWindow, DEMO_CAPTURE_VIEWS, isNewerCapture, isNewerScreen, screenCopyPastWindow,
} from '../../../supabase/functions/_shared/intel/demo-capture-views.ts'
import {
  DEMO_ORG, DEMO_ORG_ID, DEMO_PROFILE, DEMO_TIER, DEMO_USER, DEMO_USER_ID, demoMembershipRow,
} from './demo-identity.js'

export const DEMO_MISS_CODE = 'demo_not_in_snapshot'
/** The public endpoint's refusal for an asset no capture lane tracks. */
export const DEMO_UNTRACKED_CODE = 'demo_untracked'
/** The public tokenised asset endpoint, live. */
export const DEMO_LIVE_FUNCTION = 'intel-rwa-lookup'
/** The public read endpoint for a visitor's own search, tracked assets only. */
export const DEMO_READ_FUNCTION = 'intel-demo-read'
/** The only backend functions the demo ever calls. */
export const DEMO_PUBLIC_FUNCTIONS = Object.freeze([DEMO_LIVE_FUNCTION, DEMO_READ_FUNCTION])
/** intel-research capabilities whose snapshot miss is forwarded to it: the free
 * real-world asset lane (supabase/functions/_shared/intel/rwa-free-read.ts). */
export const DEMO_FORWARDED_RESEARCH = RWA_FREE_CAPABILITIES
export const DEMO_MISS_TEXT = "Not in today's demo snapshot. Create a free account to look it up."

const USABLE_STATES = ['fresh', 'cached', 'stale']
const fetchedMs = (body) => {
  const t = Date.parse(String(body?.provenance?.fetchedAt ?? body?.receipt?.fetchedAt ?? ''))
  return Number.isFinite(t) ? t : -Infinity
}

/** Is this snapshot copy of an RWA research read past its refresh window now?
 * The provider copy's own expiry decides (provenance.expiresAt), else its fetch
 * time plus the receipt's TTL. A copy that stored no usable answer counts as
 * past it; an unsupported read, or one whose window cannot be established, is
 * never second-guessed. */
export function researchCopyPastWindow(body, now = Date.now()) {
  if (!body || typeof body !== 'object') return false
  if (body.state === 'unavailable' || body.state === 'refreshing') return true
  if (!USABLE_STATES.includes(body.state)) return false
  const expires = Date.parse(String(body.provenance?.expiresAt ?? ''))
  if (Number.isFinite(expires)) return expires <= now
  const fetched = fetchedMs(body), ttl = Number(body.receipt?.ttlSeconds)
  return Number.isFinite(fetched) && Number.isFinite(ttl) && ttl > 0 && fetched + ttl * 1000 <= now
}

/** The Investor Intel surfaces (intel_surface_tiers). Starter reaches all of them. */
export const DEMO_SURFACES = {
  market_boards: 'free', market_regime: 'free', capture_views: 'free', chart_workstation: 'free',
  narratives_read: 'free', watchlist: 'free', rwa_research: 'free',
  research_on_demand: 'starter', investigation: 'starter', portfolio_valuation: 'starter', ai_generation: 'starter',
  market_history: 'starter', alert_evaluation: 'starter', agent_access: 'starter', wallet_watch: 'starter',
  thesis_journal: 'starter', comment_king: 'starter',
}

export function demoAccountAccess() {
  const surfaces = {}
  for (const [surface, minTier] of Object.entries(DEMO_SURFACES)) {
    surfaces[surface] = { allowed: true, minTier, costBasis: minTier === 'free' ? 'precomputed_shared' : 'per_member_on_demand' }
  }
  return { tier: DEMO_TIER, rank: 1, surfaces }
}

// RPCs answered by the synthetic visitor.
const IDENTITY_RPCS = {
  get_my_org_id: () => DEMO_ORG_ID,
  sparq_my_holder_workspaces: () => [],
  intel_account_access: () => demoAccountAccess(),
  get_help_context: () => null,
  claim_pending_orgs_for_current_user: () => null,
  intel_usage_summary: () => null,
}

// Personal reads that must start EMPTY rather than fail: the visitor has no
// book, no theses, no briefs and no history yet.
const EMPTY_LIST_RPCS = new Set([
  // Signals ranked for the member's own watchlist and follows: nothing yet.
  'signal_feed_v2',
  'intel_list_briefs', 'intel_list_asset_theses', 'intel_portfolio_page', 'intel_portfolio_activity_page',
  'intel_portfolio_activity_legs', 'intel_desk_positions', 'intel_portfolio_thesis_conflicts', 'what_changed',
  'intel_asset_thesis_activity', 'portfolio_exposure', 'intel_thesis_performance_ledger',
])
// Personal reads whose empty answer is an OBJECT the page reads fields from. An
// empty list here reads as a failed read ("Calendar evidence could not be read").
const EMPTY_SHAPED_RPCS = {
  // intel_book_calendar's own empty page (20260911191852_intel_calendar_versioned_evidence.sql).
  intel_book_calendar: (args = {}) => ({
    rows: [], hasMore: false, page: Number(args.p_page) || 0, unmatchedUnlocks: 0,
    knownAt: args.p_known_at ?? null, from: args.p_from ?? null, to: args.p_to ?? null, scope: args.p_asset ? 'asset' : 'book',
  }),
}
const EMPTY_VALUE_RPCS = new Set([
  'intel_asset_portfolio_holding', 'intel_asset_portfolio_context', 'intel_portfolio_overview', 'intel_what_changed_context',
  'intel_thesis_snapshot_context', 'intel_thesis_analytics', 'intel_thesis_analytics_scoped', 'intel_trade_analytics',
  'intel_trade_analytics_scoped',
])
// A write the page expects to succeed. In the demo it succeeds in memory only.
const WRITE_RPC = /(^|_)(save|append|create|record|mark|set|clear|follow|unfollow|pin|reorder|close|reclassify|complete|approve|reject|revoke|grant|claim|log|delete|update|insert|upsert|add|remove|seen)(_|$)/

// SHARED market tables the snapshot does not hold (their reads depend on the
// data they return, so no fixed request can be planned). A read of one is a
// miss, never the store's empty list: an empty ranking history would read as
// "nothing moved" rather than "not in today's demo".
const UNPLANNED_SHARED_TABLES = new Set(['market_rankings_available'])

// Tables answered by the synthetic visitor rather than the store.
function identityRows(table) {
  switch (table) {
    case 'profiles': return [{ ...DEMO_PROFILE }]
    case 'org_members': return [demoMembershipRow()]
    case 'orgs': return [{ ...DEMO_ORG }]
    default: return null
  }
}

const jsonHeaders = (extra = {}) => ({ 'Content-Type': 'application/json', ...extra })

function respond(body, status = 200, headers = {}) {
  const text = body === undefined ? '' : JSON.stringify(body)
  return new Response(status === 204 || status === 205 ? null : text, { status, headers: jsonHeaders(headers) })
}

function readUrl(input) {
  if (typeof input === 'string') return input
  if (input && typeof input.url === 'string') return input.url
  return String(input || '')
}

async function readBody(input, init) {
  const raw = init?.body ?? null
  if (raw == null && input && typeof input.clone === 'function' && typeof input.text === 'function') {
    try { return await input.clone().text() } catch { return '' }
  }
  if (typeof raw === 'string') return raw
  if (raw instanceof URLSearchParams) return raw.toString()
  if (raw && typeof raw.text === 'function') { try { return await raw.text() } catch { return '' } }
  return ''
}

function parseJson(text) {
  if (!text) return {}
  try { return JSON.parse(text) } catch { return {} }
}

function headerOf(input, init, name) {
  try {
    const headers = new Headers(init?.headers || (input && input.headers) || {})
    return headers.get(name) || ''
  } catch { return '' }
}

export function missBody(extra = {}) {
  // `error` carries the sentence because several pages print it as it is; the
  // helpers that link to sign-up key on `code` and `reason`.
  return { error: DEMO_MISS_TEXT, code: DEMO_MISS_CODE, reason: DEMO_MISS_CODE, message: DEMO_MISS_TEXT, state: 'unavailable', ...extra }
}

/** The research body a page renders as an unavailable read with our reason. */
export function researchMissBody(capability) {
  return {
    version: 1, capability: capability || null, state: 'unavailable', reason: DEMO_MISS_CODE,
    data: { rows: [], total: null, hasMore: false }, provenance: null, receipt: null, scope: null, sourceReference: null,
    refreshPolicy: { enabled: false, cacheReadSeconds: null, providerRefreshSeconds: null },
  }
}

// ─── A visitor's own search, forwarded to DEMO_READ_FUNCTION ────────────────
//
// Only these request shapes cross, each rebuilt from its allowed fields. The
// endpoint validates them again and decides, on the server, whether the asset
// is one we actively track.

const present = (value) => value !== undefined && value !== null && value !== ''
function pick(source, keys) {
  const out = {}
  for (const key of keys) if (present(source?.[key])) out[key] = source[key]
  return out
}
const identityOf = (body) => (present(body?.sourceProvider) && present(body?.providerId)
  ? { sourceProvider: String(body.sourceProvider), providerId: String(body.providerId) }
  : {})
const symbolOf = (body) => (typeof body?.symbol === 'string' && body.symbol.trim() ? { symbol: body.symbol.trim().slice(0, 120) } : {})
const SCREEN_FIELDS = ['provider', 'sort', 'dir', 'chain', 'search', 'category', 'signalDirection', 'view', 'page', 'limit']

/** How long one check of a capture view against the capture tables is kept in
 * memory: a page that reads the same view again within it is answered from the
 * same check, and the endpoint is asked at most once per view in that time. */
export const CAPTURE_CHECK_TTL_MS = 120_000

/** How long a read that HAS a snapshot copy waits for a newer answer before the
 * copy is served. The copy is dated and complete, so a visitor never watches a
 * spinner because the newer read is slow (under load on 23 Sep one took 15 s).
 * The newer answer is still taken when it lands: it is kept in memory and the
 * next read of the same thing is answered with it. */
export const FRESHER_WAIT_MS = 1_500

/** The value of `promise` if it settles within `ms`, else null. Never rejects. */
export function within(promise, ms) {
  let timer
  return Promise.race([
    Promise.resolve(promise).catch(() => null),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms) }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * The intel-demo-read body that reads a snapshotted capture view again from the
 * capture tables, or null when the view is not one the demo refreshes. A shared
 * board crosses as read 'view' with its allowed parameters only; a per-asset read
 * (token depth, attention) as read 'capture', which the endpoint answers for a
 * tracked asset only. A body carrying any parameter the view does not list is
 * not forwarded at all, so a rebuilt request can never read a different view.
 */
export function demoViewFor(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  if (b.op !== 'read' || typeof b.view !== 'string') return null
  if (Object.hasOwn(DEMO_CAPTURE_VIEWS, b.view)) {
    const allowed = Object.keys(DEMO_CAPTURE_VIEWS[b.view].params)
    const extra = Object.keys(b).filter((key) => !['op', 'view', 'orgId', 'org_id'].includes(key) && !allowed.includes(key))
    if (extra.length) return null
    return { read: 'view', view: b.view, params: pick(b, allowed) }
  }
  if (b.view === 'rwa_token_depth' || b.view === 'attention') return demoReadFor('intel-capture', b)
  return null
}

/** The intel-demo-read body that reads a snapshotted, UNSEARCHED Markets screen
 * again from the stored catalogue, or null for any other intel-markets body. */
export function demoScreenFor(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  if (b.op != null || b.history === true || symbolOf(b).symbol || present(b.sourceProvider) || present(b.providerId)) return null
  if (b.watchlistOnly === true || b.watchlistOnly === 'true') return null
  if (typeof b.search === 'string' && b.search.trim()) return null
  const extra = Object.keys(b).filter((key) => !['orgId', 'org_id', 'watchlistOnly', ...SCREEN_FIELDS].includes(key))
  if (extra.length) return null
  return { read: 'screen', query: { ...pick(b, SCREEN_FIELDS), search: '' } }
}

/** The tables the asset page's news panel reads (src/intel/lib/asset-news.js). */
export const DEMO_NEWS_TABLES = Object.freeze(['intel_curated_news', 'intel_global_news'])

/**
 * The intel-demo-read body for a snapshot miss, or null when the miss is not a
 * visitor's search (it then stays "not in today's demo snapshot").
 *   identityFor(canonicalKey) names the catalogue identity an asset page read
 *   earlier resolved that key to (the venue read carries only the key).
 */
export function demoReadFor(name, body, { identityFor = () => null } = {}) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  if (name === 'intel-markets') {
    if (b.op === 'suggest') return { read: 'suggest', q: String(b.q ?? '').trim().slice(0, 100), ...pick(b, ['limit']) }
    if (b.op != null) return null
    const identity = identityOf(b)
    if (b.history === true) return { read: 'history', ...symbolOf(b), ...pick(b, ['range']), ...identity }
    if (symbolOf(b).symbol || identity.sourceProvider) {
      const mode = b.candlesOnly === true ? 'candles' : b.quotesOnly === true ? 'quote' : 'full'
      return { read: 'detail', mode, ...symbolOf(b), ...pick(b, ['timeframe', 'interval', 'lookbackBars']), ...identity }
    }
    // A search of the screen. The visitor has no watchlist on the server.
    if (typeof b.search === 'string' && b.search.trim() && b.watchlistOnly !== true && b.watchlistOnly !== 'true') {
      return { read: 'screen', query: { ...pick(b, SCREEN_FIELDS), search: b.search.trim().slice(0, 100) } }
    }
    return null
  }
  if (name === 'intel-asset-facts') {
    if ((b.op ?? 'asset') === 'asset') return { read: 'facts', ...identityOf(b), ...pick(b, ['days']) }
    if (b.op === 'cohorts') return { read: 'cohorts', ...pick(b, ['provider']) }
    return null
  }
  // A refresh is a spend; the demo shows the shared copy only.
  if (name === 'token-profile-get') return b.refresh !== true && identityOf(b).sourceProvider ? { read: 'profile', ...identityOf(b) } : null
  if (name === 'intel-capture' && b.op === 'read') {
    if (b.view === 'rwa_token_depth' && present(b.cryptoId)) return { read: 'capture', view: 'rwa_token_depth', cryptoId: String(b.cryptoId) }
    if (b.view === 'attention' && present(b.providerId)) return { read: 'capture', view: 'attention', providerId: String(b.providerId), ...pick(b, ['hours']) }
    return null
  }
  // "How this asset was identified" for a CoinMarketCap id; a pasted contract
  // stays a miss (resolving one asks paid providers).
  if (name === 'intel-asset-resolve') {
    const query = typeof b.query === 'string' ? b.query.trim() : ''
    return /^cmc:[1-9][0-9]{0,9}$/.test(query) && !present(b.chain) ? { read: 'resolve', query } : null
  }
  // The chart's retained public DEX events for a contract representation.
  if (name === 'intel-investigate' && b.operation === 'history' && b.lens === 'liquidity' && typeof b.subject === 'string') {
    const identity = identityFor(b.subject)
    return identity ? { read: 'evidence', subject: b.subject, ...pick(b, ['from', 'to', 'limit', 'metrics', 'cursor']), ...identity } : null
  }
  if (name === 'intel-research' && b.capability === 'venueContext' && b.params?.refresh !== true) {
    const canonicalKey = typeof b.params?.canonicalKey === 'string' ? b.params.canonicalKey : ''
    const identity = canonicalKey ? identityFor(canonicalKey) : null
    return identity ? { read: 'venue', canonicalKey, ...identity } : null
  }
  return null
}

/** The news terms of an asset news read, or null for any other query. */
export function demoNewsTerms(table, url) {
  if (!DEMO_NEWS_TABLES.includes(table)) return null
  const or = url.searchParams.getAll('or')
  if (or.length !== 1 || !or[0]) return null
  const terms = or[0].replace(/^\(/, '').replace(/\)$/, '').split(',').map((term) => term.trim()).filter(Boolean)
  return terms.length && terms.length <= 6 ? terms : null
}

const postgrestError = (status, code, message) => respond({ code, message, details: null, hint: null }, status)

// `alias:table(*)` embeds in a select, as the pages write them for the rows the
// visitor creates (a watchlist item and its entity). The foreign key is
// `<alias>_id`, which is how every such embed in the product is named.
function embedsOf(select) {
  const embeds = []
  for (const match of String(select || '').matchAll(/([a-z0-9_]+):([a-z0-9_]+)\(\*\)/g)) embeds.push({ alias: match[1], table: match[2] })
  return embeds
}

/**
 * Build the demo fetch.
 *   supabaseUrl  the backend origin every intercepted URL starts with
 *   reader       { manifest(), entry(key) } from createSnapshotReader
 *   store        createDemoStore()
 */
export function createDemoFetch({ supabaseUrl, reader, store, onMiss = null, now = () => Date.now(), forwardPublic = null, fresherWaitMs = FRESHER_WAIT_MS }) {
  const base = String(supabaseUrl || '').replace(/\/+$/, '')
  const miss = (detail) => { try { onMiss?.(detail) } catch { /* diagnostics only */ } }
  // Catalogue identities the asset page's detail reads resolved, by every key
  // that page can name, so its venue read (which carries only the key) can say
  // which asset it is. In memory only.
  const identities = new Map()
  const identityFor = (key) => identities.get(key) || null
  function remember(detail) {
    const sourceProvider = detail?.sourceProvider, providerId = detail?.providerId
    if (!present(sourceProvider) || !present(providerId)) return
    const identity = { sourceProvider: String(sourceProvider), providerId: String(providerId) }
    const keys = [detail.canonicalAssetKey, `market:${identity.sourceProvider}:${identity.providerId}`, ...(Array.isArray(detail.identityChoices) ? detail.identityChoices.map((c) => c?.canonicalAssetKey) : [])]
    for (const key of keys) {
      if (typeof key !== 'string' || !key) continue
      identities.set(key, identity)
      // The chart's contract evidence names the same key in its DEX form.
      const subject = cmcDexIdentity(key)?.subject
      if (subject) identities.set(subject, identity)
    }
  }
  // A visitor's search, answered by the public read endpoint. Null when the
  // endpoint cannot be reached, so the caller keeps its old answer. The page's
  // own abort signal rides along, so a search the page has left (the Markets
  // screen after a suggestion is opened) is cancelled rather than left running.
  async function forwardRead(forwarded, signal = null) {
    if (typeof forwardPublic !== 'function' || !forwarded) return null
    try {
      const response = await forwardPublic(forwarded, DEMO_READ_FUNCTION, signal ? { signal } : undefined)
      if (!response || typeof response.status !== 'number') return null
      if (forwarded.read === 'detail' && forwarded.mode === 'full' && response.ok) {
        try { remember(await response.clone().json()) } catch { /* the page still gets its answer */ }
      }
      return response
    } catch { return null }
  }

  // An RWA research read, rebuilt from the allowed fields alone.
  const researchBody = (body) => {
    const forwarded = { capability: body.capability }
    if (body.params != null) forwarded.params = body.params
    if (body.readMode != null) forwarded.readMode = body.readMode
    return forwarded
  }
  // The shared copy for a snapshot copy past its window, or null to keep the
  // snapshot copy: when the endpoint cannot be reached, answers no usable body,
  // answers one older than the copy already held, or has not answered within
  // fresherWaitMs. A newer answer that lands after that is kept (newerResearch)
  // and answers the next read of the same key; one endpoint read per key is in
  // flight at a time.
  const newerResearch = new Map()
  const researchChecks = new Map()
  function checkResearch(key, body, stored) {
    const held = researchChecks.get(key)
    if (held) return held
    const check = (async () => {
      let response
      try { response = await forwardPublic(researchBody(body), DEMO_LIVE_FUNCTION) } catch { return null }
      if (!response || !response.ok) return null
      let answer
      try { answer = await response.json() } catch { return null }
      if (!USABLE_STATES.includes(answer?.state)) return null
      if (USABLE_STATES.includes(stored?.state) && fetchedMs(answer) < fetchedMs(stored)) return null
      newerResearch.set(key, answer)
      return answer
    })().finally(() => researchChecks.delete(key))
    researchChecks.set(key, check)
    return check
  }
  async function fresherResearch(name, body, stored, key) {
    if (name !== 'intel-research' || typeof forwardPublic !== 'function' || !DEMO_FORWARDED_RESEARCH.has(body?.capability)) return null
    // A newer answer an earlier read brought back, still inside its window.
    const kept = newerResearch.get(key)
    if (kept && !researchCopyPastWindow(kept, now())) return respond(kept)
    if (!researchCopyPastWindow(stored, now())) return null
    const answer = await within(checkResearch(key, body, stored), fresherWaitMs)
    return answer ? respond(answer) : (kept ? respond(kept) : null)
  }

  // A snapshotted stored read past its lane's cadence (a capture view, or the
  // unsearched Markets screen), read again from the store: the newer body, or
  // null to keep the snapshot copy. One check per key per CAPTURE_CHECK_TTL_MS,
  // shared by concurrent reads.
  const storedChecks = new Map()
  async function fresherStored(key, forwarded, stored, isNewer) {
    const held = storedChecks.get(key)
    if (!held || now() - held.at >= CAPTURE_CHECK_TTL_MS) {
      const check = (async () => {
        let response
        try { response = await forwardPublic(forwarded, DEMO_READ_FUNCTION) } catch { return null }
        if (!response || !response.ok) return null
        let answer
        try { answer = await response.json() } catch { return null }
        return isNewer(answer, stored) ? answer : null
      })()
      storedChecks.set(key, { at: now(), check })
    }
    // A slow check never holds the page: the snapshot copy answers after
    // fresherWaitMs, and the check, still running, answers the next read.
    const fresh = await within(storedChecks.get(key).check, fresherWaitMs)
    return fresh ? respond(fresh) : null
  }
  async function fresherCapture(name, body, key, entry) {
    if (typeof forwardPublic !== 'function' || (Number(entry?.status) || 200) !== 200) return null
    if (name === 'intel-capture') {
      const forwarded = demoViewFor(body)
      if (!forwarded || !captureCopyPastWindow(body.view, entry.body, now())) return null
      return fresherStored(key, forwarded, entry.body, isNewerCapture)
    }
    if (name === 'intel-markets') {
      const forwarded = demoScreenFor(body)
      if (!forwarded || !screenCopyPastWindow(entry.body, now())) return null
      return fresherStored(key, forwarded, entry.body, isNewerScreen)
    }
    return null
  }

  async function functions(name, input, init) {
    const text = await readBody(input, init)
    const body = parseJson(text)
    // The public lookup is genuinely live. Only the query crosses: whatever else
    // the page put in the body or the headers stays here.
    if (name === DEMO_LIVE_FUNCTION) {
      if (typeof forwardPublic !== 'function') return respond(missBody())
      const q = typeof body?.q === 'string' ? body.q : (() => { try { return new URL(readUrl(input), 'http://demo.invalid').searchParams.get('q') } catch { return null } })()
      try { return await forwardPublic({ q: String(q ?? '') }, DEMO_LIVE_FUNCTION) } catch { return respond({ error: 'lookup_unreachable', reason: 'lookup_unreachable' }, 503) }
    }
    const key = demoSnapshotKey(name, body)
    let entry = null
    try { entry = reader ? await reader.entry(key) : null } catch { entry = null }
    if (entry && entry.body !== undefined) {
      const fresher = await fresherResearch(name, body, entry.body, key) || await fresherCapture(name, body, key, entry)
      if (fresher) return fresher
      return respond(entry.body, Number(entry.status) || 200)
    }

    // Identity-shaped function reads every signed-in page makes.
    if (name === 'help-assistant' && body?.action === 'status') return respond({ tutorials_enabled: false, assistant_enabled: false })
    if (name === 'intel-resolve') return resolveInMemory(body)
    if (name === 'intel-chart-workspace') {
      const answered = chartWorkspaceInMemory(body)
      if (answered) return answered
    }
    // A real-world asset research read the snapshot does not hold: the public
    // endpoint answers it as a free member gets it. Only capability, params and
    // readMode cross; orgId and the visitor's token do not.
    if (name === 'intel-research' && typeof forwardPublic === 'function' && DEMO_FORWARDED_RESEARCH.has(body?.capability)) {
      const signal = init?.signal || null
      try { return await forwardPublic(researchBody(body), DEMO_LIVE_FUNCTION, signal ? { signal } : undefined) } catch { return respond(researchMissBody(body.capability)) }
    }
    // A visitor's own search, or the asset it opened: the public read endpoint
    // answers it for a tracked asset and refuses anything else, calmly.
    const searched = await forwardRead(demoReadFor(name, body, { identityFor }), init?.signal || null)
    if (searched) return searched
    miss({ kind: 'function', name, body })
    if (name === 'intel-research') return respond(researchMissBody(body?.capability))
    return respond(missBody())
  }

  // Workspace preferences (PersonalWorkspace.jsx) are saved through an RPC and
  // read back from their table, so the demo keeps them in that table in memory
  // and answers with the row and its next revision, as the database would.
  function saveWorkspacePreference(body) {
    const slot = String(body?.p_slot || '')
    const params = new URLSearchParams({ slot: `eq.${slot}` })
    const existing = store.select('intel_workspace_preferences', params).rows[0]
    const row = { org_id: DEMO_ORG_ID, user_id: DEMO_USER_ID, slot, value: body?.p_value ?? {}, revision: Number(existing?.revision || 0) + 1 }
    const [saved] = existing
      ? store.update('intel_workspace_preferences', row, params)
      : store.insert('intel_workspace_preferences', row, new URLSearchParams())
    return respond(saved)
  }

  // The asset chart keeps the visitor's working state (range, drawings,
  // indicators) as a member's chart does, but in memory only, and the visitor
  // has no chart conditions yet. Layouts, snapshots, sharing and alerts stay
  // demo misses: they are the visitor's own saved things.
  const workingStates = new Map()
  function chartWorkspaceInMemory(body) {
    const asset = typeof body?.asset === 'string' ? body.asset : ''
    if (body?.operation === 'working_get' && asset) return respond({ working: workingStates.get(asset) || null })
    if (body?.operation === 'working_save' && asset && body.state && typeof body.state === 'object') {
      const revision = (Number.isInteger(body.revision) ? body.revision : 0) + 1
      const updatedAt = new Date(now()).toISOString()
      workingStates.set(asset, { asset, state: body.state, revision, updatedAt })
      return respond({ asset, revision, updatedAt })
    }
    if (body?.operation === 'alert_history' && asset) return respond({ rows: [], nextCursor: null })
    return null
  }

  // Tracking something (a watchlist item, a wallet, a holding) first names it
  // as an `entities` row. The demo names it with the same pure normalizer the
  // endpoint uses and keeps the row in memory; no provider or database is asked,
  // so what the visitor can then SEE about it is still only what the snapshot holds.
  function resolveInMemory(body) {
    let entity
    try {
      entity = normalizeEntity({
        kind: body?.kind || 'asset', chain: body?.chain, value: body?.value, assetType: body?.assetType,
        issuer: body?.issuer, currency: body?.currency, symbol: body?.symbol, displaySymbol: body?.displaySymbol,
      })
    } catch (error) {
      if (error instanceof EntityResolveRefusal) return respond({ error: error.details.code, refusal: error.details }, 400)
      return respond({ error: error?.message || 'resolve_failed' }, 400)
    }
    const params = new URLSearchParams({ canonical_ref_key: `eq.${entity.canonical_ref_key}` })
    const existing = store.select('entities', params).rows[0]
    if (existing) return respond({ entity: existing })
    const [row] = store.insert('entities', { ...entity, org_id: DEMO_ORG_ID, provider_ids: {}, provider_metadata: {} }, new URLSearchParams())
    return respond({ entity: row })
  }

  function withEmbeds(rows, select) {
    const embeds = embedsOf(select)
    if (!embeds.length) return rows
    return rows.map((row) => {
      const out = { ...row }
      for (const { alias, table } of embeds) {
        const key = row?.[`${alias}_id`]
        out[alias] = key == null ? null : store.select(table, new URLSearchParams({ id: `eq.${key}` })).rows[0] || null
      }
      return out
    })
  }

  async function snapshotEntry(key) {
    try { return reader ? await reader.entry(key) : null } catch { return null }
  }

  // A GET of an allowlisted shared table, answered from the rows the builder
  // stored for the same query. Null when the snapshot does not hold it.
  async function sharedTableRows(table, url) {
    if (!Object.hasOwn(DEMO_REST_TABLES, table) || demoRestRefusal(table, url.search)) return null
    const entry = await snapshotEntry(demoRestKey(table, url.search, now()))
    const rows = entry?.body?.rows
    if (!Array.isArray(rows)) return null
    const count = Number(entry.body.count)
    return { rows, total: Number.isFinite(count) ? count : rows.length, start: Math.max(0, Number(url.searchParams.get('offset')) || 0) }
  }

  async function rpc(name, body) {
    if (Object.hasOwn(IDENTITY_RPCS, name)) return respond(IDENTITY_RPCS[name](body))
    if (DEMO_SHARED_RPCS.has(name)) {
      const entry = await snapshotEntry(demoRpcKey(name, body))
      if (entry && entry.body !== undefined) return respond(entry.body, Number(entry.status) || 200)
    }
    if (name === 'intel_save_workspace_preferences') return saveWorkspacePreference(body)
    if (Object.hasOwn(EMPTY_SHAPED_RPCS, name)) return respond(EMPTY_SHAPED_RPCS[name](body || {}))
    if (EMPTY_LIST_RPCS.has(name)) return respond([])
    if (EMPTY_VALUE_RPCS.has(name)) return respond(null)
    if (WRITE_RPC.test(name)) return respond(null)
    miss({ kind: 'rpc', name, body })
    return postgrestError(404, DEMO_MISS_CODE, DEMO_MISS_TEXT)
  }

  async function rest(table, method, url, input, init) {
    const wantsObject = /application\/vnd\.pgrst\.object\+json/.test(headerOf(input, init, 'Accept'))
    const prefer = headerOf(input, init, 'Prefer')
    const representation = /return=representation/.test(prefer)
    const counted = /count=(exact|planned|estimated)/.test(prefer)
    const shape = (rows, { total = rows.length, start = 0 } = {}) => {
      const range = rows.length ? `${start}-${start + rows.length - 1}/${counted ? total : '*'}` : `*/${counted ? total : '*'}`
      if (wantsObject) {
        if (rows.length === 1) return respond(rows[0], 200, { 'Content-Range': range })
        return respond({ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: `The result contains ${rows.length} rows`, hint: null }, 406)
      }
      return respond(rows, 200, { 'Content-Range': range })
    }

    if (method === 'GET' || method === 'HEAD') {
      if (UNPLANNED_SHARED_TABLES.has(table)) {
        miss({ kind: 'rest', table, query: url.search })
        return postgrestError(404, DEMO_MISS_CODE, DEMO_MISS_TEXT)
      }
      const identity = identityRows(table)
      let shared = identity ? null : await sharedTableRows(table, url)
      // The asset page's news panel: the shared news tables, searched for the
      // asset in front of the visitor. The endpoint rebuilds the query itself.
      const terms = identity || shared ? null : demoNewsTerms(table, url)
      if (terms) {
        const answered = await forwardRead({ read: 'news', table, terms })
        const rows = answered?.ok ? await answered.json().catch(() => null) : null
        if (Array.isArray(rows)) shared = { rows, total: rows.length, start: 0 }
      }
      const own = identity || shared ? null : store.select(table, url.searchParams)
      const result = identity ? { rows: identity, total: identity.length, start: 0 } : shared || { ...own, rows: withEmbeds(own.rows, url.searchParams.get('select')) }
      if (!identity && !result.total) miss({ kind: 'rest', table, query: url.search })
      if (method === 'HEAD') return new Response(null, { status: 200, headers: { 'Content-Range': `*/${result.total}` } })
      return shape(result.rows, result)
    }
    // Writes land in memory only. Identity tables never change.
    if (identityRows(table)) return representation ? shape(identityRows(table)) : new Response(null, { status: 204 })
    const payload = parseJson(await readBody(input, init))
    let written = []
    if (method === 'POST') written = store.insert(table, payload, url.searchParams, { upsert: /resolution=merge-duplicates/.test(prefer) })
    else if (method === 'PATCH') written = store.update(table, payload, url.searchParams)
    else if (method === 'DELETE') written = store.remove(table, url.searchParams)
    else return postgrestError(405, 'PGRST000', 'Method not allowed')
    if (representation) return shape(withEmbeds(written, url.searchParams.get('select')))
    return new Response(null, { status: method === 'POST' ? 201 : 204 })
  }

  function auth(path, method) {
    if (path === 'user' && (method === 'GET' || method === 'PUT')) return respond({ ...DEMO_USER })
    if (path === 'logout') return new Response(null, { status: 204 })
    return respond({ error: 'demo_session', error_description: DEMO_MISS_TEXT, msg: DEMO_MISS_TEXT }, 400)
  }

  return async function demoFetch(input, init = {}) {
    const href = readUrl(input)
    const method = String(init?.method || (input && input.method) || 'GET').toUpperCase()
    let url
    try { url = new URL(href, 'http://demo.invalid') } catch { return respond(missBody(), 400) }
    const path = href.startsWith(base) ? href.slice(base.length).split('?')[0] : url.pathname

    let match
    if ((match = path.match(/^\/functions\/v1\/([^/?#]+)/))) return functions(decodeURIComponent(match[1]), input, init)
    if ((match = path.match(/^\/rest\/v1\/rpc\/([^/?#]+)/))) {
      const body = method === 'GET' ? Object.fromEntries(url.searchParams) : parseJson(await readBody(input, init))
      return rpc(decodeURIComponent(match[1]), body)
    }
    if ((match = path.match(/^\/rest\/v1\/([^/?#]+)/))) return rest(decodeURIComponent(match[1]), method, url, input, init)
    if ((match = path.match(/^\/auth\/v1\/([^?#]+)/))) return auth(match[1].replace(/\/+$/, ''), method)
    if (path.startsWith('/storage/v1/')) {
      if (method === 'POST' && /\/storage\/v1\/object\/list\//.test(path)) return respond([])
      return respond({ statusCode: '404', error: DEMO_MISS_CODE, message: DEMO_MISS_TEXT }, 404)
    }
    return respond(missBody(), 404)
  }
}

export { DEMO_USER_ID }
