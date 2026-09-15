// Investor Intel — contract identity for the Markets detail page.
//
// A pasted contract that no catalogue provider lists must still open the SAME
// asset page a listed asset opens. This assembles a `market_assets`-SHAPED
// PROJECTION (never a database insert) from the sources that actually
// answered: the cached `memecoin_latest_tokens` observation first (zero
// provider calls), otherwise a bounded ladder of the governed free DEX /
// metadata clients. Nothing is invented — an unanswered field stays null and
// the row carries the reason, so the page can say why a section is empty.

import { CHAIN_PROVIDERS, getChain, normalizeTokenAddress } from '../chains.ts'
import { getTokenPairs } from '../memecoin/dexscreener.ts'
import { getOhlcv, getTokenInfo, getTokenPools } from '../memecoin/geckoterminal.ts'
import { getTokenMetadata } from '../birdeye-client.ts'
import type { DegenCtx } from '../memecoin/http.ts'
import { CHART_WINDOWS } from './cmc-chart.ts'

/** At most three governed provider calls, inside one six-second budget. */
export const CONTRACT_MAX_PROVIDER_CALLS = 3
export const CONTRACT_BUDGET_MS = 6000

export type ContractSourceState = 'available' | 'empty' | 'unavailable'
export interface ContractAssetSource {
  provider: string
  state: ContractSourceState
  /** When the answering source observed the data it returned. */
  observedAt: string | null
  reason: string | null
}
export interface ContractIdentity {
  chain: string
  address: string
  decimals: number | null
  pairAddress: string | null
  dexId: string | null
  liquidityUsd: number | null
  sources: ContractAssetSource[]
}
// deno-lint-ignore no-explicit-any
export type ContractMarketAsset = Record<string, any> & { source_provider: 'contract'; provider_id: string; contract: ContractIdentity }

export interface ContractAssetDeps {
  tokenPairs?: typeof getTokenPairs
  tokenInfo?: typeof getTokenInfo
  tokenMetadata?: typeof getTokenMetadata
  tokenPools?: typeof getTokenPools
  ohlcv?: typeof getOhlcv
  now?: () => number
}

const num = (v: unknown): number | null => { const n = Number(v); return v == null || v === '' || !Number.isFinite(n) ? null : n }
const iso = (v: unknown): string | null => { const t = Date.parse(String(v || '')); return Number.isFinite(t) ? new Date(t).toISOString() : null }
/** Address label for a token no metadata source named. Never a claimed ticker. */
export function shortContractLabel(address: string): string {
  const a = String(address || '')
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a
}

/** Split `<chain>:<address>` exactly once; the chain segment never holds ':'. */
export function parseContractProviderId(id: string): { chain: string; address: string } | null {
  const raw = String(id || '')
  if (!/^[a-z0-9-]+:[^\s]+$/.test(raw)) return null
  const at = raw.indexOf(':')
  const chain = raw.slice(0, at), address = raw.slice(at + 1)
  if (!chain || !address || !getChain(chain)) return null
  return { chain, address }
}

// deno-lint-ignore no-explicit-any
async function readMemecoinRow(admin: any, chain: string, addresses: string[]): Promise<Record<string, unknown> | null> {
  try {
    const { data } = await admin.from('memecoin_latest_tokens')
      .select('chain, token_address, symbol, name, image_url, cached_image_url, price_usd, change_1h_pct, change_24h_pct, volume_24h_usd, liquidity_usd, fdv, market_cap, pair_address, dex_id, source, source_provider, source_label, attribution_label, confidence, as_of, last_refreshed_at')
      .eq('chain', chain)
      .in('token_address', addresses)
      .order('as_of', { ascending: false })
      .limit(1)
      .maybeSingle()
    return data || null
  } catch { return null }
}

interface RowInput {
  chain: string; address: string; symbol: string | null; name: string | null; imageUrl: string | null; decimals: number | null
  price: number | null; marketCap: number | null; fdv: number | null; volume24h: number | null
  change1h: number | null; change24h: number | null; liquidityUsd: number | null
  pairAddress: string | null; dexId: string | null; asOf: string | null; lastRefreshedAt: string | null
  sourceLabel: string | null; confidence: string | null; quoteReason: string | null; sources: ContractAssetSource[]
}

function contractRow(input: RowInput): ContractMarketAsset {
  const symbol = input.symbol || shortContractLabel(input.address)
  const attribution = input.sourceLabel ? `Data via ${input.sourceLabel}` : null
  return {
    source_provider: 'contract',
    provider_id: `${input.chain}:${input.address}`,
    symbol,
    name: input.name,
    normalized_symbol: String(symbol).toUpperCase().replace(/^\$/, ''),
    primary_chain: input.chain,
    platforms: { [input.chain]: input.address },
    current_price: input.price,
    market_cap: input.marketCap,
    fdv: input.fdv,
    volume_24h: input.volume24h,
    change_1h_pct: input.change1h,
    change_24h_pct: input.change24h,
    image_url: input.imageUrl,
    as_of: input.asOf,
    last_refreshed_at: input.lastRefreshedAt || input.asOf,
    source_label: input.sourceLabel,
    attribution_label: attribution,
    confidence: input.confidence,
    // Read by the detail response as `quoteReason` — an empty price says why.
    quote_reason: input.price == null ? (input.quoteReason || 'no_dex_quote_observed') : null,
    contract: {
      chain: input.chain,
      address: input.address,
      decimals: input.decimals,
      pairAddress: input.pairAddress,
      dexId: input.dexId,
      liquidityUsd: input.liquidityUsd,
      sources: input.sources,
    },
  }
}

/**
 * Identity + market read for one on-chain contract. Returns a row the markets
 * detail assembly consumes exactly like a catalogue `market_assets` row.
 */
// deno-lint-ignore no-explicit-any
export async function buildContractMarketAsset(admin: any, chain: string, address: string, ctx: DegenCtx = {}, deps: ContractAssetDeps = {}): Promise<ContractMarketAsset> {
  const now = deps.now || (() => Date.now())
  const deadline = now() + CONTRACT_BUDGET_MS
  const raw = String(address || '').trim()
  const canonical = normalizeTokenAddress(chain, raw)
  const sources: ContractAssetSource[] = []

  // 1. The cached Degen observation — the same row the terminal renders. A hit
  //    is a complete answer, so it costs zero provider calls.
  const candidates = [...new Set([canonical, raw].filter(Boolean))]
  const cached = await readMemecoinRow(admin, chain, candidates)
  if (cached) {
    const observedAt = iso(cached.as_of) || iso(cached.last_refreshed_at)
    sources.push({ provider: String(cached.source_provider || cached.source || 'dexscreener'), state: 'available', observedAt, reason: null })
    return contractRow({
      chain, address: String(cached.token_address || canonical),
      symbol: cached.symbol ? String(cached.symbol) : null,
      name: cached.name ? String(cached.name) : null,
      imageUrl: (cached.cached_image_url ? String(cached.cached_image_url) : null) || (cached.image_url ? String(cached.image_url) : null),
      decimals: null,
      price: num(cached.price_usd), marketCap: num(cached.market_cap), fdv: num(cached.fdv), volume24h: num(cached.volume_24h_usd),
      change1h: num(cached.change_1h_pct), change24h: num(cached.change_24h_pct), liquidityUsd: num(cached.liquidity_usd),
      pairAddress: cached.pair_address ? String(cached.pair_address) : null,
      dexId: cached.dex_id ? String(cached.dex_id) : null,
      asOf: observedAt, lastRefreshedAt: iso(cached.last_refreshed_at),
      sourceLabel: cached.source_label ? String(cached.source_label) : 'DEX Screener',
      confidence: cached.confidence ? String(cached.confidence) : 'medium',
      quoteReason: 'no_cached_dex_price', sources,
    })
  }

  // 2. Live ladder — each call is a governed client with the request budget.
  const providers = CHAIN_PROVIDERS[chain] || null
  const degenCtx: DegenCtx = {
    ...ctx, supabase: ctx.supabase ?? admin, jobName: ctx.jobName ?? 'intel-markets', caller: ctx.caller ?? 'contract-identity',
    kind: 'request', chain, tokenAddress: canonical, maxCalls: CONTRACT_MAX_PROVIDER_CALLS,
  }
  let calls = 0
  const affordable = () => calls < CONTRACT_MAX_PROVIDER_CALLS && now() < deadline
  const spend = async <T>(provider: string, supported: boolean, read: () => Promise<T | null>): Promise<T | null> => {
    if (!supported) { sources.push({ provider, state: 'unavailable', observedAt: null, reason: 'chain_not_supported' }); return null }
    if (!affordable()) { sources.push({ provider, state: 'unavailable', observedAt: null, reason: 'budget_exhausted' }); return null }
    calls++
    let value: T | null = null
    try { value = await read() } catch { value = null }
    const observedAt = value ? new Date(now()).toISOString() : null
    sources.push({ provider, state: value ? 'available' : 'empty', observedAt, reason: value ? null : 'no_observation' })
    return value
  }

  const dex = await spend('dexscreener', !!providers?.dexscreener, () => (deps.tokenPairs || getTokenPairs)(chain, canonical, degenCtx))
  const info = await spend('geckoterminal', !!providers?.geckoterminal, () => (deps.tokenInfo || getTokenInfo)(chain, canonical, degenCtx))
  const meta = await spend('birdeye', !!providers?.birdeye, () => (deps.tokenMetadata || getTokenMetadata)(providers?.birdeye || chain, canonical, { supabase: degenCtx.supabase, jobName: degenCtx.jobName, caller: 'contract-identity', kind: 'request', maxCalls: 1 }))

  const answered = sources.filter((s) => s.state === 'available').map((s) => s.provider)
  const label = answered.includes('dexscreener') ? 'DEX Screener' : answered.includes('geckoterminal') ? 'GeckoTerminal' : answered.includes('birdeye') ? 'Birdeye' : null
  const price = dex?.priceUsd ?? null
  return contractRow({
    chain, address: canonical,
    symbol: dex?.symbol || meta?.symbol || null,
    name: dex?.name || meta?.name || null,
    imageUrl: dex?.imageUrl || info?.imageUrl || meta?.logo_url || null,
    decimals: meta?.decimals ?? null,
    price, marketCap: dex?.marketCap ?? null, fdv: dex?.fdv ?? null, volume24h: dex?.volume24hUsd ?? null,
    change1h: dex?.change1hPct ?? null, change24h: dex?.change24hPct ?? null, liquidityUsd: dex?.liquidityUsd ?? null,
    pairAddress: dex?.pairAddress ?? null, dexId: dex?.dexId ?? null,
    asOf: dex ? new Date(now()).toISOString() : null, lastRefreshedAt: null,
    sourceLabel: label,
    confidence: price != null ? 'medium' : answered.length ? 'low' : 'unknown',
    quoteReason: providers?.dexscreener ? (dex ? 'no_dex_quote_observed' : 'no_dex_pair_found') : 'chain_not_supported',
    sources,
  })
}

// App range + interval → the GeckoTerminal app timeframe, using the SAME
// auto-selection rule as the CMC chart plan so ranges stay comparable.
function gtTimeframe(range: string, interval = 'auto'): string {
  if (interval !== 'auto') return interval
  return (CHART_WINDOWS[range] || CHART_WINDOWS['7D']) <= 7 * 86400000 ? '1H' : '1D'
}

/**
 * Pool OHLCV for a contract identity — the only genuine price history an
 * unlisted token has. Uses the observed best pair when the identity already
 * carries one, so the common path is a single provider call.
 */
// deno-lint-ignore no-explicit-any
export async function contractCandles(asset: any, range: string, interval = 'auto', ctx: DegenCtx = {}, deps: ContractAssetDeps = {}) {
  const chain = String(asset?.contract?.chain || asset?.primary_chain || '')
  const address = String(asset?.contract?.address || '')
  const empty = (reason: string) => ({ candles: [] as { t: number; c: number }[], bestPair: null, bestProvider: null, sourceState: 'unavailable', sourceReason: reason })
  if (!chain || !address || !CHAIN_PROVIDERS[chain]?.geckoterminal) return empty('chain_not_supported')
  const degenCtx: DegenCtx = { ...ctx, supabase: ctx.supabase, jobName: ctx.jobName ?? 'intel-markets', caller: 'contract-chart', kind: 'request', chain, tokenAddress: address, maxCalls: 2 }
  try {
    let pool = asset?.contract?.pairAddress ? String(asset.contract.pairAddress) : ''
    if (!pool) {
      const pools = await (deps.tokenPools || getTokenPools)(chain, address, degenCtx)
      pool = pools?.[0]?.address || ''
    }
    if (!pool) return empty('no_pool_found')
    const timeframe = gtTimeframe(range, interval)
    const rows = await (deps.ohlcv || getOhlcv)(chain, pool, timeframe, degenCtx)
    const end = (deps.now || (() => Date.now()))(), start = end - (CHART_WINDOWS[range] || CHART_WINDOWS['7D'])
    const candles = (rows || []).filter((c) => c.t >= start && c.t <= end)
    if (!candles.length) return { ...empty('no_completed_candles'), bestPair: pool }
    return { candles, bestPair: pool, bestProvider: 'geckoterminal', sourceState: 'available', sourceReason: null, timestampMeaning: 'open', currency: 'USD', volumeUnit: 'quote (USD)' }
  } catch { return empty('provider_unavailable') }
}
