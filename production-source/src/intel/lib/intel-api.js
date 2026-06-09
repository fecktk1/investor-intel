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

export async function completeIntelOnboarding(supabase) {
  const { error } = await supabase.rpc('complete_intel_onboarding')
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
