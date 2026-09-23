// Keyless evidence capture: a dated artefact of REAL CoinMarketCap calls that a
// judge can regenerate on their own machine, with no key, no account and no
// credential of any kind.
//
// WHY THIS LIVES HERE. The keyless surface may not be reached from the parent
// product: scripts/test-intel-extraction-package.mjs fails if any product
// source names it, and _shared/market-assets/cmc-consumer-governance.test.ts
// allowlists exactly two files that may name the CMC host. This extraction is
// the one place the keyless mode is allowed to exist, and server/keyless.mjs is
// the one module in it that speaks to the keyless API.
//
// This file does not speak to the API either. It hands the keyless client a
// transport shim that records the raw bytes of each answer, and the client
// keeps sole authority over the host, the path, the parameters, the single
// Accept header, the 30-second cache and the request ceilings. The shim exists
// because the client's envelope carries normalised rows, and an evidence file
// needs the provider's own `status` object exactly as it arrived.
//
// WHAT IS RECORDED. Per probe: the provider's verbatim `status` (timestamp,
// error_code, elapsed, credit_count), the HTTP status, a CmcReceipt in the
// field layout supabase/functions/_shared/market-assets/cmc-transport.ts
// declares with keyMode 'keyless', and a shape map of path -> type. Shapes, not
// values, are what the drift gate compares.
//
// A REFUSAL IS EVIDENCE TOO. The anonymous pool is shared per IP and refuses
// readily: on 2026-09-16 this network got two answers and then HTTP 429 with
// error_code 1022 inside ninety seconds. A refused probe is recorded with its
// verbatim status rather than retried into the wall or quietly dropped, because
// a capture that hides a refusal is worth less than one that shows it.
//
// CREDITS. Zero. No key is presented, so no account of ours is debited. The
// keyless surface still reports a `credit_count` per call and that number is
// recorded exactly as it arrived, including a reported zero.
//
//   node scripts/capture-keyless-evidence.mjs --out evidence
//
import { mkdir, writeFile } from 'node:fs/promises'
import { createKeylessClient, keylessParams, KEYLESS_BASE, KEYLESS_CAVEAT, KEYLESS_ENDPOINTS, KEYLESS_SOURCE } from '../server/keyless.mjs'
import { CMC_CAPABILITIES } from '../server/cmc-capabilities.ts'
import { EVIDENCE_SCHEMA, evidenceIntegrityProblems, findRecordedSecrets, shapeDigest, shapePaths } from '../server/cmc-evidence-shape.ts'

const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'

/** Three routes, all already mapped in KEYLESS_ENDPOINTS, all of which answered
 * this network on 2026-09-16. Deliberately small: the anonymous pool is shared,
 * and a wide sweep would exhaust it for everyone and record mostly refusals. */
export const CAPTURE_SET = [
  ['global', {}],
  ['listings', { start: 1, limit: 5 }],
  ['dexHolderCount', { platform: 'ethereum', tokenAddress: WETH }],
]

const KEYLESS_PREFIX = new URL(KEYLESS_BASE).pathname

/** A transport shim that records the raw bytes. It never chooses a URL: it is
 * handed one the keyless client built and validated against its own base. */
function recordingFetcher(fetcher, sink) {
  return async (url, init) => {
    const started = Date.now()
    const response = await fetcher(url, init)
    const raw = await response.text()
    sink.push({ url: String(url), status: response.status, raw, elapsedMs: Date.now() - started })
    return new Response(raw, { status: response.status, headers: response.headers })
  }
}

const parse = (raw) => { try { return JSON.parse(raw) } catch { return null } }
const creditOf = (status) => {
  const value = status?.credit_count
  return value != null && Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : null
}

export async function captureKeylessEvidence({
  fetcher = fetch, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  attempts = 3, spacingMs = 45_000, set = CAPTURE_SET,
} = {}) {
  const sink = []
  const keyless = createKeylessClient({ fetcher: recordingFetcher(fetcher, sink), now })
  const probes = []

  for (const [capability, input] of set) {
    const spec = CMC_CAPABILITIES[capability]
    const route = KEYLESS_ENDPOINTS[capability]
    if (!spec || !route) throw new Error(`unsupported_capability:${capability}`)
    const params = keylessParams(capability, input)

    let envelope = null, call = null, used = 0
    for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
      used = attempt
      sink.length = 0
      envelope = await keyless.read(capability, input)
      call = sink.at(-1) ?? null
      if (envelope.state === 'fresh') break
      // A failure is never cached by the client, so a spaced retry really does
      // ask again. Past the last attempt the refusal itself is the record.
      if (attempt < attempts) await sleep(spacingMs)
    }

    const body = call ? parse(call.raw) : null
    const status = body?.status ?? null
    const answered = envelope?.state === 'fresh'
    const fetchedAt = answered ? envelope.provenance.fetchedAt : null
    const paths = shapePaths(body)
    probes.push({
      capability,
      // The KEYED registry path, so the artefact can be checked against the
      // capability registry without a key. The keyless prefix is recorded
      // separately rather than fused into it.
      endpoint: spec.path,
      surfacePrefix: KEYLESS_PREFIX,
      method: 'GET',
      registeredCost: spec.cost,
      parameters: params,
      attempts: used,
      httpStatus: call?.status ?? null,
      latencyMs: call?.elapsedMs ?? null,
      envelopeState: envelope?.state ?? null,
      envelopeCode: envelope?.code ?? null,
      // Verbatim. This is the authenticity of the artefact and is never rewritten.
      providerStatus: status,
      receipt: {
        capability, endpoint: spec.path, parameters: params,
        httpStatus: call?.status ?? null, creditCount: creditOf(status), elapsedMs: call?.elapsedMs ?? null,
        origin: 'live', keyMode: 'keyless',
        cacheAgeSeconds: answered ? 0 : null, ttlSeconds: spec.ttl,
        staleUntil: fetchedAt ? new Date(Date.parse(fetchedAt) + spec.stale * 1000).toISOString() : null,
        fetchedAt,
        // No reservation: the keyless surface has no account and no ledger, and
        // naming one would be an invention.
        reservation: null,
      },
      topLevelKeys: body && typeof body === 'object' ? Object.keys(body).slice(0, 12) : [],
      shapePaths: paths, shapeDigest: await shapeDigest(paths),
    })
  }

  const reportedCreditTotal = probes.reduce((sum, probe) => sum + (creditOf(probe.providerStatus) ?? 0), 0)
  return {
    schema: EVIDENCE_SCHEMA,
    capturedAt: new Date(now()).toISOString(),
    mode: 'keyless',
    source: KEYLESS_SOURCE,
    surface: { base: KEYLESS_BASE, prefix: KEYLESS_PREFIX },
    caveat: KEYLESS_CAVEAT,
    note: 'Recorded by examples/investor-intel-hackathon/scripts/capture-keyless-evidence.mjs through server/keyless.mjs. Real calls, no credential of any kind, provider status objects verbatim. No account is debited: the keyless surface reports a credit_count but bills nobody, so creditsSpent is 0 while reportedCreditTotal is what the provider itself reported. A probe the shared anonymous pool refused is recorded with its refusal rather than dropped.',
    // Zero, and not the same number as reportedCreditTotal on purpose.
    creditsSpent: 0,
    reportedCreditTotal,
    probes,
  }
}

/** Serialise, scan, then write. Never the other way round. */
export async function writeKeylessEvidence(artefact, directory) {
  const serialised = JSON.stringify(artefact, null, 2) + '\n'
  // There is no key in this mode, which is exactly why the scan stays
  // unconditional: the property worth keeping is that nothing is ever written
  // without being searched first.
  const secrets = await findRecordedSecrets(serialised, null)
  if (secrets.length) throw new Error(`Refusing to write: the capture contains ${secrets.join(', ')}`)
  const problems = await evidenceIntegrityProblems(artefact, CMC_CAPABILITIES)
  if (problems.length) throw new Error(`Refusing to write a capture that fails its own gate: ${problems.join(', ')}`)
  await mkdir(directory, { recursive: true })
  const file = `${directory}/cmc-receipt-evidence-${artefact.capturedAt.slice(0, 10)}.json`
  await writeFile(file, serialised)
  return file
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const directory = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'evidence'
  const artefact = await captureKeylessEvidence()
  const file = await writeKeylessEvidence(artefact, directory)
  const column = (v, width) => String(v ?? '').padEnd(width).slice(0, width)
  console.log(`${column('capability', 16)}${column('http', 6)}${column('error', 8)}${column('credit_count', 13)}${column('tries', 6)}shape paths`)
  for (const p of artefact.probes) {
    console.log(`${column(p.capability, 16)}${column(p.httpStatus, 6)}${column(p.providerStatus?.error_code, 8)}${column(p.receipt.creditCount, 13)}${column(p.attempts, 6)}${Object.keys(p.shapePaths).length}`)
  }
  console.log(`\ncredits spent 0 (no account was presented); provider-reported credit_count total ${artefact.reportedCreditTotal}`)
  console.log(`no secret material found in the artefact; evidence written to ${file}`)
}
