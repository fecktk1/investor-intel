import { h32 } from '../core-intel/hashing.ts'
import { assembleAssetMiniPack, type AssetMiniPack } from './asset-mini-pack.ts'
import type { DataCoverage } from './asset-evidence-pack.ts'
import { loadPrivateBriefContext } from './private-brief-context.ts'
import { briefSubject } from './brief-identity.ts'
import { readBriefNews } from './brief-news.ts'
import { loadCmcAiAllowed, containsCmcOrigin, prepareAiContext } from './ai-source-policy.ts'

// deno-lint-ignore no-explicit-any
type DB = any
// deno-lint-ignore no-explicit-any
type Any = any

export interface BriefEvidencePackOptions {
  orgId: string
  userId: string
  portfolioId?: string | null
  watchlistSymbols?: string[]
  holdings?: Array<{ canonicalKey?: string | null; chain?: string | null; tokenAddress?: string | null; symbol?: string | null; quantity?: number; costBasisStatus?: string; priceStatus?: string; value?: number | null; dayPnl?: number | null; dayPnlPct?: number | null }>
  maxAssets?: number
  now?: Date
  forAi?: boolean
}

export interface BriefEvidencePack {
  content_hash: string
  assembled_at: string
  org_scope: { org_id: string; user_id: string; watchlist_count: number; holding_count: number }
  market_regime: Any | null
  macro_rotation: {
    macro: Any[]
    rankings: Any[]
    categories: Any[]
  }
  watchlist_assets: AssetMiniPack[]
  portfolio_holdings: BriefEvidencePackOptions['holdings']
  portfolio_scope: {id:string;name?:string} | null
  context_coverage: Record<string,boolean>
  narrative_heat: Any[]
  news_that_matters: Any[]
  flow_highlights: Any[]
  protocol_chain_context: {
    protocol_tvl: Any[]
    chain_tvl: Any[]
  }
  data_coverage: DataCoverage
}

const CHECKED = [
  'intel_current_regime',
  'market_macro_snapshots',
  'market_ranking_snapshots',
  'narrative_category_snapshots',
  'watchlist asset mini-packs',
  'narrative_state',
  'intel_curated_news',
  'large_transfer_events',
  'protocol_tvl_snapshots',
  'chain_tvl_snapshots',
]

function upper(value: unknown): string {
  return String(value || '').toUpperCase().replace(/^\$/, '').trim()
}

function uniq(values: unknown[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const s = upper(value)
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

async function rows(name: string, failed: Set<string>, run: () => Any): Promise<Any[]> {
  try {
    const res = await run()
    if (res?.error || !Array.isArray(res?.data)) throw new Error('source_read_failed')
    return res.data
  } catch {
    failed.add(name)
    return []
  }
}

async function maybeRpc(db: DB, name: string, failed: Set<string>): Promise<Any | null> {
  try {
    if (typeof db.rpc !== 'function') throw new Error('source_read_failed')
    const res = await db.rpc(name)
    if (res?.error || !res || (res.data != null && typeof res.data !== 'object')) throw new Error('source_read_failed')
    return Array.isArray(res?.data) ? (res.data[0] || null) : (res?.data || null)
  } catch {
    failed.add(name)
    return null
  }
}

function coverageFor(parts: Record<string, boolean>, assetPacks: AssetMiniPack[], failed: Set<string>): DataCoverage {
  const used = Object.entries(parts).filter(([, present]) => present).map(([key]) => key)
  if (assetPacks.length) used.push('watchlist asset mini-packs')
  const optional: string[] = []
  if (!parts.market_macro_snapshots && !failed.has('market_macro_snapshots')) optional.push('No cached market macro snapshot was available for the brief.')
  if (!parts.market_ranking_snapshots && !failed.has('market_ranking_snapshots')) optional.push('No cached market ranking rotation was available for the brief.')
  if (!parts.narrative_category_snapshots && !failed.has('narrative_category_snapshots')) optional.push('No cached narrative category rotation was available for the brief.')
  if (!assetPacks.length && !failed.has('watchlist asset mini-packs')) optional.push('No watchlist or portfolio asset mini-packs were available.')
  if (!parts.large_transfer_events && !failed.has('large_transfer_events')) optional.push('No scoped large-transfer highlights were available at poll cadence.')
  if (!parts.protocol_tvl_snapshots && !failed.has('protocol_tvl_snapshots')) optional.push('No cached protocol TVL highlights were available.')
  if (!parts.chain_tvl_snapshots && !failed.has('chain_tvl_snapshots')) optional.push('No cached chain TVL highlights were available.')
  if (!parts.intel_curated_news && !failed.has('intel_curated_news')) optional.push('No unexpired, dated news from the past 48 hours was available for this brief.')
  const material = !parts.intel_current_regime && !parts.market_macro_snapshots
    ? [failed.has('intel_current_regime') || failed.has('market_macro_snapshots') ? 'Market regime or macro context could not be read for the daily brief.' : 'No cached market regime or macro context was available for the daily brief.']
    : []
  return {
    used_sources: uniq(used),
    checked_sources: CHECKED,
    unavailable_sources: [...failed].sort(),
    material_gaps: material,
    optional_gaps: optional,
    confidence_impact: material.length || failed.size ? 'high' : optional.length ? 'low' : 'none',
    should_show_warning: material.length > 0 || failed.size > 0,
  }
}

export async function assembleBriefEvidencePack(db: DB, options: BriefEvidencePackOptions): Promise<BriefEvidencePack> {
  if (!options.orgId || !options.userId) throw new Error('Brief evidence requires an organization and user')
  const now = options.now ?? new Date()
  const failed = new Set<string>()
  // These public cached reads do not depend on private portfolio selection.
  // Each catches its own failure, including when the private read later fails.
  const shared = Promise.all([
    maybeRpc(db, 'intel_current_regime', failed),
    rows('market_macro_snapshots', failed, () => db.from('market_macro_available').select('*').order('as_of', { ascending: false }).limit(2)),
    rows('market_ranking_snapshots', failed, () => db.from('market_rankings_available').select('*').order('as_of', { ascending: false }).limit(12)),
    rows('narrative_category_snapshots', failed, () => db.from('narrative_category_snapshots').select('*').order('as_of', { ascending: false }).limit(10)),
    rows('narrative_state', failed, () => db.from('narrative_state').select('*').order('global_priority_score', { ascending: false }).limit(10)),
    rows('intel_curated_news', failed, () => readBriefNews(db,now,8).then(data=>({data}))),
    rows('protocol_tvl_snapshots', failed, () => db.from('protocol_tvl_snapshots').select('protocol_slug, protocol_name, chain, tvl_usd, ts, provider, fetched_at, stale_after, confidence').order('ts', { ascending: false }).limit(8)),
    rows('chain_tvl_snapshots', failed, () => db.from('chain_tvl_snapshots').select('chain, tvl_usd, ts, provider, fetched_at, stale_after, confidence').order('ts', { ascending: false }).limit(8)),
  ])
  const personal = await loadPrivateBriefContext(db, options.orgId, options.userId, options.portfolioId)
  const holdings = options.holdings ?? personal.holdings
  const watchlistSymbols = uniq(options.watchlistSymbols?.length ? options.watchlistSymbols : personal.watchlistSymbols)
  const holdingSymbols = uniq((holdings || []).map((h: { symbol?: string }) => h?.symbol))
  const subjects = [
    ...(options.watchlistSymbols?.length ? watchlistSymbols.map(symbol => ({ symbol })) : personal.watchlistAssets.map(briefSubject).filter(Boolean)),
    ...holdings.map(briefSubject).filter(Boolean),
  ]
  const assetSubjects = [...new Map(subjects.map(subject => [subject.canonicalKey || `symbol:${subject.symbol}`, subject])).values()].slice(0, Math.min(20, Math.max(1, options.maxAssets ?? 8)))

  const [
    regime,
    macroRaw,
    rankingsRaw,
    categoriesRaw,
    narratives,
    news,
    protocolTvl,
    chainTvl,
  ] = await shared
  const flow = personal.flowHighlights
  const allowCmcAi=options.forAi?await loadCmcAiAllowed(db):false
  const macro = options.forAi ? prepareAiContext(macroRaw,allowCmcAi) : macroRaw
  const rankings = options.forAi ? prepareAiContext(rankingsRaw,allowCmcAi) : rankingsRaw
  const categories = options.forAi ? prepareAiContext(categoriesRaw,allowCmcAi) : categoriesRaw

  const assetPacks: AssetMiniPack[] = []
  // At most three cache-only assemblies at once; retain subject ordering.
  for (let offset=0;offset<assetSubjects.length;offset+=3) {
    const batch = await Promise.allSettled(assetSubjects.slice(offset,offset+3).map(subject => assembleAssetMiniPack(db, subject, { now, staleMinutes: 60, maxPromptChars: 3200, allowLiveEnrichment: false })))
    for (const result of batch) if (result.status === 'fulfilled') {
      const mini = result.value
      if (!options.forAi || allowCmcAi || !containsCmcOrigin(mini)) assetPacks.push(mini)
    } else failed.add('watchlist asset mini-packs')
  }

  const presence = {
    intel_current_regime: !!regime,
    market_macro_snapshots: macro.length > 0,
    market_ranking_snapshots: rankings.length > 0,
    narrative_category_snapshots: categories.length > 0,
    narrative_state: narratives.length > 0,
    intel_curated_news: news.length > 0,
    large_transfer_events: flow.length > 0,
    protocol_tvl_snapshots: protocolTvl.length > 0,
    chain_tvl_snapshots: chainTvl.length > 0,
  }
  const packWithoutHash = {
    assembled_at: now.toISOString(),
    org_scope: { org_id: options.orgId, user_id: options.userId, watchlist_count: watchlistSymbols.length, holding_count: holdingSymbols.length },
    market_regime: regime,
    macro_rotation: { macro, rankings, categories },
    watchlist_assets: assetPacks,
    portfolio_holdings: holdings,
    portfolio_scope: personal.portfolio,
    context_coverage: personal.coverage,
    narrative_heat: narratives,
    news_that_matters: news,
    flow_highlights: flow,
    protocol_chain_context: { protocol_tvl: protocolTvl, chain_tvl: chainTvl },
    data_coverage: coverageFor(presence, assetPacks, failed),
  }
  return {
    // Wall-clock assembly metadata must not invalidate otherwise identical evidence.
    content_hash: h32(JSON.stringify({ ...packWithoutHash, assembled_at: undefined, watchlist_assets:assetPacks.map(({cached: _cached, ...pack}) => pack) })),
    ...packWithoutHash,
  }
}
