// Thesis Journal — ongoing monitoring (shared by the cron + on-demand evaluate).
//
// Cache-first, no new providers: assembles the (already-cached) asset pack,
// classifies NEW evidence against the thesis, recomputes a deterministic status
// SUGGESTION (never the user's conclusion) + the quality score, and writes the
// engine fields. Reuses the unit-tested pure engine in ./thesis-evidence.ts.

import { getOrAssembleAssetEvidencePack, type AssetEvidenceSubject } from './asset-evidence-pack.ts'
import { readThesisContextRows } from './thesis-monitor-context.ts'
import {evaluateThesisConditions} from './thesis-conditions.ts'
import { cardsFromAssetPack, classifyEventForThesis, computeThesisStatus, scoreThesisQuality } from './thesis-evidence.ts'

// deno-lint-ignore no-explicit-any
type DB = any
// deno-lint-ignore no-explicit-any
type Any = any
const num = (v: unknown): number | null => { if(v==null||v==='')return null;const n = Number(v); return Number.isFinite(n) ? n : null }

export interface EvaluateResult {
  ok: boolean
  new_evidence: number
  engine_suggested_status: string | null
  quality: number | null
  error?: string
  evidence_version?: string
}

// Evaluate ONE thesis row. Uses the admin/service client (global pack cache +
// per-user evidence rows it sets explicitly). dryRun computes without writing.
export async function evaluateThesis(admin: DB, thesis: Any, opts: { dryRun?: boolean; readPack?: typeof getOrAssembleAssetEvidencePack } = {}): Promise<EvaluateResult> {
  const dryRun = !!opts.dryRun
  const now = new Date().toISOString()
  if (!thesis?.subject_canonical_key) return { ok: false, new_evidence: 0, engine_suggested_status: null, quality: null, error: 'no_subject' }
  const [access,member]=await Promise.all([
    admin.rpc('can_access_intel',{p_user:thesis.user_id,p_org:thesis.org_id}),
    admin.from('org_members').select('org_id').eq('org_id',thesis.org_id).eq('user_id',thesis.user_id).maybeSingle(),
  ])
  if(access.error||member.error)throw new Error('thesis_access_unavailable')
  if(access.data!==true||!member.data)return {ok:false,new_evidence:0,engine_suggested_status:null,quality:null,error:'access_unavailable'}

  const subject: AssetEvidenceSubject = { canonicalKey: thesis.subject_canonical_key, orgId: thesis.org_id, userId: thesis.user_id }
  let packRes = await (opts.readPack||getOrAssembleAssetEvidencePack)(admin, subject, { staleMinutes: 60, allowLiveEnrichment: false })
  let pack = packRes?.pack || {}

  // Existing evidence + scenarios + rules + baseline
  const [existing, scenarios, rules, baseRes] = await Promise.all([
    readThesisContextRows(admin,'intel_thesis_evidence','source_table, source_ref, impact, user_label, impact_source, is_baseline',thesis),
    readThesisContextRows(admin,'intel_thesis_scenarios','kind, probability',thesis),
    readThesisContextRows(admin,'intel_thesis_rules','id,thesis_id,rule_kind,status,description,metric,comparator,threshold,threshold_unit,time_window,source_metric,alert_rule_id',thesis),
    admin.from('intel_thesis_snapshots').select('price_snapshot, benchmark_snapshot').eq('thesis_id', thesis.id).eq('org_id',thesis.org_id).eq('user_id',thesis.user_id).eq('snapshot_kind', 'baseline').maybeSingle(),
  ])
  if(baseRes.error)throw new Error('thesis_context_unavailable')
  const activatedRules=rules.filter((r:Any)=>r.status==='active'&&r.alert_rule_id)
  if(activatedRules.length>50)throw Error('thesis_condition_limit')
  let conditions=activatedRules.length?evaluateThesisConditions(activatedRules,pack,thesis.subject_canonical_key,Date.now()):[]
  // A long-lived narrative pack must not hide newer stored quotes. Refresh the
  // shared assembly once only when an activated condition lacks usable facts.
  // This is a database assembly with live provider enrichment still disabled.
  if(packRes.cached&&conditions.some(condition=>condition.met==null)){
    packRes=await (opts.readPack||getOrAssembleAssetEvidencePack)(admin,subject,{force:true,staleMinutes:1,allowLiveEnrichment:false})
    pack=packRes.pack||{};conditions=evaluateThesisConditions(activatedRules,pack,thesis.subject_canonical_key,Date.now())
  }
  const cards=cardsFromAssetPack(pack,thesis.stance||null)
  for(const condition of conditions){
    if(dryRun)continue
    const result=await admin.rpc('intel_record_thesis_condition',{p_org:thesis.org_id,p_user:thesis.user_id,p_rule:condition.rule.id,p_expected:condition.rule,p_met:condition.met,p_evidence_version:packRes.contentHash,p_observation:condition.observation,p_reason:condition.reason})
    if(result.error||!result.data?.state)throw Error('thesis_condition_save_unavailable')
    if(result.data.state==='triggered')condition.rule.status='triggered'
  }
  const baseline = baseRes.data || null
  const seen = new Set(existing.map((e: Any) => `${e.source_table}|${e.source_ref}`))

  // Classify + stage NEW evidence (engine-labeled, idempotent)
  const newRows: Any[] = []
  for (const c of cards) {
    if (seen.has(`${c.source_table}|${c.source_ref}`)) continue
    const cls = classifyEventForThesis(c, { stance: thesis.stance, scenarios, rules })
    newRows.push({
      org_id: thesis.org_id, user_id: thesis.user_id, thesis_id: thesis.id, visibility: thesis.visibility || 'private',
      source_table: c.source_table, source_ref: c.source_ref, event_type: c.event_type, event_at: c.date,
      event_snapshot: { ...c, evidence_version: packRes.contentHash }, impact: cls.impact, impact_source: 'engine', is_baseline: false,
    })
  }
  let added=newRows.length
  if (!dryRun && newRows.length) {
    const {data,error}=await admin.from('intel_thesis_evidence').upsert(newRows, { onConflict: 'thesis_id,source_table,source_ref', ignoreDuplicates: true }).select('id')
    if(error||!Array.isArray(data))throw new Error('thesis_evidence_save_unavailable')
    added=data.length
  }

  // Evidence counts (non-baseline) for the status engine
  const union = [...existing, ...newRows]
  const count = (pred: (e: Any) => boolean) => union.filter((e) => !e.is_baseline && pred(e)).length
  const evidenceCounts = {
    supports: count((e) => e.impact === 'supports'), weakens: count((e) => e.impact === 'weakens'),
    confirms: count((e) => e.impact === 'confirms'), invalidates: count((e) => e.impact === 'invalidates'),
  }
  const triggeredRules = {
    confirmation: rules.filter((r) => r.rule_kind === 'confirmation' && r.status === 'triggered').length,
    invalidation: rules.filter((r) => r.rule_kind === 'invalidation' && r.status === 'triggered').length,
    totalConfirmation: rules.filter((r) => r.rule_kind === 'confirmation').length,
  }
  const status = computeThesisStatus({
    stance: thesis.stance,
    baselinePrice: num((baseline?.price_snapshot as Any)?.current_price),
    livePrice: num((pack as Any)?.market_summary?.current_price),
    baselineBenchmark: num((baseline?.benchmark_snapshot as Any)?.price),
    liveBenchmark: null, // benchmark live read skipped in the batch pass to stay cache-cheap
    evidenceCounts, triggeredRules,
    lastReviewedAt: thesis.last_reviewed_at, nextReviewAt: thesis.next_review_at,
  })

  const q = scoreThesisQuality({ thesis, scenarios, rules, evidence: union })

  if (!dryRun) {
    const patch: Any = {
      engine_suggested_status: status.engine_suggested_status,
      needs_user_review: status.needs_user_review,
      status_reason: status.status_reason,
      last_status_at: now,
      quality_score: q.score, quality_breakdown: q.breakdown, quality_missing: q.missing, quality_last_checked_at: now,
      last_evaluated_at: now, last_evaluation_error: null, evaluation_error_count: 0, last_evaluation_failed_at: null,
    }
    const {data,error}=await admin.from('intel_theses').update(patch).eq('id', thesis.id).eq('org_id',thesis.org_id).eq('user_id',thesis.user_id).select('id').maybeSingle()
    if(error||!data)throw new Error('thesis_evaluation_save_unavailable')
  }
  return { ok: true, new_evidence: added, engine_suggested_status: status.engine_suggested_status, quality: q.score, evidence_version: packRes.contentHash }
}

// Batch pass for the cron: oldest-evaluated first, error-isolated, dry-run aware.
export async function evalThesisEvidenceBatch(admin: DB, opts: { dryRun?: boolean; limit?: number } = {}): Promise<{ evaluated: number; failed: number; dry_run: boolean }> {
  const dryRun = !!opts.dryRun
  let evaluated = 0, failed = 0
  try {
    const { data: theses,error } = await admin.rpc('intel_thesis_monitor_candidates',{p_limit:Math.max(1, Math.min(opts.limit ?? 50, 200))})
    if(error||!Array.isArray(theses))throw new Error('thesis_candidates_unavailable')
    const active = theses || []
    for (const t of active) {
      try { const result=await evaluateThesis(admin, t, { dryRun });if(result.ok)evaluated++;else if(result.error!=='access_unavailable')failed++ }
      catch (e) {
        failed++
        if (!dryRun) {
          try {
            await admin.from('intel_theses').update({
              last_evaluation_error: String((e as Error)?.message || 'eval_failed').slice(0, 300),
              evaluation_error_count: (t.evaluation_error_count || 0) + 1,
              last_evaluation_failed_at: new Date().toISOString(),
            }).eq('id', t.id)
          } catch { /* failure-state write best-effort */ }
        }
      }
    }
  } catch { failed++ }
  return { evaluated, failed, dry_run: dryRun }
}
