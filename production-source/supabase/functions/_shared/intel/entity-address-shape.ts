// Investor Intel — does this identifier belong to the chain that was picked?
//
// The entity resolver used to accept anything a caller typed and mint a
// canonical key from it, so pasting an Ethereum contract while the chain picker
// still said Solana produced `solana:mainnet/token:0x5149…` — a row no chart,
// catalogue or provider can ever match. The add looked accepted and the token
// never appeared. One shape check per chain family closes that, and the refusal
// names the mismatch instead of failing quietly.
//
// This is a SHAPE check only. It says the string cannot be an address on that
// chain; it never claims the token exists.

import { getChain, type AddressFormat } from '../chains.ts'

export const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
export const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const TRON_ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/
const MOVE_RE = /^0x[0-9a-fA-F]{1,64}(?:::[A-Za-z_][A-Za-z0-9_]*){0,2}$/
const CARDANO_RE = /^[0-9a-fA-F]{56}(?:\.[0-9a-fA-F]{2,64})?$/

export type AddressShapeRefusal = {
  code: 'entity_address_shape'
  chain: string        // app chain id the caller picked
  chainLabel: string   // human label for that chain
  expected: AddressFormat
  looksLike: string | null  // the chain family the value does look like, when we can tell
}

/** The family a pasted identifier plausibly belongs to, or null when unknown. */
export function looksLikeFamily(value: string): string | null {
  if (EVM_ADDRESS_RE.test(value)) return 'evm'
  if (TRON_ADDRESS_RE.test(value)) return 'tron'
  if (SOLANA_ADDRESS_RE.test(value)) return 'solana'
  return null
}

// Only the formats we can refuse with certainty are checked. Bitcoin, Cosmos,
// Stellar, NEAR, TON and XRPL identifiers stay permissive apart from the one
// case that is always wrong: an EVM contract address on a non-EVM chain.
function matchesFormat(format: AddressFormat, value: string): boolean {
  switch (format) {
    case 'evm_hex': return EVM_ADDRESS_RE.test(value)
    case 'base58': return SOLANA_ADDRESS_RE.test(value)
    case 'tron_base58': return TRON_ADDRESS_RE.test(value)
    case 'sui_hex': return MOVE_RE.test(value)
    case 'cardano_policy': return CARDANO_RE.test(value)
    default: return !EVM_ADDRESS_RE.test(value)
  }
}

/**
 * Returns null when `value` could be an address on `chainId`, or a refusal
 * describing the mismatch. Native references ("native:solana", "ETH") are the
 * caller's business and are never shape-checked here.
 */
export function refuseAddressShape(chainId: string, value: string): AddressShapeRefusal | null {
  const chain = getChain(String(chainId || ''))
  const raw = String(value || '').trim()
  if (!chain || !raw) return null
  const format: AddressFormat = chain.addressFormat || 'other'
  if (matchesFormat(format, raw)) return null
  return {
    code: 'entity_address_shape',
    chain: chain.id,
    chainLabel: chain.label,
    expected: format,
    looksLike: looksLikeFamily(raw),
  }
}
