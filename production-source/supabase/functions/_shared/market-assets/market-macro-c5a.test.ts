import { macroRowFromCoinmarketcap, macroRowFromCoingecko, refreshMarketMacroSnapshots } from './market-macro.ts'

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

function makeDb() {
  const writes: Record<string, Record<string, unknown>[]> = {}
  const conflicts: Record<string, string[]> = {}
  return {
    writes,
    conflicts,
    from(table: string) {
      return {
        upsert: (rows: Record<string, unknown>[], opts?: { onConflict?: string }) => {
          ;(writes[table] ||= []).push(...(Array.isArray(rows) ? rows : [rows]))
          ;(conflicts[table] ||= []).push(opts?.onConflict || '')
          return Promise.resolve({ data: rows, error: null })
        },
      }
    },
  }
}

const NOW = new Date('2026-06-16T12:34:56Z')

Deno.test('C5a parses CoinGecko and CoinMarketCap macro payloads', () => {
  const cg = macroRowFromCoingecko({
    data: {
      total_market_cap: { usd: 3_000_000_000_000 },
      total_volume: { usd: 90_000_000_000 },
      market_cap_change_percentage_24h_usd: 1.2,
      market_cap_percentage: { btc: 54.4, eth: 12.8 },
      active_cryptocurrencies: 17000,
      markets: 1200,
    },
  }, NOW)!
  const cmc = macroRowFromCoinmarketcap({
    data: {
      btc_dominance: 54.1,
      eth_dominance: 12.7,
      active_cryptocurrencies: 10000,
      active_market_pairs: 90000,
      last_updated: '2026-06-16T12:30:00Z',
      quote: { USD: { total_market_cap: 2_990_000_000_000, total_volume_24h: 88_000_000_000, defi_market_cap: 120_000_000_000 } },
    },
  }, NOW)!
  assert(cg.provider === 'coingecko' && cg.btc_dominance_pct === 54.4, 'CoinGecko global metrics are mapped')
  assert(cmc.provider === 'coinmarketcap' && cmc.defi_market_cap_usd === 120_000_000_000, 'CMC global metrics are mapped')
  assert(cmc.as_of === '2026-06-16T12:30:00.000Z', 'CMC last_updated is preserved')
})

Deno.test('C5a refresh writes macro, category, and ranking snapshots without raw fetch', async () => {
  const db = makeDb()
  const result = await refreshMarketMacroSnapshots(db, {
    now: NOW,
    rankingTopN: 2,
    categoryTopN: 1,
    providers: ['coingecko'],
    clients: {
      coingecko: {
        enabled: () => true,
        fetchGlobal: async () => ({ data: { total_market_cap: { usd: 1 }, total_volume: { usd: 2 }, market_cap_percentage: { btc: 50 } } }),
        fetchRankings: async () => [
          { sourceProvider: 'coingecko', providerId: 'bitcoin', providerSlug: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', normalizedSymbol: 'BTC', primaryChain: null, marketCapRank: 1, currentPrice: 100, marketCap: 1000, fdv: null, circulatingSupply: null, totalSupply: null, maxSupply: null, volume24h: 50, change1hPct: null, change24hPct: 1, change7dPct: null, categories: ['Layer 1'], platforms: null, imageUrl: null, imageSource: null, asOf: NOW.getTime() },
          { sourceProvider: 'coingecko', providerId: 'ethereum', providerSlug: 'ethereum', symbol: 'ETH', name: 'Ethereum', normalizedSymbol: 'ETH', primaryChain: null, marketCapRank: 2, currentPrice: 10, marketCap: 500, fdv: null, circulatingSupply: null, totalSupply: null, maxSupply: null, volume24h: 20, change1hPct: null, change24hPct: 2, change7dPct: null, categories: ['Layer 1'], platforms: null, imageUrl: null, imageSource: null, asOf: NOW.getTime() },
        ],
        fetchCategories: async () => [
          { id: 'layer-1', name: 'Layer 1', market_cap: 1500, market_cap_change_24h: 1.5, volume_24h: 70, top_3_coins: ['btc', 'eth', 'sol'] },
          { id: 'meme-token', name: 'Meme', market_cap: 10, market_cap_change_24h: -2, volume_24h: 5, top_3_coins: ['doge'] },
        ],
      },
    },
  })
  assert(result.macroRows === 1, 'macro row written')
  assert(result.rankingRows === 2, 'ranking rows written')
  assert(result.categoryRows === 1, 'category topN is enforced')
  assert(db.conflicts.market_macro_snapshots[0] === 'provider,snapshot_kind,snapshot_bucket', 'macro upsert is idempotent')
  assert(db.conflicts.narrative_category_snapshots[0] === 'provider,category_id,snapshot_bucket', 'category upsert is idempotent')

  const source = await Deno.readTextFile(new URL('../../market-macro-refresh/index.ts', import.meta.url))
  assert(!source.includes('fetch('), 'market-macro-refresh does not use raw fetch')
  assert(source.includes('refreshMarketMacroSnapshots'), 'edge function delegates to cached provider clients')
})
