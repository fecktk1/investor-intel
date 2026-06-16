// Market Assets — CoinMarketCap provider (OPTIONAL canonical source).
//
// Active only when COINMARKETCAP_API_KEY is set AND MARKET_ASSETS_PROVIDER points
// here (or as fallback). Uses /v1/cryptocurrency/listings/latest for the top-N
// universe; logos come from /v2/cryptocurrency/info (deep step). This exists so
// we can swap off CoinGecko's non-commercial free tier without touching the page.

import type { CanonicalAsset, MarketAssetsContext, MarketAssetsProvider } from './types.ts'
import { normSymbol, num } from './types.ts'
import { marketAssetsGet } from './http.ts'

// deno-lint-ignore no-explicit-any
const _glob = globalThis as any
function env(name: string): string | undefined {
  try { const v = _glob?.Deno?.env?.get?.(name); if (v != null) return v } catch { /* */ }
  const pv = _glob?.process?.env?.[name]; return pv != null ? String(pv) : undefined
}
function apiKey(): string | undefined { return env('COINMARKETCAP_API_KEY') }
function baseUrl(): string { return env('COINMARKETCAP_API_BASE') || 'https://pro-api.coinmarketcap.com' }

const ID = 'coinmarketcap' as const

export async function fetchCoinmarketcapGlobalMetrics(ctx?: MarketAssetsContext): Promise<unknown | null> {
  const key = apiKey(); if (!key) return null
  return await marketAssetsGet<unknown>({
    provider: ID,
    url: `${baseUrl()}/v1/global-metrics/quotes/latest?convert=USD`,
    endpoint: '/v1/global-metrics/quotes/latest',
    cacheKey: 'global-metrics/quotes/latest:USD',
    headers: { 'X-CMC_PRO_API_KEY': key },
    ttlMs: 10 * 60_000,
    ctx,
  })
}

// deno-lint-ignore no-explicit-any
function mapListing(c: any): CanonicalAsset | null {
  const providerId = c?.id != null ? String(c.id) : ''
  const symbol = String(c?.symbol || '').trim()
  if (!providerId || !symbol) return null
  const q = c?.quote?.USD || {}
  return {
    sourceProvider: ID, providerId, providerSlug: c?.slug ?? null,
    symbol: symbol.toUpperCase(), name: c?.name ?? null, normalizedSymbol: normSymbol(symbol), primaryChain: null,
    marketCapRank: num(c?.cmc_rank), currentPrice: num(q?.price), marketCap: num(q?.market_cap),
    fdv: num(q?.fully_diluted_market_cap), circulatingSupply: num(c?.circulating_supply), totalSupply: num(c?.total_supply), maxSupply: num(c?.max_supply),
    volume24h: num(q?.volume_24h),
    change1hPct: num(q?.percent_change_1h), change24hPct: num(q?.percent_change_24h), change7dPct: num(q?.percent_change_7d),
    categories: null, platforms: c?.platform?.name && c?.platform?.token_address ? { [String(c.platform.name).toLowerCase()]: String(c.platform.token_address) } : null,
    imageUrl: null, imageSource: null,   // logos via /v2/cryptocurrency/info (deep)
    asOf: Date.now(),
  }
}

async function fetchTopAssets(limit: number, ctx?: MarketAssetsContext): Promise<CanonicalAsset[] | null> {
  const key = apiKey(); if (!key) return null
  const perPage = 5000
  const out: CanonicalAsset[] = []
  for (let start = 1; start <= Math.min(limit, 5000); start += perPage) {
    const count = Math.min(perPage, limit - start + 1)
    const url = `${baseUrl()}/v1/cryptocurrency/listings/latest?start=${start}&limit=${count}&convert=USD&sort=market_cap`
    const body = await marketAssetsGet<{ data?: unknown[] }>({ provider: ID, url, endpoint: '/v1/cryptocurrency/listings/latest', cacheKey: `listings:${start}:${count}`, headers: { 'X-CMC_PRO_API_KEY': key }, ctx })
    const rows = body?.data
    if (!Array.isArray(rows)) { return out.length ? out : null }
    for (const c of rows) { const a = mapListing(c); if (a) out.push(a) }
    if (rows.length < count) break
  }
  return out.length ? out.slice(0, limit) : null
}

export const coinmarketcapProvider: MarketAssetsProvider = {
  id: ID,
  enabled() {
    if (!apiKey()) return false
    const v = env('ENABLE_COINMARKETCAP_MARKET_CAP')
    return v == null || v === '' ? true : /^(1|true|yes|on)$/i.test(v.trim())
  },
  fetchTopAssets,
}
