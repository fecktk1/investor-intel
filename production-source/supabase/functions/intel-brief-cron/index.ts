// Investor Intel — Daily Brief assembly cron (service-role / super-admin).
//
// Once per day, for ACTIVE Investor Intel orgs only: assemble the brief
// deterministically from stored intelligence (zero AI per org), fingerprint the
// material inputs, and reference ONE shared global market synthesis per day
// (generated at most once, reused across all orgs via intel_shared_artifacts).
// Quiet day (fingerprint unchanged) → "no meaningful change" brief, zero AI.
//
// Active org = subscribed/trialing AND (recent activity within
// INTEL_ACTIVE_ORG_WINDOW_DAYS (default 14) OR has watchlist/portfolio/alerts).
// Batched with a wall-clock budget + safe resume: an org with today's brief row
// is skipped, so a rerun continues where the budget cut off (idempotent via the
// (org_id, brief_type, period_date) UNIQUE constraint + fingerprint).

import { createClient } from 'npm:@supabase/supabase-js@2'
import { assembleBrief } from '../_shared/intel/brief-assemble.ts'
import { h32 } from '../_shared/core-intel/hashing.ts'
import { recordCostEvent } from '../_shared/core-intel/cost-ledger.ts'
import { makeCostWriter } from '../_shared/intel/intel-cost-writer.ts'
import { validateSafeLanguage, SAFE_LANGUAGE_RULES } from '../_shared/intel-guardrails.ts'
import { CONTRACT_VERSION, GUARDRAIL_VERSION } from '../_shared/intel-prompts.ts'

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret' }
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }) }

const TIME_BUDGET_MS = 100_000
// deno-lint-ignore no-explicit-any
type Any = any

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const cronOk = req.headers.get('x-cron-secret') === Deno.env.get('CRON_SECRET')
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

    // ── 1. Active Intel orgs (subscribed/trialing + signs of life) ──
    const { data: orgs } = await admin.from('orgs').select('id, trial_ends_at, plan_overrides').eq('product_mode', 'intel').limit(1000)
    const PAID = new Set(['starter', 'pro', 'elite'])
    const subscribed = (orgs || []).filter((o: Any) => {
      const tier = String(o.plan_overrides?.intel_tier || 'trial')
      return PAID.has(tier) || (o.trial_ends_at && new Date(o.trial_ends_at).getTime() > Date.now())
    })
    const ids = subscribed.map((o: Any) => o.id)
    if (!ids.length) return json({ ok: true, briefed: 0, note: 'no subscribed/trialing intel orgs' })

    const setOf = async (table: string, extra?: (q: Any) => Any) => {
      try {
        let q = admin.from(table).select('org_id').in('org_id', ids).limit(5000)
        if (extra) q = extra(q)
        const { data } = await q
        return new Set((data || []).map((r: Any) => r.org_id))
      } catch { return new Set<string>() }
    }
    const [wlSet, pfSet, alSet, actSet] = await Promise.all([
      setOf('watchlist_items'),
      setOf('investor_portfolios'),
      setOf('intel_alert_rules', (q) => q.eq('is_active', true)),
      setOf('intel_ai_events', (q) => q.gte('created_at', activeSince)),
    ])
    const active = subscribed.filter((o: Any) => actSet.has(o.id) || wlSet.has(o.id) || pfSet.has(o.id) || alSet.has(o.id))

    // Safe resume: skip orgs that already have today's brief row.
    const { data: doneRows } = await admin.from('intel_briefs').select('org_id, change_fingerprint').eq('brief_type', 'daily').eq('period_date', today).in('org_id', active.map((o: Any) => o.id))
    const done = new Set((doneRows || []).map((r: Any) => r.org_id))
    const todo = active.filter((o: Any) => !done.has(o.id))

    // ── 2. Global inputs fetched ONCE (cached tables only) ──
    const [regimeR, narrR, sigR, newsR, prevR] = await Promise.all([
      Promise.resolve(admin.rpc('intel_current_regime')).then((r: Any) => (Array.isArray(r.data) ? r.data[0] : r.data) || null).catch(() => null),
      admin.from('narrative_state').select('lifecycle_stage, prev_stage, signal_class, global_priority_score, clarity_labels, narrative_taxonomy!inner(slug, name, status)').order('global_priority_score', { ascending: false, nullsFirst: false }).limit(40),
      admin.from('intel_signal_state').select('signal_key, subject_type, subject_id, display_symbol, direction, severity, global_score, why_it_matters, what_to_watch_next, related_assets, score_delta').gt('expires_at', new Date().toISOString()).order('global_score', { ascending: false }).limit(60),
      admin.from('intel_curated_news').select('cluster_hash, cleaned_title, title, why_it_matters, signal, tokens, final_score, should_surface').eq('should_surface', true).gt('stale_after', new Date().toISOString()).order('final_score', { ascending: false }).limit(20),
      admin.from('intel_briefs').select('org_id, change_fingerprint').eq('brief_type', 'daily').eq('period_date', yesterday).in('org_id', todo.map((o: Any) => o.id)),
    ])
    const narratives = (narrR.data || []).filter((n: Any) => ['active', 'surfaced'].includes(n.narrative_taxonomy?.status)).map((n: Any) => ({ ...n, slug: n.narrative_taxonomy.slug, name: n.narrative_taxonomy.name }))
    const signals = sigR.data || []
    const news = newsR.data || []
    const prevByOrg = new Map<string, string | null>((prevR.data || []).map((r: Any) => [String(r.org_id), (r.change_fingerprint as string | null) ?? null]))

    // Per-org context batched (watchlist + holdings), one query each.
    const todoIds = todo.map((o: Any) => o.id)
    const [wlRows, holdRows] = await Promise.all([
      Promise.resolve(admin.from('watchlist_items').select('org_id, entity:entities(display_symbol)').in('org_id', todoIds).limit(8000)).then((r: Any) => r.data || []).catch(() => []),
      Promise.resolve(admin.from('investor_portfolio_holdings').select('org_id, normalized_symbol, asset_symbol, current_value, day_pnl, day_pnl_pct').in('org_id', todoIds).limit(8000)).then((r: Any) => r.data || []).catch(() => []),
    ])
    const wlByOrg = new Map<string, string[]>()
    for (const w of wlRows) { const s = String(w.entity?.display_symbol || '').toUpperCase(); if (!s) continue; const a = wlByOrg.get(w.org_id) || []; a.push(s); wlByOrg.set(w.org_id, a) }
    const holdByOrg = new Map<string, Any[]>()
    for (const h of holdRows) { const a = holdByOrg.get(h.org_id) || []; a.push({ symbol: h.normalized_symbol || h.asset_symbol, value: h.current_value, dayPnl: h.day_pnl, dayPnlPct: h.day_pnl_pct }); holdByOrg.set(h.org_id, a) }

    // ── 3. ONE shared global market synthesis per day (reused by every org) ──
    // Generated at most once; identity-stripped (global inputs only). Quiet
    // global day or missing key → deterministic-only briefs, zero AI.
    let synthesisRef: string | null = null
    let globalAiRan = false
    const openaiKey = Deno.env.get('OPENAI_API_KEY')
    const globalFingerprint = h32([
      regimeR ? `${regimeR.regime}|${regimeR.flavor || ''}` : 'no-regime',
      ...narratives.slice(0, 10).map((n: Any) => `${n.slug}:${n.lifecycle_stage}`),
      ...signals.slice(0, 12).map((s: Any) => `${s.signal_key}:${s.direction}`),
      ...news.slice(0, 5).map((c: Any) => String(c.cluster_hash)),
    ].join('~'))
    const sharedKey = { artifact_type: 'daily_brief_global', entity_ref: '', evidence_hash: globalFingerprint, contract_version: CONTRACT_VERSION, guardrail_version: GUARDRAIL_VERSION }
    try {
      const { data: shared } = await admin.from('intel_shared_artifacts').select('id, structured, stale_after').match(sharedKey).order('created_at', { ascending: false }).limit(1).maybeSingle()
      if (shared && (!shared.stale_after || new Date(shared.stale_after).getTime() > Date.now())) {
        synthesisRef = globalFingerprint
      } else if (openaiKey && todo.length) {
        const system = `You are Investor Intel's market brief writer.\n${SAFE_LANGUAGE_RULES}\nReturn ONLY JSON: { "summary": "...", "net_signal": "bullish|bearish|mixed|neutral|unclear|data_limited", "confidence": "high|medium|low" }. One concise market-wide paragraph synthesizing ONLY the provided regime, narratives, signals and news — research context, never advice.`
        const user = JSON.stringify({ regime: regimeR, narratives: narratives.slice(0, 8).map((n: Any) => ({ name: n.name, stage: n.lifecycle_stage, signal: n.signal_class })), signals: signals.slice(0, 10).map((s: Any) => ({ subject: s.display_symbol || s.subject_id, direction: s.direction, why: s.why_it_matters })), news: news.slice(0, 5).map((c: Any) => ({ title: c.cleaned_title || c.title, signal: c.signal })) })
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST', headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5.4-mini', messages: [{ role: 'system', content: system }, { role: 'user', content: user }], response_format: { type: 'json_object' }, reasoning_effort: 'medium' }),
        })
        if (res.ok) {
          const data = await res.json()
          // deno-lint-ignore no-explicit-any
          let structured: any = {}
          try { structured = JSON.parse(data.choices?.[0]?.message?.content || '{}') } catch { /* keep empty */ }
          const check = validateSafeLanguage(String(structured?.summary || ''))
          if (check.ok && structured?.summary) {
            await admin.from('intel_shared_artifacts').upsert({
              ...sharedKey, source_set_hash: null, models: ['gpt-5.4-mini'], consensus: 'single',
              structured, confidence: ['high', 'medium', 'low'].includes(structured?.confidence) ? structured.confidence : 'medium',
              net_signal: structured?.net_signal || null, sources: ['Regime', 'Narratives', 'Intel Signals', 'Curated news'],
              data_freshness: {}, validation_status: 'passed', model_meta: { purpose: 'daily_brief_global' },
              stale_after: new Date(Date.now() + 720 * 60_000).toISOString(),
            }, { onConflict: 'artifact_type,entity_ref,evidence_hash,contract_version,guardrail_version' })
            synthesisRef = globalFingerprint
            globalAiRan = true
          }
        }
      }
    } catch { /* synthesis optional — deterministic briefs still ship */ }

    // ── 4. Assemble per-org briefs within the time budget (no AI per org) ──
    let briefed = 0, unchanged = 0, skipped = 0
    for (const o of todo) {
      if (Date.now() - startMs > TIME_BUDGET_MS) { skipped = todo.length - briefed - unchanged; break }
      const out = assembleBrief({
        regime: regimeR, narratives, signals, news,
        watchlistSymbols: wlByOrg.get(o.id) || [],
        holdings: holdByOrg.get(o.id) || [],
        prevFingerprint: prevByOrg.get(o.id) || null,
      })
      const { error } = await admin.from('intel_briefs').upsert({
        org_id: o.id, brief_type: 'daily', period_date: today, status: 'ready',
        assembled: out.sections, change_fingerprint: out.change_fingerprint,
        synthesis_artifact_ref: out.material ? synthesisRef : null,
      }, { onConflict: 'org_id,brief_type,period_date' })
      if (!error) { if (out.no_meaningful_change) unchanged++; else briefed++ }
    }

    // Precise job ledger row: ≤1 AI call regardless of org count.
    try {
      await recordCostEvent(makeCostWriter(admin), {
        feature: 'daily_brief', orgId: null, artifactType: 'daily_brief',
        model: globalAiRan ? 'gpt-5.4-mini' : null,
        cacheStatus: globalAiRan ? 'fresh' : (synthesisRef ? 'shared_hit' : 'no_ai'),
        allowReason: globalAiRan ? 'evidence_changed_material' : 'n/a_no_ai',
        evidenceHash: globalFingerprint,
        providerCallsMade: globalAiRan ? 1 : 0,
        providerCallsAvoided: Math.max(0, briefed + unchanged - (globalAiRan ? 1 : 0)),
        usage: { active_orgs: active.length, briefed, unchanged, skipped_for_budget: skipped, window_days: windowDays },
      }, { precision: 'exact', nowMs: Date.now() })
    } catch { /* ledger best-effort */ }

    return json({ ok: true, active_orgs: active.length, briefed, unchanged, skipped_for_budget: skipped, global_synthesis: globalAiRan ? 'generated' : (synthesisRef ? 'reused' : 'none') })
  } catch (e) {
    return json({ error: (e as Error)?.message || 'brief_cron_failed' }, 500)
  }
})
