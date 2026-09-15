import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { captureFx, FX_CAPTURE_OPS, FX_CODES, FX_BASE, FX_CONVERT_BATCH } from './capture-fx.ts'
import type { CaptureDeps } from './capture-jobs.ts'

const NOW = new Date(Math.floor(Date.UTC(2026, 8, 15, 4, 37, 12) / 1000) * 1000)
const HOUR_BUCKET = new Date(Math.floor(NOW.getTime() / 3_600_000) * 3_600_000).toISOString()
const ctxFor = (name: string, maxCalls: number) => ({ jobName: 'test', caller: `test-${name}`, kind: 'job' as const, maxCalls }) as any

/** PostgREST-shaped fake: remembers what was upserted and can fail on demand. */
function fakeDb(existing: any[] = [], options: { readError?: string; writeError?: string } = {}) {
  const written: any[][] = []
  return {
    written,
    from(_table: string) {
      const filters: [string, unknown][] = []
      let ordering: { column: string; ascending: boolean } | null = null
      const q: any = {
        select: () => q,
        eq: (k: string, v: unknown) => { filters.push([k, v]); return q },
        order: (column: string, opts: any = {}) => { ordering = { column, ascending: opts?.ascending !== false }; return q },
        limit: (max: number) => {
          if (options.readError) return Promise.resolve({ data: null, error: { message: options.readError } })
          let rows = existing.filter((row) => filters.every(([k, v]) => String(row?.[k] ?? '') === String(v ?? '')))
          if (ordering) rows = [...rows].sort((a, b) => String(a?.[ordering!.column] ?? '').localeCompare(String(b?.[ordering!.column] ?? '')) * (ordering!.ascending ? 1 : -1))
          return Promise.resolve({ data: rows.slice(0, max), error: null })
        },
        upsert: (rows: any[]) => {
          if (options.writeError) return Promise.resolve({ error: { message: options.writeError } })
          written.push(rows)
          return Promise.resolve({ error: null })
        },
      }
      return q
    },
  }
}

/** A price-conversion payload for the requested `convert` list. `omit` leaves a
 * currency out of the quote map entirely, the way the provider does. */
function conversionDeps(options: { omit?: string[]; fail?: string; lastUpdated?: string } = {}): CaptureDeps & { calls: any[] } {
  const calls: any[] = []
  const deps: any = {
    calls,
    policy: [{ provider: 'coinmarketcap', feature: 'fx', cadence_seconds: 3600, enabled: true, min_plan: 'basic' }],
    request: (name: string, params: Record<string, unknown>) => {
      calls.push({ name, params })
      if (options.fail) return Promise.resolve({ payload: null, reason: options.fail })
      const codes = String(params.convert || '').split(',').filter(Boolean)
      const quote: Record<string, unknown> = {}
      codes.forEach((code, index) => {
        if (code === FX_BASE || (options.omit || []).includes(code)) return
        quote[code] = { price: 0.5 + index / 10, last_updated: options.lastUpdated || '2026-09-15T04:30:00.000Z' }
      })
      return Promise.resolve({ payload: { data: { id: 2781, symbol: 'USD', amount: 1, last_updated: options.lastUpdated || '2026-09-15T04:30:00.000Z', quote } } })
    },
  }
  return deps
}

Deno.test('the op surface exposes exactly the fx job', () => {
  eq(Object.keys(FX_CAPTURE_OPS), ['fx'])
  eq(FX_CAPTURE_OPS.fx, captureFx)
  eq(FX_CODES.length, 30)
  eq(FX_CODES[0], 'USD')
  eq(new Set(FX_CODES).size, 30, 'no repeated currency')
})

Deno.test('one conversion call fills the hour bucket with every currency for one credit', async () => {
  const db = fakeDb()
  const deps = conversionDeps()
  const result = await captureFx(db, ctxFor, NOW, 'basic', deps)
  eq(result.job, 'fx')
  eq(result.credits, 1, 'the whole list is one call')
  eq(deps.calls.length, Math.ceil(FX_CODES.length / FX_CONVERT_BATCH))
  eq(deps.calls[0].name, 'priceConversion')
  eq(deps.calls[0].params.amount, 1)
  eq(deps.calls[0].params.symbol, 'USD')
  eq(String(deps.calls[0].params.convert).split(',').length, 30)
  eq(result.rows, 30)
  eq(result.capturedAt, HOUR_BUCKET, 'every row lands on the hour')
  const rows = db.written[0]
  eq(rows.length, 30)
  assert(rows.every((row: any) => row.captured_at === HOUR_BUCKET && row.base === 'USD'))
  const usd = rows.find((row: any) => row.quote === 'USD')
  eq(usd.rate, 1, 'the base is stored as exactly one')
  const eur = rows.find((row: any) => row.quote === 'EUR')
  assert(eur.rate > 0)
  eq(eur.observed_at, '2026-09-15T04:30:00.000Z', 'observed_at is the provider clock, not ours')
})

Deno.test('a currency the provider did not price is absent, never zero and never one', async () => {
  const db = fakeDb()
  const result = await captureFx(db, ctxFor, NOW, 'basic', conversionDeps({ omit: ['TRY', 'NGN', 'VND'] }))
  eq(result.rows, 27)
  eq(result.missing, ['TRY', 'VND', 'NGN'], 'reported in the supported order')
  const rows = db.written[0]
  for (const code of ['TRY', 'NGN', 'VND']) {
    eq(rows.find((row: any) => row.quote === code), undefined, `${code} is not stored at all`)
  }
  assert(rows.every((row: any) => Number(row.rate) > 0), 'no placeholder rate was written')
})

Deno.test('a provider failure is a reason on an empty result, never a throw and never a lone USD row', async () => {
  const db = fakeDb()
  const result = await captureFx(db, ctxFor, NOW, 'basic', conversionDeps({ fail: 'provider_rate_limited' }))
  eq(result.rows, 0)
  eq(result.credits, 1, 'a failed call still spent its credit')
  eq(result.error, 'provider_rate_limited')
  eq(db.written.length, 0, 'nothing was written')
})

Deno.test('a write failure is reported and a read failure never blocks the capture', async () => {
  const failedWrite = await captureFx(fakeDb([], { writeError: 'permission denied' }), ctxFor, NOW, 'basic', conversionDeps())
  eq(failedWrite.rows, 0)
  eq(failedWrite.error, 'permission denied')

  const blindRead = fakeDb([], { readError: 'statement timeout' })
  const result = await captureFx(blindRead, ctxFor, NOW, 'basic', conversionDeps())
  eq(result.rows, 30, 'an unreadable cadence check still captures: the write is idempotent')
})

Deno.test('the cadence guard skips an overlapping run without spending a credit', async () => {
  const fresh = [{ base: 'USD', quote: 'EUR', captured_at: new Date(NOW.getTime() - 600_000).toISOString(), rate: 0.9 }]
  const deps = conversionDeps()
  const result = await captureFx(fakeDb(fresh), ctxFor, NOW, 'basic', deps)
  eq(result.skipped, 'within_cadence')
  eq(result.credits, 0)
  eq(deps.calls.length, 0, 'no provider call was made')

  const old = [{ base: 'USD', quote: 'EUR', captured_at: new Date(NOW.getTime() - 4 * 3_600_000).toISOString(), rate: 0.9 }]
  const after = await captureFx(fakeDb(old), ctxFor, NOW, 'basic', conversionDeps())
  eq(after.rows, 30, 'an hour past the cadence captures again')
})

Deno.test('a disabled policy row stops the lane with a reason and no credit', async () => {
  const deps: any = conversionDeps()
  deps.policy = [{ provider: 'coinmarketcap', feature: 'fx', cadence_seconds: 3600, enabled: false, min_plan: 'basic' }]
  const result = await captureFx(fakeDb(), ctxFor, NOW, 'basic', deps)
  eq(result.skipped, 'policy_disabled')
  eq(result.credits, 0)
  eq(deps.calls.length, 0)
})

Deno.test('a plan below the policy minimum is recorded, not attempted', async () => {
  const deps: any = conversionDeps()
  deps.policy = [{ provider: 'coinmarketcap', feature: 'fx', cadence_seconds: 3600, enabled: true, min_plan: 'growth' }]
  const result = await captureFx(fakeDb(), ctxFor, NOW, 'basic', deps)
  eq(result.skipped, 'plan_below_growth')
  eq(result.credits, 0)
  eq(deps.calls.length, 0)
})

Deno.test('a thrown transport is a job error, never an exception out of the lane', async () => {
  const deps: any = conversionDeps()
  deps.request = () => { throw new Error('socket hang up') }
  const result = await captureFx(fakeDb(), ctxFor, NOW, 'basic', deps)
  eq(result.rows, 0)
  assert(result.error)
})

Deno.test('a payload that arrives as a one-element array is read the same way', async () => {
  const deps: any = conversionDeps()
  const inner = deps.request
  deps.request = async (name: string, params: Record<string, unknown>, ctx: unknown) => {
    const result = await inner(name, params, ctx)
    return { payload: { data: [result.payload.data] } }
  }
  const result = await captureFx(fakeDb(), ctxFor, NOW, 'basic', deps)
  eq(result.rows, 30)
})
