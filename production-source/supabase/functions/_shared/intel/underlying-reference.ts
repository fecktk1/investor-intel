// Investor Intel: the UNDERLYING stock's own price beside its tokenised wrappers.
//
// THE QUESTION. The wrapper board measures each wrapper of one stock against
// the volume-weighted median of its sibling wrappers (the anchor). That says
// which wrapper is dear against the others; it cannot say whether all of them
// sit above or below the stock itself. This module adds that second reference,
// BESIDE the anchor and never instead of it: the stock's price from a Chainlink
// on-chain equity feed, read keylessly through a public RPC with the same
// AggregatorV3 helpers the NAV lane uses (`chainlink-nav.ts`).
//
// WHY CHAINLINK, AND WHAT IT CANNOT DO. It is the source we can read for free,
// without a key, and show publicly. It is also a PUSH feed: a new round is
// written only when the price moves by the feed's deviation threshold (0.3 or
// 0.5 percent here) or when its heartbeat (24 hours) lapses, and the NYSE-hours
// feeds only move while the market is open. The median gap between two liquid
// wrappers of one stock is a few basis points, so a feed can honestly sit tens
// of basis points away from the true price. Every figure therefore carries the
// feed's band, and a gap inside the band is stated as NOT DISTINGUISHABLE rather
// than presented as a premium (`referenceGap`).
//
// THE CLOCK IS THE WRAPPER PRICES' CLOCK, NOT OURS. Measured 2026-09-23: the
// provider's RWA quotes refresh twice a day (`last_updated` 08:45:59 and
// 20:45:59 UTC) and the 14:47 capture returned token prices identical to the
// 08:47 one. Comparing those prices with the stock's price at 14:47 would put a
// pre-market wrapper price against a mid-session stock price. So the reference
// is the feed round IN EFFECT at the instant the wrapper prices were observed
// (the asset's `source_observed_at`), found by walking back a bounded number of
// rounds, and the session is named for that same instant.
//
// A SECOND SOURCE PLUGS IN BEHIND `UnderlyingReferenceSource`. Chainlink is the
// only implementation. A licensed real-time provider would implement the same
// two methods (which tickers it covers, and the price in effect at an instant),
// report `deviationPct: null` because it has no update band, and every reader
// downstream would pass it through unchanged. None is built here.

import { validateNavFeed, readNavRounds, liveNavRpcCall, type NavRpc, type NavRound } from './chainlink-nav.ts'
import { usEquitySessionAt, type UsEquitySession } from './investigation-sessions.ts'
import { bps } from './rwa-wrapper-spread.ts'

// ─── The registry ─────────────────────────────────────────────────────────────

export const REFERENCE_SOURCES = ['chainlink'] as const
export type ReferenceSourceId = typeof REFERENCE_SOURCES[number]

/** Networks a registry feed may live on, each with a keyless public RPC. All
 * four answered every call of the 2026-09-23 verification (publicnode.com, the
 * same operator as the NAV lane's Ethereum default). The label is a network's
 * own proper name and is shown untranslated. */
export const REFERENCE_CHAINS = {
  arbitrum: { label: 'Arbitrum', rpcUrl: 'https://arbitrum-one-rpc.publicnode.com' },
  bsc: { label: 'BNB Chain', rpcUrl: 'https://bsc-rpc.publicnode.com' },
  optimism: { label: 'OP Mainnet', rpcUrl: 'https://optimism-rpc.publicnode.com' },
  polygon: { label: 'Polygon', rpcUrl: 'https://polygon-bor-rpc.publicnode.com' },
} as const
export type ReferenceChain = keyof typeof REFERENCE_CHAINS

/** When a feed moves. `nyse_regular` feeds are written only during the NYSE
 * regular session, so outside it they hold the last regular-session level.
 * `us_equities_24_5` feeds also follow extended and overnight weekday trading. */
export const FEED_HOURS = ['nyse_regular', 'us_equities_24_5'] as const
export type FeedHours = typeof FEED_HOURS[number]

export interface EquityFeed {
  ticker: string
  /** The RWA `asset_type` this ticker must carry for the mapping to hold. */
  assetType: 'stock' | 'etf'
  chain: ReferenceChain
  /** The aggregator PROXY address, lower case. */
  proxy: string
  /** `description()` exactly as the chain returned it on verification. */
  description: string
  decimals: number
  /** The feed's deviation threshold in PERCENT (0.5 means 0.5%). */
  deviationPct: number
  heartbeatSeconds: number
  hours: FeedHours
}

/** The date every entry below was proved on chain: `description()` equal to the
 * recorded string, `decimals()` equal to 8, and `latestRoundData()` returning a
 * positive answer updated that day. Addresses were suggested by the Chainlink
 * feed directories and are believed only because the chain agreed. The live
 * re-check is `underlying-reference.test.ts` with INTEL_LIVE_RPC=1.
 *
 * WHERE A TICKER HAD TWO FEEDS, THE TIGHTER BAND WON. Apple, Amazon, Alphabet,
 * Microsoft and Tesla have 0.3 percent feeds on Polygon beside 0.5 percent ones
 * on Arbitrum and BNB Chain, and Meta has a 0.3 percent feed on BNB Chain: a
 * narrower band means fewer gaps that have to be called indistinguishable.
 * NYSE-hours feeds were preferred over 24/5 ones wherever both exist, so that
 * outside the session the reference is plainly the last regular-session level.
 * MicroStrategy has no NYSE-hours push feed, so its 24/5 feed is used and says so. */
export const REFERENCE_VERIFIED_AT = '2026-09-23'
export const CHAINLINK_EQUITY_FEEDS: Readonly<Record<string, EquityFeed>> = Object.freeze({
  AAPL: { ticker: 'AAPL', assetType: 'stock', chain: 'polygon', proxy: '0x7e7b45b08f68ec69a99aab12e42fccb078e10094', description: 'AAPL / USD', decimals: 8, deviationPct: 0.3, heartbeatSeconds: 86400, hours: 'nyse_regular' },
  AMZN: { ticker: 'AMZN', assetType: 'stock', chain: 'polygon', proxy: '0xf9184b8e5da48c19fa4e06f83f77742e748cca96', description: 'AMZN / USD', decimals: 8, deviationPct: 0.3, heartbeatSeconds: 86400, hours: 'nyse_regular' },
  GOOGL: { ticker: 'GOOGL', assetType: 'stock', chain: 'polygon', proxy: '0x1b32682c033b2dd7efdc615fa82d353e254f39b5', description: 'GOOGL / USD', decimals: 8, deviationPct: 0.3, heartbeatSeconds: 86400, hours: 'nyse_regular' },
  MSFT: { ticker: 'MSFT', assetType: 'stock', chain: 'polygon', proxy: '0xc43081d9ea6d1c53f1f0e525504d47dd60de12da', description: 'MSFT / USD', decimals: 8, deviationPct: 0.3, heartbeatSeconds: 86400, hours: 'nyse_regular' },
  TSLA: { ticker: 'TSLA', assetType: 'stock', chain: 'polygon', proxy: '0x567e67f456c7453c583b6efa6f18452cdee1f5a8', description: 'TSLA / USD', decimals: 8, deviationPct: 0.3, heartbeatSeconds: 86400, hours: 'nyse_regular' },
  META: { ticker: 'META', assetType: 'stock', chain: 'bsc', proxy: '0xfc76e9445952a3c31369dfd26edfdfb9713df5bb', description: 'META / USD', decimals: 8, deviationPct: 0.3, heartbeatSeconds: 86400, hours: 'nyse_regular' },
  NVDA: { ticker: 'NVDA', assetType: 'stock', chain: 'arbitrum', proxy: '0x4881a4418b5f2460b21d6f08cd5aa0678a7f262f', description: 'NVDA / USD', decimals: 8, deviationPct: 0.5, heartbeatSeconds: 86400, hours: 'nyse_regular' },
  COIN: { ticker: 'COIN', assetType: 'stock', chain: 'arbitrum', proxy: '0x950dc95d4e537a14283059badc2734977c454498', description: 'COIN / USD', decimals: 8, deviationPct: 0.5, heartbeatSeconds: 86400, hours: 'nyse_regular' },
  SPY: { ticker: 'SPY', assetType: 'etf', chain: 'arbitrum', proxy: '0x46306f3795342117721d8ded50fbcf6df2b3cc10', description: 'SPY / USD', decimals: 8, deviationPct: 0.5, heartbeatSeconds: 86400, hours: 'nyse_regular' },
  GME: { ticker: 'GME', assetType: 'stock', chain: 'bsc', proxy: '0x66cd2975d02f5f5cdef2e05cbca12549b1a5022d', description: 'GME / USD', decimals: 8, deviationPct: 0.5, heartbeatSeconds: 86400, hours: 'nyse_regular' },
  QQQ: { ticker: 'QQQ', assetType: 'etf', chain: 'bsc', proxy: '0x9a41b56b2c24683e2f23bde15c14bc7c4a58c3c4', description: 'QQQ / USD', decimals: 8, deviationPct: 0.5, heartbeatSeconds: 86400, hours: 'nyse_regular' },
  MSTR: { ticker: 'MSTR', assetType: 'stock', chain: 'optimism', proxy: '0xe91ac697637acd6f038055bccdad4fb0e7f01700', description: 'MSTR-USD (24/5)', decimals: 8, deviationPct: 0.5, heartbeatSeconds: 86400, hours: 'us_equities_24_5' },
})

/** Tickers with a Chainlink feed that is deliberately NOT used, and why. Each
 * one answers "no stock reference for this ticker yet" on the board.
 *
 *   SPCX  Chainlink prices it from a pre-IPO venue (its feeds are built on
 *         Hyperliquid and Binance perpetual books and a 24/5 calculated price).
 *         There is no listed regular-session share price behind it, so calling
 *         it "the stock" would present a venue price as an exchange price.
 *   CRCL, INTC, SNDK
 *         The only Chainlink PUSH feeds for these price Coinbase's own
 *         tokenised equity ("Coinbase CRCL", asset "Circle ... (Coinbase
 *         Tokenized Equity)", entity crypto-CBCRCL): that is a WRAPPER's price,
 *         and measuring wrappers against another wrapper is exactly the
 *         circularity this reference exists to break. Their stock-price feeds
 *         are published only as Data Streams reports, which a public eth_call
 *         cannot read. */
export const EXCLUDED_REFERENCE_TICKERS: Readonly<Record<string, string>> = Object.freeze({
  SPCX: 'pre_ipo_venue_price',
  CRCL: 'only_a_tokenised_equity_feed',
  INTC: 'only_a_tokenised_equity_feed',
  SNDK: 'only_a_tokenised_equity_feed',
})

// ─── The rules, every one a recorded judgement ────────────────────────────────

/** In a session where the feed is supposed to move, a round older than its
 * heartbeat plus this grace means the feed has stopped, and it is not used. */
export const IN_SESSION_GRACE_SECONDS = 3600
/** Outside the session a round is the last session level. Friday's close read on
 * the Tuesday after a Monday holiday is about 3.7 days old, so 5 days admits
 * every scheduled closure and nothing that has simply stopped. */
export const OFF_SESSION_MAX_AGE_SECONDS = 5 * 86400
/** How many earlier rounds one read may walk to find the round in effect at the
 * wrapper observation instant. One batched call, never a cursor. */
export const ROUND_WALK = 40
export const REFERENCE_RPC_TIMEOUT_MS = 6000

/** Exchanges whose listing is a US listing, as the provider's profile names
 * them (distinct values in intel_rwa_asset_profiles on 2026-09-23: Nasdaq,
 * New York Stock Exchange, NYSE Arca, Inc., NYSE American, LLC, Cboe BZX). */
export function isUsExchange(value: unknown): boolean {
  const s = String(value ?? '').trim()
  return /^(nasdaq\b|new york stock exchange\b|nyse\b|cboe (bzx|byx|edgx|edga)\b|iex\b|investors exchange\b)/i.test(s)
}

export const REFERENCE_STATES = ['observed', 'stale', 'unavailable', 'no_reference', 'mapping_refused'] as const
export type ReferenceState = typeof REFERENCE_STATES[number]

/** What the board says about a gap, and what the storage calls it. */
export const REFERENCE_SCOPE =
  'The stock reference is a Chainlink on-chain price feed for the listed share, taken at the round in effect when the wrapper prices were observed. The feed only writes a new price after a move of its stated band or after its heartbeat, so a gap smaller than the band is not distinguishable from zero. A gap compares one token with one share: it does not adjust for dividends a wrapper may have reinvested, and it is not a tradable arbitrage.'

// ─── Ticker mapping ───────────────────────────────────────────────────────────

export interface ReferenceEvidence {
  /** `intel_rwa_asset_profiles.primary_exchange`, where the profile lane has it. */
  primaryExchange?: string | null
  /** `intel_rwa_underlying_registrants.tickers`, where EDGAR answered. */
  registrantTickers?: string[] | null
  /** `tradfi_markets[].ticker` from the quotes payload already fetched. */
  tradfiTickers?: string[] | null
}

export interface MappingVerdict {
  state: 'mapped' | 'no_reference' | 'mapping_refused' | 'not_applicable'
  ticker: string | null
  reason: string | null
}

const cleanTickers = (list: unknown): string[] =>
  (Array.isArray(list) ? list : []).map((v) => String(v ?? '').trim()).filter((v) => /^[A-Z0-9.\-]{1,12}$/.test(v))

/** Map a provider RWA asset onto a registry ticker, or refuse.
 *
 * The provider's asset `symbol` IS the exchange ticker for a tokenised stock or
 * ETF, so the join is EXACT on that symbol and on nothing else: never a name,
 * never a fuzzy match, never a case fold. Then every piece of evidence we hold
 * must agree with it: the registry's asset type, a US primary exchange where the
 * profile names one, the SEC registrant's tickers where EDGAR returned any, and
 * the quotes payload's own `tradfi_markets` tickers where it carries them. Any
 * one disagreement refuses the mapping with that reason. */
export function mapUnderlyingTicker(
  asset: { symbol: string | null; assetType: string | null },
  evidence: ReferenceEvidence = {},
  covers: (ticker: string) => { assetType: string } | null = (ticker) => (Object.hasOwn(CHAINLINK_EQUITY_FEEDS, ticker) ? CHAINLINK_EQUITY_FEEDS[ticker] : null),
): MappingVerdict {
  const type = String(asset.assetType ?? '').trim()
  if (type !== 'stock' && type !== 'etf') return { state: 'not_applicable', ticker: null, reason: null }
  const symbol = String(asset.symbol ?? '').trim()
  if (!symbol) return { state: 'no_reference', ticker: null, reason: 'no_symbol' }
  if (Object.hasOwn(EXCLUDED_REFERENCE_TICKERS, symbol)) return { state: 'no_reference', ticker: symbol, reason: EXCLUDED_REFERENCE_TICKERS[symbol] }
  const feed = covers(symbol)
  if (!feed) return { state: 'no_reference', ticker: symbol, reason: 'no_feed_for_ticker' }
  if (feed.assetType !== type) return { state: 'mapping_refused', ticker: symbol, reason: 'asset_type_disagrees' }
  const exchange = String(evidence.primaryExchange ?? '').trim()
  if (exchange && !isUsExchange(exchange)) return { state: 'mapping_refused', ticker: symbol, reason: 'not_a_us_listing' }
  const registrant = cleanTickers(evidence.registrantTickers)
  if (registrant.length && !registrant.includes(symbol)) return { state: 'mapping_refused', ticker: symbol, reason: 'registrant_tickers_disagree' }
  const tradfi = cleanTickers(evidence.tradfiTickers)
  if (tradfi.length && !tradfi.includes(symbol)) return { state: 'mapping_refused', ticker: symbol, reason: 'tradfi_ticker_disagrees' }
  return { state: 'mapped', ticker: symbol, reason: null }
}

/** The tickers a quotes row's `tradfi_markets` carries. On 2026-09-23 NVDA's row
 * held one entry, `{ ticker: 'NVDA', exchange: { name: 'Binance' }, market_url }`:
 * the exchange there is where the provider saw a market, NOT the listing
 * exchange, so only the ticker is read. */
// deno-lint-ignore no-explicit-any
export function tradfiTickers(row: any): string[] | null {
  const list = Array.isArray(row?.tradfi_markets) ? row.tradfi_markets : null
  if (!list) return null
  const out = cleanTickers(list.map((entry: { ticker?: unknown }) => entry?.ticker))
  return out.length ? [...new Set(out)] : null
}

// ─── One reading ──────────────────────────────────────────────────────────────

export interface ReferenceReading {
  source: ReferenceSourceId
  ticker: string
  state: 'observed' | 'stale' | 'unavailable'
  /** Machine reason from a fixed set; null only when observed. */
  reason: string | null
  /** The underlying transport or chain message, kept for the operator. */
  detail: string | null
  network: string | null
  address: string | null
  feed: string | null
  onChainDescription: string | null
  decimals: number | null
  deviationPct: number | null
  heartbeatSeconds: number | null
  hours: FeedHours | null
  roundId: string | null
  price: number | null
  roundUpdatedAt: string | null
  /** Seconds from the round's update to `comparedAt`. */
  ageSeconds: number | null
  /** The instant the reference is taken at: when the wrapper prices were observed. */
  comparedAt: string
  session: UsEquitySession
  roundsRead: number
}

/** A reference provider. Chainlink is the only one today. */
export interface UnderlyingReferenceSource {
  readonly id: ReferenceSourceId
  /** The registry entry this source would read for a ticker, or null. */
  covers(ticker: string): { assetType: string } | null
  /** The price in effect at each requested instant. Never throws: a failure is
   * a reading with state `unavailable` and a reason. */
  readAsOf(requests: { ticker: string; asOfMs: number }[]): Promise<Map<string, ReferenceReading>>
}

const requestKey = (ticker: string, asOfMs: number) => `${ticker}@${asOfMs}`

/** Why a chain read failed, in the fixed vocabulary the surface translates. */
function failureKind(reason: string | undefined): string {
  if (reason === 'description_mismatch' || reason === 'decimals_mismatch' || reason === 'no_on_chain_description' || reason === 'mirror_decimals_missing') return 'feed_identity_not_proved'
  if (reason === 'no_latest_round' || reason === 'non_positive_nav') return 'feed_round_unusable'
  return 'feed_read_failed'
}

/** Read one registry feed as of one instant. Exported for tests. */
export async function readChainlinkAsOf(
  feed: EquityFeed,
  asOfMs: number,
  deps: { rpcCall?: NavRpc; timeoutMs?: number; rpcUrls?: Partial<Record<ReferenceChain, string>> } = {},
): Promise<ReferenceReading> {
  const rpcCall = deps.rpcCall || liveNavRpcCall
  const timeoutMs = deps.timeoutMs ?? REFERENCE_RPC_TIMEOUT_MS
  const rpcUrl = deps.rpcUrls?.[feed.chain] || REFERENCE_CHAINS[feed.chain].rpcUrl
  const { session } = usEquitySessionAt(asOfMs)
  const base: ReferenceReading = {
    source: 'chainlink', ticker: feed.ticker, state: 'unavailable', reason: null, detail: null,
    network: feed.chain, address: feed.proxy, feed: feed.description, onChainDescription: null,
    decimals: feed.decimals, deviationPct: feed.deviationPct, heartbeatSeconds: feed.heartbeatSeconds, hours: feed.hours,
    roundId: null, price: null, roundUpdatedAt: null, ageSeconds: null,
    comparedAt: new Date(asOfMs).toISOString(), session, roundsRead: 0,
  }
  // The same three-call proof the NAV lane runs: description and decimals must
  // equal the registry exactly and a positive latest round must exist.
  const validation = await validateNavFeed(
    { mirrorName: feed.description, address: feed.proxy, decimals: feed.decimals, heartbeatSeconds: feed.heartbeatSeconds, porAuditor: null },
    { rpcCall, rpcUrl, timeoutMs },
  )
  base.onChainDescription = validation.onChainDescription ?? null
  if (validation.state !== 'validated' || !validation.latest) {
    return { ...base, reason: failureKind(validation.reason), detail: (validation.reason || null)?.slice(0, 120) ?? null }
  }
  let round: NavRound | null = validation.latest
  let roundsRead = 1
  if (round.updatedAt * 1000 > asOfMs) {
    // The latest round was written AFTER the wrapper prices were observed, so it
    // is not the price those wrappers traded against. Walk back, bounded.
    const rounds = await readNavRounds(validation, { rpcCall, rpcUrl, timeoutMs }, ROUND_WALK)
    roundsRead = rounds.length
    round = rounds.filter((r) => r.updatedAt * 1000 <= asOfMs).at(-1) ?? null
    if (!round) {
      return { ...base, roundsRead, reason: 'round_at_observation_not_read', detail: `walked_${rounds.length}_rounds` }
    }
  }
  const ageSeconds = Math.round(asOfMs / 1000 - round.updatedAt)
  const moving = session === 'regular'
    || (feed.hours === 'us_equities_24_5' && (session === 'pre_market' || session === 'after_hours' || session === 'closed'))
  const limit = moving ? feed.heartbeatSeconds + IN_SESSION_GRACE_SECONDS : OFF_SESSION_MAX_AGE_SECONDS
  const stale = ageSeconds > limit
  return {
    ...base, roundsRead,
    state: stale ? 'stale' : 'observed',
    reason: stale ? (moving ? 'stale_in_session' : 'stale_off_session') : null,
    roundId: round.roundId, price: round.nav,
    roundUpdatedAt: new Date(round.updatedAt * 1000).toISOString(), ageSeconds,
  }
}

/** The Chainlink source over the committed registry. */
export function chainlinkReferenceSource(
  deps: { rpcCall?: NavRpc; timeoutMs?: number; rpcUrls?: Partial<Record<ReferenceChain, string>>; registry?: Readonly<Record<string, EquityFeed>> } = {},
): UnderlyingReferenceSource {
  const registry = deps.registry || CHAINLINK_EQUITY_FEEDS
  return {
    id: 'chainlink',
    covers: (ticker) => (Object.hasOwn(registry, ticker) ? registry[ticker] : null),
    async readAsOf(requests) {
      const out = new Map<string, ReferenceReading>()
      const unique = new Map<string, { ticker: string; asOfMs: number }>()
      for (const request of requests) unique.set(requestKey(request.ticker, request.asOfMs), request)
      // Bounded: one entry per registry ticker at most per instant, read in
      // parallel, each with its own timeout and at most two requests.
      await Promise.all([...unique.entries()].map(async ([key, request]) => {
        const feed = Object.hasOwn(registry, request.ticker) ? registry[request.ticker] : null
        if (!feed) return
        try {
          out.set(key, await readChainlinkAsOf(feed, request.asOfMs, deps))
        } catch (e) {
          // validateNavFeed never throws, but a reading is never lost to a throw.
          out.set(key, {
            source: 'chainlink', ticker: feed.ticker, state: 'unavailable', reason: 'feed_read_failed',
            detail: ((e as Error)?.message || 'read_failed').slice(0, 120),
            network: feed.chain, address: feed.proxy, feed: feed.description, onChainDescription: null,
            decimals: feed.decimals, deviationPct: feed.deviationPct, heartbeatSeconds: feed.heartbeatSeconds, hours: feed.hours,
            roundId: null, price: null, roundUpdatedAt: null, ageSeconds: null,
            comparedAt: new Date(request.asOfMs).toISOString(), session: usEquitySessionAt(request.asOfMs).session, roundsRead: 0,
          })
        }
      }))
      return out
    },
  }
}

// ─── The comparison ───────────────────────────────────────────────────────────

/** A price against the reference, in basis points of the reference, and whether
 * the gap is inside the feed's own update band. A gap inside the band is NOT
 * DISTINGUISHABLE from zero: the feed could be that far from the stock without
 * writing a new round. `withinBand` is null for a source that has no band. */
export function referenceGap(
  price: number | null,
  reading: Pick<ReferenceReading, 'state' | 'price' | 'deviationPct'> | null,
): { bps: number | null; withinBand: boolean | null } {
  if (!reading || reading.state !== 'observed' || reading.price == null || !(reading.price > 0)) return { bps: null, withinBand: null }
  if (price == null || !Number.isFinite(price) || !(price > 0)) return { bps: null, withinBand: null }
  const gap = bps(price, reading.price)
  if (gap == null) return { bps: null, withinBand: null }
  const band = reading.deviationPct
  return { bps: gap, withinBand: band == null || !(band > 0) ? null : Math.abs(gap) <= band * 100 + 1e-9 }
}

// ─── Resolving a capture ──────────────────────────────────────────────────────

export interface ReferenceAssetInput {
  rwaId: string
  symbol: string | null
  assetType: string | null
  /** The provider's clock for the wrapper prices (`source_observed_at`). */
  observedAt: string | null
}

export interface ReferenceOutcome {
  mapping: MappingVerdict
  reading: ReferenceReading | null
  /** Set when the asset mapped but no read could be attempted. */
  reason: string | null
}

/** Map every asset, then read each mapped ticker once as of its own wrapper
 * observation instant. Assets that are not stocks or ETFs are returned as
 * `not_applicable` and cost nothing. */
export async function resolveUnderlyingReferences(
  assets: ReferenceAssetInput[],
  evidence: Map<string, ReferenceEvidence>,
  source: UnderlyingReferenceSource,
): Promise<{ outcomes: Map<string, ReferenceOutcome>; reads: number }> {
  const outcomes = new Map<string, ReferenceOutcome>()
  const wanted: { rwaId: string; ticker: string; asOfMs: number }[] = []
  for (const asset of assets) {
    // The mapping reads the ACTIVE source's coverage, so a second source's
    // registry maps through exactly the same rules.
    const mapping = mapUnderlyingTicker(asset, evidence.get(asset.rwaId) ?? {}, (ticker) => source.covers(ticker))
    if (mapping.state !== 'mapped' || !mapping.ticker) { outcomes.set(asset.rwaId, { mapping, reading: null, reason: null }); continue }
    const asOfMs = Date.parse(String(asset.observedAt ?? ''))
    if (!Number.isFinite(asOfMs)) {
      // Without the wrapper prices' own clock there is no instant to read the
      // stock at, and reading it "now" would compare two different moments.
      outcomes.set(asset.rwaId, { mapping, reading: null, reason: 'wrapper_observation_time_unknown' })
      continue
    }
    wanted.push({ rwaId: asset.rwaId, ticker: mapping.ticker, asOfMs })
    outcomes.set(asset.rwaId, { mapping, reading: null, reason: null })
  }
  const readings = wanted.length ? await source.readAsOf(wanted.map(({ ticker, asOfMs }) => ({ ticker, asOfMs }))) : new Map()
  for (const want of wanted) {
    const reading = readings.get(requestKey(want.ticker, want.asOfMs)) ?? null
    const outcome = outcomes.get(want.rwaId)!
    outcomes.set(want.rwaId, { ...outcome, reading, reason: reading ? null : 'feed_read_failed' })
  }
  return { outcomes, reads: new Set(wanted.map((w) => requestKey(w.ticker, w.asOfMs))).size }
}

// ─── Row builders ─────────────────────────────────────────────────────────────

/** The additive columns on one `intel_rwa_wrapper_assets` row. Every key is
 * always present (null where it does not apply), so an upsert of a row that
 * carried a reference before and cannot carry one now clears it. */
export function assetReferenceColumns(outcome: ReferenceOutcome | null, anchorPrice: number | null, fetchedAt: string): Record<string, unknown> {
  const empty = {
    underlying_ref_state: null, underlying_ref_reason: null, underlying_ref_ticker: null, underlying_ref_source: null,
    underlying_ref_price: null, underlying_ref_feed: null, underlying_ref_network: null, underlying_ref_address: null,
    underlying_ref_deviation_pct: null, underlying_ref_heartbeat_s: null, underlying_ref_hours: null,
    underlying_ref_observed_at: null, underlying_ref_compared_at: null, underlying_ref_age_s: null,
    underlying_ref_session: null, underlying_ref_anchor_bps: null, underlying_ref_anchor_within_band: null,
    underlying_ref_fetched_at: null,
  }
  if (!outcome || outcome.mapping.state === 'not_applicable') return empty
  const { mapping, reading } = outcome
  if (mapping.state !== 'mapped') {
    return { ...empty, underlying_ref_state: mapping.state, underlying_ref_reason: mapping.reason || 'no_feed_for_ticker', underlying_ref_ticker: mapping.ticker }
  }
  if (!reading) {
    return { ...empty, underlying_ref_state: 'unavailable', underlying_ref_reason: outcome.reason || 'feed_read_failed', underlying_ref_ticker: mapping.ticker, underlying_ref_fetched_at: fetchedAt }
  }
  const gap = referenceGap(anchorPrice, reading)
  return {
    underlying_ref_state: reading.state,
    underlying_ref_reason: reading.state === 'observed' ? null : reading.reason || 'feed_read_failed',
    underlying_ref_ticker: reading.ticker,
    underlying_ref_source: reading.source,
    // A stale round's price is kept for the record but nothing is measured
    // against it; an unavailable read has no price at all.
    underlying_ref_price: reading.state === 'unavailable' ? null : reading.price,
    underlying_ref_feed: reading.feed,
    underlying_ref_network: reading.network,
    underlying_ref_address: reading.address,
    underlying_ref_deviation_pct: reading.deviationPct,
    underlying_ref_heartbeat_s: reading.heartbeatSeconds,
    underlying_ref_hours: reading.hours,
    underlying_ref_observed_at: reading.state === 'unavailable' ? null : reading.roundUpdatedAt,
    underlying_ref_compared_at: reading.comparedAt,
    underlying_ref_age_s: reading.state === 'unavailable' ? null : reading.ageSeconds,
    underlying_ref_session: reading.session,
    underlying_ref_anchor_bps: gap.bps,
    underlying_ref_anchor_within_band: gap.withinBand,
    underlying_ref_fetched_at: fetchedAt,
  }
}

/** Wrapper states that may carry a gap to the stock. An accruing wrapper never
 * does, for the same reason it never carries a premium; a wrapper whose unit was
 * not established has no comparable price. */
const GAP_STATES = new Set(['liquid', 'too_thin_to_anchor', 'volume_not_reported', 'derivative_reference'])

/** The additive columns on one `intel_rwa_wrapper_tokens` row. */
export function tokenReferenceColumns(
  token: { normalised_price?: unknown; wrapper_state?: unknown },
  outcome: ReferenceOutcome | null,
): Record<string, unknown> {
  const empty = {
    underlying_ref_price: null, underlying_ref_bps: null, underlying_ref_within_band: null,
    underlying_ref_session: null, underlying_ref_observed_at: null, underlying_ref_source: null,
  }
  const reading = outcome?.reading
  if (!reading || reading.state !== 'observed') return empty
  const price = token.normalised_price == null ? null : Number(token.normalised_price)
  const eligible = GAP_STATES.has(String(token.wrapper_state ?? ''))
  const gap = eligible ? referenceGap(price, reading) : { bps: null, withinBand: null }
  return {
    underlying_ref_price: reading.price,
    underlying_ref_bps: gap.bps,
    underlying_ref_within_band: gap.withinBand,
    underlying_ref_session: reading.session,
    underlying_ref_observed_at: reading.roundUpdatedAt,
    underlying_ref_source: reading.source,
  }
}

/** One `intel_rwa_underlying_reference_observations` row per asset a read was
 * attempted for, failures included: a failed read is stored as a reason, never
 * as a zero and never as a missing row. */
export function observationRow(
  rwaId: string,
  outcome: ReferenceOutcome | null,
  context: { capturedAt: string; fetchedAt: string; op: 'rwa_wrappers' | 'rwa_wrapper_reference' },
): Record<string, unknown> | null {
  const reading = outcome?.reading
  if (!outcome || outcome.mapping.state !== 'mapped' || !reading) return null
  return {
    rwa_id: rwaId, captured_at: context.capturedAt, source: reading.source, ticker: reading.ticker,
    capture_op: context.op,
    chain: reading.network, proxy: reading.address, feed_description: reading.feed,
    on_chain_description: reading.onChainDescription, decimals: reading.decimals,
    deviation_pct: reading.deviationPct, heartbeat_s: reading.heartbeatSeconds, market_hours: reading.hours,
    read_state: reading.state, read_reason: reading.reason, read_detail: reading.detail,
    round_id: reading.roundId, price: reading.price, round_updated_at: reading.roundUpdatedAt,
    age_seconds: reading.ageSeconds, rounds_read: reading.roundsRead,
    compared_at: reading.comparedAt, session: reading.session,
    fetched_at: context.fetchedAt,
  }
}
