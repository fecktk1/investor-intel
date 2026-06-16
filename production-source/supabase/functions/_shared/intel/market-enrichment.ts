// Market-page enrichment — shared by the AI evidence pack (asset-evidence-pack.ts)
// and the Markets detail response (intel-markets) so the SAME ecosystem-narrative,
// catalyst/news, and public on-chain reads power both the visible cards and the
// "Explain why" AI synthesis. Every read is best-effort: a missing table / empty
// result degrades to status:'missing' rather than throwing, so this is safe to
// deploy ahead of any data backfill.

import { getTokenOverview, type BirdeyeContext } from '../birdeye-client.ts'

// deno-lint-ignore no-explicit-any
type DB = any
// deno-lint-ignore no-explicit-any
type Any = any

// ── tiny local helpers (mirror asset-evidence-pack's private ones) ───────────
async function rows(run: () => Any): Promise<Any[]> {
  try {
    const res = await run()
    if (res?.error) return []
    return Array.isArray(res?.data) ? res.data : []
  } catch {
    return []
  }
}

function upperSym(value: unknown): string | null {
  const s = String(value || '').trim().replace(/^\$/, '').toUpperCase()
  return s || null
}

function num(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function newestTs(rowsIn: Any[], keys: string[]): string | null {
  let best = ''
  for (const r of rowsIn) {
    for (const k of keys) {
      const v = r?.[k]
      if (typeof v === 'string' && v > best) best = v
    }
  }
  return best || null
}

// Birdeye's x-chain slugs. Our normalized chain slugs are mostly 1:1; map the few
// that differ and gate live calls to chains Birdeye actually serves.
const BIRDEYE_CHAINS: Record<string, string> = {
  ethereum: 'ethereum',
  solana: 'solana',
  base: 'base',
  arbitrum: 'arbitrum',
  optimism: 'optimism',
  polygon: 'polygon',
  bsc: 'bsc',
  avalanche: 'avalanche',
  sui: 'sui',
  zksync: 'zksync',
}

// ── 1. Ecosystem narratives (chain-aware) ────────────────────────────────────
// For an L1/chain: the hot narratives within its ecosystem (taxonomy.chains ?
// <chain>) ranked by global_priority_score, PLUS the narratives THIS asset leads
// or belongs to, PLUS the recent source signals behind them. This is the "what's
// driving it in the ecosystem" layer the CEX-only read was missing.
export interface EcosystemNarrative {
  slug: string | null
  name: string | null
  parent_category: string | null
  status?: string | null
  is_leader?: boolean
  weight?: number | null
  lifecycle_stage: string | null
  signal_class: string | null
  global_priority_score: number | null
  momentum_score?: number | null
  chatter_score?: number | null
  risk_score?: number | null
}

export interface EcosystemNarrativeState {
  status: 'available' | 'missing'
  chain: string | null
  asset_narratives: EcosystemNarrative[]
  ecosystem_narratives: EcosystemNarrative[]
  signals: Array<Record<string, unknown>>
  freshness: string | null
}

export async function assembleEcosystemNarrativeState(
  db: DB,
  { chain, symbol }: { chain: string | null; symbol: string | null },
): Promise<EcosystemNarrativeState> {
  const sym = upperSym(symbol)
  const [ecoTax, memberRows] = await Promise.all([
    chain
      ? rows(() => db.from('narrative_taxonomy')
          .select('id, slug, name, parent_category, status, chains')
          .contains('chains', [chain])
          .in('status', ['active', 'surfaced'])
          .limit(16))
      : Promise.resolve([]),
    sym
      ? rows(() => db.from('narrative_assets')
          .select('narrative_id, is_leader, weight, normalized_symbol, narrative_taxonomy:narrative_taxonomy(slug, name, parent_category, status)')
          .eq('normalized_symbol', sym)
          .order('is_leader', { ascending: false })
          .order('weight', { ascending: false })
          .limit(8))
      : Promise.resolve([]),
  ])

  const idSet = new Set<string>()
  for (const r of ecoTax) if (r?.id) idSet.add(String(r.id))
  for (const r of memberRows) if (r?.narrative_id) idSet.add(String(r.narrative_id))
  const ids = [...idSet].slice(0, 16)

  const [stateRows, signalRows] = await Promise.all([
    ids.length
      ? rows(() => db.from('narrative_state')
          .select('narrative_id, global_priority_score, signal_class, lifecycle_stage, prev_stage, momentum_score, chatter_score, risk_score, crowding_score, onchain_status, scored_at')
          .in('narrative_id', ids))
      : Promise.resolve([]),
    ids.length
      ? rows(() => db.from('narrative_signals')
          .select('narrative_id, signal_kind, bias, source_quality_score, title, snippet, source_url, observed_at')
          .in('narrative_id', ids)
          .order('observed_at', { ascending: false })
          .limit(12))
      : Promise.resolve([]),
  ])

  const stateById = new Map<string, Any>()
  for (const s of stateRows) if (s?.narrative_id) stateById.set(String(s.narrative_id), s)
  const slugById = new Map<string, string>()

  const ecosystem_narratives: EcosystemNarrative[] = ecoTax.map((t: Any) => {
    const st = stateById.get(String(t.id)) || {}
    slugById.set(String(t.id), t.slug)
    return {
      slug: t.slug ?? null,
      name: t.name ?? null,
      parent_category: t.parent_category ?? null,
      status: t.status ?? null,
      lifecycle_stage: st.lifecycle_stage ?? null,
      signal_class: st.signal_class ?? null,
      global_priority_score: num(st.global_priority_score),
      momentum_score: num(st.momentum_score),
      chatter_score: num(st.chatter_score),
      risk_score: num(st.risk_score),
    }
  }).sort((a, b) => (b.global_priority_score ?? -1) - (a.global_priority_score ?? -1)).slice(0, 8)

  const asset_narratives: EcosystemNarrative[] = memberRows.map((m: Any) => {
    const st = stateById.get(String(m.narrative_id)) || {}
    const tax = m.narrative_taxonomy || {}
    if (tax.slug) slugById.set(String(m.narrative_id), tax.slug)
    return {
      slug: tax.slug ?? null,
      name: tax.name ?? null,
      parent_category: tax.parent_category ?? null,
      status: tax.status ?? null,
      is_leader: !!m.is_leader,
      weight: num(m.weight),
      lifecycle_stage: st.lifecycle_stage ?? null,
      signal_class: st.signal_class ?? null,
      global_priority_score: num(st.global_priority_score),
      momentum_score: num(st.momentum_score),
      chatter_score: num(st.chatter_score),
      risk_score: num(st.risk_score),
    }
  })

  const signals = signalRows.map((s: Any) => ({
    narrative: slugById.get(String(s.narrative_id)) || null,
    signal_kind: s.signal_kind ?? null,
    bias: s.bias ?? null,
    source_quality_score: num(s.source_quality_score),
    title: s.title ?? null,
    snippet: typeof s.snippet === 'string' ? s.snippet.slice(0, 220) : null,
    source_url: s.source_url ?? null,
    observed_at: s.observed_at ?? null,
  }))

  return {
    status: ecosystem_narratives.length || asset_narratives.length ? 'available' : 'missing',
    chain: chain || null,
    asset_narratives,
    ecosystem_narratives,
    signals,
    freshness: newestTs([...stateRows, ...signalRows], ['scored_at', 'observed_at']),
  }
}

// ── 2. Curated news + historic catalysts ─────────────────────────────────────
// AI-curated, deduped, surface-worthy news clusters (intel_curated_news) keyed by
// token OR chain, plus major historic events (intel_event_memory) — the real
// "what happened / why it matters" the raw entity_symbol news read kept missing.
export interface CatalystNewsState {
  status: 'available' | 'missing'
  curated_news: Array<Record<string, unknown>>
  catalysts: Array<Record<string, unknown>>
  freshness: string | null
}

function arrayContainsOr(field: string, values: string[]): string {
  // PostgREST .or() array-contains terms: `field.cs.{value}`
  return values.map((v) => `${field}.cs.{${v}}`).join(',')
}

export async function assembleCatalystNewsState(
  db: DB,
  { symbol, chain }: { symbol: string | null; chain: string | null },
): Promise<CatalystNewsState> {
  const sym = upperSym(symbol)
  const tokenTerms: string[] = []
  if (sym) tokenTerms.push(`tokens.cs.{${sym}}`)
  if (chain) tokenTerms.push(`chains.cs.{${chain}}`)
  const eventTerms: string[] = []
  if (sym) eventTerms.push(`assets.cs.{${sym}}`)
  if (chain) eventTerms.push(`chains.cs.{${chain}}`)

  const [curated, events] = await Promise.all([
    tokenTerms.length
      ? rows(() => db.from('intel_curated_news')
          .select('title, cleaned_title, summary, why_it_matters, crypto_impact, watch_next, signal, confidence, final_score, source_count, primary_url, published_at, chains, tokens, narratives, sectors')
          .eq('should_surface', true)
          .or(tokenTerms.join(','))
          .order('final_score', { ascending: false })
          .limit(6))
      : Promise.resolve([]),
    eventTerms.length
      ? rows(() => db.from('intel_event_memory')
          .select('event_type, title, summary, occurred_at, importance_score, assets, chains, narratives')
          .or(eventTerms.join(','))
          .order('occurred_at', { ascending: false })
          .limit(6))
      : Promise.resolve([]),
  ])

  const curated_news = curated.map((c: Any) => ({
    title: c.cleaned_title || c.title || null,
    summary: typeof c.summary === 'string' ? c.summary.slice(0, 320) : null,
    why_it_matters: c.why_it_matters ?? null,
    crypto_impact: c.crypto_impact ?? null,
    watch_next: c.watch_next ?? null,
    signal: c.signal ?? null,
    confidence: c.confidence ?? null,
    final_score: num(c.final_score),
    source_count: num(c.source_count),
    url: c.primary_url ?? null,
    published_at: c.published_at ?? null,
    tokens: Array.isArray(c.tokens) ? c.tokens.slice(0, 8) : [],
    chains: Array.isArray(c.chains) ? c.chains.slice(0, 8) : [],
  }))

  const catalysts = events.map((e: Any) => ({
    event_type: e.event_type ?? null,
    title: e.title ?? null,
    summary: typeof e.summary === 'string' ? e.summary.slice(0, 280) : null,
    occurred_at: e.occurred_at ?? null,
    importance_score: num(e.importance_score),
    assets: Array.isArray(e.assets) ? e.assets.slice(0, 8) : [],
    chains: Array.isArray(e.chains) ? e.chains.slice(0, 8) : [],
  }))

  return {
    status: curated_news.length || catalysts.length ? 'available' : 'missing',
    curated_news,
    catalysts,
    freshness: newestTs([...curated, ...events], ['published_at', 'occurred_at']),
  }
}

// ── 3. Public on-chain activity (budgeted live) ──────────────────────────────
// Public token-level on-chain read via the central Birdeye client (cache-first;
// the client enforces budget + per-minute caps + kill switch). Only runs for
// tokens with a contract/mint address — native L1 coins (no contract) report
// status 'native_no_contract' (their on-chain story lives in chain TVL / macro /
// ecosystem-narrative layers, not token holder metrics).
export interface PublicOnchainState {
  status: 'available' | 'missing' | 'native_no_contract' | 'unsupported_chain'
  source: string | null
  holders: number | null
  unique_wallets_24h: number | null
  volume_24h_usd: number | null
  volume_change_24h_pct: number | null
  price_change_24h_pct: number | null
  liquidity_usd: number | null
  as_of: string | null
}

export async function assemblePublicOnchainState(
  args: {
    chain: string | null
    tokenAddress: string | null
    birdeyeCtx: BirdeyeContext
    allowLive?: boolean
    nowIso?: string
  },
): Promise<PublicOnchainState> {
  const empty = (status: PublicOnchainState['status']): PublicOnchainState => ({
    status, source: null, holders: null, unique_wallets_24h: null, volume_24h_usd: null,
    volume_change_24h_pct: null, price_change_24h_pct: null, liquidity_usd: null, as_of: null,
  })
  const chain = args.chain || null
  if (!chain) return empty('missing')
  const beChain = BIRDEYE_CHAINS[chain]
  if (!beChain) return empty('unsupported_chain')
  if (!args.tokenAddress) return empty('native_no_contract')

  try {
    // cacheOnly when live is not allowed → reads whatever a warm cache holds, never spends.
    const ov = await getTokenOverview(beChain, args.tokenAddress, args.birdeyeCtx, { cacheOnly: args.allowLive === false })
    if (!ov) return empty('missing')
    const has = ov.holders != null || ov.unique_wallets_24h != null || ov.volume_24h_usd != null
    return {
      status: has ? 'available' : 'missing',
      source: 'birdeye',
      holders: num(ov.holders),
      unique_wallets_24h: num(ov.unique_wallets_24h),
      volume_24h_usd: num(ov.volume_24h_usd),
      volume_change_24h_pct: num(ov.volume_change_24h_pct),
      price_change_24h_pct: num(ov.price_change_24h_pct),
      liquidity_usd: num(ov.liquidity),
      as_of: args.nowIso || null,
    }
  } catch {
    return empty('missing')
  }
}
