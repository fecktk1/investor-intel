// Investor Intel — canonical asset identity (frontend mirror).
//
// Mirrors supabase/functions/_shared/investor-portfolio/canonical.ts (which is
// authoritative). Same deterministic key so the UI can group/dedupe/link assets
// identically to the backend.

import { getChain } from './chains'

export const WSOL_MINT = 'So11111111111111111111111111111111111111112'
export const SOL_NATIVE_KEY = 'solana:native:SOL'

function isEvmFamilyDef(c) {
  return !!c && (c.chainFamily === 'evm' || c.evmChainId != null)
}

export function canonicalAssetKey(chain, address, nativeSymbol) {
  const chainId = String(chain || '').trim().toLowerCase()
  if (!chainId) return null
  const c = getChain(chainId)
  const addr = String(address || '').trim()

  if ((c?.id === 'solana' || chainId.toLowerCase() === 'solana')
      && addr === WSOL_MINT) {
    return SOL_NATIVE_KEY
  }

  if (!c) {
    const ns = chainId.toLowerCase()
    if (addr) return `${ns}:${addr}`
    return `${ns}:native:${String(nativeSymbol || ns).toUpperCase()}`
  }

  const evm = isEvmFamilyDef(c)
  if (addr) {
    if (evm) return `eip155:${c.evmChainId}:${addr.toLowerCase()}`
    return `${c.namespace}:${addr}`
  }
  if (evm) return `eip155:${c.evmChainId}:native`
  const sym = String(nativeSymbol || c.nativeSymbol || c.namespace).toUpperCase()
  return `${c.namespace}:native:${sym}`
}

export function isNativeKey(key) {
  if (!key) return false
  return /:native(:|$)/.test(key)
}

export function shortenId(idOrKey) {
  const s = String(idOrKey || '')
  const tail = s.includes(':') ? s.split(':').pop() : s
  if (tail.length <= 12) return tail
  return `${tail.slice(0, 4)}…${tail.slice(-4)}`
}
