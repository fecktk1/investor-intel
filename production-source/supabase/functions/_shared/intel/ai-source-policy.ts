import {loadCmcOperatingSettings,cmcPolicyEnvironment} from '../market-assets/cmc-operating-settings.ts'
// Source-specific processing permission, separate from display/retention rights.
export const cmcAiAllowed = () => Deno.env.get('CMC_ALLOW_AI_PROCESSING') === 'true'
export async function loadCmcAiAllowed(db:any){return cmcPolicyEnvironment(await loadCmcOperatingSettings(db),key=>Deno.env.get(key))('CMC_ALLOW_AI_PROCESSING')==='true'}
const sourceFields = new Set(['provider', 'providers', 'source', 'source_provider', 'sourceProvider', 'source_ref', 'sourceRef', 'source_url', 'sourceUrl', 'canonical_ref_key', 'canonicalKey', 'entity_ref', 'market_cap_source', 'price_source', 'volume_source'])
const cmcSource = (value: string) => /^(?:cmc|coinmarketcap)$/i.test(value.trim()) || /^market:(?:cmc|coinmarketcap):/i.test(value) || /https?:\/\/(?:pro-api\.|www\.)?coinmarketcap\.com(?:\/|$)/i.test(value)
export function containsCmcOrigin(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsCmcOrigin)
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(([key, child]) =>
    (sourceFields.has(key) && (typeof child === 'string' ? cmcSource(child) : Array.isArray(child) && child.some(v => typeof v === 'string' && cmcSource(v)))) || containsCmcOrigin(child))
}

const derivedPacks = new Set(['asset_evidence_pack', 'asset_evidence_packs', 'brief_evidence_pack', 'narrative_evidence_pack', 'prompt_pack'])
export function prepareAiContext<T>(value: T, allowed = cmcAiAllowed()): T {
  if (allowed) return value
  const visit = (node: unknown, field = ''): unknown => {
    if (derivedPacks.has(field) && containsCmcOrigin(node)) return undefined
    if (Array.isArray(node)) return node.map(v => visit(v)).filter(v => v !== undefined)
    if (!node || typeof node !== 'object') return node
    const row = node as Record<string, unknown>
    // A provider tag belongs to the entire row, never just to its label.
    if (Object.entries(row).some(([key, v]) => sourceFields.has(key) && (typeof v === 'string' ? cmcSource(v) : Array.isArray(v) && v.some(x => typeof x === 'string' && cmcSource(x))))) return undefined
    return Object.fromEntries(Object.entries(row).map(([key, child]) => [key, visit(child, key)]).filter(([, child]) => child !== undefined))
  }
  return visit(value) as T
}

// Market readings must come from verified server caches, regardless of a client
// labeling a copied CMC snapshot as CoinGecko or omitting its source field.
export function prepareClientAiContext(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const untrustedMarketBlocks = new Set(['exchange_market', 'token_profile', 'market_snapshot', 'asset_snapshot', 'asset_evidence_pack', 'asset_evidence_packs', 'brief_evidence_pack', 'narrative_evidence_pack'])
  return Object.fromEntries(Object.entries(value).filter(([key]) => !untrustedMarketBlocks.has(key)))
}
