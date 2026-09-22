// Test-only fixtures for the RWA coverage lane and its read views. Not imported
// by any production module.

/** PostgREST-shaped fake: select, eq, in, lt, gte, not(col,'is',false), order
 * (multi-column), limit, range and upsert. Chains end in `.limit()`,
 * `.range()` or `.upsert()`. `errors[table]` fails every read of that table. */
// deno-lint-ignore no-explicit-any
export function fakeDb(tables: Record<string, any[]> = {}, errors: Record<string, string> = {}) {
  // deno-lint-ignore no-explicit-any
  const upserts: Record<string, any[]> = {}
  // deno-lint-ignore no-explicit-any
  const upsertOptions: Record<string, any[]> = {}
  const reads: string[] = []
  const compare = (a: unknown, b: unknown) => {
    if (a == null && b == null) return 0
    if (a == null) return 1
    if (b == null) return -1
    const [x, y] = [Number(a), Number(b)]
    return Number.isFinite(x) && Number.isFinite(y) ? x - y : String(a).localeCompare(String(b))
  }
  return {
    upserts, upsertOptions, reads, tables,
    from(table: string) {
      // deno-lint-ignore no-explicit-any
      const filters: ((row: any) => boolean)[] = []
      const orders: { column: string; ascending: boolean }[] = []
      const run = (start: number, end: number | null) => {
        reads.push(table)
        if (errors[table]) return { data: null, error: { message: errors[table] } }
        let rows = [...(tables[table] || [])].filter((row) => filters.every((f) => f(row)))
        rows.sort((a, b) => {
          for (const o of orders) { const c = compare(a?.[o.column], b?.[o.column]) * (o.ascending ? 1 : -1); if (c) return c }
          return 0
        })
        rows = end == null ? rows.slice(start) : rows.slice(start, end + 1)
        return { data: rows, error: null }
      }
      // deno-lint-ignore no-explicit-any
      const q: any = {
        select: () => q,
        // deno-lint-ignore no-explicit-any
        eq: (k: string, v: any) => { filters.push((r) => String(r?.[k] ?? '') === String(v ?? '')); return q },
        // deno-lint-ignore no-explicit-any
        in: (k: string, v: any[]) => { filters.push((r) => v.some((o) => String(o) === String(r?.[k]))); return q },
        // deno-lint-ignore no-explicit-any
        lt: (k: string, v: any) => { filters.push((r) => r?.[k] != null && String(r[k]) < String(v)); return q },
        // deno-lint-ignore no-explicit-any
        gte: (k: string, v: any) => { filters.push((r) => r?.[k] != null && String(r[k]) >= String(v)); return q },
        // deno-lint-ignore no-explicit-any
        not: (k: string, op: string, v: any) => { if (op === 'is' && v === false) filters.push((r) => r?.[k] !== false); return q },
        // deno-lint-ignore no-explicit-any
        order: (column: string, options: any = {}) => { orders.push({ column, ascending: options?.ascending !== false }); return q },
        limit: (max: number) => Promise.resolve(run(0, max - 1)),
        range: (from: number, to: number) => Promise.resolve(run(from, to)),
        // deno-lint-ignore no-explicit-any
        upsert: (rows: any[], options: any) => {
          (upserts[table] ||= []).push(...rows);
          (upsertOptions[table] ||= []).push(options)
          return Promise.resolve({ error: errors[`write:${table}`] ? { message: errors[`write:${table}`] } : null })
        },
      }
      return q
    },
  }
}

export const ctxFor = (name: string, maxCalls: number) => ({ jobName: 'test', caller: name, kind: 'job' as const, maxCalls })

// deno-lint-ignore no-explicit-any
export function fakeRequest(handler: (name: string, params: Record<string, unknown>, index: number) => any) {
  const calls: { name: string; params: Record<string, unknown> }[] = []
  const request = (name: string, params: Record<string, unknown> = {}) => {
    calls.push({ name, params })
    return Promise.resolve(handler(name, params, calls.length - 1))
  }
  return { request, calls }
}

export const usdQuote = (fields: Record<string, unknown>) => ({ quotes: [{ crypto_id: 2781, symbol: 'USD', last_updated: '2026-09-21T03:19:00.000Z', ...fields }] })

export const token = (cryptoId: number, symbol: string, name: string, issuer: string | null, price: number | null, cap: number | null, volume: number | null) =>
  ({ crypto_id: cryptoId, symbol, name, issuer_id: issuer, issuer_name: issuer ? `${issuer} Ltd` : null, price, market_cap: cap, volume_24h: volume })

export const quoteRow = (rwaId: number, symbol: string, assetType: string, tokens: unknown[]) => ({
  rwa_id: rwaId, name: `${symbol} asset`, symbol, asset_type: assetType, rwa_rank: rwaId, has_tokens: true,
  last_updated: '2026-09-21T03:19:00.000Z',
  ...usdQuote({ average_tokenized_price: 100, tokenized_market_cap: 1000, tokenized_volume_24h: 50 }),
  tokens,
})

export const mapRow = (rwaId: number, lastSeenAt: string, extra: Record<string, unknown> = {}) =>
  ({ rwa_id: rwaId, symbol: `S${rwaId}`, name: `Asset ${rwaId}`, asset_type: 'stock', rwa_rank: rwaId, has_tokens: true, last_seen_at: lastSeenAt, ...extra })
