// Investor Intel — news & source-following client API.

// PostgREST .or() treats commas/parens as syntax and % as an ilike wildcard —
// strip them so a free-text search term can't break the filter.
const sanitizeTerm = (s) => String(s || '').replace(/[%,()*]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
const endOfDay = (d) => `${d}T23:59:59.999`

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

export async function listNews(supabase, orgId, { entityId = null, limit = 50, search = null, since = null, until = null } = {}) {
  const broad = !!(search || since || until)
  let q = supabase.from('news_items').select('*, entity:entities(display_symbol, canonical_ref_key)').eq('org_id', orgId)
  if (entityId) q = q.eq('entity_id', entityId)
  if (search) { const s = sanitizeTerm(search); if (s) q = q.or(`title.ilike.%${s}%,summary.ilike.%${s}%`) }
  if (since) q = q.gte('created_at', since)
  if (until) q = q.lte('created_at', endOfDay(until))
  q = q.order('published_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }).limit(broad ? 200 : limit)
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
export async function listGlobalNews(supabase, { chains = null, limit = 40, requireChain = false, search = null, since = null, until = null } = {}) {
  const broad = !!(search || since || until)
  let q = supabase
    .from('intel_global_news')
    .select('id, title, url, summary, source_name, sentiment, published_at, created_at, chains, entity_symbol, source_quality, authority_level, news_category')
  if (chains && chains.length && requireChain) q = q.overlaps('chains', chains)
  if (search) { const s = sanitizeTerm(search); if (s) q = q.or(`title.ilike.%${s}%,summary.ilike.%${s}%,source_name.ilike.%${s}%`) }
  if (since) q = q.gte('created_at', since)
  if (until) q = q.lte('created_at', endOfDay(until))
  q = q.order('created_at', { ascending: false }).limit(broad ? 300 : (requireChain ? Math.max(limit * 3, 45) : 120))
  const { data, error } = await q
  if (error) throw error
  let rows = data || []
  if (chains && chains.length && !requireChain) rows = rows.filter((r) => !r.chains?.length || r.chains.some((c) => chains.includes(c)))
  if (requireChain && !broad) {
    const now = Date.now()
    const rank = (r) => {
      const ageH = (now - new Date(r.published_at || r.created_at || 0).getTime()) / 3_600_000
      const rec = Number.isNaN(ageH) ? 0.3 : Math.max(0, Math.exp(-ageH / 48))
      return 0.6 * rec + 0.4 * ((r.source_quality ?? 40) / 100)
    }
    rows.sort((a, b) => rank(b) - rank(a))
  }
  return rows.slice(0, broad ? 200 : limit).map((r) => ({ ...r, curated: true }))
}

// Paginated global-news history (the deep shared corpus). Server-side range +
// exact count so users can page through the full ~15-month retention, not just
// a recent window. Text search spans everything; chain personalization applies
// only while browsing (no search term).
export async function pageGlobalNews(supabase, { chains = null, search = null, since = null, until = null, signal = null, category = null, page = 0, pageSize = 20 } = {}) {
  let q = supabase
    .from('intel_global_news')
    .select('id, title, url, summary, source_name, sentiment, published_at, created_at, chains, entity_symbol, source_quality, authority_level, news_category', { count: 'exact' })
  if (search) { const s = sanitizeTerm(search); if (s) q = q.or(`title.ilike.%${s}%,summary.ilike.%${s}%,source_name.ilike.%${s}%`) }
  else if (chains && chains.length) q = q.or(`chains.ov.{${chains.join(',')}},chains.eq.{}`)
  if (since) q = q.gte('created_at', since)
  if (until) q = q.lte('created_at', endOfDay(until))
  if (signal) q = q.eq('sentiment', signal === 'caution' ? 'mixed' : signal)
  if (category) q = q.eq('news_category', category)
  const from = Math.max(0, page) * pageSize
  q = q.order('created_at', { ascending: false }).range(from, from + pageSize - 1)
  const { data, error, count } = await q
  if (error) throw error
  return { rows: (data || []).map((r) => ({ ...r, curated: true })), count: count || 0 }
}

// Curated intelligence — the AI-analyzed story layer (intel_curated_news):
// clusters scored for importance/credibility, each with what-happened,
// why-it-matters, bull/bear, source quality and a verification flag.
// Authenticated read (RLS: auth.uid() IS NOT NULL); ranked by final_score.
export async function listCuratedNews(supabase, { chains = null, limit = 12, search = null, since = null, until = null } = {}) {
  const broad = !!(search || since || until)
  let q = supabase
    .from('intel_curated_news')
    .select('id, cluster_hash, title, cleaned_title, summary, why_it_matters, what_happened, crypto_impact, watch_next, bull_case, bear_case, signal, signal_bias, confidence, news_category, source_quality_score, needs_confirmation, final_score, source_count, source_categories, supporting_sources, source_type, narratives, tokens, sectors, chains, primary_url, published_at, created_at')
    .eq('should_surface', true)
  if (search) { const s = sanitizeTerm(search); if (s) q = q.or(`title.ilike.%${s}%,cleaned_title.ilike.%${s}%,summary.ilike.%${s}%,why_it_matters.ilike.%${s}%,what_happened.ilike.%${s}%`) }
  if (since) q = q.gte('created_at', since)
  if (until) q = q.lte('created_at', endOfDay(until))
  // Browse: ranked by importance (final_score). Search/date: chronological so the
  // full history is reachable, newest first.
  q = broad
    ? q.order('published_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }).limit(200)
    : q.order('final_score', { ascending: false, nullsFirst: false }).limit(80)
  const { data, error } = await q
  if (error) throw error
  let rows = data || []
  if (chains && chains.length) rows = rows.filter((r) => !r.chains?.length || r.chains.some((c) => chains.includes(c)))
  return rows.slice(0, broad ? 200 : limit)
}

