import { canonicalPortfolioKey } from './asset-identity'

export const thesisCanonicalKey = thesis => thesis?.subject_canonical_key || thesis?.entity?.canonical_ref_key || null
export function thesisAssetLabel(thesis) {
  const key = thesisCanonicalKey(thesis), entity = thesis?.entity
  const frozen = thesis?.baseline?.price_snapshot?.asset
  if (key && frozen?.canonical_key === key && frozen.symbol) return frozen.symbol
  const same = key && canonicalPortfolioKey(key) === canonicalPortfolioKey(entity?.canonical_ref_key)
  if (same && entity.display_symbol) return entity.display_symbol
  const contract = /(?:erc20:|spl:|0x[a-fA-F0-9]{40})/.test(key || '') || !!entity?.contract_address
  if (same && !contract && entity.native_symbol) return entity.native_symbol
  return key || null
}
