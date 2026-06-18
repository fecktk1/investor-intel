// Investor Intel — Thesis Journal data layer.
//
// Personal-by-default: RLS scopes every read to the caller (own rows, or same-org
// rows explicitly shared as 'org'); writes are owner-only. Inserts therefore set
// org_id + user_id explicitly (RLS WITH CHECK requires them).
//
// Reads/simple writes hit the tables directly. The trust-critical paths — atomic
// create + immutable baseline, the Asset Context Pack, the since-creation delta,
// the quality score, accept-rule, and engine-status resolution — all go through
// the `intel-thesis` edge function (single assembly path; no client compose).
//
// Legacy CRUD (listTheses/createThesis/deleteThesis) lives in ./intel-data.js and
// still backs the fallback ThesisPage; this module supersedes it for the Journal.

import { createAlertRule } from './intel-data'

async function invokeThesis(supabase, body) {
  const { data, error } = await supabase.functions.invoke('intel-thesis', { body })
  if (error) throw error
  if (data && data.error) throw new Error(data.error)
  return data
}

// ── Theses ──────────────────────────────────────────────────
export async function listTheses(supabase, orgId, { status, entityId, thesisType, q } = {}) {
  let qb = supabase.from('intel_theses').select('*').eq('org_id', orgId)
  if (status) qb = Array.isArray(status) ? qb.in('status', status) : qb.eq('status', status)
  if (entityId) qb = qb.eq('entity_id', entityId)
  if (thesisType) qb = qb.eq('thesis_type', thesisType)
  if (q) qb = qb.ilike('title', `%${q}%`)
  const { data, error } = await qb.order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

export async function getThesis(supabase, orgId, id) {
  const base = supabase.from('intel_theses').select('*').eq('id', id).eq('org_id', orgId).single()
  const [thesis, scenarios, rules, evidence, reviews, snapshots] = await Promise.all([
    base,
    supabase.from('intel_thesis_scenarios').select('*').eq('thesis_id', id).order('ordinal', { ascending: true }),
    supabase.from('intel_thesis_rules').select('*').eq('thesis_id', id).order('created_at', { ascending: true }),
    supabase.from('intel_thesis_evidence').select('*').eq('thesis_id', id).order('event_at', { ascending: false }),
    supabase.from('intel_thesis_reviews').select('*, artifact:research_artifacts(*)').eq('thesis_id', id).order('created_at', { ascending: false }),
    supabase.from('intel_thesis_snapshots').select('*').eq('thesis_id', id).order('captured_at', { ascending: false }),
  ])
  if (thesis.error) throw thesis.error
  return {
    ...thesis.data,
    scenarios: scenarios.data || [],
    rules: rules.data || [],
    evidence: evidence.data || [],
    reviews: reviews.data || [],
    snapshots: snapshots.data || [],
    baseline: (snapshots.data || []).find((s) => s.snapshot_kind === 'baseline') || null,
  }
}

// Atomic create + immutable baseline via the edge fn (assembles the pack first).
export async function createThesis(supabase, orgId, payload) {
  return invokeThesis(supabase, { action: 'create', orgId, payload })
}

export async function updateThesis(supabase, id, patch) {
  const { data, error } = await supabase.from('intel_theses').update(patch).eq('id', id).select('*').single()
  if (error) throw error
  return data
}

export async function deleteThesis(supabase, id) {
  const { error } = await supabase.from('intel_theses').delete().eq('id', id)
  if (error) throw error
}

// User-authoritative status change (sets status_source='user', clears the engine flag).
export async function setThesisStatus(supabase, id, status, extra = {}) {
  return updateThesis(supabase, id, {
    status, status_source: 'user', needs_user_review: false,
    ...(status === 'closed' ? { closed_at: new Date().toISOString() } : {}),
    ...extra,
  })
}

// Resolve an engine suggestion: decision = 'accept' | 'keep' | 'revise'.
export async function resolveEngineStatus(supabase, orgId, thesisId, decision) {
  return invokeThesis(supabase, { action: 'resolve_status', orgId, thesisId, decision })
}

// ── Scenarios ───────────────────────────────────────────────
export async function listScenarios(supabase, thesisId) {
  const { data, error } = await supabase.from('intel_thesis_scenarios').select('*').eq('thesis_id', thesisId).order('ordinal', { ascending: true })
  if (error) throw error
  return data || []
}
export async function createScenario(supabase, orgId, userId, thesisId, s) {
  const { data, error } = await supabase.from('intel_thesis_scenarios')
    .insert({ org_id: orgId, user_id: userId, thesis_id: thesisId, ...s })
    .select('*').single()
  if (error) throw error
  return data
}
export async function updateScenario(supabase, id, patch) {
  const { data, error } = await supabase.from('intel_thesis_scenarios').update(patch).eq('id', id).select('*').single()
  if (error) throw error
  return data
}
export async function deleteScenario(supabase, id) {
  const { error } = await supabase.from('intel_thesis_scenarios').delete().eq('id', id)
  if (error) throw error
}

// ── Rules (confirmation / invalidation → become alert rules) ─
export async function listRules(supabase, thesisId) {
  const { data, error } = await supabase.from('intel_thesis_rules').select('*').eq('thesis_id', thesisId).order('created_at', { ascending: true })
  if (error) throw error
  return data || []
}
export async function createRule(supabase, orgId, userId, thesisId, r) {
  const { data, error } = await supabase.from('intel_thesis_rules')
    .insert({ org_id: orgId, user_id: userId, thesis_id: thesisId, ...r })
    .select('*').single()
  if (error) throw error
  return data
}
export async function deleteRule(supabase, id) {
  const { error } = await supabase.from('intel_thesis_rules').delete().eq('id', id)
  if (error) throw error
}
// Materialize a rule into a live alert rule (edge fn links rule ↔ alert).
export async function acceptRule(supabase, orgId, ruleId) {
  return invokeThesis(supabase, { action: 'accept_rule', orgId, ruleId })
}

// ── Evidence (link + frozen snapshot + labels) ──────────────
export async function listEvidence(supabase, thesisId, { impact, isBaseline } = {}) {
  let qb = supabase.from('intel_thesis_evidence').select('*').eq('thesis_id', thesisId)
  if (impact) qb = qb.eq('impact', impact)
  if (isBaseline != null) qb = qb.eq('is_baseline', isBaseline)
  const { data, error } = await qb.order('event_at', { ascending: false })
  if (error) throw error
  return data || []
}
// Bulk-attach selected evidence cards to a thesis.
export async function attachEvidence(supabase, orgId, userId, thesisId, items = []) {
  if (!items.length) return []
  const rows = items.map((it) => ({ org_id: orgId, user_id: userId, thesis_id: thesisId, ...it }))
  const { data, error } = await supabase.from('intel_thesis_evidence').insert(rows).select('*')
  if (error) throw error
  return data || []
}
export async function updateEvidence(supabase, id, patch) {
  const { data, error } = await supabase.from('intel_thesis_evidence').update({ ...patch, impact_source: patch.impact_source || 'user' }).eq('id', id).select('*').single()
  if (error) throw error
  return data
}
export async function removeEvidence(supabase, id) {
  const { error } = await supabase.from('intel_thesis_evidence').delete().eq('id', id)
  if (error) throw error
}

// ── Reviews ─────────────────────────────────────────────────
export async function listReviews(supabase, thesisId) {
  const { data, error } = await supabase.from('intel_thesis_reviews').select('*, artifact:research_artifacts(*)').eq('thesis_id', thesisId).order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}
export async function createReview(supabase, orgId, userId, thesisId, r) {
  const { data, error } = await supabase.from('intel_thesis_reviews')
    .insert({ org_id: orgId, user_id: userId, thesis_id: thesisId, ...r })
    .select('*').single()
  if (error) throw error
  return data
}

// ── Trades (research journal only — never executes) ─────────
export async function listTrades(supabase, orgId, { thesisId, status, portfolioId } = {}) {
  let qb = supabase.from('intel_trades').select('*').eq('org_id', orgId)
  if (thesisId) qb = qb.eq('thesis_id', thesisId)
  if (portfolioId) qb = qb.eq('portfolio_id', portfolioId)
  if (status) qb = Array.isArray(status) ? qb.in('status', status) : qb.eq('status', status)
  const { data, error } = await qb.order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}
export async function getTrade(supabase, id) {
  const [trade, reviews] = await Promise.all([
    supabase.from('intel_trades').select('*').eq('id', id).single(),
    supabase.from('intel_trade_reviews').select('*').eq('trade_id', id).order('created_at', { ascending: false }),
  ])
  if (trade.error) throw trade.error
  return { ...trade.data, reviews: reviews.data || [] }
}
export async function createTradePlan(supabase, orgId, userId, t) {
  const { data, error } = await supabase.from('intel_trades').insert({ org_id: orgId, user_id: userId, ...t }).select('*').single()
  if (error) throw error
  return data
}
export async function updateTrade(supabase, id, patch) {
  const { data, error } = await supabase.from('intel_trades').update(patch).eq('id', id).select('*').single()
  if (error) throw error
  return data
}
export async function deleteTrade(supabase, id) {
  const { error } = await supabase.from('intel_trades').delete().eq('id', id)
  if (error) throw error
}
export async function createTradeReview(supabase, orgId, userId, tradeId, r) {
  const { data, error } = await supabase.from('intel_trade_reviews').insert({ org_id: orgId, user_id: userId, trade_id: tradeId, ...r }).select('*').single()
  if (error) throw error
  return data
}

// ── Edge-fn / RPC backed (single assembly path) ─────────────
export async function getAssetContextPack(supabase, orgId, subject) {
  return invokeThesis(supabase, { action: 'context', orgId, subject })
}
export async function getThesisDelta(supabase, orgId, thesisId) {
  return invokeThesis(supabase, { action: 'delta', orgId, thesisId })
}
export async function getThesisQuality(supabase, orgId, payload) {
  return invokeThesis(supabase, { action: 'quality', orgId, payload })
}
// AI coach (single-model, cost-capped, non-advice) — drafts + critiques.
export async function getThesisDraft(supabase, orgId, { basics, cards }) {
  return invokeThesis(supabase, { action: 'draft', orgId, basics, cards })
}
export async function getThesisCritique(supabase, orgId, { basics, cards, draft }) {
  return invokeThesis(supabase, { action: 'critique', orgId, basics, cards, draft })
}
export async function captureBaseline(supabase, orgId, thesisId) {
  return invokeThesis(supabase, { action: 'capture_baseline', orgId, thesisId })
}
// Re-run the monitoring pass for one thesis (classify new evidence + recompute
// engine status suggestion + quality). Same logic the 6h cron runs in batch.
export async function evaluateThesisNow(supabase, orgId, thesisId) {
  return invokeThesis(supabase, { action: 'evaluate', orgId, thesisId })
}

// Analytics read RPCs (structural; price-perf enriched by the analytics edge fn in E7).
export async function getThesisAnalytics(supabase, { since = null } = {}) {
  const { data, error } = await supabase.rpc('intel_thesis_analytics', { p_since: since })
  if (error) throw error
  return data || {}
}
export async function getTradeAnalytics(supabase, { scope = 'all', scopeKey = null, since = null } = {}) {
  const { data, error } = await supabase.rpc('intel_trade_analytics', { p_scope: scope, p_scope_key: scopeKey, p_since: since })
  if (error) throw error
  return data || {}
}
export async function getPortfolioThesisConflicts(supabase, portfolioId) {
  const { data, error } = await supabase.rpc('intel_portfolio_thesis_conflicts', { p_portfolio_id: portfolioId })
  if (error) throw error
  return data || {}
}

// Per-user chart markers for an asset symbol: thesis-created, reviews, and trade
// entry/exit for the caller's own theses on this asset. RLS scopes everything to
// the caller, so markers never appear on another user's chart.
export async function thesisMarkersForSymbol(supabase, orgId, symbol) {
  const sym = String(symbol || '').toUpperCase().replace(/^\$/, '')
  if (!orgId || !sym) return []
  const keySym = (k) => String(k || '').split(/[:/]/).pop().toUpperCase()
  const { data: theses } = await supabase.from('intel_theses')
    .select('id, status, created_at, subject_canonical_key, entity:entities(display_symbol, native_symbol)')
    .eq('org_id', orgId).neq('status', 'archived')
  const mine = (theses || []).filter((th) =>
    String(th.entity?.display_symbol || '').toUpperCase() === sym ||
    String(th.entity?.native_symbol || '').toUpperCase() === sym ||
    keySym(th.subject_canonical_key) === sym)
  if (!mine.length) return []
  const ids = mine.map((th) => th.id)
  const markers = mine.filter((th) => th.created_at).map((th) => ({ t: Date.parse(th.created_at), type: 'thesis', label: 'Thesis' }))
  const [revRes, trRes] = await Promise.all([
    supabase.from('intel_thesis_reviews').select('created_at, thesis_id').in('thesis_id', ids),
    supabase.from('intel_trades').select('opened_at, closed_at, direction, thesis_id').in('thesis_id', ids),
  ])
  for (const r of (revRes.data || [])) if (r.created_at) markers.push({ t: Date.parse(r.created_at), type: 'review', label: 'Review' })
  for (const tr of (trRes.data || [])) {
    if (tr.opened_at) markers.push({ t: Date.parse(tr.opened_at), type: ['short', 'spot_reduce'].includes(tr.direction) ? 'sell' : 'entry', label: 'Entry' })
    if (tr.closed_at) markers.push({ t: Date.parse(tr.closed_at), type: 'exit', label: 'Exit' })
  }
  return markers.filter((m) => m.t)
}

// Re-export legacy alert-rule helper for rule materialization callers.
export { createAlertRule }
