// Investor Intel — super-admin controls API (all RPCs self-gate on is_super_admin).

export async function adminOverview(supabase) {
  const { data, error } = await supabase.rpc('intel_admin_overview'); if (error) throw error; return data
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
  const { data, error } = await supabase.functions.invoke('intel-provider-coverage', { body: {} })
  if (error) throw new Error(error.message || 'coverage_failed')
  if (data?.error) throw new Error(data.error)
  return data
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
export async function adminRunGlobalCrawl(supabase) {
  const { data, error } = await supabase.functions.invoke('intel-global-news-cron', { body: {} })
  if (error) throw new Error(error.message || 'crawl_failed')
  if (data?.error) throw new Error(data.error)
  return data
}
export async function adminRunChainNews(supabase) {
  const { data, error } = await supabase.functions.invoke('intel-chain-news-cron', { body: {} })
  if (error) throw new Error(error.message || 'chain_news_failed')
  if (data?.error) throw new Error(data.error)
  return data
}
export async function adminRunOrgNewsHarvest(supabase) {
  const { data, error } = await supabase.functions.invoke('intel-org-news-harvest', { body: {} })
  if (error) throw new Error(error.message || 'harvest_failed')
  if (data?.error) throw new Error(data.error)
  return data
}
export async function adminRunMacroRefresh(supabase) {
  const { data, error } = await supabase.functions.invoke('intel-macro-cron', { body: {} })
  if (error) throw new Error(error.message || 'macro_failed')
  if (data?.error) throw new Error(data.error)
  return data
}
export async function adminRunRegime(supabase) {
  const { data, error } = await supabase.functions.invoke('intel-regime', { body: {} })
  if (error) throw new Error(error.message || 'regime_failed')
  if (data?.error) throw new Error(data.error)
  return data
}
export async function adminRunStoryCards(supabase) {
  const { data, error } = await supabase.functions.invoke('intel-story-cards', { body: { limit: 8 } })
  if (error) throw new Error(error.message || 'story_cards_failed')
  if (data?.error) throw new Error(data.error)
  return data
}
export async function adminRunCurateNews(supabase) {
  const { data, error } = await supabase.functions.invoke('intel-curate-news', { body: { limit: 30 } })
  if (error) throw new Error(error.message || 'curate_failed')
  if (data?.error) throw new Error(data.error)
  return data
}
