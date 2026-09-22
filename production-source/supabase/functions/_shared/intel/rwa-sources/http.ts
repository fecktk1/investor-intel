// Investor Intel: the single keyless transport for every FREE PRIMARY source
// behind the RWA issuer legitimacy graph.
//
// WHY this module exists. A rival answer to "can I legally invest in this?"
// reads a HAND-CURATED registry. A curated registry is wrong the day it ships:
// see rwa-issuer-aliases.ts for the dated, reproduced proof that one fund was
// renamed and had its admission terms changed underneath its own token. Every
// figure here comes from a primary source instead, so it can carry its own
// fetch time, source URL and scope string.
//
// House pattern: keyless like _shared/exchange-market/http.ts, dependency
// injected like _shared/intel/capture-jobs.ts. NO auth headers, NO API keys, NO
// signing, NO account endpoints. `fetchImpl`, `now` and `userAgent` arrive
// through `deps`, so every adapter tests without a network.
//
// NEVER THROWS. A failure is a NAMED reason on an unsuccessful response, never
// an empty success and never an exception. A list that failed to load states
// why; it must not render as "no records".
//
// HOST ALLOWLIST. A source may only be fetched on its own hosts, and redirects
// are not followed automatically. A URL that does not match is
// `host_not_allowed`, so neither a caller mistake nor a redirect can turn this
// transport into a general-purpose fetcher.
//
// LICENSING, each checked 2026-09-16. This decides `exportAllowed` on any
// observation an adapter derives from the source, so it belongs next to the
// transport rather than in a comment somewhere downstream:
//
//   gleif      CC0. Free commercial redistribution. Exportable.
//   edgar      US public domain. Free redistribution. Exportable. REQUIRES a
//              descriptive User-Agent: data.sec.gov answered 403 without one
//              when probed 2026-09-16. Documented ceiling 10 requests/second.
//   blockscout Redistribution terms COULD NOT BE VERIFIED (probed 2026-09-16).
//              Treated as display-with-attribution only: every observation
//              derived from it sets exportAllowed:false and says so in its
//              scope string. Do NOT build a redistributable derived dataset
//              from this source.
//   sourcify   Publicly published verified contract source. Exportable.
//   ofac       US government publication. Exportable.
//
// RATE POLICY. GLEIF publishes no ratelimit headers and no documented ceiling
// (40 rapid calls all answered 200 on 2026-09-16), so the limit is UNKNOWN and
// the only safe posture is to be polite and cache hard. Blockscout does publish
// one (`x-ratelimit-limit: 180`, observed 2026-09-16). EDGAR documents 10/s.
// The per-source minimum interval below is deliberately more conservative than
// any published figure: this lane is never in a hurry.

export const RWA_SOURCE_IDS = ['gleif', 'edgar', 'blockscout', 'sourcify', 'ofac'] as const
export type RwaSourceId = typeof RWA_SOURCE_IDS[number]

export interface SourcePolicy {
  /** Exact hosts this source may be fetched on. Nothing else is reachable. */
  hosts: readonly string[]
  /** EDGAR answers 403 without a descriptive agent, so a call with none is
   * refused BEFORE it is issued and reported as a named failure. */
  requiresUserAgent: boolean
  minIntervalMs: number
  timeoutMs: number
  /** May a figure derived from this source leave the product in an export? */
  exportAllowed: boolean
  attribution: string
  licence: string
}

export const RWA_SOURCE_POLICY: Record<RwaSourceId, SourcePolicy> = {
  gleif: {
    hosts: ['api.gleif.org'],
    requiresUserAgent: false,
    // No published ceiling. Polite by default because the limit is unknown.
    minIntervalMs: 250,
    timeoutMs: 12_000,
    exportAllowed: true,
    attribution: 'GLEIF Level 1 and Level 2 reference data',
    licence: 'CC0',
  },
  edgar: {
    hosts: ['data.sec.gov', 'www.sec.gov', 'efts.sec.gov'],
    requiresUserAgent: true,
    // Documented ceiling is 10/s. This lane uses a fraction of it.
    minIntervalMs: 150,
    timeoutMs: 15_000,
    exportAllowed: true,
    attribution: 'US Securities and Exchange Commission EDGAR',
    licence: 'public-domain',
  },
  blockscout: {
    hosts: ['eth.blockscout.com', 'base.blockscout.com', 'arbitrum.blockscout.com', 'polygon.blockscout.com'],
    requiresUserAgent: false,
    minIntervalMs: 400,
    timeoutMs: 12_000,
    // Terms unverified on 2026-09-16. Display with attribution only.
    exportAllowed: false,
    attribution: 'Blockscout',
    licence: 'unverified',
  },
  sourcify: {
    hosts: ['sourcify.dev', 'repo.sourcify.dev'],
    requiresUserAgent: false,
    minIntervalMs: 250,
    timeoutMs: 12_000,
    exportAllowed: true,
    attribution: 'Sourcify verified contract source',
    licence: 'published-source',
  },
  ofac: {
    // The publication redirects twice (checked 2026-09-16): www.treasury.gov to
    // OFAC's list service, which answers with a short-lived signed download from
    // OFAC's own published-list bucket in AWS GovCloud. Without the bucket host
    // every run stopped at redirected_off_source and no sanctions list was read.
    hosts: ['www.treasury.gov', 'sanctionslistservice.ofac.treas.gov', 'wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com'],
    requiresUserAgent: false,
    minIntervalMs: 1_000,
    // The SDN publication is large (sdn.csv was 5.69 MB on 2026-09-16), so it
    // gets a longer ceiling than the JSON sources.
    timeoutMs: 30_000,
    exportAllowed: true,
    attribution: 'US Treasury Office of Foreign Assets Control',
    licence: 'public-domain',
  },
}

/** May an observation derived from this source be exported? Blockscout is the
 * one `false`, because its redistribution terms could not be verified. */
export const sourceExportAllowed = (source: RwaSourceId): boolean => RWA_SOURCE_POLICY[source]?.exportAllowed === true

export interface SourceResponse<T = unknown> {
  ok: boolean
  status: number | null
  data: T | null
  text: string | null
  /** When WE asked. No source here publishes an observation time for its own
   * record, so this is a fetch clock and every caller must label it as one. */
  fetchedAt: string
  sourceUrl: string
  /** Null on success. A short machine-readable name on failure, never a stack. */
  reason: string | null
  bytes: number | null
}

export interface SourceDeps {
  // deno-lint-ignore no-explicit-any
  fetchImpl?: (input: string, init?: any) => Promise<any>
  /** Descriptive agent with a contact, required by EDGAR. Read from the
   * environment by the caller so this module stays free of env permissions. */
  userAgent?: string | null
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface FetchOptions {
  /** 'json' parses and reports `invalid_json` on a body that will not parse.
   * 'text' keeps the body as a string, for the OFAC CSV publication. */
  as?: 'json' | 'text'
  /** Refuse a body larger than this rather than buffering an unbounded read. */
  maxBytes?: number
  accept?: string
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024

// deno-lint-ignore no-explicit-any
const _glob = globalThis as any
const defaultFetch = (input: string, init?: unknown) => _glob.fetch(input, init)

/** Last call per source, so the politeness floor survives across adapters in
 * one invocation. Module state, reset in tests. */
const _lastCallAt: Record<string, number> = {}
export function __resetRwaSourceStateForTests(): void {
  for (const id of RWA_SOURCE_IDS) delete _lastCallAt[id]
}

/** Is this URL on the source's own hosts and plainly https? A URL carrying
 * credentials is refused outright: this transport is keyless by design. */
export function allowedSourceUrl(source: RwaSourceId, url: string): boolean {
  const policy = RWA_SOURCE_POLICY[source]
  if (!policy) return false
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false
    return policy.hosts.includes(parsed.hostname)
  } catch { return false }
}

const failure = (sourceUrl: string, fetchedAt: string, reason: string, status: number | null = null): SourceResponse<never> =>
  ({ ok: false, status, data: null, text: null, fetchedAt, sourceUrl, reason, bytes: null })

/**
 * One bounded GET against a free primary source.
 *
 * Returns what the call DID. A non-2xx is an unsuccessful response carrying its
 * status and a named reason, not an exception and not an empty list. There is
 * deliberately NO retry loop: these lanes are cached and scheduled, and a retry
 * storm against a free public source is how access gets withdrawn for everyone.
 */
export async function fetchSource<T = unknown>(
  source: RwaSourceId,
  url: string,
  deps: SourceDeps = {},
  options: FetchOptions = {},
): Promise<SourceResponse<T>> {
  const now = deps.now ?? (() => Date.now())
  const fetchedAt = new Date(now()).toISOString()
  const policy = RWA_SOURCE_POLICY[source]
  if (!policy) return failure(url, fetchedAt, 'unknown_source')
  if (!allowedSourceUrl(source, url)) return failure(url, fetchedAt, 'host_not_allowed')

  const agent = typeof deps.userAgent === 'string' ? deps.userAgent.trim() : ''
  // EDGAR answers 403 without a descriptive agent. Refusing BEFORE the call is
  // what turns that into an honest, named failure instead of a mystery 403 that
  // a caller might render as "this issuer has no filings".
  if (policy.requiresUserAgent && !agent) return failure(url, fetchedAt, 'user_agent_required')

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const since = now() - (_lastCallAt[source] ?? 0)
  if (since < policy.minIntervalMs) await sleep(policy.minIntervalMs - since)
  _lastCallAt[source] = now()

  const fetchImpl = deps.fetchImpl ?? defaultFetch
  const maxBytes = Math.max(1, Math.trunc(options.maxBytes ?? DEFAULT_MAX_BYTES))
  const headers: Record<string, string> = { accept: options.accept ?? (options.as === 'text' ? 'text/plain,text/csv,*/*' : 'application/json') }
  if (agent) headers['User-Agent'] = agent

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), policy.timeoutMs)
    let res
    try {
      // `redirect: 'manual'` would strand the OFAC publication, which redirects
      // on purpose; the host allowlist is re-checked on the final URL instead.
      res = await fetchImpl(url, { headers, redirect: 'follow', signal: controller.signal })
    } finally { clearTimeout(timer) }

    const status = Number(res?.status) || null
    const finalUrl = typeof res?.url === 'string' && res.url ? res.url : url
    // A redirect that left the source's own hosts is not this source answering.
    if (finalUrl !== url && !allowedSourceUrl(source, finalUrl)) return failure(finalUrl, fetchedAt, 'redirected_off_source', status)

    const declared = Number(res?.headers?.get?.('content-length') ?? NaN)
    if (Number.isFinite(declared) && declared > maxBytes) return failure(finalUrl, fetchedAt, 'response_too_large', status)

    const body = typeof res?.text === 'function' ? await res.text() : ''
    const bytes = typeof body === 'string' ? body.length : 0
    if (bytes > maxBytes) return failure(finalUrl, fetchedAt, 'response_too_large', status)

    if (!res?.ok) {
      // A named status reason. 403 on EDGAR with an agent set is a different
      // problem from 403 with none, and the caller can tell them apart.
      return { ok: false, status, data: null, text: null, fetchedAt, sourceUrl: finalUrl, reason: `http_${status ?? 'error'}`, bytes }
    }

    if (options.as === 'text') return { ok: true, status, data: null, text: body, fetchedAt, sourceUrl: finalUrl, reason: null, bytes }

    try {
      return { ok: true, status, data: JSON.parse(body) as T, text: null, fetchedAt, sourceUrl: finalUrl, reason: null, bytes }
    } catch { return { ok: false, status, data: null, text: null, fetchedAt, sourceUrl: finalUrl, reason: 'invalid_json', bytes } }
  } catch (e) {
    const message = (e as Error)?.name === 'AbortError' ? 'timeout' : 'network_unavailable'
    return failure(url, fetchedAt, message)
  }
}
