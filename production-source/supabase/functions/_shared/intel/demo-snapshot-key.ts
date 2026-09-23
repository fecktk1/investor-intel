// Investor Intel public demo: the ONE rule that turns a request into a snapshot
// key.
//
// The demo serves the real Investor Intel pages from a daily snapshot built on
// the server (supabase/functions/intel-demo-snapshot). The browser and the
// builder must agree, byte for byte, on which stored body answers which request,
// so both import this file: Vite compiles it into the app, Deno runs it in the
// builder. It is pure (no Deno, no DOM, no crypto API) for exactly that reason.
//
// A key is the function name plus the canonical JSON of the request body:
//   * orgId / org_id are removed at the top level (the demo has no workspace,
//     and the builder has no org to put there);
//   * object keys are sorted at every depth, so parameter order never matters;
//   * undefined values are dropped (JSON.stringify drops them on the wire too),
//     and so are functions and symbols; array order is kept;
//   * a string that is a plain decimal number ('25', '1017') is read as that
//     number, because the pages send the same id as a URL string in one place
//     and as a number in another and every reader coerces it the same way.
// The canonical string is hashed into a short file-safe name, because a body can
// be longer than a storage object name may be.

export const DEMO_SNAPSHOT_KEY_VERSION = 1

const ORG_FIELDS = new Set(['orgId', 'org_id'])
// No leading zeros, no exponent, at most 15 significant digits: exactly the
// strings that survive a Number round trip unchanged.
const PLAIN_NUMBER = /^-?(?:0|[1-9][0-9]{0,14})(?:\.[0-9]{1,6})?$/

function canonicalValue(value: unknown, depth: number): unknown {
  if (value === null) return null
  if (depth > 32) return null
  if (Array.isArray(value)) {
    return value.map((item) => {
      const next = canonicalValue(item, depth + 1)
      // JSON.stringify writes an unrepresentable array member as null.
      return next === undefined ? null : next
    })
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (depth === 0 && ORG_FIELDS.has(key)) continue
      const next = canonicalValue((value as Record<string, unknown>)[key], depth + 1)
      if (next !== undefined) out[key] = next
    }
    return out
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') return PLAIN_NUMBER.test(value) ? Number(value) : value
  if (typeof value === 'boolean') return value
  // undefined, functions, symbols and bigints are not part of a JSON body.
  return undefined
}

/** The canonical JSON body for a request, org fields removed. */
export function canonicalRequestBody(body: unknown): string {
  let parsed: unknown = body
  if (typeof body === 'string') {
    try { parsed = body.trim() ? JSON.parse(body) : {} } catch { parsed = { __raw: body } }
  }
  if (parsed == null) parsed = {}
  const value = canonicalValue(parsed, 0)
  return JSON.stringify(value === undefined ? {} : value)
}

/** A file-safe function name. */
export function demoFunctionSlug(fn: string): string {
  return String(fn || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'request'
}

// Two independent 32-bit FNV-1a style hashes over the UTF-16 code units, joined
// into a 64-bit hex digest. Deterministic in every JavaScript runtime.
function hash64(text: string): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a ^= c; a = Math.imul(a, 0x01000193) >>> 0
    b ^= c + i; b = Math.imul(b ^ (b >>> 15), 0x2c1b3c6d) >>> 0
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0')
}

/** The canonical string a key is derived from. Exported for tests and logs. */
export function demoSnapshotCanonical(fn: string, body: unknown): string {
  return `${demoFunctionSlug(fn)}\n${canonicalRequestBody(body)}`
}

/** The snapshot key for one request: `<function>.<16 hex>`. */
export function demoSnapshotKey(fn: string, body: unknown): string {
  return `${demoFunctionSlug(fn)}.${hash64(demoSnapshotCanonical(fn, body))}`
}

/** Storage layout inside the public `intel-demo` bucket. */
export const DEMO_BUCKET = 'intel-demo'
export const DEMO_LATEST_PATH = 'latest.json'
export const demoEntryPath = (date: string, key: string): string => `snapshots/${date}/${key}.json`
export const DEMO_KEY_PATTERN = /^[a-z0-9_-]{1,80}\.[0-9a-f]{16}$/
export const DEMO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

// ─── REST table reads and shared RPCs ────────────────────────────────────────
//
// Some pages read a SHARED table straight through PostgREST (the curated news
// list, the macro calendar, a narrative's members). The snapshot replays those
// GETs on the server with the service role and the demo answers the same URL
// from the stored rows. Only the tables below may be replayed: shared market,
// news, narrative and macro data with no member rows in them. Every other table,
// and above all anything that holds a person's or a workspace's data, is
// refused on both sides, and so is any read that filters on an owner column,
// embeds another table, or names a personal column.

/** Shared tables a REST GET may be replayed from. `star` allows select=*. */
export const DEMO_REST_TABLES: Readonly<Record<string, { star?: boolean }>> = Object.freeze({
  intel_curated_news: {},
  intel_global_news: {},
  intel_macro_calendar: { star: true },
  intel_macro_indicators: { star: true },
  intel_recently_discovered: {},
  market_macro_available: {},
  narrative_taxonomy: {},
  narrative_signals: {},
  narrative_assets: {},
})

/** Shared, argument-only RPCs (no member, no workspace) the snapshot answers. */
export const DEMO_SHARED_RPCS: ReadonlySet<string> = new Set(['intel_current_regime', 'intel_macro_news'])

// A table named like member data is refused even if someone adds it above.
const PERSONAL_TABLE = /(^|_)(watchlists?|portfolios?|holdings?|thes[ie]s|alerts?|briefs?|research|trades?|wallets?|telegram|agents?|notes?|support|tickets?|profiles?|members?|memberships?|users?|preferences?|journals?|orgs?|workspaces?|subscriptions?|sessions?|tracked|followed|interactions?|feedback)(_|$)/
const OWNER_COLUMN = /^(user_id|org_id|owner_id|created_by|member_id|profile_id|workspace_id|telegram_chat_id|demand_user_id|demand_org_id)$/
const PERSONAL_COLUMN = /(^|_)(email|phone|full_name|avatar)/i
const OWNER_REFERENCE = /(^|[^a-z0-9_])(user_id|org_id|owner_id|created_by|member_id|profile_id|workspace_id)\./
const PERSONAL_REFERENCE = /(^|[^a-z0-9_])[a-z0-9_]*(email|phone|full_name|avatar)[a-z0-9_]*\./i

function queryPairs(query: string): [string, string][] {
  const text = String(query || '').replace(/^\?/, '')
  const pairs: [string, string][] = []
  for (const [key, value] of new URLSearchParams(text)) pairs.push([key, value])
  return pairs
}

/** Why a REST replay of this table and query is refused, or null when it is allowed. */
export function demoRestRefusal(table: string, query: string): string | null {
  const name = String(table || '')
  if (!/^[a-z0-9_]{1,63}$/.test(name)) return 'invalid_table'
  if (PERSONAL_TABLE.test(name)) return 'personal_table'
  if (!Object.hasOwn(DEMO_REST_TABLES, name)) return 'table_not_allowlisted'
  for (const [key, value] of queryPairs(query)) {
    if (key === 'select') {
      if (/[()!:]/.test(value)) return 'embedded_resource'
      const columns = value.split(',').map((c) => c.trim()).filter(Boolean)
      if (!columns.length) return 'empty_select'
      for (const c of columns) {
        if (c === '*') { if (!DEMO_REST_TABLES[name].star) return 'select_star'; continue }
        if (!/^[a-z0-9_]+$/.test(c)) return 'invalid_column'
        if (OWNER_COLUMN.test(c) || PERSONAL_COLUMN.test(c)) return 'owner_or_personal_column'
      }
      continue
    }
    const column = key.split(/[.-]/)[0]
    if (OWNER_COLUMN.test(column) || PERSONAL_COLUMN.test(column)) return 'owner_or_personal_filter'
    // A logical filter (or=, and=) that names an owner or personal column.
    if (/^(not\.)?(or|and)$/.test(key) && (OWNER_REFERENCE.test(value) || PERSONAL_REFERENCE.test(value))) return 'owner_or_personal_filter'
  }
  return null
}

// An ISO timestamp inside a filter value. Pages build their windows from the
// reader's clock (published in the last 7 days, scheduled in the next 21), so a
// timestamp is keyed by its whole-hour offset from the clock that sent it:
// "gte.2026-09-15T21:02:22.211Z" sent at 2026-09-22T21:02:22Z is "gte.@-168h".
// The builder stores the same token and turns it back into a time when it
// replays the read, so the window is the same window, measured from the build.
const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})/g
const TIME_TOKEN = /@(-?\d{1,6})h(?![0-9a-z])/g
const HOUR_MS = 3_600_000

/** Replace every ISO timestamp in a value with its hour offset from `now`. */
export function relativeTimeValue(value: string, now: number): string {
  return String(value).replace(ISO_TIME, (match) => {
    const at = Date.parse(match)
    return Number.isFinite(at) ? `@${Math.round((at - now) / HOUR_MS)}h` : match
  })
}

/** Turn hour tokens back into ISO timestamps measured from `now`. */
export function materializeRestQuery(query: string, now: number): string {
  const out = new URLSearchParams()
  for (const [key, value] of queryPairs(query)) {
    out.append(key, value.replace(TIME_TOKEN, (_m, hours) => new Date(now + Number(hours) * HOUR_MS).toISOString()))
  }
  return out.toString()
}

/** Canonical form of a PostgREST query: decoded pairs, times relative to `now`
 * when it is given, sorted, so parameter order never changes the key. */
export function canonicalRestQuery(query: string, now?: number): string {
  return queryPairs(query)
    .map(([key, value]) => `${key}=${now == null ? value : relativeTimeValue(value, now)}`)
    .sort()
    .join('\n')
}

/** The snapshot key for a REST GET of a shared table: `rest-<table>.<16 hex>`. */
export function demoRestKey(table: string, query: string, now?: number): string {
  return `${demoFunctionSlug(`rest-${table}`)}.${hash64(`GET /rest/v1/${table}\n${canonicalRestQuery(query, now)}`)}`
}

/** The snapshot key for a shared RPC: `rpc-<name>.<16 hex>` over its arguments. */
export function demoRpcKey(name: string, args: unknown): string {
  return demoSnapshotKey(`rpc-${name}`, args ?? {})
}

/** The key of any planned request: a function body, a REST GET or an RPC. */
export function demoRequestKey(request: { fn: string; body: Record<string, unknown> }): string {
  if (request.fn === 'rest') return demoRestKey(String(request.body?.table || ''), String(request.body?.query || ''))
  if (request.fn === 'rpc') return demoRpcKey(String(request.body?.name || ''), request.body?.args ?? {})
  return demoSnapshotKey(request.fn, request.body)
}
