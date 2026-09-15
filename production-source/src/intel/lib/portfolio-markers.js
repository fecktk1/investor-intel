import { CHAINS } from './chains'

// A view of existing ledger events, never an accounting or pricing input.
const ESTIMATES = new Set(['current_price_estimate', 'zero_value_unpriced'])
const numberOrNull = (value) => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value)

export function portfolioEventMarkers(events, { portfolioId, canonicalAssetKey } = {}) {
  const seen = new Set()
  return (events || []).flatMap((event) => {
    const eventKey = event.eventKey || `${event.kind}:${event.id}`
    const t = Date.parse(event.timestamp)
    if (seen.has(eventKey) || !Number.isFinite(t) || event.is_display_mirror) return []
    seen.add(eventKey)
    const legs = (event.lineItems || []).filter((leg) => leg.canonical_asset_key === canonicalAssetKey)
    const feeOnly = !legs.length && event.feeMatchesAsset
    if (!legs.length && !feeOnly) return []
    const directions = new Set(legs.map((leg) => leg.direction).filter(Boolean))
    const direction = feeOnly ? 'out' : directions.size === 1 ? [...directions][0] : null
    const amounts = legs.map((leg) => numberOrNull(leg.amount))
    const quantity = event.lineItemsTruncated ? null : feeOnly ? numberOrNull(event.feeAmount)
      : direction && amounts.every((n) => n != null) ? amounts.reduce((a, b) => a + b, 0) : null
    const leg = legs.length === 1 ? legs[0] : null
    const estimatedPrice = leg && ESTIMATES.has(leg.price_source_at_tx)
    const type = feeOnly ? 'fee' : event.type || 'unknown'
    const action = type.replace(/_/g, ' ')
    const status = event.status || 'unknown'
    const label = `${action.charAt(0).toUpperCase()}${action.slice(1)}${status !== 'success' ? ` · ${status}` : ''}`
    return [{
      id: `portfolio:${portfolioId}:${eventKey}`, t, type, group: 'portfolio', label, action,
      notes: event.notes || null, summary: event.summary || null, status, quantity, direction,
      recordedAt: event.recordedAt || null, createdAt: event.createdAt || null,
      tokenSymbol: leg?.symbol || legs[0]?.symbol || (feeOnly ? event.feeAsset : null),
      portfolioId, canonicalAssetKey, sourceRef: { kind: event.kind, id: event.id, sourceId: event.sourceId },
      transactionRef: event.txRef || null, protocol: event.protocol || null,
      source: event.sourceLabel || event.provider || (event.kind === 'manual' ? 'Manual' : null),
      executionPrice: !estimatedPrice && status === 'success' ? numberOrNull(leg?.price_usd_at_tx) : null,
      executionValue: !estimatedPrice && status === 'success' ? numberOrNull(leg?.value_usd_at_tx) : null,
      recordedExecutionPrice: !estimatedPrice && status === 'success' ? numberOrNull(leg?.recorded_price) : null,
      executionCurrency: leg?.quote_currency || null,
      priceSource: leg?.price_source_at_tx || null,
      fee: { asset: event.feeAsset || null, amount: numberOrNull(event.feeAmount), usd: numberOrNull(event.feeUsd), appliesToAsset: !!event.feeMatchesAsset },
      event: { ...event, lineItems: event.lineItems || [] },
    }]
  })
}

export function resolvePortfolioSelection(portfolios, explicitId, selectedId) {
  if (explicitId) return portfolios.some((p) => p.id === explicitId) ? explicitId : null
  return (portfolios.find((p) => p.id === selectedId) || portfolios.find((p) => p.is_default) || portfolios[0])?.id || null
}

// datetime-local has no timezone suffix: seed it with wall-clock components,
// rather than displaying UTC components and reinterpreting them as local later.
export function localDateTimeValue(date = new Date()) {
  const pad = (v) => String(v).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function portfolioAssetChartRef(key) {
  if (!key) return null
  const parts = key.split(':')
  const chain = parts[0] === 'eip155'
    ? CHAINS.find((c) => c.evmChainId != null && String(c.evmChainId) === parts[1])
    : CHAINS.find((c) => c.namespace === parts[0])
  if (!chain) return null
  const native = parts[0] === 'eip155' ? parts.length === 3 && parts[2] === 'native'
    : parts.length === 3 && parts[1] === 'native' && parts[2] === chain.nativeSymbol
  const address = parts[0] === 'eip155' ? parts.slice(2).join(':') : parts.slice(1).join(':')
  if (native) return { ref: `native:${chain.id}`, chain: chain.id, native: true }
  if (!address || address.includes(':') || (chain.evmChainId != null && !/^0x[\da-f]{40}$/i.test(address))) return null
  return { ref: `${chain.id}:${address}`, chain: chain.id, native: false }
}
