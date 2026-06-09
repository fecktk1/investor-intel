// Investor Intel — generic artifact generator.
//
// One endpoint for every AI insight (token_breakdown, risk_panel, explain,
// token_comparison, narrative_report, wallet_summary, defi_report,
// execution_report, alert_explanation). Flow:
//   cache check (input_hash) -> generate -> safe-language + contract validation
//   -> one constrained rewrite on a hard hit -> block if still failing ->
//   persist research_artifacts -> record telemetry.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { buildPrompt, requiredFieldsFor, CONTRACT_VERSION, GUARDRAIL_VERSION } from '../_shared/intel-prompts.ts'
import { validateSafeLanguage, validateArtifactContract, SAFE_LANGUAGE_RULES } from '../_shared/intel-guardrails.ts'
import { recordIntelEvent } from '../_shared/intel-events.ts'
import { recordAIUsage } from '../_shared/usage.ts'
import { birdeyeChainFor, birdeyeOverview, birdeyeWalletPortfolio, dflowExecutionForSolanaToken, kaminoForAddress, defiLlamaForPool } from '../_shared/intel-providers.ts'
import { chainIdFor } from '../_shared/chains.ts'
import { buildEvidence } from '../_shared/intel-evidence.ts'
import { multiModelAnalyze } from '../_shared/intel-models.ts'
import { buildMarketMemoryPromptBlock } from '../_shared/exchange-market/memory.ts'

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

function textOfArtifact(structured: any): string {
  const ya = structured?.yield_analysis || {}, tl = structured?.tvl_liquidity || {}, po = structured?.pool_overview || {}
  const parts = [structured?.summary, structured?.what_happened, structured?.why_it_matters, structured?.crypto_market_impact,
    structured?.bull_case, structured?.bear_case, structured?.neutral_case,
    structured?.beginner_explanation, structured?.advanced_explanation,
    // defi_report (pool-framed) prose — scanned by the safety guardrail too.
    po.what_it_is, ya.apy_read, ya.base_vs_reward, ya.sustainability, tl.tvl_read, tl.depth_note,
    structured?.collateral_or_il, structured?.who_its_for,
    ...(Array.isArray(structured?.comparisons) ? structured.comparisons : []),
    ...(Array.isArray(structured?.what_to_watch) ? structured.what_to_watch : [])]
  return parts.filter((x) => typeof x === 'string').join('\n')
}

async function callOpenAI(model: string, system: string, user: string, apiKey: string) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_object' },
      reasoning_effort: 'medium', // cost rule: cap at medium
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
  }
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
        return json({ artifact: cached, cached: true })
      }
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

    // Reusable SHARED artifact: when the evidence package is PUBLIC (no private
    // custom source contributed), the expensive multi-model analysis is generated
    // ONCE and reused across all users. On a fresh hit, copy the shared structured
    // into an org artifact (no AI) so the user keeps history + Save. Exempt from
    // gate/rate because it incurs no new AI cost.
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const sharedKey = pkg ? { artifact_type: artifactType, entity_ref: ent?.canonical_ref_key || '', evidence_hash: pkg.evidence_hash, contract_version: CONTRACT_VERSION, guardrail_version: GUARDRAIL_VERSION } : null
    if (!force && pkg?.reusable && sharedKey) {
      const { data: shared } = await admin.from('intel_shared_artifacts').select('*').match(sharedKey).order('created_at', { ascending: false }).limit(1).maybeSingle()
      if (shared && (!shared.stale_after || new Date(shared.stale_after).getTime() > Date.now())) {
        const orgRow = orgArtifactRow({ orgId, userId, artifactType, ent, extra, structured: shared.structured, inputHash, cacheKey, staleAfter: shared.stale_after, model: (shared.models || []).join('+') || 'shared', validationStatus: shared.validation_status || 'passed', sources: shared.sources, validatorOutcome: { reused_shared: shared.id, consensus: shared.consensus } })
        const { data: copy } = await supabase.from('research_artifacts').insert(orgRow).select('*').single()
        await recordIntelEvent(supabase, { orgId, userId, eventType: artifactType, subjectKind: ent?.entity_kind, subjectKey: ent?.canonical_ref_key, artifactId: copy?.id, model: (shared.models || []).join('+'), metadata: { cache: 'shared_hit', shared_id: shared.id, consensus: shared.consensus, evidence_items: pkg.final_count } })
        return json({ artifact: copy || shared, cached: true, shared: true, consensus: shared.consensus })
      }
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

    const required = requiredFieldsFor(artifactType)
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
        modelUsed = `synth:gpt-5.5(${mm.providersUsed.join('+')})`
        providerMeta = { providers: mm.providersUsed, statuses: mm.statuses, consensus: mm.consensus, synth_failed: !!mm.synthFailed }
        for (const [prov, u] of Object.entries(mm.usage || {})) {
          const pmodel = prov === 'grok' ? (Deno.env.get('GROK_MODEL') || 'grok-4.3') : prov === 'gemini' ? (Deno.env.get('GEMINI_MODEL') || 'gemini-2.5-flash') : prov === 'synth' ? 'gpt-5.5' : 'gpt-5.4-mini'
          void recordAIUsage(supabase, { orgId, userId, provider: prov === 'grok' ? 'xai' : prov === 'gemini' ? 'google' : 'openai', model: pmodel, surface: 'investor_intel', subMode: `${artifactType}:${prov}`, providerUsage: u, status: 'success' })
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
      const fixSystem = `${system}\n\nYour previous answer used advice-style language (${validation.hits.map((h) => h.label).join(', ')}). Rewrite it to be strictly research/risk context. ${SAFE_LANGUAGE_RULES}`
      const retry = await callOpenAI(model, fixSystem, `${user}\n\nPrevious JSON to fix:\n${JSON.stringify(structured).slice(0, 8000)}`, apiKey)
      try { structured = JSON.parse(retry.content) } catch { /* keep prior */ }
      usage = retry.usage
      validation = validateSafeLanguage(textOfArtifact(structured))
      validatorOutcome = validation.ok ? 'rewrite' : 'block'
    }
    const contract = validateArtifactContract(structured, required)
    const blocked = !validation.ok
    const validationStatus = blocked ? 'blocked' : (validatorOutcome === 'rewrite' ? 'rewritten' : 'passed')

    const now = Date.now()
    const staleAfter = new Date(now + staleMinutes * 60_000).toISOString()
    const row = orgArtifactRow({
      orgId, userId, artifactType, ent, extra, structured, inputHash, cacheKey, staleAfter, model: modelUsed,
      validationStatus, sources: sourcesUsed,
      validatorOutcome: { hits: validation.hits, contract_missing: contract.missing, consensus, providers: providerMeta?.providers || [] },
    })
    const { data: artifact, error } = await supabase.from('research_artifacts').insert(row).select('*').single()
    if (error) throw error

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

    if (blocked) return json({ artifact, blocked: true, reason: 'safety_validation_failed' }, 200)
    return json({ artifact, cached: false, consensus, multi_model: !!consensus })
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
  const evidence = body?.evidence || {}
  const apiKey = Deno.env.get('OPENAI_API_KEY')
  if (!apiKey) return json({ error: 'OPENAI_API_KEY not configured' }, 500)
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

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
      const retry = await callOpenAI(model, fixSystem, `${user}\n\nPrevious JSON to fix:\n${JSON.stringify(structured).slice(0, 8000)}`, apiKey)
      structured = JSON.parse(retry.content); rewrote = true
    } catch { /* keep prior */ }
    validation = validateSafeLanguage(textOfArtifact(structured))
  }
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
