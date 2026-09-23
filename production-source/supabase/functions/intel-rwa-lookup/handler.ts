// Investor Intel: public "Look up any tokenised asset, now".
//
// verify_jwt IS FALSE FOR THIS FUNCTION, on purpose (supabase/config.toml,
// [functions.intel-rwa-lookup]). It is an anonymous, read-only endpoint: the
// /intel/demo walk-through calls it with the anon key only, and so does the
// signed-in /intel/rwa page, so that a member and a visitor get the identical
// shared answer. The handler never reads the Authorization header, never
// resolves a user or an org, and never writes anything a caller owns. It owns
// its own protection instead:
//
//   1. Input validation (parseLookupQuery): one short ticker, name or rwa_id,
//      in a character set that cannot become a wildcard or a filter.
//   2. A per-IP request limit (30 a minute), and a separate per-IP hourly
//      allowance (20, counted only at a cache miss) for the only path that can reach the provider: a
//      shared-cache miss inside the daily free RWA budget.
//   3. The free RWA lane itself (_shared/intel/rwa-free-read.ts): cache first,
//      never a demand stamp, a live call only when intel_free_rwa_read_claim
//      grants it from cmc_free_rwa_policy.
//
// The same endpoint answers the six real-world asset research reads of the
// /intel/rwa workspace (rwaList, rwaInfo, rwaQuotes, rwaPairs, issuers, issuer)
// exactly as intel-research answers a FREE member: same validation, same free
// lane, same daily budget, same body. That is what lets the public demo page
// through a snapshot miss on that workspace without an account.
//
// See _shared/intel/rwa-lookup.ts for the answers and their receipts.

import { answerLookup, LOOKUP_LIVE_RATE, LOOKUP_RATE, parseLookupQuery, parseResearchRequest, researchRwa, ResearchRequestError, scrubSecrets, type AnswerStore, type LookupDeps, type ResearchDeps } from '../_shared/intel/rwa-lookup.ts'
import { phaseTimer, TIMING_HEADERS, type PhaseTimer } from '../_shared/intel/server-timing.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

// deno-lint-ignore no-explicit-any
type Limiter = (key: string, limit: number, windowSeconds: number, opts?: { failClosed?: boolean }) => Promise<{ ok: boolean; retryAfter: number }>

export interface HandlerDeps extends LookupDeps, ResearchDeps {
  /** The kept finished answers (answerLookup). Absent: every lookup is assembled. */
  answers?: AnswerStore | null
  /** The phase timer for one request (tests pass their own clock). */
  timer?: () => PhaseTimer
  limit: Limiter
  ipKey: (req: Request, bucket: string) => Promise<string>
  secrets: () => (string | null | undefined)[]
}

function send(body: unknown, status: number, secrets: (string | null | undefined)[], extra: Record<string, string> = {}) {
  const text = scrubSecrets(JSON.stringify(body), secrets)
  return new Response(text, { status, headers: { ...cors, ...TIMING_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra } })
}

/** The request, as { q } (a lookup) or { capability, params, readMode } (a
 * research read). GET carries only ?q=. */
async function readRequest(req: Request): Promise<Record<string, unknown>> {
  if (req.method === 'GET') return { q: new URL(req.url).searchParams.get('q') }
  const length = Number(req.headers.get('content-length') || 0)
  if (length > 4096) throw new Error('request_too_large')
  const raw = await req.text()
  if (raw.length > 4096) throw new Error('request_too_large')
  let body: unknown
  try { body = JSON.parse(raw || '{}') } catch { throw new Error('invalid_json') }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid_json')
  return body as Record<string, unknown>
}

export async function handleLookup(req: Request, deps: HandlerDeps): Promise<Response> {
  const secrets = deps.secrets()
  // Where this request's time went, as a Server-Timing header (phase names are
  // fixed words; no query, figure or identity is ever put in one).
  const timer = deps.timer ? deps.timer() : phaseTimer()
  if (req.method === 'OPTIONS') return new Response('ok', { headers: { ...cors, 'Access-Control-Max-Age': '600' } })
  if (req.method !== 'GET' && req.method !== 'POST') return send({ error: 'method_not_allowed' }, 405, secrets, { Allow: 'GET, POST, OPTIONS' })

  // The request limit first, so malformed floods are counted too.
  let key: string | null = null
  try { key = await deps.ipKey(req, 'rwa-lookup') } catch { key = null }
  if (key) {
    const gate = await timer.time('limit', () => deps.limit(key!, LOOKUP_RATE.limit, LOOKUP_RATE.windowSeconds))
    if (!gate.ok) return send({ error: 'rate_limited', reason: 'rate_limited', retryAfter: gate.retryAfter }, 429, secrets, { 'Retry-After': String(Math.max(1, gate.retryAfter || 60)), 'Cache-Control': 'no-store' })
  }

  let body: Record<string, unknown>
  try { body = await readRequest(req) } catch (e) {
    const code = (e as Error).message
    return send({ error: code, reason: code }, code === 'request_too_large' ? 413 : 400, secrets, { 'Cache-Control': 'no-store' })
  }
  // Two shapes, never mixed. Anything else in the body (an orgId, a token) is
  // refused rather than ignored, so nobody can believe it changed the answer.
  const research = 'capability' in body
  let q: ReturnType<typeof parseLookupQuery> | null = null
  let rr: ReturnType<typeof parseResearchRequest> | null = null
  if (research) {
    try { rr = parseResearchRequest(body, deps.researchParams) } catch (e) {
      const code = e instanceof ResearchRequestError ? e.message : 'invalid_request'
      return send({ error: code, reason: code }, 400, secrets, { 'Cache-Control': 'no-store' })
    }
  } else {
    if (Object.keys(body).some((k) => k !== 'q')) return send({ error: 'invalid_query', reason: 'invalid_query' }, 400, secrets, { 'Cache-Control': 'no-store' })
    try { q = parseLookupQuery(body.q) } catch { return send({ error: 'invalid_query', reason: 'invalid_query', hint: "One ticker, name or rwa_id: letters, digits, spaces and . & ' ( ) -, up to 60 characters." }, 400, secrets, { 'Cache-Control': 'no-store' }) }
  }

  // The live allowance is asked only at the moment a live read would be made:
  // after a shared-cache miss, before the daily budget claim. So cache hits
  // never use it up. It fails CLOSED: a limiter we cannot read (or no salt to
  // key it with) never becomes an unlimited one; the caller still gets the
  // cached or kept answer with the reason.
  const liveGate = async () => {
    if (!key) return false
    try { return (await deps.limit(`${key}:live`, LOOKUP_LIVE_RATE.limit, LOOKUP_LIVE_RATE.windowSeconds, { failClosed: true })).ok } catch { return false }
  }
  try {
    const body = rr ? await timer.time('research', () => researchRwa(deps, rr!, liveGate)) : await answerLookup(deps, q!, liveGate, timer)
    return send(body, 200, secrets, { 'Server-Timing': timer.header() })
  } catch {
    return send(rr ? { error: 'research_unavailable' } : { error: 'lookup_unavailable', reason: 'lookup_unavailable' }, 503, secrets, { 'Cache-Control': 'no-store' })
  }
}

