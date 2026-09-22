// Every row of a bounded PostgREST read, one page at a time. The API's row
// limit would otherwise truncate a larger read silently.

// deno-lint-ignore no-explicit-any
type Query = any

const PAGE = 1000

export async function readAllRows(build: () => Query, max = 5000): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []
  for (let from = 0; from < max; from += PAGE) {
    const { data, error } = await build().range(from, Math.min(max, from + PAGE) - 1)
    if (error) throw new Error(`paged_read_failed:${String(error.message || error.code || '').slice(0, 80)}`)
    const rows = Array.isArray(data) ? data : []
    out.push(...rows)
    if (rows.length < PAGE) break
  }
  return out
}
