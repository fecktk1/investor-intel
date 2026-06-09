// Investor Intel — per-chain Gemini news discovery (pg_cron, service-role).
// For each of the 17 launch chains, uses Gemini + Google Search grounding to
// surface recent articles/news about the chain ecosystem and its major
// protocols, and writes them into the shared intel_global_news corpus. This is
// zero-setup coverage: every chain has fresh news even with no curated sources.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { callGeminiGrounded, isGroundedError } from '../_shared/gemini-ground.ts'
import { CHAINS } from '../_shared/chains.ts'
import { classifyItems, dedupKey } from '../_shared/source-crawl.ts'
import { isUsableStory } from '../_shared/news-clean.ts'

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
      const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
      const { data: { user } } = await userClient.auth.getUser()
      const { data: prof } = user ? await userClient.from('profiles').select('is_super_admin').eq('id', user.id).maybeSingle() : { data: null }
      if (!prof?.is_super_admin) return json({ error: 'forbidden' }, 403)
    }

    const geminiKey = Deno.env.get('GEMINI_API_KEY')
    if (!geminiKey) return json({ error: 'GEMINI_API_KEY not configured' }, 500)
    const openaiKey = Deno.env.get('OPENAI_API_KEY')

    // Optionally scope to a subset of chains (admin "Run for chain X").
    let body: any = {}; try { body = await req.json() } catch { /* */ }
    const onlyChain = body?.chain || null
    const chains = onlyChain ? CHAINS.filter((c) => c.id === onlyChain) : CHAINS

    const collected: { it: any; chain: string }[] = []
    for (const chain of chains) {
      // Ask for STRUCTURED stories (real headlines + publisher names), not raw
      // grounding citations — those put the publisher DOMAIN in the title and a
      // vertexaisearch redirect in the URL, which is useless to investors.
      const r = await callGeminiGrounded({
        apiKey: geminiKey,
        systemInstruction: 'You surface real, recent crypto news using web search. Return ONLY valid JSON. Titles MUST be real article headlines — never a website name or domain. News context, not financial advice; never recommend buying or selling.',
        parts: [{ text: `Use web search to find the most important real news stories from the last 3-4 days about the ${chain.label} blockchain ecosystem and its major protocols/tokens (launches, upgrades, incidents, funding, listings, governance, regulation). Return ONLY JSON: {"stories":[{"title":"<the real article headline>","summary":"<1-2 sentence factual summary>","source":"<publisher name, e.g. The Block / CoinDesk / Reuters>","primary_symbol":"<main ticker or null>"}]}. Skip anything you cannot ground in a real article. Titles must be headlines, not domains.` }],
        temperature: 0.2,
      })
      if (isGroundedError(r)) continue
      const stories = (r.json && Array.isArray((r.json as any).stories)) ? (r.json as any).stories : []
      for (const st of stories.slice(0, 8)) {
        if (!st?.title || !isUsableStory({ title: String(st.title) })) continue
        collected.push({ chain: chain.id, it: { title: String(st.title).slice(0, 280), url: null, summary: String(st.summary || '').slice(0, 800), source_name: String(st.source || 'web').slice(0, 80), author: null, published_at: null, raw: { via: 'gemini', symbol: st.primary_symbol || null } } })
      }
    }

    if (collected.length === 0) return json({ ok: true, chains: chains.length, inserted: 0, note: 'no citations' })

    // Batched sentiment/relevance enrichment.
    const rows: any[] = []
    for (let i = 0; i < collected.length; i += 40) {
      const batch = collected.slice(i, i + 40)
      const cls = await classifyItems(batch.map((x) => x.it), [], openaiKey || '')
      batch.forEach((x, j) => {
        const c = cls[j] || {}
        rows.push({
          global_source_id: null, chains: [x.chain], entity_symbol: c.token_symbol || null,
          title: x.it.title, url: x.it.url, summary: x.it.summary, source_name: x.it.source_name, author: null,
          sentiment: c.sentiment || null, relevance: typeof c.relevance === 'number' ? c.relevance : null,
          published_at: null, tags: ['gemini', x.chain], raw: x.it.raw, dedup_key: dedupKey(x.it),
        })
      })
    }

    const byKey = new Map<string, any>(); for (const r of rows) byKey.set(r.dedup_key, r)
    const uniq = [...byKey.values()]
    let inserted = 0
    for (let i = 0; i < uniq.length; i += 100) {
      const { data, error } = await admin.from('intel_global_news').upsert(uniq.slice(i, i + 100), { onConflict: 'dedup_key', ignoreDuplicates: true }).select('id')
      if (error) throw error
      inserted += data?.length || 0
    }
    return json({ ok: true, chains: chains.length, surfaced: collected.length, inserted })
  } catch (e) {
    return json({ error: (e as Error)?.message || 'chain_news_failed' }, 500)
  }
})
