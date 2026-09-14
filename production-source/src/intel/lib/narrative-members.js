export function narrativeMemberIdentity(row) {
  const provider = row?.asset_provider, id = row?.asset_provider_id
  if (typeof id !== 'string' || !(provider === 'coinmarketcap' ? /^[1-9][0-9]{0,11}$/.test(id) : provider === 'coingecko' && /^[a-z0-9][a-z0-9._-]{0,199}$/.test(id))) return null
  return { sourceProvider: provider, providerId: id, canonicalAssetKey: `market:${provider}:${id}`, symbol: row.symbol || null, displayName: row.symbol || id }
}
export function narrativeMemberPath(row) {
  const identity = narrativeMemberIdentity(row)
  return identity ? `/intel/markets/${encodeURIComponent(identity.symbol || identity.providerId)}?${new URLSearchParams({ provider: identity.sourceProvider, id: identity.providerId })}` : null
}
export function narrativeScore(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
export function narrativeHistorySeries(history, kind) {
  return (history || []).filter(row => row && Number.isFinite(Date.parse(row.snapshot_at))).map(row => {
    let value = narrativeScore(row[kind])
    if (kind === 'confirmation') {
      const price = narrativeScore(row.price_confirmation_score), volume = narrativeScore(row.volume_confirmation_score)
      // This is the two-field average; a partial read must not silently change its denominator.
      value = price == null || volume == null ? null : (price + volume) / 2
    }
    return { time: Date.parse(row.snapshot_at), value }
  }).sort((a, b) => a.time - b.time)
}

// Separate SVG subpaths preserve gaps and actual elapsed time, including DST.
export function narrativeSeriesPath(series, width = 320, height = 48, domain = [0, 100]) {
  if (series.length < 2) return ''
  const start = series[0].time, span = series.at(-1).time - start
  if (span <= 0) return ''
  let open = false
  return series.map(point => {
    if (point.value == null) { open = false; return '' }
    const x = ((point.time - start) / span * width).toFixed(1)
    const value = Math.max(domain[0], Math.min(domain[1], point.value))
    const y = (height - (value - domain[0]) / (domain[1] - domain[0] || 1) * height).toFixed(1)
    const command = open ? 'L' : 'M'; open = true
    return `${command}${x},${y}`
  }).join(' ')
}
