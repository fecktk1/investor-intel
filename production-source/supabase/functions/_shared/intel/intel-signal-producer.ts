// Investor adapter — the signal PRODUCER.
//
// Promotes the (previously ephemeral) deterministic Signal Radar + narrative_state +
// exchange signals + curated news into ONE normalized, snapshotted store
// (intel_signal_state / intel_signal_snapshots). Runs INSIDE the existing
// intel-curate-news cron (no new job, no provider calls — reads cached tables only).
//
// Identity: every asset resolves to a CANONICAL key via asset-identity (symbol is
// display-only). Privacy: only PUBLIC market intelligence is written here — no
// portfolio/user-wallet rows. Reuse: deterministic why_it_matters/what_to_watch_next
// are stored verbatim; richer AI text is referenced by ai_artifact_ref, never copied.

import { buildNotable, buildSignalRadar } from '../intel-signals.ts'
import { buildAssetResolver } from './asset-identity.ts'
import { computeTrends } from './signal-trends.ts'
import { loadTaxonomy, tagText } from '../signal-tagger.ts'
import { makeCostWriter } from './intel-cost-writer.ts'
import { h32 } from '../core-intel/hashing.ts'
import { recordCostEvent } from '../core-intel/cost-ledger.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DB = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const CONTRACT = 'sig-c1'
const STALE_MS = 90 * 60 * 1000      // 90 min grace (covers two 45-min cron cycles)
const EXPIRE_MS = 24 * 60 * 60 * 1000 // 24h hard cutoff (reads filter expires_at)

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))
const lc = (s: unknown) => String(s ?? '').toLowerCase()

function mapDirection(d: unknown): string {
  const v = lc(d)
  if (v === 'bullish' || v === 'positive') return 'bullish'
  if (v === 'bearish' || v === 'negative') return 'bearish'
  return 'mixed' // neutral/caution/mixed/unknown → mixed (never neutralized away)
}
function confBand(score: number): string {
  if (score >= 70) return 'high'
  if (score >= 45) return 'medium'
  return 'low'
}

interface Sig {
  signal_key: string
  signal_type: string | null
  subject_type: string
  subject_id: string
  display_symbol: string | null
  chain: string | null
  related_assets: string[]
  related_narratives: string[]
  related_wallets: string[]
  direction: string
  confidence: string | null
  source_count: number
  source_diversity: number
  severity: number
  freshness: number
  market_impact: number
  why_it_matters: string | null
  what_to_watch_next: string | null
  evidence_refs: Any[]
  headlines: string[]
  ai_artifact_ref: string | null
  metrics: Record<string, unknown>
  score_delta: Record<string, unknown>
  global_score: number
}

function severityOf(diversity: number, sourceCount: number, marketImpact: number, official: boolean): number {
  return clamp01(0.4 * Math.min(diversity, 3) / 3 + 0.3 * Math.min(sourceCount, 6) / 6 + 0.2 * marketImpact + 0.1 * (official ? 1 : 0))
}
function globalScoreOf(severity: number, diversity: number, freshness: number, marketImpact: number): number {
  return clamp01(0.35 * severity + 0.25 * (Math.min(diversity, 3) / 3) + 0.2 * freshness + 0.2 * marketImpact)
}

export interface ProduceResult { signals: number; snapshots: number; skipped: number }

export async function produceSignalState(admin: DB, opts: { now?: number } = {}): Promise<ProduceResult> {
  const now = opts.now ?? Date.now()
  const nowIso = new Date(now).toISOString()
  const since = new Date(now - 14 * 86_400_000).toISOString()

  const [resolver, tax] = await Promise.all([buildAssetResolver(admin), loadTaxonomy(admin)])

  // ── cached reads only (no providers) ───────────────────────
  const baseSel = 'title, url, source_name, sentiment, published_at, created_at, chains, entity_symbol'
  let gnRes = await admin.from('intel_global_news').select(`${baseSel}, source_quality, authority_level, news_category`).gte('created_at', since).order('created_at', { ascending: false }).limit(300)
  if (gnRes.error) gnRes = await admin.from('intel_global_news').select(baseSel).gte('created_at', since).order('created_at', { ascending: false }).limit(300)

  const [curRes, tkrRes, exsRes, narrRes, priorRes] = await Promise.all([
    admin.from('intel_curated_news').select('cluster_hash, cleaned_title, title, why_it_matters, watch_next, chains, tokens, narratives, signal, signal_bias, confidence, final_score, source_count, should_surface').gt('stale_after', nowIso).eq('should_surface', true).order('final_score', { ascending: false }).limit(60),
    admin.from('exchange_latest_tickers').select('normalized_symbol, price_change_pct_24h, volume_quote_24h, spread_pct').limit(2000),
    admin.from('exchange_latest_market_signals').select('normalized_symbol, direction, strength, confidence, title, summary, why_it_matters, provider_count, confirming_providers').limit(2000),
    admin.from('narrative_state').select('narrative_id, signal_class, lifecycle_stage, prev_stage, global_priority_score, confidence_score, freshness_score, price_confirmation_score, volume_confirmation_score, breadth_score, risk_score, related_chains, related_assets, leaders, score_delta, narrative_taxonomy!inner(slug, name, status)').limit(400),
    admin.from('intel_signal_state').select('signal_key, direction, global_score, cache_key').limit(20000),
  ])

  const prior = new Map<string, { direction: string; global_score: number; cache_key: string | null }>()
  for (const r of (priorRes.data || [])) prior.set(r.signal_key, { direction: r.direction, global_score: Number(r.global_score) || 0, cache_key: r.cache_key ?? null })

  // movers from cached exchange tickers (best by volume per symbol) — no Birdeye.
  const exBySym = new Map<string, Any>()
  for (const t of (tkrRes.data || [])) {
    const k = String(t.normalized_symbol || '').toUpperCase(); if (!k) continue
    const cur = exBySym.get(k); if (!cur || (t.volume_quote_24h || 0) > (cur.volume_quote_24h || 0)) exBySym.set(k, t)
  }
  const moverBySymbol = new Map<string, Any>()
  for (const [k, t] of exBySym) if (typeof t.price_change_pct_24h === 'number') moverBySymbol.set(k, { symbol: k, change24h: t.price_change_pct_24h, volume24h: t.volume_quote_24h })

  // ── deterministic Signal Radar (unchanged engine) ─────────
  const rawCandidates = (gnRes.data || []).map((n: Any) => ({ title: n.title, url: n.url, source: n.source_name, sentiment: n.sentiment, published_at: n.published_at || n.created_at, chains: n.chains || [], symbol: n.entity_symbol || null, custom: false, origin: 'global', source_quality: n.source_quality ?? null, authority_tier: n.authority_level ?? null, news_category: n.news_category ?? null }))
  const { allCards } = buildNotable(rawCandidates, { wlSymbols: new Set(), wlChains: new Set(), moverBySymbol, scope: 'all' })
  const radar = buildSignalRadar(allCards, { wlSymbols: new Set(), wlChains: new Set(), moverBySymbol, scope: 'all' })

  // co-mention index: tokens appearing together in the same stories, so a radar
  // signal can personalize to a held/watched asset it merely co-mentions. Keys are
  // canonical (same space as the wl/hold CTEs in signal_feed_v2). Narratives come
  // from the deterministic taxonomy tagger. Both from already-fetched data; no provider.
  const coByHash = new Map<string, Set<string>>()
  for (const c of allCards) {
    if (!c.symbol) continue
    const set = coByHash.get(c.story_hash) || new Set<string>()
    set.add(String(c.symbol).toUpperCase()); coByHash.set(c.story_hash, set)
  }
  const coMentionsFor = (ids: string[], selfSym: string | null): string[] => {
    const syms = new Set<string>()
    for (const h of (ids || [])) { const s = coByHash.get(h); if (s) for (const x of s) syms.add(x) }
    if (selfSym) syms.delete(String(selfSym).toUpperCase())
    return [...new Set([...syms].map((s) => resolver.toCanonicalKey(s)).filter(Boolean) as string[])].slice(0, 8)
  }
  const narrativesFor = (text: string): string[] => [...new Set(tagText(text, tax).narratives.map(lc))].slice(0, 6)

  // story_hash → latest published_at (for truthful freshness)
  const pubByHash = new Map<string, number>()
  for (const c of allCards) { const p = new Date(c.published_at || 0).getTime(); if (!Number.isNaN(p)) pubByHash.set(c.story_hash, Math.max(pubByHash.get(c.story_hash) || 0, p)) }
  const freshnessFromHashes = (ids: string[]): number => {
    let latest = 0; for (const h of (ids || [])) latest = Math.max(latest, pubByHash.get(h) || 0)
    if (!latest) return 0.6
    return clamp01(Math.exp(-((now - latest) / 3_600_000) / 24))
  }

  const acc = new Map<string, Sig>()

  // 1) radar asset/chain signals
  for (const s of radar) {
    let subject_type: string, subject_id: string | null, display_symbol: string | null, chain: string | null
    if (s.kind === 'token' && s.asset_symbol) {
      subject_type = 'asset'; subject_id = resolver.toCanonicalKey(s.asset_symbol); display_symbol = s.asset_symbol; chain = null
    } else if (s.kind === 'chain') {
      subject_type = 'chain'; subject_id = resolver.keyForChain(s.name); display_symbol = String(s.name).toUpperCase(); chain = lc(s.name)
    } else continue
    if (!subject_id) continue
    const market_impact = typeof s.change_24h === 'number' ? clamp01(Math.abs(s.change_24h) / 15) : 0
    const freshness = freshnessFromHashes(s.related_news_ids)
    const diversity = s.source_diversity || 0
    const severity = severityOf(diversity, s.source_count || s.mention_count || 0, market_impact, !!s.has_official)
    const global_score = globalScoreOf(severity, diversity, freshness, market_impact)
    acc.set(`${subject_type}:${subject_id}`, {
      signal_key: `${subject_type}:${subject_id}`, signal_type: s.signal_type || null,
      subject_type, subject_id, display_symbol, chain,
      related_assets: coMentionsFor(s.related_news_ids, display_symbol), related_narratives: narrativesFor([s.why_it_matters || '', ...(s.headlines || [])].join(' ')), related_wallets: [],
      direction: mapDirection(s.direction), confidence: s.confidence || (diversity >= 2 ? 'medium' : 'low'),
      source_count: s.source_count || s.mention_count || 0, source_diversity: diversity,
      severity, freshness, market_impact,
      why_it_matters: s.why_it_matters || null, what_to_watch_next: s.what_to_watch_next || null,
      evidence_refs: (s.related_news_ids || []).slice(0, 4).map((id: string) => ({ kind: 'news_cluster', id })),
      headlines: (s.headlines || []).slice(0, 3), ai_artifact_ref: null,
      metrics: { change_24h: s.change_24h ?? null, has_official: !!s.has_official }, score_delta: {}, global_score,
    })
  }

  // 2) exchange market signals → enrich matching asset, or create
  const exSig = new Map<string, Any>()
  for (const e of (exsRes.data || [])) { const k = String(e.normalized_symbol || '').toUpperCase(); if (k) exSig.set(k, e) }
  for (const [sym, e] of exSig) {
    const key = resolver.toCanonicalKey(sym); if (!key) continue
    const skey = `asset:${key}`
    const tkr = exBySym.get(sym)
    const mi = tkr && typeof tkr.price_change_pct_24h === 'number' ? clamp01(Math.abs(tkr.price_change_pct_24h) / 15) : 0
    const existing = acc.get(skey)
    if (existing) {
      existing.market_impact = Math.max(existing.market_impact, mi)
      if (!existing.why_it_matters && e.why_it_matters) existing.why_it_matters = e.why_it_matters
      existing.source_count = Math.max(existing.source_count, Number(e.provider_count) || 0)
      ;(existing.metrics as Any).exchange = { direction: e.direction, strength: e.strength, provider_count: e.provider_count }
      existing.severity = Math.max(existing.severity, severityOf(existing.source_diversity, existing.source_count, existing.market_impact, false))
      existing.global_score = globalScoreOf(existing.severity, existing.source_diversity, existing.freshness, existing.market_impact)
    } else {
      const diversity = Math.min(Number(e.provider_count) || 1, 3)
      const freshness = 0.8
      const severity = severityOf(diversity, Number(e.provider_count) || 1, mi, false)
      acc.set(skey, {
        signal_key: skey, signal_type: 'exchange_market', subject_type: 'asset', subject_id: key,
        display_symbol: resolver.displaySymbolFor(key) || sym, chain: null,
        related_assets: [], related_narratives: narrativesFor([e.title || '', e.summary || '', e.why_it_matters || ''].join(' ')), related_wallets: [],
        direction: mapDirection(e.direction), confidence: e.confidence || 'medium',
        source_count: Number(e.provider_count) || 1, source_diversity: diversity,
        severity, freshness, market_impact: mi,
        why_it_matters: e.why_it_matters || e.summary || null,
        what_to_watch_next: 'Whether the move holds across venues with volume — research context, not a recommendation.',
        evidence_refs: [], headlines: e.title ? [e.title] : [], ai_artifact_ref: null,
        metrics: { exchange: { direction: e.direction, strength: e.strength, provider_count: e.provider_count, confirming: e.confirming_providers } },
        score_delta: {}, global_score: globalScoreOf(severity, diversity, freshness, mi),
      })
    }
  }

  // 3) narrative_state → narrative signals
  for (const n of (narrRes.data || [])) {
    const tax = (n as Any).narrative_taxonomy
    const slug = tax?.slug; if (!slug || (tax?.status && !['active', 'surfaced'].includes(tax.status))) continue
    const skey = `narrative:${lc(slug)}`
    const priority = Number(n.global_priority_score) || 0
    const severity = clamp01(priority / 100)
    const freshness = clamp01((Number(n.freshness_score) || 0) / 100)
    const market_impact = clamp01(((Number(n.price_confirmation_score) || 0) + (Number(n.volume_confirmation_score) || 0)) / 200)
    const related_assets = Array.isArray(n.related_assets)
      ? (n.related_assets as Any[]).map((a) => resolver.toCanonicalKey(typeof a === 'string' ? a : (a?.symbol))).filter(Boolean) as string[]
      : []
    const leadSym = Array.isArray(n.leaders) && n.leaders[0] ? (n.leaders[0] as Any).symbol : null
    acc.set(skey, {
      signal_key: skey, signal_type: 'narrative', subject_type: 'narrative', subject_id: lc(slug),
      display_symbol: tax?.name || slug, chain: (n.related_chains || [])[0] || null,
      related_assets: [...new Set(related_assets)].slice(0, 12), related_narratives: [lc(slug)], related_wallets: [],
      direction: mapDirection(n.signal_class), confidence: confBand(Number(n.confidence_score) || 0),
      source_count: Math.max(1, Math.round((Number(n.breadth_score) || 0) / 20)), source_diversity: 2,
      severity, freshness, market_impact,
      why_it_matters: `${tax?.name || slug} is ${String(n.lifecycle_stage || 'forming').replace(/_/g, ' ')} (${mapDirection(n.signal_class)})${leadSym ? `, with $${leadSym} among the leaders` : ''}. Research context, not advice.`,
      what_to_watch_next: 'Whether price/volume confirmation and on-chain activity keep pace with attention; downgrade if it stays chatter-only.',
      evidence_refs: [], headlines: [], ai_artifact_ref: (n as Any).brief_artifact_ref || null,
      metrics: { lifecycle_stage: n.lifecycle_stage, risk_score: n.risk_score, narrative: n.score_delta || {} },
      score_delta: {}, global_score: severity,
    })
  }

  // 4) curated news → news signals
  for (const c of (curRes.data || [])) {
    const hash = c.cluster_hash; if (!hash) continue
    const skey = `news:${hash}`
    const severity = clamp01((Number(c.final_score) || 0) / 100)
    const tokens = Array.isArray(c.tokens) ? (c.tokens as Any[]).map((t) => resolver.toCanonicalKey(t)).filter(Boolean) as string[] : []
    acc.set(skey, {
      signal_key: skey, signal_type: 'news', subject_type: 'news', subject_id: String(hash),
      display_symbol: c.cleaned_title || c.title || 'Story', chain: (c.chains || [])[0] || null,
      related_assets: [...new Set(tokens)].slice(0, 8), related_narratives: (c.narratives || []).map(lc).slice(0, 6), related_wallets: [],
      direction: mapDirection(c.signal || c.signal_bias), confidence: c.confidence || 'medium',
      source_count: Number(c.source_count) || 1, source_diversity: Math.min(Number(c.source_count) || 1, 3),
      severity, freshness: 0.8, market_impact: 0,
      why_it_matters: c.why_it_matters || null, what_to_watch_next: c.watch_next || null,
      evidence_refs: [{ kind: 'curated_cluster', id: hash }], headlines: [c.cleaned_title || c.title].filter(Boolean) as string[],
      ai_artifact_ref: null, metrics: {}, score_delta: {}, global_score: severity,
    })
  }

  // ── snapshot-history trends (severity windows) — momentum/decay/streak the
  // single-cron prev-delta can't express. One batched read per ~200 keys, hits
  // iss_snap_key_time. No providers, no new tables. Severity is the stored basis.
  const sevenAgo = new Date(now - 7 * 86_400_000).toISOString()
  const allKeys = [...acc.keys()]
  const histChunks: string[][] = []
  for (let i = 0; i < allKeys.length; i += 200) histChunks.push(allKeys.slice(i, i + 200))
  const histResults = await Promise.all(histChunks.map(async (chunk) => {
    try {
      const r = await admin.from('intel_signal_snapshots')
        .select('signal_key, snapshot_at, severity, direction')
        .gte('snapshot_at', sevenAgo).in('signal_key', chunk).order('snapshot_at', { ascending: true })
      return (r?.data || []) as Any[]
    } catch { return [] as Any[] }
  }))
  const histById = new Map<string, Any[]>()
  for (const rows of histResults) for (const r of rows) { const a = histById.get(r.signal_key) || []; a.push(r); histById.set(r.signal_key, a) }

  // ── finalize: deltas vs prior, cache_key, write ───────────
  const snapRows: Any[] = []
  const stateRows: Any[] = []
  let skipped = 0
  for (const sig of acc.values()) {
    const p = prior.get(sig.signal_key)
    const contentHash = h32(`${sig.direction}|${(sig.headlines || []).join('~')}|${sig.why_it_matters || ''}|${sig.global_score.toFixed(3)}`)
    const cache_key = h32(`${sig.signal_key}|${contentHash}|${CONTRACT}`)
    const trends = computeTrends(
      (histById.get(sig.signal_key) || []).map((r: Any) => ({ snapshot_at: r.snapshot_at, value: Number(r.severity), direction: r.direction })),
      { value: sig.severity, direction: sig.direction }, now,
    )
    const score_delta = {
      ...(sig.score_delta || {}),
      prev_direction: p?.direction ?? null,
      prev_global_score: p?.global_score ?? null,
      d_global_score: p ? Number((sig.global_score - p.global_score).toFixed(4)) : 0,
      ...trends,
    }
    const changed = !p || p.cache_key !== cache_key

    stateRows.push({
      signal_key: sig.signal_key, signal_type: sig.signal_type, subject_type: sig.subject_type, subject_id: sig.subject_id,
      display_symbol: sig.display_symbol, chain: sig.chain,
      related_assets: sig.related_assets, related_narratives: sig.related_narratives, related_wallets: sig.related_wallets,
      direction: sig.direction, confidence: sig.confidence, source_count: sig.source_count, source_diversity: sig.source_diversity,
      severity: sig.severity, freshness: sig.freshness, market_impact: sig.market_impact,
      why_it_matters: sig.why_it_matters, what_to_watch_next: sig.what_to_watch_next,
      evidence_refs: sig.evidence_refs, headlines: sig.headlines, ai_artifact_ref: sig.ai_artifact_ref,
      metrics: sig.metrics, score_delta, global_score: sig.global_score, cache_key,
      generated_at: nowIso, stale_after: new Date(now + STALE_MS).toISOString(), expires_at: new Date(now + EXPIRE_MS).toISOString(),
    })
    if (changed) {
      snapRows.push({
        signal_key: sig.signal_key, snapshot_at: nowIso, signal_type: sig.signal_type, subject_type: sig.subject_type,
        subject_id: sig.subject_id, display_symbol: sig.display_symbol, chain: sig.chain, direction: sig.direction,
        confidence: sig.confidence, source_count: sig.source_count, source_diversity: sig.source_diversity,
        severity: sig.severity, freshness: sig.freshness, market_impact: sig.market_impact, metrics: sig.metrics, score_delta,
      })
    } else skipped++
  }

  for (let i = 0; i < stateRows.length; i += 100) {
    const { error } = await admin.from('intel_signal_state').upsert(stateRows.slice(i, i + 100), { onConflict: 'signal_key' })
    if (error) throw error
  }
  for (let i = 0; i < snapRows.length; i += 100) {
    const { error } = await admin.from('intel_signal_snapshots').insert(snapRows.slice(i, i + 100))
    if (error) throw error
  }

  // cost ledger (precise; no AI, no provider calls — records avoidance)
  await recordCostEvent(makeCostWriter(admin), {
    feature: 'signal_producer', orgId: null, cacheStatus: 'no_ai', allowReason: 'n/a_no_ai',
    providerCallsMade: 0, providerCallsAvoided: stateRows.length,
    usage: { signals: stateRows.length, snapshots: snapRows.length, skipped },
  }, { precision: 'exact', nowMs: now })

  return { signals: stateRows.length, snapshots: snapRows.length, skipped }
}
