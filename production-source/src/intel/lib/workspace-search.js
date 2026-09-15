import { loadMarkets, resolveAsset } from './markets-api'
import { marketIdentityParams } from './asset-identity'
import { detectIdentifierKind } from './chains'
import { formatUsd } from './market-format'

// `t` is optional so the existing call sites keep working; the fallback returns
// the same English default the key carries, never a raw key.
const fallbackText = (key, options) => options?.defaultValue || key

// Contract route for an identifier the catalogue does not list. The universal
// resolver owns the canonical form; this mirrors it for the rows we build
// ourselves (an ambiguous candidate or an unresolved identifier that the reader
// may still want to open).
export const contractRoute = (symbol, chain, address) =>
  `/intel/markets/${encodeURIComponent(String(symbol || 'UNKNOWN').toUpperCase())}?${new URLSearchParams({ provider: 'contract', id: chain && address ? `${chain}:${address}` : String(address || symbol || '') })}`

// Which ladder steps actually answered. Named so a resolved row can say where its
// identity came from instead of presenting it as an unsourced fact.
const hitSources = result => [...new Set((result?.provenance || []).filter(step => step?.outcome === 'hit').map(step => step?.step).filter(Boolean))]

// The Contract result group. Built only when the typed query IS an identifier —
// a plain ticker or project name never spends a resolution.
function contractGroupRows(result, query, t) {
  if (!result || result.status === 'invalid') return []
  const group = t('search.group_contract', { defaultValue: 'Contract' })
  const via = t('resolve.via', { defaultValue: 'via {{sources}}', sources: hitSources(result).join(', ') || t('resolve.no_source', { defaultValue: 'no source' }) })

  if (result.status === 'resolved' && result.identity) {
    const identity = result.identity
    return [{
      to: identity.route || contractRoute(identity.symbol, identity.chain, identity.address),
      label: `${identity.symbol || query} · ${identity.name || ''}`,
      description: `${identity.chain || ''} · ${identity.address || identity.providerId || ''} · ${via}`,
      group,
    }]
  }

  // The chain named the asset and no market source prices it. It is a real,
  // indexed, searchable asset, so it keeps its route and its identity — and it
  // carries its own label, because opening it and finding every price empty
  // without having been told why is the thing this status exists to prevent.
  if (result.status === 'identity_only' && result.identity) {
    const identity = result.identity
    const label = t('resolve.identity_only_label', { defaultValue: 'Identity only' })
    return [{
      to: identity.route || contractRoute(identity.symbol, identity.chain, identity.address),
      label: `${identity.symbol || query} · ${identity.name || ''}`,
      description: `${label} · ${[identity.chain, identity.address || identity.providerId].filter(Boolean).join(' · ')} · ${t('resolve.identity_only_short', { defaultValue: 'the chain answered; no market source prices it' })} · ${via}`,
      group,
    }]
  }

  // The same address on several chains. Liquidity is what tells them apart, so
  // it is part of the row rather than something the reader has to open each to see.
  if (result.status === 'ambiguous') {
    return (result.candidates || []).map(candidate => ({
      to: candidate.route || contractRoute(candidate.symbol, candidate.chain, candidate.address),
      label: `${candidate.symbol || query} · ${candidate.name || ''}`,
      description: [candidate.chain, candidate.address, candidate.liquidityUsd == null ? null : formatUsd(candidate.liquidityUsd), candidate.source].filter(Boolean).join(' · '),
      group,
    }))
  }

  // Unresolved: the reader still gets a way in, and the reason is named rather
  // than swallowed.
  const detected = (result.detected || [])[0] || null
  const hint = t('resolve.unresolved_hint', { defaultValue: 'No provider recognised this identifier. Open it as a contract to see every step that was tried.' })
  return [{
    to: contractRoute(query, detected?.chain, detected?.address || query),
    label: query,
    description: result.reason ? `${hint} ${t(`resolve.reason_${result.reason}`, { defaultValue: result.reason })}` : hint,
    group,
  }]
}

export async function searchIntelAssets(supabase, orgId, query, signal, t = fallbackText) {
  if (!orgId || query.trim().length < 2) return []
  const trimmed = query.trim().slice(0, 100)
  const identifierKind = detectIdentifierKind(trimmed)
  const [data, resolution] = await Promise.all([
    loadMarkets(supabase, orgId, { search: trimmed, limit: 10, page: 0, provider: 'auto', sort: 'market_cap' }, { signal }),
    identifierKind ? resolveAsset(supabase, trimmed, null, { orgId, signal }) : Promise.resolve(null),
  ])
  if (!Array.isArray(data?.rows)) throw new Error('Asset search returned an invalid response. Try again.')
  const catalogue = data.rows.filter(row => row.sourceProvider && row.providerId != null).slice(0, 10).map(row => ({
    to: `/intel/markets/${encodeURIComponent(row.symbol || row.providerId)}${marketIdentityParams(row)}`,
    label: `${row.displayName || row.symbol} · ${row.symbol || ''}`,
    description: `${row.chain || 'Market-wide asset'} · ${row.sourceProvider} · ID ${row.providerId}`,
    group: 'Assets',
  }))
  return [...catalogue, ...contractGroupRows(resolution, trimmed, t)]
}
