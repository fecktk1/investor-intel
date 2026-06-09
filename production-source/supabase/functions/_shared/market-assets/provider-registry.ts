// Market Assets — provider registry. The canonical market-cap source is
// swappable via MARKET_ASSETS_PROVIDER (default 'coingecko'); falls back to the
// first enabled provider. The Markets page never references a provider directly.

import type { MarketAssetsProvider, MarketAssetsProviderId } from './types.ts'
import { coingeckoProvider } from './coingecko-provider.ts'
import { coinmarketcapProvider } from './coinmarketcap-provider.ts'

// deno-lint-ignore no-explicit-any
const _glob = globalThis as any
function env(name: string): string | undefined {
  try { const v = _glob?.Deno?.env?.get?.(name); if (v != null) return v } catch { /* */ }
  const pv = _glob?.process?.env?.[name]; return pv != null ? String(pv) : undefined
}

const REGISTRY: Record<MarketAssetsProviderId, MarketAssetsProvider> = {
  coingecko: coingeckoProvider,
  coinmarketcap: coinmarketcapProvider,
}
const ORDER: MarketAssetsProviderId[] = ['coingecko', 'coinmarketcap']

export function getProvider(id: MarketAssetsProviderId): MarketAssetsProvider { return REGISTRY[id] }

/** The active canonical provider: the configured one if enabled, else the first
 *  enabled provider, else CoinGecko (so the system always has a source). */
export function getMarketAssetsProvider(): MarketAssetsProvider {
  const pref = (env('MARKET_ASSETS_PROVIDER') || 'coingecko').toLowerCase() as MarketAssetsProviderId
  const p = REGISTRY[pref]
  if (p && p.enabled()) return p
  for (const id of ORDER) { const q = REGISTRY[id]; if (q?.enabled()) return q }
  return coingeckoProvider
}

export function getEnabledProviders(): MarketAssetsProvider[] {
  return ORDER.map((id) => REGISTRY[id]).filter((p) => p.enabled())
}
