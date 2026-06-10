// Investor Intel — news curation (cron, service-role).
//
// corpus → dedupe/cluster (buildNotable) → cheap prefilter → Gemini + Grok BATCH
// evaluation (2 calls total, not per item) → deterministic adjudicate → curated
// rows. Market Pulse reads should_surface=true. Cached by cluster_hash; skips
// clusters that already have a fresh curated row. Raw ingestion untouched.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { buildNotable } from '../_shared/intel-signals.ts'
import { prefilter, geminiBatchEval, grokBatchEval, adjudicate } from '../_shared/intel-curate.ts'
import { produceSignalState } from '../_shared/intel/intel-signal-producer.ts'

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }) }

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

    const geminiKey = Deno.env.get('GEMINI_API_KEY')
    const xaiKey = Deno.env.get('XAI_API_KEY') || Deno.env.get('GROK_API_KEY')
    if (!geminiKey && !xaiKey) return json({ error: 'no GEMINI_API_KEY or XAI_API_KEY configured' }, 500)
    let body: any = {}; try { body = await req.json() } catch { /* */ }
    const limit = Math.min(Math.max(Number(body?.limit) || 30, 1), 40)
    const hours = Math.min(Math.max(Number(body?.hours) || 48, 6), 168)

    const since = new Date(Date.now() - hours * 3_600_000).toISOString()
    // Enriched select needs migration 176; fall back to base columns if not applied.
    const baseSel = 'title, url, source_name, sentiment, published_at, created_at, chains, entity_symbol'
    let rowsRes: any = await admin.from('intel_global_news').select(`${baseSel}, source_quality, authority_level`).gte('created_at', since).order('created_at', { ascending: false }).limit(300)
    if (rowsRes.error) rowsRes = await admin.from('intel_global_news').select(baseSel).gte('created_at', since).order('created_at', { ascending: false }).limit(300)
    const rows = rowsRes.data

    const rawCandidates = (rows || []).map((n: any) => ({ title: n.title, url: n.url, source: n.source_name, sentiment: n.sentiment, published_at: n.published_at || n.created_at, chains: n.chains || [], symbol: n.entity_symbol || null, custom: false, origin: 'global', source_quality: n.source_quality ?? null, authority_tier: n.authority_level ?? null }))
    const { allCards } = buildNotable(rawCandidates, { wlSymbols: new Set(), wlChains: new Set(), moverBySymbol: new Map(), scope: 'all' })

    // Candidate pool (top deterministic) → cheap prefilter → AI batch.
    const pool = allCards.slice(0, 60)
    const survivors = pool.filter((c: any) => prefilter(c).keep)
    const { data: fresh } = await admin.from('intel_curated_news').select('cluster_hash')
      .in('cluster_hash', survivors.map((c: any) => c.story_hash)).gt('stale_after', new Date().toISOString())
    const have = new Set((fresh || []).map((r: any) => r.cluster_hash))
    const todo = survivors.filter((c: any) => !have.has(c.story_hash)).slice(0, limit)
    if (!todo.length) {
      // Even when curation is all-fresh, refresh the reusable Intel Signal store
      // (exchange / narrative / news move independently). Cache-only; no provider calls.
      let producer: unknown = null
      try { producer = await produceSignalState(admin, { now: Date.now() }) } catch (e) { console.error('produceSignalState failed', (e as Error)?.message) }
      return json({ ok: true, candidates: pool.length, survivors: survivors.length, evaluated: 0, surfaced: 0, producer, note: 'all fresh or nothing passed prefilter' })
    }

    const [gem, grok] = await Promise.all([
      geminiKey ? geminiBatchEval(todo, geminiKey).catch(() => ({})) : Promise.resolve({}),
      xaiKey ? grokBatchEval(todo, xaiKey).catch(() => ({})) : Promise.resolve({}),
    ])

    // Resolve each candidate's primary-source authority tier (by domain) so the
    // adjudicator can compute the explainable source-quality score + apply the
    // official-confirmation gate. Custom user sources still keep their precedence
    // upstream — this only enriches the curated row.
    const domainOf = (u: any) => { try { return new URL(String(u)).hostname.replace(/^www\./, '').toLowerCase() } catch { return null } }
    const domains = [...new Set(todo.map((c: any) => domainOf(c.url)).filter(Boolean))] as string[]
    const authByDomain = new Map<string, string>()
    if (domains.length) {
      const { data: srcRows } = await admin.from('signal_sources')
        .select('normalized_domain, authority_level').in('normalized_domain', domains).not('authority_level', 'is', null)
      for (const s of (srcRows || [])) if (s.normalized_domain && s.authority_level && !authByDomain.has(s.normalized_domain)) authByDomain.set(s.normalized_domain, s.authority_level)
    }
    for (const c of todo) { const d = domainOf((c as any).url); (c as any).authority_tier = d ? (authByDomain.get(d) || null) : null }

    const staleAfter = new Date(Date.now() + 4 * 3_600_000).toISOString()
    const out = todo.map((c: any, i: number) => ({ ...adjudicate(c, (gem as any)[i], (grok as any)[i], {}), stale_after: staleAfter, updated_at: new Date().toISOString() }))
    for (let i = 0; i < out.length; i += 50) {
      const { error } = await admin.from('intel_curated_news').upsert(out.slice(i, i + 50), { onConflict: 'cluster_hash' })
      if (error) throw error
    }
    // Promote the freshly-curated corpus + cached exchange/narrative state into the
    // reusable Intel Signal store. Best-effort; cache-only (no provider calls).
    let producer: unknown = null
    try { producer = await produceSignalState(admin, { now: Date.now() }) } catch (e) { console.error('produceSignalState failed', (e as Error)?.message) }

    // ── Long-memory enrichment (deterministic; reuses ALREADY-stored AI output) ──
    // Persist validation history (Gemini/Grok evals we just computed), story-hash
    // memory (survives prunes), and promote major/historic events — all from data
    // we already have. No new provider/AI calls. Best-effort; pre-migration → skip.
    let memory: Record<string, unknown> = {}
    try {
      // validation history: one row per curated story carrying a stored eval
      // deno-lint-ignore no-explicit-any
      const vh = out.filter((r: any) => r.gemini_eval || r.grok_eval).map((r: any) => ({
        subject_kind: 'curated_news', subject_ref: r.cluster_hash,
        validator: r.grok_eval ? 'grok' : 'gemini', model: null,
        score: r.importance_score ?? r.credibility_score ?? null,
        classification: r.news_category || null, reason: r.reason_to_suppress || null,
        new_state: r.should_surface ? 'surfaced' : 'suppressed', metadata: { signal: r.signal, final_score: r.final_score },
      }))
      for (let i = 0; i < vh.length; i += 100) { try { await admin.from('intel_validation_history').insert(vh.slice(i, i + 100)) } catch { /* table optional */ } }
      // story-hash memory (dedupe survives row prunes)
      // deno-lint-ignore no-explicit-any
      for (const r of out) {
        try {
          await admin.rpc('intel_hash_memory_upsert', {
            p_kind: 'story', p_value: r.cluster_hash, p_url: r.primary_url || null,
            p_title: r.cleaned_title || r.title || null, p_source: r.source_type || null, p_cluster: null,
            p_categories: r.sectors || [], p_assets: r.tokens || [], p_chains: r.chains || [], p_narratives: r.narratives || [],
            p_seen_at: r.published_at || new Date().toISOString(),
          })
        } catch { /* function optional pre-migration */ break }
      }
      // promote major/historic events from stored importance (no AI)
      try { const { data: ev } = await admin.rpc('intel_promote_events', { p_min_importance: 78, p_lookback_days: 14 }); memory.events = ev } catch { /* optional */ }
      memory.validation_rows = vh.length
    } catch (e) { console.error('long-memory enrichment skipped', (e as Error)?.message) }

    return json({ ok: true, candidates: pool.length, survivors: survivors.length, evaluated: todo.length, surfaced: out.filter((r: any) => r.should_surface).length, producer, memory })
  } catch (e) {
    return json({ error: (e as Error)?.message || 'curate_failed' }, 500)
  }
})
