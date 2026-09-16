// Investor Intel — client data helpers (P1: trial + profile).
// All calls use the authenticated client from useSupabase().

// Create a trial Investor Intel workspace for the current user. Returns the new
// org id. Throws 'trial_already_used' if the identity already had a trial.
export async function startIntelTrial(supabase, { displayName = null, trialDays = 7 } = {}) {
  const { data, error } = await supabase.rpc('start_intel_trial', {
    p_display_name: displayName,
    p_trial_days: trialDays,
  })
  if (error) throw new Error(error.message || 'start_trial_failed')
  return data
}

// Create a FREE Investor Intel workspace for the current user. Returns the org
// id. Unlike startIntelTrial this does not record a trial guard, so a free
// member can still take their one 7-day trial later, and it leaves no payment
// deadline on the workspace, so the membership never lapses into the paywall.
// A user who already has an Investor Intel workspace is handed that one back.
export async function startIntelFree(supabase, { displayName = null } = {}) {
  const { data, error } = await supabase.rpc('start_intel_free', { p_display_name: displayName })
  if (error) throw new Error(error.message || 'start_free_failed')
  return data
}

// The caller's tier and per-surface entitlement, for LABELLING locked surfaces.
// Never a trust boundary: every gated read is refused again at the server, and
// the withheld reading is never sent to the browser in the first place.
export async function readIntelAccess(supabase, orgId) {
  const { data, error } = await supabase.rpc('intel_account_access', { p_org: orgId })
  if (error) throw new Error(error.message || 'intel_access_unavailable')
  return data || { tier: null, surfaces: {} }
}

export async function getIntelProfile(supabase, orgId) {
  const { data, error } = await supabase
    .from('intel_user_profiles').select('*').eq('org_id', orgId).maybeSingle()
  if (error) throw error
  return data
}

// Upsert the per-workspace risk/experience/style profile (1:1 on org_id).
export async function saveIntelProfile(supabase, orgId, userId, patch) {
  const row = { org_id: orgId, user_id: userId, ...patch, updated_at: new Date().toISOString() }
  const { data, error } = await supabase
    .from('intel_user_profiles').upsert(row, { onConflict: 'org_id' }).select('*').single()
  if (error) throw error
  return data
}

// Mark onboarding done for a specific Intel workspace. Pass the org explicitly
// so completion targets the workspace being onboarded, not whatever org is
// active in auth metadata (a dual-org holder's active org may be a different,
// content, workspace). Falls back to the active org when omitted.
export async function completeIntelOnboarding(supabase, orgId = null) {
  const { error } = await supabase.rpc('complete_intel_onboarding', { p_org_id: orgId })
  if (error) throw error
}

export async function getNotificationPrefs(supabase, orgId) {
  const { data, error } = await supabase
    .from('notification_preferences').select('*').eq('org_id', orgId).maybeSingle()
  if (error) throw error
  return data
}

export async function saveNotificationPrefs(supabase, orgId, userId, patch) {
  const row = { org_id: orgId, user_id: userId, ...patch, updated_at: new Date().toISOString() }
  const { data, error } = await supabase
    .from('notification_preferences').upsert(row, { onConflict: 'org_id' }).select('*').single()
  if (error) throw error
  return data
}
