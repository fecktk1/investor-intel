// Investor Intel: benchmark reference rates for the RWA yield engine.
//
// Four keyless, public-domain, commercially redistributable series, each probed
// live on 2026-09-16:
//
//   us_treasury_bill_3m   home.treasury.gov daily yield curve XML.
//                         2026-09-15: 1M 3.93, 3M 4.11, 6M 4.17, 1Y 4.39.
//   us_treasury_bill_avg  api.fiscaldata.treasury.gov average interest rates.
//                         2026-08-31: Treasury Bills 3.788. Sends CORS "*".
//   sofr                  markets.newyorkfed.org. 2026-09-15: 3.64.
//   estr                  data-api.ecb.europa.eu. 2026-09-15: 2.19.
//
// DELIBERATELY NOT USED. DeFiLlama, whose terms grant only a personal,
// non-commercial licence and threaten liquidated damages, is not a source here
// and nothing from it is stored. FRED is not used either: it forbids
// redistribution and is redundant with Treasury and the New York Fed direct.
//
// Every reader is PURE over a payload. The network is reached only through the
// injected `fetchText` seam, so this module tests without a network, and a
// source that fails becomes a named reason on that one rate rather than an
// exception that loses the other three.

import { BENCHMARK_CURRENCY, type BenchmarkKey, type RwaCurrency } from './rwa-yield-register.ts'

export const TREASURY_CURVE_URL = 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve'
export const TREASURY_AVG_URL = 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/avg_interest_rates'
export const SOFR_URL = 'https://markets.newyorkfed.org/api/rates/secured/sofr/last/1.json'
export const ESTR_URL = 'https://data-api.ecb.europa.eu/service/data/EST/B.EU000A2X2A25.WT'

/** The one network seam. `null` means the source could not be read. */
export type FetchText = (url: string, timeoutMs: number) => Promise<string | null>
export const BENCHMARK_TIMEOUT_MS = 8000

/** What a benchmark rate figure does NOT mean. Carried onto every stored row. */
export const BENCHMARK_SCOPE =
  'A published reference rate for the stated date. It is not an executable quote, not the yield of any token, and not a rate anyone was offered.'

export interface BenchmarkRate {
  key: BenchmarkKey
  currency: RwaCurrency
  /** Percent per annum, as the publisher states it. */
  ratePct: number
  /** The publisher's own observation date, never our capture date. */
  observedAt: string
  sourceUrl: string
  /** What the observation clock means for this particular series. */
  timeMeaning: string
  /** Extra context the publisher supplied, kept verbatim where it is small. */
  detail?: Record<string, unknown>
}

export interface BenchmarkReadFailure { key: BenchmarkKey; reason: string }

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
/** A calendar date the publisher stated, normalised to YYYY-MM-DD. */
const day = (v: unknown): string | null => {
  const raw = String(v ?? '').trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null
}

// ─── Treasury daily yield curve (XML) ─────────────────────────────────────────

/** The 3 month constant-maturity bill rate from the newest dated entry.
 *
 * The feed returns a month of entries in document order and the LAST one is the
 * newest, so the newest is selected by comparing the dates rather than by taking
 * whichever entry happens to be last. */
export function parseTreasuryCurve(xml: unknown): BenchmarkRate | { reason: string } {
  const text = typeof xml === 'string' ? xml : ''
  if (!text) return { reason: 'empty_response' }
  const entries = [...text.matchAll(/<content type="application\/xml">([\s\S]*?)<\/content>/g)].map((m) => m[1])
  if (!entries.length) return { reason: 'no_entries' }
  let best: { date: string; rate: number; detail: Record<string, unknown> } | null = null
  for (const entry of entries) {
    const date = day(entry.match(/<d:NEW_DATE[^>]*>([^<]*)<\/d:NEW_DATE>/)?.[1])
    const rate = num(entry.match(/<d:BC_3MONTH[^>]*>([^<]*)<\/d:BC_3MONTH>/)?.[1])
    if (!date || rate == null) continue
    if (!best || date > best.date) {
      best = {
        date, rate,
        // The neighbouring tenors are kept so a reader can see the curve the
        // comparison sits on, not just the single point we picked.
        detail: {
          oneMonthPct: num(entry.match(/<d:BC_1MONTH[^>]*>([^<]*)<\/d:BC_1MONTH>/)?.[1]),
          sixMonthPct: num(entry.match(/<d:BC_6MONTH[^>]*>([^<]*)<\/d:BC_6MONTH>/)?.[1]),
          oneYearPct: num(entry.match(/<d:BC_1YEAR[^>]*>([^<]*)<\/d:BC_1YEAR>/)?.[1]),
        },
      }
    }
  }
  if (!best) return { reason: 'no_dated_three_month_rate' }
  return {
    key: 'us_treasury_bill_3m', currency: 'USD', ratePct: best.rate, observedAt: best.date,
    sourceUrl: TREASURY_CURVE_URL,
    timeMeaning: 'The Treasury business day this constant-maturity rate was published for.',
    detail: best.detail,
  }
}

// ─── Treasury average interest rates (JSON) ───────────────────────────────────

/** The monthly average interest rate borne by Treasury Bills. This is a
 * different quantity from the curve above: it is the average rate on debt
 * OUTSTANDING, not a current market yield, and its timeMeaning says so. */
export function parseTreasuryAverage(payload: unknown): BenchmarkRate | { reason: string } {
  let body: unknown = payload
  if (typeof payload === 'string') { try { body = JSON.parse(payload) } catch { return { reason: 'invalid_json' } } }
  const rows = (body as { data?: unknown })?.data
  if (!Array.isArray(rows) || !rows.length) return { reason: 'no_rows' }
  let best: { date: string; rate: number } | null = null
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const record = row as Record<string, unknown>
    if (String(record.security_desc ?? '').trim() !== 'Treasury Bills') continue
    const date = day(record.record_date)
    const rate = num(record.avg_interest_rate_amt)
    if (!date || rate == null) continue
    if (!best || date > best.date) best = { date, rate }
  }
  if (!best) return { reason: 'no_treasury_bill_row' }
  return {
    key: 'us_treasury_bill_avg', currency: 'USD', ratePct: best.rate, observedAt: best.date,
    sourceUrl: TREASURY_AVG_URL,
    timeMeaning: 'The month-end the average rate on outstanding Treasury Bills was reported for. It is an average over debt already issued, not a current market yield.',
  }
}

// ─── SOFR (JSON) ──────────────────────────────────────────────────────────────

export function parseSofr(payload: unknown): BenchmarkRate | { reason: string } {
  let body: unknown = payload
  if (typeof payload === 'string') { try { body = JSON.parse(payload) } catch { return { reason: 'invalid_json' } } }
  const rows = (body as { refRates?: unknown })?.refRates
  if (!Array.isArray(rows) || !rows.length) return { reason: 'no_rows' }
  let best: { date: string; rate: number; detail: Record<string, unknown> } | null = null
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const record = row as Record<string, unknown>
    if (String(record.type ?? '').trim().toUpperCase() !== 'SOFR') continue
    const date = day(record.effectiveDate)
    const rate = num(record.percentRate)
    if (!date || rate == null) continue
    if (!best || date > best.date) {
      best = {
        date, rate,
        detail: {
          percentile1: num(record.percentPercentile1), percentile25: num(record.percentPercentile25),
          percentile75: num(record.percentPercentile75), percentile99: num(record.percentPercentile99),
          volumeInBillions: num(record.volumeInBillions),
        },
      }
    }
  }
  if (!best) return { reason: 'no_sofr_row' }
  return {
    key: 'sofr', currency: 'USD', ratePct: best.rate, observedAt: best.date,
    sourceUrl: SOFR_URL,
    timeMeaning: 'The effective date the New York Fed published this rate for, computed from the prior business day\'s transactions.',
    detail: best.detail,
  }
}

// ─── ESTR (SDMX JSON) ─────────────────────────────────────────────────────────

/** The euro short-term rate.
 *
 * SDMX splits the value from its date: `dataSets[0].series[key].observations` is
 * keyed by a POSITION, and the date for that position lives at the same index of
 * `structure.dimensions.observation[0].values`. Reading the value without that
 * lookup would store an undated rate, so a position with no matching date entry
 * is dropped rather than dated by us. Verified against the live payload on
 * 2026-09-16. */
export function parseEstr(payload: unknown): BenchmarkRate | { reason: string } {
  let body: unknown = payload
  if (typeof payload === 'string') { try { body = JSON.parse(payload) } catch { return { reason: 'invalid_json' } } }
  const root = body as Record<string, any> | null
  if (!root || typeof root !== 'object') return { reason: 'invalid_payload' }
  const dimension = root.structure?.dimensions?.observation
  const dates = Array.isArray(dimension) && Array.isArray(dimension[0]?.values) ? dimension[0].values : null
  const seriesMap = root.dataSets?.[0]?.series
  if (!dates || !seriesMap || typeof seriesMap !== 'object') return { reason: 'unexpected_shape' }
  const series = seriesMap[Object.keys(seriesMap)[0]]
  const observations = series?.observations
  if (!observations || typeof observations !== 'object') return { reason: 'no_observations' }
  let best: { date: string; rate: number } | null = null
  for (const [position, value] of Object.entries(observations)) {
    const index = Number(position)
    if (!Number.isInteger(index) || index < 0 || index >= dates.length) continue
    const date = day(dates[index]?.id)
    const rate = num(Array.isArray(value) ? value[0] : value)
    if (!date || rate == null) continue
    if (!best || date > best.date) best = { date, rate }
  }
  if (!best) return { reason: 'no_dated_observation' }
  return {
    key: 'estr', currency: 'EUR', ratePct: best.rate, observedAt: best.date,
    sourceUrl: ESTR_URL,
    timeMeaning: 'The ECB business day this rate was published for, computed from the prior day\'s money-market transactions.',
  }
}

// ─── The bounded read ─────────────────────────────────────────────────────────

/** The Treasury curve feed answers "No results found" unless it is asked for a
 * month (`field_tdr_date_value_month=YYYYMM`), and that empty answer is slow.
 * Found on 2026-09-16 when the rwa_yield lane first ran: every bill-backed fund
 * stored `benchmark_unavailable`. Ask for the current UTC month; in the first
 * week of a month the new month may have no business day published yet, so the
 * previous month is the fallback. */
export function treasuryCurveUrls(now: number): string[] {
  const d = new Date(now)
  const month = (y: number, m: number) => `${TREASURY_CURVE_URL}&field_tdr_date_value_month=${y}${String(m + 1).padStart(2, '0')}`
  const urls = [month(d.getUTCFullYear(), d.getUTCMonth())]
  if (d.getUTCDate() <= 7) {
    const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1))
    urls.push(month(prev.getUTCFullYear(), prev.getUTCMonth()))
  }
  return urls
}

/** The month-filtered Treasury curve answers in roughly 17 seconds (measured
 * 2026-09-16, three runs), so the shared 8 second timeout refused every read and
 * each bill-backed fund stored `benchmark_unavailable`. */
export const TREASURY_CURVE_TIMEOUT_MS = 30000

const SOURCES: { key: BenchmarkKey; url: string | ((now: number) => string[]); timeoutMs?: number; parse: (raw: string) => BenchmarkRate | { reason: string } }[] = [
  { key: 'us_treasury_bill_3m', url: treasuryCurveUrls, timeoutMs: TREASURY_CURVE_TIMEOUT_MS, parse: parseTreasuryCurve },
  { key: 'us_treasury_bill_avg', url: `${TREASURY_AVG_URL}?filter=security_desc:eq:Treasury%20Bills&sort=-record_date&page%5Bsize%5D=1`, parse: parseTreasuryAverage },
  { key: 'sofr', url: SOFR_URL, parse: parseSofr },
  { key: 'estr', url: `${ESTR_URL}?lastNObservations=1&format=jsondata`, parse: parseEstr },
]

export interface BenchmarkReadResult {
  rates: Partial<Record<BenchmarkKey, BenchmarkRate>>
  failures: BenchmarkReadFailure[]
  /** When WE asked. Distinct from each rate's own `observedAt`. */
  fetchedAt: string
  calls: number
}

/** Read every benchmark once. At most one call per source (two for the Treasury
 * curve in the first week of a month), and a source that
 * fails contributes a named failure instead of removing the others. `only`
 * narrows the read to the benchmarks a run actually needs. */
export async function readBenchmarkRates(
  deps: { fetchText: FetchText; timeoutMs?: number; now?: number },
  only?: BenchmarkKey[],
): Promise<BenchmarkReadResult> {
  const wanted = Array.isArray(only) && only.length ? SOURCES.filter((s) => only.includes(s.key)) : SOURCES
  const fetchedAt = new Date(deps.now ?? Date.now()).toISOString()
  const rates: Partial<Record<BenchmarkKey, BenchmarkRate>> = {}
  const failures: BenchmarkReadFailure[] = []
  let calls = 0
  const nowMs = deps.now ?? Date.now()
  for (const source of wanted) {
    // A source is one URL, or an ordered list of candidates (the Treasury curve
    // tries the current month, then the previous one early in a month). Only the
    // last candidate's failure is recorded; an earlier empty month is expected.
    const candidates = typeof source.url === 'function' ? source.url(nowMs) : [source.url]
    let failure: string | null = null
    for (const url of candidates) {
      calls += 1
      let raw: string | null = null
      try { raw = await deps.fetchText(url, deps.timeoutMs ?? source.timeoutMs ?? BENCHMARK_TIMEOUT_MS) } catch (e) {
        failure = ((e as Error)?.message || 'fetch_failed').slice(0, 120)
        continue
      }
      if (!raw) { failure = 'source_unavailable'; continue }
      const parsed = source.parse(raw)
      if ('reason' in parsed) { failure = parsed.reason; continue }
      // The publisher does not get to decide our currency table. A parser that
      // returned the wrong currency for its key is a defect, not a data point.
      if (parsed.currency !== BENCHMARK_CURRENCY[source.key]) { failure = 'currency_mismatch'; continue }
      rates[source.key] = parsed
      failure = null
      break
    }
    if (failure) failures.push({ key: source.key, reason: failure })
  }
  return { rates, failures, fetchedAt, calls }
}
