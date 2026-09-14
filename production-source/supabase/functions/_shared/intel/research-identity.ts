import { CHAINS, CHAIN_COINGECKO } from '../chains.ts'
// Shared identity contract lives here so pure identity consumers do not need
// the evidence assembler (and its provider dependencies) even for type checks.
export interface AssetEvidenceSubject {
  symbol?: string | null
  canonicalKey?: string | null
  chain?: string | null
  providerId?: string | null
  sourceProvider?: string | null
  tokenAddress?: string | null
  orgId?: string | null
  userId?: string | null
}

function nativeChain(key: string) {
  return CHAINS.find(c => key === `native:${c.id}` || key === `${c.namespace}:${c.caip2Ref}/native:${c.nativeSymbol.toLowerCase()}`
    || key === (c.evmChainId != null ? `eip155:${c.evmChainId}:native` : `${c.namespace}:native:${c.nativeSymbol}`))
}

export function researchIdentity(input: AssetEvidenceSubject): AssetEvidenceSubject {
  const key = input.canonicalKey || ''
  const market = /^market:(coingecko|coinmarketcap):([^:]+)$/.exec(key)
  if (market) return { ...input, sourceProvider: market[1], providerId: market[2] }
  for (const chain of CHAINS) {
    const prefix = chain.evmChainId != null ? `eip155:${chain.evmChainId}:` : `${chain.namespace}:`
    const caipPrefix = `${chain.namespace}:${chain.caip2Ref}/`
    const caip = key.startsWith(caipPrefix) ? key.slice(caipPrefix.length) : null
    if (caip && !(chain.evmChainId != null ? /^(?:erc20|token):/.test(caip) : chain.id === 'solana' && /^(?:spl|token):/.test(caip))) continue
    const raw = caip ?? (key.startsWith(prefix) ? key.slice(prefix.length) : key.startsWith(`${chain.id}:token:`) ? key.slice(`${chain.id}:token:`.length) : null)
    if (!raw || raw.startsWith('native') || raw.includes('/')) continue
    const address = raw.replace(/^(?:erc20|spl|token):/, '')
    if (chain.evmChainId != null && !/^0x[0-9a-f]{40}$/i.test(address)) continue
    if (chain.id === 'solana' && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) continue
    if (/\s/.test(address) || address.length > 240) continue
    return { ...input, chain: chain.id, tokenAddress: chain.evmChainId != null ? address.toLowerCase() : address }
  }
  const chain = nativeChain(key)
  if (!chain || !CHAIN_COINGECKO[chain.id]) return key ? { ...input, sourceProvider:null, providerId:null } : input
  return { ...input, chain:chain.id, symbol:chain.nativeSymbol, sourceProvider:'coingecko', providerId:CHAIN_COINGECKO[chain.id], tokenAddress:null }
}

// Verified cross-provider native identities. A display symbol never resolves one.
const NATIVE_CMC_IDS: Record<string,string> = {bitcoin:'1',ethereum:'1027',solana:'5426',binancecoin:'1839','avalanche-2':'5805'}
/** Provider aliases from the same registered native identities, never symbols. */
export function nativeResearchProviderKeys(canonicalKey:string):string[] {
  const identity=researchIdentity({canonicalKey})
  if(identity.tokenAddress)return []
  const cmc=researchCmcId({canonicalKey})
  const cg=identity.sourceProvider==='coingecko'?identity.providerId:Object.entries(NATIVE_CMC_IDS).find(([,id])=>id===cmc)?.[0]
  if(!cg||!NATIVE_CMC_IDS[cg]||!cmc)return []
  return [`market:coinmarketcap:${cmc}`,`market:coingecko:${cg}`]
}
export function researchCmcId(input: AssetEvidenceSubject): string | null {
  const identity = researchIdentity(input), key = input.canonicalKey
  if (identity.tokenAddress) return null
  // An unrecognized explicit network/contract cannot be repaired by a hint for
  // another asset. Only provider-qualified references and registered natives map.
  if (key && !/^market:(?:coingecko|coinmarketcap):[^:]+$/.test(key) && !nativeChain(key)) return null
  if (identity.sourceProvider === 'coinmarketcap') return /^[1-9][0-9]{0,11}$/.test(identity.providerId || '') ? identity.providerId! : null
  return identity.sourceProvider === 'coingecko' ? NATIVE_CMC_IDS[identity.providerId || ''] ?? null : null
}
