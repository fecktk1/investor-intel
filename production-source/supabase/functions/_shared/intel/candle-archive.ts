// Investor Intel — the stored candle archive (`market_asset_candles`).
//
// A provider window is the last year at best; Bitcoin has traded since 2010. The
// archive is fetched ONCE per asset, from the first period the source can reach,
// and then extended forward by a daily append. This module is the READ half: it
// turns stored rows into chart bars and merges them with the provider's recent
// tail so a long range is one continuous series.
//
// Honesty rules:
//   * The archive and the provider tail are MERGED, not concatenated. Where the
//     two overlap the PROVIDER row wins, because it is the newer observation of
//     the same period; the archive fills only what the provider window cannot
//     reach.
//   * A stored zero volume is a real zero and stays one. A stored NULL volume is
//     a period whose volume was never reported and stays NULL — it is never
//     read as zero.
//   * The coverage sentence says how many candles came from the archive and
//     where the archive ends, so a reader can see which part of the chart is
//     stored history and which part is live.
//   * A failed archive read is a REASON, never a silently short chart.
//
// The table is service-role only. This module runs inside the Edge Functions,
// which hold the service role; Intel members reach it only through those reads.

import { aggregateOhlcv } from './cmc-chart.ts'
import { normalizeBars, type Bar } from './chart-analysis.ts'

const DAY = 86_400_000

/** App interval → the interval string stored in `market_asset_candles`. Only
 * these two are stored; every wider app interval is AGGREGATED from stored daily
 * candles rather than stored a second time. */
export const STORED_INTERVALS: Record<string, string> = { '1H': '1h', '1D': '1d' }
/** App intervals the archive can answer at all: the two it stores, plus the
 * weekly candle it can build from complete daily ones. */
export const ARCHIVE_INTERVALS = ['1H', '1D', '1W'] as const
export const archiveCanAnswer = (interval: unknown) => (ARCHIVE_INTERVALS as readonly string[]).includes(String(interval))

/** Rows one archive read may return. 20 years of daily candles is about 7,300;
 * the cap leaves room for that and for an hourly month, and a read that hits it
 * says so rather than quietly losing the oldest years. */
export const ARCHIVE_ROW_CAP = 9_000

export const CANDLE_COLUMNS = 'asset_key,provider,candle_interval,candle_time,open,high,low,close,volume,source_ref,recorded_at'

/** Two sources may both hold the same period for one asset: a venue filled the
 * years it lists and CoinMarketCap OHLCV filled the years before that. Both rows
 * are kept, because they are two measurements and neither is a correction of the
 * other, and the READ picks one with a stated precedence: an actual traded venue
 * beats an aggregate, and the aggregate beats nothing. The rule is deterministic,
 * so the same window always renders the same series. */
export const ARCHIVE_PROVIDER_RANK: Record<string, number> = {
  binance: 0, coinbase: 1, kraken: 2, kucoin: 3, coinmarketcap: 4, coinmarketcap_kline: 5, coingecko: 6,
}
export const archiveProviderRank = (provider: unknown) => ARCHIVE_PROVIDER_RANK[String(provider)] ?? 99

/** One row per period, chosen by that precedence. */
// deno-lint-ignore no-explicit-any
export function preferArchiveProvider(rows: any[]): any[] {
  const byTime = new Map<string, any>()
  for (const row of rows) {
    const key = String(row?.candle_time ?? '')
    const held = byTime.get(key)
    if (!held || archiveProviderRank(row?.provider) < archiveProviderRank(held.provider)) byTime.set(key, row)
  }
  return [...byTime.values()]
}

const num = (v: unknown): number | null => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }

/** One stored row → one chart bar. `closedAt` is derived from the stored
 * interval, which is the period the row was written for; it is an assertion
 * about that period, not a provider field, and the coverage sentence says so. */
// deno-lint-ignore no-explicit-any
export function archiveBar(row: any, step: number): Bar | null {
  const t = Date.parse(String(row?.candle_time ?? ''))
  if (!Number.isFinite(t)) return null
  const c = num(row?.close)
  if (c == null) return null
  const recorded = Date.parse(String(row?.recorded_at ?? ''))
  const volume = num(row?.volume)
  return {
    t, closedAt: t + step - 1, o: num(row?.open), h: num(row?.high), l: num(row?.low), c,
    // A stored zero is a completed period with no trades. A stored NULL is a
    // period whose volume was never reported and is NOT read as zero.
    v: volume != null && volume >= 0 ? volume : null,
    volumeKind: 'period' as const,
    ...(Number.isFinite(recorded) ? { recordedAt: recorded } : {}),
  }
}

export interface ArchiveRead { bars: Bar[]; reason: string | null; truncated: boolean; rows: number }

/** Stored candles for one asset over one window, oldest first. */
// deno-lint-ignore no-explicit-any
export async function readArchiveCandles(db: any, assetKey: string, interval: string, from: number, to: number,
  cap = ARCHIVE_ROW_CAP): Promise<ArchiveRead> {
  const stored = STORED_INTERVALS[interval] || (interval === '1W' ? '1d' : null)
  if (!assetKey || !stored) return { bars: [], reason: 'interval_not_archived', truncated: false, rows: 0 }
  const step = stored === '1h' ? 3_600_000 : DAY
  try {
    const { data, error } = await db.from('market_asset_candles').select(CANDLE_COLUMNS)
      .eq('asset_key', assetKey).eq('candle_interval', stored)
      .gte('candle_time', new Date(from).toISOString())
      .lte('candle_time', new Date(to).toISOString())
      .order('candle_time', { ascending: true }).limit(cap)
    if (error) return { bars: [], reason: String(error.message || error.code || error).slice(0, 200), truncated: false, rows: 0 }
    const rows = Array.isArray(data) ? data : data ? [data] : []
    const bars = normalizeBars(preferArchiveProvider(rows).map((row) => archiveBar(row, step)).filter((bar): bar is Bar => !!bar)).bars
    return { bars, reason: null, truncated: rows.length >= cap, rows: rows.length }
  } catch (e) { return { bars: [], reason: ((e as Error)?.message || 'archive_read_failed').slice(0, 200), truncated: false, rows: 0 } }
}

/**
 * Archive bars at the requested app interval.
 *
 * '1H' and '1D' are stored and read directly. '1W' is AGGREGATED from complete
 * daily candles through the same `aggregateOhlcv` the OHLCV path uses, so an
 * incomplete week is omitted rather than drawn from a partial set of days.
 */
// deno-lint-ignore no-explicit-any
export async function archiveSeries(db: any, assetKey: string, interval: string, from: number, to: number,
  now = Date.now(), cap = ARCHIVE_ROW_CAP): Promise<ArchiveRead & { incomplete: number }> {
  const read = await readArchiveCandles(db, assetKey, interval, from, to, cap)
  if (interval !== '1W' || !read.bars.length) return { ...read, incomplete: 0 }
  const aggregate = aggregateOhlcv(read.bars, DAY, 7 * DAY, now)
  return { ...read, bars: aggregate.bars, incomplete: aggregate.incomplete }
}

export interface MergeResult { candles: Bar[]; archived: number; live: number; archiveTo: number | null; archiveFrom: number | null }

/** Archive + provider tail, keyed on the period open. Where both hold the same
 * period the PROVIDER row wins: it is the newer observation of that period. */
export function mergeCandles(archive: Bar[], tail: Bar[]): MergeResult {
  const byTime = new Map<number, Bar>()
  for (const bar of archive) byTime.set(bar.t, bar)
  const tailTimes = new Set(tail.map((bar) => bar.t))
  for (const bar of tail) byTime.set(bar.t, bar)
  const candles = [...byTime.values()].sort((a, b) => a.t - b.t)
  const archived = archive.filter((bar) => !tailTimes.has(bar.t)).length
  return {
    candles, archived, live: candles.length - archived,
    archiveFrom: archive[0]?.t ?? null, archiveTo: archive.at(-1)?.t ?? null,
  }
}
