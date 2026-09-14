// Investor Intel — Daily Brief assembly cron (service-role / super-admin).
//
// Once per day, for ACTIVE Investor Intel users only: assemble the brief
// deterministically from stored intelligence (zero AI per user), fingerprint the
// material inputs, and reference ONE shared global market synthesis per day
// (generated at most once, reused across all orgs via intel_shared_artifacts).
// Quiet day (fingerprint unchanged) → "no meaningful change" brief, zero AI.
//
// Active org = subscribed/trialing AND (recent activity within
// INTEL_ACTIVE_ORG_WINDOW_DAYS (default 14) OR has watchlist/portfolio/alerts).
// Batched with a wall-clock budget + safe resume: an org with today's brief row
// is skipped, so a rerun continues where the budget cut off (idempotent via the
// (org_id, user_id, brief_type, period_date) UNIQUE constraint + fingerprint).

import { createClient } from 'npm:@supabase/supabase-js@2'
import { assembleBrief } from '../_shared/intel/brief-assemble.ts'
import { loadPrivateBriefContext } from '../_shared/intel/private-brief-context.ts'
import { readBriefNews } from '../_shared/intel/brief-news.ts'
import { loadCmcAiAllowed, prepareAiContext } from '../_shared/intel/ai-source-policy.ts'
import { h32 } from '../_shared/core-intel/hashing.ts'
import { recordCostEvent } from '../_shared/core-intel/cost-ledger.ts'
import { makeCostWriter } from '../_shared/intel/intel-cost-writer.ts'
import { validateSafeLanguage, SAFE_LANGUAGE_RULES } from '../_shared/intel-guardrails.ts'
import { CONTRACT_VERSION, GUARDRAIL_VERSION } from '../_shared/intel-prompts.ts'
import { intelModel, intelEffort } from '../_shared/intel-model-config.ts'

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret' }
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }) }

const TIME_BUDGET_MS = 100_000
// deno-lint-ignore no-explicit-any
type Any = any

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const secret = Deno.env.get('CRON_SECRET')
    const cronOk = !!secret && req.headers.get('x-cron-secret') === secret
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    if (!cronOk) {
      const authHeader = req.headers.get('Authorization')
      if (!authHeader) return json({ error: 'unauthorized' }, 401)
      const u = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
      const { data: { user } } = await u.auth.getUser()
      const { data: prof } = user ? await u.from('profiles').select('is_super_admin').eq('id', user.id).maybeSingle() : { data: null }
      if (!prof?.is_super_admin) return json({ error: 'forbidden' }, 403)
    }
    if ((Deno.env.get('INTEL_BRIEF_CRON_ENABLED') ?? 'true') === 'false') return json({ ok: true, note: 'brief cron disabled' })

    const startMs = Date.now()
    const today = new Date().toISOString().slice(0, 10)
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    const windowDays = Math.max(1, Math.min(90, Number(Deno.env.get('INTEL_ACTIVE_ORG_WINDOW_DAYS') || '14')))
    const activeSince = new Date(Date.now() - windowDays * 86_400_000).toISOString()

    // Pending own-user work has atomic ten-minute claims and no leading-org cap.
    const { data: work, error: workError } = await admin.rpc('intel_brief_work_batch', { p_date: today, p_active_since: activeSince, p_limit: 40 })
    if (workError) throw workError
    const todo = work || []
    if (!todo.length) return json({ ok: true, briefed: 0, note: 'No pending personal briefs' })

    // ── 2. Global inputs fetched ONCE (cached tables only) ──
    const [regimeR, narrR, sigR, newsR, macroR, rankR, catR, protocolR, chainR] = await Promise.all([
      Promise.resolve(admin.rpc('intel_current_regime')).then((r: Any) => (Array.isArray(r.data) ? r.data[0] : r.data) || null).catch(() => null),
      admin.from('narrative_state').select('lifecycle_stage, prev_stage, signal_class, global_priority_score, clarity_labels, narrative_taxonomy!inner(slug, name, status)').order('global_priority_score', { ascending: false, nullsFirst: false }).limit(40),
      admin.from('intel_signal_state').select('signal_key, subject_type, subject_id, display_symbol, direction, severity, global_score, why_it_matters, what_to_watch_next, related_assets, score_delta').gt('expires_at', new Date().toISOString()).order('global_score', { ascending: false }).limit(60),
      readBriefNews(admin,new Date(),20).then(data=>({data})),
      admin.from('market_macro_available').select('provider, total_market_cap_usd, total_volume_24h_usd, market_cap_change_24h_pct, btc_dominance_pct, eth_dominance_pct, stablecoin_market_cap_usd, as_of, fetched_at').order('as_of', { ascending: false }).limit(2),
      admin.from('market_rankings_available').select('provider, rank, normalized_symbol, symbol, name, change_24h_pct, market_cap_usd, volume_24h_usd, as_of').order('as_of', { ascending: false }).limit(12),
      admin.from('narrative_category_snapshots').select('provider, category_id, category_label, rank, market_cap_change_24h_pct, top_3_coins, as_of').order('as_of', { ascending: false }).limit(10),
      admin.from('protocol_tvl_snapshots').select('protocol_slug, protocol_name, chain, tvl_usd, ts, fetched_at').order('ts', { ascending: false }).limit(10),
      admin.from('chain_tvl_snapshots').select('chain, tvl_usd, ts, fetched_at').order('ts', { ascending: false }).limit(10),
    ])
    const narratives = (narrR.data || []).filter((n: Any) => ['active', 'surfaced'].includes(n.narrative_taxonomy?.status)).map((n: Any) => ({ ...n, slug: n.narrative_taxonomy.slug, name: n.narrative_taxonomy.name }))
    const signals = sigR.data || []
    const news = newsR.data || []

    // ── 3. ONE shared global market synthesis per day (reused by every org) ──
    // Generated at most once; identity-stripped (global inputs only). Quiet
    // global day or missing key → deterministic-only briefs, zero AI.
    let synthesisRef: string | null = null
    let globalAiRan = false
    const openaiKey = Deno.env.get('OPENAI_API_KEY')
    const briefModel = intelModel('standard')   // global market synthesis → standard tier
    const allowCmcAi=await loadCmcAiAllowed(admin)
    const synthesisInputs = prepareAiContext({
      regime: regimeR, macro: (macroR.data || []).slice(0, 2), category_rotation: (catR.data || []).slice(0, 6),
      protocol_tvl: (protocolR.data || []).slice(0, 6), chain_tvl: (chainR.data || []).slice(0, 6),
      narratives: narratives.slice(0, 8).map((n: Any) => ({ name: n.name, stage: n.lifecycle_stage, signal: n.signal_class })),
      signals: signals.slice(0, 10).map((s: Any) => ({ subject: s.display_symbol || s.subject_id, direction: s.direction, why: s.why_it_matters })),
      news: news.slice(0, 5).map((c: Any) => ({ title: c.cleaned_title || c.title, signal: c.signal })),
    },allowCmcAi)
    const globalFingerprint = h32([
      regimeR ? `${regimeR.regime}|${regimeR.flavor || ''}` : 'no-regime',
      ...narratives.slice(0, 10).map((n: Any) => `${n.slug}:${n.lifecycle_stage}`),
      ...signals.slice(0, 12).map((s: Any) => `${s.signal_key}:${s.direction}`),
      ...news.slice(0, 5).map((c: Any) => String(c.cluster_hash)),
      ...(macroR.data || []).slice(0, 2).map((m: Any) => `macro:${m.provider}:${m.as_of}:${m.market_cap_change_24h_pct}`),
      ...(catR.data || []).slice(0, 6).map((c: Any) => `cat:${c.category_id}:${c.rank}:${c.market_cap_change_24h_pct}`),
      ...(protocolR.data || []).slice(0, 6).map((p: Any) => `ptvl:${p.protocol_slug}:${p.chain}:${Math.round(Number(p.tvl_usd || 0))}`),
      ...(chainR.data || []).slice(0, 6).map((c: Any) => `ctvl:${c.chain}:${Math.round(Number(c.tvl_usd || 0))}`),
    ].join('~'))
    const synthesisFingerprint = h32(JSON.stringify({ synthesisInputs, cmcAi: allowCmcAi }))
    const sharedKey = { artifact_type: 'daily_brief_global', entity_ref: '', evidence_hash: synthesisFingerprint, contract_version: CONTRACT_VERSION, guardrail_version: GUARDRAIL_VERSION }
    try {
      const { data: shared } = await admin.from('intel_shared_artifacts').select('id, structured, stale_after').match(sharedKey).order('created_at', { ascending: false }).limit(1).maybeSingle()
      if (shared && (!shared.stale_after || new Date(shared.stale_after).getTime() > Date.now())) {
        synthesisRef = synthesisFingerprint
      } else if (openaiKey && todo.length) {
        const system = `You are Investor Intel's market brief writer.\n${SAFE_LANGUAGE_RULES}\nReturn ONLY JSON: { "summary": "...", "net_signal": "bullish|bearish|mixed|neutral|unclear|data_limited", "confidence": "high|medium|low" }. One concise market-wide paragraph synthesizing ONLY the provided regime, narratives, signals and news — research context, never advice.`
        const user = JSON.stringify(synthesisInputs)
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST', headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: briefModel, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], response_format: { type: 'json_object' }, reasoning_effort: intelEffort() }),
        })
        if (res.ok) {
          const data = await res.json()
          // deno-lint-ignore no-explicit-any
          let structured: any = {}
          try { structured = JSON.parse(data.choices?.[0]?.message?.content || '{}') } catch { /* keep empty */ }
          const check = validateSafeLanguage(String(structured?.summary || ''))
          if (check.ok && structured?.summary) {
            await admin.from('intel_shared_artifacts').upsert({
              ...sharedKey, source_set_hash: null, models: [briefModel], consensus: 'single',
              structured, confidence: ['high', 'medium', 'low'].includes(structured?.confidence) ? structured.confidence : 'medium',
              net_signal: structured?.net_signal || null, sources: ['Regime', 'Narratives', 'Intel Signals', 'Curated news'],
              data_freshness: {}, validation_status: 'passed', model_meta: { purpose: 'daily_brief_global' },
              stale_after: new Date(Date.now() + 720 * 60_000).toISOString(),
            }, { onConflict: 'artifact_type,entity_ref,evidence_hash,contract_version,guardrail_version' })
            synthesisRef = synthesisFingerprint
            globalAiRan = true
          }
        }
      }
    } catch { /* synthesis optional — deterministic briefs still ship */ }

    // One identity-free global synthesis is reused; personal assembly is pure.
    let briefed = 0, unchanged = 0, skipped = 0, failed = 0
    for (const [index, identity] of todo.entries()) {
      if (Date.now() - startMs > TIME_BUDGET_MS) { skipped = todo.length - index; break }
      try {
        const personal = await loadPrivateBriefContext(admin, identity.org_id, identity.user_id)
        const { data: previous, error: previousError } = await admin.from('intel_personal_briefs').select('change_fingerprint')
          .eq('org_id', identity.org_id).eq('user_id', identity.user_id).eq('brief_type', 'daily').eq('period_date', yesterday).maybeSingle()
        if (previousError) throw previousError
        const out = assembleBrief({
          regime: regimeR, narratives, signals, news,
          macro: macroR.data || [], rankings: rankR.data || [], categories: catR.data || [],
          protocolTvl: protocolR.data || [], chainTvl: chainR.data || [],
          ...personal, prevFingerprint: previous?.change_fingerprint || null,
        })
        const { error } = await admin.from('intel_personal_briefs').upsert({
          org_id: identity.org_id, user_id: identity.user_id, brief_type: 'daily', period_date: today, status: 'ready',
          assembled: { ...out.sections, context_coverage: personal.coverage, assembly_scope: 'personal' },
          change_fingerprint: out.change_fingerprint, synthesis_artifact_ref: out.material ? synthesisRef : null,
        }, { onConflict: 'org_id,user_id,brief_type,period_date', ignoreDuplicates: true })
        if (error) throw error
        if (out.no_meaningful_change) unchanged++; else briefed++
      } catch { failed++ } // retry after claim backoff; never save an empty success
    }

    // Precise job ledger row: ≤1 AI call regardless of org count.
    try {
      await recordCostEvent(makeCostWriter(admin), {
        feature: 'daily_brief', orgId: null, artifactType: 'daily_brief',
        model: globalAiRan ? briefModel : null,
        cacheStatus: globalAiRan ? 'fresh' : (synthesisRef ? 'shared_hit' : 'no_ai'),
        allowReason: globalAiRan ? 'evidence_changed_material' : 'n/a_no_ai',
        evidenceHash: globalFingerprint,
        providerCallsMade: globalAiRan ? 1 : 0,
        providerCallsAvoided: Math.max(0, briefed + unchanged - (globalAiRan ? 1 : 0)),
        usage: { pending_users: todo.length, briefed, unchanged, skipped_for_budget: skipped, window_days: windowDays, failed },
      }, { precision: 'exact', nowMs: Date.now() })
    } catch { /* ledger best-effort */ }

    return json({ ok: true, pending_users: todo.length, briefed, unchanged, skipped_for_budget: skipped, failed, global_synthesis: globalAiRan ? 'generated' : (synthesisRef ? 'reused' : 'none') })
  } catch (e) {
    return json({ error: (e as Error)?.message || 'brief_cron_failed' }, 500)
  }
})
