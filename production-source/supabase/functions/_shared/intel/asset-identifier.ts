// Investor Intel — universal asset-identifier detection (pure, no I/O).
//
// One paste box has to accept an identifier for every chain in the registry, not
// just EVM hex and Solana mints. This module answers a single question: "what
// shape is this string, and which (namespace, chain) pairs could it belong to?"
// It never contacts a provider and never guesses an identity from a ticker —
// a symbol is not an identity, so "BTC" is invalid here on purpose.
//
// Chain ambiguity is expressed, not hidden: an EVM hex address yields one
// candidate per eip155 chain in CHAINS (a chainHint narrows it to one), and the
// base58 families that overlap (Tron / XRPL account ids vs Solana mints) yield
// the more specific namespace first with the overlap kept as a lower-confidence
// second candidate. The resolver walks candidates in order.

import { CHAINS, getChain } from '../chains.ts'

export type IdentifierKind =
  | 'evm'
  | 'solana'
  | 'move_coin_type'
  | 'ton'
  | 'tron'
  | 'xrpl'
  | 'stellar'
  | 'near'
  | 'cardano'
  | 'cosmos_denom'
  | 'hyperliquid'
  | 'cmc_id'
  | 'unknown'

export type IdentifierCandidate = {
  /** CAIP-2 namespace (or the documented app extension), 'cmc' for a CoinMarketCap id. */
  namespace: string
  /** App chain id from CHAINS, or null when the identifier is not chain-bound. */
  chain: string | null
  /** The identifier as pasted (canonicalAddress() applies the per-namespace form). */
  address: string
  /** 0..1 — 1 when a single reading is possible, 1/n when n readings are. */
  confidence: number
}

export type DetectedIdentifier = {
  kind: IdentifierKind
  raw: string
  candidates: IdentifierCandidate[]
  invalid?: string
}

export type DetectOptions = { chainHint?: string | null }

export const MAX_IDENTIFIER_LENGTH = 200

// ── Format regexes ───────────────────────────────────────────────────────────
const BASE58 = '[1-9A-HJ-NP-Za-km-z]'
const EVM_RE = /^0x[0-9a-fA-F]{40}$/
const EVM_PARTIAL_RE = /^0x[0-9a-fA-F]{1,64}$/
const SOLANA_RE = new RegExp(`^${BASE58}{32,44}$`)
const MOVE_COIN_TYPE_RE = /^0x[0-9a-fA-F]{1,64}::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*$/
const TON_FRIENDLY_RE = /^[EU]Q[A-Za-z0-9_-]{46}$/
const TON_RAW_RE = /^(?:-1|0):[0-9a-fA-F]{64}$/
const TRON_RE = new RegExp(`^T${BASE58}{33}$`)
const XRPL_ACCOUNT_RE = new RegExp(`^r${BASE58}{24,34}$`)
const XRPL_IOU_RE = new RegExp(`^([A-Za-z0-9]{3}|[0-9A-Fa-f]{40})\\.(r${BASE58}{24,34})$`)
const STELLAR_ACCOUNT_RE = /^G[A-Z2-7]{55}$/
const STELLAR_ASSET_RE = /^([A-Za-z0-9]{1,12})-(G[A-Z2-7]{55})$/
const NEAR_NAMED_RE = /^(?:[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\.)?near$/
const NEAR_IMPLICIT_RE = /^[0-9a-f]{64}$/
const CARDANO_RE = /^([0-9a-f]{56})(?:\.([0-9a-f]{2,64}))?$/
const IBC_DENOM_RE = /^ibc\/[0-9A-Fa-f]{64}$/
const FACTORY_DENOM_RE = /^factory\/[A-Za-z0-9]{6,90}\/[A-Za-z0-9/:._-]{1,64}$/
const PEGGY_DENOM_RE = /^peggy0x[0-9a-fA-F]{40}$/
const HYPERLIQUID_SPOT_RE = /^@\d{1,6}$/
const HYPERLIQUID_PAIR_RE = /^[A-Za-z0-9]{2,12}\/USDC$/
const CMC_PREFIXED_RE = /^cmc:(\d{1,9})$/i
const CMC_BARE_RE = /^\d{1,9}$/
const TICKER_RE = /^\$?[A-Za-z]{1,12}$/
// Whitespace, quotes, brackets, control bytes and shell/SQL punctuation are part
// of no supported identifier — and are what an injection probe looks like.
// Rejecting them up front is why an invalid query costs zero provider calls.
const UNSAFE_RE = /[\s<>"'`;()|&=%*\[\]{}]/
const hasControlBytes = (value: string): boolean => {
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) < 32) return true
  return false
}

export const EVM_CHAIN_IDS = CHAINS.filter((c) => c.namespace === 'eip155').map((c) => c.id)

/** Canonical stored form for an address: EVM lowercases, every other namespace
 *  is case-significant and is only trimmed. */
export function canonicalAddress(namespace: string, address: string): string {
  const value = String(address ?? '').trim()
  return namespace === 'eip155' ? value.toLowerCase() : value
}

function candidate(namespace: string, chain: string | null, address: string, confidence: number): IdentifierCandidate {
  return { namespace, chain, address, confidence: Number(confidence.toFixed(4)) }
}

function spread(chains: string[], address: string): IdentifierCandidate[] {
  const weight = chains.length ? 1 / chains.length : 1
  return chains.map((id) => candidate(getChain(id)?.namespace || id, id, address, weight))
}

function invalid(raw: string, reason: string): DetectedIdentifier {
  return { kind: 'unknown', raw, candidates: [], invalid: reason }
}

function detected(kind: IdentifierKind, raw: string, candidates: IdentifierCandidate[]): DetectedIdentifier {
  return { kind, raw, candidates }
}

/**
 * Detect the format of a pasted identifier.
 *
 * `chainHint` (an app chain id) narrows the candidate list; when the hint is a
 * chain the format cannot belong to, the result is invalid with
 * `chain_hint_mismatch` rather than a silently different chain.
 */
export function detectIdentifier(raw: unknown, options: DetectOptions = {}): DetectedIdentifier {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) return invalid('', 'empty_query')
  if (value.length > MAX_IDENTIFIER_LENGTH) return invalid(value.slice(0, MAX_IDENTIFIER_LENGTH), 'too_long')
  if (UNSAFE_RE.test(value) || hasControlBytes(value)) return invalid(value, 'unsupported_characters')
  if (/:\/\//.test(value) || /^www\./i.test(value)) return invalid(value, 'url_not_an_identity')

  const hint = options.chainHint ? String(options.chainHint).trim() : ''
  const hinted = hint ? getChain(hint) : null
  if (hint && !hinted) return invalid(value, 'unknown_chain_hint')

  const result = classify(value)
  if (result.invalid || !hinted) return result

  const narrowed = result.candidates.filter((c) => c.chain === hinted.id)
  if (!narrowed.length) return invalid(value, 'chain_hint_mismatch')
  return detected(result.kind, value, narrowed.map((c) => candidate(c.namespace, c.chain, c.address, 1)))
}

function classify(value: string): DetectedIdentifier {
  // CoinMarketCap ids are identities in their own right (no chain).
  const cmc = CMC_PREFIXED_RE.exec(value)
  if (cmc) return detected('cmc_id', value, [candidate('cmc', null, cmc[1], 1)])
  if (CMC_BARE_RE.test(value)) return detected('cmc_id', value, [candidate('cmc', null, value, 1)])

  // Hyperliquid spot ids / native pairs.
  if (HYPERLIQUID_SPOT_RE.test(value) || HYPERLIQUID_PAIR_RE.test(value)) {
    return detected('hyperliquid', value, [candidate('hyperliquid', 'hyperliquid', value, 1)])
  }

  // Cosmos-style denoms (Injective is the registry's cosmos chain).
  if (IBC_DENOM_RE.test(value) || FACTORY_DENOM_RE.test(value) || PEGGY_DENOM_RE.test(value)) {
    return detected('cosmos_denom', value, [candidate('injective', 'injective', value, 1)])
  }

  // Move coin types are shared by Sui and Aptos; both are candidates.
  if (MOVE_COIN_TYPE_RE.test(value)) return detected('move_coin_type', value, spread(['sui', 'aptos'], value))

  // EVM hex — chain-ambiguous across every eip155 chain in the registry.
  if (EVM_RE.test(value)) return detected('evm', value, spread(EVM_CHAIN_IDS, value))

  if (TON_FRIENDLY_RE.test(value) || TON_RAW_RE.test(value)) {
    return detected('ton', value, [candidate('ton', 'ton', value, 1)])
  }

  // Tron account ids are base58 and overlap the Solana mint shape; keep both,
  // Tron first, so the resolver tries the more specific reading before Solana.
  if (TRON_RE.test(value)) {
    const overlaps = SOLANA_RE.test(value)
    return detected('tron', value, overlaps
      ? [candidate('tron', 'tron', value, 0.7), candidate('solana', 'solana', value, 0.3)]
      : [candidate('tron', 'tron', value, 1)])
  }

  const iou = XRPL_IOU_RE.exec(value)
  if (iou) return detected('xrpl', value, [candidate('xrpl', 'xrpl', value, 1)])
  if (XRPL_ACCOUNT_RE.test(value)) {
    const overlaps = SOLANA_RE.test(value)
    return detected('xrpl', value, overlaps
      ? [candidate('xrpl', 'xrpl', value, 0.7), candidate('solana', 'solana', value, 0.3)]
      : [candidate('xrpl', 'xrpl', value, 1)])
  }

  if (STELLAR_ASSET_RE.test(value) || STELLAR_ACCOUNT_RE.test(value)) {
    return detected('stellar', value, [candidate('stellar', 'stellar', value, 1)])
  }

  if (NEAR_NAMED_RE.test(value)) return detected('near', value, [candidate('near', 'near', value, 1)])
  if (NEAR_IMPLICIT_RE.test(value)) return detected('near', value, [candidate('near', 'near', value, 1)])

  if (CARDANO_RE.test(value)) return detected('cardano', value, [candidate('cardano', null, value, 1)])

  if (SOLANA_RE.test(value)) return detected('solana', value, [candidate('solana', 'solana', value, 1)])

  // Everything that remains is either a near-miss address or not an identity.
  if (EVM_PARTIAL_RE.test(value)) return invalid(value, 'malformed_evm_address')
  if (TICKER_RE.test(value)) return invalid(value, 'symbol_not_an_identity')
  return invalid(value, 'unrecognized_identifier')
}

/** Parse an XRPL issued asset (`<CURRENCY>.<r-address>`) into its parts. */
export function parseXrplIou(value: string): { currency: string; issuer: string } | null {
  const m = XRPL_IOU_RE.exec(String(value || '').trim())
  return m ? { currency: m[1], issuer: m[2] } : null
}

/** Parse a Stellar issued asset (`<CODE>-<G-address>`) into its parts. */
export function parseStellarAsset(value: string): { code: string; issuer: string } | null {
  const m = STELLAR_ASSET_RE.exec(String(value || '').trim())
  return m ? { code: m[1], issuer: m[2] } : null
}
