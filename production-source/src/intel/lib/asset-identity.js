import { CHAINS } from './chains'
const MARKET_NATIVE_CHAINS={'coingecko:bitcoin':'bitcoin','coinmarketcap:1':'bitcoin','coingecko:ethereum':'ethereum','coinmarketcap:1027':'ethereum','coingecko:solana':'solana','coinmarketcap:5426':'solana','coingecko:binancecoin':'bnb','coinmarketcap:1839':'bnb','coingecko:avalanche-2':'avalanche','coinmarketcap:5805':'avalanche'}
export const marketNativeChain=(provider,id)=>MARKET_NATIVE_CHAINS[`${provider}:${id}`]||null
// Logos use a provider ID or a registered native identity, never a display ticker.
export function assetLogoUrl(asset) {
  const direct=/^market:coinmarketcap:([1-9]\d*)$/.exec(asset||'')
  const provider=/^market:(coingecko):(.+)$/.exec(asset||'')
  const chain=provider?marketNativeChain(provider[1],provider[2]):nativeAssetChain(asset)?.id
  const nativeId=chain?Object.entries(MARKET_NATIVE_CHAINS).find(([key,value])=>key.startsWith('coinmarketcap:')&&value===chain)?.[0].split(':')[1]:null
  const id=direct?.[1]||nativeId
  return id?`https://s2.coinmarketcap.com/static/img/coins/64x64/${id}.png`:null
}
// Convert a resolved entity to the existing ledger namespace, never by ticker.
export function entityPortfolioKey(entity) {
  if (!entity || entity.entity_kind === 'wallet') return null
  const appChain = entity._chain || (entity.canonical_ref_key?.startsWith('native:') ? entity.canonical_ref_key.slice(7) : null)
  const chain = appChain ? CHAINS.find(c => c.id === appChain) : CHAINS.find(c => c.namespace === entity.chain_namespace && c.caip2Ref === String(entity.chain_id))
  if (!chain) return null
  if (entity._native || entity.asset_type === 'native') return chain.evmChainId != null ? `eip155:${chain.evmChainId}:native` : `${chain.namespace}:native:${chain.nativeSymbol}`
  const address = entity._address || entity.contract_address
  if (!address) return null
  if (chain.evmChainId != null) return /^0x[0-9a-f]{40}$/i.test(address) ? `eip155:${chain.evmChainId}:${address.toLowerCase()}` : null
  return `${chain.namespace}:${address}`
}
export function marketIdentityParams(row) {
  return !row?.sourceProvider || row?.providerId == null ? '' : `?${new URLSearchParams({ provider: row.sourceProvider, id: String(row.providerId) })}`
}

export function nativeAssetChain(key) {
  const ledger = canonicalPortfolioKey(key)
  return CHAINS.find(chain => ledger === (chain.evmChainId != null ? `eip155:${chain.evmChainId}:native` : `${chain.namespace}:native:${chain.nativeSymbol}`)) || null
}

export function nativeAssetEntity(key) {
  const chain = nativeAssetChain(key)
  if (!chain) return null
  return { id: null, canonical_ref_key: key, entity_kind: 'asset', asset_type: 'native', display_symbol: chain.nativeSymbol,
    chain_namespace: chain.namespace, chain_id: chain.caip2Ref, _native: true, _chain: chain.id }
}

/** Open a canonical contract deep link before it exists in a watchlist. No
 * entity is persisted and a chain's native symbol never names this contract. */
export function contractAssetEntity(key) {
  const canonical=canonicalPortfolioKey(key)
  if(!canonical||canonical.includes(':native'))return null
  const evm=/^eip155:(\d+):(0x[0-9a-f]{40})$/.exec(canonical),sol=/^solana:([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(canonical)
  const chain=evm?CHAINS.find(c=>String(c.evmChainId)===evm[1]):sol?CHAINS.find(c=>c.id==='solana'):null
  const address=evm?.[2]||sol?.[1]
  if(!chain||!address)return null
  return {id:null,canonical_ref_key:key,entity_kind:'asset',asset_type:evm?'erc20':'spl',contract_address:address,
    chain_namespace:chain.namespace,chain_id:chain.caip2Ref,display_symbol:null,_contract:true,_synthetic:true,_chain:chain.id,_address:address}
}

// The existing chart endpoint accepts registered native:<chain> request aliases.
// Preserve the entity's original key for evidence, activity and persistence.
export function assetChartRef(entity) {
  const chain = nativeAssetChain(entity?.canonical_ref_key)
  if(entity?._synthetic&&entity?._contract&&entity?._chain&&entity?._address)return `${entity._chain}:${entity._address}`
  return chain ? `native:${chain.id}` : entity?.canonical_ref_key || null
}

export function normalizeAssetEntity(entity) {
  if (!entity || entity.entity_kind === 'wallet') return entity
  const chain = nativeAssetChain(entity.canonical_ref_key)
  if (!chain) return entity
  return { ...entity, asset_type: 'native', display_symbol: chain.nativeSymbol, native_symbol: chain.nativeSymbol,
    chain_namespace: chain.namespace, chain_id: chain.caip2Ref, _native: true, _chain: chain.id }
}

// Translate only registered chain identities; display symbols never resolve an asset.
export function canonicalPortfolioKey(key) {
  if (typeof key !== 'string' || !key) return null
  const caip = /^([^:]+):([^/]+)\/(native|erc20|spl|token):(.+)$/.exec(key)
  if (caip) {
    const chain = CHAINS.find(c => c.namespace === caip[1] && c.caip2Ref === caip[2])
    if (!chain || (caip[3] === 'native' && caip[4].toUpperCase() !== chain.nativeSymbol)) return null
    return entityPortfolioKey({ _chain: chain.id, _native: caip[3] === 'native', _address: caip[4] })
  }
  const nativeRef = /^native:(.+)$/.exec(key)
  if (nativeRef) return entityPortfolioKey({ _chain: nativeRef[1], _native: true })
  const evm = /^eip155:(\d+):(native|0x[0-9a-f]{40})$/i.exec(key)
  if (evm) return entityPortfolioKey({ chain_namespace: 'eip155', chain_id: evm[1], asset_type: evm[2] === 'native' ? 'native' : 'erc20', contract_address: evm[2] })
  const other = /^([^:]+):(.+)$/.exec(key)
  const chain = other && CHAINS.find(c => c.namespace === other[1] && c.evmChainId == null)
  if (!chain) return null
  if (other[2].startsWith('native:')) return other[2] === `native:${chain.nativeSymbol}` ? key : null
  return key
}

export function assetEntityAliases(key) {
  if (!key) return []
  const ledger = canonicalPortfolioKey(key)
  if (ledger && ledger !== key) return [...new Set([key, ...assetEntityAliases(ledger)])]
  const parts = key.split(':')
  const chain = parts[0] === 'eip155' ? CHAINS.find(c => String(c.evmChainId) === parts[1]) : CHAINS.find(c => c.namespace === parts[0])
  if (!chain) return [key]
  const native = key === (chain.evmChainId != null ? `eip155:${chain.evmChainId}:native` : `${chain.namespace}:native:${chain.nativeSymbol}`)
  const address = parts.slice(chain.evmChainId != null ? 2 : 1).join(':')
  const assetType = native ? 'native' : chain.evmChainId != null ? 'erc20' : 'token'
  return [key, `${chain.namespace}:${chain.caip2Ref}/${assetType}:${native ? chain.nativeSymbol.toLowerCase() : address}`]
}
export function matchesResearchAsset(candidate, ...resolvedKeys) {
  if(typeof candidate!=='string'||!candidate)return false
  const normalized=canonicalPortfolioKey(candidate)||candidate
  return resolvedKeys.filter(Boolean).some(key=>(canonicalPortfolioKey(key)||key)===normalized)
}
