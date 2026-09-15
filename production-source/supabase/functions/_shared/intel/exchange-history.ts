// Investor Intel — free deep daily history from a public exchange.
//
// The candle ladder's exchange rung answers a CHART: the newest N candles at one
// width. The archive backfill needs something different — every daily candle an
// asset has ever had — and that needs a WINDOWED, paged request.
//
// Only Binance is used for this. The reason is the venue APIs themselves, not a
// preference:
//
//   * binance  `/api/v3/klines` takes `startTime` and `limit=1000` and pages
//     forward from any date. Spot daily klines reach back to the pair's listing,
//     which for the majors is 2017. Keyless and free.
//   * kraken   `/public/OHLC` accepts `since` but answers at most 720 candles
//     ANCHORED ON THE PRESENT — it cannot be paged backwards, so it cannot
//     reconstruct a decade.
//   * kucoin   pages with `startAt`/`endAt` but the adapter's request is built
//     from a limit, not a window.
//   * coinbase answers 300 candles with no window in the adapter's request.
//
// Rather than pretend the other three can do something they cannot, the lane
// falls to CoinMarketCap OHLCV for an asset Binance does not list. That choice is
// recorded per asset in the backfill state table, so the source of every stored
// year is visible.
//
// `callExchange` is injected, so this module tests without a network.

import { callExchange } from '../exchange-market/http.ts'
import type { Bar } from './chart-analysis.ts'

const DAY = 86_400_000

/** Rows one Binance klines request returns. */
export const BINANCE_PAGE = 1000
/** Pages one asset may take in a single backfill. 1000 daily candles a page, so
 * this reaches back about 27 years — more than the venue has ever existed. */
export const BINANCE_MAX_PAGES = 10
/** Binance spot opened in July 2017; nothing earlier exists to ask for. */
export const BINANCE_EPOCH_MS = Date.UTC(2017, 6, 1)

export interface ExchangeHistoryDeps {
  // deno-lint-ignore no-explicit-any
  call?: typeof callExchange | ((provider: any, opts: any) => Promise<any>)
}

/** One raw Binance kline array → a daily bar. A row whose open time is not on a
 * UTC day boundary is dropped rather than stored under a day it does not
 * describe. */
export function binanceDailyBar(row: unknown, now: number): Bar | null {
  if (!Array.isArray(row) || row.length < 7) return null
  const t = Number(row[0]), closeTime = Number(row[6])
  if (!Number.isFinite(t) || t <= 0 || t % DAY !== 0) return null
  // The day still in progress is not a completed candle.
  if (!Number.isFinite(closeTime) || closeTime > now) return null
  // `Number(null)` is 0, so an absent value must be rejected BEFORE conversion:
  // a volume the venue did not report is not a period with no trades.
  const value = (v: unknown) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
  const c = value(row[4])
  if (c == null) return null
  const volume = value(row[5])
  return {
    t, closedAt: t + DAY - 1, o: value(row[1]), h: value(row[2]), l: value(row[3]), c,
    // A day with no trades is a real zero; an unreported volume stays null.
    v: volume != null && volume >= 0 ? volume : null,
    volumeKind: 'period' as const,
  }
}

export interface ExchangeHistory { bars: Bar[]; pages: number; reason: string | null; complete: boolean }

/**
 * Every completed daily candle Binance holds for one pair between `from` and
 * `to`, paged forward.
 *
 * `complete` is true when the walk ran out of ROWS rather than out of PAGES: the
 * asset's whole Binance history is in `bars`. When it ran out of pages the
 * caller must not record the oldest returned candle as the asset's first day.
 */
// deno-lint-ignore no-explicit-any
export async function binanceDailyHistory(ctx: any, providerSymbol: string, from: number, to: number,
  now = Date.now(), deps: ExchangeHistoryDeps = {}): Promise<ExchangeHistory> {
  const symbol = String(providerSymbol || '').trim()
  if (!symbol) return { bars: [], pages: 0, reason: 'missing_symbol', complete: false }
  const call = deps.call ?? callExchange
  const start = Math.max(BINANCE_EPOCH_MS, Math.floor(Math.max(0, from) / DAY) * DAY)
  const end = Math.min(to, now)
  const bars: Bar[] = []
  let cursor = start, pages = 0, reason: string | null = null, complete = false
  while (pages < BINANCE_MAX_PAGES && cursor <= end) {
    pages += 1
    // deno-lint-ignore no-explicit-any
    let response: any = null
    try {
      response = await call('binance' as never, {
        path: `/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1d&startTime=${cursor}&limit=${BINANCE_PAGE}`,
        endpoint: '/api/v3/klines', ttl: 'klines', weight: 2, symbol, ctx,
      } as never)
    } catch { response = null }
    if (!response?.ok || !Array.isArray(response.data)) { reason = reason || 'venue_unavailable'; break }
    const page = response.data as unknown[]
    if (!page.length) { complete = true; break }
    for (const row of page) {
      const bar = binanceDailyBar(row, now)
      if (bar && bar.t >= start && bar.t <= end) bars.push(bar)
    }
    const lastOpen = Number((page.at(-1) as unknown[])?.[0])
    if (!Number.isFinite(lastOpen) || lastOpen < cursor) { reason = reason || 'malformed_page'; break }
    cursor = lastOpen + DAY
    if (page.length < BINANCE_PAGE) { complete = true; break }
  }
  const byTime = new Map<number, Bar>()
  for (const bar of bars) byTime.set(bar.t, bar)
  return { bars: [...byTime.values()].sort((a, b) => a.t - b.t), pages, reason, complete }
}
