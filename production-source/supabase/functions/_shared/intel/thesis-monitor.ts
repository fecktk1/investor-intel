// Thesis Journal — ongoing monitoring (shared by the cron + on-demand evaluate).
//
// Cache-first, no new providers: assembles the (already-cached) asset pack,
// classifies NEW evidence against the thesis, recomputes a deterministic status
// SUGGESTION (never the user's conclusion) + the quality score, and writes the
// engine fields. Reuses the unit-tested pure engine in ./thesis-evidence.ts.

import { getOrAssembleAssetEvidencePack, type AssetEvidenceSubject } from './asset-evidence-pack.ts'
import { cardsFromAssetPack, classifyEventForThesis, computeThesisStatus, scoreThesisQuality } from './thesis-evidence.ts'

// deno-lint-ignore no-explicit-any
type DB = any
// deno-lint-ignore no-explicit-any
type Any = any
const num = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) ? n : null }

export interface EvaluateResult {
  ok: boolean
  new_evidence: number
  engine_suggested_status: string | null
  quality: number | null
  error?: string
}

// Evaluate ONE thesis row. Uses the admin/service client (global pack cache +
// per-user evidence rows it sets explicitly). dryRun computes without writing.
export async function evaluateThesis(admin: DB, thesis: Any, opts: { dryRun?: boolean } = {}): Promise<EvaluateResult> {
  const dryRun = !!opts.dryRun
  const now = new Date().toISOString()
  if (!thesis?.subject_canonical_key) return { ok: false, new_evidence: 0, engine_suggested_status: null, quality: null, error: 'no_subject' }

  const subject: AssetEvidenceSubject = { canonicalKey: thesis.subject_canonical_key, orgId: thesis.org_id, userId: thesis.user_id }
  const packRes = await getOrAssembleAssetEvidencePack(admin, subject, { staleMinutes: 60 })
  const pack = packRes?.pack || {}
  const cards = cardsFromAssetPack(pack, thesis.stance || null)

  // Existing evidence + scenarios + rules + baseline
  const [evRes, scRes, rlRes, baseRes] = await Promise.all([
    admin.from('intel_thesis_evidence').select('source_table, source_ref, impact, user_label, impact_source, is_baseline').eq('thesis_id', thesis.id),
    admin.from('intel_thesis_scenarios').select('kind, probability').eq('thesis_id', thesis.id),
    admin.from('intel_thesis_rules').select('id, rule_kind, status, metric, comparator, threshold').eq('thesis_id', thesis.id),
    admin.from('intel_thesis_snapshots').select('price_snapshot, benchmark_snapshot').eq('thesis_id', thesis.id).eq('snapshot_kind', 'baseline').maybeSingle(),
  ])
  const existing: Any[] = evRes.data || []
  const scenarios: Any[] = scRes.data || []
  const rules: Any[] = rlRes.data || []
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
      event_snapshot: c, impact: cls.impact, impact_source: 'engine', is_baseline: false,
    })
  }
  if (!dryRun && newRows.length) {
    try { await admin.from('intel_thesis_evidence').upsert(newRows, { onConflict: 'thesis_id,source_table,source_ref', ignoreDuplicates: true }) } catch { /* race backstop */ }
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
    await admin.from('intel_theses').update(patch).eq('id', thesis.id)
  }
  return { ok: true, new_evidence: newRows.length, engine_suggested_status: status.engine_suggested_status, quality: q.score }
}

// Batch pass for the cron: oldest-evaluated first, error-isolated, dry-run aware.
export async function evalThesisEvidenceBatch(admin: DB, opts: { dryRun?: boolean; limit?: number } = {}): Promise<{ evaluated: number; failed: number; dry_run: boolean }> {
  const dryRun = !!opts.dryRun
  let evaluated = 0, failed = 0
  try {
    const { data: theses } = await admin.from('intel_theses')
      .select('id, org_id, user_id, stance, visibility, subject_canonical_key, last_reviewed_at, next_review_at, evaluation_error_count, org:orgs!inner(product_mode)')
      .not('subject_canonical_key', 'is', null)
      .in('status', ['active', 'strengthening', 'weakening', 'needs_review', 'partially_confirmed'])
      .lt('evaluation_error_count', 5)
      .order('last_evaluated_at', { ascending: true, nullsFirst: true })
      .limit(Math.max(1, Math.min(opts.limit ?? 50, 200)))
    const active = (theses || []).filter((t: Any) => t.org?.product_mode === 'intel')
    for (const t of active) {
      try { await evaluateThesis(admin, t, { dryRun }); evaluated++ }
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
  } catch { /* batch best-effort */ }
  return { evaluated, failed, dry_run: dryRun }
}
