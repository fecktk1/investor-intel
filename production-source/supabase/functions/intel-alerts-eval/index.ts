// Investor Intel — alert evaluation (pg_cron, service-role).
// Walks active intel_alert_rules, checks live Birdeye data for the rule's token
// against its threshold, and fires intel_alert_events. Smarter-not-noisier:
// DB-level duplicate suppression (dedup_key), per-rule cooldowns with noisy
// escalation, deterministic quality scoring + suggested tuning, stored-signal
// linking (no-AI "why this fired now"), grouped digests, and the thesis drift
// pass — all on the SAME 15-min cadence with zero extra polling. The AI "why it
// matters" is still generated on demand from the Alerts page.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { getTokenOverview } from '../_shared/birdeye-client.ts'
import { h32 } from '../_shared/core-intel/hashing.ts'
import { materialityVerdict, MATERIAL_DELTA } from '../_shared/core-intel/materiality.ts'
import { recordCostEvent } from '../_shared/core-intel/cost-ledger.ts'
import { makeCostWriter } from '../_shared/intel/intel-cost-writer.ts'
import {
  assembleIntelligenceContext,
  persistApiIntelligence,
  recordDecisionMemory,
  type IntelligenceContextBlock,
} from '../_shared/intelligence-core.ts'
import { evalThesisEvidenceBatch } from '../_shared/intel/thesis-monitor.ts'

const DEFAULT_COOLDOWN_MIN = 720          // 12h (the historical hardcode, now per-rule)
const NOISY_FIRES_48H = 4                 // ≥4 fires in 48h → cooldown ×2
const NOISY_THRESHOLD = 40                // quality below this → noisy

// Same rule + metric + 5% value band + day → one event (DB-enforced).
function dedupKeyFor(ruleId: string, metric: string | null, value: number | null): string {
  const band = value == null || !isFinite(value) ? 'na' : String(Math.round(value / 5) * 5)
  return h32(`${ruleId}|${metric || 'na'}|${band}|${new Date().toISOString().slice(0, 10)}`)
}

// Per-rule cooldown with deterministic noisy escalation (×2 when ≥4 fires/48h).
// deno-lint-ignore no-explicit-any
async function cooledDown(admin: any, ruleId: string, cooldownMinutes: number | null): Promise<boolean> {
  const base = Number(cooldownMinutes) > 0 ? Number(cooldownMinutes) : DEFAULT_COOLDOWN_MIN
  const { data: recent48 } = await admin.from('intel_alert_events').select('id, fired_at')
    .eq('rule_id', ruleId).gte('fired_at', new Date(Date.now() - 48 * 3600_000).toISOString())
    .order('fired_at', { ascending: false }).limit(NOISY_FIRES_48H + 1)
  const eff = (recent48?.length || 0) >= NOISY_FIRES_48H ? base * 2 : base
  const last = recent48?.[0]?.fired_at ? new Date(recent48[0].fired_at).getTime() : 0
  return last > Date.now() - eff * 60_000
}

// Stored Intel Signal for a symbol (cached read, no providers; absent table → null).
// deno-lint-ignore no-explicit-any
async function signalForSymbol(admin: any, symbol: string | null | undefined): Promise<any> {
  if (!symbol) return null
  try {
    const { data } = await admin.from('intel_signal_state')
      .select('signal_key, direction, confidence, global_score, source_count, why_it_matters, what_to_watch_next, score_delta')
      .eq('subject_type', 'asset').eq('display_symbol', String(symbol).toUpperCase().replace(/^\$/, ''))
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
}) {
  const { rule, entity, overview, signal, beChain, metric, value, threshold, alertEventId } = args
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
      source: 'birdeye_token_overview',
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

    const hourBucket = new Date().toISOString().slice(0, 13)
    await persistApiIntelligence(admin, {
      visibility: 'org_private',
      orgId: rule.org_id,
      rawTable: 'birdeye_token_overview',
      rawRecordId: `${beChain}:${entity?.contract_address || symbol}:${hourBucket}`,
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
      conclusion: compactText(signal?.why_it_matters || `${metric || rule.trigger_type} crossed configured threshold ${threshold}.`, 900),
      reasoningSummary: compactText(
        `Investor Intel fired ${rule.trigger_type} because ${metric || 'configured metric'}=${value ?? 'n/a'} crossed threshold ${threshold}.`,
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
    if (req.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET')) return json({ error: 'forbidden' }, 401)
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    // narrative_heat alerts read narrative_state (no provider calls) → run first so
    // they fire even when Birdeye is unconfigured/disabled.
    const narrativeFired = await evalNarrativeHeat(admin)

    const beKey = Deno.env.get('BIRDEYE_API_KEY')
    if (!beKey) return json({ ok: true, checked: 0, fired: 0, narrative_fired: narrativeFired })

    const { data: rules } = await admin
      .from('intel_alert_rules')
      .select('*, entity:entities(*), org:orgs!inner(product_mode)')
      .eq('is_active', true)
      .limit(1000)

    const active = (rules || []).filter((r: any) => r.org?.product_mode === 'intel' && r.entity?.contract_address)
    let fired = 0, checked = 0
    const firedThisRun: { id: string; org_id: string; direction: string | null }[] = []

    for (const r of active.slice(0, 400)) {
      const ent = r.entity
      const beChain = birdeyeChainFor(ent.chain_namespace, ent.chain_id)
      if (!beChain) continue
      checked++

      // Overview via the centralized client: cached/deduped/capped/logged and
      // kill-switch aware. Also warms the shared overview cache.
      const ov = await getTokenOverview(
        beChain,
        ent.contract_address,
        { supabase: admin, jobName: 'intel-alerts-eval', caller: 'alerts-cron', orgId: r.org_id },
        { cacheOnly: true },
      )
      if (!ov) continue

      const cfg = r.config || {}
      const thr = Number(cfg.threshold_pct)
      const pc = Number(ov.price_change_24h_pct)
      const vc = Number(ov.volume_change_24h_pct)
      let triggered = false; let metric = null; let value = null
      if (!Number.isNaN(thr)) {
        if (r.trigger_type === 'price_move' && !Number.isNaN(pc) && Math.abs(pc) >= thr) { triggered = true; metric = 'price_change_24h_pct'; value = pc }
        else if (r.trigger_type === 'volume_spike' && !Number.isNaN(vc) && vc >= thr) { triggered = true; metric = 'volume_change_24h_pct'; value = vc }
        else if (r.trigger_type === 'liquidity_drop' && Number(ov.liquidity) > 0 && cfg.min_liquidity_usd && Number(ov.liquidity) < Number(cfg.min_liquidity_usd)) { triggered = true; metric = 'liquidity_usd'; value = Number(ov.liquidity) }
      }
      if (!triggered) continue

      // Per-rule cooldown (NULL → 720 min) with noisy ×2 escalation.
      if (await cooledDown(admin, r.id, r.cooldown_minutes)) continue

      // Link the stored Intel Signal — its why_it_matters / what_to_watch_next
      // power the deterministic "why this fired now" with zero AI.
      const sig = await signalForSymbol(admin, ov.symbol || ent.display_symbol)
      const ins = await admin.from('intel_alert_events').upsert({
        org_id: r.org_id, rule_id: r.id,
        dedup_key: dedupKeyFor(r.id, metric, typeof value === 'number' ? value : null),
        signal_ref: sig?.signal_key || null,
        payload: {
          trigger_type: r.trigger_type, metric, value, threshold_pct: thr,
          symbol: ov.symbol || ent.display_symbol, price: ov.price, ref: ent.canonical_ref_key,
          signal_direction: sig?.direction || null,
          why_now: sig?.why_it_matters || null, confirm_or_weaken: sig?.what_to_watch_next || null,
        },
      }, { onConflict: 'rule_id,dedup_key', ignoreDuplicates: true }).select('id')
      if (!ins.error && (ins.data?.length || 0) > 0) {
        const alertEventId = ins.data[0].id
        fired++
        firedThisRun.push({ id: alertEventId, org_id: r.org_id, direction: sig?.direction || null })
        await recordTokenAlertIntelligence(admin, {
          rule: r,
          entity: ent,
          overview: ov,
          signal: sig,
          beChain,
          metric,
          value: typeof value === 'number' ? value : null,
          threshold: thr,
          alertEventId,
        })
      }
    }

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
    const tuned = await scoreRuleQuality(admin, active)

    // Thesis drift pass — every ~6h window, same cron, no extra polling.
    let thesisReviewed = 0
    let thesisEvidence: { evaluated: number; failed: number; dry_run: boolean } = { evaluated: 0, failed: 0, dry_run: false }
    const h = new Date().getUTCHours(), m = new Date().getUTCMinutes()
    if (h % 6 === 0 && m < 15) {
      thesisReviewed = await evalThesisDrift(admin)   // legacy drift (old columns) — additive, harmless
      // Thesis Journal evidence + status + quality pass (cache-first, error-isolated,
      // cursor by last_evaluated_at). THESIS_JOURNAL_CRON_MODE=dry_run logs without writing.
      const dryRun = (Deno.env.get('THESIS_JOURNAL_CRON_MODE') || 'write') === 'dry_run'
      thesisEvidence = await evalThesisEvidenceBatch(admin, { dryRun, limit: 50 })
    }

    // Precise job ledger row: this run made provider calls only via the capped
    // Birdeye client; suppressed/cooled rules are avoided work.
    try {
      await recordCostEvent(makeCostWriter(admin), {
        feature: 'alerts_eval', orgId: null, cacheStatus: 'no_ai', allowReason: 'n/a_no_ai',
        providerCallsMade: checked, providerCallsAvoided: Math.max(0, active.length - checked),
        usage: { fired, narrative_fired: narrativeFired, tuned, thesis_reviewed: thesisReviewed, thesis_evidence: thesisEvidence.evaluated, thesis_eval_failed: thesisEvidence.failed },
      }, { precision: 'exact', nowMs: Date.now() })
    } catch { /* ledger best-effort */ }

    return json({ ok: true, checked, fired, narrative_fired: narrativeFired, tuned, thesis_reviewed: thesisReviewed, thesis_evidence: thesisEvidence })
  } catch (e) {
    return json({ error: (e as Error)?.message || 'eval_failed' }, 500)
  }
})

// Fire narrative_heat events for followed narratives whose state materially changed
// (stage transition / momentum spike / elevated risk). Reads narrative_state only —
// no provider calls. Best-effort: returns the count, never throws.
// deno-lint-ignore no-explicit-any
async function evalNarrativeHeat(admin: any): Promise<number> {
  try {
    const { data: rules } = await admin.from('intel_alert_rules')
      .select('id, org_id, config, org:orgs!inner(product_mode)')
      .eq('is_active', true).eq('trigger_type', 'narrative_heat').limit(1000)
    // deno-lint-ignore no-explicit-any
    const active = (rules || []).filter((r: any) => r.org?.product_mode === 'intel' && r.config?.slug)
    if (!active.length) return 0

    // deno-lint-ignore no-explicit-any
    const slugs = [...new Set(active.map((r: any) => r.config.slug))]
    const { data: tax } = await admin.from('narrative_taxonomy').select('id, slug, name').in('slug', slugs)
    // deno-lint-ignore no-explicit-any
    const byId = new Map<string, any>((tax || []).map((t: any) => [t.id, t]))
    const ids = (tax || []).map((t: { id: string }) => t.id)
    const { data: states } = ids.length ? await admin.from('narrative_state').select('*').in('narrative_id', ids) : { data: [] }
    // deno-lint-ignore no-explicit-any
    const bySlug = new Map<string, any>()
    for (const s of (states || [])) { const ti = byId.get(s.narrative_id); if (ti) bySlug.set(ti.slug, { ...s, name: ti.name }) }

    let fired = 0
    for (const r of active) {
      const st = bySlug.get(r.config.slug); if (!st) continue
      const prefs = r.config || {}
      const delta = st.score_delta || {}
      const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : 0)
      const stageChange = prefs.stage_change !== false && st.prev_stage && st.prev_stage !== st.lifecycle_stage
        && st.stage_changed_at && (Date.now() - new Date(st.stage_changed_at).getTime()) < 6 * 3600_000
      const momoSpike = num(delta.momentum) >= Number(prefs.momentum_delta || 10)
      const riskSpike = prefs.risk_spike !== false && num(st.risk_score) >= Number(prefs.risk_score || 65)
      let reason: string | null = null
      if (stageChange) reason = `stage ${st.prev_stage} → ${st.lifecycle_stage}`
      else if (momoSpike) reason = `momentum +${Math.round(num(delta.momentum))}`
      else if (riskSpike) reason = `risk elevated (${Math.round(num(st.risk_score))})`
      if (!reason) continue

      const { data: recent } = await admin.from('intel_alert_events').select('id')
        .eq('rule_id', r.id).gte('fired_at', new Date(Date.now() - 12 * 3600_000).toISOString()).limit(1)
      if (recent && recent.length) continue

      const ins = await admin.from('intel_alert_events').insert({
        org_id: r.org_id, rule_id: r.id,
        payload: { trigger_type: 'narrative_heat', slug: r.config.slug, name: st.name, reason,
          lifecycle_stage: st.lifecycle_stage, prev_stage: st.prev_stage, signal_class: st.signal_class,
          momentum: st.momentum_score, risk: st.risk_score },
      }).select('id')
      await recordNarrativeHeatDecision(admin, r, st, reason, ins.error ? null : ins.data?.[0]?.id || null)
      fired++
    }
    return fired
  } catch (_e) { return 0 }
}

// ── Deterministic rule quality: 100 − noise penalty ──────────────────────────
// Penalty rises with fire frequency + near-identical consecutive values; falls
// with read/open rate. Noisy rules get a deterministic threshold suggestion
// (75th percentile of recent trigger values) — applied only on user accept.
// Refreshed at most once/day per rule. One grouped query — no provider calls.
// deno-lint-ignore no-explicit-any
async function scoreRuleQuality(admin: any, rules: any[]): Promise<number> {
  try {
    const staleBefore = new Date(Date.now() - 24 * 3600_000).toISOString()
    const due = rules.filter((r) => !r.last_quality_at || r.last_quality_at < staleBefore).slice(0, 100)
    if (!due.length) return 0
    const since = new Date(Date.now() - 14 * 86_400_000).toISOString()
    const { data: events } = await admin.from('intel_alert_events')
      .select('rule_id, fired_at, read_at, payload').in('rule_id', due.map((r) => r.id)).gte('fired_at', since)
      .order('fired_at', { ascending: true }).limit(2000)
    // deno-lint-ignore no-explicit-any
    const byRule = new Map<string, any[]>()
    for (const e of (events || [])) { const a = byRule.get(e.rule_id) || []; a.push(e); byRule.set(e.rule_id, a) }
    let tuned = 0
    for (const r of due) {
      const evs = byRule.get(r.id) || []
      const fires = evs.length
      const opened = evs.filter((e) => e.read_at).length
      const openRate = fires ? opened / fires : 1
      // near-identical consecutive values (within 10% of each other)
      let nearDup = 0
      for (let i = 1; i < evs.length; i++) {
        const a = Number(evs[i - 1].payload?.value), b = Number(evs[i].payload?.value)
        if (isFinite(a) && isFinite(b) && Math.abs(a - b) <= Math.abs(a) * 0.1) nearDup++
      }
      const freqPenalty = Math.min(50, fires * 3.5)            // 14d fire volume
      const dupPenalty = Math.min(25, nearDup * 5)             // near-identical repeats
      const unreadPenalty = Math.round((1 - openRate) * 20)    // fires nobody opens
      const score = Math.max(0, Math.min(100, 100 - freqPenalty - dupPenalty - unreadPenalty))
      const noisy = score < NOISY_THRESHOLD
      // Suggested tuning: raise threshold_pct to the 75th percentile of recent
      // trigger values (price_move / volume_spike only).
      // deno-lint-ignore no-explicit-any
      let suggested: any = {}
      if (noisy && ['price_move', 'volume_spike'].includes(r.trigger_type) && fires >= 3) {
        const vals = evs.map((e) => Math.abs(Number(e.payload?.value))).filter((v) => isFinite(v)).sort((a, b) => a - b)
        if (vals.length >= 3) {
          const p75 = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.75))]
          suggested = { threshold_pct: Math.ceil(p75), reason: 'fires often near your current threshold — raising it would cut the noise' }
        }
      }
      await admin.from('intel_alert_rules').update({
        quality_score: score, noisy, suggested_config: suggested, last_quality_at: new Date().toISOString(),
      }).eq('id', r.id)
      tuned++
    }
    return tuned
  } catch { return 0 }
}

// ── Thesis drift: deterministic supports / weakens / no_effect ────────────────
// Compares the thesis side + baseline signal snapshot against the CURRENT stored
// Intel Signal (cached, no providers). Sets needs_review + drift_detail, parses
// confirm/invalidate phrases into suggested alert rules (created only on user
// accept), and links the signal via intel_thesis_links. Research framing only.
// deno-lint-ignore no-explicit-any
async function evalThesisDrift(admin: any): Promise<number> {
  try {
    const { data: theses } = await admin.from('intel_theses')
      .select('id, org_id, bull_thesis, bear_thesis, neutral_thesis, what_would_confirm, what_would_invalidate, baseline_metrics, drift_detail, entity:entities(display_symbol), org:orgs!inner(product_mode)')
      .not('entity_id', 'is', null).limit(300)
    // deno-lint-ignore no-explicit-any
    const active = (theses || []).filter((t: any) => t.org?.product_mode === 'intel' && t.entity?.display_symbol)
    let reviewed = 0
    for (const t of active) {
      const sig = await signalForSymbol(admin, t.entity.display_symbol)
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
