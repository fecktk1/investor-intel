// Investor Intel public demo: the network answer for every backend request.
//
// In the demo, both Supabase data clients and window.fetch route every request
// for the backend host here, and NOTHING here forwards a request to it. Each
// request is answered from one of three places:
//
//   1. the daily snapshot (./demo-snapshot.js), for Edge Function calls whose
//      key (supabase/functions/_shared/intel/demo-snapshot-key.ts) it holds;
//   2. the synthetic visitor (./demo-identity.js), for the auth, profile,
//      membership and access reads every signed-in page makes on boot;
//   3. the in-memory store (./demo-store.js), for every table the visitor can
//      write to: it starts empty and is gone on reload.
//
// Two more snapshot answers carry SHARED data only: a GET of one of the shared
// tables in DEMO_REST_TABLES (the builder replayed the same query on the
// server), and a shared argument-only RPC in DEMO_SHARED_RPCS. A personal table
// is never among them; it is always the in-memory store.
//
// Anything else is "not in today's demo snapshot": a JSON error with code
// 'demo_not_in_snapshot' that the pages already render as a reason.
//
// The only network traffic the demo makes to the backend host is the
// snapshot reader's credential-free GETs of public objects in the intel-demo
// bucket, and those go through the ORIGINAL fetch the reader was given.

import {
  DEMO_REST_TABLES, DEMO_SHARED_RPCS, demoRestKey, demoRestRefusal, demoRpcKey, demoSnapshotKey,
} from '../../../supabase/functions/_shared/intel/demo-snapshot-key.ts'
import { EntityResolveRefusal, normalizeEntity } from '../../../supabase/functions/_shared/entity-resolver.ts'
import {
  DEMO_ORG, DEMO_ORG_ID, DEMO_PROFILE, DEMO_TIER, DEMO_USER, DEMO_USER_ID, demoMembershipRow,
} from './demo-identity.js'

export const DEMO_MISS_CODE = 'demo_not_in_snapshot'
export const DEMO_MISS_TEXT = "Not in today's demo snapshot. Create a free account to look it up."

/** The Investor Intel surfaces (intel_surface_tiers). Starter reaches all of them. */
export const DEMO_SURFACES = {
  market_boards: 'free', market_regime: 'free', capture_views: 'free', chart_workstation: 'free',
  narratives_read: 'free', watchlist: 'free', rwa_research: 'free',
  research_on_demand: 'starter', investigation: 'starter', portfolio_valuation: 'starter', ai_generation: 'starter',
  market_history: 'starter', alert_evaluation: 'starter', agent_access: 'starter', wallet_watch: 'starter',
  thesis_journal: 'starter', comment_king: 'starter',
}

export function demoAccountAccess() {
  const surfaces = {}
  for (const [surface, minTier] of Object.entries(DEMO_SURFACES)) {
    surfaces[surface] = { allowed: true, minTier, costBasis: minTier === 'free' ? 'precomputed_shared' : 'per_member_on_demand' }
  }
  return { tier: DEMO_TIER, rank: 1, surfaces }
}

// RPCs answered by the synthetic visitor.
const IDENTITY_RPCS = {
  get_my_org_id: () => DEMO_ORG_ID,
  sparq_my_holder_workspaces: () => [],
  intel_account_access: () => demoAccountAccess(),
  get_help_context: () => null,
  claim_pending_orgs_for_current_user: () => null,
  intel_usage_summary: () => null,
}

// Personal reads that must start EMPTY rather than fail: the visitor has no
// book, no theses, no briefs and no history yet.
const EMPTY_LIST_RPCS = new Set([
  // Signals ranked for the member's own watchlist and follows: nothing yet.
  'signal_feed_v2',
  'intel_list_briefs', 'intel_list_asset_theses', 'intel_portfolio_page', 'intel_portfolio_activity_page',
  'intel_portfolio_activity_legs', 'intel_desk_positions', 'intel_portfolio_thesis_conflicts', 'what_changed',
  'intel_asset_thesis_activity', 'intel_book_calendar', 'portfolio_exposure', 'intel_thesis_performance_ledger',
])
const EMPTY_VALUE_RPCS = new Set([
  'intel_asset_portfolio_holding', 'intel_asset_portfolio_context', 'intel_portfolio_overview', 'intel_what_changed_context',
  'intel_thesis_snapshot_context', 'intel_thesis_analytics', 'intel_thesis_analytics_scoped', 'intel_trade_analytics',
  'intel_trade_analytics_scoped',
])
// A write the page expects to succeed. In the demo it succeeds in memory only.
const WRITE_RPC = /(^|_)(save|append|create|record|mark|set|clear|follow|unfollow|pin|reorder|close|reclassify|complete|approve|reject|revoke|grant|claim|log|delete|update|insert|upsert|add|remove|seen)(_|$)/

// Tables answered by the synthetic visitor rather than the store.
function identityRows(table) {
  switch (table) {
    case 'profiles': return [{ ...DEMO_PROFILE }]
    case 'org_members': return [demoMembershipRow()]
    case 'orgs': return [{ ...DEMO_ORG }]
    default: return null
  }
}

const jsonHeaders = (extra = {}) => ({ 'Content-Type': 'application/json', ...extra })

function respond(body, status = 200, headers = {}) {
  const text = body === undefined ? '' : JSON.stringify(body)
  return new Response(status === 204 || status === 205 ? null : text, { status, headers: jsonHeaders(headers) })
}

function readUrl(input) {
  if (typeof input === 'string') return input
  if (input && typeof input.url === 'string') return input.url
  return String(input || '')
}

async function readBody(input, init) {
  const raw = init?.body ?? null
  if (raw == null && input && typeof input.clone === 'function' && typeof input.text === 'function') {
    try { return await input.clone().text() } catch { return '' }
  }
  if (typeof raw === 'string') return raw
  if (raw instanceof URLSearchParams) return raw.toString()
  if (raw && typeof raw.text === 'function') { try { return await raw.text() } catch { return '' } }
  return ''
}

function parseJson(text) {
  if (!text) return {}
  try { return JSON.parse(text) } catch { return {} }
}

function headerOf(input, init, name) {
  try {
    const headers = new Headers(init?.headers || (input && input.headers) || {})
    return headers.get(name) || ''
  } catch { return '' }
}

export function missBody(extra = {}) {
  // `error` carries the sentence because several pages print it as it is; the
  // helpers that link to sign-up key on `code` and `reason`.
  return { error: DEMO_MISS_TEXT, code: DEMO_MISS_CODE, reason: DEMO_MISS_CODE, message: DEMO_MISS_TEXT, state: 'unavailable', ...extra }
}

/** The research body a page renders as an unavailable read with our reason. */
export function researchMissBody(capability) {
  return {
    version: 1, capability: capability || null, state: 'unavailable', reason: DEMO_MISS_CODE,
    data: { rows: [], total: null, hasMore: false }, provenance: null, receipt: null, scope: null, sourceReference: null,
    refreshPolicy: { enabled: false, cacheReadSeconds: null, providerRefreshSeconds: null },
  }
}

const postgrestError = (status, code, message) => respond({ code, message, details: null, hint: null }, status)

// `alias:table(*)` embeds in a select, as the pages write them for the rows the
// visitor creates (a watchlist item and its entity). The foreign key is
// `<alias>_id`, which is how every such embed in the product is named.
function embedsOf(select) {
  const embeds = []
  for (const match of String(select || '').matchAll(/([a-z0-9_]+):([a-z0-9_]+)\(\*\)/g)) embeds.push({ alias: match[1], table: match[2] })
  return embeds
}

/**
 * Build the demo fetch.
 *   supabaseUrl  the backend origin every intercepted URL starts with
 *   reader       { manifest(), entry(key) } from createSnapshotReader
 *   store        createDemoStore()
 */
export function createDemoFetch({ supabaseUrl, reader, store, onMiss = null, now = () => Date.now() }) {
  const base = String(supabaseUrl || '').replace(/\/+$/, '')
  const miss = (detail) => { try { onMiss?.(detail) } catch { /* diagnostics only */ } }

  async function functions(name, input, init) {
    const text = await readBody(input, init)
    const body = parseJson(text)
    const key = demoSnapshotKey(name, body)
    let entry = null
    try { entry = reader ? await reader.entry(key) : null } catch { entry = null }
    if (entry && entry.body !== undefined) return respond(entry.body, Number(entry.status) || 200)

    // Identity-shaped function reads every signed-in page makes.
    if (name === 'help-assistant' && body?.action === 'status') return respond({ tutorials_enabled: false, assistant_enabled: false })
    if (name === 'intel-resolve') return resolveInMemory(body)
    miss({ kind: 'function', name, body })
    if (name === 'intel-research') return respond(researchMissBody(body?.capability))
    return respond(missBody())
  }

  // Workspace preferences (PersonalWorkspace.jsx) are saved through an RPC and
  // read back from their table, so the demo keeps them in that table in memory
  // and answers with the row and its next revision, as the database would.
  function saveWorkspacePreference(body) {
    const slot = String(body?.p_slot || '')
    const params = new URLSearchParams({ slot: `eq.${slot}` })
    const existing = store.select('intel_workspace_preferences', params).rows[0]
    const row = { org_id: DEMO_ORG_ID, user_id: DEMO_USER_ID, slot, value: body?.p_value ?? {}, revision: Number(existing?.revision || 0) + 1 }
    const [saved] = existing
      ? store.update('intel_workspace_preferences', row, params)
      : store.insert('intel_workspace_preferences', row, new URLSearchParams())
    return respond(saved)
  }

  // Tracking something (a watchlist item, a wallet, a holding) first names it
  // as an `entities` row. The demo names it with the same pure normalizer the
  // endpoint uses and keeps the row in memory; no provider or database is asked,
  // so what the visitor can then SEE about it is still only what the snapshot holds.
  function resolveInMemory(body) {
    let entity
    try {
      entity = normalizeEntity({
        kind: body?.kind || 'asset', chain: body?.chain, value: body?.value, assetType: body?.assetType,
        issuer: body?.issuer, currency: body?.currency, symbol: body?.symbol, displaySymbol: body?.displaySymbol,
      })
    } catch (error) {
      if (error instanceof EntityResolveRefusal) return respond({ error: error.details.code, refusal: error.details }, 400)
      return respond({ error: error?.message || 'resolve_failed' }, 400)
    }
    const params = new URLSearchParams({ canonical_ref_key: `eq.${entity.canonical_ref_key}` })
    const existing = store.select('entities', params).rows[0]
    if (existing) return respond({ entity: existing })
    const [row] = store.insert('entities', { ...entity, org_id: DEMO_ORG_ID, provider_ids: {}, provider_metadata: {} }, new URLSearchParams())
    return respond({ entity: row })
  }

  function withEmbeds(rows, select) {
    const embeds = embedsOf(select)
    if (!embeds.length) return rows
    return rows.map((row) => {
      const out = { ...row }
      for (const { alias, table } of embeds) {
        const key = row?.[`${alias}_id`]
        out[alias] = key == null ? null : store.select(table, new URLSearchParams({ id: `eq.${key}` })).rows[0] || null
      }
      return out
    })
  }

  async function snapshotEntry(key) {
    try { return reader ? await reader.entry(key) : null } catch { return null }
  }

  // A GET of an allowlisted shared table, answered from the rows the builder
  // stored for the same query. Null when the snapshot does not hold it.
  async function sharedTableRows(table, url) {
    if (!Object.hasOwn(DEMO_REST_TABLES, table) || demoRestRefusal(table, url.search)) return null
    const entry = await snapshotEntry(demoRestKey(table, url.search, now()))
    const rows = entry?.body?.rows
    if (!Array.isArray(rows)) return null
    const count = Number(entry.body.count)
    return { rows, total: Number.isFinite(count) ? count : rows.length, start: Math.max(0, Number(url.searchParams.get('offset')) || 0) }
  }

  async function rpc(name, body) {
    if (Object.hasOwn(IDENTITY_RPCS, name)) return respond(IDENTITY_RPCS[name](body))
    if (DEMO_SHARED_RPCS.has(name)) {
      const entry = await snapshotEntry(demoRpcKey(name, body))
      if (entry && entry.body !== undefined) return respond(entry.body, Number(entry.status) || 200)
    }
    if (name === 'intel_save_workspace_preferences') return saveWorkspacePreference(body)
    if (EMPTY_LIST_RPCS.has(name)) return respond([])
    if (EMPTY_VALUE_RPCS.has(name)) return respond(null)
    if (WRITE_RPC.test(name)) return respond(null)
    miss({ kind: 'rpc', name, body })
    return postgrestError(404, DEMO_MISS_CODE, DEMO_MISS_TEXT)
  }

  async function rest(table, method, url, input, init) {
    const wantsObject = /application\/vnd\.pgrst\.object\+json/.test(headerOf(input, init, 'Accept'))
    const prefer = headerOf(input, init, 'Prefer')
    const representation = /return=representation/.test(prefer)
    const counted = /count=(exact|planned|estimated)/.test(prefer)
    const shape = (rows, { total = rows.length, start = 0 } = {}) => {
      const range = rows.length ? `${start}-${start + rows.length - 1}/${counted ? total : '*'}` : `*/${counted ? total : '*'}`
      if (wantsObject) {
        if (rows.length === 1) return respond(rows[0], 200, { 'Content-Range': range })
        return respond({ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: `The result contains ${rows.length} rows`, hint: null }, 406)
      }
      return respond(rows, 200, { 'Content-Range': range })
    }

    if (method === 'GET' || method === 'HEAD') {
      const identity = identityRows(table)
      const shared = identity ? null : await sharedTableRows(table, url)
      const own = identity || shared ? null : store.select(table, url.searchParams)
      const result = identity ? { rows: identity, total: identity.length, start: 0 } : shared || { ...own, rows: withEmbeds(own.rows, url.searchParams.get('select')) }
      if (!identity && !result.total) miss({ kind: 'rest', table, query: url.search })
      if (method === 'HEAD') return new Response(null, { status: 200, headers: { 'Content-Range': `*/${result.total}` } })
      return shape(result.rows, result)
    }
    // Writes land in memory only. Identity tables never change.
    if (identityRows(table)) return representation ? shape(identityRows(table)) : new Response(null, { status: 204 })
    const payload = parseJson(await readBody(input, init))
    let written = []
    if (method === 'POST') written = store.insert(table, payload, url.searchParams, { upsert: /resolution=merge-duplicates/.test(prefer) })
    else if (method === 'PATCH') written = store.update(table, payload, url.searchParams)
    else if (method === 'DELETE') written = store.remove(table, url.searchParams)
    else return postgrestError(405, 'PGRST000', 'Method not allowed')
    if (representation) return shape(withEmbeds(written, url.searchParams.get('select')))
    return new Response(null, { status: method === 'POST' ? 201 : 204 })
  }

  function auth(path, method) {
    if (path === 'user' && (method === 'GET' || method === 'PUT')) return respond({ ...DEMO_USER })
    if (path === 'logout') return new Response(null, { status: 204 })
    return respond({ error: 'demo_session', error_description: DEMO_MISS_TEXT, msg: DEMO_MISS_TEXT }, 400)
  }

  return async function demoFetch(input, init = {}) {
    const href = readUrl(input)
    const method = String(init?.method || (input && input.method) || 'GET').toUpperCase()
    let url
    try { url = new URL(href, 'http://demo.invalid') } catch { return respond(missBody(), 400) }
    const path = href.startsWith(base) ? href.slice(base.length).split('?')[0] : url.pathname

    let match
    if ((match = path.match(/^\/functions\/v1\/([^/?#]+)/))) return functions(decodeURIComponent(match[1]), input, init)
    if ((match = path.match(/^\/rest\/v1\/rpc\/([^/?#]+)/))) {
      const body = method === 'GET' ? Object.fromEntries(url.searchParams) : parseJson(await readBody(input, init))
      return rpc(decodeURIComponent(match[1]), body)
    }
    if ((match = path.match(/^\/rest\/v1\/([^/?#]+)/))) return rest(decodeURIComponent(match[1]), method, url, input, init)
    if ((match = path.match(/^\/auth\/v1\/([^?#]+)/))) return auth(match[1].replace(/\/+$/, ''), method)
    if (path.startsWith('/storage/v1/')) {
      if (method === 'POST' && /\/storage\/v1\/object\/list\//.test(path)) return respond([])
      return respond({ statusCode: '404', error: DEMO_MISS_CODE, message: DEMO_MISS_TEXT }, 404)
    }
    return respond(missBody(), 404)
  }
}

export { DEMO_USER_ID }
