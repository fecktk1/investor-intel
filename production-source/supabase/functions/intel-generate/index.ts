// Investor Intel — generic artifact generator.
//
// One endpoint for every AI insight (token_breakdown, risk_panel, explain,
// token_comparison, narrative_report, wallet_summary, defi_report,
// execution_report, alert_explanation). Flow:
//   cache check (input_hash) -> generate -> safe-language + contract validation
//   -> one constrained rewrite on a hard hit -> block if still failing ->
//   persist research_artifacts -> record telemetry.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { buildPrompt, buildDeltaPrompt, requiredFieldsFor, DELTA_REQUIRED_FIELDS, CONTRACT_VERSION, GUARDRAIL_VERSION } from '../_shared/intel-prompts.ts'
import { validateSafeLanguage, validateArtifactContract, SAFE_LANGUAGE_RULES } from '../_shared/intel-guardrails.ts'
import { recordIntelEvent } from '../_shared/intel-events.ts'
import { recordAIUsage } from '../_shared/usage.ts'
import { birdeyeChainFor, birdeyeOverview, birdeyeWalletPortfolio, dflowExecutionForSolanaToken, kaminoForAddress, defiLlamaForPool } from '../_shared/intel-providers.ts'
import { chainIdFor } from '../_shared/chains.ts'
import { buildEvidence } from '../_shared/intel-evidence.ts'
import { multiModelAnalyze } from '../_shared/intel-models.ts'
import { buildMarketMemoryPromptBlock } from '../_shared/exchange-market/memory.ts'
import { materialityVerdict } from '../_shared/core-intel/materiality.ts'
import { recordCostEvent } from '../_shared/core-intel/cost-ledger.ts'
import { makeCostWriter } from '../_shared/intel/intel-cost-writer.ts'
import { routeExplainContext, similarRecentExplain, computeQuestionHashes } from '../_shared/intel/intel-context-adapters.ts'
import { assembleIntelligenceContext, recordDecisionMemory } from '../_shared/intelligence-core.ts'
import { intelModel, intelEffort } from '../_shared/intel-model-config.ts'
import { checkProviderBudget, logProviderCall } from '../_shared/provider-budget.ts'
import {
  compactAssetEvidencePackForPrompt,
  criticalSlicesForAssetEvidencePack,
  getOrAssembleAssetEvidencePack,
  type AssetEvidenceSubject,
  type DataCoverage,
} from '../_shared/intel/asset-evidence-pack.ts'
import { reconcileCoverage } from '../_shared/intel/coverage.ts'
import { assembleBriefEvidencePack } from '../_shared/intel/brief-evidence-pack.ts'
import { assembleNarrativeEvidencePack } from '../_shared/intel/narrative-evidence-pack.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

function hashStr(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0
  return h.toString(16)
}

function cleanSymbol(value: unknown): string | null {
  const s = String(value || '').trim().replace(/^\$/, '').toUpperCase()
  return s || null
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (Array.isArray(value)) {
      const nested = firstString(...value)
      if (nested) return nested
      continue
    }
    const s = String(value || '').trim()
    if (s) return s
  }
  return null
}

function coverageStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v || '').trim()).filter(Boolean) : []
}

function uniqStrings(values: unknown[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const s = String(value || '').trim()
    const key = s.toLowerCase()
    if (!s || seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
}

function normalizeCoverage(value: unknown): Partial<DataCoverage> {
  if (!value || typeof value !== 'object') return {}
  const v = value as Record<string, unknown>
  return {
    used_sources: coverageStrings(v.used_sources),
    checked_sources: coverageStrings(v.checked_sources),
    unavailable_sources: coverageStrings(v.unavailable_sources),
    material_gaps: coverageStrings(v.material_gaps),
    optional_gaps: coverageStrings(v.optional_gaps),
    confidence_impact: ['none', 'low', 'medium', 'high'].includes(String(v.confidence_impact))
      ? v.confidence_impact as DataCoverage['confidence_impact']
      : undefined,
    should_show_warning: typeof v.should_show_warning === 'boolean' ? v.should_show_warning : undefined,
  }
}

function mergeCoverageValues(values: unknown[]): Partial<DataCoverage> | null {
  const parts = values.map(normalizeCoverage).filter((v) =>
    (v.used_sources?.length || 0) ||
    (v.checked_sources?.length || 0) ||
    (v.unavailable_sources?.length || 0) ||
    (v.material_gaps?.length || 0) ||
    (v.optional_gaps?.length || 0)
  )
  if (!parts.length) return null
  const material = uniqStrings(parts.flatMap((v) => v.material_gaps || []))
  const optional = uniqStrings(parts.flatMap((v) => v.optional_gaps || []))
  const impactRank: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3 }
  const confidenceImpact = parts
    .map((v) => v.confidence_impact || 'none')
    .sort((a, b) => (impactRank[b] || 0) - (impactRank[a] || 0))[0] as DataCoverage['confidence_impact']
  return {
    used_sources: uniqStrings(parts.flatMap((v) => v.used_sources || [])),
    checked_sources: uniqStrings(parts.flatMap((v) => v.checked_sources || [])),
    unavailable_sources: uniqStrings(parts.flatMap((v) => v.unavailable_sources || [])),
    material_gaps: material,
    optional_gaps: optional,
    confidence_impact: confidenceImpact || (material.length ? 'high' : optional.length ? 'low' : 'none'),
    should_show_warning: parts.some((v) => v.should_show_warning === true) || material.length > 0,
  }
}

function evidencePackCoverage(value: unknown): unknown {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, any>
  return v.pack?.data_coverage || v.data_coverage || null
}

function packCoverageFromContext(context: unknown): unknown {
  if (!context || typeof context !== 'object') return null
  const c = context as Record<string, any>
  return mergeCoverageValues([
    evidencePackCoverage(c.asset_evidence_pack),
    ...(Array.isArray(c.asset_evidence_packs) ? c.asset_evidence_packs.map(evidencePackCoverage) : []),
    ...(Array.isArray(c.asset_comparison_evidence?.packs) ? c.asset_comparison_evidence.packs.map(evidencePackCoverage) : []),
    c.asset_comparison_evidence?.data_coverage,
    c.evidence_coverage,
  ])
}

function deriveAssetEvidenceSubject(args: {
  // deno-lint-ignore no-explicit-any
  extra: any
  // deno-lint-ignore no-explicit-any
  context: any
  // deno-lint-ignore no-explicit-any
  ent: any
  orgId: string
  userId: string | null
  symbolOverride?: unknown
  publicOnly?: boolean
}): AssetEvidenceSubject | null {
  const { extra, context, ent, orgId, userId, symbolOverride, publicOnly } = args
  const identity = context?.asset_identity || context?.exchange_market || {}
  const symbol = cleanSymbol(firstString(symbolOverride, extra?.symbols, extra?.symbol, identity.symbol, context?.exchange_market?.symbol, ent?.display_symbol))
  const providerId = firstString(extra?.providerId, identity.providerId, context?.exchange_market?.providerId)
  const sourceProvider = firstString(extra?.sourceProvider, identity.sourceProvider, context?.exchange_market?.sourceProvider)
  const canonicalKey = firstString(extra?.canonicalKey, identity.canonicalKey, ent?.canonical_ref_key)
  if (!symbol && !providerId && !canonicalKey) return null
  return {
    symbol,
    canonicalKey,
    chain: firstString(extra?.primaryChain, extra?.chain, identity.primaryChain, identity.chain, context?.exchange_market?.primaryChain, context?.exchange_market?.chain, ent?.chain_id, ent?.chain_namespace),
    providerId,
    sourceProvider,
    tokenAddress: firstString(extra?.tokenAddress, identity.tokenAddress, context?.dex?.tokenAddress, ent?.contract_address),
    orgId: publicOnly ? null : orgId,
    userId: publicOnly ? null : userId,
  }
}

function deriveExplainEvidenceSubject(args: {
  // deno-lint-ignore no-explicit-any
  extra: any
  // deno-lint-ignore no-explicit-any
  context: any
  // deno-lint-ignore no-explicit-any
  ent: any
  orgId: string
  userId: string | null
}): AssetEvidenceSubject | null {
  return deriveAssetEvidenceSubject(args)
}

// Stable per-asset key for explain reuse scoping (migration 286). Prefer the
// canonical key, then provider identity, then symbol. Null => no asset (a fungible
// educational question), which keeps the legacy entity-pool reuse behaviour.
function explainSubjectKeyFor(subject: AssetEvidenceSubject | null): string | null {
  if (!subject) return null
  const canonical = String(subject.canonicalKey || '').trim()
  if (canonical) return canonical
  const provider = String(subject.sourceProvider || '').trim()
  const pid = String(subject.providerId || '').trim()
  if (provider && pid) return `${provider}:${pid}`
  const sym = cleanSymbol(subject.symbol)
  return sym ? `symbol:${sym}` : null
}

function comparisonSymbols(extra: any, context: any, ent: any): string[] {
  const values: unknown[] = [
    ...(Array.isArray(extra?.symbols) ? extra.symbols : []),
    ...(Array.isArray(extra?.compareSymbols) ? extra.compareSymbols : []),
    ...(Array.isArray(extra?.assets) ? extra.assets : []),
    extra?.baseSymbol,
    extra?.quoteSymbol,
    context?.base?.symbol,
    context?.quote?.symbol,
    ...(Array.isArray(context?.symbols) ? context.symbols : []),
    ent?.display_symbol,
  ]
  return uniqStrings(values.map(cleanSymbol)).slice(0, 4)
}

function assetSubjectsForArtifact(args: {
  artifactType: string
  // deno-lint-ignore no-explicit-any
  extra: any
  // deno-lint-ignore no-explicit-any
  context: any
  // deno-lint-ignore no-explicit-any
  ent: any
  orgId: string
  userId: string | null
}): AssetEvidenceSubject[] {
  if (args.artifactType === 'token_comparison') {
    return comparisonSymbols(args.extra, args.context, args.ent)
      .map((symbol) => deriveAssetEvidenceSubject({ ...args, symbolOverride: symbol, publicOnly: true }))
      .filter(Boolean) as AssetEvidenceSubject[]
  }
  const subject = deriveAssetEvidenceSubject({ ...args, publicOnly: true })
  return subject ? [subject] : []
}

function narrativeSlugFromContext(extra: any, context: any, ent: any): string | null {
  const raw = firstString(
    extra?.narrativeSlug,
    extra?.slug,
    extra?.narrative?.slug,
    context?.narrative?.slug,
    context?.slug,
    ent?.slug,
    ent?.canonical_ref_key,
  )
  if (!raw) return null
  return String(raw).replace(/^narrative:/, '').trim()
}

async function maybeRefreshCriticalEvidencePack(
  // deno-lint-ignore no-explicit-any
  admin: any,
  subject: AssetEvidenceSubject,
  // deno-lint-ignore no-explicit-any
  currentPack: any,
  orgId: string,
  userId: string | null,
) {
  const staleSlices = criticalSlicesForAssetEvidencePack(currentPack)
  if (!staleSlices.length) return currentPack
  const subjectRef = subject.canonicalKey || subject.symbol || subject.providerId || 'unknown'
  const hardCap = Math.max(1, Number(Deno.env.get('INTEL_EVIDENCE_PACK_REFRESH_DAILY_CAP') || '250'))
  const budget = await checkProviderBudget(admin, {
    provider: 'asset-evidence-pack',
    dataType: 'critical_slice_refresh',
    calls: 1,
    hardCap,
    period: 'day',
  })
  if (!budget.allowed) {
    await logProviderCall(admin, {
      provider: 'asset-evidence-pack',
      dataType: 'critical_slice_refresh',
      endpoint: 'cache://intelligence_evidence_packs/critical-slice',
      subjectRef,
      cacheStatus: 'budget_exceeded',
      calls: 0,
      caller: 'intel-generate',
      jobName: 'explain-critical-slice-planner',
      orgId,
      userId,
      suppressionReason: budget.suppressionReason || `critical_slices:${staleSlices.join(',')}`,
    })
    return currentPack
  }
  await logProviderCall(admin, {
    provider: 'asset-evidence-pack',
    dataType: 'critical_slice_refresh',
    endpoint: 'cache://intelligence_evidence_packs/critical-slice',
    subjectRef,
    cacheStatus: 'stale_fallback',
    calls: 0,
    caller: 'intel-generate',
    jobName: 'explain-critical-slice-planner',
    orgId,
    userId,
    suppressionReason: `critical_slices:${staleSlices.join(',')};cached_table_refresh_only`,
  })
  try {
    return await getOrAssembleAssetEvidencePack(admin, subject, { force: true, staleMinutes: 30 })
  } catch {
    return currentPack
  }
}

function textOfArtifact(structured: any): string {
  const ya = structured?.yield_analysis || {}, tl = structured?.tvl_liquidity || {}, po = structured?.pool_overview || {}
  const parts = [structured?.summary, structured?.what_happened, structured?.why_it_matters, structured?.crypto_market_impact,
    structured?.bull_case, structured?.bear_case, structured?.neutral_case,
    structured?.beginner_explanation, structured?.advanced_explanation,
    // defi_report (pool-framed) prose — scanned by the safety guardrail too.
    po.what_it_is, ya.apy_read, ya.base_vs_reward, ya.sustainability, tl.tvl_read, tl.depth_note,
    structured?.collateral_or_il, structured?.who_its_for,
    // delta-mode prose — the safety guardrail must cover updates too.
    structured?.what_changed, structured?.still_holds, structured?.now_different,
    ...(Array.isArray(structured?.change_drivers) ? structured.change_drivers : []),
    ...(Array.isArray(structured?.updated_what_to_watch) ? structured.updated_what_to_watch : []),
    ...(Array.isArray(structured?.comparisons) ? structured.comparisons : []),
    ...(Array.isArray(structured?.what_to_watch) ? structured.what_to_watch : [])]
  return parts.filter((x) => typeof x === 'string').join('\n')
}

async function callOpenAI(model: string, system: string, user: string, apiKey: string, effort: string = intelEffort()) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_object' },
      reasoning_effort: effort, // cost rule: default low, hard-capped at medium (intelEffort)
    }),
  })
  if (!res.ok) throw new Error(`openai_${res.status}: ${(await res.text()).slice(0, 300)}`)
  const data = await res.json()
  return { content: data.choices?.[0]?.message?.content || '{}', usage: data.usage }
}

// Build a research_artifacts row (org-scoped). Used for fresh generations AND
// for copying a reused SHARED artifact into the workspace (history + Save).
function orgArtifactRow(p: any) {
  const s = p.structured || {}
  return {
    org_id: p.orgId, user_id: p.userId, artifact_type: p.artifactType,
    entity_id: p.ent?.id || null, subject_kind: p.ent?.entity_kind || p.extra?.subjectKind || 'general',
    title: p.extra?.title || (typeof s.summary === 'string' ? s.summary.slice(0, 120) : null) || p.artifactType,
    body_md: typeof s.summary === 'string' ? s.summary : null,
    structured: s,
    confidence: ['high', 'medium', 'low'].includes(s.confidence) ? s.confidence : 'low',
    evidence: s.evidence || [], missing_context: s.missing_context || [],
    data_freshness: s.data_freshness || {}, sources: Array.from(new Set([...(s.sources || []), ...(p.sources || [])])),
    schema_version: 2, artifact_version: 1, input_hash: p.inputHash,
    source_snapshot_ids: p.extra?.sourceSnapshotIds || [], cache_key: p.cacheKey,
    regeneration_policy: 'on_demand', provider_coverage_snapshot: p.extra?.coverage || {},
    model: p.model, validation_status: p.validationStatus,
    validator_outcome: p.validatorOutcome || {},
    status: p.validationStatus === 'blocked' ? 'blocked' : 'ready',
    stale_after: p.staleAfter,
    // reuse / delta / similarity lineage (migration 215). insertArtifact strips
    // these when the columns don't exist yet (deploy-order safety).
    evidence_hash: p.evidenceHash ?? null, source_set_hash: p.sourceSetHash ?? null,
    signal_snapshot: p.signalSnapshot ?? {}, base_artifact_id: p.baseArtifactId ?? null,
    reuse_kind: p.reuseKind ?? 'fresh',
    question_norm_hash: p.questionNormHash ?? null, question_shingles: p.questionShingles ?? null,
    // Asset-scoped explain reuse key (migration 286). Stripped on insert below when
    // the column doesn't exist yet (deploy-order safety).
    explain_subject_key: p.explainSubjectKey ?? null,
  }
}

// Columns added by additive migrations — stripped on insert when the migration
// hasn't been applied yet so a function-first deploy degrades instead of hard-breaking.
const M215_COLS = ['evidence_hash', 'source_set_hash', 'signal_snapshot', 'base_artifact_id', 'reuse_kind', 'question_norm_hash', 'question_shingles']
const ADDITIVE_COLS = [...M215_COLS, 'explain_subject_key']
async function insertArtifact(supabase: any, row: any) {
  let res = await supabase.from('research_artifacts').insert(row).select('*').single()
  if (res.error && /column|schema cache/i.test(String(res.error.message))) {
    const legacy = { ...row }
    for (const c of ADDITIVE_COLS) delete legacy[c]
    res = await supabase.from('research_artifacts').insert(legacy).select('*').single()
  }
  return res
}

async function recordArtifactDecisionMemory(supabase: any, p: any): Promise<void> {
  const artifact = p.artifact || {}
  const structured = artifact.structured || p.structured || {}
  const summary = typeof structured.summary === 'string' ? structured.summary : artifact.body_md || null
  const confidence = ['high', 'medium', 'low'].includes(structured.confidence) ? structured.confidence : artifact.confidence || null
  const confidenceScore = confidence === 'high' ? 0.9 : confidence === 'medium' ? 0.6 : confidence === 'low' ? 0.35 : null
  await recordDecisionMemory(supabase, {
    visibility: p.visibility || 'org_private',
    orgId: p.orgId,
    userId: p.userId,
    surface: 'investor_intel',
    decisionKind: p.decisionKind || p.artifactType || 'artifact_generation',
    subjectType: p.ent?.entity_kind || artifact.subject_kind || null,
    subjectRef: p.ent?.canonical_ref_key || null,
    recommendation: artifact.title || p.artifactType || null,
    conclusion: summary,
    reasoningSummary: p.reasoningSummary || summary,
    evidenceRefs: Array.isArray(artifact.evidence) ? artifact.evidence : [],
    sourceRefs: Array.isArray(artifact.sources) ? artifact.sources : [],
    entityRefs: p.ent?.canonical_ref_key ? [p.ent.canonical_ref_key] : [],
    narrativeRefs: p.ent?.entity_kind === 'narrative' && p.ent?.canonical_ref_key ? [p.ent.canonical_ref_key] : [],
    confidence,
    confidenceScore,
    model: artifact.model || p.model || null,
    artifactId: artifact.id || null,
    sharedArtifactId: p.sharedArtifactId || null,
    metadata: {
      artifact_type: p.artifactType,
      reuse_kind: artifact.reuse_kind || p.reuseKind || null,
      evidence_hash: artifact.evidence_hash || p.evidenceHash || null,
      source_set_hash: artifact.source_set_hash || p.sourceSetHash || null,
      cache: p.cache || null,
      validator_outcome: artifact.validator_outcome || null,
      ...p.metadata,
    },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'No authorization header' }, 401)

    const body = await req.json()
    const { orgId, artifactType, entity, entityId, context, extra, staleMinutes = 30, force = false } = body || {}
    // narrative_brief is a GLOBAL, market-wide artifact (no entity, no org) generated
    // by the narrative-refresh cron and reused by everyone via intel_shared_artifacts.
    // It bypasses the org-scoped flow entirely (no research_artifacts copy).
    if (artifactType === 'narrative_brief') return await handleNarrativeBrief(req, body)
    if (!orgId || !artifactType) return json({ error: 'orgId and artifactType required' }, 400)

    const apiKey = Deno.env.get('OPENAI_API_KEY')
    if (!apiKey) return json({ error: 'OPENAI_API_KEY not configured' }, 500)

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    )
    const { data: auth } = await supabase.auth.getUser()
    const userId = auth?.user?.id || null

    // Resolve the entity row if only an id was passed.
    let ent = entity
    if (!ent && entityId) {
      const { data } = await supabase.from('entities').select('*').eq('id', entityId).maybeSingle()
      ent = data
    }
    const { data: profile } = await supabase.from('intel_user_profiles').select('*').eq('org_id', orgId).maybeSingle()

    // Service-role client (shared artifacts, force log, cost ledger) + the precise
    // ledger emitter — every cost-relevant DECISION below records exactly one event.
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const costWriter = makeCostWriter(admin)
    // deno-lint-ignore no-explicit-any
    const logCost = (ev: any) => recordCostEvent(costWriter, { feature: artifactType, orgId, artifactType, subjectRef: ent?.canonical_ref_key || null, ...ev }, { precision: 'exact', nowMs: Date.now() })

    const inputHash = hashStr(JSON.stringify({ artifactType, ref: ent?.canonical_ref_key || null, context: context || null, extra: extra || null }))
    const cacheKey = `${artifactType}:${inputHash}:v1`

    // Cache check.
    if (!force) {
      const { data: cached } = await supabase
        .from('research_artifacts')
        .select('*')
        .eq('org_id', orgId).eq('cache_key', cacheKey).eq('status', 'ready')
        .order('created_at', { ascending: false }).limit(1).maybeSingle()
      if (cached && (!cached.stale_after || new Date(cached.stale_after).getTime() > Date.now())) {
        await recordIntelEvent(supabase, { orgId, userId, eventType: artifactType, subjectKind: ent?.entity_kind, subjectKey: ent?.canonical_ref_key, artifactId: cached.id, model: cached.model, metadata: { cache: 'hit' } })
        await recordArtifactDecisionMemory(supabase, { orgId, userId, artifactType, ent, artifact: cached, decisionKind: 'artifact_cache_hit', cache: 'hit' })
        void logCost({ cacheStatus: 'hit', reuseKind: cached.reuse_kind || null, model: null, evidenceHash: cached.evidence_hash || null, providerCallsAvoided: 1, allowReason: 'n/a_no_ai' })
        return json({ artifact: cached, cached: true })
      }
    }

    // ── Explain This: deterministic context routing + similarity reuse (no AI) ──
    // The question is HMAC-hashed (server secret + org salt) — raw questions, raw
    // shingles, and unsalted hashes are never stored. routed_context is in-memory
    // grounding only.
    // deno-lint-ignore no-explicit-any
    let explainHashes: any = null
    // deno-lint-ignore no-explicit-any
    let explainRouted: any = null
    // Asset key for explain reuse scoping (migration 286) — derived once, used to
    // pin similarity reuse to the SAME asset and persisted on the artifact row.
    let explainSubjectKey: string | null = null
    if (artifactType === 'explain') {
      try { explainSubjectKey = explainSubjectKeyFor(deriveExplainEvidenceSubject({ extra, context, ent, orgId, userId })) } catch { /* identity best-effort */ }
      try { explainHashes = await computeQuestionHashes(extra?.question || JSON.stringify(extra || {}), orgId) } catch { /* hashing unavailable → no similarity */ }
      if (!force && explainHashes) {
        const hit = await similarRecentExplain(supabase, { orgId, entityId: ent?.id || null, subjectKey: explainSubjectKey, hashes: explainHashes })
        // Defense-in-depth: when we have an asset key, the reused artifact MUST be the
        // same asset (never serve a different token even if keying drifts or a legacy
        // null-key row slips through).
        if (hit && (!explainSubjectKey || hit.artifact.explain_subject_key === explainSubjectKey)) {
          await recordIntelEvent(supabase, { orgId, userId, eventType: artifactType, subjectKind: ent?.entity_kind, subjectKey: ent?.canonical_ref_key, artifactId: hit.artifact.id, model: hit.artifact.model, metadata: { cache: 'explain_similar', similarity: hit.similarity, kind: hit.kind } })
          void logCost({ cacheStatus: 'explain_similar', reuseKind: 'explain_similar', model: null, providerCallsAvoided: 1, allowReason: 'n/a_no_ai', usage: { similarity: hit.similarity } })
          return json({ artifact: hit.artifact, cached: true, similar: hit.similarity, reuse_kind: 'explain_similar' })
        }
      }
      try { explainRouted = await routeExplainContext(supabase, { orgId, question: extra?.question, entity: ent }) } catch { /* routing best-effort */ }
    }

    // Deterministic evidence package (cheap, no AI) — drives reuse keying + the
    // multi-model decision. Built before any spend so a shared-artifact hit can
    // short-circuit before live API calls + AI.
    const EVIDENCE_TYPES = ['token_breakdown', 'risk_panel', 'narrative_report', 'defi_report', 'execution_report', 'thesis_review', 'wallet_summary', 'alert_explanation', 'daily_brief', 'token_comparison']
    let pkg: any = null
    if (EVIDENCE_TYPES.includes(artifactType)) {
      try {
        const cid = ent ? chainIdFor(ent.chain_namespace, ent.chain_id) : null
        const evSymbols = ent?.display_symbol ? [ent.display_symbol] : (Array.isArray(extra?.symbols) ? extra.symbols : [])
        const evChains = cid ? [cid] : (Array.isArray(extra?.chains) ? extra.chains : [])
        pkg = await buildEvidence(supabase, { orgId, symbols: evSymbols, chains: evChains, holdings: Array.isArray(extra?.holdings) ? extra.holdings : [], limit: artifactType === 'daily_brief' ? 12 : 8 })
      } catch { /* best-effort */ }
    }

    // Stage F1/F4: public asset evidence packs for asset-keyed artifacts. This runs
    // before shared-cache lookup so the pack content hash participates in the
    // reusable evidence key. The subject is intentionally public-scope for these
    // shared artifact types; Explain keeps its D/E private-scoped path below.
    const F_ASSET_PACK_TYPES = ['token_breakdown', 'risk_panel', 'token_comparison', 'thesis_review']
    // deno-lint-ignore no-explicit-any
    let assetEvidenceContext: any = null
    let assetEvidenceHash: string | null = null
    if (F_ASSET_PACK_TYPES.includes(artifactType)) {
      try {
        const subjects = assetSubjectsForArtifact({ artifactType, extra, context, ent, orgId, userId }).slice(0, artifactType === 'token_comparison' ? 4 : 1)
        const packs = []
        for (const subject of subjects) {
          let assetPack = await getOrAssembleAssetEvidencePack(admin, subject, { staleMinutes: 30 })
          assetPack = await maybeRefreshCriticalEvidencePack(admin, subject, assetPack, orgId, userId)
          const compactPack = compactAssetEvidencePackForPrompt(assetPack, artifactType === 'token_comparison' ? 5200 : 9000)
          if (compactPack) packs.push(compactPack)
        }
        if (packs.length) {
          const packHashes = packs.map((pack) => String((pack as Record<string, any>).content_hash || '')).filter(Boolean)
          assetEvidenceHash = hashStr(JSON.stringify({ artifactType, packHashes }))
          const coverage = packCoverageFromContext({ asset_evidence_packs: packs })
          assetEvidenceContext = artifactType === 'token_comparison'
            ? {
              asset_evidence_packs: packs,
              asset_comparison_evidence: { packs, data_coverage: coverage },
            }
            : { asset_evidence_pack: packs[0] }
          if (pkg) {
            const items = Array.isArray(pkg.items) ? pkg.items : []
            const coverageMerged = mergeCoverageValues([pkg.coverage, coverage]) || pkg.coverage
            pkg = {
              ...pkg,
              evidence_hash: hashStr(`${pkg.evidence_hash || ''}:asset-pack:${assetEvidenceHash}`),
              source_set_hash: hashStr(`${pkg.source_set_hash || ''}:asset-pack:${assetEvidenceHash}`),
              coverage: coverageMerged,
              items: [
                ...items,
                {
                  kind: 'asset_evidence_pack',
                  source: 'cached provider snapshots',
                  subject_count: packs.length,
                  content_hashes: packHashes,
                },
              ],
              final_count: Number(pkg.final_count || items.length) + 1,
            }
          }
        }
      } catch { /* F1 grounding is additive; original artifact path still works */ }
    }

    // Stage F2: Daily Brief gets one aggregate pack assembled from cached macro,
    // rankings, narrative category, protocol/chain TVL, flow, and watchlist mini
    // packs. It is org-scoped but still no-live-provider and participates in the
    // evidence hash before shared/delta decisions.
    // deno-lint-ignore no-explicit-any
    let briefEvidenceContext: any = null
    if (artifactType === 'daily_brief') {
      try {
        const briefPack = await assembleBriefEvidencePack(admin, {
          orgId,
          watchlistSymbols: Array.isArray(extra?.symbols) ? extra.symbols : undefined,
          holdings: Array.isArray(extra?.holdings) ? extra.holdings : undefined,
          maxAssets: 8,
        })
        briefEvidenceContext = { brief_evidence_pack: briefPack }
        if (pkg) {
          const items = Array.isArray(pkg.items) ? pkg.items : []
          const coverageMerged = mergeCoverageValues([pkg.coverage, briefPack.data_coverage]) || pkg.coverage
          pkg = {
            ...pkg,
            evidence_hash: hashStr(`${pkg.evidence_hash || ''}:brief-pack:${briefPack.content_hash}`),
            source_set_hash: hashStr(`${pkg.source_set_hash || ''}:brief-pack:${briefPack.content_hash}`),
            coverage: coverageMerged,
            items: [
              ...items,
              {
                kind: 'brief_evidence_pack',
                source: 'cached macro/regime/protocol/flow/watchlist snapshots',
                content_hash: briefPack.content_hash,
                watchlist_count: briefPack.org_scope.watchlist_count,
                holding_count: briefPack.org_scope.holding_count,
              },
            ],
            final_count: Number(pkg.final_count || items.length) + 1,
          }
        }
      } catch { /* brief evidence is additive; original brief generation still works */ }
    }

    // Stage F3: narrative reports get member asset mini-packs plus category/macro
    // rotation and narrative source signals. Public/global only, so shared reuse
    // remains identity-stripped.
    // deno-lint-ignore no-explicit-any
    let narrativeEvidenceContext: any = null
    if (artifactType === 'narrative_report') {
      try {
        const slug = narrativeSlugFromContext(extra, context, ent)
        if (slug) {
          const narrativePack = await assembleNarrativeEvidencePack(admin, slug, { maxAssets: 8 })
          narrativeEvidenceContext = { narrative_evidence_pack: narrativePack }
          if (pkg) {
            const items = Array.isArray(pkg.items) ? pkg.items : []
            const coverageMerged = mergeCoverageValues([pkg.coverage, narrativePack.data_coverage]) || pkg.coverage
            pkg = {
              ...pkg,
              evidence_hash: hashStr(`${pkg.evidence_hash || ''}:narrative-pack:${narrativePack.content_hash}`),
              source_set_hash: hashStr(`${pkg.source_set_hash || ''}:narrative-pack:${narrativePack.content_hash}`),
              coverage: coverageMerged,
              items: [
                ...items,
                {
                  kind: 'narrative_evidence_pack',
                  source: 'cached narrative/member-asset intelligence',
                  slug,
                  content_hash: narrativePack.content_hash,
                },
              ],
              final_count: Number(pkg.final_count || items.length) + 1,
            }
          }
        }
      } catch { /* narrative evidence is additive; original report path still works */ }
    }

    // Reusable SHARED artifact: when the evidence package is PUBLIC (no private
    // custom source contributed), the expensive multi-model analysis is generated
    // ONCE and reused across all users. On a fresh hit, copy the shared structured
    // into an org artifact (no AI) so the user keeps history + Save. Exempt from
    // gate/rate because it incurs no new AI cost.
    const sharedKey = pkg ? { artifact_type: artifactType, entity_ref: ent?.canonical_ref_key || '', evidence_hash: pkg.evidence_hash, contract_version: CONTRACT_VERSION, guardrail_version: GUARDRAIL_VERSION } : null
    if (!force && pkg?.reusable && sharedKey) {
      const { data: shared } = await admin.from('intel_shared_artifacts').select('*').match(sharedKey).order('created_at', { ascending: false }).limit(1).maybeSingle()
      if (shared && (!shared.stale_after || new Date(shared.stale_after).getTime() > Date.now())) {
        const orgRow = orgArtifactRow({ orgId, userId, artifactType, ent, extra, structured: shared.structured, inputHash, cacheKey, staleAfter: shared.stale_after, model: (shared.models || []).join('+') || 'shared', validationStatus: shared.validation_status || 'passed', sources: shared.sources, validatorOutcome: { reused_shared: shared.id, consensus: shared.consensus }, evidenceHash: pkg.evidence_hash, sourceSetHash: pkg.source_set_hash, reuseKind: 'shared_copy' })
        const { data: copy } = await insertArtifact(supabase, orgRow)
        await recordIntelEvent(supabase, { orgId, userId, eventType: artifactType, subjectKind: ent?.entity_kind, subjectKey: ent?.canonical_ref_key, artifactId: copy?.id, model: (shared.models || []).join('+'), metadata: { cache: 'shared_hit', shared_id: shared.id, consensus: shared.consensus, evidence_items: pkg.final_count } })
        await recordArtifactDecisionMemory(supabase, { orgId, userId, artifactType, ent, artifact: copy || { ...orgRow, structured: shared.structured }, sharedArtifactId: shared.id, decisionKind: 'artifact_shared_reuse', cache: 'shared_hit', evidenceHash: pkg.evidence_hash, sourceSetHash: pkg.source_set_hash, metadata: { consensus: shared.consensus, evidence_items: pkg.final_count } })
        void logCost({ cacheStatus: 'shared_hit', reuseKind: 'shared_copy', model: null, evidenceHash: pkg.evidence_hash, sourceSetHash: pkg.source_set_hash, providerCallsAvoided: 1, allowReason: 'n/a_no_ai' })
        return json({ artifact: copy || shared, cached: true, shared: true, consensus: shared.consensus })
      }
    }

    // ── Force refresh: an expensive override, plan-limited + cooled down (215) ──
    // Bypasses STALENESS ONLY — the kill switch, monthly cap, and per-artifact
    // daily rate limits below still apply.
    if (force) {
      try {
        const { data: fr } = await supabase.rpc('intel_force_refresh_allowed', { p_artifact_type: artifactType, p_entity_ref: ent?.canonical_ref_key || null })
        if (fr && fr.allowed === false) return json({ error: 'force_refresh_limited', reason: fr.reason, used: fr.used, limit: fr.limit, cooldown_until: fr.cooldown_until }, 429)
        if (fr) void admin.from('intel_force_refresh_log').insert({ org_id: orgId, user_id: userId, artifact_type: artifactType, entity_ref: ent?.canonical_ref_key || null })
      } catch { /* RPC absent pre-migration → allow (normal gates still apply) */ }
    }

    // Current stored Intel Signal for the subject (cached read; absent table → null).
    // deno-lint-ignore no-explicit-any
    let signalSnap: any = null
    if (ent?.display_symbol) {
      try {
        const sym = String(ent.display_symbol).toUpperCase().replace(/^\$/, '')
        const { data: sig } = await supabase.from('intel_signal_state')
          .select('direction, global_score, source_count, severity, score_delta, generated_at')
          .eq('subject_type', 'asset').eq('display_symbol', sym)
          .order('generated_at', { ascending: false }).limit(1).maybeSingle()
        signalSnap = sig || null
      } catch { /* signal store not deployed yet */ }
    }

    // ── Reuse decision vs the most-recent prior artifact for these EXACT inputs ──
    // magnitude none → extend stale_after and return (zero AI — today this case
    // re-runs the full multi-model synthesis). minor/material → cheap DELTA below.
    const DELTA_TYPES = ['token_breakdown', 'risk_panel', 'narrative_report', 'defi_report', 'execution_report', 'wallet_summary', 'token_comparison', 'thesis_review']
    // deno-lint-ignore no-explicit-any
    let deltaPlan: any = null
    if (!force && pkg) {
      try {
        const { data: prior } = await supabase.from('research_artifacts')
          .select('id, structured, evidence_hash, signal_snapshot, stale_after, created_at')
          .eq('org_id', orgId).eq('cache_key', cacheKey).eq('status', 'ready').not('evidence_hash', 'is', null)
          .gte('created_at', new Date(Date.now() - 14 * 86_400_000).toISOString())
          .order('created_at', { ascending: false }).limit(1).maybeSingle()
        if (prior) {
          // deno-lint-ignore no-explicit-any
          const ss: any = prior.signal_snapshot || {}
          const verdict = materialityVerdict({
            prevEvidenceHash: prior.evidence_hash, newEvidenceHash: pkg.evidence_hash,
            prevSignal: ss.direction ? { polarity: ss.direction, score: ss.global_score, source_count: ss.source_count } : null,
            newSignal: signalSnap ? { polarity: signalSnap.direction, score: signalSnap.global_score, source_count: signalSnap.source_count } : null,
          })
          if (verdict.magnitude === 'none') {
            const newStale = new Date(Date.now() + staleMinutes * 60_000).toISOString()
            await supabase.from('research_artifacts').update({ stale_after: newStale, reuse_kind: 'reuse_stale_unchanged' }).eq('id', prior.id)
            const { data: full } = await supabase.from('research_artifacts').select('*').eq('id', prior.id).maybeSingle()
            await recordIntelEvent(supabase, { orgId, userId, eventType: artifactType, subjectKind: ent?.entity_kind, subjectKey: ent?.canonical_ref_key, artifactId: prior.id, metadata: { cache: 'reuse_unchanged' } })
            await recordArtifactDecisionMemory(supabase, { orgId, userId, artifactType, ent, artifact: full || prior, decisionKind: 'artifact_reuse_unchanged', cache: 'reuse_unchanged', evidenceHash: pkg.evidence_hash, sourceSetHash: pkg.source_set_hash, metadata: { drivers: verdict.drivers } })
            void logCost({ cacheStatus: 'reuse_unchanged', reuseKind: 'reuse_stale_unchanged', model: null, evidenceHash: pkg.evidence_hash, sourceSetHash: pkg.source_set_hash, providerCallsAvoided: 1, allowReason: 'n/a_no_ai' })
            return json({ artifact: full || prior, cached: true, reused: true, reuse_kind: 'reuse_stale_unchanged' })
          }
          if (DELTA_TYPES.includes(artifactType) && typeof prior.structured?.summary === 'string') {
            deltaPlan = { prior, drivers: verdict.drivers.length ? verdict.drivers : ['evidence set changed'], magnitude: verdict.magnitude }
          }
        }
      } catch { /* 215 columns absent → fresh path */ }
    }

    // Governance gate: global kill switch + monthly cost cap (cache hits above
    // are exempt because they incur no new cost).
    const { data: gate } = await supabase.rpc('intel_generation_allowed')
    if (gate && gate.allowed === false) {
      return json({ error: 'generation_not_allowed', reason: gate.reason, used: gate.used, cap: gate.cap }, 402)
    }

    // Per-tier daily-rate limit by artifact category.
    const RATE_KEY: Record<string, string> = {
      token_breakdown: 'breakdowns_per_day', risk_panel: 'breakdowns_per_day', wallet_summary: 'breakdowns_per_day',
      narrative_report: 'breakdowns_per_day', defi_report: 'breakdowns_per_day', execution_report: 'breakdowns_per_day',
      explain: 'explain_per_day', token_comparison: 'comparisons_per_day', daily_brief: 'briefs_per_day',
    }
    const rateKey = RATE_KEY[artifactType]
    if (rateKey) {
      const { data: rate } = await supabase.rpc('intel_rate_check', { p_limit_key: rateKey })
      if (rate && rate.allowed === false) return json({ error: 'rate_limited', reason: rateKey, used: rate.used, limit: rate.limit }, 429)
    }

    // ── DELTA path: cheap single-model UPDATE of the prior artifact ──────────────
    // Evidence changed (minor/material) vs a recent full answer → narrate the diff
    // with gpt-5.4-mini instead of redoing the full (multi-model) analysis. Skips
    // live provider grounding entirely; gated by the same kill switch + rate above.
    if (deltaPlan) {
      const dp = buildDeltaPrompt({
        artifactType, entity: ent, profile,
        priorSummary: deltaPlan.prior.structured?.summary || '',
        priorNetSignal: deltaPlan.prior.structured?.net_signal || null,
        drivers: deltaPlan.drivers,
        context: { evidence_package: pkg?.items || [], evidence_coverage: pkg?.coverage || null, current_signal: signalSnap },
      })
      const r = await callOpenAI(dp.model, dp.system, dp.user, apiKey)
      // deno-lint-ignore no-explicit-any
      let structuredD: any
      try { structuredD = JSON.parse(r.content) } catch { structuredD = { summary: r.content, confidence: 'low', sources: [] } }
      let usageD = r.usage
      void recordAIUsage(supabase, { orgId, userId, provider: 'openai', model: dp.model, surface: 'investor_intel', subMode: `${artifactType}:delta`, providerUsage: usageD, status: 'success' })

      let validationD = validateSafeLanguage(textOfArtifact(structuredD))
      let outcomeD: 'pass' | 'rewrite' | 'block' = 'pass'
      if (!validationD.ok) {
        const fixSystem = `${dp.system}\n\nYour previous answer used advice-style language (${validationD.hits.map((h) => h.label).join(', ')}). Rewrite it to be strictly research/risk context. ${SAFE_LANGUAGE_RULES}`
        const retry = await callOpenAI(dp.model, fixSystem, `${dp.user}\n\nPrevious JSON to fix:\n${JSON.stringify(structuredD).slice(0, 8000)}`, apiKey)
        try { structuredD = JSON.parse(retry.content) } catch { /* keep prior */ }
        usageD = retry.usage
        validationD = validateSafeLanguage(textOfArtifact(structuredD))
        outcomeD = validationD.ok ? 'rewrite' : 'block'
      }
      structuredD = reconcileCoverage(structuredD, ['Delta update on prior analysis'], packCoverageFromContext({ evidence_coverage: pkg?.coverage || null, current_signal: signalSnap }))
      const contractD = validateArtifactContract(structuredD, DELTA_REQUIRED_FIELDS)
      const blockedD = !validationD.ok
      const validationStatusD = blockedD ? 'blocked' : (outcomeD === 'rewrite' ? 'rewritten' : 'passed')
      const staleAfterD = new Date(Date.now() + staleMinutes * 60_000).toISOString()
      const rowD = orgArtifactRow({
        orgId, userId, artifactType, ent, extra, structured: structuredD, inputHash, cacheKey, staleAfter: staleAfterD,
        model: dp.model, validationStatus: validationStatusD, sources: ['Delta update on prior analysis'],
        validatorOutcome: { hits: validationD.hits, contract_missing: contractD.missing, base_artifact_id: deltaPlan.prior.id, drivers: deltaPlan.drivers },
        evidenceHash: pkg?.evidence_hash, sourceSetHash: pkg?.source_set_hash, signalSnapshot: signalSnap || {},
        baseArtifactId: deltaPlan.prior.id, reuseKind: 'delta',
      })
      const { data: artifactD, error: errD } = await insertArtifact(supabase, rowD)
      if (errD) throw errD
      await recordIntelEvent(supabase, {
        orgId, userId, eventType: artifactType, subjectKind: ent?.entity_kind, subjectKey: ent?.canonical_ref_key,
        artifactId: artifactD.id, model: dp.model, tokensIn: usageD?.prompt_tokens, tokensOut: usageD?.completion_tokens,
        validatorOutcome: outcomeD, metadata: { cache: 'delta', magnitude: deltaPlan.magnitude, base_artifact_id: deltaPlan.prior.id },
      })
      await recordArtifactDecisionMemory(supabase, { orgId, userId, artifactType, ent, artifact: artifactD, decisionKind: 'artifact_delta_update', cache: 'delta', reasoningSummary: structuredD?.summary || null, evidenceHash: pkg?.evidence_hash, sourceSetHash: pkg?.source_set_hash, metadata: { magnitude: deltaPlan.magnitude, base_artifact_id: deltaPlan.prior.id, drivers: deltaPlan.drivers } })
      void logCost({
        cacheStatus: 'delta', reuseKind: 'delta', model: dp.model,
        evidenceHash: pkg?.evidence_hash, sourceSetHash: pkg?.source_set_hash,
        allowReason: deltaPlan.magnitude === 'material' ? 'evidence_changed_material' : 'evidence_changed_minor',
        usage: { tokens_in: usageD?.prompt_tokens, tokens_out: usageD?.completion_tokens },
      })
      if (blockedD) return json({ artifact: artifactD, blocked: true, reason: 'safety_validation_failed' }, 200)
      return json({ artifact: artifactD, cached: false, delta: true, base_artifact_id: deltaPlan.prior.id, change_drivers: deltaPlan.drivers })
    }

    // Ground artifacts in live provider data (graceful: null → missing_context).
    let genContext = context
    const sourcesUsed: string[] = []
    let evidenceCount = 0
    const beKey = Deno.env.get('BIRDEYE_API_KEY')
    const beChain = ent ? birdeyeChainFor(ent.chain_namespace, ent.chain_id) : null
    // One AI run grounds on at most a couple of tokens → 'request' budget. All
    // calls flow through the centralized client (cached, capped, logged).
    const beCtx = { supabase, jobName: 'intel-generate', caller: 'ai-run', kind: 'request' as const }
    const live: Record<string, unknown> = {}
    if (beKey && beChain && ent?.contract_address && ['token_breakdown', 'risk_panel', 'execution_report', 'defi_report', 'thesis_review'].includes(artifactType)) {
      const market = await birdeyeOverview(beChain, ent.contract_address, beKey, beCtx)
      if (market) { live.birdeye_market = market; sourcesUsed.push('Birdeye market data') }
    }
    if (beKey && beChain && artifactType === 'wallet_summary' && ent?.wallet_address) {
      const pf = await birdeyeWalletPortfolio(beChain, ent.wallet_address, beKey, beCtx)
      if (pf) { live.wallet_portfolio = pf; sourcesUsed.push('Birdeye wallet portfolio') }
    }
    if (artifactType === 'execution_report' && ent?.chain_namespace === 'solana' && ent?.contract_address) {
      const ex = await dflowExecutionForSolanaToken(ent.contract_address)
      if (ex) { live.dflow_execution = ex; sourcesUsed.push('DFlow quote') }
    }
    if (artifactType === 'defi_report' && ent?.chain_namespace === 'solana' && (ent?.contract_address || ent?.asset_id)) {
      const k = await kaminoForAddress(ent.contract_address || ent.asset_id)
      if (k) { live.kamino = k; sourcesUsed.push('Kamino') }
    }
    // Non-Solana defi_report → ground on DeFiLlama yields (free, all chains).
    if (artifactType === 'defi_report' && ent?.chain_namespace !== 'solana' && (ent?.contract_address || ent?.asset_id)) {
      const slug = chainIdFor(ent.chain_namespace, ent.chain_id)
      if (slug) {
        const ll = await defiLlamaForPool(ent.contract_address || ent.asset_id, slug)
        if (ll) { live.defillama = ll; sourcesUsed.push('DeFiLlama') }
      }
    }
    if (Object.keys(live).length) genContext = { ...(context || {}), ...live, _fetched_at: new Date().toISOString() }

    // Inject the (already-built) ranked evidence package into the gen context.
    if (pkg && (pkg.items.length || pkg.coverage)) {
      genContext = { ...(genContext || context || {}), evidence_package: pkg.items, evidence_coverage: pkg.coverage, evidence_scope_hint: pkg.scope_hint }
      evidenceCount = pkg.items.length
      if (pkg.items.length) sourcesUsed.push('Signal Layer / news corpus')
    }
    if (assetEvidenceContext) {
      genContext = { ...(genContext || context || {}), ...assetEvidenceContext }
      sourcesUsed.push('Asset evidence pack (cached provider snapshots)')
    }
    if (briefEvidenceContext) {
      genContext = { ...(genContext || context || {}), ...briefEvidenceContext }
      sourcesUsed.push('Daily brief evidence pack (cached intelligence snapshots)')
    }
    if (narrativeEvidenceContext) {
      genContext = { ...(genContext || context || {}), ...narrativeEvidenceContext }
      sourcesUsed.push('Narrative evidence pack (cached member asset snapshots)')
    }

    // Market regime context (one cached global read) so impact analysis is
    // regime-aware (e.g. "in a BTC-led tape, this alt's move is…").
    if (['token_breakdown', 'risk_panel', 'narrative_report', 'token_comparison', 'thesis_review', 'daily_brief'].includes(artifactType)) {
      try {
        const { data: reg } = await supabase.rpc('intel_current_regime')
        const r = Array.isArray(reg) ? reg[0] : reg
        if (r) genContext = { ...(genContext || context || {}), market_regime: { regime: r.regime, flavor: r.flavor, confidence: r.confidence, majors: r.majors } }
      } catch { /* best-effort */ }
    }

    // Exchange market grounding — reads cached latest tables + RAG memory (no live
    // exchange calls). The c3 grounding rule tells the model to use the
    // exchange_market block for exact metrics and say so when absent (never invent).
    if (['token_breakdown', 'risk_panel', 'explain', 'token_comparison', 'narrative_report', 'defi_report', 'execution_report', 'thesis_review', 'daily_brief'].includes(artifactType)) {
      try {
        const sym = ent?.display_symbol ? String(ent.display_symbol).toUpperCase().replace(/^\$/, '') : null
        if (sym) {
          const [sigR, tkR, capR, sprR] = await Promise.all([
            supabase.from('exchange_latest_market_signals').select('direction, strength, confidence, title, summary, why_it_matters, provider_count, confirming_providers').eq('normalized_symbol', sym).maybeSingle(),
            supabase.from('exchange_latest_tickers').select('provider, provider_symbol, price_change_pct_24h, volume_quote_24h, spread_pct, as_of').eq('normalized_symbol', sym).order('volume_quote_24h', { ascending: false }).limit(1).maybeSingle(),
            supabase.from('exchange_latest_market_caps').select('market_cap, market_cap_source, circulating_supply, fdv, is_estimated, confidence_score, as_of').eq('normalized_symbol', sym).maybeSingle(),
            supabase.from('exchange_latest_cross_market_spreads').select('buy_provider, sell_provider, gross_spread_pct, estimated_net_spread_pct, caution_flags').eq('normalized_symbol', sym).maybeSingle(),
          ])
          if (sigR.data || tkR.data || capR.data) {
            genContext = { ...(genContext || context || {}), exchange_market: { symbol: sym, as_of: new Date().toISOString(), signal: sigR.data || null, ticker: tkR.data || null, market_cap: capR.data || null } }
            sourcesUsed.push('Exchange market data (Binance/Coinbase/Kraken/KuCoin)')
          }
          if (sprR.data) genContext = { ...(genContext || context || {}), exchange_market_spread: sprR.data }
          const memBlock = await buildMarketMemoryPromptBlock(supabase, { query: `${sym} market context, liquidity, signal, trend`, symbol: sym, openaiKey: apiKey })
          if (memBlock) genContext = { ...(genContext || context || {}), exchange_market_memory: memBlock }
        }
      } catch { /* best-effort grounding */ }
    }

    // Explain This: ground the answer in the user's OWN cached context (routed
    // deterministically above) — in memory only, never persisted.
    if (artifactType === 'explain' && explainRouted && Object.keys(explainRouted.routed_context || {}).length) {
      genContext = { ...(genContext || context || {}), user_context: explainRouted.routed_context }
      sourcesUsed.push('Your watchlist / theses / alerts / signals context')
    }

    // Stage D2: Explain This can consume a compact asset evidence pack assembled
    // from materialized snapshot tables. This is gated to explain + asset
    // identity only; non-explain artifact paths keep the existing provider/read
    // behavior. Critical stale slices rebuild this pack from cached tables once,
    // recording a budgeted planner event with zero live provider calls.
    if (artifactType === 'explain') {
      try {
        const subject = deriveExplainEvidenceSubject({ extra, context, ent, orgId, userId })
        if (subject) {
          let assetPack = await getOrAssembleAssetEvidencePack(admin, subject, { staleMinutes: 30 })
          assetPack = await maybeRefreshCriticalEvidencePack(admin, subject, assetPack, orgId, userId)
          const compactPack = compactAssetEvidencePackForPrompt(assetPack, 12000)
          if (compactPack) {
            genContext = { asset_evidence_pack: compactPack, ...(genContext || context || {}) }
            sourcesUsed.push('Asset evidence pack (cached provider snapshots)')
          }
        }
      } catch { /* evidence packs are additive; explain still works without them */ }
    }

    // Platform-wide derived memory. This prefers stored/derived intelligence
    // (signals, events, decision memory) over raw feeds and respects the
    // Investor Intel surface policy. Private KB stays opt-in elsewhere.
    try {
      const entityRefs = ent?.canonical_ref_key ? [ent.canonical_ref_key] : []
      const narrativeRefs = ent?.entity_kind === 'narrative' && ent?.canonical_ref_key ? [ent.canonical_ref_key] : []
      const ctx = await assembleIntelligenceContext(supabase, {
        surface: 'investor_intel',
        orgId,
        query: `${artifactType} ${ent?.display_symbol || ent?.canonical_ref_key || ''}`.trim(),
        entityRefs,
        narrativeRefs,
        includePrivateKnowledge: false,
        limit: 8,
      })
      if (ctx.blocks.length) {
        genContext = {
          ...(genContext || context || {}),
          platform_intelligence_context: ctx.blocks.map((b) => ({
            memory_class: b.memory_class,
            title: b.title,
            summary: b.summary,
            freshness_class: b.freshness_class,
            confidence: b.confidence,
            rank_score: b.rank_score,
            entity_refs: b.entity_refs,
            narrative_refs: b.narrative_refs,
            source_refs: b.source_refs,
          })),
          platform_intelligence_policy: {
            surface: ctx.policy.surface_key,
            derived_over_raw: ctx.policy.derived_over_raw,
            restricted_license_policy: ctx.policy.restricted_license_policy,
          },
        }
        sourcesUsed.push('Platform intelligence memory')
      }
    } catch { /* best-effort memory grounding */ }

    const required = requiredFieldsFor(artifactType, { hasAssetEvidence: !!(genContext as { asset_evidence_pack?: unknown })?.asset_evidence_pack })
    const { system, user, model } = buildPrompt(artifactType, { entity: ent, context: genContext, profile, extra })

    // Multi-model synthesis (Grok + OpenAI + Gemini → OpenAI synthesis) runs ONLY
    // after evidence reduction + cache miss, for heavy analytical types with
    // strong-enough evidence. Everything else uses the single-model path.
    // defi_report is intentionally single-model: its pool-framed contract is
    // data-driven (yield/TVL/risk), not a contested market read that benefits
    // from multi-model debate — and single-model guarantees the pool schema.
    const MULTI_TYPES = ['token_breakdown', 'risk_panel', 'narrative_report', 'thesis_review', 'daily_brief', 'token_comparison', 'execution_report']
    const xaiKey = Deno.env.get('XAI_API_KEY') || Deno.env.get('GROK_API_KEY')
    const geminiKey = Deno.env.get('GEMINI_API_KEY')
    const useMulti = MULTI_TYPES.includes(artifactType) && pkg?.strong === true

    let structured: any = null
    let usage: any = null
    let modelUsed = model
    let consensus: string | null = null
    let providerMeta: any = null

    if (useMulti) {
      const mm = await multiModelAnalyze({
        entity: ent, evidence: genContext, baseSystem: system,
        task: `Produce your independent read for a ${artifactType.replace(/_/g, ' ')} (research / risk context, not advice).`,
        keys: { openai: apiKey, xai: xaiKey, gemini: geminiKey },
      })
      if (mm) {
        structured = mm.structured
        usage = mm.usage?.synth || null
        consensus = mm.consensus
        modelUsed = `synth:${intelModel('standard')}(${mm.providersUsed.join('+')})`
        providerMeta = { providers: mm.providersUsed, statuses: mm.statuses, consensus: mm.consensus, synth_failed: !!mm.synthFailed }
        for (const [prov, u] of Object.entries(mm.usage || {})) {
          const pmodel = prov === 'grok' ? (Deno.env.get('GROK_MODEL') || 'grok-4.3') : prov === 'gemini' ? (Deno.env.get('GEMINI_MODEL') || 'gemini-2.5-flash') : prov === 'synth' ? intelModel('standard') : intelModel('bulk')
          void recordAIUsage(supabase, { orgId, userId, provider: prov === 'grok' ? 'grok' : prov === 'gemini' ? 'gemini' : 'openai', model: pmodel, surface: 'investor_intel', subMode: `${artifactType}:${prov}`, providerUsage: u, status: 'success' })
        }
      }
    }

    // Single-model path: thin evidence, private package, light type, or multi unavailable.
    if (!structured) {
      const r = await callOpenAI(model, system, user, apiKey)
      usage = r.usage
      try { structured = JSON.parse(r.content) } catch { structured = { summary: r.content, confidence: 'low', sources: [] } }
      void recordAIUsage(supabase, { orgId, userId, provider: 'openai', model, surface: 'investor_intel', subMode: artifactType, providerUsage: usage, status: 'success' })
    }

    // Validate safety + contract; one constrained rewrite on a hard hit.
    let validation = validateSafeLanguage(textOfArtifact(structured))
    let validatorOutcome: 'pass' | 'rewrite' | 'block' = 'pass'
    if (!validation.ok) {
      // Validation-gated escalation: a guardrail miss is the ONLY place Intel reaches for
      // a higher tier (gpt-5.4, never gpt-5.5). Record the rewrite so its cost is visible.
      const escalateModel = intelModel('escalate')
      const fixSystem = `${system}\n\nYour previous answer used advice-style language (${validation.hits.map((h) => h.label).join(', ')}). Rewrite it to be strictly research/risk context. ${SAFE_LANGUAGE_RULES}`
      const retry = await callOpenAI(escalateModel, fixSystem, `${user}\n\nPrevious JSON to fix:\n${JSON.stringify(structured).slice(0, 8000)}`, apiKey)
      try { structured = JSON.parse(retry.content) } catch { /* keep prior */ }
      usage = retry.usage
      modelUsed = `${modelUsed}→escalate:${escalateModel}`
      void recordAIUsage(supabase, { orgId, userId, provider: 'openai', model: escalateModel, surface: 'investor_intel', subMode: `${artifactType}:escalate_rewrite`, providerUsage: retry.usage, status: 'success' })
      validation = validateSafeLanguage(textOfArtifact(structured))
      validatorOutcome = validation.ok ? 'rewrite' : 'block'
    }
    structured = reconcileCoverage(structured, sourcesUsed, packCoverageFromContext(genContext))
    const contract = validateArtifactContract(structured, required)
    const blocked = !validation.ok
    const validationStatus = blocked ? 'blocked' : (validatorOutcome === 'rewrite' ? 'rewritten' : 'passed')

    const now = Date.now()
    const staleAfter = new Date(now + staleMinutes * 60_000).toISOString()
    const row = orgArtifactRow({
      orgId, userId, artifactType, ent, extra, structured, inputHash, cacheKey, staleAfter, model: modelUsed,
      validationStatus, sources: sourcesUsed,
      validatorOutcome: { hits: validation.hits, contract_missing: contract.missing, consensus, providers: providerMeta?.providers || [] },
      evidenceHash: pkg?.evidence_hash, sourceSetHash: pkg?.source_set_hash, signalSnapshot: signalSnap || {},
      reuseKind: 'fresh',
      questionNormHash: explainHashes?.question_norm_hash || null, questionShingles: explainHashes?.question_shingles || null,
      explainSubjectKey,
    })
    const { data: artifact, error } = await insertArtifact(supabase, row)
    if (error) throw error
    void logCost({
      cacheStatus: 'fresh', reuseKind: 'fresh', model: modelUsed,
      evidenceHash: pkg?.evidence_hash, sourceSetHash: pkg?.source_set_hash,
      allowReason: force ? 'force_refresh' : 'no_prior_artifact',
      usage: { tokens_in: usage?.prompt_tokens, tokens_out: usage?.completion_tokens, multi_model: useMulti && !!consensus },
    })

    // Store the reusable SHARED artifact when the package is PUBLIC and a
    // multi-model synthesis produced it — generated once, reused across users.
    if (pkg?.reusable && consensus && !blocked && sharedKey) {
      void admin.from('intel_shared_artifacts').upsert({
        ...sharedKey, source_set_hash: pkg.source_set_hash, models: providerMeta?.providers || [], consensus,
        structured, confidence: ['high', 'medium', 'low'].includes(structured?.confidence) ? structured.confidence : 'low',
        net_signal: structured?.net_signal || null, sources: Array.from(new Set([...(structured?.sources || []), ...sourcesUsed])),
        data_freshness: structured?.data_freshness || {}, validation_status: validationStatus, model_meta: providerMeta,
        raw_candidate_count: pkg.raw_candidate_count, final_evidence_count: pkg.final_count, stale_after: staleAfter,
      }, { onConflict: 'artifact_type,entity_ref,evidence_hash,contract_version,guardrail_version' })
    }

    await recordIntelEvent(supabase, {
      orgId, userId, eventType: artifactType, subjectKind: ent?.entity_kind, subjectKey: ent?.canonical_ref_key,
      artifactId: artifact.id, model: modelUsed, tokensIn: usage?.prompt_tokens, tokensOut: usage?.completion_tokens,
      validatorOutcome, validatorReason: blocked ? validation.hits.map((h) => h.label).join(',') : null,
      metadata: { cache: 'miss', multi_model: useMulti && !!consensus, consensus, providers: providerMeta?.providers || [], shared_eligible: !!pkg?.reusable, contract_missing: contract.missing, evidence_items: evidenceCount, raw_candidates: pkg?.raw_candidate_count || 0 },
    })
    await recordArtifactDecisionMemory(supabase, { orgId, userId, artifactType, ent, artifact, decisionKind: 'artifact_fresh_generation', cache: 'fresh', reasoningSummary: structured?.summary || null, evidenceHash: pkg?.evidence_hash, sourceSetHash: pkg?.source_set_hash, metadata: { multi_model: useMulti && !!consensus, consensus, providers: providerMeta?.providers || [], shared_eligible: !!pkg?.reusable, contract_missing: contract.missing, evidence_items: evidenceCount, raw_candidates: pkg?.raw_candidate_count || 0 } })

    if (blocked) return json({ artifact, blocked: true, reason: 'safety_validation_failed' }, 200)
    return json({ artifact, cached: false, consensus, multi_model: !!consensus, matched_surfaces: explainRouted?.matched_surfaces || undefined })
  } catch (e) {
    return json({ error: (e as Error)?.message || 'generate_failed' }, 400)
  }
})

// ── narrative_brief: GLOBAL shared artifact (cron/service-role only) ──────────
// Generated ONCE per (slug, evidence_hash) and reused platform-wide via
// intel_shared_artifacts. The evidence is PUBLIC + identity-stripped (scores,
// stage, leaders, public drivers) — no user/workspace context ever enters it.
// deno-lint-ignore no-explicit-any
async function handleNarrativeBrief(req: Request, body: any) {
  const cronOk = req.headers.get('x-cron-secret') === Deno.env.get('CRON_SECRET')
  const authHeader = req.headers.get('Authorization') || ''
  const svcOk = authHeader === `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`
  if (!cronOk && !svcOk) return json({ error: 'forbidden' }, 403)

  const slug = String(body?.narrativeSlug || '').trim()
  if (!slug) return json({ error: 'narrativeSlug required' }, 400)
  let evidence = body?.evidence || {}
  const apiKey = Deno.env.get('OPENAI_API_KEY')
  if (!apiKey) return json({ error: 'OPENAI_API_KEY not configured' }, 500)
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  try {
    const narrativePack = await assembleNarrativeEvidencePack(admin, slug, { maxAssets: 8 })
    evidence = { ...(evidence || {}), narrative_evidence_pack: narrativePack }
  } catch { /* additive; the existing narrative evidence still drives the brief */ }

  const entityRef = `narrative:${slug}`
  const evidenceHash = hashStr(JSON.stringify(evidence))
  const sharedKey = { artifact_type: 'narrative_brief', entity_ref: entityRef, evidence_hash: evidenceHash, contract_version: CONTRACT_VERSION, guardrail_version: GUARDRAIL_VERSION }

  // shared-cache hit → no new AI cost
  if (!body?.force) {
    const { data: shared } = await admin.from('intel_shared_artifacts').select('*').match(sharedKey).order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (shared && (!shared.stale_after || new Date(shared.stale_after).getTime() > Date.now())) {
      return json({ entity_ref: entityRef, structured: shared.structured, consensus: shared.consensus, cached: true, shared: true })
    }
  }

  const required = requiredFieldsFor('narrative_brief')
  const { system, user, model } = buildPrompt('narrative_brief', { context: evidence })
  const xaiKey = Deno.env.get('XAI_API_KEY') || Deno.env.get('GROK_API_KEY')
  const geminiKey = Deno.env.get('GEMINI_API_KEY')

  // deno-lint-ignore no-explicit-any
  let structured: any = null
  let consensus: string | null = null
  let providers: string[] = []
  try {
    const mm = await multiModelAnalyze({ entity: null, evidence, baseSystem: system, task: 'Produce your independent read for a narrative brief (research / risk context, not advice).', keys: { openai: apiKey, xai: xaiKey, gemini: geminiKey } })
    if (mm) { structured = mm.structured; consensus = mm.consensus; providers = mm.providersUsed }
  } catch (_e) { /* fall back to single-model */ }
  if (!structured) {
    const r = await callOpenAI(model, system, user, apiKey)
    try { structured = JSON.parse(r.content) } catch { structured = { summary: r.content, confidence: 'low', sources: [] } }
  }

  // safety + contract validation; one constrained rewrite on a hard hit
  let validation = validateSafeLanguage(textOfArtifact(structured))
  let rewrote = false
  if (!validation.ok) {
    const fixSystem = `${system}\n\nYour previous answer used advice-style language (${validation.hits.map((h: { label: string }) => h.label).join(', ')}). Rewrite it to be strictly research/risk context. ${SAFE_LANGUAGE_RULES}`
    try {
      // Validation-gated escalation (gpt-5.4) — only on a guardrail miss.
      const retry = await callOpenAI(intelModel('escalate'), fixSystem, `${user}\n\nPrevious JSON to fix:\n${JSON.stringify(structured).slice(0, 8000)}`, apiKey)
      structured = JSON.parse(retry.content); rewrote = true
    } catch { /* keep prior */ }
    validation = validateSafeLanguage(textOfArtifact(structured))
  }
  structured = reconcileCoverage(structured, structured?.sources || [], evidence?.data_coverage || evidence?.coverage || null)
  const contract = validateArtifactContract(structured, required)
  const blocked = !validation.ok
  const validationStatus = blocked ? 'blocked' : (rewrote ? 'rewritten' : 'passed')
  const staleAfter = new Date(Date.now() + (Number(body?.staleMinutes) || 720) * 60_000).toISOString()

  if (!blocked) {
    await admin.from('intel_shared_artifacts').upsert({
      ...sharedKey, source_set_hash: null, models: providers, consensus: consensus || 'single',
      structured, confidence: ['high', 'medium', 'low'].includes(structured?.confidence) ? structured.confidence : 'low',
      net_signal: structured?.net_signal || null, sources: structured?.sources || [],
      data_freshness: structured?.data_freshness || {}, validation_status: validationStatus,
      model_meta: { providers, contract_missing: contract.missing }, stale_after: staleAfter,
    }, { onConflict: 'artifact_type,entity_ref,evidence_hash,contract_version,guardrail_version' })
  }
  return json({ entity_ref: entityRef, structured, consensus, blocked, cached: false })
}
