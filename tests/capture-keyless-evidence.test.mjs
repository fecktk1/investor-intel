import test from 'node:test'
import assert from 'node:assert/strict'
import { captureKeylessEvidence, CAPTURE_SET } from '../scripts/capture-keyless-evidence.mjs'
import { evidenceIntegrityProblems, findRecordedSecrets, shapeDigest } from '../server/cmc-evidence-shape.ts'
import { CMC_CAPABILITIES } from '../server/cmc-capabilities.ts'

const NOW = Date.parse('2026-09-16T14:00:00Z')
const stamp = '2026-09-16T14:00:00.000Z'

// Bodies in the shape the keyless surface actually answers with. `error_code`
// is the STRING "0" on this surface, which is why nothing here compares it
// strictly against the number 0.
const BODIES = {
  '/v1/global-metrics/quotes/latest': {
    data: { active_cryptocurrencies: 9, last_updated: stamp, quote: { USD: { total_market_cap: 1234.5, last_updated: stamp } } },
    status: { timestamp: stamp, error_code: '0', error_message: '', elapsed: 11, credit_count: 1 },
  },
  '/v3/cryptocurrency/listings/latest': {
    data: [{ id: 1, name: 'Bitcoin', symbol: 'BTC', cmc_rank: 1, last_updated: stamp, quote: { USD: { price: 64000.5, last_updated: stamp } } }],
    status: { timestamp: stamp, error_code: '0', error_message: '', elapsed: 23, credit_count: 1 },
  },
  // A reported charge of zero on a surface that bills nobody. It must survive as
  // zero, never be rewritten to null and never be replaced by the estimate.
  '/v1/dex/holders/count': {
    data: { holders: 812345, tokenAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' },
    status: { timestamp: stamp, error_code: '0', error_message: '', elapsed: 7, credit_count: 0 },
  },
}

// The exact body the shared anonymous pool returns when it refuses.
const REFUSAL = { status: { timestamp: stamp, error_code: '1022', error_message: "You've reached the limit for anonymous access. Sign in to activate a free API plan or upgrade for higher limits.", credit_count: 0 } }

function harness(handler) {
  const calls = []
  const fetcher = async (url, init) => { calls.push({ url: String(url), init }); return handler(String(url), calls.length) }
  return { calls, options: { fetcher, now: () => NOW, sleep: async () => {}, spacingMs: 0 } }
}

const answering = (url) => {
  const path = new URL(url).pathname.replace('/public-api', '')
  const body = BODIES[path]
  if (!body) throw new Error(`unexpected route ${path}`)
  return Response.json(body)
}

test('a keyless capture records real answers with no credential anywhere in the request', async () => {
  const { calls, options } = harness(answering)
  const artefact = await captureKeylessEvidence(options)
  assert.equal(artefact.mode, 'keyless')
  assert.equal(artefact.probes.length, CAPTURE_SET.length)
  assert.equal(calls.length, CAPTURE_SET.length)
  for (const call of calls) {
    assert.ok(call.url.startsWith('https://pro-api.coinmarketcap.com/public-api/'), call.url)
    assert.deepEqual(Object.keys(call.init.headers), ['Accept'])
    assert.ok(!/CMC_PRO_API_KEY|apikey|api_key|authorization/i.test(JSON.stringify(call)))
  }
  for (const probe of artefact.probes) {
    assert.equal(probe.receipt.keyMode, 'keyless')
    assert.equal(probe.receipt.origin, 'live')
    assert.equal(probe.receipt.reservation, null)
    assert.equal(probe.surfacePrefix, '/public-api')
    // The keyed registry path, so a keyless artefact is still checkable against
    // the capability registry without a key.
    assert.equal(probe.endpoint, CMC_CAPABILITIES[probe.capability].path)
    assert.equal(probe.receipt.ttlSeconds, CMC_CAPABILITIES[probe.capability].ttl)
    assert.equal(probe.attempts, 1)
    assert.equal(probe.httpStatus, 200)
  }
})

test('the provider status object is carried verbatim and a reported zero stays zero', async () => {
  const { options } = harness(answering)
  const artefact = await captureKeylessEvidence(options)
  const byName = Object.fromEntries(artefact.probes.map((p) => [p.capability, p]))
  assert.deepEqual(byName.global.providerStatus, BODIES['/v1/global-metrics/quotes/latest'].status)
  assert.deepEqual(byName.listings.providerStatus, BODIES['/v3/cryptocurrency/listings/latest'].status)
  assert.equal(byName.global.receipt.creditCount, 1)
  // The whole point: zero is a reading, not an absence.
  assert.equal(byName.dexHolderCount.providerStatus.credit_count, 0)
  assert.equal(byName.dexHolderCount.receipt.creditCount, 0)
  assert.notEqual(byName.dexHolderCount.receipt.creditCount, null)
  assert.equal(artefact.reportedCreditTotal, 2)
  // No account is presented, so nothing is billed, and that is a different
  // number from what the provider reported.
  assert.equal(artefact.creditsSpent, 0)
})

test('a capture passes its own gate and carries no secret material', async () => {
  const { options } = harness(answering)
  const artefact = await captureKeylessEvidence(options)
  assert.deepEqual(await evidenceIntegrityProblems(artefact, CMC_CAPABILITIES), [])
  assert.deepEqual(await findRecordedSecrets(JSON.stringify(artefact, null, 2), null), [])
  for (const probe of artefact.probes) {
    assert.equal(await shapeDigest(probe.shapePaths), probe.shapeDigest)
    assert.equal(probe.shapePaths.$, 'object')
  }
})

test('a probe the anonymous pool refuses is recorded with its refusal, never dropped or invented', async () => {
  const { calls, options } = harness(() => Response.json(REFUSAL, { status: 429 }))
  const artefact = await captureKeylessEvidence({ ...options, attempts: 2, set: [['global', {}]] })
  assert.equal(artefact.probes.length, 1)
  const probe = artefact.probes[0]
  assert.equal(calls.length, 2, 'a refusal is retried once, then recorded as itself')
  assert.equal(probe.attempts, 2)
  assert.equal(probe.httpStatus, 429)
  assert.equal(probe.envelopeState, 'unavailable')
  assert.equal(probe.envelopeCode, 'keyless_rate_limited')
  assert.deepEqual(probe.providerStatus, REFUSAL.status)
  // Nothing was fetched, so nothing claims to have been.
  assert.equal(probe.receipt.fetchedAt, null)
  assert.equal(probe.receipt.staleUntil, null)
  assert.equal(probe.receipt.cacheAgeSeconds, null)
  // The provider reported a charge of zero for the refusal; it is carried.
  assert.equal(probe.receipt.creditCount, 0)
  assert.deepEqual(probe.topLevelKeys, ['status'])
  assert.deepEqual(await evidenceIntegrityProblems(artefact, CMC_CAPABILITIES), [])
})

test('a mixed capture keeps the answered probes and the refused one side by side', async () => {
  let seen = 0
  const { options } = harness((url) => { seen++; return seen === 1 ? answering(url) : Response.json(REFUSAL, { status: 429 }) })
  const artefact = await captureKeylessEvidence({ ...options, attempts: 1 })
  assert.equal(artefact.probes.length, 3)
  assert.equal(artefact.probes[0].envelopeState, 'fresh')
  assert.equal(artefact.probes[1].envelopeState, 'unavailable')
  assert.equal(artefact.probes[2].envelopeState, 'unavailable')
  assert.deepEqual(await evidenceIntegrityProblems(artefact, CMC_CAPABILITIES), [])
})
