// Investor Intel — the ONE route shape a contract-addressed asset opens at.
//
// A token the catalogue does not list can reach the asset page by three names:
//
//   provider=contract    what the resolver, the watchlist and the Degen strip
//                        have always written: `<chain>:<address>`.
//   provider=on_demand   what `public.intel_upsert_on_demand_asset` writes into
//                        `market_assets` the first time anybody resolves that
//                        contract. Its provider_id is the SAME `<chain>:<address>`
//                        string; only the catalogue column differs.
//   a bare address       typed or pasted into the address bar.
//
// All three name one asset, so all three have to resolve through the one
// contract identity path. They did not: `resolveMarketAsset` accepted only
// 'contract', 'coingecko' and 'coinmarketcap', so an `on_demand` row — which is
// exactly what an owner's own token becomes after it has been looked up once —
// answered `invalid_provider`, and the asset page showed "The asset read could
// not be completed" with no read attempted at all.
//
// Nothing here contacts a provider: it is a naming rule, not a lookup.

import { parseContractProviderId } from './contract-market-asset.ts'

/** Catalogue namespaces whose provider_id IS a provider id. Everything else
 *  that carries a contract is read as a contract. */
export const CATALOGUE_PROVIDERS = ['coingecko', 'coinmarketcap'] as const

/** The catalogue namespace on-demand indexing writes a resolved contract under. */
export const ON_DEMAND_PROVIDER = 'on_demand'

/** Providers whose provider_id is `<chain>:<address>` and therefore a contract. */
export const CONTRACT_IDENTITY_PROVIDERS = ['contract', ON_DEMAND_PROVIDER] as const

export function isContractIdentityProvider(provider: unknown): boolean {
  return typeof provider === 'string' && (CONTRACT_IDENTITY_PROVIDERS as readonly string[]).includes(provider)
}

/**
 * The chain and address behind a (provider, provider_id) pair, or null when the
 * pair does not name a contract we carry a chain for.
 */
export function contractIdentityOf(provider: unknown, providerId: unknown): { chain: string; address: string } | null {
  if (!isContractIdentityProvider(provider)) return null
  return parseContractProviderId(String(providerId ?? ''))
}

/**
 * The canonical asset-page address for one contract.
 *
 * `label` is the path segment only — a ticker when we have one, the address
 * otherwise. The identity that is READ is always the query string, so a label
 * can never become a ticker lookup.
 */
export function contractRouteHref(chain: string, address: string, label?: string | null): string {
  const providerId = `${chain}:${address}`
  const segment = typeof label === 'string' && label.trim() ? label.trim() : address
  return `/intel/markets/${encodeURIComponent(segment)}?${new URLSearchParams({ provider: 'contract', id: providerId })}`
}
