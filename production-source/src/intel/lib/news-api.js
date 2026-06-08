// Investor Intel — news & source-following client API.

export async function listSources(supabase, orgId) {
  const { data, error } = await supabase.from('tracked_sources').select('*, entity:entities(display_symbol)').eq('org_id', orgId).order('created_at', { ascending: false })
  if (error) throw error; return data || []
}

export async function addSource(supabase, orgId, userId, { sourceType, value, label = null, entityId = null }) {
  const clean = String(value || '').trim().replace(/^@/, '')
  const { data, error } = await supabase.from('tracked_sources')
    .insert({ org_id: orgId, user_id: userId, source_type: sourceType, value: clean, label, entity_id: entityId })
    .select('*').single()
  if (error) {
    if (/intel_limit_reached:news_sources/.test(error.message || '')) throw new Error('LIMIT_NEWS_SOURCES')
    if (String(error.code) === '23505') throw new Error('DUPLICATE')
    throw error
  }
  return data
}

export async function removeSource(supabase, id) {
  const { error } = await supabase.from('tracked_sources').delete().eq('id', id); if (error) throw error
}

export async function listNews(supabase, orgId, { entityId = null, limit = 50 } = {}) {
  let q = supabase.from('news_items').select('*, entity:entities(display_symbol, canonical_ref_key)').eq('org_id', orgId)
    .order('published_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }).limit(limit)
  if (entityId) q = q.eq('entity_id', entityId)
  const { data, error } = await q
  if (error) throw error; return data || []
}

export async function refreshNews(supabase, orgId, entityId = null) {
  const { data, error } = await supabase.functions.invoke('intel-news-fetch', { body: { orgId, entityId } })
  if (error) throw new Error(error.message || 'news_fetch_failed')
  if (data?.error) throw new Error(data.reason || data.error)
  return data
}

export async function usageSummary(supabase) {
  const { data, error } = await supabase.rpc('intel_usage_summary'); if (error) throw error; return data || {}
}

// News for a single entity: the workspace's custom items + curated corpus by symbol.
export async function listEntityNews(supabase, orgId, entityId, symbol) {
  const [{ data: custom }, gl] = await Promise.all([
    supabase.from('news_items').select('id, title, url, source_name, sentiment, published_at').eq('org_id', orgId).eq('entity_id', entityId).order('created_at', { ascending: false }).limit(12),
    symbol ? supabase.from('intel_global_news').select('id, title, url, source_name, sentiment, published_at, entity_symbol, source_quality, authority_level, news_category').ilike('entity_symbol', symbol).order('created_at', { ascending: false }).limit(12) : Promise.resolve({ data: [] }),
  ])
  const merged = [...((gl?.data) || []).map((n) => ({ ...n, curated: true })), ...((custom) || [])]
  return merged.sort((a, b) => new Date(b.published_at || 0) - new Date(a.published_at || 0)).slice(0, 15)
}

// Shared corpus (global). For a specific chain/asset view pass requireChain=true:
// it does a STRICT array-overlap chain match (so chain-less macro never leaks onto
// one asset) and ranks chain-matched items by source authority + recency, so the
// seeded TIER-0 chain sources lead. Without requireChain it stays the user's
// followed-chains feed (recency-ordered, chain-less market-wide items kept).
export async function listGlobalNews(supabase, { chains = null, limit = 40, requireChain = false } = {}) {
  let q = supabase
    .from('intel_global_news')
    .select('id, title, url, summary, source_name, sentiment, published_at, created_at, chains, entity_symbol, source_quality, authority_level, news_category')
  if (chains && chains.length && requireChain) q = q.overlaps('chains', chains)
  q = q.order('created_at', { ascending: false }).limit(requireChain ? Math.max(limit * 3, 45) : 120)
  const { data, error } = await q
  if (error) throw error
  let rows = data || []
  if (chains && chains.length && !requireChain) rows = rows.filter((r) => !r.chains?.length || r.chains.some((c) => chains.includes(c)))
  if (requireChain) {
    const now = Date.now()
    const rank = (r) => {
      const ageH = (now - new Date(r.published_at || r.created_at || 0).getTime()) / 3_600_000
      const rec = Number.isNaN(ageH) ? 0.3 : Math.max(0, Math.exp(-ageH / 48))
      return 0.6 * rec + 0.4 * ((r.source_quality ?? 40) / 100)
    }
    rows.sort((a, b) => rank(b) - rank(a))
  }
  return rows.slice(0, limit).map((r) => ({ ...r, curated: true }))
}

