// Investor Intel — per-workspace news ingestion.
// Crawls the workspace's OWN sources (RSS + X via X dev API + Grok — same
// capability as the global curated crawl) AND discovers news for watchlist
// tokens via Grok web/x search. Stores deduped news_items. Additive to the
// shared global corpus.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { callGrokAgentSearch, CRYPTO_NEWS_DOMAINS } from '../_shared/grok-tools.ts'
import { crawlSource, classifyItems, dedupKey } from '../_shared/source-crawl.ts'
import { recordAIUsage } from '../_shared/usage.ts'
import { recordIntelEvent } from '../_shared/intel-events.ts'

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }) }

function parseDiscovery(text: string): any[] {
  try { const j = JSON.parse(text); if (Array.isArray(j)) return j; if (Array.isArray(j?.items)) return j.items } catch { /* */ }
  const m = text.match(/\[[\s\S]*\]/); if (m) { try { return JSON.parse(m[0]) } catch { /* */ } }
  return []
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'No authorization header' }, 401)
    const { orgId, entityId = null } = await req.json() || {}
    if (!orgId) return json({ error: 'orgId required' }, 400)

    const grokKey = Deno.env.get('XAI_API_KEY') || Deno.env.get('GROK_API_KEY')
    const xBearer = Deno.env.get('X_BEARER_TOKEN') || Deno.env.get('TWITTER_BEARER_TOKEN')
    const openaiKey = Deno.env.get('OPENAI_API_KEY')

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
    const { data: auth } = await supabase.auth.getUser()

    const { data: gate } = await supabase.rpc('intel_generation_allowed')
    if (gate && gate.allowed === false) return json({ error: 'generation_not_allowed', reason: gate.reason }, 402)
    const { data: rate } = await supabase.rpc('intel_rate_check', { p_limit_key: 'news_refreshes_per_day' })
    if (rate && rate.allowed === false) return json({ error: 'rate_limited', reason: 'news_refreshes_per_day', used: rate.used, limit: rate.limit }, 429)

    const { data: sources } = await supabase.from('tracked_sources').select('*').eq('org_id', orgId).eq('active', true)
    const { data: wl } = await supabase.from('watchlist_items').select('entity:entities(id, display_symbol)').eq('org_id', orgId).eq('item_type', 'token')
    let entities = (wl || []).map((r: any) => r.entity).filter(Boolean)
    if (entityId) { const { data: one } = await supabase.from('entities').select('id, display_symbol').eq('id', entityId).maybeSingle(); if (one) entities = [one] }
    const symbolMap = new Map<string, string>(); for (const e of entities) if (e.display_symbol) symbolMap.set(String(e.display_symbol).toLowerCase(), e.id)
    const tokenList = entities.map((e: any) => e.display_symbol).filter(Boolean).slice(0, 25)
    const fromDate = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10)

    // 1) Crawl the workspace's own sources (RSS + X API + Grok).
    const crawled: any[] = []
    for (const s of sources || []) for (const it of await crawlSource(s, { grokKey, xBearer, fromDate })) crawled.push(it)
    const clsMap = await classifyItems(crawled.slice(0, 60), tokenList, openaiKey || '')

    const rows: any[] = []
    const pushRow = (it: any, cls: any) => {
      if (!it.title) return
      const sym = (cls?.token_symbol || '').toLowerCase()
      rows.push({
        org_id: orgId, entity_id: symbolMap.get(sym) || entityId || null,
        title: String(it.title).slice(0, 400), url: it.url || null, summary: (it.summary || '').slice(0, 1200),
        source_name: (it.source_name || '').slice(0, 120), author: (it.author || '').slice(0, 120),
        sentiment: ['bullish', 'bearish', 'neutral', 'mixed'].includes(cls?.sentiment) ? cls.sentiment : 'neutral',
        relevance: typeof cls?.relevance === 'number' ? cls.relevance : null, published_at: it.published_at || null,
        raw: it.raw || {}, dedup_key: dedupKey(it),
      })
    }
    crawled.slice(0, 60).forEach((it, i) => pushRow(it, clsMap[i]))

    // 2) Token discovery via Grok web/x search (beyond followed sources).
    let discoveryUsage: any = null
    if (grokKey && tokenList.length) {
      const r = await callGrokAgentSearch({
        apiKey: grokKey,
        query: `Most important recent crypto news (last 48h) about: ${tokenList.join(', ')}. Return ONLY a JSON array; each {"title","url","summary","source_name","sentiment":"bullish|bearish|neutral|mixed","relevance":0..1,"published_at":ISO,"token_symbol"}. token_symbol one of: ${tokenList.join(', ')} or null.`,
        systemPrompt: 'Crypto news curator. Factual, news context not advice.',
        useXSearch: true, useWebSearch: true, xFilters: { from_date: fromDate }, webFilters: { allowed_domains: [...CRYPTO_NEWS_DOMAINS] },
        responseFormat: 'json', surface: 'investor_intel', maxTokens: 4000,
      })
      discoveryUsage = r.usage
      for (const it of parseDiscovery(r.text).slice(0, 40)) {
        pushRow({ title: it.title, url: it.url, summary: it.summary, source_name: it.source_name || it.author, author: it.author, published_at: it.published_at, raw: it }, { sentiment: it.sentiment, relevance: it.relevance, token_symbol: it.token_symbol })
      }
    }

    // De-dupe + store.
    const byKey = new Map<string, any>(); for (const r of rows) byKey.set(r.dedup_key, r)
    const uniq = [...byKey.values()]
    let inserted = 0
    if (uniq.length) { const { data, error } = await supabase.from('news_items').upsert(uniq, { onConflict: 'org_id,dedup_key', ignoreDuplicates: true }).select('id'); if (error) throw error; inserted = data?.length || 0 }
    if (sources?.length) await supabase.from('tracked_sources').update({ last_fetched_at: new Date().toISOString() }).eq('org_id', orgId).eq('active', true)

    if (discoveryUsage) void recordAIUsage(supabase, { orgId, userId: auth?.user?.id || null, provider: 'grok', model: 'grok-4.3', surface: 'investor_intel', subMode: 'news_fetch', providerUsage: { input_tokens: discoveryUsage.input_tokens, output_tokens: discoveryUsage.output_tokens }, status: 'success' })
    await recordIntelEvent(supabase, { orgId, userId: auth?.user?.id || null, eventType: 'news_fetch', subjectKind: 'news', metadata: { inserted, crawled: crawled.length } })

    return json({ inserted, crawled: crawled.length })
  } catch (e) {
    return json({ error: (e as Error)?.message || 'news_fetch_failed' }, 400)
  }
})
