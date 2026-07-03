// Investor Intel — super-admin controls API (all RPCs self-gate on is_super_admin).

export async function adminOverview(supabase) {
  const { data, error } = await supabase.rpc('intel_admin_overview'); if (error) throw error; return data
}
// Intelligence quality audit (218): cache hit rate, AI avoided, deltas, alert noise.
export async function adminQualityAudit(supabase, hours = 24) {
  const { data, error } = await supabase.rpc('intel_admin_quality_audit', { p_hours: hours }); if (error) throw error; return data
}
export async function adminCardRanking(supabase, artifactId) {
  const { data, error } = await supabase.rpc('intel_admin_card_ranking', { p_artifact_id: artifactId }); if (error) throw error; return data
}
export async function adminNewsInclusion(supabase, artifactId) {
  const { data, error } = await supabase.rpc('intel_admin_news_inclusion', { p_artifact_id: artifactId }); if (error) throw error; return data
}
// Long-memory observability (migrations 224-230). All self-gate on is_super_admin.
export async function adminPrunePreview(supabase, table = null) {
  const { data, error } = await supabase.rpc('intel_prune_preview', { p_table: table }); if (error) throw error; return data
}
export async function adminClusterInspect(supabase, clusterId) {
  const { data, error } = await supabase.rpc('intel_cluster_inspect', { p_cluster_id: clusterId }); if (error) throw error; return data
}
// Rollup health + source reliability are plain selects (RLS-gated).
export async function adminMemoryHealth(supabase) {
  const [rollups, reliability, events] = await Promise.all([
    supabase.from('intel_rollups').select('subject_type', { count: 'exact', head: true }),
    supabase.from('intel_source_reliability').select('source_id', { count: 'exact', head: true }),
    supabase.from('intel_event_memory').select('id', { count: 'exact', head: true }),
  ])
  return {
    rollup_rows: rollups.count ?? null,
    reliability_rows: reliability.count ?? null,
    event_rows: events.count ?? null,
  }
}
export async function adminTopNoisySources(supabase, limit = 10) {
  const { data, error } = await supabase.from('intel_source_reliability')
    .select('source_name, source_type, sample_count, distinct_clusters, early_score, noise_score')
    .order('noise_score', { ascending: false }).limit(limit)
  if (error) throw error; return data || []
}
export async function adminListWorkspaces(supabase, search) {
  const { data, error } = await supabase.rpc('intel_admin_list_workspaces', { p_search: search || null, p_limit: 200 })
  if (error) throw error; return data || []
}
export async function adminTrialAbuse(supabase) {
  const { data, error } = await supabase.rpc('intel_admin_trial_abuse'); if (error) throw error; return data
}
export async function adminGrantUser(supabase, { email, tier, trialDays, comp }) {
  const { data, error } = await supabase.rpc('intel_admin_grant_user', { p_email: email, p_tier: tier, p_trial_days: trialDays, p_comp: !!comp })
  if (error) throw error; return data
}
export async function adminRevoke(supabase, orgId) {
  const { error } = await supabase.rpc('intel_admin_revoke', { p_org_id: orgId }); if (error) throw error
}
export async function adminSetTrial(supabase, orgId, days) {
  const { error } = await supabase.rpc('intel_admin_set_trial', { p_org_id: orgId, p_days: days }); if (error) throw error
}
export async function adminSetTier(supabase, orgId, tier) {
  const { error } = await supabase.rpc('intel_admin_set_tier', { p_org_id: orgId, p_tier: tier }); if (error) throw error
}
export async function adminSetCostCap(supabase, orgId, cap) {
  const { error } = await supabase.rpc('intel_admin_set_cost_cap', { p_org_id: orgId, p_cap: cap }); if (error) throw error
}
export async function adminSetConfig(supabase, { kill, defaultCap, defaultTrialDays }) {
  const { error } = await supabase.rpc('intel_admin_set_config', { p_kill: kill, p_default_cap: defaultCap, p_default_trial_days: defaultTrialDays })
  if (error) throw error
}
export async function adminSetLimit(supabase, orgId, key, value) {
  const { error } = await supabase.rpc('intel_admin_set_limit', { p_org_id: orgId, p_key: key, p_value: value })
  if (error) throw error
}
export async function adminRunCoverage(supabase) {
  return invokeIntelFunction(supabase, 'intel-provider-coverage', {}, 'coverage_failed')
}

// ── Provider Integrations (v3.1) — registry + runtime status. All self-gate. ──
// Additive: absent RPCs (pre-migration-363) must not break the admin page, so
// callers wrap these in try/catch.
export async function adminProviderOverview(supabase) {
  const { data, error } = await supabase.rpc('intel_admin_provider_overview'); if (error) throw error; return data || []
}
export async function adminProviderEndpoints(supabase) {
  const { data, error } = await supabase.rpc('intel_admin_provider_endpoints'); if (error) throw error; return data || []
}
export async function adminProviderRagCoverage(supabase) {
  const { data, error } = await supabase.rpc('intel_admin_provider_rag_coverage'); if (error) throw error; return data || []
}
export async function adminProviderFreshness(supabase) {
  const { data, error } = await supabase.rpc('intel_admin_provider_freshness'); if (error) throw error; return data || []
}
export async function adminProviderMark(supabase, { provider, endpoint, setupStatus, testStatus, realCallVerified }) {
  const { error } = await supabase.rpc('intel_admin_provider_mark', {
    p_provider: provider, p_endpoint: endpoint,
    p_setup_status: setupStatus ?? null, p_test_status: testStatus ?? null,
    p_real_call_verified: typeof realCallVerified === 'boolean' ? realCallVerified : null,
  })
  if (error) throw error
}

// ── Global curated sources ──
export async function adminListGlobalSources(supabase) {
  const { data, error } = await supabase.rpc('intel_admin_list_global_sources'); if (error) throw error; return data || []
}
export async function adminAddGlobalSource(supabase, { sourceType, value, chains, label }) {
  const { data, error } = await supabase.rpc('intel_admin_add_global_source', { p_source_type: sourceType, p_value: value, p_chains: chains || [], p_label: label || null })
  if (error) throw error; return data
}
export async function adminRemoveGlobalSource(supabase, id) {
  const { error } = await supabase.rpc('intel_admin_remove_global_source', { p_id: id }); if (error) throw error
}
async function readFunctionError(error, fallback) {
  const message = error?.message || fallback
  const response = error?.context
  if (!response) return message
  try {
    const body = await response.clone().json()
    const detail = typeof body?.error === 'string'
      ? body.error
      : body?.message || JSON.stringify(body)
    return detail && detail !== message ? `${message}: ${detail}` : message
  } catch {
    try {
      const text = await response.clone().text()
      return text ? `${message}: ${text}` : message
    } catch {
      return message
    }
  }
}

function normalizeFunctionData(data) {
  if (data == null) return { ok: true }
  if (Array.isArray(data)) return { ok: true, items: data }
  if (typeof data === 'object') return { ok: data.ok !== false, ...data }
  return { ok: true, value: data }
}

async function invokeIntelFunction(supabase, name, body, fallback) {
  const { data, error } = await supabase.functions.invoke(name, { body })
  if (error) throw new Error(await readFunctionError(error, fallback))
  if (data?.error) {
    const detail = typeof data.error === 'string' ? data.error : JSON.stringify(data.error)
    throw new Error(detail || fallback)
  }
  return normalizeFunctionData(data)
}

export async function adminRunGlobalCrawl(supabase) {
  return invokeIntelFunction(supabase, 'intel-global-news-cron', {}, 'crawl_failed')
}
export async function adminRunChainNews(supabase) {
  return invokeIntelFunction(supabase, 'intel-chain-news-cron', {}, 'chain_news_failed')
}
export async function adminRunOrgNewsHarvest(supabase) {
  return invokeIntelFunction(supabase, 'intel-org-news-harvest', {}, 'harvest_failed')
}
export async function adminRunMacroRefresh(supabase) {
  return invokeIntelFunction(supabase, 'intel-macro-cron', {}, 'macro_failed')
}
export async function adminRunRegime(supabase) {
  return invokeIntelFunction(supabase, 'intel-regime', {}, 'regime_failed')
}
export async function adminRunStoryCards(supabase) {
  return invokeIntelFunction(supabase, 'intel-story-cards', { limit: 8, force: true }, 'story_cards_failed')
}
export async function adminRunCurateNews(supabase) {
  return invokeIntelFunction(supabase, 'intel-curate-news', { limit: 30 }, 'curate_failed')
}

export async function adminIntelRefreshSnapshot(supabase) {
  const [
    sources,
    globalNews,
    curated,
    storyCards,
    regime,
    macroEvents,
    macroIndicators,
  ] = await Promise.all([
    supabase.from('intel_global_sources').select('id,last_fetched_at', { count: 'exact', head: true }).eq('active', true),
    supabase.from('intel_global_news').select('id', { count: 'exact', head: true }),
    supabase.from('intel_curated_news').select('id', { count: 'exact', head: true }).eq('should_surface', true).gt('stale_after', new Date().toISOString()),
    supabase.from('intel_shared_artifacts').select('id', { count: 'exact', head: true }).eq('artifact_type', 'story_card').gt('stale_after', new Date().toISOString()),
    supabase.from('intel_market_regime').select('computed_at,regime').order('computed_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('intel_macro_calendar').select('id', { count: 'exact', head: true }),
    supabase.from('intel_macro_indicators').select('id', { count: 'exact', head: true }),
  ])
  const { data: latestSource } = await supabase.from('intel_global_sources')
    .select('last_fetched_at').not('last_fetched_at', 'is', null).order('last_fetched_at', { ascending: false }).limit(1).maybeSingle()
  return {
    active_sources: sources.count ?? null,
    latest_source_fetch_at: latestSource?.last_fetched_at || null,
    global_news: globalNews.count ?? null,
    curated_news_surfaced: curated.count ?? null,
    story_cards: storyCards.count ?? null,
    latest_regime_at: regime.data?.computed_at || null,
    latest_regime: regime.data?.regime || null,
    macro_events: macroEvents.count ?? null,
    macro_indicators: macroIndicators.count ?? null,
  }
}
