import {
  assembleIntelligenceContext,
  type IntelligenceContextBlock,
  type SurfaceIntelligencePolicy,
} from '../intelligence-core.ts'
import { materialityVerdict } from '../core-intel/materiality.ts'
import { h32 } from '../core-intel/hashing.ts'
import {
  assembleEcosystemNarrativeState,
  assembleCatalystNewsState,
  assembleTokenUnlockState,
  assemblePublicOnchainState,
} from './market-enrichment.ts'

// deno-lint-ignore no-explicit-any
type DB = any
type FreshnessStatus = 'fresh' | 'stale' | 'unknown' | 'missing'
type PackMateriality = 'new' | 'material' | 'minor' | 'none'

export interface AssetEvidenceSubject {
  symbol?: string | null
  canonicalKey?: string | null
  chain?: string | null
  providerId?: string | null
  sourceProvider?: string | null
  tokenAddress?: string | null
  orgId?: string | null
  userId?: string | null
}

export interface AssetEvidencePackResult {
  subject: {
    canonical_key: string
    symbol: string | null
    chain: string | null
    token_address: string | null
    provider_id: string | null
    source_provider: string | null
  }
  pack: Record<string, unknown>
  contentHash: string
  contextPack: {
    surface: string
    scope_key: string
    content_hash: string
    blocks: Array<Record<string, unknown>>
    policy: Record<string, unknown>
    stale_after: string
  }
  dataCoverage: DataCoverage
  providerCoverage: Record<string, unknown>
  sourceProvenance: Record<string, unknown>
  confidence: number
  staleAfter: string
  materiality?: PackMateriality
  persisted?: boolean
  cached?: boolean
}

export interface AssetEvidencePackOptions {
  window?: string
  now?: Date
  force?: boolean
  staleMinutes?: number
  contextLimit?: number
  // Tests can inject deterministic context assembly without touching the live
  // intelligence RPCs.
  assembleContext?: typeof assembleIntelligenceContext
}

export interface DataCoverage {
  used_sources: string[]
  checked_sources: string[]
  unavailable_sources: string[]
  material_gaps: string[]
  optional_gaps: string[]
  confidence_impact: 'none' | 'low' | 'medium' | 'high'
  should_show_warning: boolean
}

export type CriticalEvidenceSlice = 'market' | 'price' | 'liquidity'

const CHECKED_SOURCES = [
  'market_assets',
  'exchange_latest_asset_profiles',
  'exchange_latest_tickers',
  'exchange_latest_market_signals',
  'exchange_latest_market_caps',
  'exchange_latest_cross_market_spreads',
  'exchange_latest_orderbook',
  'dex_pair_snapshots',
  'pool_ohlcv_snapshots',
  'token_metadata_snapshots',
  'token_price_snapshots',
  'asset_transfer_activity',
  'large_transfer_events',
  'protocol_tvl_snapshots',
  'chain_tvl_snapshots',
  'defi_pool_snapshots',
  'token_unlocks',
  'kamino_vault_snapshots',
  'kamino_market_snapshots',
  'market_macro_snapshots',
  'market_ranking_snapshots',
  'narrative_category_snapshots',
  'narrative_taxonomy',
  'narrative_assets',
  'narrative_signals',
  'narrative_state',
  'intel_signal_state',
  'intel_global_news',
  'intel_curated_news',
  'birdeye_token_overview',
  'intel_rollups',
  'intel_event_memory',
  'historical_analog_links',
  'intelligence_entity_timeline',
  'chain_capabilities',
  'platform_intelligence_context',
]

const CHAIN_ALIASES: Record<string, string> = {
  eth: 'ethereum',
  ethereum: 'ethereum',
  mainnet: 'ethereum',
  base: 'base',
  optimism: 'optimism',
  op: 'optimism',
  arbitrum: 'arbitrum',
  arb: 'arbitrum',
  polygon: 'polygon',
  matic: 'polygon',
  bsc: 'bsc',
  binance_smart_chain: 'bsc',
  sol: 'solana',
  solana: 'solana',
  avalanche: 'avalanche',
  avax: 'avalanche',
}

function normalizeSymbol(value: unknown): string | null {
  const s = String(value || '').trim().replace(/^\$/, '').toUpperCase()
  return s || null
}

function normalizeChain(value: unknown): string | null {
  const raw = String(value || '').trim().toLowerCase().replace(/\s+/g, '_')
  return CHAIN_ALIASES[raw] || raw || null
}

function normalizeAddress(value: unknown): string | null {
  const s = String(value || '').trim()
  if (!s) return null
  return s.startsWith('0x') ? s.toLowerCase() : s
}

function canonicalAssetKeys(chain: string | null, tokenAddress: string | null, canonicalKey?: string | null): string[] {
  const keys = new Set<string>()
  if (canonicalKey) keys.add(String(canonicalKey))
  if (chain && tokenAddress) {
    const addr = normalizeAddress(tokenAddress)
    if (addr) {
      keys.add(`${chain}:erc20:${addr}`)
      keys.add(`${chain}:spl:${addr}`)
      keys.add(`${chain}:token:${addr}`)
    }
  }
  return [...keys].filter(Boolean)
}

function platformEntries(platforms: unknown): Array<{ chain: string; address: string }> {
  if (!platforms || typeof platforms !== 'object') return []
  return Object.entries(platforms as Record<string, unknown>)
    .map(([chain, address]) => ({ chain: normalizeChain(chain) || chain, address: normalizeAddress(address) || '' }))
    .filter((entry) => !!entry.chain && !!entry.address)
}

function bestPlatformAddress(platforms: unknown, preferredChain: string | null): { chain: string | null; address: string | null } {
  const entries = platformEntries(platforms)
  if (!entries.length) return { chain: null, address: null }
  const preferred = preferredChain ? entries.find((entry) => entry.chain === preferredChain) : null
  const selected = preferred || entries[0]
  return { chain: selected.chain, address: selected.address }
}

// deno-lint-ignore no-explicit-any
async function maybeSingle(run: () => any): Promise<any | null> {
  try {
    const res = await run()
    if (res?.error) return null
    return res?.data ?? null
  } catch {
    return null
  }
}

// deno-lint-ignore no-explicit-any
async function rows(run: () => any): Promise<any[]> {
  try {
    const res = await run()
    if (res?.error) return []
    return Array.isArray(res?.data) ? res.data : []
  } catch {
    return []
  }
}

function freshnessFor(row: unknown, nowMs: number, fallbackHours = 24): {
  status: FreshnessStatus
  as_of: string | null
  stale_after: string | null
  age_hours: number | null
} {
  if (!row || typeof row !== 'object') return { status: 'missing', as_of: null, stale_after: null, age_hours: null }
  const r = row as Record<string, unknown>
  const asOf = String(r.as_of || r.fetched_at || r.generated_at || r.published_at || r.snapshot_at || r.ts || r.created_at || '')
  const staleAfter = String(r.stale_after || '')
  const asOfMs = asOf ? new Date(asOf).getTime() : NaN
  const staleMs = staleAfter ? new Date(staleAfter).getTime() : NaN
  const ageHours = Number.isFinite(asOfMs) ? Math.max(0, (nowMs - asOfMs) / 3_600_000) : null
  if (Number.isFinite(staleMs)) return { status: staleMs > nowMs ? 'fresh' : 'stale', as_of: asOf || null, stale_after: staleAfter, age_hours: ageHours }
  if (ageHours == null) return { status: 'unknown', as_of: null, stale_after: null, age_hours: null }
  return { status: ageHours <= fallbackHours ? 'fresh' : 'stale', as_of: asOf, stale_after: null, age_hours: ageHours }
}

function newestFreshness(rowsIn: unknown[], nowMs: number, fallbackHours = 24) {
  if (!rowsIn.length) return freshnessFor(null, nowMs, fallbackHours)
  return freshnessFor(rowsIn[0], nowMs, fallbackHours)
}

function compactRow(row: unknown, keep: string[]): Record<string, unknown> | null {
  if (!row || typeof row !== 'object') return null
  const source = row as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of keep) {
    if (source[key] !== undefined && source[key] !== null) out[key] = source[key]
  }
  return Object.keys(out).length ? out : null
}

function compactRows(rowsIn: unknown[], keep: string[], limit = 5): Record<string, unknown>[] {
  return rowsIn.slice(0, limit).map((row) => compactRow(row, keep)).filter(Boolean) as Record<string, unknown>[]
}

function provenanceFor(table: string, rowsIn: unknown[], nowMs: number, providerFallback: string | null = null) {
  const first = rowsIn[0]
  const providers = new Set<string>()
  for (const row of rowsIn) {
    const provider = row && typeof row === 'object' ? (row as Record<string, unknown>).provider : null
    if (provider) providers.add(String(provider))
  }
  if (!providers.size && providerFallback) providers.add(providerFallback)
  const fresh = freshnessFor(first, nowMs)
  return {
    table,
    providers: [...providers],
    rows: rowsIn.length,
    as_of: fresh.as_of,
    stale_after: fresh.stale_after,
    freshness: fresh.status,
  }
}

function withScope<T extends Record<string, unknown>>(row: T, subject: AssetEvidenceSubject): T & Record<string, unknown> {
  return {
    ...row,
    org_id: subject.orgId || null,
    user_id: subject.userId || null,
  }
}

async function latestScopedPack(db: DB, subjectKey: string, subject: AssetEvidenceSubject, window: string): Promise<Record<string, unknown> | null> {
  let q = db.from('intelligence_evidence_packs')
    .select('*')
    .eq('subject_canonical_key', subjectKey)
    .eq('window', window)
  q = subject.orgId ? q.eq('org_id', subject.orgId) : q.is('org_id', null)
  q = subject.userId ? q.eq('user_id', subject.userId) : q.is('user_id', null)
  return await maybeSingle(() => q.order('built_at', { ascending: false }).limit(1).maybeSingle())
}

async function latestScopedContextPack(db: DB, scopeKey: string, subject: AssetEvidenceSubject): Promise<Record<string, unknown> | null> {
  let q = db.from('ai_context_packs')
    .select('*')
    .eq('surface', 'investor_intel')
    .eq('scope_key', scopeKey)
  q = subject.orgId ? q.eq('org_id', subject.orgId) : q.is('org_id', null)
  q = subject.userId ? q.eq('user_id', subject.userId) : q.is('user_id', null)
  return await maybeSingle(() => q.order('assembled_at', { ascending: false }).limit(1).maybeSingle())
}

function blockForStorage(block: IntelligenceContextBlock): Record<string, unknown> {
  return {
    memory_class: block.memory_class,
    visibility: block.visibility,
    title: block.title,
    summary: block.summary,
    freshness_class: block.freshness_class,
    confidence: block.confidence,
    rank_score: block.rank_score,
    entity_refs: block.entity_refs,
    narrative_refs: block.narrative_refs,
    source_refs: block.source_refs,
    created_at: block.created_at,
    retrieval_reason: block.retrieval_reason,
  }
}

function policyForStorage(policy: SurfaceIntelligencePolicy | Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!policy || typeof policy !== 'object') return {}
  return {
    surface_key: (policy as SurfaceIntelligencePolicy).surface_key,
    derived_over_raw: (policy as SurfaceIntelligencePolicy).derived_over_raw,
    restricted_license_policy: (policy as SurfaceIntelligencePolicy).restricted_license_policy,
    allow_global_public: (policy as SurfaceIntelligencePolicy).allow_global_public,
    allow_global_derived: (policy as SurfaceIntelligencePolicy).allow_global_derived,
    allow_scoped_private: (policy as SurfaceIntelligencePolicy).allow_scoped_private,
  }
}

function textArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v || '').trim()).filter(Boolean) : []
}

function intersectsAny(values: unknown, refs: string[]): boolean {
  const lower = new Set(refs.map((r) => r.toLowerCase()))
  return textArray(values).some((value) => lower.has(value.toLowerCase()))
}

function uniqRows(rowsIn: unknown[], key: string): Record<string, unknown>[] {
  const seen = new Set<string>()
  const out: Record<string, unknown>[] = []
  for (const row of rowsIn) {
    if (!row || typeof row !== 'object') continue
    const rec = row as Record<string, unknown>
    const id = String(rec[key] || h32(JSON.stringify(rec)))
    if (seen.has(id)) continue
    seen.add(id)
    out.push(rec)
  }
  return out
}

async function assembleHistoricalContext(
  db: DB,
  resolved: Awaited<ReturnType<typeof resolveAsset>>,
  assetKeys: string[],
  nowMs: number,
) {
  const sym = resolved.symbol
  const chain = resolved.chain
  const refs = [...new Set([
    resolved.canonicalKey,
    sym,
    sym ? `asset:${sym}` : null,
    chain,
    ...assetKeys,
  ].map((v) => String(v || '').trim()).filter(Boolean))].slice(0, 10)

  const rollupsNested = await Promise.all(refs.map((ref) => rows(() => db.from('intel_rollups')
    .select('*')
    .eq('subject_id', ref)
    .order('period_start', { ascending: false })
    .limit(6))))
  const rollups = uniqRows(rollupsNested.flat(), 'id')

  const eventRows = await rows(() => db.from('intel_event_memory')
    .select('*')
    .order('occurred_at', { ascending: false })
    .limit(80))
  const events = eventRows.filter((row) =>
    intersectsAny((row as Record<string, unknown>).assets, refs)
    || intersectsAny((row as Record<string, unknown>).chains, refs)
    || intersectsAny((row as Record<string, unknown>).narratives, refs)
  )

  const analogNested = await Promise.all([
    ...refs.map((ref) => rows(() => db.from('historical_analog_links')
      .select('*')
      .eq('current_subject_ref', ref)
      .order('observed_at', { ascending: false })
      .limit(4))),
    rows(() => db.from('historical_analog_links')
      .select('*')
      .eq('analog_kind', 'market_regime_similarity')
      .order('observed_at', { ascending: false })
      .limit(3)),
  ])
  const analogs = uniqRows(analogNested.flat(), 'id')

  const timelineNested = await Promise.all(refs.map((ref) => rows(() => db.from('intelligence_entity_timeline')
    .select('*')
    .eq('entity_ref', ref)
    .order('occurred_at', { ascending: false })
    .limit(4))))
  const timeline = uniqRows(timelineNested.flat(), 'id')

  const used = {
    intel_rollups: rollups.length > 0,
    intel_event_memory: events.length > 0,
    historical_analog_links: analogs.length > 0,
    intelligence_entity_timeline: timeline.length > 0,
  }
  const thin = !Object.values(used).some(Boolean)
  return {
    status: thin ? 'thin' : 'available',
    coverage_note: thin
      ? `No rolled-up historical memory matched ${sym || resolved.canonicalKey}; use current cached context only.`
      : null,
    trend_windows: compactRows(rollups, [
      'subject_type',
      'subject_id',
      'subject_label',
      'period_kind',
      'period_start',
      'period_end',
      'source_count',
      'source_diversity',
      'first_seen_at',
      'last_seen_at',
      'important_events',
      'computed_at',
    ], 8),
    material_events: compactRows(events, [
      'event_type',
      'title',
      'summary',
      'occurred_at',
      'importance_score',
      'importance_source',
      'assets',
      'chains',
      'narratives',
      'evidence_refs',
    ], 6),
    analogs: compactRows(analogs, [
      'current_subject_type',
      'current_subject_ref',
      'analog_subject_type',
      'analog_subject_ref',
      'analog_kind',
      'similarity_score',
      'basis',
      'evidence_refs',
      'observed_at',
    ], 6),
    entity_timeline: compactRows(timeline, [
      'entity_type',
      'entity_ref',
      'event_type',
      'title',
      'summary',
      'impact_score',
      'confidence',
      'narrative_refs',
      'source_refs',
      'occurred_at',
    ], 6),
    provenance: {
      intel_rollups: provenanceFor('intel_rollups', rollups, nowMs, null),
      intel_event_memory: provenanceFor('intel_event_memory', events, nowMs, null),
      historical_analog_links: provenanceFor('historical_analog_links', analogs, nowMs, null),
      intelligence_entity_timeline: provenanceFor('intelligence_entity_timeline', timeline, nowMs, null),
    },
    used_sources: Object.entries(used).filter(([, ok]) => ok).map(([name]) => name),
  }
}

async function resolveAsset(db: DB, subject: AssetEvidenceSubject) {
  const symbol = normalizeSymbol(subject.symbol)
  const providerId = String(subject.providerId || '').trim() || null
  const sourceProvider = String(subject.sourceProvider || '').trim() || null
  let marketAsset = null
  if (providerId && sourceProvider) {
    marketAsset = await maybeSingle(() => db.from('market_assets')
      .select('*')
      .eq('source_provider', sourceProvider)
      .eq('provider_id', providerId)
      .maybeSingle())
  }
  // Symbol-only fallback is for assets WITHOUT an explicit provider id (e.g. a
  // CEX-only ticker). When a providerId was supplied we never fall back to symbol:
  // normalized_symbol is not unique, so a market-cap-ordered pick could resolve a
  // DIFFERENT token that happens to share the symbol (the ZEC-on-ETH class of bug).
  // For the symbol path, prefer the CoinGecko row deterministically before any
  // other provider, then market cap as a tiebreak.
  if (!marketAsset && symbol && !providerId) {
    marketAsset = await maybeSingle(() => db.from('market_assets')
        .select('*')
        .eq('normalized_symbol', symbol)
        .eq('source_provider', 'coingecko')
        .order('market_cap', { ascending: false })
        .limit(1)
        .maybeSingle())
      || await maybeSingle(() => db.from('market_assets')
        .select('*')
        .eq('normalized_symbol', symbol)
        .order('market_cap', { ascending: false })
        .limit(1)
        .maybeSingle())
  }

  const cexProfile = symbol
    ? await maybeSingle(() => db.from('exchange_latest_asset_profiles').select('*').eq('normalized_symbol', symbol).maybeSingle())
    : null
  const preferredChain = normalizeChain(subject.chain) || normalizeChain(marketAsset?.primary_chain) || normalizeChain(cexProfile?.chain)
  const platform = bestPlatformAddress(marketAsset?.platforms, preferredChain)
  const tokenAddress = normalizeAddress(subject.tokenAddress) || platform.address
  const chain = normalizeChain(subject.chain) || platform.chain || normalizeChain(marketAsset?.primary_chain) || normalizeChain(cexProfile?.chain)
  const canonicalKey = String(subject.canonicalKey || '').trim()
    || (marketAsset?.source_provider && marketAsset?.provider_id ? `market:${marketAsset.source_provider}:${marketAsset.provider_id}` : '')
    || (chain && tokenAddress ? `${chain}:token:${tokenAddress}` : '')
    || (symbol ? `symbol:${symbol}` : 'asset:unknown')

  return {
    symbol,
    chain,
    tokenAddress,
    canonicalKey,
    providerId: providerId || marketAsset?.provider_id || null,
    sourceProvider: sourceProvider || marketAsset?.source_provider || null,
    marketAsset,
    cexProfile,
  }
}

export async function assembleAssetEvidencePack(
  db: DB,
  subject: AssetEvidenceSubject,
  options: AssetEvidencePackOptions = {},
): Promise<AssetEvidencePackResult> {
  const now = options.now ?? new Date()
  const nowMs = now.getTime()
  const staleAfter = new Date(nowMs + Math.max(5, options.staleMinutes ?? 30) * 60_000).toISOString()
  const resolved = await resolveAsset(db, subject)
  const sym = resolved.symbol
  const chain = resolved.chain
  const tokenAddress = resolved.tokenAddress
  const assetKeys = canonicalAssetKeys(chain, tokenAddress, resolved.canonicalKey)

  const [
    tickerRows,
    signal,
    cap,
    spread,
    orderbooks,
    dexRows,
    ohlcvRows,
    metadataRows,
    priceRows,
    chainTvlRows,
    protocolRows,
    defiPools,
    kaminoVaults,
    kaminoMarkets,
    macroRows,
    rankingRows,
    categoryRows,
    signalState,
    newsRows,
    coverageRows,
  ] = await Promise.all([
    sym ? rows(() => db.from('exchange_latest_tickers').select('*').eq('normalized_symbol', sym).order('volume_quote_24h', { ascending: false }).limit(8)) : Promise.resolve([]),
    sym ? maybeSingle(() => db.from('exchange_latest_market_signals').select('*').eq('normalized_symbol', sym).maybeSingle()) : Promise.resolve(null),
    sym ? maybeSingle(() => db.from('exchange_latest_market_caps').select('*').eq('normalized_symbol', sym).maybeSingle()) : Promise.resolve(null),
    sym ? maybeSingle(() => db.from('exchange_latest_cross_market_spreads').select('*').eq('normalized_symbol', sym).maybeSingle()) : Promise.resolve(null),
    sym ? rows(() => db.from('exchange_latest_orderbook').select('*').eq('normalized_symbol', sym).order('as_of', { ascending: false }).limit(8)) : Promise.resolve([]),
    chain && tokenAddress ? rows(() => db.from('dex_pair_snapshots').select('*').eq('chain', chain).eq('token_address', tokenAddress).order('fetched_at', { ascending: false }).limit(5)) : Promise.resolve([]),
    chain && tokenAddress ? rows(() => db.from('pool_ohlcv_snapshots').select('*').eq('chain', chain).eq('token_address', tokenAddress).order('fetched_at', { ascending: false }).limit(3)) : Promise.resolve([]),
    assetKeys.length ? rows(() => db.from('token_metadata_snapshots').select('*').in('canonical_asset_key', assetKeys).order('fetched_at', { ascending: false }).limit(3)) : Promise.resolve([]),
    assetKeys.length ? rows(() => db.from('token_price_snapshots').select('*').in('canonical_asset_key', assetKeys).order('ts', { ascending: false }).limit(3)) : Promise.resolve([]),
    chain ? rows(() => db.from('chain_tvl_snapshots').select('*').eq('chain', chain).order('ts', { ascending: false }).limit(3)) : Promise.resolve([]),
    chain ? rows(() => db.from('protocol_tvl_snapshots').select('*').eq('chain', chain).order('ts', { ascending: false }).limit(5)) : Promise.resolve([]),
    chain ? rows(() => db.from('defi_pool_snapshots').select('*').eq('chain', chain).order('snapshot_at', { ascending: false }).limit(5)) : Promise.resolve([]),
    chain === 'solana' ? rows(() => db.from('kamino_vault_snapshots').select('*').is('org_id', null).order('snapshot_at', { ascending: false }).limit(5)) : Promise.resolve([]),
    chain === 'solana' ? rows(() => db.from('kamino_market_snapshots').select('*').is('org_id', null).order('snapshot_at', { ascending: false }).limit(5)) : Promise.resolve([]),
    rows(() => db.from('market_macro_snapshots').select('*').order('as_of', { ascending: false }).limit(2)),
    sym ? rows(() => db.from('market_ranking_snapshots').select('*').eq('normalized_symbol', sym).order('as_of', { ascending: false }).limit(3)) : Promise.resolve([]),
    rows(() => db.from('narrative_category_snapshots').select('*').order('as_of', { ascending: false }).limit(8)),
    sym ? maybeSingle(() => db.from('intel_signal_state').select('*').eq('subject_type', 'asset').eq('display_symbol', sym).order('generated_at', { ascending: false }).limit(1).maybeSingle()) : Promise.resolve(null),
    sym ? rows(() => db.from('intel_global_news').select('title, url, summary, source_name, sentiment, relevance, published_at, created_at, tags, chains, entity_symbol').eq('entity_symbol', sym).order('published_at', { ascending: false }).limit(6)) : Promise.resolve([]),
    chain ? rows(() => db.from('chain_capabilities').select('*').eq('chain', chain).limit(40)) : Promise.resolve([]),
  ])

  let transferRows: unknown[] = []
  let largeTransferRows: unknown[] = []
  if (subject.orgId && subject.userId) {
    if (assetKeys.length) {
      transferRows = await rows(() => db.from('asset_transfer_activity')
        .select('chain, canonical_asset_key, symbol, amount, usd_value, direction, label, provider, block_time, fetched_at, stale_after')
        .eq('org_id', subject.orgId)
        .eq('user_id', subject.userId)
        .in('canonical_asset_key', assetKeys)
        .order('block_time', { ascending: false })
        .limit(8))
      largeTransferRows = await rows(() => db.from('large_transfer_events')
        .select('chain, canonical_asset_key, symbol, amount, usd_value, threshold_usd, direction, label, provider, observed_at, fetched_at')
        .eq('org_id', subject.orgId)
        .eq('user_id', subject.userId)
        .in('canonical_asset_key', assetKeys)
        .order('observed_at', { ascending: false })
        .limit(8))
    }
    if (!transferRows.length && sym) {
      transferRows = await rows(() => db.from('asset_transfer_activity')
        .select('chain, canonical_asset_key, symbol, amount, usd_value, direction, label, provider, block_time, fetched_at, stale_after')
        .eq('org_id', subject.orgId)
        .eq('user_id', subject.userId)
        .eq('symbol', sym)
        .order('block_time', { ascending: false })
        .limit(8))
    }
    if (!largeTransferRows.length && sym) {
      largeTransferRows = await rows(() => db.from('large_transfer_events')
        .select('chain, canonical_asset_key, symbol, amount, usd_value, threshold_usd, direction, label, provider, observed_at, fetched_at')
        .eq('org_id', subject.orgId)
        .eq('user_id', subject.userId)
        .eq('symbol', sym)
        .order('observed_at', { ascending: false })
        .limit(8))
    }
  }

  // Enrichment layers (chain-aware narratives, curated news + historic catalysts,
  // public on-chain). Each degrades to a 'missing' status rather than throwing.
  // On-chain uses the central Birdeye client (cache-first, budget/kill-switch
  // enforced); live calls are allowed per product decision but bounded by the
  // 'request' budget and the pack's own 30-min reuse cache.
  const [historicalContext, ecosystemNarrativeState, catalystState, onchainState, unlockState] = await Promise.all([
    assembleHistoricalContext(db, resolved, assetKeys, nowMs),
    assembleEcosystemNarrativeState(db, { chain, symbol: sym }),
    assembleCatalystNewsState(db, { symbol: sym, chain }),
    assemblePublicOnchainState({
      chain,
      tokenAddress,
      allowLive: true,
      nowIso: now.toISOString(),
      birdeyeCtx: { supabase: db, jobName: 'asset-evidence-pack', caller: 'market-enrichment', kind: 'request', orgId: subject.orgId || null, userId: subject.userId || null },
    }),
    assembleTokenUnlockState(db, { symbol: sym, nowMs }),
  ])
  const cexFreshness = newestFreshness([resolved.cexProfile, ...tickerRows, signal, cap, spread, ...orderbooks].filter(Boolean), nowMs, 3)
  const dexFreshness = newestFreshness(dexRows, nowMs, 3)
  const flowFreshness = newestFreshness([...largeTransferRows, ...transferRows], nowMs, 3)
  const protocolFreshness = newestFreshness([...protocolRows, ...defiPools, ...kaminoVaults, ...kaminoMarkets], nowMs, 12)
  const chainFreshness = newestFreshness([...chainTvlRows, ...macroRows], nowMs, 12)
  const newsFreshness = newestFreshness(newsRows, nowMs, 36)

  const bestTicker = tickerRows[0] || null
  const bestDex = dexRows[0] || null
  const bestOrderbook = orderbooks[0] || null
  const orderbookBidDepth = orderbooks.reduce((sum, row) => sum + (Number((row as Record<string, unknown>).bid_depth_usd) || 0), 0)
  const orderbookAskDepth = orderbooks.reduce((sum, row) => sum + (Number((row as Record<string, unknown>).ask_depth_usd) || 0), 0)

  const providerCoverage: Record<string, unknown> = {
    chain,
    capabilities: Object.fromEntries(coverageRows.map((row) => [String(row.capability || ''), {
      status: row.status,
      note_key: row.note_key || null,
      verified_at: row.verified_at || null,
    }]).filter(([key]) => key)),
    cex_providers: [...new Set(tickerRows.map((row) => String(row.provider || '')).filter(Boolean))],
    dex_providers: [...new Set(dexRows.map((row) => String(row.provider || '')).filter(Boolean))],
    defi_providers: [...new Set([...protocolRows, ...defiPools, ...kaminoVaults, ...kaminoMarkets].map((row) => String(row.provider || '')).filter(Boolean))],
    news_providers: [...new Set(newsRows.map((row) => String(row.source_name || '')).filter(Boolean))].slice(0, 8),
  }

  const usedSources = new Set<string>()
  const unavailableSources = new Set<string>()
  const mark = (source: string, hasData: boolean) => hasData ? usedSources.add(source) : unavailableSources.add(source)
  mark('market_assets', !!resolved.marketAsset)
  mark('exchange_latest_asset_profiles', !!resolved.cexProfile)
  mark('exchange_latest_tickers', tickerRows.length > 0)
  mark('exchange_latest_market_signals', !!signal)
  mark('exchange_latest_market_caps', !!cap)
  mark('exchange_latest_cross_market_spreads', !!spread)
  mark('exchange_latest_orderbook', orderbooks.length > 0)
  mark('dex_pair_snapshots', dexRows.length > 0)
  mark('pool_ohlcv_snapshots', ohlcvRows.length > 0)
  mark('token_metadata_snapshots', metadataRows.length > 0)
  mark('token_price_snapshots', priceRows.length > 0)
  mark('asset_transfer_activity', transferRows.length > 0)
  mark('large_transfer_events', largeTransferRows.length > 0)
  mark('protocol_tvl_snapshots', protocolRows.length > 0)
  mark('chain_tvl_snapshots', chainTvlRows.length > 0)
  mark('defi_pool_snapshots', defiPools.length > 0)
  mark('kamino_vault_snapshots', kaminoVaults.length > 0)
  mark('kamino_market_snapshots', kaminoMarkets.length > 0)
  mark('token_unlocks', unlockState.status === 'available')
  mark('market_macro_snapshots', macroRows.length > 0)
  mark('market_ranking_snapshots', rankingRows.length > 0)
  mark('narrative_category_snapshots', categoryRows.length > 0)
  mark('intel_signal_state', !!signalState)
  mark('intel_global_news', newsRows.length > 0)
  mark('narrative_taxonomy', ecosystemNarrativeState.ecosystem_narratives.length > 0)
  mark('narrative_assets', ecosystemNarrativeState.asset_narratives.length > 0)
  mark('narrative_signals', ecosystemNarrativeState.signals.length > 0)
  mark('narrative_state', ecosystemNarrativeState.ecosystem_narratives.some((n) => n.global_priority_score != null) || ecosystemNarrativeState.asset_narratives.some((n) => n.global_priority_score != null))
  mark('intel_curated_news', catalystState.curated_news.length > 0)
  mark('birdeye_token_overview', onchainState.status === 'available')
  mark('intel_rollups', (historicalContext.trend_windows as unknown[]).length > 0)
  mark('intel_event_memory', (historicalContext.material_events as unknown[]).length > 0)
  mark('historical_analog_links', (historicalContext.analogs as unknown[]).length > 0)
  mark('intelligence_entity_timeline', (historicalContext.entity_timeline as unknown[]).length > 0)
  mark('chain_capabilities', coverageRows.length > 0)

  const materialGaps: string[] = []
  const optionalGaps: string[] = []
  const hasAnyMarket = !!resolved.marketAsset || !!resolved.cexProfile || !!bestTicker || !!cap || !!bestDex
  const hasAnyPrice = !!bestTicker?.price || !!bestDex?.price_usd || priceRows.length > 0 || !!resolved.marketAsset?.current_price
  const hasAnyLiquidity = orderbooks.length > 0 || !!spread || !!bestDex?.liquidity_usd || !!resolved.cexProfile?.liquidity_score
  if (!hasAnyMarket) materialGaps.push(`No cached market/profile snapshot matched ${sym || resolved.canonicalKey}.`)
  if (!hasAnyPrice) materialGaps.push(`No cached price snapshot matched ${sym || resolved.canonicalKey}.`)
  if (!hasAnyLiquidity) materialGaps.push(`No cached liquidity/depth snapshot matched ${sym || resolved.canonicalKey}.`)
  if (hasAnyMarket && cexFreshness.status === 'stale' && dexFreshness.status !== 'fresh') {
    materialGaps.push(`Cached market data for ${sym || resolved.canonicalKey} is stale and no fresh DEX fallback was available.`)
  }
  if (!dexRows.length) optionalGaps.push(`No cached DEX pair snapshot matched ${sym || resolved.canonicalKey}; DEX liquidity is absent from this pack.`)
  if (!ohlcvRows.length) optionalGaps.push(`No cached GeckoTerminal OHLCV snapshot matched ${sym || resolved.canonicalKey}.`)
  if (!protocolRows.length && !defiPools.length && !kaminoVaults.length && !kaminoMarkets.length) {
    optionalGaps.push(`No cached protocol/DeFi snapshot matched ${chain || sym || resolved.canonicalKey}.`)
  }
  if (!subject.orgId || !subject.userId) optionalGaps.push('Wallet/whale flow data was not scoped for this explain request.')
  else if (!transferRows.length && !largeTransferRows.length) optionalGaps.push(`No cached wallet or large-transfer flow rows matched ${sym || resolved.canonicalKey}.`)
  else if (flowFreshness.status === 'stale') optionalGaps.push('Cached flow data is stale or partial; webhooks remain dormant and polling cadence may lag.')
  if (!newsRows.length && !catalystState.curated_news.length && !catalystState.catalysts.length) {
    optionalGaps.push(`No curated news or historic catalysts matched ${sym || resolved.canonicalKey}.`)
  }
  if (chain && ecosystemNarrativeState.status === 'missing') {
    optionalGaps.push(`No active ecosystem narratives matched ${chain}; ecosystem rotation context is absent.`)
  }
  if (onchainState.status === 'missing') {
    optionalGaps.push(`No public on-chain activity snapshot resolved for ${sym || resolved.canonicalKey}.`)
  }
  // Derivatives (funding / open interest / liquidations) are not ingested
  // platform-wide. This is a KNOWN, NON-ESSENTIAL absence — keep it an optional gap
  // so a market read is never dominated by "no derivatives data".
  optionalGaps.push('Derivatives positioning (funding, open interest, liquidations) is not collected platform-wide — treat as an optional limitation, not a material gap.')
  if (historicalContext.status === 'thin' && historicalContext.coverage_note) optionalGaps.push(String(historicalContext.coverage_note))
  if (!bestDex?.socials && !bestDex?.links) optionalGaps.push(`No cached social/link metadata was present for ${sym || resolved.canonicalKey}.`)
  optionalGaps.push('Holder distribution was not materialized in the deployed cache tables; holder_state is derived only from available flow metadata.')

  const dataCoverage: DataCoverage = {
    used_sources: [...usedSources].sort(),
    checked_sources: CHECKED_SOURCES,
    unavailable_sources: [...unavailableSources].sort(),
    material_gaps: [...new Set(materialGaps)],
    optional_gaps: [...new Set(optionalGaps)],
    confidence_impact: materialGaps.length ? 'high' : optionalGaps.length > 6 ? 'medium' : optionalGaps.length ? 'low' : 'none',
    should_show_warning: materialGaps.length > 0,
  }
  const confidence = materialGaps.length ? 0.35 : optionalGaps.length > 6 ? 0.62 : 0.82

  const sourceProvenance = {
    market_assets: provenanceFor('market_assets', resolved.marketAsset ? [resolved.marketAsset] : [], nowMs, resolved.sourceProvider),
    cex: provenanceFor('exchange_latest_*', [resolved.cexProfile, ...tickerRows, signal, cap, spread, ...orderbooks].filter(Boolean), nowMs, null),
    dex: provenanceFor('dex_pair_snapshots', dexRows, nowMs, 'dexscreener'),
    ohlcv: provenanceFor('pool_ohlcv_snapshots', ohlcvRows, nowMs, 'geckoterminal'),
    token_snapshots: provenanceFor('token_*_snapshots', [...metadataRows, ...priceRows], nowMs, 'alchemy'),
    flow: provenanceFor('asset_transfer_activity/large_transfer_events', [...largeTransferRows, ...transferRows], nowMs, 'alchemy'),
    protocol: provenanceFor('protocol/defi/kamino snapshots', [...protocolRows, ...defiPools, ...kaminoVaults, ...kaminoMarkets], nowMs, null),
    chain: provenanceFor('chain_tvl_snapshots/market_macro_snapshots', [...chainTvlRows, ...macroRows], nowMs, null),
    narrative: provenanceFor('intel_signal_state/narrative_category_snapshots', [signalState, ...categoryRows].filter(Boolean), nowMs, null),
    ecosystem_narrative: { source: 'narrative_taxonomy/narrative_state/narrative_signals', freshness: ecosystemNarrativeState.freshness, status: ecosystemNarrativeState.status },
    news: provenanceFor('intel_global_news', newsRows, nowMs, null),
    catalysts: { source: 'intel_curated_news/intel_event_memory', freshness: catalystState.freshness, status: catalystState.status },
    unlocks: { source: 'token_unlocks', freshness: unlockState.freshness, status: unlockState.status },
    onchain: { source: onchainState.source || 'birdeye_token_overview', as_of: onchainState.as_of, status: onchainState.status },
    historical: historicalContext.provenance,
  }

  const assembleContext = options.assembleContext ?? assembleIntelligenceContext
  let contextBlocks: IntelligenceContextBlock[] = []
  let contextPolicy: SurfaceIntelligencePolicy | Record<string, unknown> = {}
  try {
    const ctx = await assembleContext(db, {
      surface: 'investor_intel',
      orgId: subject.orgId || null,
      userId: subject.userId || null,
      query: `${sym || resolved.canonicalKey} market narrative news profile on-chain context`.trim(),
      entityRefs: [resolved.canonicalKey],
      narrativeRefs: [],
      includePrivateKnowledge: false,
      includeSemanticMemory: false,
      limit: Math.max(1, Math.min(options.contextLimit ?? 8, 12)),
    })
    contextBlocks = ctx.blocks || []
    contextPolicy = ctx.policy || {}
    mark('platform_intelligence_context', contextBlocks.length > 0)
  } catch {
    mark('platform_intelligence_context', false)
  }
  dataCoverage.used_sources = [...usedSources].sort()
  dataCoverage.unavailable_sources = [...unavailableSources].sort()

  const contextBlocksForStorage = contextBlocks.map(blockForStorage)
  const contextHash = h32(JSON.stringify(contextBlocksForStorage))
  const contextPack = {
    surface: 'investor_intel',
    scope_key: resolved.canonicalKey,
    content_hash: contextHash,
    blocks: contextBlocksForStorage,
    policy: policyForStorage(contextPolicy),
    stale_after: staleAfter,
  }

  const pack = {
    asset: {
      canonical_key: resolved.canonicalKey,
      symbol: sym,
      name: resolved.marketAsset?.name || resolved.cexProfile?.display_name || null,
      chain,
      token_address: tokenAddress,
      provider_id: resolved.providerId,
      source_provider: resolved.sourceProvider,
      market_cap_rank: resolved.marketAsset?.market_cap_rank ?? null,
      categories: resolved.marketAsset?.categories || [],
    },
    market_summary: {
      current_price: bestTicker?.price ?? bestDex?.price_usd ?? priceRows[0]?.price_usd ?? resolved.marketAsset?.current_price ?? null,
      change_24h_pct: bestTicker?.price_change_pct_24h ?? resolved.marketAsset?.change_24h_pct ?? null,
      change_7d_pct: bestTicker?.price_change_pct_7d ?? resolved.marketAsset?.change_7d_pct ?? null,
      volume_24h: bestTicker?.volume_quote_24h ?? bestDex?.volume_24h ?? resolved.marketAsset?.volume_24h ?? null,
      market_cap: cap?.market_cap ?? bestDex?.market_cap ?? resolved.marketAsset?.market_cap ?? null,
      fdv: cap?.fdv ?? bestDex?.fdv ?? resolved.marketAsset?.fdv ?? null,
      freshness: cexFreshness,
    },
    dex_state: {
      status: dexRows.length ? 'available' : 'missing',
      best_pair: compactRow(bestDex, ['chain', 'token_address', 'pair_address', 'dex_id', 'symbol', 'price_usd', 'liquidity_usd', 'volume_24h', 'market_cap', 'fdv', 'txns_24h', 'price_change', 'socials', 'links', 'source_ref', 'fetched_at', 'stale_after']),
      ohlcv: compactRows(ohlcvRows, ['chain', 'pool_or_token_address', 'timeframe', 'candles', 'source_ref', 'fetched_at', 'stale_after'], 2),
      freshness: dexFreshness,
    },
    cex_state: {
      status: tickerRows.length || resolved.cexProfile ? 'available' : 'missing',
      profile: compactRow(resolved.cexProfile, ['normalized_symbol', 'display_name', 'chain', 'best_global_pair', 'best_global_provider', 'best_us_retail_pair', 'best_us_retail_provider', 'provider_coverage', 'providers', 'liquidity_score', 'retail_relevance_score', 'market_quality_score', 'signal_direction', 'signal_strength', 'signal_confidence', 'latest_price', 'latest_change_24h_pct', 'latest_volume_quote_24h', 'caution_flags', 'as_of']),
      tickers: compactRows(tickerRows, ['provider', 'provider_symbol', 'price', 'price_change_pct_24h', 'price_change_pct_7d', 'volume_quote_24h', 'bid_price', 'ask_price', 'spread_pct', 'as_of'], 6),
      signal: compactRow(signal, ['direction', 'strength', 'confidence', 'signal_type', 'provider_count', 'confirming_providers', 'conflicting_providers', 'title', 'summary', 'why_it_matters', 'factors', 'as_of']),
      market_cap: compactRow(cap, ['market_cap', 'market_cap_source', 'circulating_supply', 'total_supply', 'fdv', 'price_used', 'price_source', 'confidence_score', 'is_estimated', 'as_of']),
      spread: compactRow(spread, ['buy_provider', 'sell_provider', 'gross_spread_pct', 'estimated_net_spread_pct', 'liquidity_score', 'confidence_score', 'caution_flags', 'as_of']),
      orderbook: compactRows(orderbooks, ['provider', 'provider_symbol', 'depth_level', 'bid_price', 'ask_price', 'bid_depth_usd', 'ask_depth_usd', 'imbalance_pct', 'spread_pct', 'mid_price', 'as_of'], 6),
      freshness: cexFreshness,
    },
    liquidity_state: {
      cex_bid_depth_usd: orderbookBidDepth || null,
      cex_ask_depth_usd: orderbookAskDepth || null,
      cex_min_spread_pct: orderbooks.map((row) => Number(row.spread_pct)).filter(Number.isFinite).sort((a, b) => a - b)[0] ?? bestTicker?.spread_pct ?? null,
      dex_liquidity_usd: bestDex?.liquidity_usd ?? null,
      spread_watch: compactRow(spread, ['gross_spread_pct', 'estimated_net_spread_pct', 'caution_flags', 'as_of']),
      freshness: orderbooks.length ? newestFreshness(orderbooks, nowMs, 3) : dexFreshness,
    },
    flow_state: {
      status: subject.orgId && subject.userId ? (transferRows.length || largeTransferRows.length ? 'available' : 'missing') : 'not_scoped',
      transfer_activity: compactRows(transferRows, ['chain', 'canonical_asset_key', 'symbol', 'amount', 'usd_value', 'direction', 'label', 'provider', 'block_time', 'fetched_at', 'stale_after'], 6),
      large_transfers: compactRows(largeTransferRows, ['chain', 'canonical_asset_key', 'symbol', 'amount', 'usd_value', 'threshold_usd', 'direction', 'label', 'provider', 'observed_at', 'fetched_at'], 6),
      poll_cadence_note: 'Flow/whale data is polling-cadence only until provider webhooks are registered.',
      freshness: flowFreshness,
    },
    holder_state: {
      status: 'derived_only',
      note: 'No standalone holder-distribution snapshot table is materialized; use available transfer and metadata rows only.',
      token_metadata: compactRows(metadataRows, ['chain', 'token_address', 'canonical_asset_key', 'symbol', 'name', 'decimals', 'provider', 'fetched_at', 'stale_after', 'confidence'], 2),
    },
    protocol_state: {
      status: protocolRows.length || defiPools.length || kaminoVaults.length || kaminoMarkets.length ? 'available' : 'missing',
      protocol_tvl: compactRows(protocolRows, ['protocol_slug', 'protocol_name', 'chain', 'ts', 'tvl_usd', 'provider', 'source_ref', 'fetched_at', 'stale_after', 'confidence'], 5),
      defi_pools: compactRows(defiPools, ['provider', 'chain', 'pool_id', 'name', 'project', 'symbol', 'tvl_usd', 'apy', 'apy_base', 'apy_reward', 'product_type', 'snapshot_at', 'fetched_at', 'stale_after', 'confidence'], 5),
      kamino_vaults: compactRows(kaminoVaults, ['vault_address', 'name', 'tvl_usd', 'apy', 'apy_base', 'apy_reward', 'token_a_mint', 'token_b_mint', 'snapshot_at', 'fetched_at', 'stale_after', 'confidence'], 5),
      kamino_markets: compactRows(kaminoMarkets, ['market_address', 'reserve_address', 'mint', 'market_name', 'supply_apy', 'borrow_apy', 'total_borrow_usd', 'utilization', 'snapshot_at', 'fetched_at', 'stale_after', 'confidence'], 5),
      freshness: protocolFreshness,
    },
    chain_state: {
      status: chainTvlRows.length || macroRows.length ? 'available' : 'missing',
      chain_tvl: compactRows(chainTvlRows, ['chain', 'ts', 'tvl_usd', 'provider', 'source_ref', 'fetched_at', 'stale_after', 'confidence'], 3),
      macro: compactRows(macroRows, ['provider', 'snapshot_kind', 'total_market_cap_usd', 'total_volume_24h_usd', 'market_cap_change_24h_pct', 'btc_dominance_pct', 'eth_dominance_pct', 'defi_market_cap_usd', 'stablecoin_market_cap_usd', 'as_of', 'fetched_at'], 2),
      rankings: compactRows(rankingRows, ['provider', 'rank_kind', 'rank', 'provider_id', 'symbol', 'name', 'normalized_symbol', 'price_usd', 'market_cap_usd', 'volume_24h_usd', 'change_24h_pct', 'categories', 'as_of'], 3),
      freshness: chainFreshness,
    },
    narrative_state: {
      status: signalState || categoryRows.length ? 'available' : 'missing',
      intel_signal: compactRow(signalState, ['signal_key', 'signal_type', 'subject_type', 'subject_id', 'display_symbol', 'chain', 'direction', 'confidence', 'source_count', 'source_diversity', 'severity', 'freshness', 'market_impact', 'why_it_matters', 'what_to_watch_next', 'evidence_refs', 'headlines', 'global_score', 'score_delta', 'generated_at', 'stale_after']),
      categories: compactRows(categoryRows, ['provider', 'category_id', 'category_label', 'rank', 'market_cap_usd', 'market_cap_change_24h_pct', 'volume_24h_usd', 'top_3_coins', 'as_of', 'fetched_at'], 6),
      context_blocks: contextBlocksForStorage,
    },
    // Chain-aware ecosystem narratives — for an L1, the narratives within its
    // ecosystem (and the ones THIS asset leads) that may be driving the move.
    ecosystem_narrative_state: ecosystemNarrativeState,
    // AI-curated news clusters + historic catalysts (the "what happened / why").
    catalyst_state: catalystState,
    // Forward token-unlock calendar (emissions) — potential dilution catalyst.
    unlock_state: unlockState,
    // Public token-level on-chain activity (holders, active wallets, volume).
    onchain_state: onchainState,
    news_state: {
      status: newsRows.length ? 'available' : 'missing',
      stories: compactRows(newsRows, ['title', 'url', 'summary', 'source_name', 'sentiment', 'relevance', 'published_at', 'created_at', 'tags', 'chains', 'entity_symbol'], 6),
      freshness: newsFreshness,
    },
    social_state: {
      status: bestDex?.socials || bestDex?.links ? 'available' : 'missing',
      socials: bestDex?.socials || {},
      links: bestDex?.links || {},
      news_sources: [...new Set(newsRows.map((row) => String(row.source_name || '')).filter(Boolean))].slice(0, 6),
    },
    risk_state: {
      caution_flags: [
        ...(resolved.cexProfile?.caution_flags || spread?.caution_flags || []),
        ...(unlockState.material && unlockState.next_unlock
          ? [`Token supply unlock scheduled in ${unlockState.next_unlock.days_until}d (${unlockState.next_unlock.unlock_date}) — potential forward dilution.`]
          : []),
      ],
      upcoming_unlock: unlockState.next_unlock,
      market_cap_estimated: cap?.is_estimated === true,
      signal_direction: signal?.direction || signalState?.direction || null,
      signal_confidence: signal?.confidence || signalState?.confidence || null,
      gaps_affecting_confidence: dataCoverage.material_gaps,
    },
    historical_context: historicalContext,
    provider_coverage: providerCoverage,
    data_coverage: dataCoverage,
    confidence_inputs: {
      confidence,
      used_source_count: dataCoverage.used_sources.length,
      material_gap_count: dataCoverage.material_gaps.length,
      optional_gap_count: dataCoverage.optional_gaps.length,
      freshness: {
        cex: cexFreshness.status,
        dex: dexFreshness.status,
        flow: flowFreshness.status,
        protocol: protocolFreshness.status,
        chain: chainFreshness.status,
        news: newsFreshness.status,
      },
    },
    stale_or_missing_material_gaps: dataCoverage.material_gaps,
    source_provenance: sourceProvenance,
  }

  const contentHash = h32(JSON.stringify(pack))
  return {
    subject: {
      canonical_key: resolved.canonicalKey,
      symbol: sym,
      chain,
      token_address: tokenAddress,
      provider_id: resolved.providerId,
      source_provider: resolved.sourceProvider,
    },
    pack,
    contentHash,
    contextPack,
    dataCoverage,
    providerCoverage,
    sourceProvenance,
    confidence,
    staleAfter,
  }
}

export async function persistAssetEvidencePack(
  db: DB,
  result: AssetEvidencePackResult,
  subject: AssetEvidenceSubject,
  options: AssetEvidencePackOptions = {},
): Promise<AssetEvidencePackResult> {
  const window = options.window || 'current'
  const latest = await latestScopedPack(db, result.subject.canonical_key, subject, window)
  const verdict = latest
    ? materialityVerdict({ prevEvidenceHash: String(latest.content_hash || ''), newEvidenceHash: result.contentHash })
    : { magnitude: 'material' as const }
  const materiality: PackMateriality = latest ? verdict.magnitude : 'new'
  const out = { ...result, materiality }
  if (latest && verdict.magnitude === 'none') {
    return { ...out, persisted: false }
  }

  const evidenceRow = withScope({
    subject_canonical_key: result.subject.canonical_key,
    subject_symbol: result.subject.symbol,
    subject_chain: result.subject.chain,
    window,
    pack_schema_version: 'd1',
    content_hash: result.contentHash,
    pack: result.pack,
    provider_coverage: result.providerCoverage,
    data_coverage: result.dataCoverage,
    source_provenance: result.sourceProvenance,
    confidence: result.confidence,
    materiality,
    built_at: new Date().toISOString(),
    stale_after: result.staleAfter,
  }, subject)
  await db.from('intelligence_evidence_packs').upsert(evidenceRow, { onConflict: 'org_id,user_id,subject_canonical_key,window,content_hash' })

  const contextRow = withScope({
    surface: result.contextPack.surface,
    scope_key: result.contextPack.scope_key,
    context_schema_version: 'd1',
    content_hash: result.contextPack.content_hash,
    blocks: result.contextPack.blocks,
    policy: result.contextPack.policy,
    assembled_at: new Date().toISOString(),
    stale_after: result.contextPack.stale_after,
  }, subject)
  await db.from('ai_context_packs').upsert(contextRow, { onConflict: 'org_id,user_id,surface,scope_key,content_hash' })

  return { ...out, persisted: true }
}

export async function getOrAssembleAssetEvidencePack(
  db: DB,
  subject: AssetEvidenceSubject,
  options: AssetEvidencePackOptions = {},
): Promise<AssetEvidencePackResult> {
  const resolved = await resolveAsset(db, subject)
  const window = options.window || 'current'
  if (!options.force) {
    const latest = await latestScopedPack(db, resolved.canonicalKey, subject, window)
    if (latest && (!latest.stale_after || new Date(String(latest.stale_after)).getTime() > (options.now ?? new Date()).getTime())) {
      const ctx = await latestScopedContextPack(db, resolved.canonicalKey, subject)
      return {
        subject: {
          canonical_key: resolved.canonicalKey,
          symbol: resolved.symbol,
          chain: resolved.chain,
          token_address: resolved.tokenAddress,
          provider_id: resolved.providerId,
          source_provider: resolved.sourceProvider,
        },
        pack: latest.pack as Record<string, unknown>,
        contentHash: String(latest.content_hash || ''),
        contextPack: {
          surface: String(ctx?.surface || 'investor_intel'),
          scope_key: String(ctx?.scope_key || resolved.canonicalKey),
          content_hash: String(ctx?.content_hash || ''),
          blocks: Array.isArray(ctx?.blocks) ? ctx.blocks as Array<Record<string, unknown>> : [],
          policy: ctx?.policy && typeof ctx.policy === 'object' ? ctx.policy as Record<string, unknown> : {},
          stale_after: String(ctx?.stale_after || latest.stale_after || new Date().toISOString()),
        },
        dataCoverage: (latest.data_coverage || {}) as DataCoverage,
        providerCoverage: (latest.provider_coverage || {}) as Record<string, unknown>,
        sourceProvenance: (latest.source_provenance || {}) as Record<string, unknown>,
        confidence: Number(latest.confidence ?? 0.5),
        staleAfter: String(latest.stale_after || ''),
        materiality: String(latest.materiality || 'none') as AssetEvidencePackResult['materiality'],
        cached: true,
        persisted: false,
      }
    }
  }
  const assembled = await assembleAssetEvidencePack(db, { ...subject, symbol: resolved.symbol, canonicalKey: resolved.canonicalKey, chain: resolved.chain, tokenAddress: resolved.tokenAddress }, options)
  return await persistAssetEvidencePack(db, assembled, subject, options)
}

export function compactAssetEvidencePackForPrompt(result: AssetEvidencePackResult | null | undefined, maxChars = 9000): Record<string, unknown> | null {
  if (!result?.pack) return null
  const payload = {
    content_hash: result.contentHash,
    subject: result.subject,
    pack: result.pack,
    ai_context_pack: {
      content_hash: result.contextPack.content_hash,
      blocks: result.contextPack.blocks,
      policy: result.contextPack.policy,
    },
  }
  const raw = JSON.stringify(payload)
  if (raw.length <= maxChars) return payload
  const compact = {
    content_hash: result.contentHash,
    subject: result.subject,
    pack: {
      cex_state: (result.pack as Record<string, unknown>).cex_state,
      dex_state: (result.pack as Record<string, unknown>).dex_state,
      market_summary: (result.pack as Record<string, unknown>).market_summary,
      liquidity_state: (result.pack as Record<string, unknown>).liquidity_state,
      flow_state: (result.pack as Record<string, unknown>).flow_state,
      onchain_state: (result.pack as Record<string, unknown>).onchain_state,
      ecosystem_narrative_state: (result.pack as Record<string, unknown>).ecosystem_narrative_state,
      catalyst_state: (result.pack as Record<string, unknown>).catalyst_state,
      unlock_state: (result.pack as Record<string, unknown>).unlock_state,
      narrative_state: (result.pack as Record<string, unknown>).narrative_state,
      historical_context: (result.pack as Record<string, unknown>).historical_context,
      provider_coverage: (result.pack as Record<string, unknown>).provider_coverage,
      data_coverage: (result.pack as Record<string, unknown>).data_coverage,
      source_provenance: (result.pack as Record<string, unknown>).source_provenance,
    },
    ai_context_pack: {
      content_hash: result.contextPack.content_hash,
      blocks: result.contextPack.blocks.slice(0, 5),
      policy: result.contextPack.policy,
    },
  }
  let s = JSON.stringify(compact)
  if (s.length <= maxChars) return compact
  const minimal = {
    content_hash: result.contentHash,
    subject: result.subject,
    pack: {
      asset: (result.pack as Record<string, unknown>).asset,
      market_summary: (result.pack as Record<string, unknown>).market_summary,
      cex_state: (result.pack as Record<string, unknown>).cex_state,
      dex_state: (result.pack as Record<string, unknown>).dex_state,
      liquidity_state: (result.pack as Record<string, unknown>).liquidity_state,
      onchain_state: (result.pack as Record<string, unknown>).onchain_state,
      ecosystem_narrative_state: (result.pack as Record<string, unknown>).ecosystem_narrative_state,
      catalyst_state: (result.pack as Record<string, unknown>).catalyst_state,
      unlock_state: (result.pack as Record<string, unknown>).unlock_state,
      narrative_state: (result.pack as Record<string, unknown>).narrative_state,
      news_state: (result.pack as Record<string, unknown>).news_state,
      historical_context: (result.pack as Record<string, unknown>).historical_context,
      data_coverage: (result.pack as Record<string, unknown>).data_coverage,
      stale_or_missing_material_gaps: (result.pack as Record<string, unknown>).stale_or_missing_material_gaps,
    },
    ai_context_pack: { blocks: result.contextPack.blocks.slice(0, 3) },
  }
  s = JSON.stringify(minimal)
  if (s.length <= maxChars) return minimal
  return {
    ...minimal,
    ai_context_pack: { blocks: [] },
  }
}

export function criticalSlicesForAssetEvidencePack(result: AssetEvidencePackResult | null | undefined): CriticalEvidenceSlice[] {
  if (!result?.pack) return []
  const pack = result.pack as Record<string, unknown>
  const coverage = (pack.data_coverage || result.dataCoverage || {}) as Partial<DataCoverage>
  const gaps = [...(coverage.material_gaps || []), ...((pack.stale_or_missing_material_gaps as string[] | undefined) || [])]
    .map((gap) => String(gap || '').toLowerCase())
  const out = new Set<CriticalEvidenceSlice>()
  for (const gap of gaps) {
    if (/market|profile/.test(gap)) out.add('market')
    if (/price/.test(gap)) out.add('price')
    if (/liquidity|depth|spread/.test(gap)) out.add('liquidity')
  }
  const cex = (pack.cex_state || {}) as Record<string, unknown>
  const dex = (pack.dex_state || {}) as Record<string, unknown>
  const liq = (pack.liquidity_state || {}) as Record<string, unknown>
  const market = (pack.market_summary || {}) as Record<string, unknown>
  const cexFresh = (cex.freshness || {}) as Record<string, unknown>
  const dexFresh = (dex.freshness || {}) as Record<string, unknown>
  if (!market.current_price && !market.market_cap && !market.volume_24h) out.add('market')
  if (!market.current_price) out.add('price')
  if (!liq.cex_bid_depth_usd && !liq.cex_ask_depth_usd && !liq.dex_liquidity_usd && !liq.cex_min_spread_pct) out.add('liquidity')
  if (cexFresh.status === 'stale' && dexFresh.status !== 'fresh') out.add('market')
  return [...out]
}
