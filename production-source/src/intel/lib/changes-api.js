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
export async function markSurfaceSeen(supabase, surface, subjectKey = '') {
  if (!surface) return
  try { await supabase.rpc('mark_surface_seen', { p_surface: surface, p_subject_key: subjectKey || '' }) } catch { /* ignore */ }
}
