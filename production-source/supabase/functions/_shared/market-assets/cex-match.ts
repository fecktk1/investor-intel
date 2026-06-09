// Market Assets — confidence-gated CEX identity matcher (G1).
//
// CEX (Binance/Coinbase/Kraken/KuCoin) data is ENRICHMENT on the canonical
// top-N. A canonical asset must NOT be attached to CEX data on a bare symbol
// match — symbols collide across wrapped/bridged/old/meme listings. We grade the
// match and the read path renders spread/arbitrage ONLY for `high` confidence.
//
// Priority (high → low):
//   1. admin/exchange mapping with a contract address that matches a canonical
//      platform contract, or whose canonical_asset_id == this provider_id        → high
//   2. admin/exchange mapping marked admin_override/provider_id/native_asset      → high
//   3. curated major symbol, unambiguous in the canonical set                     → high
//   4. unambiguous symbol with a CEX profile (single canonical claimant)          → medium
//   5. ambiguous / wrapped / multi-claimant symbol with a CEX profile             → low
//   6. no CEX profile                                                             → unknown (no coverage)

import { EXCLUDED_BASES, MAJOR_SYMBOLS, normalizeBase } from '../exchange-market/entity-mapping.ts'

export type EnrichmentConfidence = 'high' | 'medium' | 'low' | 'unknown'

// deno-lint-ignore no-explicit-any
type Profile = Record<string, any>
// deno-lint-ignore no-explicit-any
type Mapping = Record<string, any>

export interface CexMatchInput {
  normalizedSymbol: string | null
  providerId: string
  platforms: Record<string, string> | null   // canonical platform contracts
}

export interface CexMatchCtx {
  profileBySym: Map<string, Profile>          // exchange_latest_asset_profiles by normalized_symbol
  mappingBySym: Map<string, Mapping>          // exchange_asset_mappings by normalized_symbol (active)
  symbolCounts: Map<string, number>           // how many canonical assets claim each normalized_symbol
}

export interface CexMatch {
  profile: Profile | null
  confidence: EnrichmentConfidence
  reason: string
}

/** Count how many canonical assets claim each normalized symbol (ambiguity map). */
export function buildSymbolCounts(assets: Array<{ normalizedSymbol: string | null }>): Map<string, number> {
  const m = new Map<string, number>()
  for (const a of assets) { const s = a.normalizedSymbol; if (!s) continue; m.set(s, (m.get(s) || 0) + 1) }
  return m
}

function platformAddrSet(platforms: Record<string, string> | null): Set<string> {
  const s = new Set<string>()
  if (!platforms) return s
  for (const v of Object.values(platforms)) if (typeof v === 'string' && v.trim()) s.add(v.trim().toLowerCase())
  return s
}

export function matchCexEnrichment(asset: CexMatchInput, ctx: CexMatchCtx): CexMatch {
  const sym = asset.normalizedSymbol ? normalizeBase(asset.normalizedSymbol) : null
  if (!sym) return { profile: null, confidence: 'unknown', reason: 'no_symbol' }

  const profile = ctx.profileBySym.get(sym) || null
  const mapping = ctx.mappingBySym.get(sym) || null
  const count = ctx.symbolCounts.get(sym) || 0
  const unambiguous = count <= 1
  const excluded = EXCLUDED_BASES.has(sym)

  // 1-2. sanctioned mapping
  if (mapping && mapping.is_active !== false) {
    const addrs = platformAddrSet(asset.platforms)
    if (mapping.contract_address && addrs.has(String(mapping.contract_address).toLowerCase())) {
      return { profile, confidence: 'high', reason: 'mapping_contract_match' }
    }
    if (mapping.canonical_asset_id && asset.providerId && String(mapping.canonical_asset_id) === String(asset.providerId)) {
      return { profile, confidence: 'high', reason: 'mapping_canonical_id_match' }
    }
    const src = String(mapping.mapping_source || '')
    if (['admin_override', 'provider_id', 'native_asset', 'native'].includes(src)) {
      return { profile, confidence: 'high', reason: `mapping_${src}` }
    }
    return { profile, confidence: profile ? 'medium' : 'unknown', reason: 'mapping_unspecified' }
  }

  // 3. curated major, unambiguous
  if (!excluded && unambiguous && MAJOR_SYMBOLS.has(sym) && profile) {
    return { profile, confidence: 'high', reason: 'curated_major_unambiguous' }
  }

  // no CEX coverage at all
  if (!profile) return { profile: null, confidence: 'unknown', reason: 'no_cex_profile' }

  // 4. unambiguous symbol with a profile
  if (unambiguous && !excluded) return { profile, confidence: 'medium', reason: 'symbol_unambiguous' }

  // 5. ambiguous or wrapped/bridged → low (never drives spread/arb)
  return { profile, confidence: 'low', reason: excluded ? 'wrapped_or_bridged' : 'symbol_ambiguous' }
}
