// Test doubles shared by the demo snapshot tests: a PostgREST-shaped fake
// database, an in-memory bucket, and a fetch that fails the test if a provider
// (or anything else) is ever called.

// deno-lint-ignore-file no-explicit-any
type Row = Record<string, any>

export function fakeDb(tables: Record<string, Row[]> = {}) {
  const writes: { table: string; op: string; rows: unknown }[] = []
  const rpcs: { name: string; args: unknown }[] = []
  const from = (table: string) => {
    const filters: ((row: Row) => boolean)[] = []
    let ordering: { column: string; ascending: boolean }[] = []
    let max = Infinity
    let single: 'single' | 'maybe' | null = null
    let head = false
    const run = () => {
      let rows = [...(tables[table] || [])].filter((row) => filters.every((f) => f(row)))
      for (const o of [...ordering].reverse()) rows.sort((a, b) => String(a?.[o.column] ?? '').localeCompare(String(b?.[o.column] ?? '')) * (o.ascending ? 1 : -1))
      rows = rows.slice(0, max)
      if (head) return { data: null, error: null, count: rows.length }
      if (single) return { data: rows[0] ?? null, error: single === 'single' && rows.length !== 1 ? { message: 'not one row', code: 'PGRST116' } : null }
      return { data: rows, error: null, count: rows.length }
    }
    const q: any = {
      select: (_cols?: string, opts?: any) => { if (opts?.head) head = true; return q },
      eq: (k: string, v: any) => { filters.push((r) => String(r?.[k]) === String(v)); return q },
      neq: (k: string, v: any) => { filters.push((r) => String(r?.[k]) !== String(v)); return q },
      gt: (k: string, v: any) => { filters.push((r) => String(r?.[k] ?? '') > String(v)); return q },
      gte: (k: string, v: any) => { filters.push((r) => String(r?.[k] ?? '') >= String(v)); return q },
      lt: (k: string, v: any) => { filters.push((r) => String(r?.[k] ?? '') < String(v)); return q },
      lte: (k: string, v: any) => { filters.push((r) => String(r?.[k] ?? '') <= String(v)); return q },
      in: (k: string, vs: any[]) => { const set = new Set((vs || []).map(String)); filters.push((r) => set.has(String(r?.[k]))); return q },
      is: (k: string, v: any) => { filters.push((r) => (v === null ? r?.[k] == null : r?.[k] === v)); return q },
      not: () => q, or: () => q, filter: () => q, contains: () => q, ilike: () => q, like: () => q, match: () => q,
      order: (column: string, o: any = {}) => { ordering.push({ column, ascending: o?.ascending !== false }); return q },
      limit: (n: number) => { max = n; return q },
      range: (a: number, b: number) => { max = b - a + 1; return q },
      single: () => { single = 'single'; return q },
      maybeSingle: () => { single = 'maybe'; return q },
      then: (resolve: any, reject: any) => Promise.resolve(run()).then(resolve, reject),
      insert: (rows: unknown) => { writes.push({ table, op: 'insert', rows }); return Promise.resolve({ data: null, error: null }) },
      upsert: (rows: unknown) => { writes.push({ table, op: 'upsert', rows }); const w: any = { then: (r: any) => Promise.resolve({ data: null, error: null }).then(r), select: () => w }; return w },
      update: (rows: unknown) => { writes.push({ table, op: 'update', rows }); const w: any = { eq: () => w, then: (r: any) => Promise.resolve({ data: null, error: null }).then(r) }; return w },
    }
    return q
  }
  return {
    writes, rpcs, tables,
    from,
    rpc: (name: string, args: unknown) => { rpcs.push({ name, args }); return Promise.resolve({ data: null, error: null }) },
  }
}

export function memoryStorage() {
  const files = new Map<string, string>()
  const order: string[] = []
  return {
    files, order,
    async upload(path: string, text: string) { files.set(path, text); order.push(path) },
    async download(path: string) { return files.get(path) ?? null },
    async list(prefix: string) {
      const base = prefix.replace(/\/+$/, '') + '/'
      const names = new Set<string>()
      for (const path of files.keys()) if (path.startsWith(base)) names.add(path.slice(base.length).split('/')[0])
      return [...names].sort()
    },
    async remove(paths: string[]) { for (const p of paths) files.delete(p) },
  }
}

/** Replace globalThis.fetch with one that records and refuses every call. */
export function forbidNetwork() {
  const calls: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = ((input: unknown) => {
    calls.push(String((input as Request)?.url ?? input))
    return Promise.reject(new Error('network_forbidden_in_test'))
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}
