// Market Assets — shared types for the canonical Top-N-by-market-cap layer.
//
// The canonical universe is provider-agnostic: CoinGecko (primary) or
// CoinMarketCap (optional) implement MarketAssetsProvider and return a
// normalized CanonicalAsset[]. The Markets page NEVER depends on a specific
// provider — it reads the `market_assets` table written by market-assets-refresh.

export type MarketAssetsProviderId = 'coingecko' | 'coinmarketcap'

/** One contract deployment exactly as the provider lists it. `chain` is the app
 * chain id when the platform maps to one; an unmapped platform keeps chain null
 * and its provider-reported name, never a guess. */
export interface AssetDeployment {
  platformSlug: string | null
  platformName: string | null
  chain: string | null
  address: string
}

/** Provider metadata facts recorded verbatim (CMC /v2/cryptocurrency/info).
 * Absent fields stay null; a valid zero stays a zero; nothing is inferred. */
export interface AssetFacts {
  notice: string | null
  noticeHash: string | null              // SHA-256 hex of the trimmed notice
  selfReportedCirculatingSupply: number | null
  selfReportedMarketCap: number | null
  selfReportedTags: string[] | null
  infiniteSupply: boolean | null
  dateAdded: string | null
  dateLaunched: string | null
  category: string | null                // 'coin' | 'token' as reported
  tagGroups: { tag: string; group: string | null }[]
  deployments: AssetDeployment[]
  urls: Record<string, string[]> | null
  factsAt: string | null                 // metadata fetch time (daily clock)
}

/** One canonical asset (a row in `market_assets`), provider-normalized. */
export interface CanonicalAsset {
  sourceProvider: MarketAssetsProviderId
  providerId: string                 // provider's stable id (coingecko id / cmc id)
  providerSlug: string | null
  symbol: string
  name: string | null
  normalizedSymbol: string | null    // UPPER, $-stripped — CEX enrichment join key (low confidence)
  primaryChain: string | null
  marketCapRank: number | null
  currentPrice: number | null
  marketCap: number | null
  fdv: number | null
  circulatingSupply: number | null
  totalSupply: number | null
  maxSupply: number | null
  numMarketPairs?: number | null    // CoinMarketCap listings only; CoinGecko leaves it null
  volume24h: number | null
  change1hPct: number | null
  change24hPct: number | null
  change7dPct: number | null
  categories: string[] | null
  platforms: Record<string, string> | null   // { chain: contract_address } — one primary, kept for compatibility
  facts?: AssetFacts | null                  // CoinMarketCap metadata pass only; CoinGecko leaves it null
  factsAt?: string | null                    // same clock as facts.factsAt, as a column
  metadataFetchedAt?: string | null
  imageUrl: string | null
  imageSource: string | null
  asOf: number                       // epoch ms
}

export interface MarketAssetsContext {
  orgId?: string | null
  userId?: string | null
  // deno-lint-ignore no-explicit-any
  supabase?: any                     // service-role client for DB cache + usage logs
  jobName?: string
  caller?: string
  requestId?: string | null
  kind?: 'job' | 'request' | 'render'
  waitForFresh?: boolean             // research saves need the completed shared refresh
  selectedDemand?: boolean           // authorized visible cache reader; never permits provider calls
  // Suppress the connected-demand stamp for THIS read, whatever `kind` says.
  //
  // Stamping demanded_at is how a foreground read tells the refresh worker to
  // buy a provider refresh later, on another clock, against the same shared
  // budget. A read that must not cause that spend has to be able to say so even
  // when it is otherwise a 'request': the free real-world-asset lane reads live
  // inside its own daily cap and must leave no standing instruction behind it.
  // This flag only ever REMOVES an effect; it can never authorise a call.
  noDemand?: boolean
  // A shared copy fetched BEFORE this instant counts as past its window for THIS
  // read, so a read that may call (kind other than 'render') refreshes it. The
  // public RWA lookup sets it when the stored copy is older than its live rule
  // allows or a visitor asked to check the provider now. It only ever makes a
  // copy older: the call still needs maxCalls, a reservation and every budget.
  refreshBefore?: string | null
  maxCalls?: number                  // explicit per-run budget override
  _calls?: number                    // internal counter
}

export interface MarketAssetsProvider {
  readonly id: MarketAssetsProviderId
  /** Operational enable flag (env breaker + key presence). */
  enabled(): boolean
  /**
   * Fetch the top `limit` assets by market cap, descending. Returns null on
   * total failure; omits assets it cannot normalize. Never fabricates data.
   */
  fetchTopAssets(limit: number, ctx?: MarketAssetsContext): Promise<CanonicalAsset[] | null>
}

/** UPPER-case, $-stripped symbol for the (low-confidence) CEX join key. */
export function normSymbol(raw: string | null | undefined): string | null {
  if (!raw) return null
  const s = String(raw).trim().toUpperCase().replace(/^\$/, '')
  return s || null
}

export const num = (v: unknown): number | null => {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
