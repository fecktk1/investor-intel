// Investor Intel — Narrative Radar client.
//
// Reads the GLOBAL narrative intelligence layer (per-user ranked) via the
// intel-narratives edge function, and the follow/interaction RPCs. The default
// experience needs NO manual input — loadNarratives returns a ranked global list
// for any user (stronger ranking once they have a watchlist / wallets / follows).

import { attachNarrativeMemberMarkets } from './narrative-member-market'

export async function loadNarratives(supabase, orgId, params = {}) {
  const { data, error } = await supabase.functions.invoke('intel-narratives', { body: { mode: 'feed', orgId, ...params } })
  if (error) throw new Error(error.message || 'narratives_failed')
  if (data?.error) throw new Error(data.error)
  if (!Array.isArray(data?.narratives)) throw new Error('Narrative coverage could not be read.')
  return data // { narratives, summary, count }
}

export async function loadNarrativeDetail(supabase, orgId, slug) {
  const { data, error } = await supabase.functions.invoke('intel-narratives', { body: { mode: 'detail', orgId, slug } })
  if (error) throw new Error(error.message || 'narrative_detail_failed')
  if (data?.error) throw new Error(data.error)
  if (!data?.taxonomy?.id) throw new Error('Narrative details are incomplete. Retry the narrative.')
  return data // { taxonomy, state, drivers, is_followed, brief }
}

export async function loadNarrativeHistory(supabase, slug, days = 30, { withCoverage = false, before } = {}) {
  const { data, error } = await supabase.functions.invoke('intel-narratives', { body: { mode: 'history', slug, days, ...(before ? { before } : {}) } })
  if (error || data?.error) throw new Error(data?.error || error.message || 'Narrative history could not be read.')
  if (!Array.isArray(data?.history)) throw new Error('Narrative history response is incomplete.')
  return withCoverage ? { rows: data.history, coverage: data.historyCoverage || null } : data.history
}

// Real X (Twitter) 7-day chatter velocity for a narrative — the actual "mentions
// +X% vs 7d avg" the X-API collector stores in narrative_signals.raw, read directly
// (authenticated RLS) because the detail RPC's chatter blob prefers the Grok provider
// and usually shadows it. Returns null on miss so the caller hides the line.
export async function loadNarrativeXVelocity(supabase, slug) {
  if (!slug) return null
    const { data: tax, error: taxError } = await supabase.from('narrative_taxonomy').select('id').eq('slug', slug).maybeSingle()
    if (taxError) throw taxError
    if (!tax?.id) return null
    const { data, error } = await supabase.from('narrative_signals')
      .select('raw, fetched_at')
      .eq('narrative_id', tax.id).eq('provider', 'x_api').eq('signal_kind', 'social_chatter')
      .order('fetched_at', { ascending: false }).limit(1).maybeSingle()
    if (error) throw error
    const raw = data?.raw
    if (!raw || raw.velocity_pct == null) return null
    const num = (v) => ((typeof v === 'number' || typeof v === 'string' && v.trim() !== '') && Number.isFinite(Number(v))) ? Number(v) : null
    return { velocity_pct: num(raw.velocity_pct), counts_today: num(raw.counts_today), prior_avg: num(raw.prior_avg), total_7d: num(raw.total_7d), fetched_at: data.fetched_at }
}

// Authenticated shared membership read. A label never becomes a provider ID.
// One bounded page; no market API request and no portfolio download.
export async function loadNarrativeMembers(supabase, narrativeId, page = 0) {
  if (!Number.isInteger(page) || page < 0 || page > 499) throw new Error('Invalid member page.')
  const { data, error } = await supabase.from('narrative_assets')
    .select('id,asset_provider,asset_provider_id,symbol,chain,weight,is_leader,membership_source,updated_at')
    .eq('narrative_id', narrativeId).order('is_leader', { ascending: false })
    .order('weight', { ascending: false }).order('id', { ascending: true }).range(page * 20, page * 20 + 20)
  if (error) throw error
  if (!Array.isArray(data)) throw new Error('Narrative members could not be read.')
  return { rows: await attachNarrativeMemberMarkets(supabase, data.slice(0, 20)), hasMore: data.length > 20, page }
}

export async function loadNarrativeAlertState(supabase, orgId, userId, slug) {
  const { data, error } = await supabase.from('intel_alert_rules').select('id,is_active')
    .eq('org_id', orgId).eq('user_id', userId).eq('trigger_type', 'narrative_heat')
    .eq('config->>slug', slug).eq('is_active', true).limit(1)
  if (error) throw error
  if (!Array.isArray(data)) throw new Error('Narrative alert status could not be read.')
  return data.some(row => row.is_active === true)
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
// Returns the user_followed_narratives row id (a tutorial completion receipt).
// On a re-follow the RPC returns the existing row id without bumping followed_at.
export async function followNarrative(supabase, slug, alertPrefs = {}) {
  const { data, error } = await supabase.rpc('narrative_follow', { p_slug: slug, p_alert_prefs: alertPrefs })
  if (error) throw new Error(error.message || 'follow_failed')
  return data
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
