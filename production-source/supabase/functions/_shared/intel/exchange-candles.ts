// Investor Intel — candles from the free public exchange registry.
//
// The registry (`_shared/exchange-market`) already carries four keyless public
// venues (Binance, Coinbase, Kraken, KuCoin) and a cached ticker table that says
// which of them lists a symbol and how much volume each one carries. That is the
// cheapest and finest-grained candle source the platform has: it costs no
// CoinMarketCap credit and it samples down to one minute. So it is the FIRST rung
// of the ladder for any asset with a VERIFIED exchange identity.
//
// Honesty rules:
//   * The venue is chosen by 24-hour quote volume, and the coverage sentence
//     names it. A chart never says "an exchange" without saying which one.
//   * A venue that cannot sample the requested width is not asked for it. The
//     width vocabulary lives in `candle-ladder.ts` (`VENUE_CANDLES`), where
//     Coinbase is deliberately NOT offered 4-hour candles: its granularity map
//     resolves `4h` to 3600 seconds, so the bars would be hourly.
//   * Only CLOSED periods are kept. The provider marks the period in progress
//     with `committed: false`; it is dropped rather than drawn as a candle.
//   * A zero volume is a completed period in which nothing traded and stays a
//     zero. A volume the venue did not report stays null.
//   * One request is the whole answer. A window needing more periods than the
//     venue returns is answered with the newest it can, and the coverage
//     sentence says how far back they reach.
//
// Nothing here calls a venue directly: the registry lookup and the ticker read
// are both injectable, so the module tests without a network or a database.

import { getProvider } from '../exchange-market/provider-registry.ts'
import type { ProviderId } from '../exchange-market/types.ts'
import { normalizeBars, type Bar } from './chart-analysis.ts'
import { candlePlan, candleCoverage, EXCHANGE_INTERVALS, VENUE_CANDLES, type CandlePlan } from './candle-ladder.ts'

export const EXCHANGE_SOURCE = 'exchange'
/** Venues considered for one chart, best volume first. More than this and the
 * fallback walk costs more than the answer is worth. */
export const VENUE_CANDIDATES = 3

export interface ExchangeCandleDeps {
  // deno-lint-ignore no-explicit-any
  provider?: (id: ProviderId) => any
  // deno-lint-ignore no-explicit-any
  tickers?: (db: any, symbol: string) => Promise<any[]>
}

/** Cached venue listings for one normalized symbol, best quote volume first. A
 * failed read is an empty candidate list, never a thrown chart. */
// deno-lint-ignore no-explicit-any
async function readTickers(db: any, symbol: string): Promise<any[]> {
  try {
    const { data, error } = await db.from('exchange_latest_tickers')
      .select('provider, provider_symbol, quote_asset, volume_quote_24h')
      .eq('normalized_symbol', symbol)
      .order('volume_quote_24h', { ascending: false })
      .limit(8)
    if (error) return []
    return Array.isArray(data) ? data : data ? [data] : []
  } catch { return [] }
}

/** Venue kline snapshots → chart bars. `closeTime` is the venue's own, so the
 * close is a provider fact here rather than something derived. */
// deno-lint-ignore no-explicit-any
export function exchangeBars(klines: any[], now: number): Bar[] {
  const bars = (klines || []).flatMap((k) => {
    const t = Number(k?.openTime), closedAt = Number(k?.closeTime)
    if (!Number.isFinite(t) || t <= 0 || !Number.isFinite(closedAt) || closedAt <= t) return []
    // The period still in progress is not a candle.
    if (k?.committed === false || closedAt > now) return []
    const c = Number(k?.close)
    if (!Number.isFinite(c)) return []
    // `Number(null)` is 0, so an absent value must be rejected BEFORE conversion:
    // a volume the venue did not report is not a period with no trades.
    const value = (v: unknown) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
    const volume = value(k?.volumeBase)
    return [{
      t, closedAt, o: value(k?.open), h: value(k?.high), l: value(k?.low), c,
      // A period with no trades is a real zero; an unreported volume stays null.
      v: volume != null && volume >= 0 ? volume : null,
      volumeKind: 'period' as const,
    }]
  })
  return normalizeBars(bars).bars
}

export interface ExchangeCandleResult {
  candles: Bar[]
  source: string
  timestampMeaning: 'open'
  barIntervalMs: number | null
  volumeUnit: string
  currency: string | null
  coverage: string
  sourceState: string
  sourceReason: string | null
  bestPair: string | null
  bestProvider: string | null
  plan: CandlePlan | null
  // deno-lint-ignore no-explicit-any
  provenance: any[]
}

const EMPTY = (reason: string, coverage: string, plan: CandlePlan | null = null): ExchangeCandleResult => ({
  candles: [], source: EXCHANGE_SOURCE, timestampMeaning: 'open', barIntervalMs: plan?.step ?? null,
  volumeUnit: 'base asset', currency: null, coverage, sourceState: 'unavailable', sourceReason: reason,
  bestPair: null, bestProvider: null, plan, provenance: [],
})

/**
 * Candles for ONE normalized symbol from the best public venue that lists it.
 *
 * Returns the same shape the other chart sources return, so the detail response,
 * `chartSeriesResponse` and the renderer treat it like any other source.
 */
// deno-lint-ignore no-explicit-any
export async function loadExchangeCandles(db: any, symbol: string, range = '7D', interval = 'auto',
  now = Date.now(), deps: ExchangeCandleDeps = {}): Promise<ExchangeCandleResult> {
  const normalized = String(symbol || '').toUpperCase().trim()
  if (!normalized) return EMPTY('missing_symbol', 'No normalized symbol for this asset, so no public exchange listing can be looked up.')
  const rows = await (deps.tickers ?? readTickers)(db, normalized)
  if (!rows.length) return EMPTY('no_exchange_listing', `No cached public exchange listing for ${normalized}.`)

  const attempted: string[] = []
  let lastReason: string | null = null
  let lastPlan: CandlePlan | null = null
  for (const row of rows.slice(0, VENUE_CANDIDATES)) {
    const venue = String(row?.provider || '')
    const limits = VENUE_CANDLES[venue]
    const providerSymbol = String(row?.provider_symbol || '')
    if (!limits || !providerSymbol) { lastReason = lastReason || 'unknown_venue'; continue }
    let plan: CandlePlan
    try { plan = candlePlan(range, interval, limits, now) } catch { return EMPTY('invalid_chart_parameters', 'The requested range and interval are not an exchange sampling.') }
    lastPlan = plan
    const providerInterval = EXCHANGE_INTERVALS[plan.selected]
    if (!providerInterval) { lastReason = lastReason || 'unsupported_interval'; continue }
    attempted.push(venue)
    // deno-lint-ignore no-explicit-any
    let klines: any[] | null = null
    try {
      const provider = (deps.provider ?? getProvider)(venue as ProviderId)
      // deno-lint-ignore no-explicit-any
      klines = provider ? await provider.getKlines(providerSymbol, providerInterval, plan.limit, { supabase: db, jobName: 'intel-markets-candles', kind: 'request' } as any) : null
    } catch { klines = null }
    if (!klines || !klines.length) { lastReason = lastReason || 'venue_unavailable'; continue }
    const bars = exchangeBars(klines, now).filter((bar) => bar.t >= plan.from && (bar.closedAt ?? bar.t) <= plan.to)
    if (!bars.length) { lastReason = lastReason || 'no_completed_candles'; continue }
    const coverage = candleCoverage({
      plan, source: venue, oldest: bars[0]?.t ?? null, count: bars.length, reason: null,
      extra: [
        `Volume is the base asset for each completed period; a period with no trades is a real zero.`,
        attempted.length > 1 ? `${attempted.slice(0, -1).join(', ')} could not answer (${lastReason || 'no_completed_candles'}).` : null,
      ],
    })
    return {
      candles: bars, source: venue, timestampMeaning: 'open', barIntervalMs: plan.step,
      volumeUnit: 'base asset', currency: row?.quote_asset ? String(row.quote_asset) : null,
      coverage, sourceState: 'fresh', sourceReason: null,
      bestPair: providerSymbol, bestProvider: venue, plan, provenance: [],
    }
  }
  const reason = lastReason || 'no_completed_candles'
  return EMPTY(reason, attempted.length
    ? `No completed candles for ${normalized} from ${attempted.join(', ')} (${reason}).`
    : `No public venue lists ${normalized} at this interval (${reason}).`, lastPlan)
}
