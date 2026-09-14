type Row = Record<string, unknown>
const instant = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value.trim()) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

export function evidenceFreshness(row: unknown, nowMs: number, fallbackHours = 24) {
  const r = row && typeof row === 'object' ? row as Row : null
  const asOf = r ? instant(r.observedAt ?? r.observed_at ?? r.as_of ?? r.block_time ?? r.published_at ?? r.snapshot_at ?? r.ts) : null
  const recordedAt = r ? instant(r.recordedAt ?? r.recorded_at ?? r.fetched_at ?? r.last_refreshed_at ?? r.created_at) : null
  const expiry = r ? instant(r.expiresAt ?? r.stale_after) : null
  const future = !!asOf && Date.parse(asOf) > nowMs
  const ageHours = asOf && !future ? (nowMs - Date.parse(asOf)) / 3_600_000 : null
  const staleAfter = expiry ?? (asOf ? new Date(Date.parse(asOf) + fallbackHours * 3_600_000).toISOString() : null)
  const status = !r ? 'missing' : !asOf || future ? 'unknown' : Date.parse(staleAfter!) <= nowMs ? 'stale' : 'fresh'
  return { status, as_of: asOf, recorded_at: recordedAt, stale_after: staleAfter, age_hours: ageHours }
}

// A group is only fresh when every included observation is fresh. Its range and
// individual clocks remain available; no newest row impersonates the group.
export function combineFreshness(observations: ReturnType<typeof evidenceFreshness>[]) {
  const rows = observations.filter(o => o.status !== 'missing')
  const times = [...new Set(rows.map(o => o.as_of).filter((x): x is string => x !== null))].sort()
  const expiries = rows.map(o => o.stale_after).filter((x): x is string => x !== null).sort()
  const recorded = [...new Set(rows.map(o => o.recorded_at))]
  const unknown = rows.some(o => o.status === 'unknown')
  const status = !rows.length ? 'missing' : rows.some(o => o.status === 'stale') ? 'stale' : unknown ? 'unknown' : 'fresh'
  return {
    status,
    as_of: times.length === 1 && rows.every(o => o.as_of !== null) ? times[0] : null,
    recorded_at: recorded.length === 1 ? recorded[0] : null,
    stale_after: expiries[0] ?? null,
    age_hours: rows.length && rows.every(o => o.age_hours !== null) ? Math.max(...rows.map(o => o.age_hours!)) : null,
    mixed_observation_times: times.length > 1,
    oldest_observed_at: times[0] ?? null,
    newest_observed_at: times.at(-1) ?? null,
    unknown_observation_count: rows.filter(o => o.status === 'unknown').length,
    observations: rows,
  }
}

export function groupFreshness(rows: unknown[], nowMs: number, fallbackHours = 24) {
  return combineFreshness(rows.filter(Boolean).map(row => evidenceFreshness(row, nowMs, fallbackHours)))
}

export function selectedFieldEvidence(value: unknown, row: unknown, table: string, nowMs: number, unit: string) {
  const r = (row ?? {}) as Row
  return {
    value: value ?? null, unit, source_table: value == null ? null : table,
    provider: r.provider ?? r.source_provider ?? r.market_cap_source ?? null,
    source_ref: r.sourceRef ?? r.source_ref ?? r.id ?? null,
    ...evidenceFreshness(value == null ? null : row, nowMs, 3),
  }
}
