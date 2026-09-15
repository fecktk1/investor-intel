// Investor Intel — CoinMarketCap k-line candles for contract-only assets
// (CMC plan proposal 24, Stage 4).
//
// `/v1/k-line/candles` is the only CoinMarketCap series a token WITHOUT a CMC
// listing can have: it is keyed by (platform, contract address) and aggregates
// every pool on that chain, so it is a strictly better answer than one
// GeckoTerminal pool — which is why the ladder in `intel-markets` tries it
// FIRST for a contract identity on a verified CMC DEX chain, and falls through
// to the pool unchanged when it cannot answer.
//
// `loadKlineChart` returns EXACTLY the object shape `loadCmcChart` returns, so
// the detail response, `chartSeriesResponse` and the renderer treat it like any
// other chart source. What differs, and is stated rather than hidden:
//
//   * TIMESTAMPS. The provider's `t` is the candle OPEN, in SECONDS (values
//     below 1e12 are multiplied by 1000; a provider that ever sends
//     milliseconds is therefore also read correctly).
//   * `closedAt` IS SYNTHESISED. The endpoint publishes no close time. We
//     compute `closedAt = t + barIntervalMs - 1` from the interval the request
//     pinned. It is an assertion about the period we asked for, NOT a provider
//     fact, and the coverage sentence says so on every chart.
//   * VOLUME is USD (`unit: 'usd'` is pinned on the request) and is a per-period
//     figure, not a running snapshot. A zero-volume period is a real, completed
//     period with no trades: its zero is kept as a zero and never dropped.
//   * SUB-MINUTE IS REFUSED. `cmc-capabilities.ts` registers the eight named
//     candle widths the endpoint documents (`1min` … `1w`); there is no
//     sub-minute width, and the app vocabulary has no key for one. The audit's
//     "sub-minute launch replay" is therefore NOT available, and this module
//     does not pretend otherwise by relabelling a one-minute candle.
//   * PLAN. `dexCandles` is a Startup capability. Below Startup the rung is
//     skipped with `sourceReason: 'plan_below_startup'` and spends nothing; the
//     ladder then continues to the pool source exactly as it does today.
//
// NO `from`/`to`: A LATEST-N REQUEST, NOT A WINDOWED HISTORY REQUEST.
// Probed live on 2026-09-15 with the owner's Startup key:
//
//   platform=base address=0x8d01…6207 interval=1h limit=168 from=1788840000 to=1789444800
//     -> HTTP 403, insufficient_entitlement
//   platform=base address=0x8d01…6207 interval=1h limit=5   (no from/to)
//     -> HTTP 200, 1 credit
//
// So a WINDOWED history request is above the plan and a "newest N candles"
// request is not. This module therefore asks for the newest `limit` candles
// (one request, no paging — paging needs a window) and applies the app window
// LOCALLY, dropping anything older than the requested range. When the newest
// candles do not reach back to the window start the coverage sentence says how
// far back they actually reach, rather than presenting a short series as a
// complete one. The registry still accepts `from`/`to` (they are documented
// parameters and remain validated as seconds); nothing here sends them.
//
// Nothing here calls CoinMarketCap directly: the transport and the plan read are
// injected through `deps`, so the module tests without a network or a database.

import { requestCmc, cmcPlan } from '../market-assets/cmc-transport.ts'
import { loadCmcOperatingSettings } from '../market-assets/cmc-operating-settings.ts'
import { planAllows, CMC_CAPABILITIES } from '../market-assets/cmc-capabilities.ts'
import { cmcDexIdentity, cmcDexParams, type CmcDexIdentity } from '../market-assets/cmc-dex.ts'
import { normalizeBars, type Bar } from './chart-analysis.ts'
import { CHART_WINDOWS, CHART_INTERVALS, isSubHourInterval } from './cmc-chart.ts'
import { contractCandles } from './contract-market-asset.ts'
import { getChain } from '../chains.ts'
import type { MarketAssetsContext } from '../market-assets/types.ts'

const HOUR = 3_600_000, DAY = 86_400_000

/** App interval key → the provider's named candle width. The registry accepts
 * exactly these eight (`klineIntervals` in `cmc-capabilities.ts`). */
export const KLINE_INTERVALS: Record<string, string> = {
  '1M': '1min', '5M': '5min', '15M': '15min', '30M': '30min',
  '1H': '1h', '4H': '4h', '1D': '1d', '1W': '1w',
}
/** The registry caps `limit` at 1000 for `dexCandles`, and one request is the
 * whole chart: without `from`/`to` there is no cursor to page with. */
export const KLINE_LIMIT = 1000
/** One request a chart, so one asset page spends exactly one credit. */
export const KLINE_MAX_CALLS = 1
export const KLINE_SOURCE = 'coinmarketcap_kline'

export interface KlineDeps {
  // deno-lint-ignore no-explicit-any
  request?: (name: string, params?: Record<string, unknown>, ctx?: MarketAssetsContext) => Promise<any>
  // deno-lint-ignore no-explicit-any
  plan?: (db: any, now: number) => Promise<string>
}

// deno-lint-ignore no-explicit-any
const defaultPlan = async (db: any, now: number): Promise<string> => {
  try { return cmcPlan(now, await loadCmcOperatingSettings(db)) } catch { return 'basic' }
}

/** Seconds or milliseconds → milliseconds. The provider documents seconds; a
 * value already at millisecond magnitude is left alone rather than multiplied
 * into the year 57000. */
export const klineEpochMs = (value: unknown): number | null => {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.trunc(n < 1e12 ? n * 1000 : n)
}

/** The app interval this window gets when the caller asked for `auto`.
 * ≤1H → 1 minute, ≤12H → 5 minutes, ≤24H → 15 minutes, ≤7D → 1 hour, else 1 day. */
export function klineAutoInterval(durationMs: number): string {
  if (durationMs <= HOUR) return '1M'
  if (durationMs <= 12 * HOUR) return '5M'
  if (durationMs <= DAY) return '15M'
  if (durationMs <= 7 * DAY) return '1H'
  return '1D'
}

export interface KlinePlan {
  selected: string; providerInterval: string; step: number
  /** Window the CALLER asked for, in ms. Applied locally to whatever comes back. */
  from: number; to: number
  /** How many completed periods the window needs, before the 1000 ceiling. */
  wanted: number
  /** Extra completed periods GRANTED before the window, the warm-up a study needs
   * to have a value at the first visible bar. The window takes the ceiling first,
   * so this is only what `KLINE_LIMIT` had left over. */
  lookback: number
  /** True when the window needs more periods than one request can return. */
  capped: boolean
  /** The one request: a named candle width and a count. No `from`/`to`. */
  request: { interval: string; limit: number }
}

/** Request plan for one chart: the newest `limit` candles at one named width.
 * There is no window in the request — see the header probe — so there is nothing
 * to page with, and `from`/`to` exist only to trim what comes back.
 *
 * `lookback` asks for extra completed periods BEFORE the window so a study has a
 * value at the first visible bar. The window is served first: the warm-up takes
 * only what the 1000-candle ceiling has left. */
export function klinePlan(timeframe = '7D', interval = 'auto', now = Date.now(), lookback = 0): KlinePlan {
  const duration = CHART_WINDOWS[timeframe]
  if (!duration || !Number.isFinite(now)) throw new Error('invalid_chart_parameters')
  const selected = interval === 'auto' ? klineAutoInterval(duration) : interval
  const step = CHART_INTERVALS[selected]
  if (!step || !KLINE_INTERVALS[selected]) throw new Error('invalid_chart_parameters')
  // `to` is the OPEN of the period still in progress; every candle we keep is a
  // period that has already closed.
  const to = Math.floor(now / step) * step
  const wanted = Math.ceil(duration / step)
  const asked = Number.isFinite(Number(lookback)) ? Math.trunc(Number(lookback)) : 0
  // The window first, the warm-up with what is left of the one-request ceiling.
  const granted = Math.min(Math.max(0, asked), Math.max(0, KLINE_LIMIT - wanted - 1))
  // One extra period, because the newest row the provider returns is usually the
  // period still in progress and is dropped locally.
  const limit = Math.max(1, Math.min(KLINE_LIMIT, wanted + granted + 1))
  return {
    selected, providerInterval: KLINE_INTERVALS[selected], step,
    // `capped` stays about the WINDOW: a chart is short when the range does not
    // fit in one request, never because a warm-up request was trimmed.
    from: to - (wanted + granted) * step, to, wanted, lookback: granted, capped: wanted + 1 > KLINE_LIMIT,
    request: { interval: KLINE_INTERVALS[selected], limit },
  }
}

/** Positional k-line rows → chart bars. `closedAt` is synthesised from the
 * interval; a zero volume is a real zero and stays one. Rows outside the plan's
 * window, and the period still in progress, are dropped rather than drawn. */
// deno-lint-ignore no-explicit-any
export function klineBars(payload: any, step: number, recordedAt: number | null, now: number): Bar[] {
  const data = payload?.data ?? payload
  const raw = Array.isArray(data) ? data : Array.isArray(data?.candles) ? data.candles : []
  const bars = raw.flatMap((row: unknown) => {
    if (!Array.isArray(row) || row.length < 6) return []
    const t = klineEpochMs(row[5])
    if (t == null) return []
    const closedAt = t + step - 1
    if (closedAt > now) return []
    const [o, h, l, c, v] = row.slice(0, 5).map((x: unknown) => { const n = Number(x); return Number.isFinite(n) ? n : null })
    if (c == null) return []
    return [{
      t, closedAt, o, h, l, c,
      // A zero-volume period is a completed period in which nothing traded.
      v: v != null && v >= 0 ? v : null,
      volumeKind: 'period' as const, volumeUnit: 'USD' as const,
      ...(recordedAt != null ? { recordedAt } : {}),
    }]
  })
  return normalizeBars(bars).bars
}

/** The CMC DEX identity of a market-asset row, or null when the asset names no
 * contract on one of the four verified CMC DEX chains. The app chain id is
 * translated through the authoritative chain registry, so a chain whose CAIP
 * reference changes there cannot silently point at the wrong network. */
// deno-lint-ignore no-explicit-any
export function klineIdentity(asset: any): CmcDexIdentity | null {
  const chainId = String(asset?.contract?.chain || asset?.primary_chain || '')
  let address = asset?.contract?.address ? String(asset.contract.address) : ''
  if (!address) {
    const entries = Object.entries(asset?.platforms || {}).filter(([key, value]) => typeof value === 'string' && value && key === chainId)
    if (entries.length === 1) address = String(entries[0][1])
  }
  const chain = getChain(chainId)
  if (!chain || !address) return null
  const caip = chain.namespace === 'solana' ? 'solana' : `${chain.namespace}:${chain.caip2Ref}`
  return cmcDexIdentity(caip === 'solana' ? `solana:${address}` : `${caip}:${address}`)
}

const EMPTY = (reason: string, step: number | null, coverage: string) => ({
  candles: [] as Bar[], source: KLINE_SOURCE, timestampMeaning: 'open' as const,
  barIntervalMs: step, volumeUnit: 'USD', coverage,
  sourceState: 'unavailable', sourceReason: reason,
  // deno-lint-ignore no-explicit-any
  provenance: [] as any[], bestPair: null, bestProvider: null as string | null,
})

/**
 * Candles for ONE contract identity from `/v1/k-line/candles`.
 *
 * Returns the same object `loadCmcChart` returns; `source` is
 * `coinmarketcap_kline` so a reader can never confuse a DEX aggregate with the
 * listed-asset OHLCV series.
 */
// deno-lint-ignore no-explicit-any
export async function loadKlineChart(admin: any, identity: CmcDexIdentity, timeframe = '7D', interval = 'auto',
  now = Date.now(), context: MarketAssetsContext = {}, deps: KlineDeps = {}, lookback = 0) {
  if (!identity?.platform || !identity?.address) return EMPTY('missing_identifier', null, 'No verified CoinMarketCap DEX contract identity for this asset.')
  let plan: KlinePlan
  try { plan = klinePlan(timeframe, interval, now, lookback) } catch { return EMPTY('invalid_chart_parameters', null, 'The requested range and interval are not a k-line sampling.') }

  // A capability above the current plan is never attempted: the rung is skipped
  // with a reason and the ladder continues, the way `network_stats` is skipped
  // below Growth rather than spending a call to discover it.
  const account = await (deps.plan ?? defaultPlan)(admin, now)
  if (!planAllows(account, CMC_CAPABILITIES.dexCandles.tier)) {
    return EMPTY('plan_below_startup', plan.step, `CoinMarketCap k-line candles need a ${CMC_CAPABILITIES.dexCandles.tier} plan; the current plan is ${account}.`)
  }

  const request = deps.request ?? requestCmc
  const ctx = { ...context, supabase: admin, kind: 'request' as const, caller: 'contract-kline-chart', maxCalls: KLINE_MAX_CALLS }
  // ONE request: the newest `limit` candles at one width, no `from`/`to`.
  const params = cmcDexParams('dexCandles', identity, { interval: plan.request.interval, unit: 'usd', limit: plan.request.limit })
  // deno-lint-ignore no-explicit-any
  let result: any = null
  try { result = await request('dexCandles', params, ctx) } catch { result = null }
  const reason = (result ? result.reason : 'provider_unavailable') || null
  // deno-lint-ignore no-explicit-any
  const provenance: any[] = result?.provenance ? [result.provenance] : []
  const recorded = Date.parse(result?.provenance?.fetchedAt || '')
  const returned = klineBars(result?.payload, plan.step, Number.isFinite(recorded) ? recorded : null, now)
  // The window is applied HERE, to what came back — the request could not carry it.
  const candles = returned.filter((bar) => bar.t >= plan.from && (bar.closedAt ?? bar.t) <= plan.to)
  // How far back the answer genuinely reaches, so a short series is never
  // presented as a complete one.
  const oldestReturned = returned[0]?.t ?? null
  // The shortfall sentence is about the WINDOW the reader asked for; warm-up
  // periods sit before it and their absence does not shorten the range.
  const windowFrom = plan.to - plan.wanted * plan.step
  const reachesWindowStart = oldestReturned != null && oldestReturned <= windowFrom + plan.step
  const span = (ms: number) => {
    const [unit, n] = ms >= DAY ? ['day', Math.round(ms / DAY)] as const : ['hour', Math.round(ms / HOUR)] as const
    return `${n} ${unit}${n === 1 ? '' : 's'}`
  }
  const coverage = [
    `${plan.selected} completed ${plan.providerInterval} candles from the CoinMarketCap k-line aggregate for ${identity.label}; every pool on the chain, not one pair.`,
    'Timestamps are period opens reported in seconds; the close time is derived from the requested interval, not reported by the provider.',
    'Volume is USD for each completed period; a period with no trades is a real zero.',
    // The endpoint answers "the newest N candles"; a dated window is above this
    // plan (403 insufficient_entitlement), so the range is applied after the fact.
    `The provider was asked for the newest ${plan.request.limit} candles and the ${timeframe} range was applied locally.`,
    plan.capped ? `${timeframe} at this interval needs ${plan.wanted} periods, more than the ${KLINE_LIMIT}-candle ceiling of one request.` : null,
    candles.length && !reachesWindowStart
      ? `They reach back about ${span(plan.to - oldestReturned!)}, not the full ${timeframe} range.`
      : null,
    reason ? `Some candles are unavailable (${reason}).` : null,
  ].filter(Boolean).join(' ')
  const state = result?.state
  return {
    candles, source: KLINE_SOURCE, timestampMeaning: 'open' as const, barIntervalMs: plan.step, volumeUnit: 'USD',
    coverage: candles.length ? coverage : `${coverage} No completed candles were returned for this window.`.trim(),
    sourceState: candles.length ? (state === 'fresh' ? 'fresh' : 'stale') : 'unavailable',
    // `insufficient_entitlement`, `budget_exceeded` and the rest survive onto the
    // ladder, which names them in the pool source's coverage sentence.
    sourceReason: candles.length ? reason : (reason ?? 'no_completed_candles'),
    provenance, bestPair: null, bestProvider: candles.length ? KLINE_SOURCE : null,
  }
}

export interface LadderDeps extends KlineDeps {
  kline?: typeof loadKlineChart
  pool?: typeof contractCandles
}

/**
 * The candle ladder for a CONTRACT identity: the CoinMarketCap k-line aggregate
 * first when the contract sits on a verified CMC DEX chain, then the
 * GeckoTerminal pool exactly as before.
 *
 * The k-line rung covers every pool on the chain, so preferring it over a single
 * pool is not a provider preference — it is a wider measurement of the same
 * asset. When it cannot answer (no verified chain, plan below Startup, budget,
 * outage, or no completed candles) the pool answer is returned unchanged, with
 * the k-line reason appended to its coverage so the page can say what was tried.
 */
// deno-lint-ignore no-explicit-any
export async function contractCandleLadder(admin: any, canonical: any, timeframe = '7D', interval = 'auto',
  context: MarketAssetsContext = {}, deps: LadderDeps = {}, now = Date.now(), lookback = 0) {
  const identity = klineIdentity(canonical)
  let klineReason = 'no_cmc_dex_chain'
  if (identity) {
    // The warm-up travels with the k-line request. The pool source below has no
    // period vocabulary of its own to extend, so it answers its usual window.
    const kline = await (deps.kline ?? loadKlineChart)(admin, identity, timeframe, interval, now, context, deps, lookback)
    if (kline.candles.length) return kline
    klineReason = kline.sourceReason || 'no_completed_candles'
  }
  // The pool source has no sub-hour timeframe. Asking it for one would be
  // answered with DAILY candles under a one-minute label, so the request falls
  // back to the automatic spacing and the coverage sentence states it.
  const subHour = isSubHourInterval(interval)
  const pool = await (deps.pool ?? contractCandles)(canonical, timeframe, subHour ? 'auto' : interval, { supabase: admin, jobName: 'intel-markets' })
  const note = [
    // deno-lint-ignore no-explicit-any
    (pool as any).coverage || null,
    `CoinMarketCap k-line candles are unavailable (${klineReason}); showing pool history.`,
    subHour ? 'Sub-hour candles come only from the CoinMarketCap k-line aggregate, so this pool series uses its own spacing.' : null,
  ].filter(Boolean).join(' ')
  return { ...pool, coverage: note, klineReason }
}
