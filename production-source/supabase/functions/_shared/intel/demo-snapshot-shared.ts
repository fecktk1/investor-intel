// Investor Intel public demo: the SHARED data of the secondary pages (My Intel,
// Narratives, News, Macro, DeFi, Market context, Discovery, Markets).
//
// Two mechanisms, and only these two:
//   * in-process shared readers with the service role (the dashboard digest, the
//     Narrative Radar, the DeFi explorer, the Markets and Degen screens), which
//     compute exactly the body the
//     page's Edge Function returns for a visitor with nothing saved, and the
//     shared argument-only RPCs (DEMO_SHARED_RPCS);
//   * REST GET replays of the allowlisted shared tables (DEMO_REST_TABLES), with
//     every personal table, owner filter, embed and personal column refused.
// Nothing here signs in as anyone, and nothing here calls a provider: every
// source is a table the capture and curation jobs already wrote.

import { assembleDashboardCore } from './dashboard-core.ts'
import { publicDashboardSourceReads } from './dashboard-reads.ts'
import { readPublicDashboardPicture } from './dashboard-picture.ts'
import { readPublicNarrativeFeed, readPublicNarratives } from './narrative-public-read.ts'
import { readPublicDefiBrowse } from '../defi-public-browse.ts'
import { demoRestRefusal } from './demo-snapshot-key.ts'
import {
  currentRegimeRequest, dashboardRequests, defiBrowseRequest, DEFI_MAX_PAGES, DEFI_PAGE_SIZE, degenRequests, degenScreenRequest, macroRequests,
  marketsRequests, marketsScreenRequest, NARRATIVE_DETAILS, narrativeDetailRequests, narrativeFeedRequest, newsRequests, recentlyDiscoveredRequest,
  researchWorkspaceRequests, type SharedDemoRequest,
} from './demo-snapshot-requests.ts'
import { marketScreenResponse } from './markets-screen.ts'
import { screenProvenance } from './market-provenance.ts'
import { readNativeChainPerformance } from './chain-performance-read.ts'
import { requestCmc } from '../market-assets/cmc-transport.ts'
import { CHAINS } from '../chains.ts'
import { DEGEN_TOKEN_LIMIT, degenScreenBody, degenScreenRows, readCatalogueContracts, readDegenTokens } from '../memecoin/degen-read.ts'
import { DegenQueryError, isDegenSortKey } from '../memecoin/degen-query.ts'
import type { FunctionReader, RestReplay } from './demo-snapshot-builder.ts'

// deno-lint-ignore no-explicit-any
type Db = any

/** intel-dashboard for the default view: section 'core' or 'picture'. */
export function publicDashboardReader(db: Db): FunctionReader {
  return async (body, now) => {
    if ((body.scope ?? 'all') !== 'all' || body.chain != null) return null
    if (body.section === 'picture') {
      const result = await readPublicDashboardPicture(db, new Date(now))
      // intel-dashboard: { intelligence_grounding: picture, generated_at: picture.assembled_at }.
      return { status: 200, body: { intelligence_grounding: result.picture, generated_at: result.picture.assembled_at } }
    }
    if (body.section !== 'core') return null
    // No member: no cost-ledger write and no private evidence pack, and with no
    // followed chain and no watchlist token the chain quotes and movers read nothing.
    const out = await assembleDashboardCore({
      supabase: db, accessAdmin: db, batch: publicDashboardSourceReads(db), orgId: null,
      scope: 'all', chain: null, section: 'core', beKey: undefined,
    })
    return { status: 200, body: out }
  }
}

// ─── Markets ─────────────────────────────────────────────────────────────────

/** The native chain strip, from stored rows and the shared CMC cache only: kind
 * 'render' with maxCalls 0 never reaches the provider, and noDemand stamps no
 * demand that could buy a refresh later. */
export const cacheOnlyNativeChains = (db: Db) =>
  // deno-lint-ignore no-explicit-any
  readNativeChainPerformance(db, ((name: string, input: Record<string, unknown>, ctx: any) =>
    requestCmc(name, input, { ...ctx, kind: 'render', maxCalls: 0, noDemand: true })) as typeof requestCmc)

/** Why a Markets body is not the screen a visitor with nothing saved can see, or null. */
export function marketsScreenRefusal(body: Record<string, unknown>): string | null {
  if (body.op != null) return 'not_the_screen'                       // suggest (typeahead)
  if (body.history === true) return 'not_the_screen'                 // one asset's history
  if ((typeof body.symbol === 'string' && body.symbol.trim()) || body.sourceProvider != null || body.providerId != null) return 'not_the_screen' // detail
  if (body.watchlistOnly === true || body.watchlistOnly === 'true') return 'watchlist'
  return null
}

/**
 * intel-markets, the screen: the same RPC with no workspace
 * (intel_markets_screen_public, derived from intel_markets_screen_for_user), and
 * the same assembly intel-markets/index.ts returns:
 *   { ...marketScreenResponse(screen), receipt, figureProvenance, nativeChains, nativeChainsUnavailable }.
 * A refused or failed read is null: the demo then says the screen is not in
 * today's snapshot, never an empty table.
 */
export function publicMarketsReader(db: Db, readChains: (db: Db) => Promise<{ rows: unknown[]; unavailable: boolean }> = cacheOnlyNativeChains): FunctionReader {
  return async (body) => {
    if (marketsScreenRefusal(body)) return null
    const [{ data: screen, error }, nativeChains] = await Promise.all([
      db.rpc('intel_markets_screen_public', { p_query: body }),
      readChains(db).catch(() => ({ rows: [], unavailable: true })),
    ])
    if (error || !screen) return null
    const formatted = marketScreenResponse(screen)
    const { receipt, figureProvenance } = screenProvenance(formatted)
    return { status: 200, body: { ...formatted, receipt, figureProvenance, nativeChains: nativeChains.rows, nativeChainsUnavailable: nativeChains.unavailable } }
  }
}

/**
 * intel-degen for a visitor with no watchlist: the same reads and the same body
 * (_shared/memecoin/degen-read.ts). The token and catalogue reads are shared by
 * every entry of one invocation, as intel-degen shares its catalogue for five
 * minutes. The watchlist bucket and a failed token read are null.
 */
export function publicDegenReader(db: Db): FunctionReader {
  type Reads = { rows: ReturnType<typeof degenScreenRows>; catalogue: Set<string> } | null
  let reads: Promise<Reads> | null = null
  const load = (): Promise<Reads> => reads ??= (async (): Promise<Reads> => {
    const { data, error } = await readDegenTokens(db)
    if (error || !Array.isArray(data)) return null
    return { rows: degenScreenRows(data), catalogue: await readCatalogueContracts(db).catch(() => new Set<string>()) }
  })().catch(() => null)
  return async (body, now) => {
    if (body.bucket === 'watchlist') return null
    if (body.sort != null && body.sort !== '' && !isDegenSortKey(body.sort)) return null
    const read = await load()
    if (!read) return null
    try {
      return { status: 200, body: degenScreenBody(read.rows, body, { catalogueContracts: read.catalogue, watchSet: null, now }) }
    } catch (e) {
      if (e instanceof DegenQueryError) return null
      throw e
    }
  }
}

/** The in-process readers, by Edge Function name. */
export function sharedFunctionReaders(db: Db): Record<string, FunctionReader> {
  return {
    'intel-dashboard': publicDashboardReader(db),
    'intel-narratives': (body, now) => readPublicNarratives(db, body, now),
    'intel-defi-browse': (body, now) => readPublicDefiBrowse(db, body, now),
    'intel-markets': publicMarketsReader(db),
    'intel-degen': publicDegenReader(db),
  }
}

/** A REST replay over PostgREST with the service role. Refuses anything the
 * allowlist refuses before a request is made. */
export function serviceRoleRestReplay(supabaseUrl: string, serviceKey: string, fetchImpl: typeof fetch = fetch): RestReplay {
  const base = String(supabaseUrl || '').replace(/\/+$/, '')
  return async (table, query) => {
    const refusal = demoRestRefusal(table, query)
    if (refusal) throw new Error(`rest_refused:${refusal}`)
    const response = await fetchImpl(`${base}/rest/v1/${table}?${query}`, {
      method: 'GET',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Accept: 'application/json', Prefer: 'count=exact' },
    })
    if (!response.ok) { await response.body?.cancel(); return null }
    const rows = await response.json().catch(() => null)
    if (!Array.isArray(rows)) return null
    const total = Number(String(response.headers.get('content-range') || '').split('/')[1])
    return { rows, count: Number.isFinite(total) ? total : null }
  }
}

/**
 * The shared-data part of the day's plan. The narrative feed is read once (with
 * the same reader the entry uses) to name the top narratives and their ids, and
 * the DeFi explorer's totals decide how many pages exist.
 */
export async function planSharedRequests(db: Db, now: number): Promise<SharedDemoRequest[]> {
  const out: SharedDemoRequest[] = [
    ...dashboardRequests(), currentRegimeRequest(), ...macroRequests(), ...newsRequests(),
    recentlyDiscoveredRequest(), ...researchWorkspaceRequests(), narrativeFeedRequest(),
  ]
  try {
    const { body, ids } = await readPublicNarrativeFeed(db)
    const slugs = (Array.isArray(body.narratives) ? body.narratives : []).map((row: { slug?: unknown }) => String(row?.slug || '')).filter(Boolean)
    for (const slug of slugs.slice(0, NARRATIVE_DETAILS)) out.push(...narrativeDetailRequests(slug, ids.get(slug) || null))
  } catch { /* no narratives today: the feed entry says so */ }
  for (const view of ['vaults', 'lending'] as const) {
    out.push(defiBrowseRequest(view, 0))
    try {
      const first = await readPublicDefiBrowse(db, defiBrowseRequest(view, 0).body, now)
      // deno-lint-ignore no-explicit-any
      const total = Number((first?.body as any)?.total || 0)
      const pages = Math.min(DEFI_MAX_PAGES, Math.ceil(total / DEFI_PAGE_SIZE))
      for (let page = 1; page < pages; page++) out.push(defiBrowseRequest(view, page))
    } catch { /* the first page alone */ }
  }
  out.push(...await planMarketsRequests(db, now))
  return out
}

// deno-lint-ignore no-explicit-any
type Any = any
const strings = (values: unknown[]): string[] => values.map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean)

/** The Markets and Degen screens. The default screen is read once (with the same
 * reader the entry uses) to size the pages and name the categories and chains
 * the page then offers. */
export async function planMarketsRequests(db: Db, now: number, readers: { markets?: FunctionReader; degen?: FunctionReader } = {}): Promise<SharedDemoRequest[]> {
  const out: SharedDemoRequest[] = []
  let markets: Any = null
  try { markets = (await (readers.markets ?? publicMarketsReader(db))(marketsScreenRequest().body, now))?.body ?? null } catch { markets = null }
  const leaders = strings((Array.isArray(markets?.categoryLeaders) ? markets.categoryLeaders : []).map((c: Any) => c?.category))
  const rowCategories = strings((Array.isArray(markets?.rows) ? markets.rows : []).flatMap((r: Any) => (Array.isArray(r?.categories) ? r.categories : [])))
  const offered = new Set(strings(Array.isArray(markets?.availableCategories) ? markets.availableCategories : []))
  out.push(...marketsRequests(CHAINS.map((c) => c.id), {
    total: markets ? Number(markets.total) : null,
    derivedCounts: markets?.derivedCounts ?? null,
    // Only categories the select offers: the others are not reachable from the page.
    categories: [...leaders, ...rowCategories].filter((c) => offered.has(c)),
    heatmapChains: strings((Array.isArray(markets?.chainHeatmap) ? markets.chainHeatmap : []).map((c: Any) => c?.chain)),
  }))
  let degen: Any = null
  try { degen = (await (readers.degen ?? publicDegenReader(db))(degenScreenRequest().body, now))?.body ?? null } catch { degen = null }
  out.push(...degenRequests({
    total: degen ? Math.min(Number(degen.total), DEGEN_TOKEN_LIMIT) : null,
    chains: strings((Array.isArray(degen?.rows) ? degen.rows : []).map((r: Any) => r?.chain)),
  }))
  return out
}
