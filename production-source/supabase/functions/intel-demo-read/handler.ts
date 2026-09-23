// Investor Intel public demo: the read endpoint for a visitor's own search.
//
// verify_jwt IS FALSE FOR THIS FUNCTION, on purpose (supabase/config.toml,
// [functions.intel-demo-read]). The /intel/demo walk-through has no account, so
// it calls this endpoint with the anon key only. The handler never reads the
// Authorization header, never resolves a user or an org, never calls a provider
// or AI, and never writes a row anyone owns. It owns its own protection instead:
//
//   1. A per-IP request limit (60 a minute) and an hourly allowance (1,200).
//   2. A bounded body (4 KB) and a request REBUILT from its allowed fields
//      (_shared/intel/demo-read.ts parseDemoRead): an unknown field, an unknown
//      read or a bad value is refused before anything is read.
//   3. The tracked-asset allowlist, enforced HERE on the server
//      (public.intel_demo_tracked_assets): an asset no capture lane observed in
//      the last seven days is refused with 403 'demo_untracked', whatever the
//      browser sent.
//   4. Stored and cache-only readers only (_shared/intel/demo-market-read.ts),
//      and for read 'view' the capture tables through the same envelope
//      intel-capture uses (_shared/intel/demo-capture-views.ts lists the views).
//
// Kept free of the Supabase client so its tests run without it; ./index.ts wires
// the production readers.

import { answerDemoRead, DEMO_READ_HOURLY, DEMO_READ_RATE, DemoReadRefusal, parseDemoRead, type DemoReadDeps } from '../_shared/intel/demo-read.ts'
import { phaseTimer, TIMING_HEADERS, type PhaseTimer } from '../_shared/intel/server-timing.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

type Limiter = (key: string, limit: number, windowSeconds: number) => Promise<{ ok: boolean; retryAfter: number }>

export interface HandlerDeps {
  reads: DemoReadDeps
  limit: Limiter
  ipKey: (req: Request, bucket: string) => Promise<string>
  secrets: () => (string | null | undefined)[]
  /** The phase timer for one request (tests pass their own clock). */
  timer?: () => PhaseTimer
}

export const MAX_BODY_BYTES = 4096

function scrub(text: string, secrets: (string | null | undefined)[]): string {
  let out = text
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join('[redacted]')
  return out
}

function send(body: unknown, status: number, secrets: (string | null | undefined)[], extra: Record<string, string> = {}) {
  return new Response(scrub(JSON.stringify(body), secrets), { status, headers: { ...cors, ...TIMING_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra } })
}

async function readJson(req: Request): Promise<unknown> {
  const length = Number(req.headers.get('content-length') || 0)
  if (length > MAX_BODY_BYTES) throw new DemoReadRefusal('request_too_large', 413)
  const raw = await req.text()
  if (raw.length > MAX_BODY_BYTES) throw new DemoReadRefusal('request_too_large', 413)
  try { return JSON.parse(raw || '{}') } catch { throw new DemoReadRefusal('invalid_json') }
}

export async function handleDemoRead(req: Request, deps: HandlerDeps): Promise<Response> {
  const secrets = deps.secrets()
  // Where this request's time went, as a Server-Timing header (fixed phase names).
  const timer = deps.timer ? deps.timer() : phaseTimer()
  if (req.method === 'OPTIONS') return new Response('ok', { headers: { ...cors, 'Access-Control-Max-Age': '600' } })
  if (req.method !== 'POST') return send({ error: 'method_not_allowed' }, 405, secrets, { Allow: 'POST, OPTIONS' })

  // The limits first, so malformed floods are counted too.
  let key: string | null = null
  try { key = await deps.ipKey(req, 'demo-read') } catch { key = null }
  if (key) {
    // Both windows are counted at once: two round trips one after the other were
    // a fixed cost on every read of an asset page that opens with a dozen.
    const buckets = [['', DEMO_READ_RATE], [':hour', DEMO_READ_HOURLY]] as const
    const gates = await timer.time('limit', () => Promise.all(buckets.map(([bucket, rate]) => deps.limit(`${key}${bucket}`, rate.limit, rate.windowSeconds))))
    for (let i = 0; i < buckets.length; i++) {
      const gate = gates[i], rate = buckets[i][1]
      if (!gate.ok) {
        const retryAfter = Math.max(1, gate.retryAfter || rate.windowSeconds)
        return send({ error: 'rate_limited', reason: 'rate_limited', retryAfter }, 429, secrets, { 'Retry-After': String(retryAfter) })
      }
    }
  }

  let read
  try { read = parseDemoRead(await readJson(req)) } catch (e) {
    if (e instanceof DemoReadRefusal) return send({ error: e.code, code: e.code, reason: e.code }, e.status, secrets)
    return send({ error: 'invalid_request', reason: 'invalid_request' }, 400, secrets)
  }
  try {
    const answer = await timer.time('read', () => answerDemoRead(read, deps.reads))
    return send(answer.body, answer.status, secrets, { 'Server-Timing': timer.header() })
  } catch (e) {
    if (e instanceof DemoReadRefusal) return send({ error: e.code, code: e.code, reason: e.code }, e.status, secrets)
    console.error('intel_demo_read_failed', { read: read.read, message: scrub(String((e as Error)?.message || e), secrets).slice(0, 200) })
    return send({ error: 'demo_read_unavailable', reason: 'demo_read_unavailable' }, 503, secrets)
  }
}
