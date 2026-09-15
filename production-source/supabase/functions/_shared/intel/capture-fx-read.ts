// Investor Intel — the `fx` read view over `intel_fx_rates`.
//
// Served by `intel-capture` as `{ op:'read', view:'fx', orgId }` to any signed-in
// Intel member: the table is service-role only, so the browser never reads it
// directly. The answer is the newest captured HOUR, whole — a mix of two hours
// would silently price two columns of the same row against different clocks.
//
// Three states, and the caller must be able to tell them apart:
//   fresh        — the newest capture is inside FX_STALE_AFTER_MS.
//   stale        — older than that. The rates are STILL RETURNED: an hour-old
//                  cadence that missed a few runs is far better than reverting
//                  a reader's chosen currency to dollars without saying why.
//   unavailable  — nothing captured (or the read failed). `rates` is {} and
//                  `reason` says which; the app falls back to USD and says so.
//
// The currency NAMES and SIGNS are a static table here, not a daily call to the
// provider's `/v1/fiat/map`: the supported set is fixed at thirty codes, so the
// map endpoint would cost a credit a day to re-learn constants. `FX_CURRENCIES`
// mirrors the map's `name`/`sign` fields for exactly those thirty.

import { FX_BASE, FX_CODES, FX_TABLE, type FxCode } from './capture-fx.ts'

/** Rates older than this are reported with `state: 'stale'` — still usable, but
 * the settings section says how old they are. */
export const FX_STALE_AFTER_MS = 6 * 3_600_000
// One hour holds thirty rows; the cap reads a few hours of headroom so a run
// that wrote a partial hour cannot hide the complete hour underneath it.
const FX_ROW_CAP = 150

export interface FxCurrency {
  code: FxCode
  name: string
  /** Display sign, or null when the sign is ambiguous (kr, د.إ, R) and the ISO
   * code is what a reader can actually identify. */
  sign: string | null
  /** True where the sign conventionally follows the amount (zł, Kč, Ft, ₫). */
  suffix?: boolean
}

/** Mirrors `/v1/fiat/map` for the supported thirty, in settings order. */
export const FX_CURRENCIES: readonly FxCurrency[] = [
  { code: 'USD', name: 'United States Dollar', sign: '$' },
  { code: 'EUR', name: 'Euro', sign: '€' },
  { code: 'GBP', name: 'Pound Sterling', sign: '£' },
  { code: 'JPY', name: 'Japanese Yen', sign: '¥' },
  { code: 'CHF', name: 'Swiss Franc', sign: null },
  { code: 'CAD', name: 'Canadian Dollar', sign: 'CA$' },
  { code: 'AUD', name: 'Australian Dollar', sign: 'A$' },
  { code: 'NZD', name: 'New Zealand Dollar', sign: 'NZ$' },
  { code: 'SGD', name: 'Singapore Dollar', sign: 'S$' },
  { code: 'HKD', name: 'Hong Kong Dollar', sign: 'HK$' },
  { code: 'KRW', name: 'South Korean Won', sign: '₩' },
  { code: 'INR', name: 'Indian Rupee', sign: '₹' },
  { code: 'BRL', name: 'Brazilian Real', sign: 'R$' },
  { code: 'MXN', name: 'Mexican Peso', sign: 'MX$' },
  // A bare "R" reads as a rand to South Africans and as a real to Brazilians.
  { code: 'ZAR', name: 'South African Rand', sign: null },
  { code: 'TRY', name: 'Turkish Lira', sign: '₺' },
  // Three different "kr": the code is the only thing that separates them.
  { code: 'SEK', name: 'Swedish Krona', sign: null },
  { code: 'NOK', name: 'Norwegian Krone', sign: null },
  { code: 'DKK', name: 'Danish Krone', sign: null },
  { code: 'PLN', name: 'Polish Zloty', sign: 'zł', suffix: true },
  { code: 'CZK', name: 'Czech Koruna', sign: 'Kč', suffix: true },
  { code: 'HUF', name: 'Hungarian Forint', sign: 'Ft', suffix: true },
  // د.إ and ﷼ are right-to-left inside a left-to-right figure; the code is safer.
  { code: 'AED', name: 'United Arab Emirates Dirham', sign: null },
  { code: 'SAR', name: 'Saudi Riyal', sign: null },
  { code: 'ILS', name: 'Israeli New Shekel', sign: '₪' },
  { code: 'THB', name: 'Thai Baht', sign: '฿' },
  { code: 'IDR', name: 'Indonesian Rupiah', sign: 'Rp' },
  { code: 'PHP', name: 'Philippine Peso', sign: '₱' },
  { code: 'VND', name: 'Vietnamese Dong', sign: '₫', suffix: true },
  { code: 'NGN', name: 'Nigerian Naira', sign: '₦' },
]

export interface FxRate { rate: number; observedAt: string | null }
export interface Coverage { from: string | null; to: string | null; count: number; truncated?: boolean }
export interface ViewResult { view: string; asOf: string | null; coverage: Coverage; reason?: string | null; [key: string]: unknown }

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const str = (v: unknown, max = 40): string | null => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null }
const at = (now: Date | number): number => (now instanceof Date ? now.getTime() : now)
const emptyCoverage = (): Coverage => ({ from: null, to: null, count: 0 })

const unavailable = (reason: string): ViewResult => ({
  view: 'fx', base: FX_BASE, rates: {}, currencies: FX_CURRENCIES,
  state: 'unavailable', observedAt: null, asOf: null, coverage: emptyCoverage(), reason,
})

/**
 * Newest captured hour of USD→currency rates.
 *
 * `{ rates: { EUR: { rate, observedAt }, … }, base: 'USD', asOf, currencies }`.
 * `currencies` is always the full thirty — the settings select must be able to
 * offer every currency even in the hour before the first capture lands.
 */
// deno-lint-ignore no-explicit-any
export async function readFx(db: any, _body: Record<string, unknown> = {}, now: Date | number = Date.now()): Promise<ViewResult> {
  let rows: any[] = []
  try {
    const { data, error } = await db.from(FX_TABLE).select('base,quote,captured_at,rate,observed_at')
      .eq('base', FX_BASE).order('captured_at', { ascending: false }).limit(FX_ROW_CAP)
    if (error) return unavailable(String(error.message || error.code || error).slice(0, 200))
    rows = Array.isArray(data) ? data : data ? [data] : []
  } catch (e) {
    return unavailable(((e as Error)?.message || 'fx_read_failed').slice(0, 200))
  }
  if (!rows.length) return unavailable('fx_not_captured')

  // Newest-first is the read's own ordering, but a fake or a future reorder must
  // not decide which hour is current: take the maximum explicitly.
  const stamps = rows.map((row) => str(row?.captured_at)).filter((v): v is string => !!v).sort()
  const asOf = stamps.at(-1) ?? null
  if (!asOf) return unavailable('fx_not_captured')

  const supported = new Set<string>(FX_CODES)
  const rates: Record<string, FxRate> = {}
  let observedAt: string | null = null
  for (const row of rows) {
    if (str(row?.captured_at) !== asOf) continue
    const code = (str(row?.quote, 10) || '').toUpperCase()
    if (!supported.has(code) || rates[code]) continue
    const rate = num(row?.rate)
    if (rate == null || rate <= 0) continue
    const rowObserved = str(row?.observed_at)
    rates[code] = { rate, observedAt: rowObserved }
    if (rowObserved && (!observedAt || rowObserved > observedAt)) observedAt = rowObserved
  }
  if (!Object.keys(rates).length) return unavailable('fx_not_captured')

  const age = at(now) - Date.parse(asOf)
  const state = Number.isFinite(age) && age > FX_STALE_AFTER_MS ? 'stale' : 'fresh'
  return {
    view: 'fx', base: FX_BASE, rates, currencies: FX_CURRENCIES,
    state, observedAt, asOf,
    coverage: { from: asOf, to: asOf, count: Object.keys(rates).length, truncated: rows.length >= FX_ROW_CAP },
    reason: null,
  }
}

/** Integration surface consumed by `intel-capture/index.ts`. Keyed by view name. */
export const FX_CAPTURE_VIEWS: Record<string, (
  // deno-lint-ignore no-explicit-any
  db: any,
  body: Record<string, unknown>,
  now: number,
) => Promise<ViewResult>> = { fx: readFx }
