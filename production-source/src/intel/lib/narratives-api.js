// Investor Intel — Narrative Radar client.
//
// Reads the GLOBAL narrative intelligence layer (per-user ranked) via the
// intel-narratives edge function, and the follow/interaction RPCs. The default
// experience needs NO manual input — loadNarratives returns a ranked global list
// for any user (stronger ranking once they have a watchlist / wallets / follows).

export async function loadNarratives(supabase, orgId, params = {}) {
  const { data, error } = await supabase.functions.invoke('intel-narratives', { body: { mode: 'feed', orgId, ...params } })
  if (error) throw new Error(error.message || 'narratives_failed')
  if (data?.error) throw new Error(data.error)
  return data // { narratives, summary, count }
}

export async function loadNarrativeDetail(supabase, orgId, slug) {
  const { data, error } = await supabase.functions.invoke('intel-narratives', { body: { mode: 'detail', orgId, slug } })
  if (error) throw new Error(error.message || 'narrative_detail_failed')
  if (data?.error) throw new Error(data.error)
  return data // { taxonomy, state, drivers, is_followed, brief }
}

export async function loadNarrativeHistory(supabase, slug, days = 30) {
  try {
    const { data, error } = await supabase.functions.invoke('intel-narratives', { body: { mode: 'history', slug, days } })
    if (error || data?.error) return []
    return data.history || []
  } catch { return [] }
}

// Real X (Twitter) 7-day chatter velocity for a narrative — the actual "mentions
// +X% vs 7d avg" the X-API collector stores in narrative_signals.raw, read directly
// (authenticated RLS) because the detail RPC's chatter blob prefers the Grok provider
// and usually shadows it. Returns null on miss so the caller hides the line.
export async function loadNarrativeXVelocity(supabase, slug) {
  if (!slug) return null
  try {
    const { data: tax } = await supabase.from('narrative_taxonomy').select('id').eq('slug', slug).maybeSingle()
    if (!tax?.id) return null
    const { data } = await supabase.from('narrative_signals')
      .select('raw, fetched_at')
      .eq('narrative_id', tax.id).eq('provider', 'x_api').eq('signal_kind', 'social_chatter')
      .order('fetched_at', { ascending: false }).limit(1).maybeSingle()
    const raw = data?.raw
    if (!raw || raw.velocity_pct == null) return null
    const num = (v) => (v != null && Number.isFinite(Number(v))) ? Number(v) : null
    return { velocity_pct: num(raw.velocity_pct), counts_today: num(raw.counts_today), prior_avg: num(raw.prior_avg), total_7d: num(raw.total_7d), fetched_at: data.fetched_at }
  } catch { return null }
}

// Super-admin only — explainability for tuning.
export async function loadNarrativeDebug(supabase, slug) {
  try {
    const { data, error } = await supabase.functions.invoke('intel-narratives', { body: { mode: 'debug', slug } })
    if (error || data?.error) return null
    return data.debug || null
  } catch { return null }
}

// Follow ATTACHES to an existing global narrative (never creates one).
export async function followNarrative(supabase, slug, alertPrefs = {}) {
  const { error } = await supabase.rpc('narrative_follow', { p_slug: slug, p_alert_prefs: alertPrefs })
  if (error) throw new Error(error.message || 'follow_failed')
}
export async function unfollowNarrative(supabase, slug) {
  const { error } = await supabase.rpc('narrative_unfollow', { p_slug: slug })
  if (error) throw new Error(error.message || 'unfollow_failed')
}

export async function logNarrativeInteraction(supabase, slug, kind = 'open') {
  try { await supabase.rpc('narrative_log_interaction', { p_slug: slug, p_kind: kind }) } catch { /* best-effort */ }
}

// Narrative alerts (reuse intel_alert_rules; the RPC also ensures a follow).
export async function setNarrativeAlert(supabase, slug, prefs = {}) {
  const { error } = await supabase.rpc('narrative_set_alert', { p_slug: slug, p_prefs: prefs })
  if (error) throw new Error(error.message || 'alert_failed')
}
export async function clearNarrativeAlert(supabase, slug) {
  const { error } = await supabase.rpc('narrative_clear_alert', { p_slug: slug })
  if (error) throw new Error(error.message || 'alert_clear_failed')
}

// ── advanced Custom tab — map-to-global FIRST, private only as fallback ──
// Returns { mapped: true, slug } when the text maps to an existing global basket
// (the user should just follow it), else creates a private tracked_narrative.
export async function mapOrCreateCustomNarrative(supabase, orgId, text) {
  const q = String(text || '').trim()
  if (!q) throw new Error('empty')
  // 1) try to map to a global narrative by name / alias (case-insensitive).
  try {
    const { data: matches } = await supabase
      .from('narrative_taxonomy')
      .select('slug, name, parent_category, aliases')
      .in('status', ['active', 'surfaced'])
      .limit(200)
    const lc = q.toLowerCase()
    const hit = (matches || []).find((m) =>
      m.name?.toLowerCase() === lc
      || m.slug === lc.replace(/[^a-z0-9]+/g, '-')
      || (Array.isArray(m.aliases) && m.aliases.some((a) => String(a).toLowerCase() === lc))
      || m.name?.toLowerCase().includes(lc) || lc.includes(m.name?.toLowerCase()))
    if (hit) return { mapped: true, slug: hit.slug, name: hit.name }
  } catch { /* fall through to private create */ }

  // 2) no clean map → create a private custom narrative (org-scoped, advanced).
  const slug = q.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  const { error } = await supabase.from('tracked_narratives').upsert(
    { org_id: orgId, slug, title: q }, { onConflict: 'org_id,slug', ignoreDuplicates: true })
  if (error) throw new Error(error.message || 'custom_create_failed')
  return { mapped: false, slug, title: q }
}

export async function listCustomNarratives(supabase, orgId) {
  const { data } = await supabase.from('tracked_narratives').select('*').eq('org_id', orgId).order('created_at', { ascending: false })
  return data || []
}
