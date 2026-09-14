import { CHAINS } from './chains'

export function manualAssetIdentity(tx) {
  const chain = CHAINS.find(c => c.id === tx.chain)
  if (!chain) throw new Error('Choose a supported network.')
  const symbol = String(tx.symbol || '').trim().replace(/^\$/, '').toUpperCase()
  const address = String(tx.contractAddress || '').trim()
  const kind = tx.assetKind || (address ? 'token' : 'native')
  if (!['native', 'token'].includes(kind)) throw new Error('Choose native asset or token.')
  if (kind === 'native') {
    if (address || symbol !== chain.nativeSymbol) throw new Error(`The native asset on ${chain.label} is ${chain.nativeSymbol}. For another asset, select Token and enter its contract or mint.`)
    return { symbol, contractAddress: null, kind }
  }
  if (!address) throw new Error('Enter the token contract or mint. A symbol alone cannot identify a token.')
  if (address.length > 240 || /\s/.test(address)) throw new Error('Enter a valid contract or mint.')
  if (chain.evmChainId != null && !/^0x[0-9a-f]{40}$/i.test(address)) throw new Error('An EVM token contract must be a 0x address with 40 hexadecimal characters.')
  if (chain.id === 'solana' && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) throw new Error('Enter a valid Solana mint address.')
  return { symbol, contractAddress: chain.evmChainId != null ? address.toLowerCase() : address, kind }
}
