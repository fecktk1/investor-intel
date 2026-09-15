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
/** One page. The registry caps `limit` at 1000 for `dexCandles`. */
export const KLINE_PAGE = 1000
/** At most four pages a chart, so one asset page can never spend an unbounded
 * number of credits on a wide window at a fine interval. A window that needs
 * more keeps its NEWEST candles and the coverage sentence says it was cut. */
export const KLINE_MAX_PAGES = 4
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
  from: number; to: number; limited: boolean
  pages: { interval: string; from: number; to: number; limit: number }[]
}

/** Request plan for one chart. `from`/`to` on a page are SECONDS, which is what
 * `cmcParams` validates (`/^\d{9,10}$/`) — never milliseconds. */
export function klinePlan(timeframe = '7D', interval = 'auto', now = Date.now()): KlinePlan {
  const duration = CHART_WINDOWS[timeframe]
  if (!duration || !Number.isFinite(now)) throw new Error('invalid_chart_parameters')
  const selected = interval === 'auto' ? klineAutoInterval(duration) : interval
  const step = CHART_INTERVALS[selected]
  if (!step || !KLINE_INTERVALS[selected]) throw new Error('invalid_chart_parameters')
  // `end` is the OPEN of the period still in progress, so every candle the plan
  // asks for is a period that has already closed.
  const end = Math.floor(now / step) * step
  const wanted = Math.ceil(duration / step)
  const start = end - wanted * step
  const pages: KlinePlan['pages'] = []
  for (let until = end; until > start && pages.length < KLINE_MAX_PAGES;) {
    const first = Math.max(start, until - KLINE_PAGE * step)
    pages.push({
      interval: KLINE_INTERVALS[selected],
      from: Math.floor(first / 1000), to: Math.floor(until / 1000),
      limit: Math.min(KLINE_PAGE, Math.round((until - first) / step)) || 1,
    })
    until = first
  }
  const covered = pages.length ? end - Math.min(...pages.map((p) => p.from * 1000)) : 0
  return { selected, providerInterval: KLINE_INTERVALS[selected], step, from: end - covered, to: end, limited: covered < duration, pages }
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
  now = Date.now(), context: MarketAssetsContext = {}, deps: KlineDeps = {}) {
  if (!identity?.platform || !identity?.address) return EMPTY('missing_identifier', null, 'No verified CoinMarketCap DEX contract identity for this asset.')
  let plan: KlinePlan
  try { plan = klinePlan(timeframe, interval, now) } catch { return EMPTY('invalid_chart_parameters', null, 'The requested range and interval are not a k-line sampling.') }

  // A capability above the current plan is never attempted: the rung is skipped
  // with a reason and the ladder continues, the way `network_stats` is skipped
  // below Growth rather than spending a call to discover it.
  const account = await (deps.plan ?? defaultPlan)(admin, now)
  if (!planAllows(account, CMC_CAPABILITIES.dexCandles.tier)) {
    return EMPTY('plan_below_startup', plan.step, `CoinMarketCap k-line candles need a ${CMC_CAPABILITIES.dexCandles.tier} plan; the current plan is ${account}.`)
  }

  const request = deps.request ?? requestCmc
  const ctx = { ...context, supabase: admin, kind: 'request' as const, caller: 'contract-kline-chart', maxCalls: KLINE_MAX_PAGES }
  // deno-lint-ignore no-explicit-any
  const all: Bar[] = [], states: string[] = [], reasons: string[] = [], provenance: any[] = []
  for (const page of plan.pages) {
    const params = cmcDexParams('dexCandles', identity, { interval: page.interval, unit: 'usd', from: page.from, to: page.to, limit: page.limit })
    // deno-lint-ignore no-explicit-any
    let result: any = null
    try { result = await request('dexCandles', params, ctx) } catch { result = null }
    if (!result) { reasons.push('provider_unavailable'); states.push('unavailable'); break }
    states.push(result.state)
    if (result.reason) reasons.push(result.reason)
    if (result.provenance) provenance.push(result.provenance)
    const recorded = Date.parse(result.provenance?.fetchedAt || '')
    all.push(...klineBars(result.payload, plan.step, Number.isFinite(recorded) ? recorded : null, now))
    // No repeated requests after a denial, an exhausted budget or an outage.
    if (!result.payload) break
  }
  const candles = normalizeBars(all).bars.filter((bar) => bar.t >= plan.from && (bar.closedAt ?? bar.t) <= plan.to)
  const coverage = [
    `${plan.selected} completed ${plan.providerInterval} candles from the CoinMarketCap k-line aggregate for ${identity.label}; every pool on the chain, not one pair.`,
    'Timestamps are period opens reported in seconds; the close time is derived from the requested interval, not reported by the provider.',
    'Volume is USD for each completed period; a period with no trades is a real zero.',
    plan.limited ? `The window was cut to the newest ${KLINE_MAX_PAGES * KLINE_PAGE} candles at this interval.` : null,
    reasons.length ? `Some candles are unavailable (${[...new Set(reasons)].join(', ')}).` : null,
  ].filter(Boolean).join(' ')
  const sourceState = states.every((s) => s === 'fresh') && states.length ? 'fresh' : candles.length ? 'stale' : states[0] || 'unavailable'
  return {
    candles, source: KLINE_SOURCE, timestampMeaning: 'open' as const, barIntervalMs: plan.step, volumeUnit: 'USD',
    coverage: candles.length ? coverage : `${coverage} No completed candles were returned for this window.`.trim(),
    sourceState: candles.length ? sourceState : 'unavailable',
    sourceReason: candles.length ? (reasons[0] ?? null) : (reasons[0] ?? 'no_completed_candles'),
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
  context: MarketAssetsContext = {}, deps: LadderDeps = {}, now = Date.now()) {
  const identity = klineIdentity(canonical)
  let klineReason = 'no_cmc_dex_chain'
  if (identity) {
    const kline = await (deps.kline ?? loadKlineChart)(admin, identity, timeframe, interval, now, context, deps)
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
