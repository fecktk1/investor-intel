import assert from 'node:assert/strict'
import {
  compareShapePaths, EVIDENCE_SCHEMA, evidenceIntegrityProblems, findRecordedSecrets,
  RECEIPT_FIELDS, RECEIPT_OPTIONAL_FIELDS, shapeDigest, shapePaths, type CapabilitySpec,
} from './cmc-evidence-shape.ts'

const REGISTRY: Record<string, CapabilitySpec> = {
  fiatMap: { path: '/v1/fiat/map', cost: 'one', ttl: 86400, stale: 86400 },
  map: { path: '/v1/cryptocurrency/map', cost: 'zero', ttl: 86400, stale: 86400 },
}

const receipt = (over: Record<string, unknown> = {}) => ({
  capability: 'fiatMap', endpoint: '/v1/fiat/map', parameters: { limit: '1', start: '1' },
  httpStatus: 200, creditCount: 1, elapsedMs: 41, origin: 'live', keyMode: 'keyed',
  cacheAgeSeconds: 0, ttlSeconds: 86400, staleUntil: '2026-09-17T09:00:00.000Z',
  fetchedAt: '2026-09-16T09:00:00.000Z', reservation: null, ...over,
})

async function probe(body: unknown, over: Record<string, unknown> = {}) {
  const paths = shapePaths(body)
  return {
    capability: 'fiatMap', endpoint: '/v1/fiat/map', method: 'GET', registeredCost: 'one',
    parameters: { limit: '1', start: '1' }, httpStatus: 200, latencyMs: 41,
    providerStatus: { timestamp: '2026-09-16T09:00:00.000Z', error_code: 0, error_message: null, elapsed: 8, credit_count: 1 },
    receipt: receipt(), topLevelKeys: ['data', 'status'], shapePaths: paths, shapeDigest: await shapeDigest(paths), ...over,
  }
}

async function artefact(body: unknown, over: Record<string, unknown> = {}) {
  return {
    schema: EVIDENCE_SCHEMA, capturedAt: '2026-09-16T09:00:00.000Z',
    reportedCreditTotal: 1, probes: [await probe(body)], ...over,
  }
}

const FIAT = { data: [{ id: 2781, name: 'United States Dollar', sign: '$', symbol: 'USD' }], status: { error_code: 0, credit_count: 1 } }

Deno.test('a figure that moves leaves the recorded shape byte-identical', async () => {
  const later = { data: [{ id: 2781, name: 'United States Dollar', sign: '$', symbol: 'USD' }], status: { error_code: 0, credit_count: 1 } }
  later.data[0].name = 'Something The Provider Renamed In The Value'
  later.status.credit_count = 7
  assert.deepEqual(shapePaths(later), shapePaths(FIAT))
  assert.equal(await shapeDigest(shapePaths(later)), await shapeDigest(shapePaths(FIAT)))
  assert.equal(compareShapePaths(shapePaths(FIAT), shapePaths(later)).identical, true)
})

Deno.test('an added or removed provider field is a shape change reported by path', () => {
  const widened = { ...FIAT, data: [{ ...FIAT.data[0], plural_name: 'US Dollars' }] }
  const widerDiff = compareShapePaths(shapePaths(FIAT), shapePaths(widened))
  assert.equal(widerDiff.identical, false)
  assert.deepEqual(widerDiff.added, ['$.data.[].plural_name'])
  assert.deepEqual(widerDiff.removed, [])
  const narrowed = { ...FIAT, data: [{ id: 2781, name: 'United States Dollar', symbol: 'USD' }] }
  assert.deepEqual(compareShapePaths(shapePaths(FIAT), shapePaths(narrowed)).removed, ['$.data.[].sign'])
})

Deno.test('a field that changes type is a type change rather than an addition', () => {
  const stringified = { ...FIAT, data: [{ ...FIAT.data[0], id: '2781' }] }
  const diff = compareShapePaths(shapePaths(FIAT), shapePaths(stringified))
  assert.deepEqual(diff.added, [])
  assert.deepEqual(diff.removed, [])
  assert.deepEqual(diff.changed, [{ path: '$.data.[].id', recorded: 'number', observed: 'string' }])
})

Deno.test('an array records its member shape and never its length', () => {
  const one = { rows: [{ a: 1 }] }, many = { rows: [{ a: 1 }, { a: 2 }, { a: 3 }] }
  assert.deepEqual(shapePaths(one), shapePaths(many))
  // Members that disagree about a type are recorded as the union, not as
  // whichever member happened to be read first.
  assert.equal(shapePaths({ rows: [{ a: 1 }, { a: null }] })['$.rows.[].a'], 'null|number')
})

Deno.test('the recorded receipt names exactly the fields the transport declares', async () => {
  const source = await Deno.readTextFile(new URL('./cmc-transport.ts', import.meta.url))
  const start = source.indexOf('export interface CmcReceipt {')
  assert.ok(start > 0, 'CmcReceipt is no longer declared in cmc-transport.ts')
  const block = source.slice(start, source.indexOf('\n}', start))
  const declared = [...block.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map((m) => m[1]).sort()
  assert.deepEqual(declared, [...RECEIPT_FIELDS].sort())
  // Optional members are declared `name?:` and listed separately, so a new
  // optional field cannot slip in without the artefact vocabulary naming it.
  const optional = [...block.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\?\s*:/g)].map((m) => m[1]).sort()
  assert.deepEqual(optional, [...RECEIPT_OPTIONAL_FIELDS].sort())
})

Deno.test('a recorded receipt may carry the optional proof, and nothing else outside the interface', async () => {
  const recorded = await artefact(FIAT)
  const first = recorded.probes[0]
  const withProof = { ...recorded, probes: [{ ...first, receipt: { ...first.receipt, proof: null } }] }
  assert.deepEqual(await evidenceIntegrityProblems(withProof, REGISTRY), [])
  const extra = { ...recorded, probes: [{ ...first, receipt: { ...first.receipt, rawBody: {} } }] }
  assert.deepEqual(await evidenceIntegrityProblems(extra, REGISTRY), ['receipt_fields:fiatMap'])
})

Deno.test('an artefact that carries a key, a key prefix or a cache-key fingerprint is refused', async () => {
  const key = '11111111-2222-3333-4444-555555555555'
  const fingerprint = (await shapeDigest({ any: 'thing' })).slice(0, 24)
  assert.deepEqual(await findRecordedSecrets(JSON.stringify(await artefact(FIAT)), key), [])
  assert.deepEqual(await findRecordedSecrets(`{"k":"${key}"}`, key), ['api_key', 'api_key_prefix', 'api_key_suffix', 'uuid_shaped_token'])
  assert.deepEqual(await findRecordedSecrets(`{"cacheKey":"cmc:v3:basic:${fingerprint}:map"}`, null), ['fingerprint_shaped_token'])
  assert.deepEqual(await findRecordedSecrets('{"headers":{"X-CMC_PRO_API_KEY":"redacted"}}', null), ['credential_header'])
})

Deno.test('a recorded capture whose registry entry has moved fails without a key', async () => {
  assert.deepEqual(await evidenceIntegrityProblems(await artefact(FIAT), REGISTRY), [])
  const moved = { ...REGISTRY, fiatMap: { ...REGISTRY.fiatMap, path: '/v2/fiat/map' } }
  // The receipt still agrees with the probe it was recorded beside; what no
  // longer agrees is the code, and that is what the keyless run catches.
  assert.deepEqual(await evidenceIntegrityProblems(await artefact(FIAT), moved), ['endpoint_drift:fiatMap'])
  const repriced = { ...REGISTRY, fiatMap: { ...REGISTRY.fiatMap, cost: '250' } }
  assert.deepEqual(await evidenceIntegrityProblems(await artefact(FIAT), repriced), ['cost_drift:fiatMap'])
  assert.deepEqual(await evidenceIntegrityProblems({ schema: EVIDENCE_SCHEMA, capturedAt: '2026-09-16T09:00:00.000Z' }, REGISTRY), ['probes_absent'])
})

Deno.test('a reported charge of zero is kept as zero and never read as unknown', async () => {
  const free = await artefact(FIAT, { reportedCreditTotal: 0 })
  free.probes[0].providerStatus.credit_count = 0
  free.probes[0].receipt = receipt({ creditCount: 0 })
  assert.deepEqual(await evidenceIntegrityProblems(free, REGISTRY), [])
  // Null where the provider reported a number is the substitution this guards.
  const erased = await artefact(FIAT, { reportedCreditTotal: 1 })
  erased.probes[0].receipt = receipt({ creditCount: null })
  assert.deepEqual(await evidenceIntegrityProblems(erased, REGISTRY), ['credit_count_mismatch:fiatMap'])
})

Deno.test('a shape map edited after the capture fails its own digest', async () => {
  const tampered = await artefact(FIAT)
  tampered.probes[0].shapePaths['$.data.[].sign'] = 'number'
  assert.deepEqual(await evidenceIntegrityProblems(tampered, REGISTRY), ['shape_digest_mismatch:fiatMap'])
  const dropped = await artefact(FIAT)
  delete (dropped.probes[0].receipt as Record<string, unknown>).reservation
  assert.deepEqual(await evidenceIntegrityProblems(dropped, REGISTRY), ['receipt_fields:fiatMap'])
})

Deno.test('a walk that had to stop says so instead of comparing a partial map', () => {
  let deep: Record<string, unknown> = { leaf: 1 }
  for (let level = 0; level < 20; level++) deep = { down: deep }
  assert.equal(shapePaths(deep).$truncated, 'boolean')
  assert.equal(shapePaths({ shallow: 1 }).$truncated, undefined)
})
