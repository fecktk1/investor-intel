// Investor Intel — CRUD helpers for theses, briefs, alerts, saved research.
import { readHistoryPage } from './history-page'

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
export async function listBriefs(supabase, orgId, { limit = 30, cursor = null, paged = false } = {}) {
  const { data, error } = await supabase.rpc('intel_list_briefs', {
    p_org_id: orgId, p_limit: limit, p_before_date: cursor?.period_date || null,
    p_before_id: cursor?.id || null, p_before_scope: cursor?.scope || null,
  })
  if (error) throw error
  return paged ? { rows: data?.rows || [], nextCursor: data?.next_cursor || null } : data?.rows || []
}
export async function upsertBrief(supabase, orgId, { briefType = 'daily', periodDate = todayISO(), artifactId = null, status = 'ready' }) {
  const { data, error } = await supabase.rpc('intel_save_personal_brief', {
    p_org_id: orgId, p_brief_type: briefType, p_period_date: periodDate, p_artifact_id: artifactId, p_status: status,
  })
  if (error) throw error; return data
}

// ── Alerts (P10) ──
export async function listAlertRules(supabase, orgId, options = {}) {
  return readHistoryPage(supabase.from('intel_alert_rules').select('*, entity:entities(*)').eq('org_id', orgId), 'created_at', options)
}
export async function createAlertRule(supabase, orgId, userId, r) {
  const { data, error } = await supabase.from('intel_alert_rules').insert({ org_id: orgId, user_id: userId, ...r }).select('*, entity:entities(*)').single()
  if (error) throw error; return data
}
export async function deleteAlertRule(supabase, id) {
  const { error } = await supabase.from('intel_alert_rules').delete().eq('id', id); if (error) throw error
}
// Patch a rule (threshold tuning, per-rule cooldown, clearing the noisy flag).
export async function updateAlertRule(supabase, id, patch, expectedRevision) {
  let query=supabase.from('intel_alert_rules').update(patch).eq('id', id)
  if(expectedRevision!=null)query=query.eq('chart_revision',expectedRevision)
  const { data, error } = await query.select('*, entity:entities(*)').single()
  if (error) throw error
  if(!data)throw Error('The alert changed or is unavailable. Reload it before saving.')
  return data
}
export async function listAlertEvents(supabase, orgId, options = {}) {
  return readHistoryPage(supabase.from('intel_alert_events').select('*, artifact:research_artifacts(*)').eq('org_id', orgId), 'fired_at', options)
}
export async function markChartAlertRead(supabase, orgId, eventId) {
  if (!orgId || !eventId) throw new Error('Choose an alert to mark as read.')
  const { data, error } = await supabase.rpc('intel_mark_chart_alert_read', { p_org: orgId, p_event: eventId })
  if (error || data?.id !== eventId || !Number.isFinite(Date.parse(data?.readAt))) throw new Error('Could not mark this alert as read. Try again.')
  return data
}

// ── Saved research ──
export async function listSavedResearch(supabase, orgId, { page = 0, limit = 30 } = {}) {
  const size = Math.max(1, Math.min(100, Number(limit) || 30)), offset = Math.max(0, Number(page) || 0) * size
  const { data, error } = await supabase.from('saved_research')
    .select('id,title,tags,created_at,artifact_id,private_owner_id,properties:intel_saved_research_properties(label,tags,workflow_state,revision),summary:snapshot->>summary,artifact:research_artifacts(id,title,artifact_type,confidence,created_at)')
    .eq('org_id', orgId).order('created_at', { ascending: false }).order('id', { ascending: false }).range(offset, offset + size - 1)
  if (error) throw error
  if(!Array.isArray(data))throw Error('Saved research could not be read.')
  return data.map(row => ({ ...row, snapshot: { summary: row.summary } }))
}
export async function getSavedResearch(supabase, orgId, id) {
  const { data, error } = await supabase.from('saved_research').select('*,artifact:research_artifacts(*),properties:intel_saved_research_properties(label,tags,workflow_state,revision)').eq('org_id', orgId).eq('id', id).single()
  if (error) throw error
  return data
}
export async function saveResearch(supabase, orgId, userId, { artifactId, title, snapshot = {}, tags = [], privateOwner = false }) {
  const { data, error } = await supabase.from('saved_research').insert({ org_id: orgId, user_id: userId, artifact_id: artifactId, title, snapshot, tags, ...(privateOwner ? { private_owner_id: userId } : {}) }).select('*').single()
  if (error) throw error; return data
}
export async function deleteSavedResearch(supabase, id) {
  const { error } = await supabase.from('saved_research').delete().eq('id', id); if (error) throw error
}
