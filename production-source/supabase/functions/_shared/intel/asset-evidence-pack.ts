import {
  assembleIntelligenceContext,
  type IntelligenceContextBlock,
  type SurfaceIntelligencePolicy,
} from '../intelligence-core.ts'
import { evidenceFreshness as freshnessFor, groupFreshness, combineFreshness, selectedFieldEvidence } from './evidence-freshness.ts'
import {selectMarketField} from './market-field-selection.ts'
import { materialityVerdict } from '../core-intel/materiality.ts'
import { h32 } from '../core-intel/hashing.ts'
import { researchIdentity, type AssetEvidenceSubject } from './research-identity.ts'
export type { AssetEvidenceSubject } from './research-identity.ts'
import { readCachedAssetQuote } from './cached-asset-quote.ts'
import { readAssetSpecialistEvidence } from './asset-specialist-evidence.ts'
import {readConnectedAssetIdentity} from './connected-asset-identity.ts'
import { budgetEvidencePrompt } from './evidence-prompt-budget.ts'
import { representationPromptState } from './representation-review.ts'
import { hasVerifiedCexIdentity, marketIdentityChoices } from './market-read-quality.ts'
import { positionDepthQuotes } from './position-depth.ts'
import { canonicalAssetKey } from '../investor-portfolio/canonical.ts'
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
  // Callers that need a strictly cache-only assembly (tests, renders, or
  // degraded operation) can suppress the bounded live enrichment fallback.
  allowLiveEnrichment?: boolean
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
  'intel_market_observations',
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
      const canonical = canonicalAssetKey(chain, addr)
      if (canonical) keys.add(canonical)
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
  const selected = preferred || (!preferredChain && entries.length === 1 ? entries[0] : null)
  return { chain: selected?.chain || null, address: selected?.address || null }
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
async function rows(run: () => any, onFailure?: () => void): Promise<any[]> {
  try {
    const res = await run()
    if (res?.error || !Array.isArray(res?.data)) { onFailure?.(); return [] }
    return res.data
  } catch {
    onFailure?.()
    return []
  }
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

function provenanceFor(table: string, rowsIn: unknown[], nowMs: number, providerFallback: string | null = null, fallbackHours = 24) {
  const providers = new Set<string>()
  for (const row of rowsIn) {
    const provider = row && typeof row === 'object' ? (row as Record<string, unknown>).provider : null
    if (provider) providers.add(String(provider))
  }
  if (!providers.size && providerFallback) providers.add(providerFallback)
  const fresh = groupFreshness(rowsIn, nowMs, fallbackHours)
  return {
    table,
    providers: [...providers],
    rows: rowsIn.length,
    as_of: fresh.as_of,
    stale_after: fresh.stale_after,
    freshness: fresh.status,
    observations: fresh.observations,
    mixed_observation_times: fresh.mixed_observation_times,
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
  const sym = resolved.contextSymbol
  const chain = resolved.chain
  const refs = [...new Set([
    resolved.canonicalKey,
    sym,
    sym ? `asset:${sym}` : null,
    chain,
    ...assetKeys,
  ].map((v) => String(v || '').trim()).filter(Boolean))].slice(0, 10)

  const rollupRows = await rows(() => db.from('intel_rollups')
    .select('*')
    .in('subject_id', refs)
    .order('period_start', { ascending: false })
    .limit(30))
  const rollups = uniqRows(rollupRows, 'id')

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
    rows(() => db.from('historical_analog_links')
      .select('*')
      .in('current_subject_ref', refs)
      .order('observed_at', { ascending: false })
      .limit(20)),
    rows(() => db.from('historical_analog_links')
      .select('*')
      .eq('analog_kind', 'market_regime_similarity')
      .order('observed_at', { ascending: false })
      .limit(3)),
  ])
  const analogs = uniqRows(analogNested.flat(), 'id')

  const timelineRows = await rows(() => db.from('intelligence_entity_timeline')
    .select('*')
    .in('entity_ref', refs)
    .order('occurred_at', { ascending: false })
    .limit(20))
  const timeline = uniqRows(timelineRows, 'id')

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
  subject = researchIdentity(subject)
  const symbol = normalizeSymbol(subject.symbol)
  const providerId = String(subject.providerId || '').trim() || null
  const sourceProvider = String(subject.sourceProvider || '').trim() || null
  let marketAsset = null
  let connected:any=null,identityReadFailed=false
  if(subject.chain&&subject.tokenAddress){
    try{connected=await readConnectedAssetIdentity(db,subject.canonicalKey||canonicalAssetKey(subject.chain,subject.tokenAddress)!)}catch{identityReadFailed=true}
  }
  if(connected?.cmcId){
    try{
      const response=await db.from('market_assets').select('*').eq('source_provider','coinmarketcap').eq('provider_id',connected.cmcId).maybeSingle()
      if(response.error)throw response.error
      marketAsset=response.data
    }catch{identityReadFailed=true}
  }
  if (!marketAsset && providerId && sourceProvider) {
    marketAsset = await maybeSingle(() => db.from('market_assets')
      .select('*')
      .eq('source_provider', sourceProvider)
      .eq('provider_id', providerId)
      .maybeSingle())
  }
  // A canonical contract never borrows the largest market with the same ticker.
  const explicitIdentity = !!(subject.canonicalKey || subject.tokenAddress || providerId)
  if (!marketAsset && symbol && !explicitIdentity) {
    const candidates = await rows(() => db.from('market_assets').select('*')
      .eq('normalized_symbol', symbol).eq('source_provider', 'coingecko').limit(2))
    if (candidates.length === 1) marketAsset = candidates[0]
  }
  if (marketAsset && subject.tokenAddress && subject.chain) {
    const key = canonicalAssetKey(subject.chain, subject.tokenAddress)
    if (!marketIdentityChoices(marketAsset).some(choice => choice.canonicalAssetKey === key)) marketAsset = null
  }
  const resolvedSymbol = normalizeSymbol(marketAsset?.normalized_symbol || marketAsset?.symbol) || symbol
  const mapping = resolvedSymbol && marketAsset
    ? await maybeSingle(() => db.from('exchange_asset_mappings').select('*').eq('normalized_symbol', resolvedSymbol).eq('is_active', true).maybeSingle()) : null
  const cexSymbol = hasVerifiedCexIdentity(marketAsset, mapping) ? resolvedSymbol : null
  const cexProfile = cexSymbol
    ? await maybeSingle(() => db.from('exchange_latest_asset_profiles').select('*').eq('normalized_symbol', cexSymbol).maybeSingle()) : null
  const preferredChain = normalizeChain(subject.chain) || normalizeChain(marketAsset?.primary_chain) || normalizeChain(cexProfile?.chain)
  const platform = bestPlatformAddress(marketAsset?.platforms, preferredChain)
  const tokenAddress = normalizeAddress(subject.tokenAddress) || platform.address
  const chain = normalizeChain(subject.chain) || platform.chain || normalizeChain(marketAsset?.primary_chain) || normalizeChain(cexProfile?.chain)
  const canonicalKey = String(subject.canonicalKey || '').trim()
    || (marketAsset?.source_provider && marketAsset?.provider_id ? `market:${marketAsset.source_provider}:${marketAsset.provider_id}` : '')
    || (chain && tokenAddress ? `${chain}:token:${tokenAddress}` : '')
    || (symbol ? `symbol:${symbol}` : 'asset:unknown')

  return {
    symbol: resolvedSymbol,
    contextSymbol: marketAsset ? resolvedSymbol : null,
    cexSymbol,
    chain,
    tokenAddress,
    canonicalKey,
    providerId: marketAsset?.provider_id || (subject.tokenAddress?null:providerId) || null,
    sourceProvider: marketAsset?.source_provider || (subject.tokenAddress?null:sourceProvider) || null,
    marketAsset,
    cexProfile,
    connected,
    identityReadFailed,
  }
}

export async function assembleAssetEvidencePack(
  db: DB,
  subject: AssetEvidenceSubject,
  options: AssetEvidencePackOptions = {},
): Promise<AssetEvidencePackResult> {
  const now = options.now ?? new Date()
  const nowMs = now.getTime()
  let staleAfter = new Date(nowMs + Math.max(5, options.staleMinutes ?? 30) * 60_000).toISOString()
  const resolved=await resolveAsset(db,subject)
  const cachedQuote=await readCachedAssetQuote(db,resolved.connected?.marketSubject?{canonicalKey:resolved.connected.marketSubject}:subject,nowMs)
  if(cachedQuote.observations.length)staleAfter=new Date(Math.min(Date.parse(staleAfter),...cachedQuote.observations.map((o:any)=>Date.parse(o.expiresAt)))).toISOString()
  const sym = resolved.symbol
  const chain = resolved.chain
  const tokenAddress = resolved.tokenAddress
  const cexSym = resolved.cexSymbol
  const contextSym = resolved.contextSymbol
  const assetKeys = canonicalAssetKeys(chain, tokenAddress, resolved.canonicalKey)
  const depthReadFailures = new Set<string>()
  const protocolReadFailures = new Set<string>()
  const marketReadFailures = new Set<string>()

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
    cexSym ? rows(() => db.from('exchange_latest_tickers').select('*').eq('normalized_symbol', cexSym).order('volume_quote_24h', { ascending: false }).limit(8), () => depthReadFailures.add('exchange_latest_tickers')) : Promise.resolve([]),
    cexSym ? maybeSingle(() => db.from('exchange_latest_market_signals').select('*').eq('normalized_symbol', cexSym).maybeSingle()) : Promise.resolve(null),
    cexSym ? maybeSingle(() => db.from('exchange_latest_market_caps').select('*').eq('normalized_symbol', cexSym).maybeSingle()) : Promise.resolve(null),
    cexSym ? maybeSingle(() => db.from('exchange_latest_cross_market_spreads').select('*').eq('normalized_symbol', cexSym).maybeSingle()) : Promise.resolve(null),
    cexSym ? rows(() => db.from('exchange_latest_orderbook').select('*').eq('normalized_symbol', cexSym).order('as_of', { ascending: false }).limit(8), () => depthReadFailures.add('exchange_latest_orderbook')) : Promise.resolve([]),
    chain && tokenAddress ? rows(() => db.from('dex_pair_snapshots').select('*').eq('chain', chain).eq('token_address', tokenAddress).order('fetched_at', { ascending: false }).limit(5)) : Promise.resolve([]),
    chain && tokenAddress ? rows(() => db.from('pool_ohlcv_snapshots').select('*').eq('chain', chain).eq('token_address', tokenAddress).order('fetched_at', { ascending: false }).limit(3)) : Promise.resolve([]),
    assetKeys.length ? rows(() => db.from('token_metadata_snapshots').select('*').in('canonical_asset_key', assetKeys).order('fetched_at', { ascending: false }).limit(3)) : Promise.resolve([]),
    assetKeys.length ? rows(() => db.from('token_price_snapshots').select('*').in('canonical_asset_key', assetKeys).order('ts', { ascending: false }).limit(3)) : Promise.resolve([]),
    chain ? rows(() => db.from('chain_tvl_snapshots').select('*').eq('chain', chain).order('ts', { ascending: false }).limit(3)) : Promise.resolve([]),
    chain ? rows(() => db.from('protocol_tvl_snapshots').select('*').eq('chain', chain).order('ts', { ascending: false }).limit(5),()=>protocolReadFailures.add('protocol_tvl_snapshots')) : Promise.resolve([]),
    chain ? rows(() => db.from('defi_pool_snapshots').select('*').eq('chain', chain).order('snapshot_at', { ascending: false }).limit(5),()=>protocolReadFailures.add('defi_pool_snapshots')) : Promise.resolve([]),
    chain === 'solana' ? rows(() => db.from('kamino_vault_snapshots').select('*').is('org_id', null).order('snapshot_at', { ascending: false }).limit(5),()=>protocolReadFailures.add('kamino_vault_snapshots')) : Promise.resolve([]),
    chain === 'solana' ? rows(() => db.from('kamino_market_snapshots').select('*').is('org_id', null).order('snapshot_at', { ascending: false }).limit(5),()=>protocolReadFailures.add('kamino_market_snapshots')) : Promise.resolve([]),
    rows(() => db.from('market_macro_available').select('*').order('as_of', { ascending: false }).limit(2),()=>marketReadFailures.add('market_macro_snapshots')),
    resolved.sourceProvider && resolved.providerId ? rows(() => db.from('market_rankings_available').select('*').eq('provider', resolved.sourceProvider).eq('provider_id', resolved.providerId).order('snapshot_bucket', { ascending: false }).limit(3),()=>marketReadFailures.add('market_ranking_snapshots')) : Promise.resolve([]),
    rows(() => db.from('narrative_category_snapshots').select('*').order('as_of', { ascending: false }).limit(8)),
    contextSym ? maybeSingle(() => db.from('intel_signal_state').select('*').eq('subject_type', 'asset').eq('display_symbol', contextSym).order('generated_at', { ascending: false }).limit(1).maybeSingle()) : Promise.resolve(null),
    contextSym ? rows(() => db.from('intel_global_news').select('title, url, summary, source_name, sentiment, relevance, published_at, created_at, tags, chains, entity_symbol').eq('entity_symbol', contextSym).order('published_at', { ascending: false }).limit(6)) : Promise.resolve([]),
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

  }

  // Enrichment layers (chain-aware narratives, curated news + historic catalysts,
  // public on-chain). Each degrades to a 'missing' status rather than throwing.
  // On-chain uses the central Birdeye client (cache-first, budget/kill-switch
  // enforced); live calls are allowed per product decision but bounded by the
  // 'request' budget and the pack's own 30-min reuse cache.
  const [historicalContext, ecosystemNarrativeState, catalystState, onchainState, unlockState, specialist] = await Promise.all([
    assembleHistoricalContext(db, resolved, assetKeys, nowMs),
    assembleEcosystemNarrativeState(db, { chain, symbol: contextSym }),
    assembleCatalystNewsState(db, { symbol: contextSym, chain }, nowMs),
    assemblePublicOnchainState({
      chain,
      tokenAddress,
      allowLive: options.allowLiveEnrichment !== false,
      nowIso: now.toISOString(),
      birdeyeCtx: { supabase: db, jobName: 'asset-evidence-pack', caller: 'market-enrichment', kind: 'request', orgId: subject.orgId || null, userId: subject.userId || null },
    }),
    assembleTokenUnlockState(db, { symbol: contextSym, nowMs, allowLive:options.allowLiveEnrichment !== false }),
    readAssetSpecialistEvidence(db, { ...subject, canonicalKey: resolved.canonicalKey, sourceProvider: resolved.sourceProvider, providerId: resolved.providerId, chain, tokenAddress }, nowMs, resolved.connected?{linked:resolved.connected,identityError:resolved.identityReadFailed}:undefined),
  ])
  const cexFreshness = groupFreshness([resolved.cexProfile, ...tickerRows, signal, cap, spread, ...orderbooks].filter(Boolean), nowMs, 3)
  const dexFreshness = groupFreshness(dexRows, nowMs, 3)
  const flowFreshness = groupFreshness([...largeTransferRows, ...transferRows], nowMs, 3)
  const protocolFreshness = groupFreshness([...protocolRows, ...defiPools, ...kaminoVaults, ...kaminoMarkets], nowMs, 12)
  const hasProtocolContext=Boolean(protocolRows.length||defiPools.length||kaminoVaults.length||kaminoMarkets.length)
  const protocolStatus=protocolReadFailures.size?(hasProtocolContext?'partial':'error'):(hasProtocolContext?'available':'missing')
  // These queries match only the chain, not a token or its issuer. Carry that
  // distinction on extracted rows as well as the enclosing research section.
  const protocolContextRows=(input:unknown[],keep:string[])=>compactRows(input,keep,5).map(row=>({...row,scope:'chain_context',asset_specific:false,context_chain:chain}))
  const chainFreshness = groupFreshness([...chainTvlRows, ...macroRows], nowMs, 12)
  const newsFreshness = groupFreshness(newsRows, nowMs, 36)

  const bestTicker = tickerRows[0] || null
  const bestDex = dexRows[0] || null
  const bestOrderbook = orderbooks[0] || null
  const validSpread=(value:unknown):number|null=>{
    if(typeof value!=='number'&&!(typeof value==='string'&&value.trim()!==''))return null
    const n=Number(value);return Number.isFinite(n)&&n>=0?n:null
  }
  const spreadCandidates=orderbooks.flatMap(row=>{const value=validSpread(row.spread_pct);return value==null?[]:[{value,row,table:'exchange_latest_orderbook'}]}).sort((a,b)=>a.value-b.value)
  const fallbackSpread=validSpread(bestTicker?.spread_pct)
  const selectedSpread=spreadCandidates[0]??(fallbackSpread==null?null:{value:fallbackSpread,row:bestTicker,table:'exchange_latest_tickers'})
  // Zero is a measured depth. No usable observations remain missing per side.
  const sumDepth = (field: 'bid_depth_usd' | 'ask_depth_usd'): number | null => {
    const values = orderbooks.map((row) => row[field]).filter((value) =>
      typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')
    ).map(Number).filter((value) => Number.isFinite(value) && value >= 0)
    if (!values.length) return null
    const total = values.reduce((sum, value) => sum + value, 0)
    return Number.isFinite(total) ? total : null
  }
  const orderbookBidDepth = sumDepth('bid_depth_usd')
  const orderbookAskDepth = sumDepth('ask_depth_usd')
  const depthEvidence = (key: 'bid_depth_usd' | 'ask_depth_usd', value: number | null) => ({
    value, unit: 'USD', source_table: 'exchange_latest_orderbook',
    ...groupFreshness(orderbooks.filter(row => {
      const v = row[key]
      return (typeof v === 'number' || typeof v === 'string' && v.trim() !== '') && Number.isFinite(Number(v)) && Number(v) >= 0
    }), nowMs, 3),
  })

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
  mark('intel_market_observations', cachedQuote.observations.length > 0 || specialist.derivatives.observations.length > 0 || specialist.contractEvidence.observations.length > 0)
  mark('holder_concentration_scores', specialist.holders.records.length > 0)
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
  if(marketReadFailures.size) materialGaps.push(`Market history could not be read from ${[...marketReadFailures].join(', ')}; coverage is unknown.`)
  const hasAnyMarket = cachedQuote.observations.length > 0 || !!resolved.marketAsset || !!resolved.cexProfile || !!bestTicker || !!cap || !!bestDex
  const hasAnyPrice = cachedQuote.fields.price != null || bestTicker?.price != null || bestDex?.price_usd != null || priceRows.length > 0 || resolved.marketAsset?.current_price != null
  const hasAnyLiquidity = orderbooks.length > 0 || !!spread || !!bestDex?.liquidity_usd || !!resolved.cexProfile?.liquidity_score
  if (!hasAnyMarket) materialGaps.push(`No cached market/profile snapshot matched ${sym || resolved.canonicalKey}.`)
  if (!hasAnyPrice) materialGaps.push(`No cached price snapshot matched ${sym || resolved.canonicalKey}.`)
  if (!hasAnyLiquidity) materialGaps.push(`No cached liquidity/depth snapshot matched ${sym || resolved.canonicalKey}.`)
  if (cachedQuote.error) optionalGaps.push(cachedQuote.error)
  if (hasAnyMarket && !cachedQuote.freshness && cexFreshness.status === 'stale' && dexFreshness.status !== 'fresh') {
    materialGaps.push(`Cached market data for ${sym || resolved.canonicalKey} is stale and no fresh DEX fallback was available.`)
  }
  if (!dexRows.length) optionalGaps.push(`No cached DEX pair snapshot matched ${sym || resolved.canonicalKey}; DEX liquidity is absent from this pack.`)
  if (!ohlcvRows.length) optionalGaps.push(`No cached GeckoTerminal OHLCV snapshot matched ${sym || resolved.canonicalKey}.`)
  if (protocolReadFailures.size) {
    optionalGaps.push(`Protocol/DeFi chain context could not be read from ${[...protocolReadFailures].join(', ')}; coverage is unknown.`)
  } else if (!hasProtocolContext) {
    optionalGaps.push(`No cached protocol/DeFi chain context was available for ${chain || sym || resolved.canonicalKey}; token relationships are unverified.`)
  }
  if (!subject.orgId || !subject.userId) optionalGaps.push('Wallet/whale flow data was not scoped for this explain request.')
  else if (!transferRows.length && !largeTransferRows.length) optionalGaps.push(`No cached wallet or large-transfer flow rows matched ${sym || resolved.canonicalKey}.`)
  else if (flowFreshness.status === 'stale') optionalGaps.push('Cached flow data is stale or partial; webhooks remain dormant and polling cadence may lag.')
  if (catalystState.failed_sources?.length) {
    materialGaps.push(`Catalyst evidence could not be loaded from ${catalystState.failed_sources.join(', ')}; event coverage is unknown.`)
  } else if (!newsRows.length && !catalystState.curated_news.length && !catalystState.catalysts.length) {
    optionalGaps.push(`No curated news or historic catalysts matched ${sym || resolved.canonicalKey}.`)
  }
  if (chain && ecosystemNarrativeState.status === 'missing') {
    optionalGaps.push(`No active ecosystem narratives matched ${chain}; ecosystem rotation context is absent.`)
  }
  if (onchainState.status === 'missing') {
    optionalGaps.push(`No public on-chain activity snapshot resolved for ${sym || resolved.canonicalKey}.`)
  }
  // Describe this pack's coverage; other workspaces retain derivatives evidence.
  if (specialist.derivatives.status !== 'available') optionalGaps.push(specialist.derivatives.reason || 'Derivatives coverage is unavailable.')
  if (specialist.derivatives.has_more) optionalGaps.push('Derivatives evidence is bounded to 200 retained observations; the specialist investigation supports further pagination.')
  if (historicalContext.status === 'thin' && historicalContext.coverage_note) optionalGaps.push(String(historicalContext.coverage_note))
  if (!bestDex?.socials && !bestDex?.links) optionalGaps.push(`No cached social/link metadata was present for ${sym || resolved.canonicalKey}.`)
  if (specialist.contractEvidence.status === 'error' || specialist.contractEvidence.status === 'partial') materialGaps.push(specialist.contractEvidence.reason || 'Retained contract evidence could not be read.')
  if (specialist.holders.status !== 'available') optionalGaps.push(specialist.holders.reason || 'Holder coverage is unavailable.')

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
    benchmarks: {source:'intel_market_observations',status:specialist.benchmark.status,observations:specialist.benchmark.observations.map(o=>({id:o.id,subject:o.subject,source_ref:o.sourceRef,observed_at:o.observedAt,recorded_at:o.recordedAt}))},
    undated_cmc_sources: {source:'intel_market_source_versions',observed_at:null,versions:[...(specialist.rwa?.versions||[]),...(specialist.security?.versions||[])].map(v=>({id:v.id,subject:v.subject,family:v.family,source_ref:v.sourceReference,recorded_at:v.recordedAt,fetched_at:v.fetchedAt,expires_at:v.expiresAt})),time_meaning:'Source effective dates are unreported. These are retained response versions, not dated market events.'},
    participation_attention: {source:'intel_market_observations',method:specialist.contractEvidence.attention_comparison?.method,status:specialist.contractEvidence.attention_comparison?.status,observations:specialist.contractEvidence.attention_comparison?.observations.map(o=>({id:o.id,source_ref:o.sourceRef,observed_at:o.observedAt,recorded_at:o.recordedAt}))||[]},
    cmc_contract: { source: 'intel_market_observations', subject: specialist.contractEvidence.subject, status: specialist.contractEvidence.status, observations: specialist.contractEvidence.observations.map(o => ({ id: o.id, source_ref: o.sourceRef, observed_at: o.observedAt, recorded_at: o.recordedAt, expires_at: o.expiresAt })) },
    derivatives: { source: 'intel_market_observations', subject: specialist.derivatives.subject, status: specialist.derivatives.status, observations: specialist.derivatives.observations.map(o => ({ id: o.id, provider: o.provider, source_ref: o.sourceRef, observed_at: o.observedAt, recorded_at: o.recordedAt, expires_at: o.expiresAt })) },
    holders: { source: 'holder_concentration_scores', status: specialist.holders.status, records: specialist.holders.records.map(r => ({ source_ref: r.sourceRef, provider: r.provider, computed_at: r.computed_at, observed_at: r.observedAt, clock_meaning: r.clockMeaning })) },
    market_assets: provenanceFor('market_assets', resolved.marketAsset ? [resolved.marketAsset] : [], nowMs, resolved.sourceProvider),
    cex: provenanceFor('exchange_latest_*', [resolved.cexProfile, ...tickerRows, signal, cap, spread, ...orderbooks].filter(Boolean), nowMs, null, 3),
    dex: provenanceFor('dex_pair_snapshots', dexRows, nowMs, 'dexscreener', 3),
    ohlcv: provenanceFor('pool_ohlcv_snapshots', ohlcvRows, nowMs, 'geckoterminal'),
    token_snapshots: provenanceFor('token_*_snapshots', [...metadataRows, ...priceRows], nowMs, 'alchemy'),
    flow: provenanceFor('asset_transfer_activity/large_transfer_events', [...largeTransferRows, ...transferRows], nowMs, 'alchemy', 3),
    protocol: {...provenanceFor('protocol/defi/kamino snapshots', [...protocolRows, ...defiPools, ...kaminoVaults, ...kaminoMarkets], nowMs, null, 12),scope:'chain_context',asset_specific:false,failed_sources:[...protocolReadFailures],read_status:protocolStatus},
    chain: provenanceFor('chain_tvl_snapshots/market_macro_snapshots', [...chainTvlRows, ...macroRows], nowMs, null, 12),
    narrative: provenanceFor('intel_signal_state/narrative_category_snapshots', [signalState, ...categoryRows].filter(Boolean), nowMs, null),
    ecosystem_narrative: { source: 'narrative_taxonomy/narrative_state/narrative_signals', freshness: ecosystemNarrativeState.freshness, status: ecosystemNarrativeState.status },
    news: provenanceFor('intel_global_news', newsRows, nowMs, null, 36),
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

  const field = (unit: string, candidates: Array<[unknown, unknown, string]>) => {
    return selectMarketField(candidates, nowMs, unit)
  }
  const quote = (key: string): [unknown, unknown, string] => [cachedQuote.fields[key]?.value, cachedQuote.fields[key], 'intel_market_observations']
  const marketFields = {
    current_price: field('USD', [quote('price'), [bestTicker?.price, bestTicker, 'exchange_latest_tickers'], [bestDex?.price_usd, bestDex, 'dex_pair_snapshots'], [priceRows[0]?.price_usd, priceRows[0], 'token_price_snapshots'], [resolved.marketAsset?.current_price, resolved.marketAsset, 'market_assets']]),
    change_24h_pct: field('%', [quote('change_86400'), [bestTicker?.price_change_pct_24h, bestTicker, 'exchange_latest_tickers'], [resolved.marketAsset?.change_24h_pct, resolved.marketAsset, 'market_assets']]),
    change_7d_pct: field('%', [quote('change_604800'), [bestTicker?.price_change_pct_7d, bestTicker, 'exchange_latest_tickers'], [resolved.marketAsset?.change_7d_pct, resolved.marketAsset, 'market_assets']]),
    volume_24h: field('USD', [quote('volume_24h'), [bestTicker?.volume_quote_24h, bestTicker, 'exchange_latest_tickers'], [bestDex?.volume_24h, bestDex, 'dex_pair_snapshots'], [resolved.marketAsset?.volume_24h, resolved.marketAsset, 'market_assets']]),
    market_cap: field('USD', [quote('market_cap'), [cap?.market_cap, cap, 'exchange_latest_market_caps'], [bestDex?.market_cap, bestDex, 'dex_pair_snapshots'], [resolved.marketAsset?.market_cap, resolved.marketAsset, 'market_assets']]),
    fdv: field('USD', [[cap?.fdv, cap, 'exchange_latest_market_caps'], [bestDex?.fdv, bestDex, 'dex_pair_snapshots'], [resolved.marketAsset?.fdv, resolved.marketAsset, 'market_assets']]),
  }

  const pack = {
    identity_version: 3,
    market_lookup_version: 2,
    market_selection_version: 1,
    coverage_version: 1,
    retained_quote_version: 1,
    evidence_projection_version: 3,
    liquidity_projection_version: 1,
    protocol_context_version: 1,
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
      ...Object.fromEntries(Object.entries(marketFields).map(([key, evidence]) => [key, evidence.value])),
      freshness: combineFreshness(Object.values(marketFields)),
      field_evidence: marketFields,
      retained_observations: cachedQuote.observations,
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
      venue_depth: {
        quotes: depthReadFailures.size ? [] : positionDepthQuotes(resolved.marketAsset, !!cexSym, orderbooks, tickerRows, nowMs),
        status: depthReadFailures.size ? 'error' : 'recorded',
        reason: depthReadFailures.size ? 'The retained exchange depth read failed. Coverage is unknown.' : 'Only fresh, verified USD best-level quantities among the bounded covered venues are included. Deeper levels and fees are not inferred.',
        evaluated_at: now.toISOString(),
      },
      cex_bid_depth_usd: orderbookBidDepth,
      cex_ask_depth_usd: orderbookAskDepth,
      cex_min_spread_pct: selectedSpread?.value ?? null,
      dex_liquidity_usd: bestDex?.liquidity_usd ?? null,
      spread_watch: compactRow(spread, ['gross_spread_pct', 'estimated_net_spread_pct', 'caution_flags', 'as_of']),
      freshness: groupFreshness([...orderbooks, bestDex, spread, bestTicker].filter(Boolean), nowMs, 3),
      field_evidence: {
        cex_bid_depth_usd: depthEvidence('bid_depth_usd', orderbookBidDepth),
        cex_ask_depth_usd: depthEvidence('ask_depth_usd', orderbookAskDepth),
        dex_liquidity_usd: selectedFieldEvidence(bestDex?.liquidity_usd, bestDex, 'dex_pair_snapshots', nowMs, 'USD'),
        cex_min_spread_pct: selectedFieldEvidence(selectedSpread?.value,selectedSpread?.row,selectedSpread?.table||'',nowMs,'%'),
      },
    },
    flow_state: {
      status: subject.orgId && subject.userId ? (transferRows.length || largeTransferRows.length ? 'available' : 'missing') : 'not_scoped',
      transfer_activity: compactRows(transferRows, ['chain', 'canonical_asset_key', 'symbol', 'amount', 'usd_value', 'direction', 'label', 'provider', 'block_time', 'fetched_at', 'stale_after'], 6),
      large_transfers: compactRows(largeTransferRows, ['chain', 'canonical_asset_key', 'symbol', 'amount', 'usd_value', 'threshold_usd', 'direction', 'label', 'provider', 'observed_at', 'fetched_at'], 6),
      poll_cadence_note: 'Flow/whale data is polling-cadence only until provider webhooks are registered.',
      freshness: flowFreshness,
    },
    cmc_contract_state: specialist.contractEvidence,
    rwa_state: specialist.rwa,
    security_state: specialist.security,
    benchmark_state: specialist.benchmark,
    representation_state: specialist.representation,
    connected_identity: resolved.connected||specialist.identity,
    derivatives_state: specialist.derivatives,
    holder_state: {
      ...specialist.holders,
      token_metadata: compactRows(metadataRows, ['chain', 'token_address', 'canonical_asset_key', 'symbol', 'name', 'decimals', 'provider', 'fetched_at', 'stale_after', 'confidence'], 2),
    },
    protocol_state: {
      status: protocolStatus,
      scope:'chain_context',asset_specific:false,context_chain:chain,
      qualification:'Chain-wide protocol and pool context. A relationship to this token, its issuer or holders has not been verified; these values are not token fundamentals.',
      failed_sources:[...protocolReadFailures],
      protocol_tvl: protocolContextRows(protocolRows, ['protocol_slug', 'protocol_name', 'chain', 'ts', 'tvl_usd', 'provider', 'source_ref', 'fetched_at', 'stale_after', 'confidence']),
      defi_pools: protocolContextRows(defiPools, ['provider', 'chain', 'pool_id', 'name', 'project', 'symbol', 'tvl_usd', 'apy', 'apy_base', 'apy_reward', 'product_type', 'snapshot_at', 'fetched_at', 'stale_after', 'confidence']),
      kamino_vaults: protocolContextRows(kaminoVaults, ['vault_address', 'name', 'tvl_usd', 'apy', 'apy_base', 'apy_reward', 'token_a_mint', 'token_b_mint', 'snapshot_at', 'fetched_at', 'stale_after', 'confidence']),
      kamino_markets: protocolContextRows(kaminoMarkets, ['market_address', 'reserve_address', 'mint', 'market_name', 'supply_apy', 'borrow_apy', 'total_borrow_usd', 'utilization', 'snapshot_at', 'fetched_at', 'stale_after', 'confidence']),
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
    if (latest && (latest.pack as Record<string, unknown>)?.identity_version === 3 && (latest.pack as Record<string, unknown>)?.market_lookup_version === 2 && (latest.pack as Record<string, unknown>)?.market_selection_version === 1 && (latest.pack as Record<string, unknown>)?.coverage_version === 1 && (latest.pack as Record<string, unknown>)?.retained_quote_version === 1 && (latest.pack as Record<string, unknown>)?.evidence_projection_version === 3 && (latest.pack as Record<string, unknown>)?.liquidity_projection_version === 1 && (latest.pack as Record<string, unknown>)?.protocol_context_version === 1 && (!latest.stale_after || new Date(String(latest.stale_after)).getTime() > (options.now ?? new Date()).getTime())) {
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
  // Provider metadata describes representations; it is not an authored network
  // selector. Preserve only the caller's explicit chain/contract constraints.
  const assembled = await assembleAssetEvidencePack(db, { ...subject, symbol: resolved.symbol, canonicalKey: resolved.canonicalKey }, options)
  return await persistAssetEvidencePack(db, assembled, subject, options)
}

export function compactAssetEvidencePackForPrompt(result: AssetEvidencePackResult | null | undefined, maxChars = 9000): Record<string, unknown> | null {
  if (!result?.pack) return null
  // Sanitize before every fast/compact/budget return; the saved pack is immutable.
  if (result.pack.representation_state != null) result={...result,pack:{...result.pack,representation_state:representationPromptState(result.pack.representation_state as any)}}
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
      cmc_contract_state: (result.pack as Record<string, unknown>).cmc_contract_state,
      rwa_state: (result.pack as Record<string, unknown>).rwa_state,
      security_state: (result.pack as Record<string, unknown>).security_state,
      benchmark_state: (result.pack as Record<string, unknown>).benchmark_state,
      representation_state: (result.pack as Record<string, unknown>).representation_state,
      derivatives_state: (result.pack as Record<string, unknown>).derivatives_state,
      holder_state: (result.pack as Record<string, unknown>).holder_state,
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
      cmc_contract_state: (result.pack as Record<string, unknown>).cmc_contract_state,
      rwa_state: (result.pack as Record<string, unknown>).rwa_state,
      security_state: (result.pack as Record<string, unknown>).security_state,
      benchmark_state: (result.pack as Record<string, unknown>).benchmark_state,
      representation_state: (result.pack as Record<string, unknown>).representation_state,
      derivatives_state: (result.pack as Record<string, unknown>).derivatives_state,
      holder_state: (result.pack as Record<string, unknown>).holder_state,
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
  return budgetEvidencePrompt(result.contentHash, result.subject, result.pack, maxChars)
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
  const known=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)
  if (![market.current_price,market.market_cap,market.volume_24h].some(known)) out.add('market')
  if (!known(market.current_price)) out.add('price')
  if (![liq.cex_bid_depth_usd,liq.cex_ask_depth_usd,liq.dex_liquidity_usd,liq.cex_min_spread_pct].some(known)) out.add('liquidity')
  if (cexFresh.status === 'stale' && dexFresh.status !== 'fresh') out.add('market')
  return [...out]
}
