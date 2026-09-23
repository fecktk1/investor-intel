// Investor Intel public demo: the asset page's market reads from STORED data only.
//
// intel-markets answers a member's asset page (detail, chart candles, the quote
// poll and the price history) through a ladder that may ask CoinMarketCap, the
// public exchange registry, CoinGecko or Birdeye live. The public demo must never
// do that, so this module assembles the SAME response bodies with every
// provider-facing step replaced by its stored or cache-only form:
//
//   identity + quote  market_assets (the catalogue lanes' rows); a CoinMarketCap
//                     quote and metadata from the shared response cache through
//                     requestCmc with kind 'render', maxCalls 0 and noDemand (it
//                     cannot reach the provider and stamps no demand); for a
//                     tokenised real-world asset token that only the RWA lanes
//                     capture, the newest captured wrapper or coverage row. The
//                     NEWEST of these answers (demoQuoteRead), and the price is
//                     then taken from the stored quote tape (intel_quote_tape,
//                     filled every minute from the CoinMarketCap observations)
//                     when the tape holds a later price than all of them.
//   chart candles     STORED PRICES FIRST (stored-candles.ts): intraday candles
//                     built from the CoinMarketCap quotes the observation lanes
//                     store (or the CoinGecko catalogue snapshots), the RWA wrapper
//                     and coverage captures, and daily rows from the candle
//                     archive and the wrapper OHLCV backfill, at the finest width
//                     the stored spacing supports. Only when nothing is stored for
//                     the window: the exchange registry's response cache
//                     (cacheOnly), the CoinMarketCap OHLCV cache (render) and the
//                     stored daily archive at one day, said plainly.
//   history           the CoinMarketCap history cache (render), then the same
//                     stored prices (intraday buckets, or daily rows).
//   enrichment        the stored narrative, catalyst and unlock reads, and the
//                     Birdeye cache only (allowLive false).
//
// Nothing here writes a row a visitor owns, resolves a user or an org, or calls
// AI. The only rows the cache passes add are the transports' own zero-call
// accounting lines (provider_call_logs / exchange_api_usage_logs, calls 0).
//
// The assembly below mirrors intel-markets/index.ts marketDetail line for line
// where it can; the member path is not touched and is not imported from, so a
// member's read and its provider ladder stay exactly as they were.

import { matchCexEnrichment } from '../market-assets/cex-match.ts'
import { requestCmc } from '../market-assets/cmc-transport.ts'
import { marketCanonicalIdentity, marketIdentityChoices, verifiedNativeMarketSymbol, hasVerifiedCexIdentity, usableSpread, marketChain } from './market-read-quality.ts'
import { resolveMarketAsset } from './market-asset-resolver.ts'
import { resolveCmcAsset } from './cmc-asset-identity.ts'
import { assetMarketRead, marketCmcIdentity } from './market-asset-source.ts'
import { loadAssetHistory, historyPlan, unavailableHistory } from './asset-history.ts'
import { realizedVolatility, maxDrawdown, distanceFromHigh, timeUnderWaterDays } from './risk-metrics.ts'
import { marketCoverage, type MarketIdentityKind } from './market-coverage.ts'
import { positionDepthQuotes } from './position-depth.ts'
import { loadCmcChart, CHART_WINDOWS, CHART_INTERVALS } from './cmc-chart.ts'
import { loadMarketCandles } from './market-candle-read.ts'
import { MAX_LOOKBACK_BARS } from './chart-analysis.ts'
import { loadExchangeCandles } from './exchange-candles.ts'
import { archiveSeries } from './candle-archive.ts'
import { CANDLE_RANGE_MS } from './candle-ladder.ts'
import { chartSeriesResponse } from './chart-series-contract.ts'
import { loadStoredCandles, storedIdentity, storedRpc, dailyRows, intradayBars } from './stored-candles.ts'
import { quoteProvenance, chartProvenance, venueProvenance, curatedNewsWithEnvelopes, CATALOGUE_REFRESH_SECONDS } from './market-provenance.ts'
import { storedReceipt, receiptFreshness, type SourceReceipt } from './source-receipt.ts'
import { figureEnvelope, figureScope, type FigureEnvelope } from './market-figure-scope.ts'
import { readMetricAgreement } from './metric-agreement-read.ts'
import { metricAgreementReceipt } from './metric-agreement.ts'
import { assembleEcosystemNarrativeState, assembleCatalystNewsState, assemblePublicOnchainState, assembleTokenUnlockState } from './market-enrichment.ts'
import { getProvider } from '../exchange-market/provider-registry.ts'
import { getChain } from '../chains.ts'

// deno-lint-ignore no-explicit-any
type Db = any
// deno-lint-ignore no-explicit-any
type Any = any

export const DEMO_READ_CALLER = 'intel-demo-read'

/** A body and its HTTP status, exactly as intel-markets would send it. */
export interface DemoReadAnswer { status: number; body: Any }

/** requestCmc that can only read the shared cache: kind 'render' returns the
 * stored record (or an empty 'refresh_required' answer) and never reaches the
 * provider; maxCalls 0 and noDemand make sure of it; no user and no org ride. */
// deno-lint-ignore no-explicit-any
export const cacheOnlyCmc: typeof requestCmc = ((name: string, input: Record<string, unknown> = {}, ctx: any = {}) =>
  requestCmc(name, input, { ...ctx, kind: 'render', maxCalls: 0, _calls: 0, noDemand: true, waitForFresh: false, selectedDemand: false, orgId: null, userId: null, caller: DEMO_READ_CALLER })) as typeof requestCmc

/** The exchange registry's providers with every kline read held to the cache. */
// deno-lint-ignore no-explicit-any
export function cacheOnlyVenue(id: any): Any {
  const provider = getProvider(id)
  if (!provider) return null
  // deno-lint-ignore no-explicit-any
  return { ...provider, getKlines: (symbol: string, interval: string, limit: number, ctx?: any) => provider.getKlines(symbol, interval, limit, ctx, { cacheOnly: true }) }
}

const lookbackBars = (value: unknown): number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_LOOKBACK_BARS ? value as number : 0

/** The CMC identity resolver, cache-only. */
// deno-lint-ignore no-explicit-any
const cacheOnlyResolveCmc = (admin: Db, id: string) => resolveCmcAsset(admin, id, cacheOnlyCmc, { supabase: admin } as any)

/**
 * A tokenised real-world asset token that only the RWA lanes capture has no
 * market_assets row and, usually, no cached CoinMarketCap quote. Its newest
 * captured row (hourly wrapper lane, else daily coverage lane) is read as the
 * quote instead: the same CoinMarketCap figures the lane stored, dated.
 */
export async function rwaTokenRow(db: Db, cryptoId: string): Promise<Any | null> {
  if (!/^[1-9][0-9]{0,9}$/.test(cryptoId)) return null
  const pick = async (table: string, columns: string, order: string) => {
    try {
      const { data, error } = await db.from(table).select(columns).eq('crypto_id', cryptoId).order(order, { ascending: false }).limit(1)
      return error || !Array.isArray(data) ? null : data[0] || null
    } catch { return null }
  }
  const wrapper = await pick('intel_rwa_wrapper_tokens', 'crypto_id,symbol,name,price,market_cap,volume_24h,captured_at,fetched_at', 'captured_at')
  const coverage = wrapper ? null : await pick('intel_rwa_coverage_tokens', 'crypto_id,symbol,name,price,market_cap,volume_24h,captured_at,fetched_at', 'captured_at')
  const row = wrapper || coverage
  if (!row) return null
  const num = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
  const symbol = String(row.symbol || '').toUpperCase() || null
  return {
    source_provider: 'coinmarketcap', provider_id: cryptoId, provider_slug: null,
    name: row.name ?? null, symbol, normalized_symbol: symbol, primary_chain: null, platforms: null,
    current_price: num(row.price), market_cap: num(row.market_cap), volume_24h: num(row.volume_24h),
    market_cap_rank: null, fdv: null, circulating_supply: null, total_supply: null, max_supply: null,
    change_1h_pct: null, change_24h_pct: null, change_7d_pct: null, image_url: null, categories: null,
    as_of: row.captured_at ?? null, last_refreshed_at: row.fetched_at ?? row.captured_at ?? null,
    source_label: wrapper ? 'CoinMarketCap (RWA wrapper capture)' : 'CoinMarketCap (RWA coverage capture)',
    attribution_label: 'Data via CoinMarketCap',
  }
}

/** One asset, resolved exactly as intel-markets resolves it, with the CMC step
 * cache-only and the RWA-lane row as the last resort for a CMC id. */
export async function resolveDemoAsset(db: Db, symbol: string, sourceProvider?: string, providerId?: string): Promise<{ data: Any | null; error: unknown; ambiguous: boolean }> {
  const resolved = await resolveMarketAsset(db, symbol, sourceProvider, providerId, cacheOnlyResolveCmc as Any)
  if (resolved.data || resolved.ambiguous || !(sourceProvider === 'coinmarketcap' && providerId)) return resolved
  const row = await rwaTokenRow(db, providerId)
  return row ? { data: row, error: null, ambiguous: false } : resolved
}

// deno-lint-ignore no-explicit-any
function detailIdentity(asset: any, quoteChain: string | null): { kind: MarketIdentityKind; provider: string | null; providerId: string | null; chain: string | null; address: string | null } {
  const provider = asset?.source_provider ? String(asset.source_provider) : null
  const kind: MarketIdentityKind = provider === 'contract' ? 'contract' : provider === 'coinmarketcap' ? 'cmc' : 'coingecko'
  const chain = asset?.contract?.chain ? String(asset.contract.chain) : quoteChain || asset?.primary_chain || null
  let address: string | null = asset?.contract?.address ? String(asset.contract.address) : null
  if (!address) {
    const entries = Object.entries(asset?.platforms || {}).filter(([platform, value]) => typeof value === 'string' && value && (!chain || marketChain(platform) === chain))
    if (entries.length === 1) address = String(entries[0][1])
  }
  return { kind, provider, providerId: asset?.provider_id != null ? String(asset.provider_id) : null, chain, address }
}

const DAY = 86_400_000

/** The stored daily archive for the requested window, when nothing warmer
 * answered. The width is one day whatever was asked, and the sentence says so. */
async function archiveWindow(db: Db, assetKey: string | null, range: string, requested: string, now: number, ladder: Any): Promise<Any | null> {
  if (!assetKey) return null
  const span = Math.max(CANDLE_RANGE_MS[range] || 7 * DAY, DAY)
  const read = await archiveSeries(db, assetKey, '1D', now - span, now).catch(() => null)
  const bars = read?.bars || []
  if (!bars.length) return null
  const coverage = `${bars.length} stored daily candles from the archive. The demo reads stored data only and never asks a live source, so this window is shown at one day${requested !== '1D' ? ` rather than ${requested}` : ''}. Archived volume is USD for every period.`
  return {
    candles: bars, source: 'archive', bestProvider: 'archive', bestPair: null, barIntervalMs: DAY, timestampMeaning: 'open',
    volumeUnit: 'USD', coverage, sourceState: 'stale', sourceReason: null, provenance: [],
    ladder: { ...(ladder || {}), range, source: 'archive', interval: '1D', requestedInterval: requested, substituted: requested !== '1D', archivedCandles: bars.length, archiveEndsAt: new Date(bars[bars.length - 1].t).toISOString() },
  }
}

/** Candles for one asset from stored data only (see the header). */
export async function demoAssetCandles(db: Db, canonical: Any, verifiedInput: boolean | (() => Promise<boolean>), timeframe: string, interval = 'auto', lookback = 0, now = Date.now()): Promise<Any> {
  // Stored prices first: the same window every visit, labelled with where each
  // candle came from. A failed stored read falls through to the caches below.
  const stored = await loadStoredCandles(db, storedIdentity(canonical), timeframe, interval, now, lookback).catch((e) => {
    console.error('intel_demo_stored_candles_failed', String((e as Error)?.message || e).slice(0, 160))
    return null
  })
  if (Array.isArray(stored?.candles) && stored.candles.length) return stored
  // Only now is the exchange identity needed (the cached exchange rung below).
  const verified = typeof verifiedInput === 'function' ? await verifiedInput().catch(() => false) : verifiedInput
  const identityKey = marketCanonicalIdentity(canonical).canonicalAssetKey || (canonical?.source_provider && canonical?.provider_id != null ? `market:${canonical.source_provider}:${canonical.provider_id}` : null)
  const chart: Any = await loadMarketCandles({
    assetKey: identityKey,
    symbol: canonical?.normalized_symbol ? String(canonical.normalized_symbol) : null,
    cexVerified: verified,
    cmcId: marketCmcIdentity(canonical),
    klineIdentity: false,
    coingeckoId: false,
  }, timeframe, interval, now, {
    exchange: (range, width, lb) => loadExchangeCandles(db, String(canonical?.normalized_symbol || ''), range, width, now, { provider: cacheOnlyVenue }, lb),
    cmc: (id, range, width, lb) => loadCmcChart(db, id, range, width, now, cacheOnlyCmc, {}, lb),
    archive: (assetKey, width, from, to) => archiveSeries(db, assetKey, width, from, to),
  }, lookback)
  if (Array.isArray(chart?.candles) && chart.candles.length) return chart
  const requested = String(chart?.ladder?.requestedInterval || interval)
  // Nothing warmer held the window: the archive answers it at one day, first
  // under the canonical key and then under the plain market key.
  const marketKey = canonical?.source_provider && canonical?.provider_id != null ? `market:${canonical.source_provider}:${canonical.provider_id}` : null
  for (const key of [...new Set([identityKey, marketKey].filter(Boolean))]) {
    const stored = await archiveWindow(db, key as string, timeframe, requested, now, chart?.ladder)
    if (stored) return stored
  }
  return {
    ...chart,
    coverage: [chart?.coverage, 'The demo reads stored data only and never asks a live source; no stored candles hold this window.'].filter(Boolean).join(' '),
  }
}

/** Candles run through the same response contract intel-markets applies. No
 * chart capture proof is issued in the demo. */
function withSeries(body: Any): Any {
  if (!Array.isArray(body?.candles)) return body
  const series = chartSeriesResponse({ ...body, source: body.source || body.bestProvider })
  return { ...body, candles: series.candles, chartSource: series.source }
}

// deno-lint-ignore no-explicit-any
async function latestDexSnapshotForPlatforms(db: Db, platforms: Record<string, unknown> | null): Promise<Record<string, unknown> | null> {
  if (!platforms) return null
  for (const [platform, address] of Object.entries(platforms)) {
    const addr = String(address || '').trim()
    if (!addr) continue
    const appChain = marketChain(platform)
    const candidates = getChain(appChain)?.evmChainId != null ? [...new Set([addr, addr.toLowerCase()])] : [addr]
    for (const tokenAddress of candidates) {
      try {
        const { data } = await db.from('dex_pair_snapshots')
          .select('chain, token_address, pair_address, price_usd, liquidity_usd, volume_24h, market_cap, fdv, source_ref, fetched_at, stale_after')
          .eq('chain', appChain).eq('token_address', tokenAddress).order('fetched_at', { ascending: false }).limit(1).maybeSingle()
        if (data) return data
      } catch { return null }
    }
  }
  return null
}

function dexEnrichment(row: Record<string, unknown>, chain: string): Record<string, unknown> {
  return {
    liquidityUsd: row.liquidity_usd ?? null, volume24hUsd: row.volume_24h ?? row.volume_24h_usd ?? null, priceUsd: row.price_usd ?? null,
    marketCap: row.market_cap ?? null, fdv: row.fdv ?? null, pairAddress: row.pair_address ?? null, sourceUrl: row.source_ref ?? null,
    fetchedAt: row.fetched_at ?? null, staleAfter: row.stale_after ?? null, chain,
  }
}

// A stored quote is 'fresh' for fifteen minutes: the observation lanes store a
// price every two to five minutes for assets in use and the tape copies them
// every minute, so a price a few minutes old is the newest one we hold, and
// calling it stale would say something untrue about it.
const FRESH_MS = 15 * 60_000, STALE_MS = 60 * 60_000
function freshness(asOf: string | null, now = Date.now()): 'fresh' | 'stale' | 'degraded' | 'unavailable' {
  if (!asOf) return 'unavailable'
  const age = now - new Date(asOf).getTime()
  if (!Number.isFinite(age)) return 'unavailable'
  if (age <= FRESH_MS) return 'fresh'
  if (age <= STALE_MS) return 'stale'
  return 'degraded'
}

/** How often the quote tape can hold a newer price: the observation lanes store
 * one every two to five minutes and the tape copies them every minute. Ten
 * minutes, so a receipt inside one and a half cadences is 'cached', not 'stale'. */
export const QUOTE_TAPE_REFRESH_SECONDS = 600

export interface TapePoint { price: number; observedAt: string }

/** The newest stored price on the quote tape for one CoinMarketCap id, or null.
 * One index-only read of the tape's primary key; never a provider. */
export async function readQuoteTape(db: Db, cmcId: string | null, now = Date.now()): Promise<TapePoint | null> {
  if (!cmcId || !/^[1-9][0-9]{0,11}$/.test(cmcId)) return null
  try {
    const { data, error } = await db.from('intel_quote_tape').select('price,observed_at')
      .eq('subject', `market:coinmarketcap:${cmcId}`).order('observed_at', { ascending: false }).limit(1)
    if (error || !Array.isArray(data) || !data[0]) return null
    const price = Number(data[0].price), at = Date.parse(String(data[0].observed_at ?? ''))
    if (!(price > 0) || !Number.isFinite(price) || !Number.isFinite(at) || at > now + 60_000) return null
    return { price, observedAt: new Date(at).toISOString() }
  } catch { return null }
}

const timeOf = (value: unknown): number => { const t = Date.parse(String(value ?? '')); return Number.isFinite(t) ? t : -Infinity }

/** How often each stored catalogue can hold a newer quote. The CoinMarketCap
 * rows are rewritten from the same observations the tape copies (every two to
 * five minutes for assets in use), the CoinGecko catalogue every 30 minutes. */
const STORED_QUOTE_REFRESH: Record<string, number> = { coinmarketcap: QUOTE_TAPE_REFRESH_SECONDS, coingecko: 1800 }

/** The store a resolved row came from: the catalogue, or one of the two RWA
 * capture tables rwaTokenRow reads (six-hourly and daily). */
function storedQuoteSource(asset: Any, provider: string): { capability: string; refreshSeconds: number } {
  const label = String(asset?.source_label || '')
  if (/RWA wrapper capture/.test(label)) return { capability: 'intel_rwa_wrapper_tokens', refreshSeconds: 21_600 }
  if (/RWA coverage capture/.test(label)) return { capability: 'intel_rwa_coverage_tokens', refreshSeconds: 86_400 }
  return { capability: 'market_assets', refreshSeconds: STORED_QUOTE_REFRESH[provider] ?? CATALOGUE_REFRESH_SECONDS }
}

/** Receipt and envelopes for a quote a stored row answered, judged against that
 * store's own refresh, so a price minutes old reads 'cached', never 'stale'. */
function storedQuoteRead(quote: Any, asset: Any, now: number): { receipts: SourceReceipt[]; figureProvenance: Record<string, FigureEnvelope> } {
  const provider = String(quote?.quoteProvider || 'unknown')
  const fetchedAt = quote?.provenance?.fetchedAt ?? quote?.asOf ?? null
  const source = storedQuoteSource(asset, provider)
  const receipt = storedReceipt({
    provider, capability: source.capability, origin: 'stored', fetchedAt, refreshSeconds: source.refreshSeconds,
    state: quote?.sourceFreshness === 'unavailable' || !quote?.asOf ? 'unavailable' : null,
  }, now)
  const freshness = receiptFreshness(receipt, now)
  const envelope = (scope: string) => figureEnvelope('stored', provider, fetchedAt, freshness, figureScope(scope))
  return { receipts: [receipt], figureProvenance: { price: envelope('price'), price_change: envelope('price_change'), market_cap: envelope('market_cap'), volume_24h: envelope('volume_24h') } }
}

export interface DemoQuoteRead {
  quote: Any
  receipts: SourceReceipt[]
  figureProvenance: Record<string, FigureEnvelope>
  /** Which store answered the price: 'quote_tape', 'catalogue' or 'cache'. */
  priceSource: 'quote_tape' | 'catalogue' | 'cache' | null
  /** When the price came from the tape: the time of the other figures (the 24h
   * change, volume and market cap), which the tape does not hold. Else null. */
  figuresAsOf: string | null
}

/**
 * The demo quote: the NEWEST stored answer, never an older one because of the
 * order of a ladder. intel-markets prefers the shared CoinMarketCap cache to the
 * catalogue row, which is right for a member whose read refreshes that cache;
 * the demo never refreshes it, so the cache can sit hours behind the catalogue
 * row the observation lane rewrote minutes ago. Then, when the quote tape holds
 * a later price than that answer, the price and its time come from the tape and
 * every other figure keeps its own time, said in `figuresAsOf`. Pure.
 */
export function demoQuoteRead(asset: Any, cmc: Any, cmcReceipts: unknown[], tape: TapePoint | null, now = Date.now()): DemoQuoteRead {
  const cached = assetMarketRead(asset, cmc)
  const row = cmc ? assetMarketRead(asset, null) : cached
  const rowNewer = row !== cached && timeOf(row.asOf) > timeOf(cached.asOf)
  const base = rowNewer ? row : cached
  const answeredByCache = !rowNewer && !!cmc && cached.price != null && cached.price === cmc?.current_price && String(cmc?.provider_id) === String(cached.quoteProviderId)
  // The shared cache's own receipts describe a cache answer; a catalogue answer
  // gets a receipt for the stored row it came from.
  const baseRead = answeredByCache ? quoteProvenance(base, Array.isArray(cmcReceipts) ? cmcReceipts : [], now) : storedQuoteRead(base, asset, now)
  const baseSource = answeredByCache ? 'cache' : base.price != null ? 'catalogue' : null
  if (!tape || !(timeOf(tape.observedAt) > timeOf(base.asOf))) {
    return { quote: { ...base, sourceFreshness: base.sourceFreshness || freshness(base.asOf, now) }, receipts: baseRead.receipts, figureProvenance: baseRead.figureProvenance, priceSource: baseSource, figuresAsOf: null }
  }
  const receipt = storedReceipt({ provider: 'coinmarketcap', capability: 'intel_quote_tape', origin: 'stored', fetchedAt: tape.observedAt, capturedAt: tape.observedAt, refreshSeconds: QUOTE_TAPE_REFRESH_SECONDS }, now)
  const quote = {
    ...base,
    price: tape.price, asOf: tape.observedAt, quoteProvider: 'coinmarketcap',
    provenance: { provider: 'coinmarketcap', observedAt: tape.observedAt, fetchedAt: tape.observedAt, store: 'intel_quote_tape' },
    sourceFreshness: freshness(tape.observedAt, now),
  }
  return {
    quote,
    receipts: [receipt],
    figureProvenance: { ...baseRead.figureProvenance, price: figureEnvelope('stored', 'coinmarketcap', tape.observedAt, receiptFreshness(receipt, now), figureScope('price')) },
    priceSource: 'quote_tape',
    figuresAsOf: base.asOf ?? null,
  }
}

export interface DemoDetailInput {
  symbol: string
  sourceProvider?: string
  providerId?: string
  timeframe?: string
  interval?: string
  lookbackBars?: number
  candlesOnly?: boolean
  quotesOnly?: boolean
}

/**
 * The asset page's detail read (and its candlesOnly and quotesOnly forms), from
 * stored data only. Same statuses and body shape as intel-markets marketDetail.
 * The caller has already checked that the identity is tracked.
 */
export async function demoMarketDetail(db: Db, input: DemoDetailInput, resolvedAsset?: Any): Promise<DemoReadAnswer> {
  const timeframe = input.timeframe || '7D'
  const interval = input.interval || 'auto'
  const lookback = lookbackBars(input.lookbackBars)
  if (!CHART_WINDOWS[timeframe] || (interval !== 'auto' && !CHART_INTERVALS[interval])) return { status: 400, body: { error: 'invalid_chart_range' } }
  let sym = String(input.symbol || '').toUpperCase().replace(/^\$/, '')
  const resolved = resolvedAsset ? { data: resolvedAsset, error: null, ambiguous: false } : await resolveDemoAsset(db, sym, input.sourceProvider, input.providerId)
  if (resolved.ambiguous) return { status: 409, body: { error: 'ambiguous_asset', symbol: sym } }
  if (resolved.error) return { status: 503, body: { error: 'identity_unavailable' } }
  if (!resolved.data) return { status: 404, body: { error: 'asset_not_found', symbol: sym } }
  const cmcId = marketCmcIdentity(resolved.data)
  // The quote: the shared CoinMarketCap cache and the stored quote tape. Started
  // here and awaited only where its answer is needed, so the full read below
  // runs every read that does not depend on it at the same time (the detail read
  // was about ten database round trips one after another; under load that was
  // the 9 to 15 seconds a visitor watched "Loading asset observations").
  const quoteP = (async () => {
    const [cmc, tape] = cmcId && !input.candlesOnly
      ? await Promise.all([cacheOnlyResolveCmc(db, cmcId), readQuoteTape(db, cmcId)])
      : [null, null]
    const read = demoQuoteRead(resolved.data, cmc?.data, cmc?.receipts || [], tape)
    // A cache read that answered nothing is no reason when a stored price did.
    const quoteReason = read.priceSource === 'quote_tape' || read.priceSource === 'catalogue' ? null : cmc?.error || resolved.data.quote_reason || null
    return { read, quoteReason }
  })()
  if (input.quotesOnly) {
    const { read, quoteReason } = await quoteP
    return { status: 200, body: { ...read.quote, sourceProvider: resolved.data.source_provider, providerId: resolved.data.provider_id, quoteReason, quoteReceipts: read.receipts, quoteProvenance: read.figureProvenance, priceSource: read.priceSource, figuresAsOf: read.figuresAsOf } }
  }
  sym = String(resolved.data.normalized_symbol || resolved.data.symbol || sym).toUpperCase()
  const verifiedIdentity = async (): Promise<boolean> => {
    const [identityProfile, identityMapping, claimants] = await Promise.all([
      db.from('exchange_latest_asset_profiles').select('*').eq('normalized_symbol', sym).maybeSingle(),
      db.from('exchange_asset_mappings').select('*').eq('normalized_symbol', sym).eq('is_active', true).maybeSingle(),
      db.from('market_assets').select('provider_id', { count: 'exact', head: true }).eq('normalized_symbol', sym),
    ])
    const identityMatch = matchCexEnrichment({ normalizedSymbol: sym, providerId: resolved.data.provider_id, platforms: resolved.data.platforms }, { profileBySym: new Map(identityProfile.data ? [[sym, identityProfile.data]] : []), mappingBySym: new Map(identityMapping.data ? [[sym, identityMapping.data]] : []), symbolCounts: new Map([[sym, claimants.count ?? 2]]) })
    return hasVerifiedCexIdentity(resolved.data, identityMapping.data) && (identityMatch.confidence === 'high' || !!verifiedNativeMarketSymbol(resolved.data))
  }
  if (input.candlesOnly) {
    // Candles only: the exchange identity is read only if stored prices hold nothing.
    const c = await demoAssetCandles(db, resolved.data, verifiedIdentity, timeframe, interval, lookback)
    return { status: 200, body: withSeries({ ...c, timeframe, lookbackBars: lookback, chartAsset: marketCanonicalIdentity(resolved.data).canonicalAssetKey || `market:${resolved.data.source_provider}:${resolved.data.provider_id}` }) }
  }
  // Everything the full read needs, started together. The exchange identity
  // check, the nine exchange reads, the candles, the DEX snapshot, the four
  // enrichment assemblies and the metric agreement depend on the resolved asset
  // only (the enrichments also on the quote's chain), never on each other, so
  // none of them waits for another. The same reads as before, and the same body.
  const canonical = resolved.data
  const verifiedP = verifiedIdentity()
  const canonicalPlatforms = canonical?.platforms && typeof canonical.platforms === 'object' ? canonical.platforms as Record<string, unknown> : null
  const dexP = latestDexSnapshotForPlatforms(db, canonicalPlatforms)
  const chartP = demoAssetCandles(db, canonical, () => verifiedP, timeframe, interval, lookback)
  const enrichP = Promise.all([quoteP, dexP]).then(([{ read }, dexSnapshot]) => {
    const ecoChain = read.quote.chain
    const onchainChain = String(dexSnapshot?.chain || ecoChain || '').toLowerCase() || null
    const onchainAddress = dexSnapshot?.token_address ? String(dexSnapshot.token_address) : canonical?.contract?.address ? String(canonical.contract.address) : null
    return Promise.all([
      assembleEcosystemNarrativeState(db, { chain: ecoChain, symbol: sym }),
      assembleCatalystNewsState(db, { symbol: sym, chain: ecoChain }),
      // The Birdeye cache only: allowLive false never makes the budgeted live call.
      assemblePublicOnchainState({
        chain: onchainChain, tokenAddress: onchainAddress, allowLive: false, nowIso: new Date().toISOString(),
        birdeyeCtx: { supabase: db, jobName: DEMO_READ_CALLER, caller: DEMO_READ_CALLER, kind: 'render' } as Any,
      }),
      assembleTokenUnlockState(db, { symbol: sym, nowMs: Date.now(), allowLive: false }),
    ])
  })
  // Additive: an unreadable agreement is no agreement, never a failed read.
  const metricP = cmcId
    ? readMetricAgreement(db, `market:coinmarketcap:${cmcId}`, Date.now()).then(metricAgreementReceipt).catch(() => null)
    : Promise.resolve(null)
  const readsP = Promise.all([
    db.from('exchange_latest_asset_profiles').select('*').eq('normalized_symbol', sym).maybeSingle(),
    db.from('exchange_latest_market_signals').select('*').eq('normalized_symbol', sym).maybeSingle(),
    db.from('exchange_latest_market_caps').select('*').eq('normalized_symbol', sym).maybeSingle(),
    db.from('exchange_latest_cross_market_spreads').select('*').eq('normalized_symbol', sym).maybeSingle(),
    db.from('exchange_market_rollups').select('*').eq('normalized_symbol', sym),
    db.from('exchange_latest_tickers').select('*').eq('normalized_symbol', sym),
    db.from('exchange_latest_provider_market_signals').select('provider, direction, strength, confidence, signal_type, factors, raw_metrics, as_of').eq('normalized_symbol', sym).order('as_of', { ascending: false }).limit(24),
    db.from('exchange_latest_orderbook').select('*').eq('normalized_symbol', sym).order('as_of', { ascending: false }).limit(8),
    db.from('exchange_market_memory').select('summary, why_it_matters, memory_type, as_of').eq('normalized_symbol', sym).eq('is_active', true).order('as_of', { ascending: false }).limit(1),
  ])
  const [cexVerified, [profR, sigR, capR, sprR, rollR, tickR, provSigR, bookR, memR], { read, quoteReason }, chart, dexSnapshot, [ecosystemNarratives, catalystRead, onchain, unlocks], metricAgreement] =
    await Promise.all([verifiedP, readsP, quoteP, chartP, dexP, enrichP, metricP])
  const quote = read.quote
  const quoteRead = { receipts: read.receipts, figureProvenance: read.figureProvenance }
  const priceRead = { priceSource: read.priceSource, figuresAsOf: read.figuresAsOf }
  if (!cexVerified) { for (const result of [profR, sigR, capR, sprR]) result.data = null; for (const result of [rollR, tickR, provSigR, bookR, memR]) result.data = [] }

  const provSig = new Map<string, Any>()
  for (const s of (provSigR.data || [])) if (!provSig.has(s.provider)) provSig.set(s.provider, s)
  const tickByProv = new Map<string, Any>((tickR.data || []).map((t: Any) => [t.provider, t]))
  const bookByProv = new Map<string, Any>((bookR.data || []).map((b: Any) => [b.provider, b]))
  const providers = [...new Set([...(tickR.data || []).map((t: Any) => t.provider), ...provSig.keys()])].map((p) => {
    const t = tickByProv.get(p); const s = provSig.get(p); const b = bookByProv.get(p)
    return { provider: p, providerSymbol: t?.provider_symbol ?? b?.provider_symbol ?? null, price: t?.price ?? null, change24h: t?.price_change_pct_24h ?? null, volume24h: t?.volume_quote_24h ?? null, spreadPct: t?.spread_pct ?? b?.spread_pct ?? null, direction: s?.direction ?? null, strength: s?.strength ?? null, confidence: s?.confidence ?? null, factors: s?.factors || [], orderbook: b ? { depthLevel: b.depth_level, bidDepthUsd: b.bid_depth_usd, askDepthUsd: b.ask_depth_usd, imbalancePct: b.imbalance_pct, bidPrice: b.bid_price, askPrice: b.ask_price, asOf: b.as_of } : null }
  }).sort((a, b) => (b.volume24h || 0) - (a.volume24h || 0))

  const orderbookRows = [...(bookR.data || [])].sort((a: Any, b: Any) => ((b.bid_depth_usd || 0) + (b.ask_depth_usd || 0)) - ((a.bid_depth_usd || 0) + (a.ask_depth_usd || 0)))
  const orderbook = orderbookRows.length ? {
    providerCount: orderbookRows.length,
    totalBidDepthUsd: orderbookRows.reduce((s: number, r: Any) => s + (Number(r.bid_depth_usd) || 0), 0),
    totalAskDepthUsd: orderbookRows.reduce((s: number, r: Any) => s + (Number(r.ask_depth_usd) || 0), 0),
    bestDepthProvider: orderbookRows[0]?.provider || null,
    minSpreadPct: orderbookRows.map((r: Any) => Number(r.spread_pct)).filter((x: number) => Number.isFinite(x)).sort((a: number, b: number) => a - b)[0] ?? null,
    asOf: orderbookRows.reduce((m: string, r: Any) => r.as_of && r.as_of > m ? r.as_of : m, ''),
    providers: orderbookRows.map((r: Any) => ({ provider: r.provider, providerSymbol: r.provider_symbol, depthLevel: r.depth_level, bidPrice: r.bid_price, askPrice: r.ask_price, bidDepthUsd: r.bid_depth_usd, askDepthUsd: r.ask_depth_usd, imbalancePct: r.imbalance_pct, spreadPct: r.spread_pct, asOf: r.as_of })),
  } : null

  const rollups: Record<string, Any> = {}
  for (const r of (rollR.data || [])) rollups[r.timeframe] = r
  const { candles, bestPair, bestProvider } = chart
  const prof = profR.data, sig = sigR.data
  const dex = dexSnapshot ? dexEnrichment(dexSnapshot, String(dexSnapshot.chain || '')) : null

  const catalysts = { ...catalystRead, curated_news: curatedNewsWithEnvelopes(catalystRead.curated_news) }

  const payload: Any = {
    detail: true, symbol: sym, ...quote,
    providerId: canonical?.provider_id ?? null, sourceProvider: canonical?.source_provider ?? null, primaryChain: canonical?.primary_chain ?? null,
    signal: sig ? { direction: sig.direction, strength: sig.strength, confidence: sig.confidence, signalType: sig.signal_type, title: sig.title, summary: sig.summary, whyItMatters: sig.why_it_matters, factors: sig.factors || [], confirmingProviders: sig.confirming_providers || [], conflictingProviders: sig.conflicting_providers || [], providerCount: sig.provider_count } : null,
    profile: prof ? { liquidityScore: prof.liquidity_score, retailRelevanceScore: prof.retail_relevance_score, marketQualityScore: prof.market_quality_score, trendScore: prof.trend_score, bestGlobalPair: prof.best_global_pair, bestUsRetailPair: prof.best_us_retail_pair } : null,
    ...marketCanonicalIdentity(canonical),
    identityChoices: marketIdentityChoices(canonical),
    sourceFreshness: quote.sourceFreshness || freshness(quote.asOf), quoteReason, ...priceRead,
    cexCoverage: cexVerified && providers.length ? 'available' : 'unverified',
    depthQuotes: positionDepthQuotes(canonical, cexVerified, bookR.data || [], tickR.data || []),
    spread: cexVerified && usableSpread(sprR.data) ? sprR.data : null, orderbook, rollups, providers, dex,
    memorySummary: memR.data?.[0]?.summary || null,
    ecosystemNarratives, catalysts, onchain, unlocks,
    ...chart, chartAsset: marketCanonicalIdentity(canonical).canonicalAssetKey || `market:${canonical.source_provider}:${canonical.provider_id}`, candles, bestPair, bestProvider, chartCoverage: 'coverage' in chart ? chart.coverage : null,
    chartState: 'sourceState' in chart ? chart.sourceState : null,
    chartReason: 'sourceReason' in chart ? chart.sourceReason : null,
    chartProvenance: 'provenance' in chart ? chart.provenance : null,
    quoteSourceLabel: canonical?.source_label ? String(canonical.source_label) : null,
    quoteAttribution: canonical?.attribution_label ? String(canonical.attribution_label) : null,
  }
  const identity = detailIdentity(canonical, quote.chain)
  const chartRead = chartProvenance(chart)
  const figureProvenance = { ...quoteRead.figureProvenance, ...venueProvenance({ tickers: tickR.data || [], orderbookAsOf: orderbook?.asOf || null, dex }), chart: chartRead.envelope }
  return { status: 200, body: withSeries({ ...payload, identity, coverage: marketCoverage(payload, { identityKind: identity.kind, cmcId }), quoteReceipts: quoteRead.receipts, quoteProvenance: quoteRead.figureProvenance, chartReceipts: chartRead.receipts, figureProvenance, metricAgreement }) }
}

const NO_RISK_METRICS = { volatility30d: null, maxDrawdown: null, distanceFromHigh: null, timeUnderWaterDays: null }

/** The history figure's reason when neither the history cache nor the archive
 * holds the window: the demo shows stored data only. */
export const DEMO_STORED_ONLY = 'demo_stored_only'

/** A history range from STORED prices, when the CoinMarketCap history cache
 * holds nothing for it: 48 hours as 5-minute buckets, 7 and 30 days as hourly
 * buckets (each point the last stored price of its bucket, at that price's own
 * time), and 90 days or a year as daily rows (the archive close, else the
 * backfill close, else the day's last stored price). Nothing is fabricated: an
 * empty bucket is no point. Costs no credit, and says which store it read. */
export async function storedHistory(db: Db, asset: Any, range: string, now: number): Promise<Any | null> {
  const plan = historyPlan(range)
  if (!plan) return null
  const identity = storedIdentity(asset)
  if (!identity.cmcId && !identity.coingeckoId && !identity.archiveKeys.length) return null
  const rpc = storedRpc(db, identity)
  const provider = identity.cmcId ? 'CoinMarketCap' : 'CoinGecko'
  let points: Any[] = []
  let sourceKey = 'stored_quotes'
  if (plan.interval === 'daily') {
    const answer = await rpc('daily', { from: now - plan.count * DAY, to: now })
    const rows = dailyRows(answer?.days)
    points = rows.map((row) => ({ t: row.t, price: row.c, volume: row.kind === 'archive' ? row.v : null, marketCap: null }))
    sourceKey = 'stored_daily'
  } else {
    const step = plan.interval === '5m' ? 300_000 : 3_600_000
    const answer = await rpc('buckets', { from: Math.floor((now - plan.count * step) / step) * step, to: now, bucketSeconds: step / 1000 })
    const rows: Any[] = Array.isArray(answer?.bars) ? answer.bars : []
    const kept = new Set(intradayBars(rows, step).bars.map((bar) => bar.t))
    points = rows.filter((row) => Array.isArray(row) && kept.has(Number(row[0])))
      .map((row) => ({ t: Number(row[6]) || Number(row[0]), price: Number(row[4]), volume: null, marketCap: null }))
  }
  if (!points.length) return null
  const newest = points[points.length - 1].t
  return {
    points, interval: plan.interval,
    source: sourceKey === 'stored_daily' ? 'stored daily prices' : `stored ${provider} quotes`, sourceKey, sourceProvider: provider,
    observedAt: new Date(newest).toISOString(), fetchedAt: null,
    state: now - newest <= (plan.interval === 'daily' ? 3 * DAY : 3 * 3_600_000) ? 'fresh' : 'stale', reason: null, credits: 0,
  }
}

/** The price history figure: the CoinMarketCap history cache, then stored prices. */
export async function demoMarketHistory(db: Db, input: { symbol?: string; sourceProvider?: string; providerId?: string; range?: string }, resolvedAsset?: Any): Promise<DemoReadAnswer> {
  const range = input.range || '90d'
  if (!historyPlan(range)) return { status: 400, body: { error: 'invalid_history_range' } }
  const sym = String(input.symbol || '').toUpperCase().replace(/^\$/, '')
  const resolved = resolvedAsset ? { data: resolvedAsset, error: null, ambiguous: false } : await resolveDemoAsset(db, sym, input.sourceProvider, input.providerId)
  if (resolved.ambiguous) return { status: 409, body: { error: 'ambiguous_asset', symbol: sym } }
  if (resolved.error) return { status: 503, body: { error: 'identity_unavailable' } }
  if (!resolved.data) return { status: 404, body: { error: 'asset_not_found', symbol: sym } }
  const identity = detailIdentity(resolved.data, null)
  const cmcId = marketCmcIdentity(resolved.data)
  const now = Date.now()
  // A CoinGecko row with no CoinMarketCap listing still has stored catalogue
  // snapshots; only an asset with neither says it has no history here.
  let history: Any = cmcId
    ? await loadAssetHistory(db, { cmcId, range, request: cacheOnlyCmc, ctx: { caller: DEMO_READ_CALLER } })
    : unavailableHistory(range, 'no_coinmarketcap_listing')
  if (!history.points.length) history = await storedHistory(db, resolved.data, range, now).catch(() => null) || (cmcId ? { ...history, reason: DEMO_STORED_ONLY } : history)
  const metrics = history.points.length ? {
    volatility30d: realizedVolatility(history.points), maxDrawdown: maxDrawdown(history.points),
    distanceFromHigh: distanceFromHigh(history.points, now), timeUnderWaterDays: timeUnderWaterDays(history.points),
  } : NO_RISK_METRICS
  return { status: 200, body: { history, metrics, identity } }
}
