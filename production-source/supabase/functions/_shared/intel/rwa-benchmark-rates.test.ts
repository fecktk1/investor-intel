import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  parseTreasuryCurve, parseTreasuryAverage, parseSofr, parseEstr, readBenchmarkRates,
} from './rwa-benchmark-rates.ts'

/** Two dated entries in the Treasury feed's real envelope shape, deliberately
 * ordered with the NEWER one first so document order is not recency. */
const CURVE_XML = `<feed>
<entry><content type="application/xml"><m:properties>
  <d:NEW_DATE m:type="Edm.DateTime">2026-09-15T00:00:00</d:NEW_DATE>
  <d:BC_1MONTH m:type="Edm.Double">3.93</d:BC_1MONTH>
  <d:BC_3MONTH m:type="Edm.Double">4.11</d:BC_3MONTH>
  <d:BC_6MONTH m:type="Edm.Double">4.17</d:BC_6MONTH>
  <d:BC_1YEAR m:type="Edm.Double">4.39</d:BC_1YEAR>
</m:properties></content></entry>
<entry><content type="application/xml"><m:properties>
  <d:NEW_DATE m:type="Edm.DateTime">2026-09-14T00:00:00</d:NEW_DATE>
  <d:BC_1MONTH m:type="Edm.Double">3.90</d:BC_1MONTH>
  <d:BC_3MONTH m:type="Edm.Double">4.02</d:BC_3MONTH>
</m:properties></content></entry>
</feed>`

Deno.test('the newest dated treasury entry wins even when it is not last in the document', () => {
  // Verified against the live feed on 2026-09-16: 2026-09-15 read 1M 3.93,
  // 3M 4.11, 6M 4.17, 1Y 4.39.
  const rate = parseTreasuryCurve(CURVE_XML)
  assert(!('reason' in rate))
  if ('reason' in rate) return
  eq(rate.key, 'us_treasury_bill_3m')
  eq(rate.currency, 'USD')
  eq(rate.ratePct, 4.11)
  eq(rate.observedAt, '2026-09-15')
  // The neighbouring tenors travel with it so the curve behind the point is visible.
  eq(rate.detail?.oneMonthPct, 3.93)
  eq(rate.detail?.sixMonthPct, 4.17)
  eq(rate.detail?.oneYearPct, 4.39)
  assert(rate.timeMeaning.length > 20)

  eq((parseTreasuryCurve('') as { reason: string }).reason, 'empty_response')
  eq((parseTreasuryCurve('<feed></feed>') as { reason: string }).reason, 'no_entries')
})

Deno.test('the treasury average reads only the bill row and says it is not a market yield', () => {
  const rate = parseTreasuryAverage({
    data: [
      { record_date: '2026-07-31', security_desc: 'Treasury Bills', avg_interest_rate_amt: '3.758' },
      { record_date: '2026-08-31', security_desc: 'Treasury Notes', avg_interest_rate_amt: '2.900' },
      { record_date: '2026-08-31', security_desc: 'Treasury Bills', avg_interest_rate_amt: '3.788' },
    ],
  })
  assert(!('reason' in rate))
  if ('reason' in rate) return
  eq(rate.ratePct, 3.788)
  eq(rate.observedAt, '2026-08-31')
  eq(rate.key, 'us_treasury_bill_avg')
  // The distinction that stops this being read as a current market yield.
  assert(rate.timeMeaning.includes('not a current market yield'))

  eq((parseTreasuryAverage({ data: [{ record_date: '2026-08-31', security_desc: 'Treasury Notes', avg_interest_rate_amt: '2.9' }] }) as { reason: string }).reason, 'no_treasury_bill_row')
  eq((parseTreasuryAverage('not json') as { reason: string }).reason, 'invalid_json')
})

Deno.test('the secured overnight rate keeps its own effective date and distribution', () => {
  // Verified live 2026-09-16: 2026-09-15 read 3.64.
  const rate = parseSofr({
    refRates: [
      { effectiveDate: '2026-09-14', type: 'SOFR', percentRate: 3.62 },
      { effectiveDate: '2026-09-15', type: 'SOFR', percentRate: 3.64, percentPercentile1: 3.57, percentPercentile99: 3.72, volumeInBillions: 2952 },
      { effectiveDate: '2026-09-15', type: 'BGCR', percentRate: 3.60 },
    ],
  })
  assert(!('reason' in rate))
  if ('reason' in rate) return
  eq(rate.ratePct, 3.64)
  eq(rate.observedAt, '2026-09-15')
  eq(rate.currency, 'USD')
  eq(rate.detail?.volumeInBillions, 2952)
  // A different secured rate in the same payload is not SOFR.
  eq((parseSofr({ refRates: [{ effectiveDate: '2026-09-15', type: 'BGCR', percentRate: 3.6 }] }) as { reason: string }).reason, 'no_sofr_row')
})

Deno.test('the euro rate is dated by position against the observation dimension, never by us', () => {
  // The live SDMX shape probed 2026-09-16: values live under a position key and
  // the date for that position lives at the same index of the dimension.
  const payload = {
    structure: { dimensions: { observation: [{ id: 'TIME_PERIOD', values: [{ id: '2026-09-11' }, { id: '2026-09-14' }, { id: '2026-09-15' }] }] } },
    dataSets: [{ series: { '0:0:0': { observations: { '0': [2.189], '1': [2.19], '2': [2.19] } } } }],
  }
  const rate = parseEstr(payload)
  assert(!('reason' in rate))
  if ('reason' in rate) return
  eq(rate.key, 'estr')
  eq(rate.currency, 'EUR')
  eq(rate.ratePct, 2.19)
  eq(rate.observedAt, '2026-09-15')

  // A position with no matching date entry is dropped rather than dated by us.
  const unmatched = parseEstr({
    structure: { dimensions: { observation: [{ id: 'TIME_PERIOD', values: [{ id: '2026-09-15' }] }] } },
    dataSets: [{ series: { '0:0:0': { observations: { '4': [9.99] } } } }],
  })
  eq((unmatched as { reason: string }).reason, 'no_dated_observation')
  eq((parseEstr({}) as { reason: string }).reason, 'unexpected_shape')
})

Deno.test('one failing source is a named failure and never removes the rates that did answer', async () => {
  const result = await readBenchmarkRates({
    now: Date.parse('2026-09-16T12:00:00Z'),
    fetchText: (url) => {
      if (url.includes('home.treasury.gov')) return Promise.resolve(CURVE_XML)
      if (url.includes('markets.newyorkfed.org')) return Promise.resolve(JSON.stringify({ refRates: [{ effectiveDate: '2026-09-15', type: 'SOFR', percentRate: 3.64 }] }))
      // The euro source is down and the dollar ones are not.
      if (url.includes('ecb.europa.eu')) return Promise.resolve(null)
      return Promise.reject(new Error('fiscaldata_timeout'))
    },
  })
  eq(result.calls, 4)
  eq(result.rates.us_treasury_bill_3m?.ratePct, 4.11)
  eq(result.rates.sofr?.ratePct, 3.64)
  eq(result.rates.estr, undefined)
  eq(result.rates.us_treasury_bill_avg, undefined)
  const failures = Object.fromEntries(result.failures.map((f) => [f.key, f.reason]))
  eq(failures.estr, 'source_unavailable')
  eq(failures.us_treasury_bill_avg, 'fiscaldata_timeout')
  // Our capture clock is recorded separately from each rate's own date.
  eq(result.fetchedAt, '2026-09-16T12:00:00.000Z')
  eq(result.rates.sofr?.observedAt, '2026-09-15')

  // A run may narrow to the benchmarks it actually needs.
  const narrowed = await readBenchmarkRates({ fetchText: () => Promise.resolve(CURVE_XML) }, ['us_treasury_bill_3m'])
  eq(narrowed.calls, 1)
  eq(narrowed.rates.us_treasury_bill_3m?.ratePct, 4.11)
})
