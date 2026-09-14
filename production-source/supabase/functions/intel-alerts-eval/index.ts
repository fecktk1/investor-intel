// Investor Intel — alert evaluation (pg_cron, service-role).
// Walks active intel_alert_rules, checks stored Birdeye data for the rule's token
// against its threshold, and fires intel_alert_events. Smarter-not-noisier:
// DB-level duplicate suppression (dedup_key), per-rule cooldowns with noisy
// escalation, deterministic quality scoring + suggested tuning, stored-signal
// linking (no-AI "why this fired now"), grouped digests, and the thesis drift
// pass — all on the SAME 15-min cadence with zero extra polling. The AI "why it
// matters" is still generated on demand from the Alerts page.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { evaluateMarketAlerts } from '../_shared/intel/market-alert-evaluator.ts'
import { scoreRuleQuality } from '../_shared/intel/alert-quality.ts'
import { materialityVerdict, MATERIAL_DELTA } from '../_shared/core-intel/materiality.ts'
import { recordCostEvent } from '../_shared/core-intel/cost-ledger.ts'
import { makeCostWriter } from '../_shared/intel/intel-cost-writer.ts'
import {
  assembleIntelligenceContext,
  persistApiIntelligence,
  recordDecisionMemory,
  type IntelligenceContextBlock,
} from '../_shared/intelligence-core.ts'
import { thesisEvidencePass, alertRunState } from '../_shared/intel/alert-run-state.ts'
import { evalThesisEvidenceBatch } from '../_shared/intel/thesis-monitor.ts'

const DEFAULT_COOLDOWN_MIN = 720          // 12h (the historical hardcode, now per-rule)
const NOISY_THRESHOLD = 40                // quality below this → noisy

// Stored Intel Signal for a symbol (cached read, no providers; absent table → null).
// deno-lint-ignore no-explicit-any
async function signalForEntity(admin: any, entity: any): Promise<any> {
  if (!entity?.canonical_ref_key) return null
  try {
    const { data } = await admin.from('intel_signal_state')
      .select('signal_key, direction, confidence, global_score, source_count, why_it_matters, what_to_watch_next, score_delta')
      .eq('subject_type', 'asset').eq('subject_id', entity.canonical_ref_key)
      .order('generated_at', { ascending: false }).limit(1).maybeSingle()
    return data || null
  } catch { return null }
}

const BIRDEYE_CHAIN: Record<string, string> = { '1': 'ethereum', '8453': 'base', '42161': 'arbitrum', '56': 'bsc', '137': 'polygon', '43114': 'avalanche' }
function birdeyeChainFor(ns: string, ref: string): string | null {
  if (ns === 'solana') return 'solana'
  if (ns === 'eip155') return BIRDEYE_CHAIN[ref] || null
  return null
}
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }) }

function compactText(value: unknown, max = 600): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function stableHash(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

function uniqueRefs(values: Array<string | number | null | undefined>, max = 40): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of values) {
    const value = compactText(raw, 140)
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
    if (out.length >= max) break
  }
  return out
}

function confidenceScore(label: unknown): number {
  const normalized = String(label || '').toLowerCase()
  if (normalized.includes('high')) return 0.85
  if (normalized.includes('medium')) return 0.60
  if (normalized.includes('low')) return 0.35
  return 0.50
}

function contextRefs(blocks: IntelligenceContextBlock[]): Array<Record<string, unknown>> {
  return blocks.slice(0, 8).map((b) => ({
    memory_class: b.memory_class,
    title: b.title,
    entity_refs: b.entity_refs?.slice(0, 8) || [],
    narrative_refs: b.narrative_refs?.slice(0, 8) || [],
    confidence: b.confidence,
    created_at: b.created_at,
  }))
}

// deno-lint-ignore no-explicit-any
async function recordTokenAlertIntelligence(admin: any, args: {
  rule: any
  entity: any
  overview: any
  signal: any
  beChain: string
  metric: string | null
  value: number | null
  threshold: number
  alertEventId: string
  observation: any
}) {
  const { rule, entity, overview, signal, beChain, metric, value, threshold, alertEventId, observation } = args
  const symbol = overview?.symbol || entity?.display_symbol || entity?.symbol || entity?.contract_address
  const entityRefs = uniqueRefs([
    entity?.canonical_ref_key,
    entity?.contract_address,
    symbol,
    overview?.address,
    overview?.name,
    signal?.signal_key,
  ])
  const sourceRefs = [
    {
      source: observation.provider, source_ref: observation.sourceRef, observed_at: observation.observedAt, recorded_at: observation.recordedAt,
      chain: beChain,
      contract_address: entity?.contract_address,
      symbol,
    },
    {
      source: 'intel_alert_events',
      id: alertEventId,
      rule_id: rule.id,
    },
    signal?.signal_key ? {
      source: 'intel_signal_state',
      signal_key: signal.signal_key,
      direction: signal.direction,
      confidence: signal.confidence,
    } : null,
  ].filter(Boolean) as Array<Record<string, unknown>>

  try {
    const query = `${symbol || ''} ${rule.trigger_type || ''} ${metric || ''} ${signal?.why_it_matters || ''}`
    const ctx = await assembleIntelligenceContext(admin, {
      surface: 'alerts',
      orgId: rule.org_id,
      query,
      entityRefs,
      includePrivateKnowledge: false,
      limit: 6,
    })

    await persistApiIntelligence(admin, {
      visibility: 'org_private',
      orgId: rule.org_id,
      rawTable: observation.provider === 'coinmarketcap' ? 'intel_market_observations' : 'birdeye_token_overview_cache',
      rawRecordId: observation.id,
      rawHash: stableHash({
        chain: beChain,
        contract_address: entity?.contract_address,
        price: overview?.price,
        liquidity: overview?.liquidity,
        price_change_24h_pct: overview?.price_change_24h_pct,
        volume_change_24h_pct: overview?.volume_change_24h_pct,
      }),
      promotionStatus: 'linked',
      promotionScore: Math.max(confidenceScore(signal?.confidence), Math.min(1, Math.abs(Number(value || 0)) / Math.max(1, Math.abs(threshold || 1)))),
      validationStatus: 'alert_threshold_triggered',
      entityRefs,
      sourceRefs,
      promotedMemoryType: 'execution_decision',
      promotedMemoryRef: alertEventId,
      derivedPayload: {
        symbol,
        chain: beChain,
        contract_address: entity?.contract_address,
        price: overview?.price,
        liquidity: overview?.liquidity,
        price_change_24h_pct: overview?.price_change_24h_pct,
        volume_change_24h_pct: overview?.volume_change_24h_pct,
        trigger_type: rule.trigger_type,
        metric,
        value,
        threshold,
        signal_key: signal?.signal_key || null,
      },
    })

    await recordDecisionMemory(admin, {
      visibility: 'org_private',
      orgId: rule.org_id,
      surface: 'alerts',
      decisionKind: 'intel_alert_fired',
      subjectType: 'alert_rule',
      subjectRef: rule.id,
      recommendation: compactText(`Alert fired for ${symbol || 'tracked token'}: ${metric || rule.trigger_type}`, 240),
      conclusion: compactText(signal?.why_it_matters || `${metric || rule.trigger_type} matched configured threshold ${threshold}.`, 900),
      reasoningSummary: compactText(
        `Investor Intel fired ${rule.trigger_type} because ${metric || 'configured metric'}=${value ?? 'n/a'} matched threshold ${threshold}.`,
        900,
      ),
      evidenceRefs: sourceRefs,
      retrievedContextRefs: contextRefs(ctx.blocks),
      sourceRefs,
      entityRefs,
      confidence: signal?.confidence || 'medium',
      confidenceScore: confidenceScore(signal?.confidence || 'medium'),
      assumptions: [
        { type: 'configured_threshold', trigger_type: rule.trigger_type, metric, threshold },
        { type: 'cooldown_checked', cooldown_minutes: rule.cooldown_minutes || DEFAULT_COOLDOWN_MIN },
      ],
      alternativesConsidered: [
        'Suppress alert when the rule is inside its cooldown window.',
        'Suppress alert when no configured metric crosses the threshold.',
      ],
      decisionHash: `intel_alert:${rule.id}:${alertEventId}`,
      metadata: {
        source_table: 'intel_alert_events',
        source_id: alertEventId,
        rule_id: rule.id,
        metric,
        value,
        threshold,
        signal_ref: signal?.signal_key || null,
      },
    })
  } catch (err) {
    console.warn('[intel-alerts-eval] token alert intelligence skipped:', (err as Error)?.message || err)
  }
}

// deno-lint-ignore no-explicit-any
async function recordNarrativeHeatDecision(admin: any, rule: any, state: any, reason: string, alertEventId: string | null) {
  const slug = rule?.config?.slug || state?.slug || state?.narrative_key || state?.name
  const narrativeRefs = uniqueRefs([slug, state?.name], 10)
  const sourceRefs = [
    {
      source: 'narrative_state',
      narrative_id: state?.narrative_id,
      slug,
      lifecycle_stage: state?.lifecycle_stage,
    },
    alertEventId ? {
      source: 'intel_alert_events',
      id: alertEventId,
      rule_id: rule.id,
    } : null,
  ].filter(Boolean) as Array<Record<string, unknown>>

  try {
    const ctx = await assembleIntelligenceContext(admin, {
      surface: 'alerts',
      orgId: rule.org_id,
      query: `${slug || ''} narrative heat ${reason}`,
      narrativeRefs,
      includePrivateKnowledge: false,
      limit: 6,
    })

    await recordDecisionMemory(admin, {
      visibility: 'org_private',
      orgId: rule.org_id,
      surface: 'alerts',
      decisionKind: 'narrative_heat_alert_fired',
      subjectType: 'alert_rule',
      subjectRef: rule.id,
      recommendation: compactText(`Narrative heat alert fired: ${state?.name || slug || 'tracked narrative'}`, 240),
      conclusion: compactText(reason, 900),
      reasoningSummary: compactText(
        `Narrative heat changed for ${state?.name || slug || 'tracked narrative'}: ${reason}.`,
        900,
      ),
      evidenceRefs: sourceRefs,
      retrievedContextRefs: contextRefs(ctx.blocks),
      sourceRefs,
      narrativeRefs,
      confidence: 'medium',
      confidenceScore: 0.60,
      assumptions: [
        { type: 'narrative_heat_preferences', config: rule.config || {} },
        { type: 'state_window', source: 'narrative_state' },
      ],
      alternativesConsidered: [
        'Suppress alert when a recent narrative heat alert already fired.',
        'Suppress alert when no stage change, momentum spike, or risk spike is present.',
      ],
      decisionHash: `narrative_heat:${rule.id}:${slug}:${alertEventId || new Date().toISOString().slice(0, 10)}`,
      metadata: {
        source_table: alertEventId ? 'intel_alert_events' : 'narrative_state',
        source_id: alertEventId || String(state?.narrative_id || slug || rule.id),
        rule_id: rule.id,
        slug,
        reason,
      },
    })
  } catch (err) {
    console.warn('[intel-alerts-eval] narrative heat decision skipped:', (err as Error)?.message || err)
  }
}

Deno.serve(async (req) => {
  try {
    if (!Deno.env.get('CRON_SECRET') || req.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET')) return json({ error: 'forbidden' }, 401)
    const body=await req.json().catch(()=>({}))
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    // Versioned chart rules use the same cadence and shared normalized prices.
    // The RPC locks each rule, records its baseline/crossing atomically and never
    // sends a notification or calls an upstream price provider.
    const retentionResult = await admin.rpc('intel_prune_chart_prices', { p_limit: 100 })
    if (retentionResult.error) console.error('[intel-alerts-eval] expired chart prices could not be pruned:', retentionResult.error.code)
    let historyPruned=0,historyPruneFailed=false
    for (let batch=0;batch<3;batch++) {
      const historyRetention = await admin.rpc('intel_prune_investigation_history', { p_limit: 5000 })
      if (historyRetention.error) console.error('[intel-alerts-eval] expired market history could not be pruned:', historyRetention.error.code)
      if(historyRetention.error)historyPruneFailed=true;else historyPruned+=Number(historyRetention.data)||0
      if (historyRetention.error||Number(historyRetention.data)<5000) break
    }
    const chartResult = await admin.rpc('intel_evaluate_chart_alerts', { p_limit: 100 })
    if (chartResult.error) console.error('[intel-alerts-eval] chart conditions unavailable:', chartResult.error.code)

    // narrative_heat alerts read narrative_state (no provider calls) → run first so
    // they fire even when Birdeye is unconfigured/disabled.
    const narrativeFired = await evalNarrativeHeat(admin)


    const firedThisRun: { id: string; org_id: string; direction: string | null }[] = []
    const market = await evaluateMarketAlerts(admin, async (r, evidence, eventId) => {
      const ent=r.entity, sig=await signalForEntity(admin,ent)
      firedThisRun.push({id:eventId,org_id:r.org_id,direction:sig?.direction||null})
      // Keep optional existing signal linkage; the immutable condition receipt
      // was already committed. An enrichment failure never recreates an event.
      if(sig?.signal_key){
        const linked=await admin.from('intel_alert_events').update({signal_ref:sig.signal_key}).eq('id',eventId).eq('rule_id',r.id)
        if(linked.error)throw Error('signal_link_failed')
      }
      await recordTokenAlertIntelligence(admin,{rule:r,entity:ent,overview:evidence.overview,signal:sig,beChain:birdeyeChainFor(ent.chain_namespace,ent.chain_id)||ent.canonical_ref_key,metric:evidence.metric,value:evidence.observation.value,threshold:Number(r.config?.min_liquidity_usd??r.config?.threshold_pct),alertEventId:eventId,observation:evidence.observation})
    })
    const {checked,fired,rules:active}=market

    // Grouped digest: ≥2 related events in one run for the same org share a group_id.
    try {
      const byOrg = new Map<string, { id: string; direction: string | null }[]>()
      for (const f of firedThisRun) { const a = byOrg.get(f.org_id) || []; a.push(f); byOrg.set(f.org_id, a) }
      for (const [, evs] of byOrg) {
        if (evs.length < 2) continue
        const gid = crypto.randomUUID()
        await admin.from('intel_alert_events').update({ group_id: gid }).in('id', evs.map((e) => e.id))
      }
    } catch { /* grouping best-effort */ }

    // Deterministic quality scoring + suggested tuning (refreshed at most daily per rule).
    const quality = await scoreRuleQuality(admin, active), tuned=quality.tuned

    // Thesis drift pass — every ~6h window, same cron, no extra polling.
    let thesisReviewed = 0
    let thesisEvidence: { evaluated: number; failed: number; dry_run: boolean } = { evaluated: 0, failed: 0, dry_run: false }
    const h = new Date().getUTCHours(), m = new Date().getUTCMinutes()
    if (h % 6 === 0 && m < 15) {
      thesisReviewed = await evalThesisDrift(admin)   // legacy drift (old columns) — additive, harmless
    }
    // A cron-authenticated operator may run a bounded evidence pass now. This
    // uses the same access checks and persistence path as the scheduled pass.
    const evidencePass=thesisEvidencePass(body,new Date())
    if (evidencePass.run) {
      // Thesis Journal evidence + status + quality pass (cache-first, error-isolated,
      // cursor by last_evaluated_at). THESIS_JOURNAL_CRON_MODE=dry_run logs without writing.
      const dryRun = (Deno.env.get('THESIS_JOURNAL_CRON_MODE') || 'write') === 'dry_run'
      const limit=evidencePass.limit
      thesisEvidence = await evalThesisEvidenceBatch(admin, { dryRun, limit })
    }

    // Precise job ledger row: this run made provider calls only via the capped
    // Birdeye client; suppressed/cooled rules are avoided work.
    try {
      await recordCostEvent(makeCostWriter(admin), {
        feature: 'alerts_eval', orgId: null, cacheStatus: 'no_ai', allowReason: 'n/a_no_ai',
        providerCallsMade: 0, providerCallsAvoided: checked,
        usage: { fired, narrative_fired: narrativeFired.fired, tuned, thesis_reviewed: thesisReviewed, thesis_evidence: thesisEvidence.evaluated, thesis_eval_failed: thesisEvidence.failed },
      }, { precision: 'exact', nowMs: Date.now() })
    } catch { /* ledger best-effort */ }

    const runState=alertRunState(!!chartResult.error,thesisEvidence.failed,!!retentionResult.error||historyPruneFailed,market.failed+narrativeFired.failed+quality.failed+quality.incomplete)
    return json({ ok: runState.ok, partial: runState.partial, checked, fired, market_alerts:{failed:market.failed,unavailable:market.unavailable}, quality, narrative_alerts:narrativeFired, maintenance:{chartPricesPruned:retentionResult.error?null:retentionResult.data,marketObservationsPruned:historyPruned,chartPruneFailed:!!retentionResult.error,historyPruneFailed},chart_alerts: chartResult.error ? { error: 'chart_alert_evaluation_unavailable' } : chartResult.data, narrative_fired: narrativeFired, tuned, thesis_reviewed: thesisReviewed, thesis_evidence: thesisEvidence }, runState.status)
  } catch (e) {
    return json({ error: (e as Error)?.message || 'eval_failed' }, 500)
  }
})

// The RPC reads and commits one locked narrative calculation; no provider calls.
async function evalNarrativeHeat(admin:any):Promise<{fired:number;failed:number;unavailable:number}>{
 const result=await admin.from('intel_alert_rules').select('id,org_id,user_id,chart_revision,config,org:orgs!inner(product_mode)')
  .eq('is_active',true).eq('org.product_mode','intel').eq('trigger_type','narrative_heat')
  .order('last_evaluation_attempt_at',{ascending:true,nullsFirst:true}).order('id').limit(400)
 if(result.error||!Array.isArray(result.data))return {fired:0,failed:1,unavailable:0}
 let fired=0,failed=0,unavailable=0
 for(const rule of result.data){
  const r=await admin.rpc('intel_record_narrative_alert',{p_rule:rule.id,p_org:rule.org_id,p_revision:rule.chart_revision})
  if(r.error||!r.data?.state){
   failed++
   const state=await admin.rpc('intel_record_alert_evaluation',{p_rule:rule.id,p_org:rule.org_id,p_revision:rule.chart_revision,p_state:{status:'evaluation_failed',reason:'Narrative source or event write failed. This is not an empty result.'}})
   if(state.error)failed++
  }else if(r.data.state==='fired'){
   fired++
   await recordNarrativeHeatDecision(admin,rule,r.data.snapshot,r.data.reason,r.data.eventId)
  }else if(r.data.state==='evidence_unavailable')unavailable++
 }
 return {fired,failed,unavailable}
}

// ── Deterministic rule quality: 100 − noise penalty ──────────────────────────
// Penalty rises with fire frequency + near-identical consecutive values; falls
// with read/open rate. Noisy rules get a deterministic threshold suggestion
// (75th percentile of recent trigger values) — applied only on user accept.
// Refreshed at most once/day per rule. One grouped query — no provider calls.
// deno-lint-ignore no-explicit-any

// ── Thesis drift: deterministic supports / weakens / no_effect ────────────────
// Compares the thesis side + baseline signal snapshot against the CURRENT stored
// Intel Signal (cached, no providers). Sets needs_review + drift_detail, parses
// confirm/invalidate phrases into suggested alert rules (created only on user
// accept), and links the signal via intel_thesis_links. Research framing only.
// deno-lint-ignore no-explicit-any
async function evalThesisDrift(admin: any): Promise<number> {
  try {
    const { data: theses } = await admin.from('intel_theses')
      .select('id, org_id, bull_thesis, bear_thesis, neutral_thesis, what_would_confirm, what_would_invalidate, baseline_metrics, drift_detail, entity:entities(display_symbol,canonical_ref_key), org:orgs!inner(product_mode)')
      .not('entity_id', 'is', null).limit(300)
    // deno-lint-ignore no-explicit-any
    const active = (theses || []).filter((t: any) => t.org?.product_mode === 'intel' && t.entity?.display_symbol)
    let reviewed = 0
    for (const t of active) {
      const sig = await signalForEntity(admin, t.entity)
      if (!sig) continue
      // Thesis side: directional only when exactly one of bull/bear is filled.
      const hasBull = !!String(t.bull_thesis || '').trim(), hasBear = !!String(t.bear_thesis || '').trim()
      const side = hasBull && !hasBear ? 'bullish' : hasBear && !hasBull ? 'bearish' : 'unknown'
      const prev = (t.drift_detail || {}).signal || (t.baseline_metrics || {}).signal || null
      const verdict = materialityVerdict({
        prevEvidenceHash: 'baseline', newEvidenceHash: 'baseline', // hash not the driver here
        prevSignal: prev ? { polarity: prev.direction, score: prev.global_score, source_count: prev.source_count } : null,
        newSignal: { polarity: sig.direction, score: sig.global_score, source_count: sig.source_count },
      })
      let drift = 'unknown'
      if (side !== 'unknown') {
        if (sig.direction === side) drift = 'supports'
        else if (sig.direction === (side === 'bullish' ? 'bearish' : 'bullish')) drift = 'weakens'
        else drift = 'no_effect'
      } else drift = verdict.magnitude === 'none' ? 'no_effect' : 'unknown'
      const needsReview = drift === 'weakens' || Math.abs(Number(verdict.drivers.length ? (sig.global_score - (prev?.global_score ?? sig.global_score)) : 0)) >= MATERIAL_DELTA

      // Deterministic alert suggestions from confirm/invalidate phrases.
      const suggestions = parseThesisConditions(`${t.what_would_confirm || ''}\n${t.what_would_invalidate || ''}`)
      await admin.from('intel_theses').update({
        drift_state: drift, needs_review: needsReview, last_drift_at: new Date().toISOString(),
        drift_detail: { signal: { direction: sig.direction, global_score: sig.global_score, source_count: sig.source_count }, drivers: verdict.drivers, side },
        suggested_rules: suggestions,
      }).eq('id', t.id)
      // Link the signal (idempotent via the unique (thesis, kind, key) index).
      try {
        await admin.from('intel_thesis_links').upsert(
          { org_id: t.org_id, thesis_id: t.id, link_kind: 'signal', ref_key: sig.signal_key },
          { onConflict: 'thesis_id,link_kind,ref_key', ignoreDuplicates: true },
        )
      } catch { /* pre-217 schema */ }
      reviewed++
    }
    return reviewed
  } catch { return 0 }
}

// "drops below $X" / "liquidity under $Y" / "volume spikes" → alert-rule configs.
// deno-lint-ignore no-explicit-any
function parseThesisConditions(text: string): any[] {
  // deno-lint-ignore no-explicit-any
  const out: any[] = []
  const t = String(text || '').toLowerCase()
  const pricePct = t.match(/(?:price\s+)?(?:drops?|falls?|down|rises?|up|moves?)\s+(?:by\s+)?(\d{1,3})\s*%/)
  if (pricePct) out.push({ trigger_type: 'price_move', config: { threshold_pct: Number(pricePct[1]) }, phrase: pricePct[0] })
  const liq = t.match(/liquidity\s+(?:drops?\s+)?(?:under|below)\s+\$?([\d,.]+)\s*([km])?/)
  if (liq) {
    const mult = liq[2] === 'm' ? 1e6 : liq[2] === 'k' ? 1e3 : 1
    out.push({ trigger_type: 'liquidity_drop', config: { min_liquidity_usd: parseFloat(liq[1].replace(/,/g, '')) * mult }, phrase: liq[0] })
  }
  if (/volume\s+(spikes?|surges?|doubles?|explodes?)/.test(t)) out.push({ trigger_type: 'volume_spike', config: { threshold_pct: 50 }, phrase: 'volume spikes' })
  return out.slice(0, 4)
}
