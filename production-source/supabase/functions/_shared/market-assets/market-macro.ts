import type { CanonicalAsset, MarketAssetsContext, MarketAssetsProviderId } from './types.ts'
import { coingeckoProvider, fetchCoingeckoCategories, fetchCoingeckoGlobal } from './coingecko-provider.ts'
import { coinmarketcapProvider, fetchCoinmarketcapGlobalMetrics } from './coinmarketcap-provider.ts'

export type MarketMacroProvider = MarketAssetsProviderId

export interface MarketMacroProviderClient {
  enabled(): boolean
  fetchGlobal(ctx: MarketAssetsContext): Promise<unknown | null>
  fetchRankings(limit: number, ctx: MarketAssetsContext): Promise<CanonicalAsset[] | null>
  fetchCategories?(ctx: MarketAssetsContext): Promise<unknown[] | null>
}

export interface MarketMacroRefreshOptions {
  now?: Date
  rankingTopN?: number
  categoryTopN?: number
  providers?: MarketMacroProvider[]
  clients?: Partial<Record<MarketMacroProvider, MarketMacroProviderClient>>
}

export interface MarketMacroRefreshResult {
  macroRows: number
  rankingRows: number
  categoryRows: number
  providersAttempted: string[]
  providersSkipped: string[]
  writeErrors: string[]
}

const DEFAULT_RANKING_TOP_N = 100
const DEFAULT_CATEGORY_TOP_N = 60

const DEFAULT_CLIENTS: Record<MarketMacroProvider, MarketMacroProviderClient> = {
  coingecko: {
    enabled: () => coingeckoProvider.enabled(),
    fetchGlobal: (ctx) => fetchCoingeckoGlobal(ctx),
    fetchRankings: (limit, ctx) => coingeckoProvider.fetchTopAssets(limit, ctx),
    fetchCategories: (ctx) => fetchCoingeckoCategories(ctx),
  },
  coinmarketcap: {
    enabled: () => coinmarketcapProvider.enabled(),
    fetchGlobal: (ctx) => fetchCoinmarketcapGlobalMetrics(ctx),
    fetchRankings: (limit, ctx) => coinmarketcapProvider.fetchTopAssets(limit, ctx),
  },
}

function num(v: unknown): number | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function int(v: unknown): number | null {
  const n = num(v)
  return n == null ? null : Math.trunc(n)
}

function cleanLimit(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback
}

function bucketIso(now: Date): string {
  return new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString()
}

function isoOrFallback(value: unknown, fallback: string): string {
  if (!value) return fallback
  const t = new Date(String(value)).getTime()
  return Number.isFinite(t) ? new Date(t).toISOString() : fallback
}

// deno-lint-ignore no-explicit-any
export function macroRowFromCoingecko(raw: any, now: Date): Record<string, unknown> | null {
  const data = raw?.data
  if (!data || typeof data !== 'object') return null
  const asOf = now.toISOString()
  const totalMarketCap = data.total_market_cap || {}
  const totalVolume = data.total_volume || {}
  const dominance = data.market_cap_percentage || {}
  return {
    provider: 'coingecko',
    snapshot_kind: 'global',
    total_market_cap_usd: num(totalMarketCap.usd),
    total_volume_24h_usd: num(totalVolume.usd),
    market_cap_change_24h_pct: num(data.market_cap_change_percentage_24h_usd),
    btc_dominance_pct: num(dominance.btc),
    eth_dominance_pct: num(dominance.eth),
    active_cryptocurrencies: int(data.active_cryptocurrencies),
    active_markets: int(data.markets),
    source_ref: '/global',
    as_of: asOf,
    fetched_at: asOf,
    snapshot_bucket: bucketIso(now),
    raw_metrics: data,
    updated_at: asOf,
  }
}

// deno-lint-ignore no-explicit-any
export function macroRowFromCoinmarketcap(raw: any, now: Date): Record<string, unknown> | null {
  const data = raw?.data
  if (!data || typeof data !== 'object') return null
  const quote = data.quote?.USD || {}
  const asOf = isoOrFallback(data.last_updated, now.toISOString())
  return {
    provider: 'coinmarketcap',
    snapshot_kind: 'global',
    total_market_cap_usd: num(quote.total_market_cap),
    total_volume_24h_usd: num(quote.total_volume_24h),
    btc_dominance_pct: num(data.btc_dominance),
    eth_dominance_pct: num(data.eth_dominance),
    defi_market_cap_usd: num(quote.defi_market_cap),
    defi_volume_24h_usd: num(quote.defi_volume_24h),
    stablecoin_market_cap_usd: num(quote.stablecoin_market_cap),
    stablecoin_volume_24h_usd: num(quote.stablecoin_volume_24h),
    altcoin_market_cap_usd: num(quote.altcoin_market_cap),
    active_cryptocurrencies: int(data.active_cryptocurrencies ?? data.total_cryptocurrencies),
    active_markets: int(data.active_market_pairs),
    source_ref: '/v1/global-metrics/quotes/latest',
    as_of: asOf,
    fetched_at: now.toISOString(),
    snapshot_bucket: bucketIso(now),
    raw_metrics: data,
    updated_at: now.toISOString(),
  }
}

export function rankingRowsFromAssets(provider: MarketMacroProvider, assets: CanonicalAsset[], now: Date): Record<string, unknown>[] {
  const fetchedAt = now.toISOString()
  const bucket = bucketIso(now)
  return assets
    .filter((a) => a.marketCapRank != null || a.marketCap != null)
    .sort((a, b) => (a.marketCapRank || 999999) - (b.marketCapRank || 999999) || (b.marketCap || 0) - (a.marketCap || 0))
    .map((a, i) => ({
      provider,
      rank_kind: 'market_cap',
      rank: a.marketCapRank ?? i + 1,
      provider_id: a.providerId,
      provider_slug: a.providerSlug,
      symbol: a.symbol,
      name: a.name,
      normalized_symbol: a.normalizedSymbol,
      price_usd: a.currentPrice,
      market_cap_usd: a.marketCap,
      volume_24h_usd: a.volume24h,
      change_1h_pct: a.change1hPct,
      change_24h_pct: a.change24hPct,
      change_7d_pct: a.change7dPct,
      categories: a.categories || [],
      source_ref: provider === 'coinmarketcap' ? '/v1/cryptocurrency/listings/latest' : '/coins/markets',
      as_of: new Date(a.asOf || now.getTime()).toISOString(),
      fetched_at: fetchedAt,
      snapshot_bucket: bucket,
      raw_metrics: { sourceProvider: a.sourceProvider, providerId: a.providerId, primaryChain: a.primaryChain },
      updated_at: fetchedAt,
    }))
}

// deno-lint-ignore no-explicit-any
export function categoryRowsFromCoingecko(rawRows: any[], now: Date, limit = DEFAULT_CATEGORY_TOP_N): Record<string, unknown>[] {
  const fetchedAt = now.toISOString()
  const bucket = bucketIso(now)
  return rawRows
    .filter((r) => r?.id)
    .sort((a, b) => (num(b?.market_cap) || 0) - (num(a?.market_cap) || 0))
    .slice(0, cleanLimit(limit, DEFAULT_CATEGORY_TOP_N))
    .map((r, i) => ({
      provider: 'coingecko',
      category_id: String(r.id),
      category_label: r.name ? String(r.name) : String(r.id),
      rank: i + 1,
      market_cap_usd: num(r.market_cap),
      market_cap_change_24h_pct: num(r.market_cap_change_24h),
      volume_24h_usd: num(r.volume_24h),
      top_3_coins: Array.isArray(r.top_3_coins) ? r.top_3_coins.slice(0, 3) : [],
      source_ref: '/coins/categories',
      as_of: isoOrFallback(r.updated_at, fetchedAt),
      fetched_at: fetchedAt,
      snapshot_bucket: bucket,
      raw_metrics: r,
      updated_at: fetchedAt,
    }))
}

// deno-lint-ignore no-explicit-any
async function writeUpsert(admin: any, table: string, rows: Record<string, unknown>[], onConflict: string, writeErrors: Set<string>): Promise<number> {
  if (!rows.length) return 0
  const { error } = await admin.from(table).upsert(rows, { onConflict })
  if (error) {
    writeErrors.add(`${table}: ${error.message || error.code || JSON.stringify(error)}`)
    return 0
  }
  return rows.length
}

// deno-lint-ignore no-explicit-any
export async function refreshMarketMacroSnapshots(admin: any, options: MarketMacroRefreshOptions = {}): Promise<MarketMacroRefreshResult> {
  const now = options.now || new Date()
  const rankingTopN = cleanLimit(options.rankingTopN, DEFAULT_RANKING_TOP_N)
  const categoryTopN = cleanLimit(options.categoryTopN, DEFAULT_CATEGORY_TOP_N)
  const providers = options.providers || ['coingecko', 'coinmarketcap']
  const clients = { ...DEFAULT_CLIENTS, ...(options.clients || {}) }
  const macroRows: Record<string, unknown>[] = []
  const rankingRows: Record<string, unknown>[] = []
  const categoryRows: Record<string, unknown>[] = []
  const providersAttempted: string[] = []
  const providersSkipped: string[] = []
  const writeErrors = new Set<string>()

  for (const provider of providers) {
    const client = clients[provider]
    if (!client?.enabled()) {
      providersSkipped.push(provider)
      continue
    }
    providersAttempted.push(provider)
    const ctx: MarketAssetsContext = { supabase: admin, jobName: `market-macro-refresh:${provider}`, caller: 'market-macro-refresh', kind: 'job', maxCalls: provider === 'coingecko' ? 8 : 4 }

    try {
      const rawGlobal = await client.fetchGlobal(ctx)
      const row = provider === 'coingecko' ? macroRowFromCoingecko(rawGlobal, now) : macroRowFromCoinmarketcap(rawGlobal, now)
      if (row) macroRows.push(row)
    } catch {
      // Provider failures degrade to last good snapshots.
    }

    try {
      const assets = await client.fetchRankings(rankingTopN, ctx)
      if (assets?.length) rankingRows.push(...rankingRowsFromAssets(provider, assets.slice(0, rankingTopN), now))
    } catch {
      // Ranking snapshots are best-effort.
    }

    if (provider === 'coingecko' && client.fetchCategories) {
      try {
        const rawCategories = await client.fetchCategories(ctx)
        if (Array.isArray(rawCategories)) categoryRows.push(...categoryRowsFromCoingecko(rawCategories, now, categoryTopN))
      } catch {
        // Category snapshots are best-effort.
      }
    }
  }

  const macroCount = await writeUpsert(admin, 'market_macro_snapshots', macroRows, 'provider,snapshot_kind,snapshot_bucket', writeErrors)
  const rankingCount = await writeUpsert(admin, 'market_ranking_snapshots', rankingRows, 'provider,rank_kind,rank,snapshot_bucket', writeErrors)
  const categoryCount = await writeUpsert(admin, 'narrative_category_snapshots', categoryRows, 'provider,category_id,snapshot_bucket', writeErrors)

  return {
    macroRows: macroCount,
    rankingRows: rankingCount,
    categoryRows: categoryCount,
    providersAttempted,
    providersSkipped,
    writeErrors: [...writeErrors],
  }
}
