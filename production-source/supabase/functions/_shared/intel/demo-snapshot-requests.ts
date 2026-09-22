// Investor Intel public demo: the SHARED-data requests of the secondary pages,
// written exactly as each page sends them.
//
// Pure (no Deno, no DOM), because both sides need it: the Deno planner puts
// these requests in the day's plan, and the Vite tests drive the real page
// clients through the demo fetch and check that every request they send is
// answered by the key planned here. The component and line that sends each
// request are named beside it.
//
// Three kinds of request:
//   fn '<edge function>'  a functions.invoke body (orgId is dropped by the key);
//   fn 'rest'             a PostgREST GET of an allowlisted shared table
//                         (demo-snapshot-key.ts DEMO_REST_TABLES), its query
//                         with time windows as hour tokens ('@-168h');
//   fn 'rpc'              a shared, argument-only RPC (DEMO_SHARED_RPCS).

export interface SharedDemoRequest { fn: string; body: Record<string, unknown>; group?: string }

const rest = (table: string, pairs: [string, string][], group: string): SharedDemoRequest =>
  ({ fn: 'rest', body: { table, query: new URLSearchParams(pairs).toString() }, group })
const rpc = (name: string, args: Record<string, unknown>, group: string): SharedDemoRequest =>
  ({ fn: 'rpc', body: { name, args }, group })
const fn = (name: string, body: Record<string, unknown>, group: string): SharedDemoRequest => ({ fn: name, body, group })

// ─── My Intel / Market Pulse (MarketPulsePage.jsx via useDashboard.js) ───────

/** useDashboard.js: { orgId, scope, chain, section } for the default 'all' view. */
export const dashboardRequests = (): SharedDemoRequest[] => [
  fn('intel-dashboard', { scope: 'all', chain: null, section: 'core' }, 'pulse'),
  fn('intel-dashboard', { scope: 'all', chain: null, section: 'picture' }, 'pulse'),
]
/** regime-api.js loadCurrentRegime (RegimeBanner on My Intel and Markets). */
export const currentRegimeRequest = (): SharedDemoRequest => rpc('intel_current_regime', {}, 'pulse')

// ─── Macro (MacroPage.jsx via macro-api.js) ───────────────────────────────────

export const MACRO_NEWS_LIMIT = 40
export const MACRO_CALENDAR_DAYS = 21
export const macroRequests = (): SharedDemoRequest[] => [
  rpc('intel_macro_news', { p_limit: MACRO_NEWS_LIMIT }, 'macro'),                      // loadMacroNews
  rest('intel_macro_indicators', [['select', '*'], ['order', 'metric_key.asc']], 'macro'), // loadMacroIndicators
  rest('intel_macro_calendar', [                                                         // loadMacroCalendar
    ['select', '*'], ['scheduled_at', 'gte.@-24h'], ['scheduled_at', `lte.@${MACRO_CALENDAR_DAYS * 24}h`],
    ['order', 'scheduled_at.asc'], ['limit', '60'],
  ], 'macro'),
]

// ─── News (NewsPage.jsx via news-api.js) ─────────────────────────────────────

export const NEWS_PAGE_SIZE = 12 // NewsPage.jsx PAGE_SIZE
export const NEWS_PAGES = 5
const CURATED_SELECT = 'id,cluster_hash,title,cleaned_title,summary,why_it_matters,what_happened,crypto_impact,watch_next,bull_case,bear_case,signal,signal_bias,confidence,news_category,source_quality_score,needs_confirmation,final_score,source_count,source_categories,supporting_sources,source_type,narratives,tokens,sectors,chains,primary_url,published_at,created_at'
const GLOBAL_NEWS_SELECT = 'id,title,url,summary,source_name,sentiment,published_at,created_at,chains,entity_symbol,source_quality,authority_level,news_category'

/** listCuratedNews, the default 'analyzed' feed: ranked, the last seven days. */
export const curatedNewsPage = (page: number): SharedDemoRequest => rest('intel_curated_news', [
  ['select', CURATED_SELECT], ['should_surface', 'eq.true'],
  ['published_at', 'gte.@-168h'], ['published_at', 'lte.@0h'],
  ['order', 'final_score.desc.nullslast,id.asc'], ['offset', String(page * NEWS_PAGE_SIZE)], ['limit', String(NEWS_PAGE_SIZE)],
], 'news')
/** pageGlobalNews, the 'headlines' feed: newest first. */
export const globalNewsPage = (page: number): SharedDemoRequest => rest('intel_global_news', [
  ['select', GLOBAL_NEWS_SELECT], ['order', 'created_at.desc,id.asc'],
  ['offset', String(page * NEWS_PAGE_SIZE)], ['limit', String(NEWS_PAGE_SIZE)],
], 'news')
export const newsRequests = (): SharedDemoRequest[] => {
  const out: SharedDemoRequest[] = []
  for (let page = 0; page < NEWS_PAGES; page++) out.push(curatedNewsPage(page), globalNewsPage(page))
  return out
}

// ─── Discovery and Markets (RecentlyDiscovered.jsx, MarketResearchPage.jsx) ──

const DISCOVERED_SELECT = 'asset_key,provider,provider_id,symbol,name,image_url,cached_image_url,first_demanded_at,last_demanded_at,demand_count,in_use_until'
export const recentlyDiscoveredRequest = (limit = 12): SharedDemoRequest =>
  rest('intel_recently_discovered', [['select', DISCOVERED_SELECT], ['order', 'last_demanded_at.desc'], ['limit', String(limit)]], 'discovery')

export const LISTINGS_PAGES = 4
/** useMarketResearch.js: { orgId, capability, params } on /intel/market-context and /intel/discovery. */
export const researchWorkspaceRequests = (): SharedDemoRequest[] => {
  const out = [fn('intel-research', { capability: 'global', params: {} }, 'context')]
  for (let page = 0; page < LISTINGS_PAGES; page++) out.push(fn('intel-research', { capability: 'listings', params: { start: page * 25 + 1, limit: 25 } }, 'discovery'))
  return out
}

// ─── Narratives (NarrativeRadarPage.jsx, NarrativeDetailPage.jsx) ────────────

export const NARRATIVE_DETAILS = 25
export const NARRATIVE_HISTORY_DAYS = 30
/** narratives-api.js loadNarratives: { mode: 'feed', orgId }. */
export const narrativeFeedRequest = (): SharedDemoRequest => fn('intel-narratives', { mode: 'feed' }, 'narratives')
/** The detail page's reads for one narrative (NarrativeDetailPage.jsx:95 and NarrativeMembers.jsx). */
export function narrativeDetailRequests(slug: string, id: string | null): SharedDemoRequest[] {
  const out = [
    fn('intel-narratives', { mode: 'detail', slug }, 'narratives'),                                  // loadNarrativeDetail
    fn('intel-narratives', { mode: 'history', slug, days: NARRATIVE_HISTORY_DAYS }, 'narratives'),   // loadNarrativeHistory
    rest('narrative_taxonomy', [['select', 'id'], ['slug', `eq.${slug}`]], 'narratives'),            // loadNarrativeXVelocity, step 1
  ]
  if (id) {
    out.push(rest('narrative_signals', [                                                            // loadNarrativeXVelocity, step 2
      ['select', 'raw,fetched_at'], ['narrative_id', `eq.${id}`], ['provider', 'eq.x_api'], ['signal_kind', 'eq.social_chatter'],
      ['order', 'fetched_at.desc'], ['limit', '1'],
    ], 'narratives'))
    out.push(rest('narrative_assets', [                                                             // loadNarrativeMembers, page 0
      ['select', 'id,asset_provider,asset_provider_id,symbol,chain,weight,is_leader,membership_source,updated_at'],
      ['narrative_id', `eq.${id}`], ['order', 'is_leader.desc,weight.desc,id.asc'], ['offset', '0'], ['limit', '21'],
    ], 'narratives'))
  }
  return out
}

// ─── DeFi (DefiPage.jsx via defi-api.js loadDefiPage) ────────────────────────

export const DEFI_PAGE_SIZE = 50
export const DEFI_MAX_PAGES = 8
/** defiQuery() with the page's defaults; only the view and the page vary. */
export const defiBrowseRequest = (view: 'vaults' | 'lending', page: number): SharedDemoRequest => fn('intel-defi-browse', {
  chain: 'solana', view, product: 'all', search: '', sort: 'tvl_usd', direction: 'desc', page, limit: DEFI_PAGE_SIZE,
}, 'defi')
