// Pure time/identity math shared by charts and deterministic tests. No prices are
// inferred for executions, and no event is moved to a visible window boundary.
export function epochMs(value) {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : /^\d+(\.\d+)?$/.test(String(value)) ? Number(value) : Date.parse(value)
  if (!Number.isFinite(n)) return null
  return n > 0 && n < 1e12 ? n * 1000 : n
}

export function normalizeCandles(candles = []) {
  const unique = new Map()
  for (const c of candles) {
    const time = epochMs(c.t)
    if (time == null || c.c == null || !Number.isFinite(Number(c.c)) || Number(c.c) <= 0) continue
    unique.set(time, { t: time, price: Number(c.c) })
  }
  return [...unique.values()].sort((a, b) => a.t - b.t)
}

export function alignComparison(series = []) {
  const valid = series.map((s, index) => ({ ...s, key: `asset_${index}`, data: normalizeCandles(s.candles) })).filter(s => s.data.length > 1)
  if (valid.length < 2) return { series: valid, data: [], reason: 'insufficient_series', observations: 0 }
  const maps = valid.map(s => new Map(s.data.map(c => [c.t, c.price])))
  const times = valid[0].data.map(c => c.t).filter(t => maps.every(m => m.has(t)))
  if (times.length < 2) return { series: valid, data: [], reason: 'unaligned_history', observations: times.length }
  const bases = maps.map(m => m.get(times[0]))
  const data = times.map(t => Object.fromEntries([['t', t], ...valid.map((s, i) => [s.key, (maps[i].get(t) / bases[i] - 1) * 100])]))
  return { series: valid, data, observations: times.length, reason: null }
}

export function markerGroup(marker) {
  if (marker.group) return marker.group
  if (['entry', 'exit', 'trade', 'partial_exit'].includes(marker.type)) return 'trade'
  if (['buy', 'sell', 'transfer', 'swap', 'fee'].includes(marker.type)) return 'portfolio'
  if (['news', 'partnership', 'unlock'].includes(marker.type)) return { partnership: 'partnerships', unlock: 'unlocks' }[marker.type] || marker.type
  return 'thesis'
}

// Layer visibility applies to each saved record, including explicitly linked
// research. Hiding the ledger must not hide a journal's independent history.
export function projectMarkerLayers(markers = [], groups) {
  return markers.flatMap(marker => {
    const linkedResearch = projectMarkerLayers(marker.linkedResearch || [], groups)
    if (groups && !groups.has(markerGroup(marker))) return linkedResearch
    return [{ ...marker, linkedResearch }]
  })
}

export function markerWindow(markers = [], from, to, groups) {
  const all = markers.map((m, index) => ({ ...m, id: m.id || `${m.sourceRef || m.source || m.type}:${m.t}:${index}`, t: epochMs(m.t ?? m.occurredAt ?? m.occurred_at) }))
    .filter(m => (!groups || groups.has(markerGroup(m))))
    .sort((a, b) => (a.t ?? Infinity) - (b.t ?? Infinity) || String(a.id).localeCompare(String(b.id)))
  const seen = new Set()
  const unique = all.filter(m => { if (seen.has(m.id)) return false; seen.add(m.id); return true })
  return {
    visible: unique.filter(m => m.t != null && (from == null || m.t >= from) && (to == null || m.t <= to)),
    outside: unique.filter(m => m.t != null && ((from != null && m.t < from) || (to != null && m.t > to))),
    undated: unique.filter(m => m.t == null),
  }
}

// Nearby glyphs share a hit target, but their timestamps remain unchanged.
export function clusterMarkers(markers, from, to, pixels = 900) {
  const threshold = Math.max(0, (to - from) * 22 / Math.max(240, pixels))
  const groups = []
  for (const marker of markers) {
    const last = groups.at(-1)
    if (last && marker.t - last.t < threshold) last.events.push(marker)
    else groups.push({ t: marker.t, events: [marker] })
  }
  return groups
}

// A journal record enriches a ledger event only through an explicit validated
// reference. Similar timestamps or labels are never a deduplication key.
export function mergeLinkedAssetMarkers(portfolio = [], research = []) {
  const result = portfolio.map(marker => ({ ...marker, linkedResearch: [] }))
  const byRef = new Map(result.map(marker => [`${marker.sourceRef?.kind}:${marker.sourceRef?.id}`, marker]))
  for (const marker of research) {
    const linked = marker.linkedSourceRef
    const parent = linked && byRef.get(linked.eventKey || `${linked.kind}:${linked.id}`)
    if (parent) parent.linkedResearch.push(marker)
    else result.push(marker)
  }
  return result.sort((a,b) => (epochMs(a.t) ?? Infinity) - (epochMs(b.t) ?? Infinity))
}
