import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { readFx, FX_CAPTURE_VIEWS, FX_CURRENCIES, FX_STALE_AFTER_MS } from './capture-fx-read.ts'
import { FX_CODES } from './capture-fx.ts'

const NOW = Date.UTC(2026, 8, 15, 12, 0, 0)
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString()

function fakeDb(rows: any[] = [], readError?: string) {
  return {
    from(_table: string) {
      const filters: [string, unknown][] = []
      let ordering: { column: string; ascending: boolean } | null = null
      const q: any = {
        select: () => q,
        eq: (k: string, v: unknown) => { filters.push([k, v]); return q },
        order: (column: string, opts: any = {}) => { ordering = { column, ascending: opts?.ascending !== false }; return q },
        limit: (max: number) => {
          if (readError) return Promise.resolve({ data: null, error: { message: readError } })
          let out = rows.filter((row) => filters.every(([k, v]) => String(row?.[k] ?? '') === String(v ?? '')))
          if (ordering) out = [...out].sort((a, b) => String(a?.[ordering!.column] ?? '').localeCompare(String(b?.[ordering!.column] ?? '')) * (ordering!.ascending ? 1 : -1))
          return Promise.resolve({ data: out.slice(0, max), error: null })
        },
      }
      return q
    },
  }
}

const hourOfRates = (capturedAt: string, codes: readonly string[] = FX_CODES) =>
  codes.map((code, index) => ({ base: 'USD', quote: code, captured_at: capturedAt, rate: code === 'USD' ? 1 : 0.5 + index / 10, observed_at: capturedAt }))

Deno.test('the view surface exposes exactly the fx view', () => {
  eq(Object.keys(FX_CAPTURE_VIEWS), ['fx'])
  eq(FX_CAPTURE_VIEWS.fx, readFx)
})

Deno.test('the currency table covers the supported thirty, in order, with usable signs', () => {
  eq(FX_CURRENCIES.length, 30)
  eq(FX_CURRENCIES.map((c) => c.code).join(','), FX_CODES.join(','))
  assert(FX_CURRENCIES.every((c) => c.name.length > 2), 'every currency has a name')
  eq(FX_CURRENCIES.find((c) => c.code === 'USD')?.sign, '$')
  eq(FX_CURRENCIES.find((c) => c.code === 'CAD')?.sign, 'CA$', 'colliding dollar signs are disambiguated')
  eq(FX_CURRENCIES.find((c) => c.code === 'SEK')?.sign, null, 'an ambiguous sign falls back to the ISO code')
  eq(FX_CURRENCIES.find((c) => c.code === 'AED')?.sign, null)
  eq(FX_CURRENCIES.find((c) => c.code === 'PLN')?.suffix, true, 'zloty follows the amount')
})

Deno.test('an empty table is unavailable with a reason, never an error and never a fabricated rate', async () => {
  const result = await readFx(fakeDb(), {}, NOW)
  eq(result.view, 'fx')
  eq(result.state, 'unavailable')
  eq(result.reason, 'fx_not_captured')
  eq(result.rates, {})
  eq(result.asOf, null)
  eq(result.coverage.count, 0)
  eq((result.currencies as any[]).length, 30, 'the select can still offer every currency')
})

Deno.test('a failed read is unavailable with the failure as the reason', async () => {
  const result = await readFx(fakeDb([], 'canceling statement due to statement timeout'), {}, NOW)
  eq(result.state, 'unavailable')
  assert(String(result.reason).includes('statement timeout'))
  eq(result.rates, {})
})

Deno.test('a fresh capture answers the whole newest hour', async () => {
  const result = await readFx(fakeDb(hourOfRates(hoursAgo(1))), {}, NOW)
  eq(result.state, 'fresh')
  eq(result.base, 'USD')
  eq(result.asOf, hoursAgo(1))
  const rates = result.rates as Record<string, { rate: number; observedAt: string | null }>
  eq(Object.keys(rates).length, 30)
  eq(rates.USD.rate, 1)
  assert(rates.EUR.rate > 0)
  eq(rates.EUR.observedAt, hoursAgo(1))
  eq(result.coverage.count, 30)
  eq(result.reason, null)
})

Deno.test('only the newest hour is served: two hours are never mixed into one row of figures', async () => {
  const rows = [...hourOfRates(hoursAgo(5)), ...hourOfRates(hoursAgo(1), ['USD', 'EUR', 'GBP'])]
  const result = await readFx(fakeDb(rows), {}, NOW)
  eq(result.asOf, hoursAgo(1))
  eq(Object.keys(result.rates as Record<string, unknown>).length, 3, 'a partial newest hour is served as the partial hour it is')
})

Deno.test('rates past the staleness horizon are still returned, marked stale', async () => {
  const stale = await readFx(fakeDb(hourOfRates(hoursAgo(9))), {}, NOW)
  eq(stale.state, 'stale')
  eq(Object.keys(stale.rates as Record<string, unknown>).length, 30, 'stale rates are usable rates')
  eq(stale.asOf, hoursAgo(9))

  const edge = await readFx(fakeDb(hourOfRates(new Date(NOW - FX_STALE_AFTER_MS + 60_000).toISOString())), {}, NOW)
  eq(edge.state, 'fresh', 'inside the horizon is fresh')
})

Deno.test('unpriceable and unsupported rows are dropped rather than served', async () => {
  const rows = [
    { base: 'USD', quote: 'EUR', captured_at: hoursAgo(1), rate: 0.92, observed_at: hoursAgo(1) },
    { base: 'USD', quote: 'GBP', captured_at: hoursAgo(1), rate: 0, observed_at: hoursAgo(1) },
    { base: 'USD', quote: 'XXX', captured_at: hoursAgo(1), rate: 4, observed_at: hoursAgo(1) },
    { base: 'USD', quote: 'JPY', captured_at: hoursAgo(1), rate: null, observed_at: hoursAgo(1) },
  ]
  const result = await readFx(fakeDb(rows), {}, NOW)
  eq(Object.keys(result.rates as Record<string, unknown>), ['EUR'])
  eq(result.state, 'fresh')
})

Deno.test('an hour that priced nothing usable is unavailable, not an empty fresh read', async () => {
  const rows = [{ base: 'USD', quote: 'EUR', captured_at: hoursAgo(1), rate: -1, observed_at: hoursAgo(1) }]
  const result = await readFx(fakeDb(rows), {}, NOW)
  eq(result.state, 'unavailable')
  eq(result.reason, 'fx_not_captured')
})

Deno.test('observedAt is the newest provider clock in the hour', async () => {
  const rows = [
    { base: 'USD', quote: 'EUR', captured_at: hoursAgo(1), rate: 0.92, observed_at: hoursAgo(2) },
    { base: 'USD', quote: 'GBP', captured_at: hoursAgo(1), rate: 0.79, observed_at: hoursAgo(1) },
  ]
  const result = await readFx(fakeDb(rows), {}, NOW)
  eq(result.observedAt, hoursAgo(1))
})
