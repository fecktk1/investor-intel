// Investor Intel — what a tracked entity is CALLED, and where its page is.
//
// A watchlist row used to print `entity.canonical_ref_key`, which for a token
// is the raw mint or contract address. This module turns an entity row (plus
// whatever the identity endpoint has since stored on it) into the four things
// a member actually reads: a logo, a name, a symbol and a chain — with the
// address kept as a shortened, copyable label rather than as the row's title.

import { CHAINS, chainIdFor, getChain } from './chains'
import { assetLogoUrl, nativeAssetChain } from './asset-identity'

/** The app chain id behind an entity, or null when it names no registered chain. */
export function entityChain(entity) {
  if (!entity) return null
  const native = nativeAssetChain(entity.canonical_ref_key)
  if (native) return native
  const id = chainIdFor(entity.chain_namespace, entity.chain_id)
  return id ? getChain(id) : CHAINS.find((c) => c.namespace === entity.chain_namespace && c.caip2Ref === entity.chain_id) || null
}

/** The contract address a row should print, or null for a native coin. */
export function entityAddress(entity) {
  if (!entity || entity.entity_kind === 'wallet') return entity?.wallet_address || null
  if (entity.asset_type === 'native' || nativeAssetChain(entity.canonical_ref_key)) return null
  return entity.contract_address || null
}

/**
 * The display identity for one watchlist item.
 *
 * `overrides` is the map returned by the identity endpoint for rows whose
 * entity had not been named yet; a stored entity needs no override at all.
 * `unnamed` is true when nothing we hold can name the token — the caller says
 * so in words and still shows the address, rather than printing a bare row.
 */
export function entityDisplay(item, overrides = {}) {
  const entity = item?.entity || {}
  const override = overrides[entity.canonical_ref_key] || null
  const chain = entityChain(entity)
  const address = entityAddress(entity)
  const native = entity.asset_type === 'native' || !!nativeAssetChain(entity.canonical_ref_key)

  const symbol = item?.label || entity.display_symbol || override?.symbol
    || (native ? chain?.nativeSymbol : null) || null
  const name = override?.name || entity.provider_metadata?.display_name
    || (native ? chain?.label : null) || null
  const logo = override?.imageUrl || entity.provider_metadata?.image_url
    || assetLogoUrl(entity.canonical_ref_key) || null
  const provider = override?.provider || entity.provider_metadata?.identity_provider || null
  const providerId = override?.providerId || entity.provider_metadata?.identity_provider_id || null

  return {
    symbol, name, logo, address, provider, providerId,
    chainId: chain?.id || null,
    chainLabel: chain?.label || null,
    native,
    unnamed: !symbol && !name,
    href: entityDisplayHref({ symbol, provider, providerId, chainId: chain?.id || null, address }),
  }
}

/**
 * The asset page for a display identity.
 *
 * A CATALOGUE identity (CoinMarketCap or CoinGecko) opens the market page by
 * its provider id, exactly as the markets table links it. Everything else that
 * carries a chain and an address opens the contract route (`provider=contract`),
 * which is the one address the market read can answer for a token no catalogue
 * lists.
 *
 * The allowlist is the point. An identity resolved today is stored with
 * whatever provider named it — `contract`, and `on_demand` once the first
 * resolution has indexed it — and linking a row under a provider the market
 * read does not accept produced a page that refused the read before making it.
 * So a provider is only used as a route when it IS a catalogue namespace.
 */
export const CATALOGUE_PROVIDERS = ['coinmarketcap', 'coingecko']

export function entityDisplayHref({ symbol, provider, providerId, chainId, address }) {
  if (provider && CATALOGUE_PROVIDERS.includes(provider) && providerId && symbol) {
    return `/intel/markets/${encodeURIComponent(symbol)}?${new URLSearchParams({ provider, id: String(providerId) })}`
  }
  if (chainId && address) {
    const id = `${chainId}:${address}`
    // The path segment is the ticker when a source has named the token, so the
    // address bar reads FORGE rather than a 44-character mint. The identity
    // that is READ is the query string, so the label can never become a lookup.
    const label = symbol && String(symbol).trim() ? String(symbol).trim() : address
    return `/intel/markets/${encodeURIComponent(label)}?${new URLSearchParams({ provider: 'contract', id })}`
  }
  return null
}

/** The refs on a page that still need naming. Natives and wallets never do. */
export function refsNeedingIdentity(items) {
  const refs = []
  for (const item of items || []) {
    const entity = item?.entity
    if (!entity?.canonical_ref_key || entity.entity_kind !== 'asset') continue
    if (!entityAddress(entity)) continue
    const display = entityDisplay(item)
    if (display.symbol && display.name) continue
    if (!refs.includes(entity.canonical_ref_key)) refs.push(entity.canonical_ref_key)
  }
  return refs
}
