// Investor Intel — home dashboard digest (scope-aware).
// scope='all'      → everything notable (global + custom)
// scope='chain'    → a single chain: its news/movers/projects + your followed items on it
// scope='following'→ only the user's custom-followed items
// Also returns followed_chains + per-chain projects for the chain/project selectors.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { birdeyeChainFor, birdeyeOverview } from '../_shared/intel-providers.ts'
import { chainIdFor, getChain, CHAINS } from '../_shared/chains.ts'
import { buildNotable, buildSignalRadar } from '../_shared/intel-signals.ts'

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }) }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'No authorization header' }, 401)
    const { orgId, scope = 'all', chain = null } = await req.json() || {}
    if (!orgId) return json({ error: 'orgId required' }, 400)

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
    const beKey = Deno.env.get('BIRDEYE_API_KEY')

    const [wlRes, profRes, customRes, globalRes, narrRes, alertRes, briefRes, researchRes] = await Promise.all([
      supabase.from('watchlist_items').select('item_type, label, entity:entities(id, display_symbol, canonical_ref_key, chain_namespace, chain_id, contract_address)').eq('org_id', orgId),
      supabase.from('intel_user_profiles').select('chains_of_interest').eq('org_id', orgId).maybeSingle(),
      supabase.from('news_items').select('id, title, url, source_name, sentiment, published_at, created_at, entity:entities(display_symbol, canonical_ref_key, chain_namespace, chain_id)').eq('org_id', orgId).order('created_at', { ascending: false }).limit(20),
      supabase.from('intel_global_news').select('id, title, url, source_name, sentiment, published_at, created_at, chains, entity_symbol, source_quality, authority_level').order('created_at', { ascending: false }).limit(60),
      supabase.from('tracked_narratives').select('id, title, status, last_signal_at').eq('org_id', orgId).order('updated_at', { ascending: false }).limit(10),
      supabase.from('intel_alert_events').select('id, fired_at, payload, read_at').eq('org_id', orgId).order('fired_at', { ascending: false }).limit(8),
      supabase.from('intel_briefs').select('period_date, brief_type, artifact:research_artifacts(structured)').eq('org_id', orgId).order('period_date', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('research_artifacts').select('id, artifact_type, title, confidence, created_at').eq('org_id', orgId).order('created_at', { ascending: false }).limit(6),
    ])

    const wl = (wlRes.data || []).map((i: any) => ({ ...i, chainId: i.entity ? chainIdFor(i.entity.chain_namespace, i.entity.chain_id) : null }))
    const counts: Record<string, number> = {}
    for (const i of wl) counts[i.item_type] = (counts[i.item_type] || 0) + 1

    // followed chains = profile selection ∪ chains present in the watchlist.
    const chainSet = new Set<string>([...(profRes.data?.chains_of_interest || [])])
    for (const i of wl) if (i.item_type === 'token' && i.chainId) chainSet.add(i.chainId)
    const followed_chains = [...chainSet].map((id) => ({ id, label: getChain(id)?.label || id, item_count: wl.filter((i: any) => i.item_type === 'token' && i.chainId === id).length }))

    // Performance of the chains the user follows. Hidden entirely when they've
    // selected none; shows all 17 if they selected all 17. Reads the shared
    // intel_chain_perf store (refreshed by the regime cron) — no per-load fetch.
    let chain_perf: any[] = []
    if (followed_chains.length) {
      try {
        const { data: perf } = await supabase.from('intel_chain_perf').select('chain_id, symbol, price, change_24h, market_cap').in('chain_id', followed_chains.map((c: any) => c.id))
        const byId = new Map((perf || []).map((p: any) => [p.chain_id, p]))
        chain_perf = followed_chains
          .map((c: any) => { const p = byId.get(c.id); return p && p.price != null ? { chain_id: c.id, ref: `native:${c.id}`, label: c.label, symbol: p.symbol || getChain(c.id)?.nativeSymbol || null, price: p.price, change_24h: p.change_24h, market_cap: p.market_cap } : null })
          .filter(Boolean)
          .sort((a: any, b: any) => (b.change_24h ?? -999) - (a.change_24h ?? -999))
      } catch { /* best-effort */ }
    }

    // Token universe for movers (scope-filtered).
    let tokenItems = wl.filter((i: any) => i.item_type === 'token' && i.entity?.contract_address)
    if (scope === 'chain' && chain) tokenItems = tokenItems.filter((i: any) => i.chainId === chain)

    // Movers — RENDER PATH: read cached overviews ONLY. This dashboard is hit
    // per user per load, so it must never trigger live Birdeye enrichment in a
    // loop (a driver of the usage spike). cacheOnly:true short-circuits before
    // any live call, and maxCalls:0 is a hard backstop. Movers reflect whatever
    // a background job last warmed into the overview cache; on a cold cache the
    // section is simply empty rather than fanning out to Birdeye.
    // TODO(intel): add a small movers-warmer cron that populates the overview
    // cache for active watchlist tokens so this section is always fresh.
    const movers: any[] = []
    if (beKey) {
      const renderCtx = { supabase, jobName: 'intel-dashboard', caller: 'dashboard-render', orgId, maxCalls: 0 }
      const picks = tokenItems.map((i: any) => i.entity).slice(0, 15)
      const results = await Promise.all(picks.map(async (e: any) => {
        const c = birdeyeChainFor(e.chain_namespace, e.chain_id); if (!c) return null
        const o = await birdeyeOverview(c, e.contract_address, beKey, renderCtx, { cacheOnly: true })
        if (!o || typeof o.price_change_24h_pct !== 'number') return null
        return { symbol: o.symbol || e.display_symbol, ref: e.canonical_ref_key, chainId: chainIdFor(e.chain_namespace, e.chain_id), price: o.price, change24h: o.price_change_24h_pct, liquidity: o.liquidity, volume24h: o.volume_24h_usd }
      }))
      for (const r of results) if (r) movers.push(r)
      movers.sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h))
    }

    // ── Notable News + Signal Radar (deterministic; whale-clustered, ranked) ──
    const wlSymbols = new Set<string>(wl.map((i: any) => String(i.entity?.display_symbol || '').toUpperCase()).filter(Boolean))
    const wlChains = new Set<string>(wl.map((i: any) => i.chainId).filter(Boolean))
    const moverBySymbol = new Map<string, any>(movers.map((m: any) => [String(m.symbol || '').toUpperCase(), m]))

    // Enrich with the exchange market intelligence layer — reads cached latest
    // tables only (no live exchange calls). Improves market-confirmation for the
    // deterministic ranking (intel-signals reads mover.change24h) and powers the
    // market-context cards. Best-effort: absent tables ⇒ unchanged behavior.
    const exBySym = new Map<string, any>()            // best (max-volume) exchange ticker per symbol
    let marketSignalBySymbol = new Map<string, any>()
    try {
      const [exT, exS] = await Promise.all([
        supabase.from('exchange_latest_tickers').select('normalized_symbol, provider, provider_symbol, price_change_pct_24h, volume_quote_24h, spread_pct').limit(1000),
        supabase.from('exchange_latest_market_signals').select('normalized_symbol, direction, strength, confidence, title, summary, why_it_matters, provider_count, confirming_providers').limit(1000),
      ])
      for (const tkr of (exT.data || [])) { const k = String(tkr.normalized_symbol).toUpperCase(); const cur = exBySym.get(k); if (!cur || (tkr.volume_quote_24h || 0) > (cur.volume_quote_24h || 0)) exBySym.set(k, tkr) }
      for (const [k, tkr] of exBySym) if (!moverBySymbol.has(k) && typeof tkr.price_change_pct_24h === 'number') moverBySymbol.set(k, { symbol: k, change24h: tkr.price_change_pct_24h, volume24h: tkr.volume_quote_24h, source: 'exchange' })
      marketSignalBySymbol = new Map((exS.data || []).map((s: any) => [String(s.normalized_symbol).toUpperCase(), s]))
    } catch { /* exchange layer optional */ }
    const marketContextFor = (symbol: string | null | undefined) => {
      if (!symbol) return null
      const k = String(symbol).toUpperCase()
      const ms = marketSignalBySymbol.get(k); const tkr = exBySym.get(k)
      if (!ms || !tkr) return null
      return { direction: ms.direction, strength: ms.strength, confidence: ms.confidence, title: ms.title, summary: ms.summary, whyItMatters: ms.why_it_matters, providerCount: ms.provider_count, confirmingProviders: ms.confirming_providers, source: 'exchange-market', rawMetrics: { pair: tkr.provider_symbol, priceChangePercent24h: tkr.price_change_pct_24h, quoteVolume24h: tkr.volume_quote_24h, spreadPercent: tkr.spread_pct } }
    }
    const rawCandidates = [
      ...(customRes.data || []).map((n: any) => ({ title: n.title, url: n.url, source: n.source_name, sentiment: n.sentiment, published_at: n.published_at || n.created_at, chains: n.entity ? [chainIdFor(n.entity.chain_namespace, n.entity.chain_id)].filter(Boolean) : [], symbol: n.entity?.display_symbol || null, custom: true, origin: 'custom' })),
      ...(globalRes.data || []).map((n: any) => ({ title: n.title, url: n.url, source: n.source_name, sentiment: n.sentiment, published_at: n.published_at || n.created_at, chains: n.chains || [], symbol: n.entity_symbol || null, custom: false, origin: 'global', source_quality: n.source_quality ?? null, authority_tier: n.authority_level ?? null })),
    ]
    const sigOpts = { wlSymbols, wlChains, moverBySymbol, scope, chain }
    const { notable, allCards } = buildNotable(rawCandidates, sigOpts)
    const signals = buildSignalRadar(allCards, sigOpts)

    // Attach reusable SHARED story analysis (AI) when a fresh one exists — no AI on page load.
    if (notable.length) {
      const { data: shared } = await supabase.from('intel_shared_artifacts').select('evidence_hash, structured, consensus')
        .eq('artifact_type', 'story_card').in('evidence_hash', notable.map((c: any) => c.story_hash)).gt('stale_after', new Date().toISOString())
      const byHash = new Map((shared || []).map((s: any) => [s.evidence_hash, s]))
      for (const c of notable) {
        const a = byHash.get(c.story_hash)
        if (a?.structured) {
          const st = a.structured
          c.analysis = { what_happened: st.what_happened, why_it_matters: st.why_it_matters, crypto_market_impact: st.crypto_market_impact, what_to_watch: Array.isArray(st.what_to_watch) ? st.what_to_watch[0] : st.what_to_watch, consensus: a.consensus }
          if (st.net_signal) c.signal = st.net_signal
          if (st.impact_scope) c.scope = st.impact_scope
          if (st.confidence) c.confidence = st.confidence
        }
      }
    }

    // Link Signal Radar ↔ Notable News (a signal cites the stories behind it).
    const notableHashes = new Set(notable.map((c: any) => c.story_hash))
    for (const s of signals) (s as any).related_news_ids = ((s as any).related_news_ids || []).filter((h: string) => notableHashes.has(h)).slice(0, 3)

    // Prefer AI-CURATED Notable News (intel-curate-news cron: Gemini + Grok judged
    // importance/credibility/should_surface). Falls back to the deterministic
    // clustered cards when the curated table is empty. Sub-threshold rows feed a
    // clearly-labelled "Developing chatter" section instead of polluting top news.
    let notableOut = notable
    let developing: any[] = []
    const wlMatch = (c: any) => (c.symbol && wlSymbols.has(String(c.symbol).toUpperCase())) || (c.chains || []).some((ch: string) => wlChains.has(ch))
    const mapCurated = (c: any) => ({
      story_hash: c.cluster_hash, title: c.cleaned_title || c.title, source_name: c.source_type || 'Curated', source_category: c.source_type,
      url: c.primary_url, published_at: c.published_at, chains: c.chains || [], symbol: (c.tokens || [])[0] || null, source_support: c.source_count,
      signal: c.signal, signal_bias: c.signal_bias, news_category: c.news_category, confidence: c.confidence, final_score: c.final_score,
      source_quality: c.source_quality_score, needs_confirmation: c.needs_confirmation, curated: true, supporting_facts: [],
      scope: (c.chains || []).length >= 2 ? 'market_wide' : (c.tokens || []).length ? 'asset_specific' : (c.chains || []).length === 1 ? 'chain_specific' : 'unclear',
      analysis: { what_happened: c.what_happened || c.summary, why_it_matters: c.why_it_matters, crypto_market_impact: c.crypto_impact, what_to_watch: c.watch_next, bull_case: c.bull_case, bear_case: c.bear_case },
      tokens: c.tokens, sectors: c.sectors, narratives: c.narratives, reason_to_suppress: c.reason_to_suppress,
    })
    try {
      const { data: curated } = await supabase.from('intel_curated_news')
        .select('cluster_hash, cleaned_title, title, summary, what_happened, why_it_matters, crypto_impact, watch_next, bull_case, bear_case, chains, tokens, sectors, narratives, signal, signal_bias, news_category, confidence, final_score, source_quality_score, needs_confirmation, source_count, source_type, primary_url, published_at, should_surface, reason_to_suppress')
        .gt('stale_after', new Date().toISOString()).order('final_score', { ascending: false }).limit(40)
      const surfaced = (curated || []).filter((c: any) => c.should_surface).map(mapCurated)
      if (surfaced.length) {
        let cur = surfaced
        if (scope === 'chain' && chain) cur = cur.filter((c) => (c.chains || []).includes(chain))
        cur.sort((a, b) => (b.final_score + (wlMatch(b) ? 20 : 0)) - (a.final_score + (wlMatch(a) ? 20 : 0)))
        notableOut = scope === 'following'
          ? [...notable.filter((c: any) => c.custom), ...cur.filter((c) => !notable.some((n: any) => n.story_hash === c.story_hash))].slice(0, 6)
          : cur.slice(0, 6)
      }
      developing = (curated || []).filter((c: any) => !c.should_surface).slice(0, 4).map(mapCurated)
    } catch { /* fall back to deterministic notable */ }

    // Attach exchange market context (cards render it only when a pair exists).
    for (const c of notableOut) { const mc = marketContextFor(c.symbol); if (mc) (c as any).market_context = mc }
    for (const s of signals) { const mc = marketContextFor((s as any).asset_symbol); if (mc) (s as any).market_context = mc }

    // Emerging-trends / market movers from the exchange layer (top by |24h move|
    // among assets with exchange coverage; quality-aware via the signal direction).
    const market_movers = [...exBySym.entries()]
      .filter(([, t]) => typeof t.price_change_pct_24h === 'number' && (t.volume_quote_24h || 0) > 0)
      .map(([k, t]) => ({ symbol: k, change24h: t.price_change_pct_24h, volume24h: t.volume_quote_24h, market_context: marketContextFor(k) }))
      .sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h))
      .slice(0, 12)

    // Projects for a chain selector: followed tokens on the chain + notable symbols.
    let projects: any[] | null = null
    if (scope === 'chain' && chain) {
      const followedTokens = tokenItems.map((i: any) => ({ symbol: i.entity.display_symbol || i.label, ref: i.entity.canonical_ref_key, followed: true, mover: movers.find((m) => m.ref === i.entity.canonical_ref_key) || null }))
      const followedSymbols = new Set(followedTokens.map((p) => String(p.symbol || '').toLowerCase()))
      const seen = new Map<string, any>()
      for (const c of notable) { const s = c.symbol; if (s && !followedSymbols.has(String(s).toLowerCase())) seen.set(String(s).toLowerCase(), { symbol: s, followed: false }) }
      projects = [...followedTokens, ...[...seen.values()].slice(0, 12)]
    }

    return json({
      scope, chain,
      counts, total_following: wl.length,
      followed_chains,
      chain_perf,
      available_chains: CHAINS.map((c) => ({ id: c.id, label: c.label })),
      movers: movers.slice(0, 12),
      market_movers,
      projects,
      notable: notableOut,
      news: notableOut,
      developing,
      signals,
      narratives: scope === 'following' ? [] : (narrRes.data || []),
      alerts: alertRes.data || [],
      unread_alerts: (alertRes.data || []).filter((a: any) => !a.read_at).length,
      latest_brief: briefRes.data || null,
      recent_research: researchRes.data || [],
      generated_at: new Date().toISOString(),
    })
  } catch (e) {
    return json({ error: (e as Error)?.message || 'dashboard_failed' }, 400)
  }
})
