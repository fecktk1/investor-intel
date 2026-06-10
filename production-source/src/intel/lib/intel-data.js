// Investor Intel — CRUD helpers for theses, briefs, alerts, saved research.

const todayISO = () => new Date().toISOString().slice(0, 10)

// ── Theses (P13) ──
export async function listTheses(supabase, orgId) {
  const { data, error } = await supabase.from('intel_theses').select('*').eq('org_id', orgId).order('created_at', { ascending: false })
  if (error) throw error; return data || []
}
export async function createThesis(supabase, orgId, userId, t) {
  const { data, error } = await supabase.from('intel_theses').insert({ org_id: orgId, user_id: userId, ...t }).select('*').single()
  if (error) throw error; return data
}
export async function deleteThesis(supabase, id) {
  const { error } = await supabase.from('intel_theses').delete().eq('id', id); if (error) throw error
}

// ── Briefs (P9) ──
export async function listBriefs(supabase, orgId) {
  const { data, error } = await supabase.from('intel_briefs').select('*, artifact:research_artifacts(*)').eq('org_id', orgId).order('period_date', { ascending: false })
  if (error) throw error; return data || []
}
export async function upsertBrief(supabase, orgId, { briefType = 'daily', periodDate = todayISO(), artifactId = null, status = 'ready' }) {
  const { data, error } = await supabase.from('intel_briefs')
    .upsert({ org_id: orgId, brief_type: briefType, period_date: periodDate, artifact_id: artifactId, status }, { onConflict: 'org_id,brief_type,period_date' })
    .select('*, artifact:research_artifacts(*)').single()
  if (error) throw error; return data
}

// ── Alerts (P10) ──
export async function listAlertRules(supabase, orgId) {
  const { data, error } = await supabase.from('intel_alert_rules').select('*, entity:entities(*)').eq('org_id', orgId).order('created_at', { ascending: false })
  if (error) throw error; return data || []
}
export async function createAlertRule(supabase, orgId, userId, r) {
  const { data, error } = await supabase.from('intel_alert_rules').insert({ org_id: orgId, user_id: userId, ...r }).select('*, entity:entities(*)').single()
  if (error) throw error; return data
}
export async function deleteAlertRule(supabase, id) {
  const { error } = await supabase.from('intel_alert_rules').delete().eq('id', id); if (error) throw error
}
// Patch a rule (threshold tuning, per-rule cooldown, clearing the noisy flag).
export async function updateAlertRule(supabase, id, patch) {
  const { data, error } = await supabase.from('intel_alert_rules').update(patch).eq('id', id).select('*, entity:entities(*)').single()
  if (error) throw error; return data
}
export async function listAlertEvents(supabase, orgId) {
  const { data, error } = await supabase.from('intel_alert_events').select('*, artifact:research_artifacts(*)').eq('org_id', orgId).order('fired_at', { ascending: false }).limit(50)
  if (error) throw error; return data || []
}

// ── Saved research ──
export async function listSavedResearch(supabase, orgId) {
  const { data, error } = await supabase.from('saved_research').select('*, artifact:research_artifacts(*)').eq('org_id', orgId).order('created_at', { ascending: false })
  if (error) throw error; return data || []
}
export async function saveResearch(supabase, orgId, userId, { artifactId, title, snapshot = {}, tags = [] }) {
  const { data, error } = await supabase.from('saved_research').insert({ org_id: orgId, user_id: userId, artifact_id: artifactId, title, snapshot, tags }).select('*').single()
  if (error) throw error; return data
}
export async function deleteSavedResearch(supabase, id) {
  const { error } = await supabase.from('saved_research').delete().eq('id', id); if (error) throw error
}
