// Market Assets — CoinGecko provider (PRIMARY canonical top-N-by-market-cap).
//
// Uses /coins/markets pagination (250/page) for the universe + price/supply/
// change windows + logo. Platforms (contract addresses per chain) + categories
// are fetched in a separate deep step (fetchCoingeckoPlatforms / fetchCoingeckoCoin).
// Keyless by default; supports an optional Demo key. NOTE: CoinGecko free/Demo
// ToS is non-commercial — the provider abstraction lets us swap to CMC or a paid
// plan before commercial launch (see plan "Open decision").

import type { CanonicalAsset, MarketAssetsContext, MarketAssetsProvider } from './types.ts'
import { normSymbol, num } from './types.ts'
import { marketAssetsGet } from './http.ts'

// deno-lint-ignore no-explicit-any
const _glob = globalThis as any
function env(name: string): string | undefined {
  try { const v = _glob?.Deno?.env?.get?.(name); if (v != null) return v } catch { /* */ }
  const pv = _glob?.process?.env?.[name]; return pv != null ? String(pv) : undefined
}
// CoinGecko has two tiers with DIFFERENT host + auth header:
//   • Demo (free):  api.coingecko.com      + x-cg-demo-api-key
//   • Paid (Basic/Pro/…): pro-api.coingecko.com + x-cg-pro-api-key
// Default: if a key is set, assume a PAID key (pro host); keyless → public host.
// Override with COINGECKO_API_TIER=demo (demo key) or COINGECKO_API_BASE.
function isPro(): boolean {
  const tier = (env('COINGECKO_API_TIER') || '').toLowerCase()
  if (tier === 'pro' || tier === 'paid' || tier === 'basic' || tier === 'analyst') return true
  if (tier === 'demo' || tier === 'free') return false
  return !!env('COINGECKO_API_KEY')   // key present ⇒ paid by default
}
function baseUrl(): string {
  return env('COINGECKO_API_BASE') || (isPro() ? 'https://pro-api.coingecko.com/api/v3' : 'https://api.coingecko.com/api/v3')
}
function authHeaders(): Record<string, string> {
  const key = env('COINGECKO_API_KEY')
  if (!key) return {}
  return isPro() ? { 'x-cg-pro-api-key': key } : { 'x-cg-demo-api-key': key }
}

const ID = 'coingecko' as const

// deno-lint-ignore no-explicit-any
function mapCoin(c: any): CanonicalAsset | null {
  const providerId = String(c?.id || '').trim()
  const symbol = String(c?.symbol || '').trim()
  if (!providerId || !symbol) return null
  return {
    sourceProvider: ID, providerId, providerSlug: providerId,
    symbol: symbol.toUpperCase(), name: c?.name ?? null, normalizedSymbol: normSymbol(symbol), primaryChain: null,
    marketCapRank: num(c?.market_cap_rank), currentPrice: num(c?.current_price), marketCap: num(c?.market_cap),
    fdv: num(c?.fully_diluted_valuation), circulatingSupply: num(c?.circulating_supply), totalSupply: num(c?.total_supply), maxSupply: num(c?.max_supply),
    volume24h: num(c?.total_volume),
    change1hPct: num(c?.price_change_percentage_1h_in_currency), change24hPct: num(c?.price_change_percentage_24h_in_currency ?? c?.price_change_percentage_24h), change7dPct: num(c?.price_change_percentage_7d_in_currency),
    categories: null, platforms: null,
    imageUrl: c?.image ? String(c.image) : null, imageSource: c?.image ? ID : null,
    asOf: Date.now(),
  }
}

async function fetchTopAssets(limit: number, ctx?: MarketAssetsContext): Promise<CanonicalAsset[] | null> {
  const perPage = 250
  const pages = Math.max(1, Math.ceil(Math.min(limit, 5000) / perPage))
  const out: CanonicalAsset[] = []
  let anyOk = false
  for (let page = 1; page <= pages; page++) {
    const url = `${baseUrl()}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=${page}&price_change_percentage=1h%2C24h%2C7d&sparkline=false`
    const rows = await marketAssetsGet<unknown[]>({ provider: ID, url, endpoint: '/coins/markets', cacheKey: `coins/markets:p${page}`, headers: authHeaders(), ctx })
    if (!Array.isArray(rows)) continue
    anyOk = true
    for (const c of rows) { const a = mapCoin(c); if (a) out.push(a) }
    if (rows.length < perPage) break   // ran out of coins
  }
  if (!anyOk && out.length === 0) return null
  return out.slice(0, limit)
}

/** Deep: contract platforms per chain for all coins (one keyless call). Returns
 *  Map<coingeckoId, { chain: address }>. */
export async function fetchCoingeckoPlatforms(ctx?: MarketAssetsContext): Promise<Map<string, Record<string, string>>> {
  const url = `${baseUrl()}/coins/list?include_platform=true`
  const rows = await marketAssetsGet<unknown[]>({ provider: ID, url, endpoint: '/coins/list', cacheKey: 'coins/list:platforms', headers: authHeaders(), ttlMs: 12 * 3600_000, ctx })
  const m = new Map<string, Record<string, string>>()
  if (!Array.isArray(rows)) return m
  for (const r of rows) {
    // deno-lint-ignore no-explicit-any
    const row = r as any
    const id = String(row?.id || '')
    const platforms = row?.platforms && typeof row.platforms === 'object' ? row.platforms : null
    if (!id || !platforms) continue
    const clean: Record<string, string> = {}
    for (const [chain, addr] of Object.entries(platforms)) if (chain && typeof addr === 'string' && addr.trim()) clean[chain] = addr.trim()
    if (Object.keys(clean).length) m.set(id, clean)
  }
  return m
}

/** Deep: full coin doc for categories/links/description (per-id; for top-N or profiles). */
// deno-lint-ignore no-explicit-any
export async function fetchCoingeckoCoin(id: string, ctx?: MarketAssetsContext): Promise<any | null> {
  const url = `${baseUrl()}/coins/${encodeURIComponent(id)}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false`
  return await marketAssetsGet<unknown>({ provider: ID, url, endpoint: '/coins/{id}', cacheKey: `coins/${id}`, headers: authHeaders(), ttlMs: 24 * 3600_000, ctx })
}

/** Deep: coin ids belonging to a CoinGecko category (top by market cap). Lets us
 *  tag the canonical universe with category buckets for the Markets filter
 *  without a per-coin call. One call per category; bad/unknown ids return []. */
export async function fetchCoingeckoCategoryMembers(categoryId: string, ctx?: MarketAssetsContext): Promise<string[]> {
  const url = `${baseUrl()}/coins/markets?vs_currency=usd&category=${encodeURIComponent(categoryId)}&order=market_cap_desc&per_page=250&page=1&sparkline=false`
  const rows = await marketAssetsGet<unknown[]>({ provider: ID, url, endpoint: '/coins/markets?category', cacheKey: `coins/markets:cat:${categoryId}`, headers: authHeaders(), ttlMs: 12 * 3600_000, ctx })
  if (!Array.isArray(rows)) return []
  // deno-lint-ignore no-explicit-any
  return rows.map((c: any) => String(c?.id || '')).filter(Boolean)
}

export const coingeckoProvider: MarketAssetsProvider = {
  id: ID,
  enabled() {
    const v = env('ENABLE_COINGECKO_MARKET_CAP')
    return v == null || v === '' ? true : /^(1|true|yes|on)$/i.test(v.trim())
  },
  fetchTopAssets,
}
