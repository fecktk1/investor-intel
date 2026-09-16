// Investor Intel: advertised yield from an SEC N-MFP3 filing.
//
// The realized side of this engine comes from NAV on chain. The ADVERTISED side
// has to come from what the issuer actually published, and for a regulated money
// market fund that is a primary source: the monthly N-MFP3 filing on EDGAR.
// Public domain, keyless, and free.
//
// EDGAR REQUIRES A DESCRIPTIVE USER-AGENT or it answers 403, and documents a 10
// requests per second ceiling. This lane makes at most two calls per fund per
// capture, so the ceiling is never approached. The agent is the one resolved by
// `rwa-sources/edgar-agent.ts` (environment, then the operating profile row) and
// passed in by the caller; with none, this reader refuses before any call and
// reports `user_agent_required`, exactly like the issuer registry lane.
//
// THE TRAP THIS MODULE EXISTS TO AVOID, found by probing the live filing on
// 2026-09-16. A single N-MFP3 does NOT carry one seven-day yield. The Franklin
// OnChain U.S. Government Money Fund filing for period 2026-08-31 (accession
// 0002071691-26-021281) carries TWENTY-ONE dated pairs, one per business day of
// the month. Taking the first in document order yields 0.0355 dated 2026-08-03,
// which is four weeks stale on the day the filing was made. The figure as of the
// report date is 0.0357 net and 0.0374 gross, dated 2026-08-31. So the reader
// below selects the pair with the LATEST date that is not after the report date,
// and stores that date alongside the value. A yield without its own date is not
// a fact we are willing to display.

import { compliantEdgarAgent } from './rwa-sources/edgar-agent.ts'

export const SEC_FULLTEXT_URL = 'https://efts.sec.gov/LATEST/search-index'
export const SEC_ARCHIVES_BASE = 'https://www.sec.gov/Archives/edgar/data'
/** RETIRED AS A FALLBACK on 2026-09-16 and kept only so existing imports still
 * resolve. EDGAR asks for a descriptive agent with a REAL contact, and this
 * address is not published anywhere by the product (the published support
 * address is support@thecontentforge.io, on a different domain), so sending it
 * would misstate how to reach us. `readAdvertisedYield` no longer sends it: the
 * agent now arrives from `resolveEdgarUserAgent` through the caller. */
export const SEC_USER_AGENT = 'TheContentForge Investor Intel (intel@thecontentforge.com)'
export const SEC_TIMEOUT_MS = 8000

/** What an advertised yield is, and is not. */
export const ADVERTISED_TIME_MEANING =
  'The date the fund stated this seven-day yield for, taken from its own filing. It describes a past seven-day period, not the yield of holding a token, and not a forecast.'

export type FetchTextWithHeaders = (url: string, headers: Record<string, string>, timeoutMs: number) => Promise<string | null>

export interface AdvertisedYield {
  seriesId: string
  seriesName: string | null
  /** The filing's reporting period end. */
  reportDate: string
  /** The date the selected seven-day figures are stated for. */
  observedAt: string
  netYieldPct: number
  grossYieldPct: number | null
  /** Portfolio context the same filing states, kept because it is what makes a
   * seven-day yield interpretable. */
  averagePortfolioMaturityDays: number | null
  averageLifeMaturityDays: number | null
  weeklyLiquidAssetsPct: number | null
  sourceUrl: string
  timeMeaning: string
}

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const day = (v: unknown): string | null => {
  const raw = String(v ?? '').trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null
}
const tagValues = (xml: string, tag: string): string[] =>
  [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))].map((m) => m[1].trim())

/** Pair up a dated series of `<xValue>` and `<xDate>` elements and return the
 * newest entry that is not after `reportDate`.
 *
 * Document order is NOT trusted for recency: the pairing is done by index and
 * then chosen by comparing the dates themselves. An entry dated after the report
 * period is ignored rather than preferred, because a filing must not appear to
 * describe a period it does not cover. */
export function newestDatedPair(
  values: string[], dates: string[], reportDate: string,
): { value: number; date: string } | null {
  let best: { value: number; date: string } | null = null
  for (let i = 0; i < Math.min(values.length, dates.length); i++) {
    const date = day(dates[i]), value = num(values[i])
    if (!date || value == null || date > reportDate) continue
    if (!best || date > best.date) best = { value, date }
  }
  return best
}

/** Parse one N-MFP3 `primary_doc.xml` into the advertised yield it states.
 *
 * Yields are filed as FRACTIONS (0.0357), and are converted to percent once,
 * here, so no downstream surface has to guess the unit. */
export function parseNmfpAdvertisedYield(xml: unknown, sourceUrl: string): AdvertisedYield | { reason: string } {
  const text = typeof xml === 'string' ? xml : ''
  if (!text) return { reason: 'empty_response' }
  const seriesId = tagValues(text, 'seriesId')[0] || ''
  if (!/^S\d{9}$/.test(seriesId)) return { reason: 'no_series_id' }
  const reportDate = day(tagValues(text, 'reportDate')[0])
  if (!reportDate) return { reason: 'no_report_date' }

  const net = newestDatedPair(tagValues(text, 'sevenDayNetYieldValue'), tagValues(text, 'sevenDayNetYieldDate'), reportDate)
  if (!net) return { reason: 'no_dated_net_yield' }
  const gross = newestDatedPair(tagValues(text, 'sevenDayGrossYieldValue'), tagValues(text, 'sevenDayGrossYieldDate'), reportDate)

  // The liquidity series is dated the same way but the filing states it per
  // week; only the first is read, and only as context. A figure we cannot date
  // is left null rather than attached to the yield's date.
  const weekly = num(tagValues(text, 'percentageWeeklyLiquidAssets')[0])
  return {
    seriesId,
    seriesName: tagValues(text, 'nameOfSeries')[0] || null,
    reportDate,
    observedAt: net.date,
    netYieldPct: net.value * 100,
    // Gross is only reported when it is dated the SAME day as the net figure.
    // Two different days would be two different weeks presented as one spread.
    grossYieldPct: gross && gross.date === net.date ? gross.value * 100 : null,
    averagePortfolioMaturityDays: num(tagValues(text, 'averagePortfolioMaturity')[0]),
    averageLifeMaturityDays: num(tagValues(text, 'averageLifeMaturity')[0]),
    weeklyLiquidAssetsPct: weekly == null ? null : weekly * 100,
    sourceUrl,
    timeMeaning: ADVERTISED_TIME_MEANING,
  }
}

/** The newest N-MFP3 filing for a series, as EDGAR full-text search reports it.
 *
 * The search answers with ids shaped `<accession>:<document>`; the accession is
 * turned into an Archives path by stripping its dashes. Nothing is guessed: a
 * hit whose id does not parse is skipped. */
export function newestFilingUrl(payload: unknown, cik?: string | null): { url: string; filedAt: string | null } | null {
  let body: unknown = payload
  if (typeof payload === 'string') { try { body = JSON.parse(payload) } catch { return null } }
  // deno-lint-ignore no-explicit-any
  const hits = (body as any)?.hits?.hits
  if (!Array.isArray(hits) || !hits.length) return null
  let best: { url: string; filedAt: string | null; sortKey: string } | null = null
  for (const hit of hits) {
    const id = String(hit?._id ?? '')
    const [accession, document] = id.split(':')
    if (!/^\d{10}-\d{2}-\d{6}$/.test(accession || '') || !document) continue
    const owner = String(cik || hit?._source?.ciks?.[0] || '').replace(/^0+/, '')
    if (!owner) continue
    const filedAt = day(hit?._source?.file_date)
    const period = day(hit?._source?.period_ending)
    // Newest by the period the filing covers, falling back to the filing date.
    const sortKey = period || filedAt || ''
    if (!sortKey) continue
    if (!best || sortKey > best.sortKey) {
      best = { url: `${SEC_ARCHIVES_BASE}/${owner}/${accession.replaceAll('-', '')}/${document}`, filedAt, sortKey }
    }
  }
  return best ? { url: best.url, filedAt: best.filedAt } : null
}

/** Read the advertised yield for one registered series. At most two calls.
 *
 * Never throws: a failure is a named reason, so a fund whose filing could not be
 * read shows "advertised yield unavailable" with the reason rather than an empty
 * cell that reads as zero. */
export async function readAdvertisedYield(
  seriesId: string,
  deps: { fetchText: FetchTextWithHeaders; timeoutMs?: number; userAgent?: string | null },
): Promise<{ yield: AdvertisedYield } | { reason: string }> {
  if (!/^S\d{9}$/.test(String(seriesId || ''))) return { reason: 'invalid_series_id' }
  // Refused BEFORE the call, so a missing setting is a named reason and never an
  // anonymous request that EDGAR answers with 403.
  const agent = compliantEdgarAgent(deps.userAgent)
  if (!agent) return { reason: 'user_agent_required' }
  const headers = { 'User-Agent': agent, 'Accept-Encoding': 'gzip, deflate' }
  const timeout = deps.timeoutMs ?? SEC_TIMEOUT_MS
  let search: string | null = null
  try {
    search = await deps.fetchText(`${SEC_FULLTEXT_URL}?q=%22${seriesId}%22&forms=N-MFP3`, headers, timeout)
  } catch (e) { return { reason: ((e as Error)?.message || 'search_failed').slice(0, 120) } }
  if (!search) return { reason: 'search_unavailable' }
  const filing = newestFilingUrl(search)
  if (!filing) return { reason: 'no_filing_found' }
  let document: string | null = null
  try { document = await deps.fetchText(filing.url, headers, timeout) } catch (e) {
    return { reason: ((e as Error)?.message || 'filing_fetch_failed').slice(0, 120) }
  }
  if (!document) return { reason: 'filing_unavailable' }
  const parsed = parseNmfpAdvertisedYield(document, filing.url)
  if ('reason' in parsed) return parsed
  // The filing we fetched must be the series we asked for. EDGAR full-text
  // search matches the whole document, so a trust that files several series
  // could otherwise return a sibling fund's filing for this query.
  if (parsed.seriesId !== seriesId) return { reason: 'series_mismatch' }
  return { yield: parsed }
}
