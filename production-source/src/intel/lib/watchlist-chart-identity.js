import { canonicalPortfolioKey, nativeAssetChain, marketNativeChain } from './asset-identity'
import { CHAINS } from './chains'
export function watchlistChartInput(asset) {
  const provider = /^market:(coinmarketcap|coingecko):(.+)$/.exec(asset || '')
  const native = nativeAssetChain(asset) || (provider && CHAINS.find(chain => chain.id === marketNativeChain(provider[1], provider[2])))
  if (native) return { kind: 'asset', chain: native.id, value: `native:${native.id}`, itemType: 'token' }
  const key = canonicalPortfolioKey(asset)
  if (!key) return null
  const parts = key.split(':'), chain = parts[0] === 'eip155' ? CHAINS.find(chain => String(chain.evmChainId) === parts[1]) : CHAINS.find(chain => chain.namespace === parts[0])
  const value = parts.slice(parts[0] === 'eip155' ? 2 : 1).join(':')
  return chain && value && !value.startsWith('native') ? { kind: 'asset', chain: chain.id, value, itemType: 'token' } : null
}
