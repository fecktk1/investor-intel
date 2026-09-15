// Investor Intel — "What changed since last visit" client (Phase 1).
// Deterministic change summaries + per-surface last-seen. Both are tiny RPCs that
// read only stored data — no new fetches, no AI.

export async function loadWhatChanged(supabase, surface, since = null) {
  if (!surface) return []
  const { data, error } = await supabase.rpc('what_changed', { p_surface: surface, p_since: since })
  if (error) throw error
  return data || []
}

// Best-effort: marking a surface seen must never break a page.
export async function loadWhatChangedContext(supabase, { orgId, userId, surface, since = null }) {
  if (!orgId || !surface) throw new Error('Workspace and surface required')
  const { data, error } = await supabase.rpc('intel_what_changed_context', {
    p_org_id: orgId, p_user_id: userId || null, p_surface: surface, p_since: since,
  })
  if (error) throw error
  return data
}

export async function markSurfaceSeen(supabase, surface, subjectKey = '', context = {}) {
  if (!surface) return
  try {
    const { error } = context.orgId
      ? await supabase.rpc('intel_mark_surface_seen', {
        p_org_id: context.orgId, p_user_id: context.userId || null,
        p_surface: surface, p_subject_key: subjectKey || '', p_observed_at: context.observedAt || null,
      })
      : await supabase.rpc('mark_surface_seen', { p_surface: surface, p_subject_key: subjectKey || '' })
    return !error
  } catch { return false }
}
