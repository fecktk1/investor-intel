// Investor Intel — shared story-card analysis (cron, service-role).
//
// Generates the reusable AI analysis behind Market Pulse "Notable News" cards:
// what happened / why it matters / crypto impact / bull-bear / what-to-watch.
// Runs ONCE per top global story (multi-model synthesis), stored in
// intel_shared_artifacts keyed by storyHash(title) so the dashboard reads it for
// EVERY user with no per-load AI. Capped per run; skips stories that already
// have a fresh card. Privacy-safe: only public global news (intel_global_news).

import { createClient } from 'npm:@supabase/supabase-js@2'
import { buildPrompt, CONTRACT_VERSION, GUARDRAIL_VERSION } from '../_shared/intel-prompts.ts'
import { multiModelAnalyze } from '../_shared/intel-models.ts'
import { validateSafeLanguage } from '../_shared/intel-guardrails.ts'
import { isUsableStory, cleanSourceName, isPressRelease, storyHash } from '../_shared/news-clean.ts'

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }) }
const TRUST: Record<string, number> = { curated: 0.85, macro: 0.7, gemini: 0.5, org_rss: 0.45 }

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

    const keys = { openai: Deno.env.get('OPENAI_API_KEY'), xai: Deno.env.get('XAI_API_KEY') || Deno.env.get('GROK_API_KEY'), gemini: Deno.env.get('GEMINI_API_KEY') }
    if (!keys.openai) return json({ error: 'OPENAI_API_KEY not configured' }, 500)
    let body: any = {}; try { body = await req.json() } catch { /* */ }
    const limit = Math.min(Math.max(Number(body?.limit) || 6, 1), 12)

    // Candidate stories from the shared corpus → clean + dedupe + rank.
    const since = new Date(Date.now() - 4 * 86_400_000).toISOString()
    const { data: rows } = await admin.from('intel_global_news')
      .select('title, summary, source_name, sentiment, published_at, created_at, chains, entity_symbol, origin')
      .gte('created_at', since).order('created_at', { ascending: false }).limit(250)

    const byKey = new Map<string, any>()
    for (const n of (rows || [])) {
      if (!isUsableStory(n)) continue
      const key = storyHash(n.title)
      const ex = byKey.get(key)
      if (ex) { ex.source_support += 1; continue }
      byKey.set(key, {
        story_hash: key, title: String(n.title).slice(0, 200), summary: String(n.summary || '').slice(0, 600),
        source_name: cleanSourceName(n.source_name, n.title, null) || 'Source', chains: n.chains || [], symbol: n.entity_symbol || null,
        published_at: n.published_at || n.created_at, origin: n.origin, source_support: 1, sentiment: n.sentiment,
        is_press_release: isPressRelease(n.source_name || n.title),
      })
    }
    const now = Date.now()
    const recency = (s: any) => { const h = (now - new Date(s || 0).getTime()) / 3_600_000; return Number.isNaN(h) ? 0.2 : Math.max(0, Math.exp(-h / 36)) }
    const cards = [...byKey.values()].map((c) => ({ ...c, _score: 0.4 * recency(c.published_at) + 0.2 * (TRUST[c.origin] ?? 0.5) + 0.2 * Math.min(c.source_support, 5) / 5 - (c.is_press_release ? 0.3 : 0) }))
      .sort((a, b) => b._score - a._score)

    // Skip stories that already have a fresh shared card.
    const top = cards.slice(0, limit * 3)
    const { data: existing } = await admin.from('intel_shared_artifacts').select('evidence_hash')
      .eq('artifact_type', 'story_card').in('evidence_hash', top.map((c) => c.story_hash)).gt('stale_after', new Date().toISOString())
    const haveFresh = new Set((existing || []).map((e: any) => e.evidence_hash))
    const todo = top.filter((c) => !haveFresh.has(c.story_hash)).slice(0, limit)

    let generated = 0
    for (const c of todo) {
      const evidence = { story: { title: c.title, summary: c.summary, source: c.source_name, chains: c.chains, symbol: c.symbol, source_support: c.source_support, press_release: c.is_press_release }, note: 'Public crypto news story. Judge corroboration honestly; a single press release is weak evidence.' }
      const { system } = buildPrompt('story_card', { context: evidence })
      let mm
      try { mm = await multiModelAnalyze({ entity: null, evidence, baseSystem: system, task: 'Analyze this public crypto news story for a retail investor (research / risk context, not advice).', keys }) }
      catch { mm = null }
      if (!mm?.structured) continue
      const st = mm.structured
      const v = validateSafeLanguage([st.summary, st.what_happened, st.why_it_matters, st.crypto_market_impact, ...(Array.isArray(st.bullish_signals) ? st.bullish_signals : []), ...(Array.isArray(st.bearish_signals) ? st.bearish_signals : [])].filter((x) => typeof x === 'string').join('\n'))
      if (!v.ok) continue // never store advice-y output
      const { error } = await admin.from('intel_shared_artifacts').upsert({
        artifact_type: 'story_card', entity_ref: '', evidence_hash: c.story_hash, source_set_hash: null,
        contract_version: CONTRACT_VERSION, guardrail_version: GUARDRAIL_VERSION, models: mm.providersUsed, consensus: mm.consensus,
        structured: st, confidence: ['high', 'medium', 'low'].includes(st.confidence) ? st.confidence : 'low', net_signal: st.net_signal || null,
        sources: [c.source_name], data_freshness: {}, validation_status: 'passed', model_meta: { statuses: mm.statuses, synth_failed: !!mm.synthFailed },
        raw_candidate_count: c.source_support, final_evidence_count: 1, stale_after: new Date(now + 6 * 3_600_000).toISOString(),
      }, { onConflict: 'artifact_type,entity_ref,evidence_hash,contract_version,guardrail_version' })
      if (!error) generated++
    }
    return json({ ok: true, candidates: cards.length, generated })
  } catch (e) {
    return json({ error: (e as Error)?.message || 'story_cards_failed' }, 500)
  }
})
