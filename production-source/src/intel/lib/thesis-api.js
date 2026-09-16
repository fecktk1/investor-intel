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
import { assertThesisActivation } from './thesis-activation'

const operationIds = new WeakMap()
function operationId(payload) {
  if (payload?.idempotency_key) return payload.idempotency_key
  if (!operationIds.has(payload)) operationIds.set(payload, crypto.randomUUID())
  return operationIds.get(payload)
}

function notifyActivityChanged(orgId, thesisId = null) {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('intel:thesis-activity-changed', { detail: { orgId, thesisId } }))
}

async function invokeThesis(supabase, body) {
  const { data, error } = await supabase.functions.invoke('intel-thesis', { body })
  if (error) throw error
  if (data && data.error) {
    // The code stays the message (existing callers read it), and a refusal keeps
    // what it refused: the coach names the figures it could not ground.
    const failure = new Error(data.error)
    failure.code = data.error
    if (Array.isArray(data.ungrounded)) failure.ungrounded = data.ungrounded
    throw failure
  }
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

// Only summary fields for the visible journal page. Authored words and evidence
// retain their existing, authorized detail reads.
export async function listThesesPage(supabase, orgId, { status='', q='', page=0, limit=20 } = {}) {
  if(!orgId)throw Error('A workspace is required to read the journal.')
  const size=Math.max(1,Math.min(100,Math.trunc(Number(limit)||20))),index=Math.max(0,Math.min(10000,Math.trunc(Number(page)||0)))
  let query=supabase.from('intel_theses').select('id,title,subject_canonical_key,thesis_type,stance,status,conviction,time_horizon,next_review_at,thesis_date,created_at,needs_user_review,quality_score,visibility,user_id')
    .eq('org_id',orgId).order('created_at',{ascending:false}).order('id',{ascending:false})
  if(status)query=query.eq('status',status)
  const search=String(q).trim().slice(0,200)
  if(search)query=query.ilike('title',`%${search.replace(/[\\%_]/g,'\\$&')}%`)
  const {data,error}=await query.range(index*size,index*size+size)
  if(error)throw error
  return {rows:(data||[]).slice(0,size),hasMore:(data||[]).length>size,page:index}
}

export async function getThesis(supabase, orgId, id) {
  const base = supabase.from('intel_theses').select('*, entity:entities(id, display_symbol, native_symbol, canonical_ref_key, entity_kind, asset_type, chain_namespace, chain_id, contract_address)').eq('id', id).eq('org_id', orgId).single()
  const [thesis, scenarios, rules, evidence, reviews, snapshots] = await Promise.all([
    base,
    supabase.from('intel_thesis_scenarios').select('*').eq('thesis_id', id).order('ordinal', { ascending: true }),
    supabase.from('intel_thesis_rules').select('*').eq('thesis_id', id).order('created_at', { ascending: true }),
    supabase.from('intel_thesis_evidence').select('*').eq('thesis_id', id).order('event_at', { ascending: false }),
    supabase.from('intel_thesis_reviews').select('*, artifact:research_artifacts(*)').eq('thesis_id', id).order('created_at', { ascending: false }),
    supabase.rpc('intel_thesis_snapshot_context',{p_org_id:orgId,p_thesis_id:id}),
  ])
  if (thesis.error) throw thesis.error
  if ([scenarios,rules,evidence,reviews,snapshots].some(result=>result.error)) throw new Error('Part of this thesis could not be loaded. Please retry to view its complete research history.')
  return {
    ...thesis.data,
    scenarios: scenarios.data || [],
    rules: rules.data || [],
    evidence: evidence.data || [],
    reviews: reviews.data || [],
    snapshots: snapshots.data?.rows || [],
    snapshotCursor: snapshots.data?.next_cursor || null,
    baseline: snapshots.data?.baseline || null,
  }
}

// Atomic create + immutable baseline via the edge fn (assembles the pack first).
export async function getThesisRecordedEvidence(supabase, orgId, thesisId) {
  return invokeThesis(supabase, { action: 'recorded_evidence', orgId, thesisId })
}

export async function createThesis(supabase, orgId, payload) {
  assertThesisActivation(payload)
  const data = await invokeThesis(supabase, { action: 'create', orgId, payload })
  notifyActivityChanged(orgId, data?.thesis_id)
  return data
}

export async function updateThesis(supabase, id, patch) {
  const { data, error } = await supabase.from('intel_theses').update(patch).eq('id', id).select('*').single()
  if (error) throw error
  notifyActivityChanged(data.org_id, id)
  return data
}

export async function deleteThesis(supabase, id) {
  const { data, error } = await supabase.from('intel_theses').delete().eq('id', id).select('org_id').maybeSingle()
  if (error) throw error
  if (data) notifyActivityChanged(data.org_id, id)
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
  const data = await invokeThesis(supabase, { action: 'resolve_status', orgId, thesisId, decision })
  notifyActivityChanged(orgId, thesisId)
  return data
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
  notifyActivityChanged(orgId, thesisId)
  return data
}
export async function updateScenario(supabase, id, patch) {
  const { data, error } = await supabase.from('intel_thesis_scenarios').update(patch).eq('id', id).select('*').single()
  if (error) throw error
  notifyActivityChanged(data.org_id, data.thesis_id)
  return data
}
export async function deleteScenario(supabase, id) {
  const { data, error } = await supabase.from('intel_thesis_scenarios').delete().eq('id', id).select('org_id, thesis_id').maybeSingle()
  if (error) throw error
  if (data) notifyActivityChanged(data.org_id, data.thesis_id)
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
  if (error) {
    if(error.code==='23505'&&r.id){
      const previous=await supabase.from('intel_thesis_rules').select('*').eq('id',r.id).eq('org_id',orgId).eq('user_id',userId).eq('thesis_id',thesisId).maybeSingle()
      if(!previous.error&&previous.data&&Object.entries(r).filter(([key])=>!['id','status'].includes(key)).every(([key,value])=>JSON.stringify(previous.data[key])===JSON.stringify(value)))return previous.data
    }
    throw error
  }
  notifyActivityChanged(orgId, thesisId)
  return data
}
export async function deleteRule(supabase, id) {
  const { data, error } = await supabase.from('intel_thesis_rules').delete().eq('id', id).select('org_id, thesis_id').maybeSingle()
  if (error) throw error
  if (data) notifyActivityChanged(data.org_id, data.thesis_id)
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
  notifyActivityChanged(orgId, thesisId)
  return data || []
}
export async function updateEvidence(supabase, id, patch) {
  const { data, error } = await supabase.from('intel_thesis_evidence').update({ ...patch, impact_source: patch.impact_source || 'user' }).eq('id', id).select('*').single()
  if (error) throw error
  notifyActivityChanged(data.org_id, data.thesis_id)
  return data
}
export async function removeEvidence(supabase, id) {
  const { data, error } = await supabase.from('intel_thesis_evidence').delete().eq('id', id).select('org_id, thesis_id').maybeSingle()
  if (error) throw error
  if (data) notifyActivityChanged(data.org_id, data.thesis_id)
}

// ── Reviews ─────────────────────────────────────────────────
export async function listReviews(supabase, thesisId) {
  const { data, error } = await supabase.from('intel_thesis_reviews').select('*, artifact:research_artifacts(*)').eq('thesis_id', thesisId).order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}
export async function createReview(supabase, orgId, userId, thesisId, r) {
  // The RPC derives the author from auth.uid(), and commits the note and every
  // requested state change together. The argument remains for existing callers.
  const { idempotency_key: _key, ...review } = r
  const { data, error } = await supabase.rpc('intel_save_thesis_review', {
    p_org_id: orgId, p_thesis_id: thesisId, p_review: review, p_operation_id: operationId(r),
  })
  if (error) throw error
  notifyActivityChanged(orgId, thesisId)
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
  notifyActivityChanged(orgId, data.thesis_id)
  return data
}
export async function updateTrade(supabase, id, patch) {
  const { data, error } = await supabase.from('intel_trades').update(patch).eq('id', id).select('*').single()
  if (error) throw error
  notifyActivityChanged(data.org_id, data.thesis_id)
  return data
}
export async function deleteTrade(supabase, id) {
  const { data, error } = await supabase.from('intel_trades').delete().eq('id', id).select('org_id, thesis_id').maybeSingle()
  if (error) throw error
  if (data) notifyActivityChanged(data.org_id, data.thesis_id)
}
export async function createTradeReview(supabase, orgId, userId, tradeId, r) {
  const { data, error } = await supabase.from('intel_trade_reviews').insert({ org_id: orgId, user_id: userId, trade_id: tradeId, ...r }).select('*').single()
  if (error) throw error
  notifyActivityChanged(orgId)
  return data
}

// Journal an exit and its original review in one transaction, with a reusable
// operation id so a retry after an uncertain response cannot duplicate history.
export async function closeTradeWithReview(supabase, orgId, tradeId, payload) {
  const { data, error } = await supabase.rpc('intel_close_trade_with_review', {
    p_org_id: orgId, p_trade_id: tradeId, p_trade: payload.trade,
    p_review: payload.review, p_operation_id: operationId(payload),
  })
  if (error) throw error
  notifyActivityChanged(orgId, data?.trade?.thesis_id)
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
export async function getThesisDraft(supabase, orgId, { basics, cards, evidenceVersion, evidenceSubject }) {
  return invokeThesis(supabase, { action: 'draft', orgId, basics, cards, evidenceVersion, evidenceSubject })
}
export async function getThesisCritique(supabase, orgId, { basics, cards, draft, evidenceVersion, evidenceSubject }) {
  return invokeThesis(supabase, { action: 'critique', orgId, basics, cards, draft, evidenceVersion, evidenceSubject })
}
export async function captureBaseline(supabase, orgId, thesisId) {
  return invokeThesis(supabase, { action: 'capture_baseline', orgId, thesisId })
}
// Re-run the monitoring pass for one thesis (classify new evidence + recompute
// engine status suggestion + quality). Same logic the 6h cron runs in batch.
export async function evaluateThesisNow(supabase, orgId, thesisId) {
  return invokeThesis(supabase, { action: 'evaluate', orgId, thesisId })
}
export async function previewThesisEvaluation(supabase, orgId, thesisId) {
  return invokeThesis(supabase, { action: 'evaluate', orgId, thesisId, dryRun: true })
}

// Analytics read RPCs (structural; price-perf enriched by the analytics edge fn in E7).
export async function getThesisAnalytics(supabase, { since = null, orgId = null } = {}) {
  const { data, error } = await supabase.rpc(orgId?'intel_thesis_analytics_scoped':'intel_thesis_analytics', { p_since: since,...(orgId?{p_org:orgId}:{}) })
  if (error) throw error
  if(!data||typeof data.count_by_status!=='object')throw Error('Thesis analytics response was incomplete. Retry this read.')
  return data
}
export async function getTradeAnalytics(supabase, { scope = 'all', scopeKey = null, since = null, orgId = null } = {}) {
  const { data, error } = await supabase.rpc(orgId?'intel_trade_analytics_scoped':'intel_trade_analytics', { p_scope: scope, p_scope_key: scopeKey, p_since: since,...(orgId?{p_org:orgId}:{}) })
  if (error) throw error
  if(!data||data.closed_trades==null)throw Error('Journal analytics response was incomplete. Retry this read.')
  return data
}
export async function getPortfolioThesisConflicts(supabase, portfolioId) {
  const { data, error } = await supabase.rpc('intel_portfolio_thesis_conflicts', { p_portfolio_id: portfolioId })
  if (error) throw error
  return data || {}
}

const EVENT_PRESENTATION = {
  thesis_created: ['thesis', 'Thesis created'], thesis_updated: ['review', 'Thesis updated'],
  thesis_reviewed: ['review', 'Thesis reviewed'], thesis_review_updated: ['review', 'Review updated'],
  thesis_status_changed: ['review', 'Thesis status changed'], thesis_closed: ['review', 'Thesis closed'],
  thesis_reopened: ['review', 'Thesis reopened'], thesis_archived: ['review', 'Thesis archived'], thesis_restored: ['review', 'Thesis restored'],
  engine_suggestion: ['review', 'System suggestion'], rule_confirmed: ['confirm', 'Confirmation rule triggered'], rule_invalidated: ['invalidate', 'Invalidation rule triggered'],
  rule_changed: ['review', 'Thesis rule changed'], evidence_changed: ['review', 'Evidence changed'], scenario_changed: ['review', 'Scenario changed'],
  trade_planned: ['trade', 'Trade plan recorded'], trade_updated: ['trade', 'Trade updated'], trade_entered: ['entry', 'Trade entry recorded'],
  trade_exited: ['exit', 'Trade exit recorded'], trade_partial_exit: ['exit', 'Partial exit recorded'], trade_cancelled: ['trade', 'Trade cancelled'],
  trade_reviewed: ['review', 'Trade reviewed'], trade_review_updated: ['review', 'Trade review updated'],
}

export function thesisActivityToMarker(event) {
  const [type, label] = EVENT_PRESENTATION[event.event_kind] || ['review', event.event_kind.replaceAll('_', ' ')]
  const words = event.text_snapshot || {}
  return {
    id: event.id, t: Date.parse(event.occurred_at), type, label,
    eventKind: event.event_kind, thesisId: event.thesis_id, tradeId: event.trade_id,
    entityId: event.entity_id, canonicalKey: event.canonical_key, title: event.title_snapshot,
    note: words.note || words.lesson || words.pre_notes || words.rationale || null,
    textSnapshot: words, sourceSnapshot: event.source_snapshot || null, changes: event.changes || {},
    occurredAt: event.occurred_at, recordedAt: event.recorded_at,
    actorKind: event.actor_kind, operationId: event.operation_id,
    historicalCompleteness: event.historical_completeness,
    source: { table: event.source_table, id: event.source_id },
    linkedSourceRef: event.linked_source_ref || null,
    group: event.trade_id ? 'trade' : 'thesis',
  }
}

// Page by canonical identity and the visible time window. An explicit thesisId
// preserves org-shared thesis viewing; ordinary asset queries return only mine.
// Errors stay errors so the UI never mistakes missing deployment for no history.
export async function getAssetThesisMarkers(supabase, orgId, { entityId = null, canonicalKey = null, thesisId = null, from = null, to = null, limit = 200, cursor = null } = {}) {
  if (!orgId || (!entityId && !canonicalKey && !thesisId)) return { markers: [], nextCursor: null, historicalCoverage: null }
  const asIso = (value) => value == null ? null : new Date(value).toISOString()
  const { data, error } = await supabase.rpc('intel_asset_thesis_activity', {
    p_org_id: orgId, p_entity_id: entityId, p_canonical_key: canonicalKey, p_thesis_id: thesisId,
    p_from: asIso(from), p_to: asIso(to), p_limit: Math.max(1, Math.min(500, Math.floor(Number(limit) || 200))),
    p_before_at: cursor?.occurred_at || null, p_before_id: cursor?.id || null,
  })
  if (error) throw error
  return {
    markers: (data?.events || []).map(thesisActivityToMarker).filter((m) => Number.isFinite(m.t)),
    nextCursor: data?.next_cursor || null, historicalCoverage: data?.historical_coverage || null,
  }
}

// Compatibility for old symbol callers: resolve exactly one existing entity.
// Ambiguous tickers cannot silently merge unrelated assets or chains.
export async function thesisMarkersForSymbol(supabase, orgId, symbol) {
  const sym = String(symbol || '').toUpperCase().replace(/^\$/, '')
  if (!orgId || !/^[A-Z0-9._-]{1,32}$/.test(sym)) return []
  const { data, error } = await supabase.from('entities').select('id, canonical_ref_key')
    .or(`display_symbol.eq.${sym},native_symbol.eq.${sym}`).limit(2)
  if (error) throw error
  if (!data?.length) return []
  if (data.length !== 1) throw new Error('Select the exact asset to show personal thesis history.')
  return (await getAssetThesisMarkers(supabase, orgId, { entityId: data[0].id })).markers
}

// Re-export legacy alert-rule helper for rule materialization callers.
export { createAlertRule }
export async function listAssetTheses(supabase, orgId, { canonicalKey = null, entityId = null, cursor = null, limit = 30 } = {}) {
  const { data, error } = await supabase.rpc('intel_list_asset_theses', {
    p_org_id: orgId, p_canonical_key: canonicalKey, p_entity_id: entityId, p_limit: limit,
    p_before_at: cursor?.at || null, p_before_id: cursor?.id || null,
  })
  if (error) throw error
  return { rows: data?.rows || [], nextCursor: data?.next_cursor || null }
}
