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

// Provider names are proper nouns and stay as written. Generic stores are
// described in the reader's language.
const PROVIDER_NAMES = { coinmarketcap: 'CoinMarketCap', coingecko: 'CoinGecko', birdeye: 'Birdeye', geckoterminal: 'GeckoTerminal', dexscreener: 'DEX Screener' }
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
