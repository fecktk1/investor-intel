const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/
const columns = 'id,snapshot_at,momentum_score,chatter_score,price_confirmation_score,volume_confirmation_score,breadth_score,crowding_score,risk_score,confidence_score,global_priority_score,lifecycle_stage,signal_class'

// Read shared rows under the caller's JWT. A timestamp plus record ID cursor
// preserves distinct snapshots recorded at the same instant.
export async function readNarrativeHistory(db: any, slug: string, days: number, before?: any) {
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('Invalid history range')
  if (before != null && (!before || typeof before !== 'object' || Array.isArray(before) || typeof before.at !== 'string' || !timestamp.test(before.at) || !Number.isFinite(Date.parse(before.at)) || typeof before.id !== 'string' || !uuid.test(before.id))) throw new Error('Invalid narrative history cursor')
  const { data: taxonomy, error: taxonomyError } = await db.from('narrative_taxonomy').select('id').eq('slug', slug).maybeSingle()
  if (taxonomyError || taxonomy === undefined) throw new Error('Narrative identity could not be read')
  if (!taxonomy?.id) throw new Error('Narrative identity is unavailable')
  const now = Date.now()
  let query = db.from('narrative_score_snapshots').select(columns).eq('narrative_id', taxonomy.id)
    .gte('snapshot_at', new Date(now - days * 86400000).toISOString()).lte('snapshot_at', new Date(now).toISOString())
    .order('snapshot_at', { ascending: false }).order('id', { ascending: false })
  if (before) {
    const at = before.at // Preserve PostgreSQL microseconds in the cursor.
    query = query.or(`snapshot_at.lt.${at},and(snapshot_at.eq.${at},id.lt.${before.id})`)
  }
  const { data, error } = await query.limit(481)
  if (error || !Array.isArray(data) || data.length > 481 || data.some(row => !row || !uuid.test(row.id) || !timestamp.test(row.snapshot_at) || !Number.isFinite(Date.parse(row.snapshot_at)))) throw new Error('Narrative history could not be read')
  const page = data.slice(0, 480).reverse() // Keep the database's precise ordering.
  return { history: page, historyCoverage: { requestedDays: days, returnedRows: page.length, hasMore: data.length > 480,
    nextCursor: data.length > 480 ? {at: page[0].snapshot_at,id:page[0].id} : null, from: page[0]?.snapshot_at || null, to: page.at(-1)?.snapshot_at || null } }
}
