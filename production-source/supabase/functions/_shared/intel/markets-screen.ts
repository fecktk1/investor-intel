import { marketCanonicalIdentity } from './market-read-quality.ts'

export function screenFreshness(asOf: string | null, providerDegraded = false): 'fresh' | 'stale' | 'degraded' | 'unavailable' {
  if (!asOf || !Number.isFinite(Date.parse(asOf))) return 'unavailable'
  const age = Date.now() - Date.parse(asOf)
  if (providerDegraded || age > 60 * 60_000 || age < -30_000) return 'degraded'
  return age <= 5 * 60_000 ? 'fresh' : 'stale'
}

// Format only the database's bounded page/panels. All matching, filtering,
// aggregate counts and sort order have already been applied to the same universe.
export function marketScreenResponse(data: any) {
  const providerStatus = data.providerStatus || []
  const degraded = providerStatus.some((provider: any) => provider.degraded)
  const row = (a: any) => {
    const platforms = a.platforms && typeof a.platforms === 'object' ? a.platforms : {}
    const cex = a.cex || null
    return {
      sourceProvider: a.source_provider, providerId: a.provider_id, symbol: a.symbol, displayName: a.name,
      normalizedSymbol: a.normalized_symbol, chain: a.primary_chain,
      contract: a.primary_chain ? platforms[a.primary_chain] || null : null,
      rank: a.market_cap_rank,
      // Prefer our own mirrored copy (market-asset-logo-verify); the provider URL
      // stays alongside it as the client-side second chance before initials.
      imageUrl: a.cached_image_url ?? a.image_url, imageSourceUrl: a.image_url,
      imageFallbackType: a.image_fallback_type, imageVerifiedAt: a.image_verified_at ?? null,
      price: a.current_price, change1hPct: a.change_1h_pct, change24hPct: a.change_24h_pct, change7dPct: a.change_7d_pct,
      volumeQuote24h: a.volume_24h, marketCap: a.market_cap, marketCapIsEstimated: false, fdv: a.fdv,
      circulatingSupply: a.circulating_supply, totalSupply: a.total_supply, maxSupply: a.max_supply,
      numMarketPairs: a.num_market_pairs ?? null,
      categories: a.categories || [], platforms, cex, dex: a.dex || null,
      enrichmentConfidence: a.enrichment_confidence, ...marketCanonicalIdentity(a),
      cexCoverage: cex && Number(cex.availableCount) > 0 ? 'available' : 'unverified',
      signalDirection: a.matched_signal_direction || null, providers: cex?.providers || [],
      confirmingProviders: cex?.marketContext?.confirmingProviders || [], marketContext: cex?.marketContext || null,
      sourceLabel: a.source_label, sourceUrl: a.source_url, attributionLabel: a.attribution_label,
      lastRefreshedAt: a.last_refreshed_at, asOf: a.as_of, freshness: screenFreshness(a.as_of, degraded),
      detailHref: `/intel/markets/${encodeURIComponent(a.symbol)}?${new URLSearchParams({ provider: a.source_provider, id: a.provider_id })}`,
      derived: a.derived || {}, flags: a.flags, onWatchlist: a.on_watchlist === true,
    }
  }
  const snapshot = { ...data.snapshot,
    strongestChain: [...(data.chainHeatmap || [])].filter(c => c.avg_change_24h_pct != null).sort((a, b) => b.avg_change_24h_pct - a.avg_change_24h_pct)[0]?.chain || null,
    freshness: screenFreshness(data.snapshot?.lastUpdated, degraded),
  }
  return {
    catalog: data.catalog || null, snapshot, rows: (data.records || []).map(row), total: data.total, page: data.page, limit: data.limit,
    // The database resolved the effective direction (named sorts keep their own).
    sort: data.sort ?? null, dir: data.dir ?? null,
    marketCapPanel: { topByMarketCap: (data.topByMarketCap || []).map(row),
      unavailableCount: snapshot.marketCapUnavailableCount,
      estimatedCount: 0, coveragePct: snapshot.marketCapCoveragePct },
    topGainers: (data.topGainers || []).map(row), topLosers: (data.topLosers || []).map(row),
    availableCategories: data.availableCategories || [],
    categoryLeaders: (data.categoryLeaders || []).map((category: any) => ({ category: category.category, leaders: category.leaders.map(row) })),
    watchlistMovers: (data.watchlistMovers || []).map(row), derivedCounts: data.derivedCounts,
    chainHeatmap: data.chainHeatmap || [], crossExchangeSpreads: data.crossExchangeSpreads || [],
    providerStatus, lastUpdated: snapshot.lastUpdated,
  }
}
