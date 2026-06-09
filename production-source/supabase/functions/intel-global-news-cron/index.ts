// Investor Intel — global curated news crawl (pg_cron, service-role).
// Crawls every active intel_global_source ONCE and writes the shared
// intel_global_news corpus that all workspaces read. X via X dev API + Grok.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { crawlSource, classifyItems, dedupKey } from '../_shared/source-crawl.ts'

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
    const grokKey = Deno.env.get('XAI_API_KEY') || Deno.env.get('GROK_API_KEY')
    const xBearer = Deno.env.get('X_BEARER_TOKEN') || Deno.env.get('TWITTER_BEARER_TOKEN')
    const openaiKey = Deno.env.get('OPENAI_API_KEY')
    const fromDate = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10)

    const { data: sources } = await admin.from('intel_global_sources').select('*').eq('active', true).limit(200)
    const collected: { it: any; source: any }[] = []
    for (const s of sources || []) {
      const items = await crawlSource(s, { grokKey, xBearer, fromDate })
      for (const it of items) collected.push({ it, source: s })
      await admin.from('intel_global_sources').update({ last_fetched_at: new Date().toISOString() }).eq('id', s.id)
    }

    // Newest 200, enriched in batches of 40 (caps classification cost).
    collected.sort((a, b) => new Date(b.it.published_at || 0).getTime() - new Date(a.it.published_at || 0).getTime())
    const top = collected.slice(0, 200)
    const rows: any[] = []
    for (let i = 0; i < top.length; i += 40) {
      const batch = top.slice(i, i + 40)
      const cls = await classifyItems(batch.map((x) => x.it), [], openaiKey || '')
      batch.forEach((x, j) => {
        const c = cls[j] || {}
        rows.push({
          global_source_id: x.source.id, chains: x.source.chains || [], entity_symbol: c.token_symbol || null,
          title: x.it.title, url: x.it.url, summary: x.it.summary, source_name: x.it.source_name, author: x.it.author,
          sentiment: c.sentiment || null, relevance: typeof c.relevance === 'number' ? c.relevance : null,
          published_at: x.it.published_at, raw: x.it.raw || {}, dedup_key: dedupKey(x.it),
        })
      })
    }
    // De-dupe within this run, then upsert (existing rows skipped).
    const byKey = new Map<string, any>(); for (const r of rows) byKey.set(r.dedup_key, r)
    const uniq = [...byKey.values()]
    let inserted = 0
    for (let i = 0; i < uniq.length; i += 100) {
      const { data, error } = await admin.from('intel_global_news').upsert(uniq.slice(i, i + 100), { onConflict: 'dedup_key', ignoreDuplicates: true }).select('id')
      if (error) throw error
      inserted += data?.length || 0
    }
    return json({ ok: true, sources: (sources || []).length, crawled: collected.length, inserted })
  } catch (e) {
    return json({ error: (e as Error)?.message || 'global_news_failed' }, 500)
  }
})
