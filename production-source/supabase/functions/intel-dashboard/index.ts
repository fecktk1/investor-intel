// Investor Intel — home dashboard digest (scope-aware).
// scope='all'      → everything notable (global + custom)
// scope='chain'    → a single chain: its news/movers/projects + your followed items on it
// scope='following'→ only the user's custom-followed items
// Also returns followed_chains + per-chain projects for the chain/project selectors.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { birdeyeChainFor, birdeyeOverview } from '../_shared/intel-providers.ts'
import { chainIdFor, getChain, CHAINS } from '../_shared/chains.ts'
import { buildNotable, buildSignalRadar, clusterTitles } from '../_shared/intel-signals.ts'
import { makeCostWriter } from '../_shared/intel/intel-cost-writer.ts'
import { recordCostEvent } from '../_shared/core-intel/cost-ledger.ts'
import { assembleBriefEvidencePack } from '../_shared/intel/brief-evidence-pack.ts'
import {requireIntelAccess} from '../_shared/intel/research-service.ts'
import {orgAuthzErrorResponse} from '../_shared/org-authz.ts'
import {nativeChainPerformance} from '../_shared/intel/chain-performance.ts'
import {requestCmc} from '../_shared/market-assets/cmc-transport.ts'
import {cmcRows} from '../_shared/market-assets/cmc-capabilities.ts'
import {nativeCmcId} from '../_shared/intel/cmc-chart.ts'
import {dashboardSourceReads,withCuratedEnvelope,dashboardFigureProvenance,CHAIN_QUOTE_REFRESH_SECONDS} from '../_shared/intel/dashboard-reads.ts'
import {fromCmcReceipt,storedReceipt,type SourceReceipt} from '../_shared/intel/source-receipt.ts'
import {readMetricAgreement} from '../_shared/intel/metric-agreement-read.ts'
import {metricAgreementReceipt} from '../_shared/intel/metric-agreement.ts'
import {readDashboardPicture} from '../_shared/intel/dashboard-picture.ts'

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
function json(b: unknown, s = 200, timing = '') { return new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control':'private, no-store', ...(timing?{'Server-Timing':timing}:{}) } }) }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: {...corsHeaders, 'Access-Control-Max-Age': '600'} })
  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'No authorization header' }, 401)
    const { orgId, scope = 'all', chain = null, section = 'full' } = await req.json() || {}
    if (!orgId) return json({ error: 'orgId required' }, 400)
    if (!['all', 'chain', 'following'].includes(scope) || !['core', 'picture', 'grounding', 'full'].includes(section)
      || (chain != null && !CHAINS.some(c => c.id === chain))) return json({ error: 'Invalid dashboard scope' }, 400)

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
    const accessAdmin=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const actor=await requireIntelAccess(req,createClient,accessAdmin,orgId)
    if(!actor.userId)return json({error:'Unauthorized'},401)
    const auth={user:{id:actor.userId}}

    if(section==='picture'){
      const result=await readDashboardPicture(supabase,orgId,auth.user.id)
      return json({intelligence_grounding:result.picture,generated_at:result.picture.assembled_at},200,result.timing)
    }

    // Independent cached evidence lane: callers can paint the desk while this
    // stored-data assembly completes. Verify identity/org before privileged reads.
    if (section === 'grounding') {
      const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
      const intelligence_grounding = await assembleBriefEvidencePack(admin, { orgId, userId: auth.user.id, maxAssets: 6 })
      return json({ intelligence_grounding, generated_at: new Date().toISOString() })
    }
    const beKey = Deno.env.get('BIRDEYE_API_KEY')
    const batch=dashboardSourceReads(supabase,orgId,auth.user.id,scope,chain)
    const {sources}=batch
    const changesPromise=sources.changes
    const [wlRes,profRes,customRes,globalRes,narrRes,alertRes,briefRes,researchRes]=await Promise.all([
      sources.watchlist,sources.profile,sources.custom_news,sources.global_news,sources.narratives,sources.alerts,sources.brief,sources.research,
    ])

    const wl = (wlRes.data || []).slice(0,200).map((i: any) => ({ ...i, chainId: i.entity ? chainIdFor(i.entity.chain_namespace, i.entity.chain_id) : null }))
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
    // Receipts for the chain quotes. The CMC read below is render-only (cache,
    // no call), so its receipt describes the shared snapshot; stored CoinGecko
    // rows get a receipt that describes the stored table instead.
    const chain_perf_receipts: SourceReceipt[] = []
    if (followed_chains.length) {
      try {
        const ids=[...new Set(followed_chains.map((c:any)=>nativeCmcId(c.id)).filter(Boolean))]
        const [cached,cmc]=await Promise.all([
          supabase.from('intel_chain_perf').select('chain_id, coingecko_id, symbol, price, change_24h, market_cap,updated_at').limit(100),
          ids.length?requestCmc('quotes',{id:ids.join(',')},{supabase:accessAdmin,kind:'render',maxCalls:0,caller:'dashboard-render'}):Promise.resolve(null)
        ])
        const quotes=cmc?.payload?cmcRows('quotes',cmc.payload).rows.map(row=>({provider:'coinmarketcap',provider_id:String(row.id),symbol:row.symbol,price:row.quote.price,change_24h:row.quote.percent_change_24h,market_cap:row.quote.market_cap,updated_at:row.quote.last_updated||row.last_updated})):[]
        chain_perf = nativeChainPerformance(followed_chains,[...quotes,...(cached.data||[])])
        const cmcReceipt=fromCmcReceipt(cmc?.receipt)
        if(cmcReceipt&&chain_perf.some((c:any)=>c.source==='coinmarketcap'))chain_perf_receipts.push(cmcReceipt)
        const geckoRows=chain_perf.filter((c:any)=>c.source==='coingecko')
        if(geckoRows.length)chain_perf_receipts.push(storedReceipt({provider:'coingecko',capability:'intel_chain_perf',origin:'stored',
          fetchedAt:geckoRows.map((c:any)=>c.as_of).sort().at(-1),refreshSeconds:CHAIN_QUOTE_REFRESH_SECONDS}))
        // The evidentiary standard for each CoinMarketCap chain quote, from the
        // retained observations only: no provider call and no credit.
        await Promise.all(chain_perf.map(async(c:any)=>{
          const id=c.source==='coinmarketcap'?nativeCmcId(c.chain_id):null
          if(!id)return
          try{c.metric_agreement=metricAgreementReceipt(await readMetricAgreement(accessAdmin,`market:coinmarketcap:${id}`,Date.now()))}catch{/* additive */}
        }))
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
    const exchangeAsOf: unknown[] = []
    let marketSignalBySymbol = new Map<string, any>()
    try {
      const [exT,exS]=await Promise.all([sources.exchange_tickers,sources.exchange_signals])
      for (const tkr of (exT.data || [])) { exchangeAsOf.push(tkr.as_of); const k = String(tkr.normalized_symbol).toUpperCase(); const cur = exBySym.get(k); if (!cur || (tkr.volume_quote_24h || 0) > (cur.volume_quote_24h || 0)) exBySym.set(k, tkr) }
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
      ...(globalRes.data || []).map((n: any) => ({ title: n.title, url: n.url, source: n.source_name, sentiment: n.sentiment, published_at: n.published_at || n.created_at, chains: n.chains || [], symbol: n.entity_symbol || null, custom: false, origin: 'global', source_quality: n.source_quality ?? null, authority_tier: n.authority_level ?? null, news_category: n.news_category ?? null })),
    ]
    const sigOpts = { wlSymbols, wlChains, moverBySymbol, scope, chain }
    const { notable, allCards } = buildNotable(rawCandidates, sigOpts)
    let signals = buildSignalRadar(allCards, sigOpts)   // deterministic fallback; reused from the store below when available

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
    let newsSource: 'curated' | 'stored' = 'stored'
    const wlMatch = (c: any) => (c.symbol && wlSymbols.has(String(c.symbol).toUpperCase())) || (c.chains || []).some((ch: string) => wlChains.has(ch))
    const mapCurated = (c: any) => withCuratedEnvelope({
      story_hash: c.cluster_hash, title: c.cleaned_title || c.title, source_name: c.source_type || 'Curated', source_category: c.source_type,
      url: c.primary_url, published_at: c.published_at, chains: c.chains || [], symbol: (c.tokens || [])[0] || null, source_support: c.source_count,
      signal: c.signal, signal_bias: c.signal_bias, news_category: c.news_category, confidence: c.confidence, final_score: c.final_score,
      source_quality: c.source_quality_score, needs_confirmation: c.needs_confirmation, curated: true, supporting_facts: [],
      scope: (c.chains || []).length >= 2 ? 'market_wide' : (c.tokens || []).length ? 'asset_specific' : (c.chains || []).length === 1 ? 'chain_specific' : 'unclear',
      analysis: { what_happened: c.what_happened || c.summary, why_it_matters: c.why_it_matters, crypto_market_impact: c.crypto_impact, what_to_watch: c.watch_next, bull_case: c.bull_case, bear_case: c.bear_case },
      tokens: c.tokens, sectors: c.sectors, narratives: c.narratives, reason_to_suppress: c.reason_to_suppress,
    }, c)
    try {
      const {data:curated}=await sources.curated_news
      const surfaced = (curated || []).filter((c: any) => c.should_surface).map(mapCurated)
      if (surfaced.length) {
        let cur: any[] = surfaced
        if (scope === 'chain' && chain) cur = cur.filter((c) => (c.chains || []).includes(chain))
        cur.sort((a, b) => (b.final_score + (wlMatch(b) ? 20 : 0)) - (a.final_score + (wlMatch(a) ? 20 : 0)))
        notableOut = scope === 'following'
          ? [...notable.filter((c: any) => c.custom), ...cur.filter((c) => !notable.some((n: any) => n.story_hash === c.story_hash))].slice(0, 6)
          : cur.slice(0, 6)
        newsSource = 'curated'
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
      const followedTokens: any[] = tokenItems.map((i: any) => ({ symbol: i.entity.display_symbol || i.label, ref: i.entity.canonical_ref_key, followed: true, mover: movers.find((m) => m.ref === i.entity.canonical_ref_key) || null }))
      const followedSymbols = new Set(followedTokens.map((p) => String(p.symbol || '').toLowerCase()))
      const seen = new Map<string, any>()
      for (const c of notable) { const s = c.symbol; if (s && !followedSymbols.has(String(s).toLowerCase())) seen.set(String(s).toLowerCase(), { symbol: s, followed: false }) }
      projects = [...followedTokens, ...[...seen.values()].slice(0, 12)]
    }

    // ── Reusable Intel Signal store (Phase 1): personalized rails + "what changed" ──
    // Primary Signal Radar reuses the stored, snapshotted signals (generated once by
    // the producer, ranked per-user at read time by signal_feed_v2). The deterministic
    // buildSignalRadar above stays as the cold-start fallback when the store is empty.
    const storeRowToCard = (r: any) => {
      const kind = r.subject_type === 'chain' ? 'chain' : r.subject_type === 'narrative' ? 'narrative' : r.subject_type === 'news' ? 'news' : 'token'
      const asset_symbol = r.subject_type === 'asset' ? String(r.display_symbol || '').toUpperCase() || null : null
      const card: any = {
        id: r.signal_key, name: r.display_symbol || r.subject_id, kind, asset_symbol,
        chain: r.chain || null, ref: (r.subject_type === 'asset' || r.subject_type === 'chain') ? r.subject_id : null,
        signal_type: r.signal_type || 'Signal', signal_scope: kind === 'token' ? 'token_specific' : kind === 'chain' ? 'chain_specific' : kind,
        direction: r.direction, confidence: r.confidence, time_window: 'last 24h',
        mention_count: r.source_count, source_count: r.source_count, source_diversity: r.source_diversity,
        headlines: r.headlines || [], why_it_matters: r.why_it_matters, what_to_watch_next: r.what_to_watch_next,
        change_24h: (r.metrics && typeof r.metrics.change_24h === 'number') ? r.metrics.change_24h : null,
        supporting_facts: [], related_news_ids: (r.evidence_refs || []).map((e: any) => e.id).filter(Boolean),
        severity: r.severity, global_score: r.global_score, score_delta: r.score_delta || {},
        reasons: r.reasons || [], on_watchlist: !!r.on_watchlist, affects_holding: !!r.affects_holding,
        generated_at: r.generated_at, stale_after: r.stale_after,
      }
      const mc = marketContextFor(card.asset_symbol); if (mc) card.market_context = mc
      return card
    }

    let for_you: any[] = [], affects_holdings: any[] = [], followed_signals: any[] = [], outside_bubble: any[] = []
    let what_changed: any[] = []
    let signals_source = 'fallback_radar'
    try {
      const {data:feed}=await sources.signal_feed
      if (Array.isArray(feed) && feed.length) {
        // Read-time guard: collapse residual near-duplicate NEWS cards (same event,
        // different wording) so one story can't flood the feed before the curation/
        // producer crons re-cluster it. Keep the highest-ranked per cluster (feed is
        // already final_rank-ordered); non-news cards pass through untouched.
        const rawCards = feed.map(storeRowToCard)
        const newsClusters = clusterTitles(rawCards.map((c: any) => c.kind === 'news' ? String(c.name || (c.headlines || [])[0] || '') : ''))
        const seenNews = new Set<number>()
        const cards = rawCards.filter((c: any, i: number) => {
          if (c.kind !== 'news') return true
          const cid = newsClusters[i]
          if (seenNews.has(cid)) return false
          seenNews.add(cid); return true
        })
        for_you = cards.filter((c: any) => (c.reasons || []).length).slice(0, 6)
        affects_holdings = cards.filter((c: any) => c.affects_holding).slice(0, 6)
        followed_signals = cards.filter((c: any) => (c.reasons || []).includes('followed narrative') || c.on_watchlist).slice(0, 6)
        outside_bubble = cards.filter((c: any) => !(c.reasons || []).length).slice(0, 3)
        const primary = scope === 'following' ? cards.filter((c: any) => (c.reasons || []).length) : cards
        if (primary.length) signals = primary.slice(0, scope === 'chain' ? 8 : 6)
        signals_source = 'signal_store'
      }
    } catch { /* store not deployed yet → keep deterministic fallback radar */ }
    let what_changed_context: any = { items: [], coverage: 'unavailable' }
    try {
      const { data: wc, error } = await changesPromise
      if (!error && wc) { what_changed_context = wc; what_changed = wc.items || [] }
    } catch { /* Display unavailable, never invent a last-visit baseline. */ }

    // Bucketed cost-ledger event (no write-amplification): this render made ZERO
    // provider calls (cacheOnly + maxCalls:0). Record the avoidance, collapsed per
    // org+hour. Uses a service-role client ONLY for the ledger write — never for reads.
    try {
      const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
      await recordCostEvent(makeCostWriter(admin), {
        feature: 'dashboard', orgId, cacheStatus: signals_source === 'signal_store' ? 'no_ai' : 'fallback',
        allowReason: signals_source === 'signal_store' ? 'n/a_no_ai' : 'fallback',
        providerCallsMade: 0, providerCallsAvoided: tokenItems.length,
      }, { precision: 'bucketed', nowMs: Date.now() })
    } catch { /* ledger best-effort */ }

    let intelligence_grounding: any = null
    if (section === 'full') try {
      const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
      intelligence_grounding = await assembleBriefEvidencePack(admin, {
        orgId,
        userId: auth.user.id,
        watchlistSymbols: [...wlSymbols].slice(0, 12),
        maxAssets: 6,
      })
    } catch { /* dashboard grounding is additive */ }

    return json({
      scope, chain,
      read_states: batch.states,
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
      signals_source,
      for_you,
      affects_holdings,
      followed_signals,
      outside_bubble,
      what_changed,
      what_changed_context,
      intelligence_grounding,
      narratives: scope === 'following' ? [] : (narrRes.data || []),
      alerts: alertRes.data || [],
      unread_alerts: alertRes.error?null:(alertRes.data || []).filter((a: any) => !a.read_at).length,
      latest_brief: briefRes.data || null,
      recent_research: researchRes.data || [],
      // Play 7: every figure group names its source, clock, freshness and scope.
      figure_provenance: dashboardFigureProvenance({chainPerf:chain_perf,movers,marketMovers:market_movers,exchangeAsOf,news:notableOut,newsSource,signals,signalsSource:signals_source}),
      receipts: { chain_perf: chain_perf_receipts },
      personal_coverage:{watchlist_truncated:(wlRes.data?.length||0)>200,watchlist_error:!!wlRes.error,profile_error:!!profRes.error,alerts_error:!!alertRes.error,research_error:!!researchRes.error},
      generated_at: new Date().toISOString(),
    },200,batch.timing())
  } catch (e) {
    const denied=orgAuthzErrorResponse(e,corsHeaders);if(denied)return denied
    return json({ error: (e as Error)?.message || 'dashboard_failed' }, 400)
  }
})
