// Investor Intel public demo: what intel-demo-read may be asked, and the answer.
//
// The demo (/intel/demo) serves the real pages from a daily snapshot. What a
// snapshot cannot hold is a visitor's own search: the typed text, the asset they
// open from it, and that asset's page. The owner's rule decides those reads:
// "search should be available if it's something we actively track; if it's new
// and random, then no." So intel-demo-read answers them for an ACTIVELY TRACKED
// asset (public.intel_demo_tracked_assets: a capture lane stored an observation
// of that exact identity in the last seven days) and refuses everything else
// with the calm reason 'demo_untracked'.
//
// Two reads are not searches, and involve no asset identity: 'view', a SHARED
// capture view (the wrapper board, the market structure panels), and 'screen'
// with no search text, the Markets catalogue page. The browser asks for them
// only when the snapshot's copy is older than its lane's cadence, so the page
// shows the newest stored capture, not the one the snapshot happened to hold
// (./demo-capture-views.ts names the views and their parameters).
//
// Pure (no Deno, no DOM, no client): the Edge Function wires the readers in, and
// the tests drive this module with fakes. Every request is REBUILT here from its
// allowed fields; an unknown field, a bad value or an unknown read is refused
// before any reader runs, so nothing a caller adds can change what is read.
//
// Every reader is a stored or cache-only read (./demo-market-read.ts for the
// market reads). None calls a provider, none calls AI, none writes a row anyone
// owns, and none resolves a user or an org.

import { CHART_INTERVALS, CHART_WINDOWS } from './cmc-chart.ts'
import { MARKET_SORTS, MARKET_VIEWS, MARKETS_PAGE_SIZE } from './demo-snapshot-requests.ts'
import { DemoViewRefusal, parseDemoView } from './demo-capture-views.ts'

export const DEMO_UNTRACKED = 'demo_untracked'
/** The calm sentence that goes with the refusal. The page renders its own
 * translated copy from the code; this one is for any other reader. */
export const DEMO_UNTRACKED_TEXT = 'Not among the assets this demo tracks. Create a free account to look it up.'

/** Per-IP limits. Every read is stored data, so these protect the database, not
 * a credit budget: an asset page opens with about a dozen reads, the typeahead
 * asks at most once per pause in typing, and an open asset page re-reads its
 * quote (and, off the default range, its chart) once a minute. */
export const DEMO_READ_RATE = { limit: 60, windowSeconds: 60 }
export const DEMO_READ_HOURLY = { limit: 1200, windowSeconds: 3600 }

export const DEMO_READS = ['suggest', 'screen', 'detail', 'history', 'facts', 'cohorts', 'profile', 'capture', 'venue', 'news', 'resolve', 'evidence', 'view'] as const
export type DemoReadKind = typeof DEMO_READS[number]

export const DEMO_PROVIDERS = ['coinmarketcap', 'coingecko'] as const
export const DEMO_CAPTURE_VIEWS = ['rwa_token_depth', 'attention'] as const
export const DEMO_NEWS_TABLES = ['intel_curated_news', 'intel_global_news'] as const
const HISTORY_RANGES = ['1y', '90d', '30d', '7d', '48h']
const DETAIL_MODES = ['full', 'candles', 'quote']
const MAX_LOOKBACK = 1000

export class DemoReadRefusal extends Error {
  constructor(public code: string, public status = 400) { super(code) }
}

// deno-lint-ignore no-explicit-any
type Any = any
export interface Identity { sourceProvider: string; providerId: string }
export type DemoRead =
  | { read: 'suggest'; q: string; limit: number }
  | { read: 'screen'; query: Record<string, unknown> }
  | { read: 'detail'; mode: 'full' | 'candles' | 'quote'; symbol: string; identity: Identity | null; timeframe: string; interval: string; lookbackBars: number }
  | { read: 'history'; symbol: string; identity: Identity | null; range: string }
  | { read: 'facts'; identity: Identity; days: number }
  | { read: 'cohorts'; provider: string }
  | { read: 'profile'; identity: Identity }
  | { read: 'capture'; view: 'rwa_token_depth'; cryptoId: string; identity: Identity }
  | { read: 'capture'; view: 'attention'; providerId: string; hours: number; identity: Identity }
  | { read: 'venue'; canonicalKey: string; identity: Identity }
  | { read: 'news'; table: typeof DEMO_NEWS_TABLES[number]; terms: string[] }
  | { read: 'resolve'; query: string; identity: Identity }
  | { read: 'evidence'; subject: string; from: number; to: number; limit: number; metrics: string[] | null; cursor: { time: string; id: string } | null; identity: Identity }
  | { read: 'view'; view: string; params: Record<string, unknown> }

const refuse = (code: string): never => { throw new DemoReadRefusal(code) }
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const only = (body: Record<string, unknown>, allowed: string[]) => { for (const key of Object.keys(body)) if (!allowed.includes(key)) refuse('invalid_request') }
// deno-lint-ignore no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

function text(value: unknown, max: number, code: string, { required = false } = {}): string {
  if (value == null || value === '') { if (required) refuse(code); return '' }
  if (typeof value !== 'string' || value.length > max || CONTROL.test(value)) refuse(code)
  return (value as string).trim()
}
function int(value: unknown, min: number, max: number, fallback: number, code: string): number {
  if (value == null || value === '') return fallback
  const n = typeof value === 'string' && /^-?\d{1,6}$/.test(value) ? Number(value) : value
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) refuse(code)
  return n as number
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T, code: string): T {
  if (value == null || value === '') return fallback
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) refuse(code)
  return value as T
}

/** An exact catalogue identity: CoinMarketCap ids are digits, CoinGecko ids are
 * slugs. A contract, an on-demand row or anything else is never tracked here. */
export function parseIdentity(sourceProvider: unknown, providerId: unknown, { required = false } = {}): Identity | null {
  const hasProvider = sourceProvider != null && sourceProvider !== ''
  const hasId = providerId != null && providerId !== ''
  if (!hasProvider && !hasId) { if (required) refuse(DEMO_UNTRACKED); return null }
  if (!hasProvider || !hasId) refuse('incomplete_identity')
  if (typeof sourceProvider !== 'string' || !(DEMO_PROVIDERS as readonly string[]).includes(sourceProvider)) throw new DemoReadRefusal(DEMO_UNTRACKED, 403)
  const id = typeof providerId === 'number' && Number.isInteger(providerId) ? String(providerId) : providerId
  if (typeof id !== 'string') refuse('invalid_provider_id')
  const valid = sourceProvider === 'coinmarketcap' ? /^[1-9][0-9]{0,9}$/.test(id as string) : /^[a-z0-9][a-z0-9._-]{0,119}$/.test(id as string)
  if (!valid) throw new DemoReadRefusal(DEMO_UNTRACKED, 403)
  return { sourceProvider, providerId: id as string }
}

/** A news relevance term, exactly as src/intel/lib/asset-news.js writes them. */
const NEWS_WORD = String.raw`[\p{L}\p{N} :._-]{1,80}`
const NEWS_TERMS: Record<string, RegExp[]> = {
  intel_curated_news: [new RegExp(String.raw`^tokens\.cs\.\{"${NEWS_WORD}"\}$`, 'u'), /^chains\.cs\.\{[a-z0-9-]{1,40}\}$/],
  intel_global_news: [
    new RegExp(String.raw`^title\.ilike\.%${NEWS_WORD}%$`, 'u'), /^title\.ilike\.%[a-zA-Z0-9:._/-]{10,150}%$/,
    new RegExp(String.raw`^entity_symbol\.eq\."${NEWS_WORD}"$`, 'u'), /^chains\.cs\.\{[a-z0-9-]{1,40}\}$/,
  ],
}

/** The request, rebuilt from its allowed fields, or a DemoReadRefusal. */
export function parseDemoRead(body: unknown): DemoRead {
  if (!isObject(body)) refuse('invalid_request')
  const b = body as Record<string, unknown>
  const read = oneOf(b.read, DEMO_READS, undefined as unknown as DemoReadKind, 'invalid_read')
  if (!read) refuse('invalid_read')
  switch (read) {
    case 'suggest': {
      only(b, ['read', 'q', 'limit'])
      const q = text(b.q, 100, 'invalid_query', { required: true })
      if (q.length < 2) refuse('invalid_query')
      return { read, q, limit: int(b.limit, 1, 20, 8, 'invalid_limit') }
    }
    case 'screen': {
      only(b, ['read', 'query'])
      if (!isObject(b.query)) refuse('invalid_request')
      const q = b.query as Record<string, unknown>
      only(q, ['provider', 'sort', 'dir', 'chain', 'search', 'category', 'signalDirection', 'watchlistOnly', 'view', 'page', 'limit'])
      // A SEARCH, or the unsearched screen the snapshot holds when its copy is
      // older than the catalogue's own refresh (the browser asks only then):
      // the same stored catalogue read either way, never a provider.
      const search = text(q.search, 100, 'invalid_search')
      if (q.watchlistOnly != null && q.watchlistOnly !== false && q.watchlistOnly !== 'false') refuse('invalid_request')
      const chain = text(q.chain, 40, 'invalid_chain')
      if (chain && !/^[a-z0-9-]+$/.test(chain)) refuse('invalid_chain')
      const signalDirection = text(q.signalDirection, 20, 'invalid_signal')
      if (signalDirection && !/^[a-z_]+$/.test(signalDirection)) refuse('invalid_signal')
      const query = {
        provider: oneOf(q.provider, ['auto', 'coinmarketcap', 'coingecko'] as const, 'auto', 'invalid_provider'),
        sort: oneOf(q.sort, MARKET_SORTS as readonly string[], 'market_cap', 'invalid_sort'),
        dir: oneOf(q.dir, ['asc', 'desc'] as const, 'desc', 'invalid_dir'),
        chain, search, category: text(q.category, 80, 'invalid_category'), signalDirection,
        watchlistOnly: false,
        view: oneOf(q.view, MARKET_VIEWS.map(([v]) => v), '' as string, 'invalid_view'),
        page: int(q.page, 0, 40, 0, 'invalid_page'),
        limit: int(q.limit, 1, MARKETS_PAGE_SIZE, MARKETS_PAGE_SIZE, 'invalid_limit'),
      }
      return { read, query }
    }
    case 'detail': {
      only(b, ['read', 'mode', 'symbol', 'sourceProvider', 'providerId', 'timeframe', 'interval', 'lookbackBars'])
      const mode = oneOf(b.mode, DETAIL_MODES, 'full', 'invalid_mode') as 'full' | 'candles' | 'quote'
      const identity = parseIdentity(b.sourceProvider, b.providerId)
      const symbol = text(b.symbol, 120, 'invalid_symbol')
      if (!identity && !symbol) refuse('invalid_symbol')
      return {
        read, mode, symbol, identity,
        timeframe: oneOf(b.timeframe, Object.keys(CHART_WINDOWS), '7D', 'invalid_chart_range'),
        interval: oneOf(b.interval, ['auto', ...Object.keys(CHART_INTERVALS)], 'auto', 'invalid_chart_range'),
        lookbackBars: int(b.lookbackBars, 0, MAX_LOOKBACK, 0, 'invalid_lookback'),
      }
    }
    case 'history': {
      only(b, ['read', 'symbol', 'sourceProvider', 'providerId', 'range'])
      const identity = parseIdentity(b.sourceProvider, b.providerId)
      const symbol = text(b.symbol, 120, 'invalid_symbol')
      if (!identity && !symbol) refuse('invalid_symbol')
      return { read, symbol, identity, range: oneOf(b.range, HISTORY_RANGES, '90d', 'invalid_history_range') }
    }
    case 'facts': {
      only(b, ['read', 'sourceProvider', 'providerId', 'days'])
      return { read, identity: parseIdentity(b.sourceProvider, b.providerId, { required: true })!, days: int(b.days, 1, 400, 30, 'invalid_days') }
    }
    case 'cohorts': {
      only(b, ['read', 'provider'])
      return { read, provider: oneOf(b.provider, DEMO_PROVIDERS, 'coinmarketcap', 'invalid_provider') }
    }
    case 'profile': {
      only(b, ['read', 'sourceProvider', 'providerId'])
      return { read, identity: parseIdentity(b.sourceProvider, b.providerId, { required: true })! }
    }
    case 'capture': {
      const view = oneOf(b.view, DEMO_CAPTURE_VIEWS, undefined as unknown as 'attention', 'invalid_view')
      if (!view) refuse('invalid_view')
      if (view === 'rwa_token_depth') {
        only(b, ['read', 'view', 'cryptoId'])
        const cryptoId = typeof b.cryptoId === 'number' ? String(b.cryptoId) : b.cryptoId
        const identity = parseIdentity('coinmarketcap', cryptoId, { required: true })!
        return { read, view, cryptoId: identity.providerId, identity }
      }
      only(b, ['read', 'view', 'providerId', 'hours'])
      const identity = parseIdentity('coinmarketcap', b.providerId, { required: true })!
      return { read, view, providerId: identity.providerId, hours: int(b.hours, 1, 168, 24, 'invalid_hours'), identity }
    }
    case 'venue': {
      only(b, ['read', 'canonicalKey', 'sourceProvider', 'providerId'])
      const canonicalKey = text(b.canonicalKey, 240, 'invalid_venue_identity', { required: true })
      if (/\s/.test(canonicalKey)) refuse('invalid_venue_identity')
      return { read, canonicalKey, identity: parseIdentity(b.sourceProvider, b.providerId, { required: true })! }
    }
    case 'resolve': {
      // "How this asset was identified" for a CoinMarketCap id: 'cmc:<id>'.
      only(b, ['read', 'query'])
      const query = text(b.query, 240, 'invalid_query', { required: true })
      const match = /^cmc:([1-9][0-9]{0,9})$/.exec(query)
      if (!match) throw new DemoReadRefusal(DEMO_UNTRACKED, 403)
      return { read, query, identity: { sourceProvider: 'coinmarketcap', providerId: match[1] } }
    }
    case 'evidence': {
      // The chart's retained public DEX events for a contract representation
      // (useContractChartEvidence: intel-investigate lens 'liquidity', 'history').
      only(b, ['read', 'subject', 'from', 'to', 'limit', 'metrics', 'cursor', 'sourceProvider', 'providerId'])
      const subject = text(b.subject, 240, 'invalid_subject', { required: true })
      if (/\s/.test(subject)) refuse('invalid_subject')
      const time = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : refuse('invalid_time_window'))
      let metrics: string[] | null = null
      if (b.metrics != null) {
        if (!Array.isArray(b.metrics) || !b.metrics.length || b.metrics.length > 2 || b.metrics.some((m) => m !== 'liquidity_event_usd' && m !== 'swap_event_usd')) refuse('invalid_history_metrics')
        metrics = b.metrics as string[]
      }
      let cursor: { time: string; id: string } | null = null
      if (b.cursor != null) {
        const c = b.cursor as Record<string, unknown>
        if (!isObject(c) || typeof c.time !== 'string' || c.time.length > 40 || typeof c.id !== 'string' || !/^(?:cmc|issuer|depth):[a-f0-9]{64}$/.test(c.id)) refuse('invalid_history_cursor')
        cursor = { time: c.time as string, id: c.id as string }
      }
      return {
        read, subject, from: time(b.from), to: time(b.to), limit: int(b.limit, 1, 500, 100, 'invalid_page_limit'), metrics, cursor,
        identity: parseIdentity(b.sourceProvider, b.providerId, { required: true })!,
      }
    }
    case 'view': {
      // A SHARED capture view the snapshot holds, read again from the capture
      // tables because a newer capture may exist (./demo-capture-views.ts). No
      // asset identity: these are the boards every visitor sees alike.
      only(b, ['read', 'view', 'params'])
      try {
        const parsed = parseDemoView(b.view, b.params)
        return { read, view: parsed.view, params: parsed.params }
      } catch (e) {
        if (e instanceof DemoViewRefusal) refuse(e.code)
        throw e
      }
    }
    case 'news': {
      only(b, ['read', 'table', 'terms'])
      const table = oneOf(b.table, DEMO_NEWS_TABLES, undefined as unknown as 'intel_curated_news', 'invalid_table')
      if (!table) refuse('invalid_table')
      if (!Array.isArray(b.terms) || !b.terms.length || b.terms.length > 6) refuse('invalid_terms')
      const terms = (b.terms as unknown[]).map((term) => {
        if (typeof term !== 'string' || term.length > 200 || !NEWS_TERMS[table].some((pattern) => pattern.test(term))) refuse('invalid_terms')
        return term as string
      })
      return { read, table, terms }
    }
  }
  return refuse('invalid_read')
}

/** The readers the Edge Function supplies. All are stored or cache-only reads. */
export interface DemoReadDeps {
  /** The tracked subset of these identities, as 'provider:id' keys. */
  tracked: (identities: Identity[]) => Promise<Set<string>>
  suggest: (q: string, limit: number) => Promise<{ q: string; limit: number; matches: Any[]; error: string | null }>
  screen: (query: Record<string, unknown>) => Promise<Any | null>
  resolve: (symbol: string, identity: Identity | null) => Promise<{ data: Any | null; error: unknown; ambiguous: boolean }>
  detail: (read: Extract<DemoRead, { read: 'detail' }>, asset: Any) => Promise<{ status: number; body: Any }>
  history: (read: Extract<DemoRead, { read: 'history' }>, asset: Any) => Promise<{ status: number; body: Any }>
  facts: (identity: Identity, days: number) => Promise<{ status: number; body: Any }>
  cohorts: (provider: string) => Promise<Any>
  profile: (identity: Identity) => Promise<Any>
  capture: (body: Record<string, unknown>) => Promise<{ status: number; body: Any }>
  venue: (canonicalKey: string, asset: Any) => Promise<Any>
  /** The canonical keys an asset page may name for this catalogue row. */
  canonicalKeys: (asset: Any) => string[]
  news: (table: string, terms: string[]) => Promise<Any[] | null>
  /** The identity resolution of a CoinMarketCap id, from stored and cached
   *  steps only; nothing is indexed and no demand is recorded. */
  resolveIdentity: (cmcId: string) => Promise<Any>
  /** The contract subjects (cmcDexIdentity) this catalogue row's page can chart. */
  evidenceSubjects: (asset: Any) => string[]
  /** Retained public events for one subject (readInvestigationHistory). */
  evidence: (read: Extract<DemoRead, { read: 'evidence' }>) => Promise<{ status: number; body: Any }>
}

export interface DemoReadAnswer { status: number; body: Any }

/** Stamped on a view answer: read back from the capture tables, no provider asked. */
export const DEMO_VIEW_SERVED = Object.freeze({ served: 'stored_capture', providerCalls: 0 })

export const untracked = (): DemoReadAnswer => ({
  status: 403,
  body: { error: DEMO_UNTRACKED, code: DEMO_UNTRACKED, reason: DEMO_UNTRACKED, state: 'unavailable', message: DEMO_UNTRACKED_TEXT },
})

const key = (identity: Identity) => `${identity.sourceProvider}:${identity.providerId}`

async function isTracked(deps: DemoReadDeps, identity: Identity): Promise<boolean> {
  return (await deps.tracked([identity])).has(key(identity))
}

/** A resolved asset, only when the identity it resolves to is tracked. */
async function trackedAsset(deps: DemoReadDeps, symbol: string, identity: Identity | null): Promise<{ asset: Any } | { answer: DemoReadAnswer }> {
  // An exact identity is checked BEFORE anything is resolved, so an untracked
  // id is refused without a single read of its own.
  if (identity && !await isTracked(deps, identity)) return { answer: untracked() }
  const resolved = await deps.resolve(symbol, identity)
  if (resolved.ambiguous) return { answer: { status: 409, body: { error: 'ambiguous_asset', symbol } } }
  if (resolved.error) return { answer: { status: 503, body: { error: 'identity_unavailable' } } }
  if (!resolved.data) return { answer: untracked() }
  const found = { sourceProvider: String(resolved.data.source_provider || ''), providerId: String(resolved.data.provider_id ?? '') }
  if (!identity && !await isTracked(deps, found)) return { answer: untracked() }
  if (identity && key(found) !== key(identity)) return { answer: untracked() }
  return { asset: resolved.data }
}

/** Suggestions limited to tracked assets. A pasted contract no catalogue carries
 * is "new and random" in the demo: its synthetic offer is dropped. */
async function trackedSuggestions(deps: DemoReadDeps, q: string, limit: number): Promise<DemoReadAnswer> {
  // Ask for more than the page shows, since untracked rows are removed.
  const result = await deps.suggest(q, 20)
  if (result.error === 'invalid_query') return { status: 400, body: { error: 'invalid_query' } }
  if (result.error) return { status: 503, body: { error: result.error } }
  const candidates = result.matches.filter((row) => (DEMO_PROVIDERS as readonly string[]).includes(row?.sourceProvider))
  const tracked = candidates.length ? await deps.tracked(candidates.map((row) => ({ sourceProvider: row.sourceProvider, providerId: String(row.providerId) }))) : new Set<string>()
  const matches = candidates.filter((row) => tracked.has(`${row.sourceProvider}:${row.providerId}`)).slice(0, limit)
  return { status: 200, body: { suggest: true, q: result.q, limit, matches, ...(matches.length ? {} : { demoReason: DEMO_UNTRACKED }) } }
}

/** One answer. Throws only for a reader failure the caller turns into a 503. */
export async function answerDemoRead(read: DemoRead, deps: DemoReadDeps): Promise<DemoReadAnswer> {
  switch (read.read) {
    case 'suggest': return trackedSuggestions(deps, read.q, read.limit)
    case 'screen': {
      // The screen is the current catalogue (the CMC top 1,000, or CoinGecko's).
      // A tracked asset outside it (an RWA wrapper past rank 1,000, say) is still
      // searchable: the tracked suggestions for the same text ride along as
      // demoSuggestions, and only a search that names no tracked asset at all
      // says why with 'demo_untracked'.
      // An unsearched screen is the catalogue page itself: nothing to suggest,
      // and an empty page (a chain or category with no rows) is not "untracked".
      const search = String(read.query.search || '')
      if (!search) {
        const screen = await deps.screen(read.query)
        return screen ? { status: 200, body: screen } : { status: 503, body: { error: 'market_snapshot_unavailable' } }
      }
      const [screen, suggested] = await Promise.all([
        deps.screen(read.query),
        search.length >= 2 ? trackedSuggestions(deps, search, 8).catch(() => null) : Promise.resolve(null),
      ])
      if (!screen) return { status: 503, body: { error: 'market_snapshot_unavailable' } }
      const rows: Any[] = Array.isArray(screen.rows) ? screen.rows : []
      const onScreen = new Set(rows.map((row) => `${row?.sourceProvider}:${row?.providerId}`))
      const matches: Any[] = suggested?.status === 200 && Array.isArray(suggested.body?.matches) ? suggested.body.matches : []
      const demoSuggestions = matches.filter((m) => !onScreen.has(`${m.sourceProvider}:${m.providerId}`))
      const body = { ...screen, demoSuggestions }
      return { status: 200, body: rows.length || matches.length ? body : { ...body, demoReason: DEMO_UNTRACKED } }
    }
    case 'detail': {
      const found = await trackedAsset(deps, read.symbol, read.identity)
      if ('answer' in found) return found.answer
      return deps.detail(read, found.asset)
    }
    case 'history': {
      const found = await trackedAsset(deps, read.symbol, read.identity)
      if ('answer' in found) return found.answer
      return deps.history(read, found.asset)
    }
    case 'facts': {
      if (!await isTracked(deps, read.identity)) return untracked()
      return deps.facts(read.identity, read.days)
    }
    case 'cohorts': return { status: 200, body: await deps.cohorts(read.provider) }
    case 'profile': {
      if (!await isTracked(deps, read.identity)) return untracked()
      return { status: 200, body: await deps.profile(read.identity) }
    }
    case 'capture': {
      if (!await isTracked(deps, read.identity)) return untracked()
      const body = read.view === 'rwa_token_depth'
        ? { op: 'read', view: 'rwa_token_depth', cryptoId: read.cryptoId }
        : { op: 'read', view: 'attention', providerId: read.providerId, hours: read.hours }
      return deps.capture(body)
    }
    case 'venue': {
      const found = await trackedAsset(deps, '', read.identity)
      if ('answer' in found) return found.answer
      // The key must be one this tracked asset's page can name.
      if (!deps.canonicalKeys(found.asset).includes(read.canonicalKey)) return untracked()
      return { status: 200, body: await deps.venue(read.canonicalKey, found.asset) }
    }
    case 'resolve': {
      if (!await isTracked(deps, read.identity)) return untracked()
      return { status: 200, body: await deps.resolveIdentity(read.identity.providerId) }
    }
    case 'evidence': {
      const found = await trackedAsset(deps, '', read.identity)
      if ('answer' in found) return found.answer
      if (!deps.evidenceSubjects(found.asset).includes(read.subject)) return untracked()
      return deps.evidence(read)
    }
    case 'view': {
      // The same body intel-capture reads for a member, op and view last so no
      // parameter can rewrite them. captureReadEnvelope reads stored rows only.
      const answer = await deps.capture({ ...read.params, op: 'read', view: read.view })
      if (answer.status !== 200 || !answer.body || typeof answer.body !== 'object') return answer
      return { status: 200, body: { ...answer.body, demoRead: DEMO_VIEW_SERVED } }
    }
    case 'news': {
      const rows = await deps.news(read.table, read.terms)
      if (!rows) return { status: 503, body: { error: 'asset_news_unavailable' } }
      return { status: 200, body: rows }
    }
  }
}
