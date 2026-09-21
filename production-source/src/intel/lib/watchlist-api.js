// Investor Intel — watchlist client API (P2).
// Entity resolution happens server-side (intel-resolve); the watchlist rows
// themselves are written under the user's RLS.
import { normalizeAssetEntity, nativeAssetChain, assetLogoUrl } from './asset-identity'
import { isRevisionConflict } from './revision-conflict'

/** A refusal carries its machine code and the chain it was refused against, so
 *  the page can say why in the reader's own language. Reading the function's
 *  body matters: a non-2xx invoke only ever reports "non-2xx status code", so
 *  before this the server's reason never reached the member at all. */
export class ResolveRefused extends Error {
  constructor(code, details) {
    super(code)
    this.name = 'ResolveRefused'
    this.code = code
    this.details = details || null
  }
}

export async function resolveEntity(supabase, orgId, input) {
  const { data, error } = await supabase.functions.invoke('intel-resolve', { body: { orgId, ...input } })
  if (error) {
    const body = await error.context?.json?.().catch(() => null)
    if (body?.error) throw new ResolveRefused(body.error, body.refusal)
    throw new Error(error.message || 'resolve_failed')
  }
  if (data?.error) throw new ResolveRefused(data.error, data.refusal)
  return normalizeAssetEntity(data.entity)
}

/** Name the entities behind these refs. The endpoint answers from our own
 *  catalogue and caches first and stores what it finds on the entity, so a
 *  ref asked for once is answered from the row itself ever after. */
export async function loadEntityIdentities(supabase, orgId, refs) {
  const wanted = [...new Set((refs || []).filter(Boolean))].slice(0, 40)
  if (!orgId || !wanted.length) return {}
  const { data, error } = await supabase.functions.invoke('intel-entity-identity', { body: { orgId, refs: wanted } })
  if (error) {
    const body = await error.context?.json?.().catch(() => null)
    throw new Error(body?.error || error.message || 'entity_identity_failed')
  }
  if (data?.error) throw new Error(data.error)
  return data?.identities || {}
}

export async function ensureDefaultWatchlist(supabase, orgId, userId) {
  const { data: existing, error: readError } = await supabase
    .from('watchlists').select('*').eq('org_id', orgId).eq('is_default', true).maybeSingle()
  if (readError) throw readError
  if (existing) return existing
  const { data, error } = await supabase
    .from('watchlists').insert({ org_id: orgId, user_id: userId, name: 'My Watchlist', is_default: true })
    .select('*').single()
  if (error?.code === '23505') {
    const retry = await supabase.from('watchlists').select('*').eq('org_id', orgId).eq('is_default', true).single()
    if (retry.error) throw retry.error
    return retry.data
  }
  if (error) throw error
  return data
}

export async function listWatchlists(supabase, orgId) {
  const { data, error } = await supabase.from('watchlists').select('*').eq('org_id', orgId).order('is_default', { ascending: false }).order('sort_order').order('id').limit(101)
  if (error) throw error
  if (!Array.isArray(data)) throw new Error('Watchlists could not be read.')
  if (data.length > 100) throw new Error('More than 100 watchlists are present. Narrowing support is required before editing this workspace.')
  return data
}
export async function listWatchlist(supabase, orgId, listId = null) {
  // Legacy consumers mean the default list, never an unlabeled cross-list merge.
  if (!listId) {
    const { data, error } = await supabase.from('watchlists').select('id').eq('org_id', orgId).eq('is_default', true).maybeSingle()
    if (error) throw error
    if (!data) return []
    listId = data.id
  }
  const { data, error } = await supabase
    .from('watchlist_items')
    .select('*, entity:entities(*)')
    .eq('org_id', orgId)
    .eq('watchlist_id', listId)
    .order('is_pinned', { ascending: false })
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: false }).order('id').limit(1001)
  if (error) throw error
  if (!Array.isArray(data)) throw new Error('Watchlist items could not be read.')
  if (data.length > 1000) throw new Error('This list exceeds the 1,000-item editing limit. No partial order was loaded.')
  return (data || []).map(row => ({ ...row, entity: normalizeAssetEntity(row.entity) }))
}

export async function addWatchlistItem(supabase, orgId, userId, { kind = 'asset', chain, value, itemType = 'token', label, listId = null } = {}) {
  const entity = await resolveEntity(supabase, orgId, { kind, chain, value })
  const wl = listId ? { id: listId } : await ensureDefaultWatchlist(supabase, orgId, userId)
  const { data, error } = await supabase
    .from('watchlist_items')
    .insert({ org_id: orgId, watchlist_id: wl.id, entity_id: entity.id, item_type: itemType, label: label || entity.display_symbol || null })
    .select('*, entity:entities(*)').single()
  if (error) {
    if (String(error.code) === '23505') { // already on the watchlist
      const { data: ex } = await supabase
        .from('watchlist_items').select('*, entity:entities(*)')
        .eq('watchlist_id', wl.id).eq('entity_id', entity.id).maybeSingle()
      if (ex) return ex
    }
    throw error
  }
  return data
}

export async function removeWatchlistItem(supabase, itemId) {
  const { error } = await supabase.from('watchlist_items').delete().eq('id', itemId)
  if (error) throw error
}

// Optional manual holdings (no wallet connection needed). Null clears.
export async function setHolding(supabase, itemId, { amount = null, costBasis = null } = {}) {
  const { error } = await supabase.from('watchlist_items')
    .update({ holding_amount: amount === '' ? null : amount, cost_basis_usd: costBasis === '' ? null : costBasis })
    .eq('id', itemId)
  if (error) throw error
}

// Add an already-resolved entity (no re-resolve round-trip).
export async function addEntityToWatchlist(supabase, orgId, userId, entity, itemType = 'token', listId = null) {
  const wl = listId ? { id: listId } : await ensureDefaultWatchlist(supabase, orgId, userId)
  const { data, error } = await supabase
    .from('watchlist_items')
    .upsert({ org_id: orgId, watchlist_id: wl.id, entity_id: entity.id, item_type: itemType, label: entity.display_symbol || null },
      { onConflict: 'watchlist_id,entity_id', ignoreDuplicates: true })
    .select('*').maybeSingle()
  if (error && String(error.code) !== '23505') throw error
  return data
}

export async function createWatchlist(supabase, orgId, userId, name) {
  const title = String(name || '').trim()
  if (!title || title.length > 120) throw new Error('Use a list name between 1 and 120 characters.')
  const { data, error } = await supabase.from('watchlists').insert({ org_id: orgId, user_id: userId, name: title }).select('*').single()
  if (error) throw error
  return data
}

export async function watchlistAssetPage(supabase, orgId, listId, page = 0) {
  if (!listId) return { assets: [], hasMore: false }
  const index = Math.max(0, Math.min(100, Math.trunc(page)))
  const { data, error } = await supabase.from('watchlist_items').select('id,entity:entities(canonical_ref_key,display_symbol)')
    .eq('org_id', orgId).eq('watchlist_id', listId).order('is_pinned', { ascending: false }).order('sort_order').order('created_at', { ascending: false }).order('id').range(index * 20, index * 20 + 20)
  if (error) throw error
  if (!Array.isArray(data)) throw Error('Watchlist assets could not be read.')
  return { assets: data.slice(0, 20).map(row => ({ asset: row.entity?.canonical_ref_key, symbol: row.entity?.display_symbol, name: row.entity?.display_symbol || row.entity?.canonical_ref_key, logo: assetLogoUrl(row.entity?.canonical_ref_key) })), hasMore: data.length > 20 }
}
export async function changeWatchlist(supabase, orgId, list, name) {
  const title = String(name || '').trim()
  if (!title || title.length > 120) throw new Error('Use a list name between 1 and 120 characters.')
  const { data, error } = await supabase.from('watchlists').update({ name: title }).eq('org_id', orgId).eq('id', list.id).eq('revision', list.revision).select('*').maybeSingle()
  if (error) throw error
  if (!data) throw new Error('This list changed in another tab. Reload before renaming it.')
  return data
}
export async function deleteWatchlist(supabase, orgId, list) {
  if (list.is_default) throw new Error('The default list is retained for existing workflows.')
  const { data, error } = await supabase.from('watchlists').delete().eq('org_id', orgId).eq('id', list.id).eq('revision', list.revision).select('id').maybeSingle()
  if (error) throw error
  if (!data) throw new Error('This list changed in another tab. Reload before deleting it.')
}
export async function reorderWatchlist(supabase, orgId, list, itemIds) {
  const { data, error } = await supabase.rpc('intel_reorder_watchlist', { p_org_id: orgId, p_list_id: list.id, p_revision: list.revision, p_item_ids: itemIds })
  if (error) throw new Error(isRevisionConflict(error) || /members_changed/.test(error.message) ? 'This list changed in another tab. Reload and review the latest order.' : error.message)
  return data
}
export async function pinWatchlistItem(supabase, orgId, list, itemId, pinned) {
  const { data, error } = await supabase.rpc('intel_pin_watchlist_item', { p_org_id: orgId, p_list_id: list.id, p_item_id: itemId, p_revision: list.revision, p_pinned: pinned })
  if (error) throw new Error(isRevisionConflict(error) ? 'This list changed in another tab. Reload and review the latest pins.' : error.message)
  if (!Number.isInteger(data)) throw new Error('The pin change was not confirmed saved.')
  return data
}

// URL-safe link target for an entity detail page.
export function entityHref(entity, itemType) {
  if (!entity?.canonical_ref_key) return '/intel'
  const native = entity.entity_kind !== 'wallet' && nativeAssetChain(entity.canonical_ref_key)
  const ref = encodeURIComponent(native ? `native:${native.id}` : entity.canonical_ref_key)
  if (itemType === 'wallet' || entity.entity_kind === 'wallet') return `/intel/wallet/${ref}`
  if (itemType === 'narrative' || entity.entity_kind === 'narrative') return '/intel/narratives'
  return `/intel/asset/${ref}`
}
