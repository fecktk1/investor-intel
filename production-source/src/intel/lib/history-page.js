// Stable keyset pages retain PostgreSQL's timestamp precision at boundaries.
export async function readHistoryPage(query, column, { limit = 50, cursor = null, paged = false } = {}) {
  const size = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)))
  let q = query.order(column, { ascending: false }).order('id', { ascending: false })
  if (cursor) {
    if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(cursor.at || '') || !/^[0-9a-f-]{36}$/i.test(cursor.id || '')) throw new Error('Invalid history cursor')
    q = q.or(`${column}.lt.${cursor.at},and(${column}.eq.${cursor.at},id.lt.${cursor.id})`)
  }
  const { data, error } = await q.limit(size + 1)
  if (error) throw error
  const rows = (data || []).slice(0, size), last = rows.at(-1)
  const nextCursor = data?.length > size ? { at: last[column], id: last.id } : null
  return paged ? { rows, nextCursor } : rows
}

export function appendHistoryPage(previous, rows) {
  const known = new Set(previous.map(row => `${row.scope || ''}:${row.id}`))
  return [...previous, ...rows.filter(row => !known.has(`${row.scope || ''}:${row.id}`))]
}
