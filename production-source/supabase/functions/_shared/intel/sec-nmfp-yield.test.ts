import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  newestDatedPair, parseNmfpAdvertisedYield, newestFilingUrl, readAdvertisedYield,
} from './sec-nmfp-yield.ts'

/** The real shape probed on 2026-09-16: one filing carrying many dated pairs in
 * ascending document order, the earliest of which is four weeks stale. */
const FILING = `<edgarSubmission>
  <seriesId>S000067043</seriesId>
  <nameOfSeries>Franklin OnChain U.S. Government Money Fund</nameOfSeries>
  <reportDate>2026-08-31</reportDate>
  <averagePortfolioMaturity>37</averagePortfolioMaturity>
  <averageLifeMaturity>113</averageLifeMaturity>
  <percentageWeeklyLiquidAssets>0.7485</percentageWeeklyLiquidAssets>
  <percentageWeeklyLiquidAssets>0.7444</percentageWeeklyLiquidAssets>
  <sevenDayGrossYield><sevenDayGrossYieldValue>0.0373</sevenDayGrossYieldValue><sevenDayGrossYieldDate>2026-08-03</sevenDayGrossYieldDate></sevenDayGrossYield>
  <sevenDayGrossYield><sevenDayGrossYieldValue>0.0374</sevenDayGrossYieldValue><sevenDayGrossYieldDate>2026-08-31</sevenDayGrossYieldDate></sevenDayGrossYield>
  <sevenDayNetYield><sevenDayNetYieldValue>0.0355</sevenDayNetYieldValue><sevenDayNetYieldDate>2026-08-03</sevenDayNetYieldDate></sevenDayNetYield>
  <sevenDayNetYield><sevenDayNetYieldValue>0.0357</sevenDayNetYieldValue><sevenDayNetYieldDate>2026-08-31</sevenDayNetYieldDate></sevenDayNetYield>
</edgarSubmission>`

Deno.test('the seven day yield as of the report date is selected instead of the first one in the document', () => {
  // This is the whole trap. Document order would hand back 0.0355 dated
  // 2026-08-03, which is four weeks stale on a filing for 2026-08-31. The
  // figure as of the report date is 0.0357.
  const picked = newestDatedPair(['0.0355', '0.0356', '0.0357'], ['2026-08-03', '2026-08-12', '2026-08-31'], '2026-08-31')
  eq(picked?.value, 0.0357)
  eq(picked?.date, '2026-08-31')

  // A pair dated after the period the filing covers is ignored, never preferred.
  const beyond = newestDatedPair(['0.0357', '0.0900'], ['2026-08-31', '2026-09-30'], '2026-08-31')
  eq(beyond?.value, 0.0357)
  eq(beyond?.date, '2026-08-31')

  eq(newestDatedPair([], [], '2026-08-31'), null)
  eq(newestDatedPair(['0.03'], ['not-a-date'], '2026-08-31'), null)
})

Deno.test('a filing is read into a dated advertised yield stated in percent', () => {
  const parsed = parseNmfpAdvertisedYield(FILING, 'https://www.sec.gov/Archives/example/primary_doc.xml')
  assert(!('reason' in parsed))
  if ('reason' in parsed) return
  eq(parsed.seriesId, 'S000067043')
  eq(parsed.seriesName, 'Franklin OnChain U.S. Government Money Fund')
  eq(parsed.reportDate, '2026-08-31')
  // The yield carries its OWN date, which is the point of selecting it this way.
  eq(parsed.observedAt, '2026-08-31')
  // Filed as a fraction, converted to percent exactly once.
  eq(Number(parsed.netYieldPct.toFixed(4)), 3.57)
  eq(Number((parsed.grossYieldPct ?? 0).toFixed(4)), 3.74)
  eq(parsed.averagePortfolioMaturityDays, 37)
  eq(parsed.averageLifeMaturityDays, 113)
  eq(Number((parsed.weeklyLiquidAssetsPct ?? 0).toFixed(2)), 74.85)
  assert(parsed.timeMeaning.includes('past seven-day period'))
})

Deno.test('a gross yield dated to a different week is not presented beside the net figure', () => {
  // Two different weeks shown as one spread would be a fabricated number.
  const mismatched = FILING.replace('<sevenDayGrossYieldDate>2026-08-31</sevenDayGrossYieldDate>', '<sevenDayGrossYieldDate>2026-08-24</sevenDayGrossYieldDate>')
  const parsed = parseNmfpAdvertisedYield(mismatched, 'https://example.test/doc.xml')
  assert(!('reason' in parsed))
  if ('reason' in parsed) return
  eq(parsed.observedAt, '2026-08-31')
  eq(parsed.grossYieldPct, null)
})

Deno.test('a filing that cannot be identified is refused rather than partially believed', () => {
  eq((parseNmfpAdvertisedYield('', 'u') as { reason: string }).reason, 'empty_response')
  eq((parseNmfpAdvertisedYield('<x><seriesId>nope</seriesId></x>', 'u') as { reason: string }).reason, 'no_series_id')
  eq((parseNmfpAdvertisedYield('<x><seriesId>S000067043</seriesId></x>', 'u') as { reason: string }).reason, 'no_report_date')
  const noYield = '<x><seriesId>S000067043</seriesId><reportDate>2026-08-31</reportDate></x>'
  eq((parseNmfpAdvertisedYield(noYield, 'u') as { reason: string }).reason, 'no_dated_net_yield')
})

Deno.test('the newest filing is chosen by the period it covers and turned into an archive path', () => {
  const found = newestFilingUrl({
    hits: { hits: [
      { _id: '0002071691-26-017542:primary_doc.xml', _source: { ciks: ['0001786958'], file_date: '2026-08-06', period_ending: '2026-07-31' } },
      { _id: '0002071691-26-021281:primary_doc.xml', _source: { ciks: ['0001786958'], file_date: '2026-09-04', period_ending: '2026-08-31' } },
      { _id: 'malformed', _source: { ciks: ['0001786958'], file_date: '2026-09-09' } },
    ] },
  })
  // Leading zeros are stripped from the owner id and dashes from the accession.
  eq(found?.url, 'https://www.sec.gov/Archives/edgar/data/1786958/000207169126021281/primary_doc.xml')
  eq(found?.filedAt, '2026-09-04')
  eq(newestFilingUrl({ hits: { hits: [] } }), null)
  eq(newestFilingUrl('not json'), null)
})

Deno.test('a sibling series filing is refused and every request names this client to edgar', async () => {
  // EDGAR full-text search matches the whole document, so a trust that files
  // several series can return a different fund's filing for this query.
  const seen: Record<string, string>[] = []
  const wrongSeries = FILING.replace('S000067043', 'S000012345')
  const AGENT = 'TheContentForge Investor Intel support@thecontentforge.io'
  const refused = await readAdvertisedYield('S000067043', {
    userAgent: AGENT,
    fetchText: (url, headers) => {
      seen.push(headers)
      return Promise.resolve(url.includes('efts')
        ? JSON.stringify({ hits: { hits: [{ _id: '0002071691-26-021281:primary_doc.xml', _source: { ciks: ['0001786958'], period_ending: '2026-08-31' } }] } })
        : wrongSeries)
    },
  })
  eq((refused as { reason: string }).reason, 'series_mismatch')
  // EDGAR answers 403 without a descriptive agent, so every call carries one.
  assert(seen.length >= 1)
  for (const headers of seen) eq(headers['User-Agent'], AGENT)

  const ok = await readAdvertisedYield('S000067043', {
    userAgent: AGENT,
    fetchText: (url) => Promise.resolve(url.includes('efts')
      ? JSON.stringify({ hits: { hits: [{ _id: '0002071691-26-021281:primary_doc.xml', _source: { ciks: ['0001786958'], period_ending: '2026-08-31' } }] } })
      : FILING),
  })
  assert('yield' in ok)
  if (!('yield' in ok)) return
  eq(ok.yield.observedAt, '2026-08-31')

  eq((await readAdvertisedYield('nope', { fetchText: () => Promise.resolve(null) }) as { reason: string }).reason, 'invalid_series_id')
  eq((await readAdvertisedYield('S000067043', { userAgent: AGENT, fetchText: () => Promise.resolve(null) }) as { reason: string }).reason, 'search_unavailable')

  // No agent, or an agent with no contact, is refused before any request.
  let calls = 0
  const counting = () => { calls += 1; return Promise.resolve(null) }
  eq((await readAdvertisedYield('S000067043', { fetchText: counting }) as { reason: string }).reason, 'user_agent_required')
  eq((await readAdvertisedYield('S000067043', { userAgent: 'TheContentForge Investor Intel', fetchText: counting }) as { reason: string }).reason, 'user_agent_required')
  eq(calls, 0)
})
