// CoinMarketCap DEX platforms: what is verified, what could be, what we cannot map.
//
// `CMC_DEX_NETWORKS` in cmc-dex.ts is four hardcoded platforms (Ethereum 1,
// Base 199, Arbitrum 51, Solana 16) verified on 2026-09-12 against live
// platform, token, holder and swap responses. It stays a reviewed constant: a
// platform id in a list is not evidence that the token, holder and swap
// endpoints answer correctly for it, and a wrong platform id silently returns
// another chain's token.
//
// This module is the reviewer's worklist, not a widening mechanism. Given the
// rows of `/v1/dex/platform/list` (`{ id, n, dn }` — numeric id, name, display
// name) it answers three questions and nothing else:
//
//   verified   the four platforms already in CMC_DEX_NETWORKS, unchanged.
//   candidates a platform whose name maps to a chain in our registry but which
//              is NOT verified — each with the chain, its address format and the
//              reason it is a candidate. Probe these, then add the ones that
//              answer to CMC_DEX_NETWORKS by hand.
//   unmapped   a platform we carry no chain for. Adding the chain comes first.
//
// Pure: no I/O, no provider call, no constant mutated. `candidateDexPlatforms`
// returning a chain is a hypothesis for a human to test.

import { CHAINS, getChain } from '../chains.ts'
import { CMC_DEX_NETWORKS } from './cmc-dex.ts'

export type DexPlatformRow = { id?: unknown; n?: unknown; dn?: unknown }

export type DexPlatformCandidate = {
  platformId: number
  /** The provider's own name for the platform, as returned. */
  name: string
  /** The app chain id the name matched. */
  chain: string
  /** From the chain registry — what an address on this chain must look like. */
  addressFormat: string
  /** Why this is a candidate and not yet verified. */
  reason: 'chain_known_platform_unverified'
}

export type DexPlatformUnmapped = {
  platformId: number
  name: string
  reason: 'no_chain_in_registry' | 'unreadable_row'
}

export type DexPlatformReview = {
  verified: typeof CMC_DEX_NETWORKS[number][]
  candidates: DexPlatformCandidate[]
  unmapped: DexPlatformUnmapped[]
}

/** Extra spellings CoinMarketCap uses for a chain we already carry. Only
 *  unambiguous aliases belong here: an alias that could name two chains is
 *  worse than no alias, because it sends a contract to the wrong network. */
const PLATFORM_ALIASES: Record<string, string> = {
  // Keys are already normalized: lower-cased, single-spaced, and with a
  // trailing parenthetical stripped, so 'BNB Smart Chain (BEP20)' matches the
  // first entry rather than needing its own.
  'bnb smart chain': 'bnb',
  'binance smart chain': 'bnb',
  bsc: 'bnb',
  'bnb chain': 'bnb',
  'polygon pos': 'polygon',
  'polygon matic': 'polygon',
  matic: 'polygon',
  'avalanche c-chain': 'avalanche',
  'avalanche cchain': 'avalanche',
  avax: 'avalanche',
  'op mainnet': 'optimism',
  'optimism ethereum': 'optimism',
  'arbitrum one': 'arbitrum',
  'zksync era': 'zksync',
  'gnosis chain': 'gnosis',
  xdai: 'gnosis',
  'sei network': 'sei',
  'sui network': 'sui',
  'the open network': 'ton',
  toncoin: 'ton',
  'xrp ledger': 'xrpl',
  xrp: 'xrpl',
  'near protocol': 'near',
  'injective protocol': 'injective',
  'metis andromeda': 'metis',
  'opbnb mainnet': 'opbnb',
  'xdc network': 'xdc',
  'hyperliquid evm': 'hyperliquid',
  hyperevm: 'hyperliquid',
}

const normalize = (value: unknown): string =>
  String(value ?? '').trim().toLowerCase().replace(/[\s_]+/g, ' ').replace(/\s*\(.*\)$/, '').trim()

/** A platform name to an app chain id, or null. Label, id and a short alias
 *  table only — never a prefix or fuzzy match, which is how 'arbitrum nova'
 *  would become 'arbitrum'. */
export function chainForPlatformName(name: unknown): string | null {
  const key = normalize(name)
  if (!key) return null
  if (getChain(key)) return key
  const alias = PLATFORM_ALIASES[key]
  if (alias && getChain(alias)) return alias
  const byLabel = CHAINS.find((c) => normalize(c.label) === key)
  return byLabel ? byLabel.id : null
}

/** Split `/v1/dex/platform/list` into the verified set, the platforms a reviewer
 *  should probe, and the platforms we have no chain for. */
export function candidateDexPlatforms(rows: unknown): DexPlatformReview {
  const verified = [...CMC_DEX_NETWORKS]
  const verifiedIds = new Set<number>(verified.map((n) => n.platformId as number))
  const candidates: DexPlatformCandidate[] = []
  const unmapped: DexPlatformUnmapped[] = []
  const seen = new Set<number>()

  for (const row of Array.isArray(rows) ? rows : []) {
    const record = (row && typeof row === 'object' ? row : {}) as DexPlatformRow
    const platformId = Number(record.id)
    const name = String(record.n ?? record.dn ?? '').trim().slice(0, 80)
    if (!Number.isSafeInteger(platformId) || platformId <= 0 || !name) {
      // A row we cannot read is reported, never dropped: a silent gap in the
      // review list reads as "nothing left to check".
      unmapped.push({ platformId: Number.isSafeInteger(platformId) ? platformId : 0, name, reason: 'unreadable_row' })
      continue
    }
    if (seen.has(platformId)) continue
    seen.add(platformId)
    if (verifiedIds.has(platformId)) continue

    const chain = chainForPlatformName(name) ?? chainForPlatformName(record.dn)
    if (!chain) {
      unmapped.push({ platformId, name, reason: 'no_chain_in_registry' })
      continue
    }
    candidates.push({
      platformId,
      name,
      chain,
      addressFormat: getChain(chain)?.addressFormat ?? 'other',
      reason: 'chain_known_platform_unverified',
    })
  }

  candidates.sort((a, b) => a.platformId - b.platformId)
  unmapped.sort((a, b) => a.platformId - b.platformId)
  return { verified, candidates, unmapped }
}
