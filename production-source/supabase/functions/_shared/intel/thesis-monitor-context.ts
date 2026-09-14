// Read a complete, bounded journal context with stable keyset pagination.
// Reaching the safety bound is an error, never a truncated quality calculation.
export async function readThesisContextRows(admin: any, table: string, columns: string, thesis: {id:string;org_id:string;user_id:string}): Promise<any[]> {
  const rows: any[] = []
  let cursor: string | null = null
  for (let page = 0; page < 20; page++) {
    let query = admin.from(table).select(`id,${columns}`).eq('thesis_id', thesis.id)
      .eq('org_id', thesis.org_id).eq('user_id', thesis.user_id).order('id').limit(500)
    if (cursor) query = query.gt('id', cursor)
    const result = await query
    if (result.error || !Array.isArray(result.data)) throw new Error('thesis_context_unavailable')
    if (result.data.some((row: any) => typeof row.id !== 'string' || (cursor && row.id <= cursor))) throw new Error('thesis_context_unavailable')
    rows.push(...result.data)
    if (result.data.length < 500) return rows
    cursor = result.data.at(-1).id
  }
  throw new Error('thesis_context_limit_reached')
}
