import { CHAINS } from '../chains.ts'
import { researchIdentity, type AssetEvidenceSubject } from './research-identity.ts'
import { marketCanonicalIdentity } from './market-read-quality.ts'

export function briefSubject(row: any): AssetEvidenceSubject | null {
  let key = String(row?.canonicalKey || row?.canonical_asset_key || row?.canonical_ref_key || '').trim()
  key = key.replace(/^(eip155:\d+)\/(?:erc20|token):/, '$1:')
    .replace(/^solana:mainnet\/(?:spl|token):/, 'solana:')
  if (!key) return null
  const chain = row.chain || CHAINS.find(c => c.namespace === row.chain_namespace && c.caip2Ref === row.chain_id)?.id
  return researchIdentity({ canonicalKey: key, chain: chain || null,
    tokenAddress: row.tokenAddress || row.contract_address || null,
    symbol: row.symbol || row.display_symbol || row.asset_symbol || null })
}

/** Legacy ticker signals are applicable only to a verified native identity.
 * Contract tokens require an explicit canonical reference on the signal. */
export function briefSignalMatches(row: any, signal: any): boolean {
  const subject = briefSubject(row)
  if (!subject) return false
  const references = [signal.subject_id, signal.canonical_asset_key, ...(Array.isArray(signal.related_assets) ? signal.related_assets : [])]
  if (references.some(ref => typeof ref === 'string' && (ref === row.id || briefSubject({canonicalKey:ref})?.canonicalKey === subject.canonicalKey))) return true
  const nativeSymbol = briefNativeSymbol(row)
  return !!nativeSymbol && String(signal.display_symbol || '').toUpperCase() === nativeSymbol
}

export function briefNativeSymbol(row: any): string | null {
  const subject = briefSubject(row)
  if (!subject?.providerId || subject.tokenAddress) return null
  const native = subject.canonicalKey?.includes('native:') || subject.canonicalKey?.endsWith(':native')
    || marketCanonicalIdentity({source_provider:subject.sourceProvider,provider_id:subject.providerId}).canonicalAssetKey?.includes(':native')
  return native ? subject.symbol?.toUpperCase() || null : null
}
