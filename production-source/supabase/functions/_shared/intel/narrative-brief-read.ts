// The optional cached brief has its own read state. A source failure must not
// be described as a narrative with no saved brief. This never generates AI.
export async function readNarrativeBrief(db: any, slug: string) {
  try {
    const { data, error } = await db.from('intel_shared_artifacts')
      .select('structured, consensus, confidence, net_signal, created_at, stale_after, evidence_hash')
      .eq('artifact_type', 'narrative_brief').eq('entity_ref', `narrative:${slug}`)
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (error || data === undefined || data !== null && (!data || typeof data !== 'object' || Array.isArray(data))) throw new Error('Invalid brief read')
    return { brief: data, briefState: data ? 'available' : 'empty' }
  } catch { return { brief: null, briefState: 'error' } }
}
