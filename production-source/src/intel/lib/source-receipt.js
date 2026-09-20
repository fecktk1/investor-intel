// Client mirror of the freshness and envelope rules in
// supabase/functions/_shared/intel/source-receipt.ts and market-figure-scope.ts.
//
// The server already states `freshness` on every SourceReceipt and envelope.
// This mirror exists for two reasons only: a CmcReceipt (research views) does
// not carry the field, and a curated envelope can outlive its review window in a
// client cache, so the app re-checks the window at render time instead of
// trusting a kind that was true when the response was assembled.

export const FRESHNESS_STATES = ['fresh', 'cached', 'stale', 'unavailable']
export const CAPTURE_CADENCE_GRACE = 1.5

const finite = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

/** Same answer as receiptFreshness() on the server for the same receipt. */
export function receiptFreshness(receipt, now = Date.now()) {
  if (!receipt || typeof receipt !== 'object') return 'unavailable'
  if (FRESHNESS_STATES.includes(receipt.freshness)) return receipt.freshness
  if (receipt.origin === 'negative-cache') return 'unavailable'
  if (receipt.origin === 'live') {
    const status = finite(receipt.httpStatus)
    return receipt.fetchedAt && status != null && status >= 200 && status < 300 ? 'fresh' : 'unavailable'
  }
  const fetched = Date.parse(String(receipt.capturedAt || receipt.fetchedAt || ''))
  if (!Number.isFinite(fetched)) return 'unavailable'
  const cadence = finite(receipt.cadenceSeconds)
  const limit = finite(receipt.ttlSeconds) ?? (cadence != null ? cadence * CAPTURE_CADENCE_GRACE : null)
  const age = finite(receipt.cacheAgeSeconds) ?? Math.max(0, (now - fetched) / 1000)
  if (limit != null) return age <= limit ? 'cached' : 'stale'
  const staleUntil = Date.parse(String(receipt.staleUntil || ''))
  if (Number.isFinite(staleUntil)) return staleUntil > now ? 'cached' : 'stale'
  return 'cached'
}

/** The envelope kind a view must branch on. A 'curated' envelope whose review
 * window has closed since the response was assembled is 'curated_stale' here.
 * An unknown or missing kind is null: the caller draws no provenance claim. */
export function envelopeKind(envelope, now = Date.now()) {
  const kind = envelope?.kind
  if (kind === 'curated') {
    const until = Date.parse(String(envelope.staleAfter || ''))
    return Number.isFinite(until) && until > now ? 'curated' : 'curated_stale'
  }
  return ['live', 'stored', 'curated_stale'].includes(kind) ? kind : null
}

/** Freshness of an envelope, after the curated window re-check above. */
export function envelopeFreshness(envelope, now = Date.now()) {
  const kind = envelopeKind(envelope, now)
  if (!kind) return null
  if (kind === 'curated_stale') return 'stale'
  return FRESHNESS_STATES.includes(envelope.freshness) ? envelope.freshness : null
}

/** What ONE read cost the reader who is looking at it, derived only from fields
 * the receipt already carries. Nothing here estimates: `estimateCmcCredits` in
 * cmc-capabilities.ts is a reservation FLOOR, never the amount billed, so it
 * must not be substituted for a charge that was not reported.
 *
 *   calls    Provider calls this read made FOR THIS READER. A live transport read
 *            is one. A cache hit, a remembered failure, a stored copy and a shared
 *            capture are all zero: nothing was called to draw this view.
 *   credits  The provider's own reported charge. A reported 0 is a real charge of
 *            zero and stays 0. null means it was not reported, which every cache
 *            hit does, because the cache row does not retain the originating
 *            charge (see CmcReceipt in cmc-transport.ts). A caller renders null
 *            in words, never as a zero.
 *   runCalls For a shared capture only: how many calls the capture RUN made to
 *            this endpoint. That is what the capture cost once for everyone, not
 *            what this reader cost, so it is kept in a separate field.
 *   served   'live' a call answered this read · 'cache' the shared cache did ·
 *            'shared' a recorded capture or stored copy did, at no per-reader
 *            provider cost · 'failed' a remembered failure answered it.
 *
 * Returns null for anything that is not a receipt, or a receipt with no origin:
 * a cost claim is never invented for a read that did not say how it was served. */
export function receiptCost(receipt) {
  if (!receipt || typeof receipt !== 'object') return null
  const credits = finite(receipt.creditCount)
  switch (String(receipt.origin || '')) {
    case 'live': return { calls: 1, credits, runCalls: null, served: 'live' }
    case 'negative-cache': return { calls: 0, credits, runCalls: null, served: 'failed' }
    case 'capture':
    case 'stored': return { calls: 0, credits, runCalls: finite(receipt.callCount), served: 'shared' }
    case 'cache': return { calls: 0, credits, runCalls: null, served: 'cache' }
    default: return null
  }
}

// Provider names are proper nouns and stay as written. Generic stores are
// described in the reader's language.
// The lower-case ids on the right of the second line are how the macro store and
// the execution quote write their own source (intel_macro_indicators.raw.source,
// dflow-check-execution's `sources`), so a figure can name its issuer without the
// page hard-coding a provider name of its own.
const PROVIDER_NAMES = {
  coinmarketcap: 'CoinMarketCap', coingecko: 'CoinGecko', birdeye: 'Birdeye', geckoterminal: 'GeckoTerminal', dexscreener: 'DEX Screener',
  dflow: 'DFlow', bls: 'US Bureau of Labor Statistics', 'ny fed': 'Federal Reserve Bank of New York',
  'alternative.me': 'Alternative.me', 'yahoo finance': 'Yahoo Finance', trongrid: 'TronGrid', chainlink: 'Chainlink',
  blockscout: 'Blockscout', sourcify: 'Sourcify', gleif: 'GLEIF', edgar: 'SEC EDGAR', ofac: 'OFAC',
}
const STORE_LABELS = {
  exchange: ['receipt_state.source_exchange', 'Centralized exchanges'],
  dex_pair_snapshots: ['receipt_state.source_dex_snapshots', 'DEX pool snapshots'],
  intel_curated_news: ['receipt_state.source_curated_news', 'Curated news desk'],
  'news_items+intel_global_news': ['receipt_state.source_stored_news', 'Recorded news'],
  signal_store: ['receipt_state.source_signal_store', 'Signal store'],
  derived_from_stored_news: ['receipt_state.source_derived_signals', 'Signals derived from recorded news'],
  market_assets: ['receipt_state.source_market_catalogue', 'Market catalogue'],
}
export function providerLabel(value, t = null) {
  const key = String(value || '')
  if (STORE_LABELS[key]) return t ? t(STORE_LABELS[key][0], { defaultValue: STORE_LABELS[key][1] }) : STORE_LABELS[key][1]
  return key.split('+').map(part => PROVIDER_NAMES[part] || part).join(' + ')
}

// Chart candles on /intel/markets/:symbol. The detail response carries one
// receipt set and one envelope for the candles of its FIRST load (the page's
// default period). Every other period is a `candlesOnly` read whose body carries
// the ladder output (raw CoinMarketCap transport receipts, the source, its state
// and clocks) but no assembled envelope. So the chart re-derives the envelope for
// the snapshot it is actually drawing, with the same rules as chartProvenance()
// in supabase/functions/_shared/intel/market-provenance.ts. A parity test runs
// both on the same bodies, so the two cannot drift apart silently.
const CHART_SCOPE = { coinmarketcap: 'cmc_ohlcv', coinmarketcap_kline: 'dex_ohlcv', coingecko: 'coingecko_ohlc', birdeye: 'birdeye_ohlcv', geckoterminal: 'dex_ohlcv', dexscreener: 'dex_pool' }
const CHART_EXCHANGES = ['binance', 'coinbase', 'kraken', 'kucoin', 'okx', 'bybit']
// The English sentences behind each scope key (market-figure-scope.ts). The app
// renders the localised figure_scope.<key> string; these are its fallback.
const CHART_SCOPE_SENTENCES = {
  birdeye_ohlcv: 'Birdeye on-chain candles for this contract from a shared cache. Pool prices, not a fill anyone received.',
  dex_pool: 'Figures for one DEX pool at its snapshot time. Not the depth available to a trade and not every pool for this token.',
  dex_ohlcv: 'Candles for one DEX pool as a public source published them. Not every pool for this token and not an execution record.',
  exchange_ohlcv: 'Candles from one covered centralized exchange pair. Reported by that venue and not the price on any other venue.',
  coingecko_ohlc: 'CoinGecko observations at the provider spacing. Volume is not included and the spacing is not a candle width.',
  cmc_ohlcv: 'CoinMarketCap completed OHLCV periods for this asset. Asset-level market data, not the price of any one pool or venue.',
}
const PRICE_SCOPE = 'Provider-aggregated USD quote at its reported time. Not an executable price and not the quote of any one venue.'

const isoOrNull = value => {
  if (value == null || value === '') return null
  const at = Date.parse(String(value))
  return Number.isFinite(at) ? new Date(at).toISOString() : null
}
const newestStamp = values => {
  const stamps = values.map(v => Date.parse(String(v ?? ''))).filter(Number.isFinite)
  return stamps.length ? new Date(Math.max(...stamps)).toISOString() : null
}
const worstFreshness = states => (!states.length ? null
  : states.includes('unavailable') ? 'unavailable'
    : states.includes('stale') ? 'stale'
      : states.every(s => s === 'fresh') ? 'fresh' : 'cached')

/** Receipts and the chart envelope for one candle snapshot, as chartProvenance()
 * derives them on the server. A snapshot that already carries the server's own
 * `chartEnvelope` / `chartReceipts` (the detail response's first load) keeps
 * them untouched. Returns null for anything that is not a snapshot. */
export function chartSnapshotProvenance(snapshot, now = Date.now()) {
  if (!snapshot || typeof snapshot !== 'object') return null
  if (snapshot.chartEnvelope !== undefined || Array.isArray(snapshot.chartReceipts)) {
    return { receipts: Array.isArray(snapshot.chartReceipts) ? snapshot.chartReceipts.filter(Boolean) : [], envelope: snapshot.chartEnvelope || null }
  }
  const source = String(snapshot.bestProvider || snapshot.source || 'unknown')
  const receipts = (Array.isArray(snapshot.receipts) ? snapshot.receipts : [])
    .filter(r => r && typeof r === 'object')
    .map(r => ({ ...r, provider: 'coinmarketcap', freshness: receiptFreshness(r, now) }))
  const fetchedAt = newestStamp([...(Array.isArray(snapshot.provenance) ? snapshot.provenance.map(p => p?.fetchedAt) : []), snapshot.last_refreshed_at, snapshot.lastRefreshedAt])
  const state = String(snapshot.sourceState ?? snapshot.chartState ?? '')
  const freshness = receipts.length ? worstFreshness(receipts.map(r => receiptFreshness(r, now)))
    : state === 'stale' ? 'stale' : state === 'unavailable' || !(snapshot.candles?.length) ? 'unavailable' : null
  const scopeKey = CHART_SCOPE[source] ?? (source.includes('exchange') || CHART_EXCHANGES.includes(source) ? 'exchange_ohlcv' : null)
  return {
    receipts,
    envelope: {
      kind: receipts.some(r => r.origin === 'live') ? 'live' : 'stored',
      source,
      fetchedAt: isoOrNull(fetchedAt),
      freshness: FRESHNESS_STATES.includes(freshness) ? freshness : null,
      scope: scopeKey ? CHART_SCOPE_SENTENCES[scopeKey] : PRICE_SCOPE,
      scopeKey,
    },
  }
}
