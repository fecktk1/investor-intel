import { strict as assert } from 'node:assert'
import { allowedSourceUrl, fetchSource, sourceExportAllowed, __resetRwaSourceStateForTests } from './http.ts'
import { deps, fakeFetch, EDGAR_AGENT } from './test-support.ts'

const GLEIF = 'https://api.gleif.org/api/v1/lei-records/254900RYEZ47C0C0YO93'
const EDGAR = 'https://data.sec.gov/submissions/CIK0002004367.json'

Deno.test('EDGAR without a descriptive User-Agent is an honest named failure rather than an empty result', async () => {
  __resetRwaSourceStateForTests()
  const { impl, calls } = fakeFetch({ [EDGAR]: { body: { cik: '0002004367' } } })
  const response = await fetchSource('edgar', EDGAR, deps(impl))
  assert.equal(response.ok, false)
  assert.equal(response.reason, 'user_agent_required')
  assert.equal(response.data, null)
  // The point of refusing early: no request is issued at all, so the caller can
  // never mistake a 403 body for "this filer has no submissions".
  assert.equal(calls.length, 0)
  assert.ok(response.fetchedAt)
})

Deno.test('a descriptive User-Agent is sent to EDGAR and the parsed body is returned', async () => {
  __resetRwaSourceStateForTests()
  const { impl, calls } = fakeFetch({ [EDGAR]: { body: { cik: '0002004367', name: 'Invesco Short Duration US Government Securities Fund' } } })
  const response = await fetchSource<{ cik: string }>('edgar', EDGAR, deps(impl, { userAgent: EDGAR_AGENT }))
  assert.equal(response.ok, true)
  assert.equal(response.data?.cik, '0002004367')
  assert.equal(calls[0].headers['User-Agent'], EDGAR_AGENT)
})

Deno.test('a source may only be fetched on its own hosts and never with embedded credentials', () => {
  assert.equal(allowedSourceUrl('gleif', GLEIF), true)
  assert.equal(allowedSourceUrl('gleif', 'https://api.gleif.org.evil.test/api/v1/lei-records'), false)
  // EDGAR's host is not GLEIF's host, even though both are allowlisted sources.
  assert.equal(allowedSourceUrl('gleif', EDGAR), false)
  assert.equal(allowedSourceUrl('edgar', 'http://data.sec.gov/submissions/CIK1.json'), false)
  assert.equal(allowedSourceUrl('edgar', 'https://user:pass@data.sec.gov/submissions/CIK1.json'), false)
})

Deno.test('a redirect that leaves the source hosts is refused instead of being trusted as that source', async () => {
  __resetRwaSourceStateForTests()
  const { impl } = fakeFetch({ [GLEIF]: { body: { data: {} }, url: 'https://elsewhere.test/lei' } })
  const response = await fetchSource('gleif', GLEIF, deps(impl))
  assert.equal(response.ok, false)
  assert.equal(response.reason, 'redirected_off_source')
})

Deno.test('an unsuccessful status, unparseable body, timeout and network loss each carry their own reason', async () => {
  __resetRwaSourceStateForTests()
  const notFound = await fetchSource('gleif', GLEIF, deps(fakeFetch({ [GLEIF]: { status: 404, body: { errors: [] } } }).impl))
  assert.equal(notFound.reason, 'http_404')
  assert.equal(notFound.status, 404)

  __resetRwaSourceStateForTests()
  const broken = await fetchSource('gleif', GLEIF, deps(fakeFetch({ [GLEIF]: { body: 'not json at all' } }).impl))
  assert.equal(broken.reason, 'invalid_json')

  __resetRwaSourceStateForTests()
  const timedOut = await fetchSource('gleif', GLEIF, deps(fakeFetch({ [GLEIF]: { throws: 'abort' } }).impl))
  assert.equal(timedOut.reason, 'timeout')

  __resetRwaSourceStateForTests()
  const offline = await fetchSource('gleif', GLEIF, deps(fakeFetch({ [GLEIF]: { throws: 'network' } }).impl))
  assert.equal(offline.reason, 'network_unavailable')
  // Every failure still answers, and none of them throws.
  for (const r of [notFound, broken, timedOut, offline]) assert.equal(r.data, null)
})

Deno.test('a response larger than its ceiling is refused rather than buffered', async () => {
  __resetRwaSourceStateForTests()
  const { impl } = fakeFetch({ [GLEIF]: { body: 'x'.repeat(500), headers: { 'content-length': '5000' } } })
  const response = await fetchSource('gleif', GLEIF, deps(impl), { maxBytes: 100 })
  assert.equal(response.ok, false)
  assert.equal(response.reason, 'response_too_large')
})

Deno.test('export rights follow the source licence, and the explorer with unverified terms is not exportable', () => {
  // GLEIF is CC0 and EDGAR and OFAC are US public domain.
  for (const source of ['gleif', 'edgar', 'ofac', 'sourcify'] as const) assert.equal(sourceExportAllowed(source), true)
  // Blockscout's redistribution terms could not be verified on 2026-09-16.
  assert.equal(sourceExportAllowed('blockscout'), false)
})

// Checked 2026-09-16: the SDN file ends on a signed download from OFAC's
// published-list bucket. Only that exact bucket host is added, never S3 at large.
Deno.test('ofac follows its own publication chain to the published-list bucket and nowhere else on S3', () => {
  assert.equal(allowedSourceUrl('ofac', 'https://www.treasury.gov/ofac/downloads/sdn.csv'), true)
  assert.equal(allowedSourceUrl('ofac', 'https://sanctionslistservice.ofac.treas.gov/api/publicationpreview/exports/sdn.csv'), true)
  assert.equal(allowedSourceUrl('ofac', 'https://wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com/Published/x/2026-09-15/y/SDN.CSV?X-Amz-Expires=3600'), true)
  assert.equal(allowedSourceUrl('ofac', 'https://other-bucket.s3.us-gov-west-1.amazonaws.com/SDN.CSV'), false)
  assert.equal(allowedSourceUrl('ofac', 'https://wc2h-sls-prod-public-published.s3.us-east-1.amazonaws.com/SDN.CSV'), false)
  assert.equal(allowedSourceUrl('gleif', 'https://wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com/SDN.CSV'), false)
})
