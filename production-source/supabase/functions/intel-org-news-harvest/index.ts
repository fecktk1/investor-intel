// Investor Intel — cross-org news harvest (pg_cron, service-role).
//
// The org/content side already crawls RSS feeds into rss_items every 5 minutes.
// This sweeps those items (across ALL orgs — public news the org chose to
// track) for chain-relevant + macro content, dedups them, runs a bounded
// Google-grounded fact-check, and merges them into the shared intel_global_news
// corpus that every retail user reads. Net effect: retail users get a rich,
// verified news feed WITHOUT each draining provider APIs.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { CHAINS } from '../_shared/chains.ts'
import { classifyItems, dedupKey, type CrawledItem } from '../_shared/source-crawl.ts'
import { callGeminiGrounded, isGroundedError } from '../_shared/gemini-ground.ts'

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }) }

const MACRO_TERMS = ['fomc', 'cpi', 'ppi', 'pce', 'federal reserve', 'fed ', 'interest rate', 'rate cut', 'rate hike', 'inflation', 'jobs report', 'nonfarm', 'unemployment', 'gdp', 'powell', 'treasury', 'recession', 'etf approval', 'sec ', 'cftc', 'sanction', 'tariff']
// Common-word chain labels we only trust when the SYMBOL also appears or it's macro.
const WEAK_LABELS = new Set(['base', 'near', 'sei', 'sui'])
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const hit = (text: string, term: string) => term.length >= 3 && new RegExp(`\\b${esc(term)}\\b`, 'i').test(text)

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const cronOk = req.headers.get('x-cron-secret') === Deno.env.get('CRON_SECRET')
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    if (!cronOk) {
      const authHeader = req.headers.get('Authorization')
      if (!authHeader) return json({ error: 'unauthorized' }, 401)
      const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
      const { data: { user } } = await userClient.auth.getUser()
      const { data: prof } = user ? await userClient.from('profiles').select('is_super_admin').eq('id', user.id).maybeSingle() : { data: null }
      if (!prof?.is_super_admin) return json({ error: 'forbidden' }, 403)
    }

    const openaiKey = Deno.env.get('OPENAI_API_KEY') || ''
    const geminiKey = Deno.env.get('GEMINI_API_KEY') || ''
    let body: any = {}; try { body = await req.json() } catch { /* */ }
    const hours = Math.min(Math.max(Number(body?.hours) || 72, 6), 240)
    const scanLimit = Math.min(Math.max(Number(body?.limit) || 1500, 100), 4000)
    const verify = body?.verify !== false
    const since = new Date(Date.now() - hours * 3600_000).toISOString()

    // Pull recent org RSS items across all workspaces (service-role bypasses RLS).
    const { data: items, error: readErr } = await admin
      .from('rss_items')
      .select('title, link, canonical_url, description, source, source_domain, pub_date, retain_forever')
      .gt('pub_date', since)
      .order('pub_date', { ascending: false })
      .limit(scanLimit)
    if (readErr) throw readErr

    // Keyword filter → chain tagging.
    const terms = CHAINS.map((c) => ({ id: c.id, sym: c.nativeSymbol.toLowerCase(), label: c.label.toLowerCase() }))
    const candidates: { chains: string[]; isMacro: boolean; it: CrawledItem }[] = []
    for (const it of (items || [])) {
      const text = `${it.title || ''} ${it.description || ''}`.toLowerCase()
      if (!text.trim()) continue
      const isMacro = it.retain_forever === true || MACRO_TERMS.some((m) => text.includes(m))
      const matched: string[] = []
      for (const c of terms) {
        const symHit = hit(text, c.sym)
        const labelHit = hit(text, c.label) && (!WEAK_LABELS.has(c.label) || symHit)
        if (symHit || labelHit) matched.push(c.id)
      }
      if (!matched.length && !isMacro) continue
      candidates.push({
        chains: matched, isMacro,
        it: { title: String(it.title).slice(0, 280), url: it.canonical_url || it.link || null, summary: String(it.description || '').slice(0, 800), source_name: it.source || it.source_domain || 'RSS', author: null, published_at: it.pub_date || null, raw: { via: 'org_rss' } },
      })
    }

    // Dedup candidates by key, cap to a sane batch (most recent first).
    const byKey = new Map<string, typeof candidates[number]>()
    for (const c of candidates) { const k = dedupKey(c.it); if (!byKey.has(k)) byKey.set(k, c) }
    const uniqCand = [...byKey.values()].slice(0, 240)
    if (!uniqCand.length) return json({ ok: true, scanned: items?.length || 0, candidates: 0, inserted: 0 })

    // Batched classification (sentiment / relevance / token symbol).
    const tokenSet = [...new Set(CHAINS.map((c) => c.nativeSymbol))]
    const rows: any[] = []
    for (let i = 0; i < uniqCand.length; i += 40) {
      const batch = uniqCand.slice(i, i + 40)
      const cls = openaiKey ? await classifyItems(batch.map((x) => x.it), tokenSet, openaiKey) : {}
      batch.forEach((x, j) => {
        const c = (cls as any)[j] || {}
        const tags = ['org_rss', ...x.chains]; if (x.isMacro) tags.push('macro')
        rows.push({
          global_source_id: null, origin: 'org_rss', chains: x.chains, entity_symbol: c.token_symbol || null,
          title: x.it.title, url: x.it.url, summary: x.it.summary, source_name: x.it.source_name, author: null,
          sentiment: c.sentiment || null, relevance: typeof c.relevance === 'number' ? c.relevance : null,
          published_at: x.it.published_at, tags, raw: { ...x.it.raw, macro: x.isMacro }, dedup_key: dedupKey(x.it),
        })
      })
    }

    // Drop low-relevance noise (keep macro + anything unscored or relevant).
    let kept = rows.filter((r) => r.tags.includes('macro') || r.relevance == null || r.relevance >= 0.25)

    // Bounded Google-grounded fact-check on the top headlines (one shared call).
    let verified = 0
    if (verify && geminiKey && kept.length) {
      const top = [...kept].sort((a, b) => (b.relevance || 0) - (a.relevance || 0)).slice(0, 15)
      const g = await callGeminiGrounded({
        apiKey: geminiKey,
        systemInstruction: 'You fact-check crypto/finance news headlines using live web search. Respond with ONLY a JSON object. This is information verification, never financial advice.',
        parts: [{ text: `For each headline below, judge whether it is supported by current reputable web sources. Return {"items":[{"idx":number,"verdict":"supported|unsupported|unclear"}]}.\n\n${top.map((r, i) => `${i}. ${r.title}`).join('\n')}` }],
        temperature: 0,
      })
      if (!isGroundedError(g) && g.json && Array.isArray((g.json as any).items)) {
        for (const v of (g.json as any).items) {
          const r = top[v?.idx]; if (!r) continue
          r.raw = { ...r.raw, verification: v.verdict }
          if (v.verdict === 'supported') { r.tags = [...r.tags, 'verified']; verified++ }
          else if (v.verdict === 'unsupported') { r.tags = [...r.tags, 'disputed']; r.relevance = Math.min(r.relevance ?? 0.3, 0.2) }
        }
      }
    }

    // Final dedup + upsert (UNIQUE dedup_key handles cross-run dedup too).
    const finalByKey = new Map<string, any>(); for (const r of kept) finalByKey.set(r.dedup_key, r)
    const uniq = [...finalByKey.values()]
    let inserted = 0
    for (let i = 0; i < uniq.length; i += 100) {
      const { data, error } = await admin.from('intel_global_news').upsert(uniq.slice(i, i + 100), { onConflict: 'dedup_key', ignoreDuplicates: true }).select('id')
      if (error) throw error
      inserted += data?.length || 0
    }
    return json({ ok: true, scanned: items?.length || 0, candidates: uniqCand.length, kept: kept.length, verified, inserted })
  } catch (e) {
    return json({ error: (e as Error)?.message || 'org_news_harvest_failed' }, 500)
  }
})
