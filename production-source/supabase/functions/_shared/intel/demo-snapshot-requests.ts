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

// ─── Markets (MarketsPage.jsx via useMarketScreen.js -> markets-api.js loadMarkets) ──

export const MARKETS_PAGE_SIZE = 50 // MarketsPage.jsx PAGE_SIZE
/** Default pages of the unfiltered screen (50 rows a page: the top 1,000). */
export const MARKETS_DEFAULT_PAGES = 20
/** Category filters planned: the category leaders first, then the categories of
 * the assets on the first page, in order. The select offers every category. */
export const MARKETS_CATEGORIES = 40
/** Every order the page can send: the Filters & sort select (MarketsPage.jsx
 * SORTS) and every sortable column header (MarketsTable.jsx MARKET_SORT_KEYS). */
export const MARKET_SORTS = [
  'market_cap', 'volume', 'gainers', 'losers', 'change_1h', 'change_24h', 'change_7d', 'exchange_availability', 'arbitrage',
  'unusual_volume', 'multi_exchange_strength', 'recently_updated', 'rank', 'price', 'drawdown', 'fdv', 'circulating_supply',
  'max_supply', 'market_pairs',
]
/** Columns that start ascending when first picked (MarketsPage.jsx ASCENDING_FIRST). */
export const MARKET_ASCENDING_FIRST = ['rank', 'drawdown']
/** The derived-view buttons and the order each one sets (MarketsPage.jsx "Derived views"). */
export const MARKET_VIEWS: [string, string | null][] = [
  ['unusual_volume', 'unusual_volume'], ['vol_up_price_flat', null], ['price_up_liq_weak', null],
  ['multi_exchange', 'multi_exchange_strength'], ['thin_liquidity', null],
]
export const MARKET_PROVIDERS = ['coinmarketcap', 'coingecko'] // the Catalogue select besides 'auto'

/**
 * useMarketScreen -> loadMarkets: { orgId, ...screenParams }, where screenParams
 * is every m_ default (MarketsPage.jsx useScreenParams) with sort and dir from
 * useColumnSort. dir is never '' on the wire: an unset m_dir reads as the
 * column's own first direction.
 */
export const marketsScreenRequest = (patch: Record<string, unknown> = {}): SharedDemoRequest => {
  const sort = String(patch.sort ?? 'market_cap')
  return fn('intel-markets', {
    provider: 'auto', sort, dir: MARKET_ASCENDING_FIRST.includes(sort) ? 'asc' : 'desc', chain: '', search: '', category: '',
    signalDirection: '', watchlistOnly: false, view: '', page: 0, limit: MARKETS_PAGE_SIZE, ...patch,
  }, 'markets')
}

/** markets-api.js loadMarketMacro: the global macro bar in the expanded market context. */
export const MARKET_MACRO_COLUMNS = 'provider,total_market_cap_usd,total_volume_24h_usd,market_cap_change_24h_pct,btc_dominance_pct,eth_dominance_pct,stablecoin_market_cap_usd,defi_market_cap_usd,as_of'
export const marketMacroRequest = (): SharedDemoRequest => rest('market_macro_available', [
  ['select', MARKET_MACRO_COLUMNS], ['snapshot_kind', 'eq.global'], ['order', 'as_of.desc'], ['limit', '4'],
], 'markets')

export interface MarketsDiscovery {
  total?: number | null
  derivedCounts?: Record<string, unknown> | null
  categories?: string[]      // category leaders first, then first-page asset categories
  heatmapChains?: string[]   // the chain heatmap's chains (MarketsCharts onChain)
}

/** The Markets screen variants a visitor reaches from the default view. */
export function marketsRequests(chainIds: string[], found: MarketsDiscovery = {}): SharedDemoRequest[] {
  const out: SharedDemoRequest[] = [marketMacroRequest()]
  const pages = (total: unknown, max: number) => Math.max(1, Math.min(max, Math.ceil(Number(total) / MARKETS_PAGE_SIZE) || 1))
  for (let page = 0; page < pages(found.total ?? MARKETS_DEFAULT_PAGES * MARKETS_PAGE_SIZE, MARKETS_DEFAULT_PAGES); page++) out.push(marketsScreenRequest({ page }))
  for (const provider of MARKET_PROVIDERS) out.push(marketsScreenRequest({ provider }))
  // Every column both ways, first and second page.
  for (const sort of MARKET_SORTS) {
    const first = MARKET_ASCENDING_FIRST.includes(sort) ? 'asc' : 'desc'
    for (const page of [0, 1]) for (const dir of [first, first === 'asc' ? 'desc' : 'asc']) out.push(marketsScreenRequest({ sort, dir, page }))
  }
  for (const [view, sort] of MARKET_VIEWS) {
    const count = Number(found.derivedCounts?.[view])
    // A button with a zero count is disabled; the view is still planned so a
    // shared link to it answers with its zero.
    const viewPages = Number.isFinite(count) ? pages(count, 2) : 1
    for (let page = 0; page < viewPages; page++) out.push(marketsScreenRequest({ view, ...(sort ? { sort } : {}), page }))
  }
  for (const chain of [...new Set([...chainIds, ...(found.heatmapChains || [])])]) if (chain) out.push(marketsScreenRequest({ chain }))
  for (const category of [...new Set(found.categories || [])].slice(0, MARKETS_CATEGORIES)) if (category) out.push(marketsScreenRequest({ category }))
  return out
}

// ─── Degen (MarketsPage.jsx ?mode=degen via markets-api.js loadDegenMarkets) ──

export const DEGEN_PAGES = 6
/** MarketsPage.jsx DEGEN_SORTS (= DEGEN_SORT_KEYS in _shared/memecoin/degen-query.ts). */
export const DEGEN_SORTS = ['trending', 'volume', 'gainers', 'losers', 'liquidity', 'new', 'market_cap', 'price', 'change_1h', 'change_24h', 'fdv', 'buys', 'sells', 'txns', 'risk', 'age']
/** MarketsPage.jsx DEGEN_BUCKETS without 'watchlist' (the visitor has none on the server). */
export const DEGEN_BUCKETS = ['hot', 'new', 'pumpfun', 'migrated', 'trending', 'takeovers', 'established', 'high_volume', 'high_liquidity', 'high_risk']
export const DEGEN_CHAINS = ['solana', 'ethereum', 'base', 'bnb']
export const DEGEN_RISK_MAX = [30, 60]

/** MarketsPage.jsx degen effect: the fixed fields, then search/chain/bucket/riskMax only when set. */
export const degenScreenRequest = (patch: Record<string, unknown> = {}): SharedDemoRequest =>
  fn('intel-degen', { sort: 'trending', dir: 'desc', showExcluded: false, page: 0, limit: MARKETS_PAGE_SIZE, ...patch }, 'degen')

export function degenRequests(found: { total?: number | null; chains?: string[] } = {}): SharedDemoRequest[] {
  const out: SharedDemoRequest[] = []
  const pages = Math.max(1, Math.min(DEGEN_PAGES, Math.ceil(Number(found.total ?? DEGEN_PAGES * MARKETS_PAGE_SIZE) / MARKETS_PAGE_SIZE) || 1))
  for (let page = 0; page < pages; page++) out.push(degenScreenRequest({ page }))
  out.push(degenScreenRequest({ showExcluded: true }))
  for (const sort of DEGEN_SORTS) for (const dir of ['desc', 'asc']) out.push(degenScreenRequest({ sort, dir }))
  for (const bucket of DEGEN_BUCKETS) out.push(degenScreenRequest({ bucket }))
  for (const chain of [...new Set([...DEGEN_CHAINS, ...(found.chains || [])])]) if (chain) out.push(degenScreenRequest({ chain }))
  for (const riskMax of DEGEN_RISK_MAX) out.push(degenScreenRequest({ riskMax }))
  return out
}
