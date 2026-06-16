import { h32 } from '../core-intel/hashing.ts'
import { assembleAssetMiniPack, type AssetMiniPack } from './asset-mini-pack.ts'
import type { DataCoverage } from './asset-evidence-pack.ts'

// deno-lint-ignore no-explicit-any
type DB = any
// deno-lint-ignore no-explicit-any
type Any = any

export interface BriefEvidencePackOptions {
  orgId: string
  watchlistSymbols?: string[]
  holdings?: Array<{ symbol?: string | null; value?: number | null; dayPnl?: number | null; dayPnlPct?: number | null }>
  maxAssets?: number
  now?: Date
}

export interface BriefEvidencePack {
  content_hash: string
  assembled_at: string
  org_scope: { org_id: string; watchlist_count: number; holding_count: number }
  market_regime: Any | null
  macro_rotation: {
    macro: Any[]
    rankings: Any[]
    categories: Any[]
  }
  watchlist_assets: AssetMiniPack[]
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

async function rows(run: () => Any): Promise<Any[]> {
  try {
    const res = await run()
    if (res?.error) return []
    return Array.isArray(res?.data) ? res.data : []
  } catch {
    return []
  }
}

async function maybeRpc(db: DB, name: string): Promise<Any | null> {
  try {
    if (typeof db.rpc !== 'function') return null
    const res = await db.rpc(name)
    if (res?.error) return null
    return Array.isArray(res?.data) ? (res.data[0] || null) : (res?.data || null)
  } catch {
    return null
  }
}

async function orgWatchlistSymbols(db: DB, orgId: string): Promise<string[]> {
  const direct = await rows(() => db.from('watchlist_items').select('symbol, normalized_symbol, entity:entities(display_symbol)').eq('org_id', orgId).limit(100))
  return uniq(direct.map((row) => row.normalized_symbol || row.symbol || row.entity?.display_symbol))
}

async function orgHoldings(db: DB, orgId: string): Promise<BriefEvidencePackOptions['holdings']> {
  return await rows(() => db.from('investor_portfolio_holdings')
    .select('normalized_symbol, asset_symbol, current_value, day_pnl, day_pnl_pct')
    .eq('org_id', orgId)
    .limit(100))
    .then((items) => items.map((h) => ({
      symbol: h.normalized_symbol || h.asset_symbol,
      value: h.current_value,
      dayPnl: h.day_pnl,
      dayPnlPct: h.day_pnl_pct,
    })))
}

function coverageFor(parts: Record<string, boolean>, assetPacks: AssetMiniPack[]): DataCoverage {
  const used = Object.entries(parts).filter(([, present]) => present).map(([key]) => key)
  if (assetPacks.length) used.push('watchlist asset mini-packs')
  const optional: string[] = []
  if (!parts.market_macro_snapshots) optional.push('No cached market macro snapshot was available for the brief.')
  if (!parts.market_ranking_snapshots) optional.push('No cached market ranking rotation was available for the brief.')
  if (!parts.narrative_category_snapshots) optional.push('No cached narrative category rotation was available for the brief.')
  if (!assetPacks.length) optional.push('No watchlist or portfolio asset mini-packs were available.')
  if (!parts.large_transfer_events) optional.push('No scoped large-transfer highlights were available at poll cadence.')
  if (!parts.protocol_tvl_snapshots) optional.push('No cached protocol TVL highlights were available.')
  if (!parts.chain_tvl_snapshots) optional.push('No cached chain TVL highlights were available.')
  const material = !parts.intel_current_regime && !parts.market_macro_snapshots
    ? ['No cached market regime or macro context was available for the daily brief.']
    : []
  return {
    used_sources: uniq(used),
    checked_sources: CHECKED,
    unavailable_sources: [],
    material_gaps: material,
    optional_gaps: optional,
    confidence_impact: material.length ? 'high' : optional.length ? 'low' : 'none',
    should_show_warning: material.length > 0,
  }
}

export async function assembleBriefEvidencePack(db: DB, options: BriefEvidencePackOptions): Promise<BriefEvidencePack> {
  const now = options.now ?? new Date()
  const holdings = options.holdings ?? await orgHoldings(db, options.orgId)
  const watchlistSymbols = uniq(options.watchlistSymbols?.length ? options.watchlistSymbols : await orgWatchlistSymbols(db, options.orgId))
  const holdingSymbols = uniq((holdings || []).map((h) => h?.symbol))
  const assetSymbols = uniq([...watchlistSymbols, ...holdingSymbols]).slice(0, Math.max(1, options.maxAssets ?? 8))

  const [
    regime,
    macro,
    rankings,
    categories,
    narratives,
    news,
    flow,
    protocolTvl,
    chainTvl,
  ] = await Promise.all([
    maybeRpc(db, 'intel_current_regime'),
    rows(() => db.from('market_macro_snapshots').select('*').order('as_of', { ascending: false }).limit(2)),
    rows(() => db.from('market_ranking_snapshots').select('*').order('as_of', { ascending: false }).limit(12)),
    rows(() => db.from('narrative_category_snapshots').select('*').order('as_of', { ascending: false }).limit(10)),
    rows(() => db.from('narrative_state').select('*').order('global_priority_score', { ascending: false }).limit(10)),
    rows(() => db.from('intel_curated_news').select('*').eq('should_surface', true).order('final_score', { ascending: false }).limit(8)),
    rows(() => db.from('large_transfer_events').select('chain, canonical_asset_key, symbol, amount, usd_value, threshold_usd, direction, label, provider, observed_at, fetched_at').eq('org_id', options.orgId).order('observed_at', { ascending: false }).limit(8)),
    rows(() => db.from('protocol_tvl_snapshots').select('protocol_slug, protocol_name, chain, tvl_usd, ts, provider, fetched_at, stale_after, confidence').order('ts', { ascending: false }).limit(8)),
    rows(() => db.from('chain_tvl_snapshots').select('chain, tvl_usd, ts, provider, fetched_at, stale_after, confidence').order('ts', { ascending: false }).limit(8)),
  ])

  const assetPacks: AssetMiniPack[] = []
  for (const symbol of assetSymbols) {
    try {
      assetPacks.push(await assembleAssetMiniPack(db, { symbol }, { now, staleMinutes: 60, maxPromptChars: 3200 }))
    } catch {
      // Mini-pack failures should not block a brief; coverage below records thinness.
    }
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
    org_scope: { org_id: options.orgId, watchlist_count: watchlistSymbols.length, holding_count: holdingSymbols.length },
    market_regime: regime,
    macro_rotation: { macro, rankings, categories },
    watchlist_assets: assetPacks,
    narrative_heat: narratives,
    news_that_matters: news,
    flow_highlights: flow,
    protocol_chain_context: { protocol_tvl: protocolTvl, chain_tvl: chainTvl },
    data_coverage: coverageFor(presence, assetPacks),
  }
  return {
    content_hash: h32(JSON.stringify(packWithoutHash)),
    ...packWithoutHash,
  }
}
