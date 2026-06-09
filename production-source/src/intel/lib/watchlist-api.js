// Investor Intel — watchlist client API (P2).
// Entity resolution happens server-side (intel-resolve); the watchlist rows
// themselves are written under the user's RLS.

export async function resolveEntity(supabase, orgId, input) {
  const { data, error } = await supabase.functions.invoke('intel-resolve', { body: { orgId, ...input } })
  if (error) throw new Error(error.message || 'resolve_failed')
  if (data?.error) throw new Error(data.error)
  return data.entity
}

export async function ensureDefaultWatchlist(supabase, orgId, userId) {
  const { data: existing } = await supabase
    .from('watchlists').select('*').eq('org_id', orgId).eq('is_default', true).maybeSingle()
  if (existing) return existing
  const { data, error } = await supabase
    .from('watchlists').insert({ org_id: orgId, user_id: userId, name: 'My Watchlist', is_default: true })
    .select('*').single()
  if (error) throw error
  return data
}

export async function listWatchlist(supabase, orgId) {
  const { data, error } = await supabase
    .from('watchlist_items')
    .select('*, entity:entities(*)')
    .eq('org_id', orgId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

export async function addWatchlistItem(supabase, orgId, userId, { kind = 'asset', chain, value, itemType = 'token', label } = {}) {
  const entity = await resolveEntity(supabase, orgId, { kind, chain, value })
  const wl = await ensureDefaultWatchlist(supabase, orgId, userId)
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
export async function addEntityToWatchlist(supabase, orgId, userId, entity, itemType = 'token') {
  const wl = await ensureDefaultWatchlist(supabase, orgId, userId)
  const { data, error } = await supabase
    .from('watchlist_items')
    .upsert({ org_id: orgId, watchlist_id: wl.id, entity_id: entity.id, item_type: itemType, label: entity.display_symbol || null },
      { onConflict: 'watchlist_id,entity_id', ignoreDuplicates: true })
    .select('*').maybeSingle()
  if (error && String(error.code) !== '23505') throw error
  return data
}

// URL-safe link target for an entity detail page.
export function entityHref(entity, itemType) {
  if (!entity?.canonical_ref_key) return '/intel'
  const ref = encodeURIComponent(entity.canonical_ref_key)
  if (itemType === 'wallet' || entity.entity_kind === 'wallet') return `/intel/wallet/${ref}`
  if (itemType === 'narrative' || entity.entity_kind === 'narrative') return '/intel/narratives'
  return `/intel/asset/${ref}`
}
