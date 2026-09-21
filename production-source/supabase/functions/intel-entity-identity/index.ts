// intel-entity-identity — give a tracked entity a name, a symbol and a logo.
//
// A watchlist item points at an `entities` row, and the resolver that creates
// that row only ever knew the chain and the address. Nothing filled in what the
// token is CALLED, so every contract row printed its raw mint or contract
// address and a member saw a wall of addresses.
//
// This endpoint fills that in ONCE per entity and stores the answer on the row,
// so rendering a list never contacts a provider. It reuses the universal
// resolver (_shared/intel/asset-resolver.ts), whose first rungs are our own
// catalogue and our own caches: a token the catalogue already knows costs zero
// provider calls. Only the long tail reaches the bounded on-chain / DEX rungs,
// and a token nothing can name is recorded as unresolved with a timestamp so
// the next page load does not ask again.
//
// POST { orgId, refs: string[], refresh?: boolean }
//   → { identities: { [canonical_ref_key]: Identity }, resolved, deferred }
//
// Auth: signed-in member of orgId with Investor Intel access (requireIntelAccess).

import { createClient } from 'npm:@supabase/supabase-js@2'
import { resolveAsset } from '../_shared/intel/asset-resolver.ts'
import { requireIntelAccess } from '../_shared/intel/research-service.ts'
import { OrgAuthzError } from '../_shared/org-authz.ts'
import { chainIdFor } from '../_shared/chains.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

/** One page of a watchlist is the working set; the rest of a long list is
 *  answered on the next load rather than by a longer request. */
export const MAX_REFS = 40
/** Resolutions that may reach beyond our own tables in a single request. The
 *  catalogue and cache rungs are free, so this only bounds the long tail. */
export const MAX_RESOLVES = 12
/** How long an honest "nothing could name this" is trusted before we try again. */
export const UNRESOLVED_TTL_MS = 24 * 60 * 60 * 1000

export type EntityIdentity = {
  ref: string
  symbol: string | null
  name: string | null
  imageUrl: string | null
  provider: string | null
  providerId: string | null
  chain: string | null
  address: string | null
  state: 'stored' | 'resolved' | 'unresolved' | 'deferred'
  reason?: string | null
}

type EntityRow = {
  id: string
  canonical_ref_key: string
  display_symbol: string | null
  contract_address: string | null
  chain_namespace: string | null
  chain_id: string | null
  entity_kind: string | null
  provider_ids: Record<string, unknown> | null
  provider_metadata: Record<string, unknown> | null
}

const text = (value: unknown): string | null => {
  const s = typeof value === 'string' ? value.trim() : ''
  return s ? s : null
}
const httpsUrl = (value: unknown): string | null => {
  const s = text(value)
  return s && /^https:\/\//.test(s) ? s : null
}

/** What the row already knows, with no lookup at all. */
export function storedIdentity(row: EntityRow): EntityIdentity {
  const meta = (row.provider_metadata || {}) as Record<string, unknown>
  return {
    ref: row.canonical_ref_key,
    symbol: text(row.display_symbol),
    name: text(meta.display_name),
    imageUrl: httpsUrl(meta.image_url),
    provider: text(meta.identity_provider),
    providerId: text(meta.identity_provider_id),
    chain: text(meta.identity_chain) || chainIdFor(row.chain_namespace, row.chain_id),
    address: text(row.contract_address),
    state: 'stored',
  }
}

/** A row is complete when a member would read a name and a symbol from it. */
export function identityComplete(identity: EntityIdentity): boolean {
  return !!identity.symbol && !!identity.name
}

/** An unresolved marker is honoured for a day so a list does not re-ask on
 *  every load for a token nothing can name. */
export function unresolvedRecently(row: EntityRow, now: number): boolean {
  const meta = (row.provider_metadata || {}) as Record<string, unknown>
  if (meta.identity_state !== 'unresolved') return false
  const at = Date.parse(String(meta.identity_at ?? ''))
  return Number.isFinite(at) && now - at < UNRESOLVED_TTL_MS
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
  try {
    if (!req.headers.get('Authorization')) return json({ error: 'unauthorized' }, 401)
    const body = await req.json().catch(() => null) as Record<string, unknown> | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'invalid_body' }, 400)
    const orgId = typeof body.orgId === 'string' ? body.orgId : ''
    if (!orgId || orgId.length > 64) return json({ error: 'invalid_org' }, 400)
    const refs = Array.isArray(body.refs)
      ? [...new Set(body.refs.filter((r): r is string => typeof r === 'string' && !!r.trim() && r.length <= 256))]
      : []
    if (!refs.length) return json({ error: 'invalid_refs' }, 400)
    if (refs.length > MAX_REFS) return json({ error: 'too_many_refs' }, 400)
    const refresh = body.refresh === true

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const actor = await requireIntelAccess(req, createClient, admin, orgId)

    const { data, error } = await admin
      .from('entities')
      .select('id,canonical_ref_key,display_symbol,contract_address,chain_namespace,chain_id,entity_kind,provider_ids,provider_metadata')
      .eq('org_id', orgId)
      .in('canonical_ref_key', refs)
    if (error) throw error

    const now = Date.now()
    const identities: Record<string, EntityIdentity> = {}
    const pending: EntityRow[] = []

    for (const row of (data || []) as EntityRow[]) {
      const stored = storedIdentity(row)
      identities[row.canonical_ref_key] = stored
      if (!refresh && identityComplete(stored)) continue
      if (!refresh && unresolvedRecently(row, now)) {
        identities[row.canonical_ref_key] = { ...stored, state: 'unresolved' }
        continue
      }
      if (row.entity_kind !== 'asset' || !stored.address) continue
      pending.push(row)
    }

    let resolved = 0
    for (const row of pending) {
      if (resolved >= MAX_RESOLVES) {
        identities[row.canonical_ref_key] = { ...identities[row.canonical_ref_key], state: 'deferred' }
        continue
      }
      resolved += 1
      const stored = storedIdentity(row)
      const chain = chainIdFor(row.chain_namespace, row.chain_id)
      const result = await resolveAsset(admin, {
        query: String(row.contract_address),
        chain,
        orgId,
        userId: actor?.userId ?? null,
        ctx: { supabase: admin },
      }).catch(() => null)

      const identity = result?.identity ?? null
      const symbol = text(identity?.symbol) || text(row.display_symbol)
      const name = text(identity?.name)
      const meta = { ...((row.provider_metadata || {}) as Record<string, unknown>) }
      const providerIds = { ...((row.provider_ids || {}) as Record<string, unknown>) }

      if (identity && (symbol || name)) {
        const imageUrl = httpsUrl(identity.logoUrl)
        meta.display_name = name ?? meta.display_name ?? null
        if (imageUrl) meta.image_url = imageUrl
        meta.identity_provider = identity.provider
        meta.identity_provider_id = identity.providerId
        meta.identity_chain = identity.chain ?? chain
        meta.identity_route = identity.route
        meta.identity_state = 'resolved'
        meta.identity_at = new Date().toISOString()
        if (identity.provider && identity.providerId) providerIds[identity.provider] = identity.providerId
        identities[row.canonical_ref_key] = {
          ref: row.canonical_ref_key,
          symbol,
          name: text(meta.display_name),
          imageUrl: httpsUrl(meta.image_url),
          provider: identity.provider,
          providerId: identity.providerId,
          chain: identity.chain ?? chain,
          address: stored.address,
          state: 'resolved',
        }
      } else {
        meta.identity_state = 'unresolved'
        meta.identity_at = new Date().toISOString()
        meta.identity_reason = result?.reason ?? 'no_source_answered'
        identities[row.canonical_ref_key] = {
          ...identities[row.canonical_ref_key],
          state: 'unresolved',
          reason: String(meta.identity_reason),
        }
      }

      // Stored on the entity so no later render has to ask anything at all.
      const { error: writeError } = await admin.from('entities')
        .update({ display_symbol: symbol, provider_ids: providerIds, provider_metadata: meta, updated_at: new Date().toISOString() })
        .eq('id', row.id).eq('org_id', orgId)
      if (writeError) throw writeError
    }

    // A ref with no entities row in this workspace is reported as such rather
    // than silently missing from the answer.
    for (const ref of refs) {
      if (!identities[ref]) {
        identities[ref] = { ref, symbol: null, name: null, imageUrl: null, provider: null, providerId: null,
          chain: null, address: null, state: 'unresolved', reason: 'entity_not_in_workspace' }
      }
    }

    return json({ identities, resolved, deferred: Math.max(0, pending.length - resolved) })
  } catch (e) {
    if (e instanceof OrgAuthzError) return json({ error: e.message }, e.status ?? 403)
    return json({ error: (e as Error)?.message || 'entity_identity_failed' }, 500)
  }
})
