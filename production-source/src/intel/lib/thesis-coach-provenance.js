// Accepting a coach draft explicitly keeps the evidence it cites in the existing
// journal snapshot infrastructure. It never changes an existing user's label.
export function attachCoachProvenance(rows, accepted) {
  const out = rows.map(row => ({ ...row }))
  if (!accepted?.version || !Array.isArray(accepted.sources)) return out
  for (const source of accepted.sources.slice(0, 14)) {
    if (!source.source_table || !source.source_ref) continue
    const existing = out.find(row => row.source_table === source.source_table && row.source_ref === source.source_ref)
    const citation = { evidence_version: accepted.version, coach_citation_id: source.citation_id }
    if (existing) existing.event_snapshot = { ...existing.event_snapshot, ...citation }
    else out.push({ source_table: source.source_table, source_ref: source.source_ref, event_type: source.event_type,
      event_at: source.date, event_snapshot: { ...source, ...citation }, impact: 'no_effect', impact_source: 'engine' })
  }
  return out
}
