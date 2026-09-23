/** Shape, not value: the vocabulary the recorded CoinMarketCap evidence artefact
 * and its drift gate share.
 *
 * Provider VALUES change every few seconds (a price, a rank, a credit balance);
 * provider SHAPES are the contract this platform actually reads. A gate that
 * compared bodies would be red every minute and would teach everyone to ignore
 * it, so nothing here records or compares a value. One walk turns a response
 * into a flat map of path -> type name with every array index collapsed to
 * `[]`: an array's LENGTH is a value, its member shape is the contract. Two
 * captures a week apart from the same endpoint produce byte-identical maps
 * unless the provider really changed the contract.
 *
 * This lives beside the transport because the artefact records CmcReceipt
 * objects verbatim and RECEIPT_FIELDS below must track that interface. The
 * colocated test pins it against the transport SOURCE rather than against the
 * type, because `npm test` runs Deno with --no-check and a type-level guard
 * would not execute at all.
 *
 * Nothing here names a provider host, reads a credential, or performs IO. */

export const EVIDENCE_SCHEMA = 'cmc-receipt-evidence/1'

/** Exactly the required fields of CmcReceipt in cmc-transport.ts, in declaration order. */
export const RECEIPT_FIELDS = ['capability', 'endpoint', 'parameters', 'httpStatus', 'creditCount', 'elapsedMs',
  'origin', 'keyMode', 'cacheAgeSeconds', 'ttlSeconds', 'staleUntil', 'fetchedAt', 'reservation'] as const
/** The optional (`?:`) fields of CmcReceipt. A recorded receipt may carry them or
 * not: the artefacts recorded before `proof` existed stay valid, and a receipt
 * that does carry one still names nothing outside the interface. */
export const RECEIPT_OPTIONAL_FIELDS = ['proof'] as const
export const RECEIPT_ORIGINS = ['live', 'cache', 'negative-cache']
export const RECEIPT_KEY_MODES = ['keyed', 'keyless']

export interface ShapeLimits { maxMembers?: number; maxDepth?: number; maxPaths?: number }
export interface ShapeDifference {
  added: string[]; removed: string[]
  changed: Array<{ path: string; recorded: string; observed: string }>
  identical: boolean
}

const typeName = (v: unknown): string => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v
/** Two members disagreeing about a field's type is itself a stable fact about
 * the endpoint (`platform` is an object on some rows and null on others), so a
 * union is recorded rather than whichever member happened to come first. */
const union = (a: string, b: string): string => a === b ? a : [...new Set([...a.split('|'), ...b.split('|')])].sort().join('|')

/** A response reduced to `path -> type`. The root is `$`; `a.[].b` is field `b`
 * of every member of array `a`. Deterministic: keys are walked sorted, so the
 * map is a stable digest input. */
export function shapePaths(value: unknown, limits: ShapeLimits = {}): Record<string, string> {
  const maxMembers = limits.maxMembers ?? 50, maxDepth = limits.maxDepth ?? 12, maxPaths = limits.maxPaths ?? 4000
  const out: Record<string, string> = {}
  let truncated = false
  const visit = (node: unknown, path: string, depth: number) => {
    if (Object.keys(out).length >= maxPaths) { truncated = true; return }
    out[path] = out[path] === undefined ? typeName(node) : union(out[path], typeName(node))
    if (depth >= maxDepth) { truncated = true; return }
    // Index collapse. A page of 250 rows and a page of 3 give the same map: a
    // wider page repeats the contract, it cannot change it. Reading only the
    // first maxMembers keeps a large listing bounded.
    if (Array.isArray(node)) { for (const member of node.slice(0, maxMembers)) visit(member, `${path}.[]`, depth + 1); return }
    if (node && typeof node === 'object') {
      for (const key of Object.keys(node as object).sort()) visit((node as Record<string, unknown>)[key], `${path}.${key}`, depth + 1)
    }
  }
  visit(value, '$', 0)
  // A truncated walk is a different reading from a complete one and says so,
  // rather than silently comparing a partial map against a full one.
  if (truncated) out.$truncated = 'boolean'
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
}

async function sha256Hex(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
    .map((v) => v.toString(16).padStart(2, '0')).join('')
}

/** A digest of the shape map alone. Recomputing it is how a keyless run proves
 * the recorded map was not edited after the capture that produced it. */
export function shapeDigest(paths: Record<string, string>): Promise<string> {
  return sha256Hex(JSON.stringify(Object.keys(paths).sort().map((key) => [key, paths[key]])))
}

/** What changed between a recorded shape and a freshly observed one. Values are
 * not an input here and cannot appear in the result. */
export function compareShapePaths(recorded: Record<string, string>, observed: Record<string, string>): ShapeDifference {
  const added = Object.keys(observed).filter((path) => recorded[path] === undefined).sort()
  const removed = Object.keys(recorded).filter((path) => observed[path] === undefined).sort()
  const changed = Object.keys(recorded).filter((path) => observed[path] !== undefined && observed[path] !== recorded[path])
    .sort().map((path) => ({ path, recorded: recorded[path], observed: observed[path] }))
  return { added, removed, changed, identical: !added.length && !removed.length && !changed.length }
}

/** Key-shaped material, scanned for without a key in hand.
 *
 * A CoinMarketCap key is a UUID, so a UUID anywhere in an artefact is treated
 * as a credential until proven otherwise. The 24-hex check is the cache-key
 * fingerprint from cmc-transport.ts. It has one known false positive, since an
 * RWA `issuer_id` is also 24 hex, and that is deliberate: a capture that wants to
 * record issuer identities must teach this scan about that field rather than
 * loosen the rule. No sha256 check lives here because the artefact's own shape
 * digests are sha256 hex; the exact key-digest comparison below covers it
 * whenever a key is actually present. */
const KEY_SHAPED: Array<[string, RegExp]> = [
  ['credential_header', /X-CMC[_-]PRO[_-]API[_-]KEY/i],
  ['uuid_shaped_token', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ['fingerprint_shaped_token', /(?<![0-9a-fA-Fx])[0-9a-f]{24}(?![0-9a-fA-F])/],
]

/** The NAMES of any secret material found in `text`, never the material. An
 * empty array is the only result that permits a write. */
export async function findRecordedSecrets(text: string, key?: string | null): Promise<string[]> {
  const found = new Set<string>()
  if (typeof key === 'string' && key.length >= 8) {
    if (text.includes(key)) found.add('api_key')
    if (text.includes(key.slice(0, 8))) found.add('api_key_prefix')
    if (text.includes(key.slice(-8))) found.add('api_key_suffix')
    const digest = await sha256Hex(key)
    if (text.includes(digest)) found.add('key_sha256')
    // cmc-transport.ts builds its shared cache key from exactly this slice.
    if (text.includes(digest.slice(0, 24))) found.add('key_fingerprint')
  }
  for (const [name, pattern] of KEY_SHAPED) if (pattern.test(text)) found.add(name)
  return [...found].sort()
}

export interface CapabilitySpec { path: string; cost: string; ttl: number; stale: number }

const isFiniteNumber = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v)

/** Everything about a recorded artefact that can be checked WITHOUT a key, as a
 * list of named reasons. An empty list is a pass; the caller decides what a
 * problem costs. The registry is injected so this module stays IO-free and so a
 * test can pin a drifting endpoint without editing the real registry. */
export async function evidenceIntegrityProblems(artefact: unknown, registry: Record<string, CapabilitySpec>): Promise<string[]> {
  const problems: string[] = []
  if (!artefact || typeof artefact !== 'object' || Array.isArray(artefact)) return ['artefact_not_an_object']
  const file = artefact as Record<string, any>
  if (file.schema !== EVIDENCE_SCHEMA) problems.push(`schema_unrecognised:${String(file.schema ?? 'absent')}`)
  if (!Number.isFinite(Date.parse(String(file.capturedAt ?? '')))) problems.push('captured_at_unreadable')
  if (!Array.isArray(file.probes)) return [...problems, 'probes_absent']
  if (!file.probes.length) problems.push('probes_empty')

  let reported = 0
  for (const [index, raw] of (file.probes as unknown[]).entries()) {
    const probe = raw as Record<string, any>
    const name = typeof probe?.capability === 'string' && probe.capability ? probe.capability : `#${index}`
    if (!probe || typeof probe !== 'object') { problems.push(`probe_not_an_object:${name}`); continue }
    const spec = registry[probe.capability]
    if (!spec) { problems.push(`capability_unregistered:${name}`); continue }
    // The registry moving under a recorded capture is exactly the drift a
    // keyless run can still catch: the artefact no longer describes the code.
    if (probe.endpoint !== spec.path) problems.push(`endpoint_drift:${name}`)
    if (String(probe.registeredCost) !== String(spec.cost)) problems.push(`cost_drift:${name}`)

    const receipt = probe.receipt as Record<string, any> | undefined
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) problems.push(`receipt_absent:${name}`)
    else {
      const optional: readonly string[] = RECEIPT_OPTIONAL_FIELDS
      const fields = Object.keys(receipt).filter((field) => !optional.includes(field)).sort().join(',')
      if (fields !== [...RECEIPT_FIELDS].sort().join(',')) problems.push(`receipt_fields:${name}`)
      if (receipt.capability !== probe.capability) problems.push(`receipt_capability_mismatch:${name}`)
      if (receipt.endpoint !== probe.endpoint) problems.push(`receipt_endpoint_mismatch:${name}`)
      if (!RECEIPT_ORIGINS.includes(String(receipt.origin))) problems.push(`receipt_origin:${name}`)
      if (!RECEIPT_KEY_MODES.includes(String(receipt.keyMode))) problems.push(`receipt_key_mode:${name}`)
      if (receipt.creditCount !== null && !(isFiniteNumber(receipt.creditCount) && receipt.creditCount >= 0)) problems.push(`receipt_credit_count:${name}`)
      // A provider-reported charge is the whole point of the artefact, and a
      // reported 0 is a real charge of zero: the receipt must carry it exactly,
      // never as null and never replaced by the registry estimate.
      const declared = probe.providerStatus?.credit_count
      if (isFiniteNumber(declared) && receipt.creditCount !== declared) problems.push(`credit_count_mismatch:${name}`)
      if (receipt.ttlSeconds !== null && receipt.ttlSeconds !== spec.ttl) problems.push(`receipt_ttl_drift:${name}`)
    }
    if (isFiniteNumber(probe.providerStatus?.credit_count)) reported += probe.providerStatus.credit_count

    const paths = probe.shapePaths
    if (!paths || typeof paths !== 'object' || Array.isArray(paths)) problems.push(`shape_absent:${name}`)
    else if (await shapeDigest(paths as Record<string, string>) !== probe.shapeDigest) problems.push(`shape_digest_mismatch:${name}`)
  }
  if (isFiniteNumber(file.reportedCreditTotal) && file.reportedCreditTotal !== reported) problems.push('reported_credit_total_mismatch')
  return problems
}
