// On-demand price history for one asset (CMC plan proposal 1).
//
// One range is ONE provider sampling: a single `history` request whose interval
// and observation count are fixed by the range, never a pagination ladder and
// never a retry. The provider enforces the retained depth of the plan (Basic:
// one year daily, one month intraday); this module does not restate it, it
// reports the transport's own reason when a request is refused.
//
// An empty series is never presented as data: without usable points the read is
// `unavailable` with the reason that produced it.
import { cmcRows, cmcUsdQuote, cmcUsable, estimateCmcCredits } from '../market-assets/cmc-capabilities.ts'
import { requestCmc } from '../market-assets/cmc-transport.ts'
import type { MarketAssetsContext } from '../market-assets/types.ts'
import { finite, instant } from './investigation-evidence.ts'

export type HistoryRange = '1y' | '90d' | '30d' | '7d' | '48h'
export type HistoryInterval = 'daily' | 'hourly' | '5m'
export interface HistoryPoint { t: number; price: number; volume: number | null; marketCap: number | null }
export interface AssetHistory {
  points: HistoryPoint[]
  interval: HistoryInterval
  source: 'coinmarketcap'
  observedAt: string | null
  fetchedAt: string | null
  state: 'fresh' | 'stale' | 'unavailable'
  reason: string | null
  credits: number
}

/** Range → sampling. Each count stays inside the provider's own ceiling for its
 * interval (daily 366, hourly 744, 5m 576), so a finer interval never widens the
 * requested window. History costs one credit per 100 returned observations. */
export const HISTORY_RANGES: Record<HistoryRange, { interval: HistoryInterval; count: number }> = {
  '1y': { interval: 'daily', count: 366 },
  '90d': { interval: 'daily', count: 90 },
  '30d': { interval: 'hourly', count: 720 },
  '7d': { interval: 'hourly', count: 168 },
  '48h': { interval: '5m', count: 576 },
}
export function historyPlan(range: unknown): { range: HistoryRange; interval: HistoryInterval; count: number; credits: number } | null {
  const plan = typeof range === 'string' ? HISTORY_RANGES[range as HistoryRange] : undefined
  if (!plan) return null
  return { range: range as HistoryRange, ...plan, credits: estimateCmcCredits('history', { count: String(plan.count) }) }
}

/** Points of the requested asset only. A shared response can carry several ids;
 * a foreign id is never adopted as this asset's history. */
export function historyPoints(payload: unknown, cmcId: string, now = Date.now()): HistoryPoint[] {
  let rows: Record<string, any>[]
  try { rows = cmcRows('history', payload).rows } catch { return [] }
  const byTime = new Map<number, HistoryPoint>()
  for (const row of rows) {
    if (row?.id != null && String(row.id) !== cmcId) continue
    for (const point of (Array.isArray(row?.quotes) ? row.quotes : []).slice(0, 1000)) {
      const quote = cmcUsdQuote(point || {}) as Record<string, unknown>
      const t = instant(quote.timestamp ?? point?.timestamp)
      const price = finite(quote.price)
      // A reported point in the future is a clock fault, not an observation.
      if (t == null || price == null || t > now + 300000) continue
      if (!byTime.has(t)) byTime.set(t, { t, price, volume: finite(quote.volume_24h), marketCap: finite(quote.market_cap) })
    }
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t)
}

function unavailable(interval: HistoryInterval, reason: string, credits = 0, fetchedAt: string | null = null): AssetHistory {
  return { points: [], interval, source: 'coinmarketcap', observedAt: null, fetchedAt, state: 'unavailable', reason, credits }
}
/** The shape a caller returns when it knows there is nothing to request. */
export function unavailableHistory(range: unknown, reason: string): AssetHistory {
  return unavailable(historyPlan(range)?.interval ?? 'daily', reason)
}

export interface AssetHistoryOptions {
  cmcId: unknown
  range?: unknown
  ctx?: MarketAssetsContext
  request?: typeof requestCmc
  now?: number
}
/** ONE `history` call per range, with the caller's budget pinned to a single
 * provider request. Foreground demand for a replayable history window is NOT
 * recorded here: the resolver owns demand, and a background worker must never
 * inherit a one-off history read as a polling loop — so the organisation and
 * user of the request are deliberately not handed to the transport. */
// deno-lint-ignore no-explicit-any
export async function loadAssetHistory(admin: any, options: AssetHistoryOptions): Promise<AssetHistory> {
  const { cmcId, range = '90d', ctx = {}, request = requestCmc, now = Date.now() } = options
  const plan = historyPlan(range)
  if (!plan) return unavailable('daily', 'unsupported_history_range')
  const id = String(cmcId ?? '')
  if (!/^[1-9][0-9]{0,9}$/.test(id)) return unavailable(plan.interval, 'no_coinmarketcap_listing', 0)
  const result = await request('history', { id, interval: plan.interval, count: String(plan.count) }, {
    supabase: admin, jobName: ctx.jobName ?? 'intel-markets', caller: ctx.caller ?? 'asset-history',
    kind: 'request', maxCalls: 1, _calls: 0,
  }).catch(() => null)
  if (!result) return unavailable(plan.interval, 'provider_unavailable', plan.credits)
  const fetchedAt = result.provenance?.fetchedAt ?? null
  const points = historyPoints(result.payload, id, now)
  if (!points.length) return unavailable(plan.interval, result.reason ?? 'no_history_points', plan.credits, fetchedAt)
  // The series clock is its newest point, not the endpoint's retrieval time.
  const observedAt = new Date(points[points.length - 1].t).toISOString()
  return {
    points, interval: plan.interval, source: 'coinmarketcap', observedAt, fetchedAt,
    state: cmcUsable(result.state) ? 'fresh' : 'stale', reason: result.reason ?? null, credits: plan.credits,
  }
}
