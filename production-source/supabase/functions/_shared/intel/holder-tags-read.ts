// Investor Intel — read views over the holder-tag and holder-cohort capture
// tables (CMC plan proposal 20).
//
// Same contract as `capture-venues-read.ts` and `capture-listings-read.ts`: pure
// functions over a PostgREST-shaped `db`, every read bounded by an explicit row
// cap, ordered so that hitting a cap loses the OLDEST rows, and `coverage`
// reporting the window actually read ({from, to, count}) with `truncated`. An
// empty table is an empty result with `asOf: null` — never an error, and never a
// fabricated row.
//
// Both tables are service-role only; these reads run inside the `intel-research`
// Edge Function behind an authenticated Intel membership check.
//
// WHAT THE CLOCK MEANS. `captured_at` is the hour WE asked CoinMarketCap, floored
// to the hour. Neither `/v1/dex/holders/tag_count` nor `/v1/dex/holders/list`
// publishes an observation time, so no field in these views may be read as "when
// the provider measured this". `coverage` and `asOf` are capture times.
//
// WHAT A COHORT IS. One page of at most fifty addresses per tag, in the order the
// provider returned them, with the cursor deliberately not followed. It is not
// the holder base, not the top holders by balance unless the provider happened to
// order them that way, and not a ranking this platform produced.
//
// WHAT AN ADDRESS IS. An address. CMC's tags are CMC's labels for addresses. No
// field here names, describes or implies a person, and nothing is enriched with
// ENS, exchange labels or clustering.

import { CMC_HOLDER_TAGS, cmcDexIdentity } from '../market-assets/cmc-dex.ts'
import { HOLDER_COHORT_TABLE, HOLDER_TAG_TABLE } from './holder-tags.ts'

/** Windows the tag history view accepts, in days. */
export const HOLDER_TAG_DAYS = [7, 30, 90]
export const HOLDER_TAG_DEFAULT_DAYS = 30
/** Captures returned to the caller, newest kept. A slider with more than sixty
 * stops is not a slider, and an hourly on-demand lane can easily produce more. */
export const HOLDER_TAG_CAPTURE_MAX = 60
/** 60 captures x 8 tags, plus headroom for an hour the provider reported more. */
export const HOLDER_TAG_ROW_CAP = 600
/** 8 tags x 50 addresses, plus headroom. One capture is the whole read. */
export const HOLDER_COHORT_ROW_CAP = 500
/** Bins in a realized-gain histogram. Negatives and positives never share a bin,
 * so when BOTH signs are present each side gets half; when only one sign is
 * present that side gets all ten. The total is ten either way. */
export const REALIZED_BIN_COUNT = 10

export interface Coverage { from: string | null; to: string | null; count: number; truncated?: boolean }
export interface HolderTagPoint { tag: string; holderCount: number | null; balance: number | null; ratio: number | null }
export interface HolderTagCaptureView { capturedAt: string; tags: HolderTagPoint[] }
export interface HistogramBin { from: number; to: number; count: number }

const HOUR = 3_600_000
const num = (v: unknown): number | null => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const str = (v: unknown, max = 200): string | null => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null }
const at = (now: Date | number): number => (now instanceof Date ? now.getTime() : now)
const emptyCoverage = (): Coverage => ({ from: null, to: null, count: 0 })

/** The stored clock, floored to the hour. A caller may pass any instant; the
 * stored value is always an hour mark, so flooring is what makes "the capture at
 * 14:32" mean the 14:00 capture instead of silently matching nothing. */
export function captureHour(value: unknown): string | null {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value))
  if (!Number.isFinite(parsed)) return null
  return new Date(Math.floor(parsed / HOUR) * HOUR).toISOString()
}

/** Registry order first, then anything the provider added, alphabetically. A
 * chart whose bars move because the provider reordered its response is not a
 * chart of anything. */
export function orderTags(tags: string[]): string[] {
  const known = CMC_HOLDER_TAGS.filter((tag) => tags.includes(tag))
  const extra = [...new Set(tags.filter((tag) => !CMC_HOLDER_TAGS.includes(tag)))].sort()
  return [...known, ...extra]
}

/** Bounded read. A failed read is reported as a reason on an empty result; the
 * caller renders "unavailable", never a silently short list. */
// deno-lint-ignore no-explicit-any
async function readRows(build: () => any): Promise<{ rows: any[]; reason: string | null }> {
  try {
    const { data, error } = await build()
    if (error) return { rows: [], reason: String(error.message || error.code || error).slice(0, 200) }
    return { rows: Array.isArray(data) ? data : data ? [data] : [], reason: null }
  } catch (e) { return { rows: [], reason: ((e as Error)?.message || 'read_failed').slice(0, 200) } }
}

const TAG_COLUMNS = 'chain,contract_address,captured_at,tag,holder_count,balance,ratio,ratio_unit'
const COHORT_COLUMNS = 'chain,contract_address,captured_at,tag,wallet_address,balance,percent,buy_volume_usd,sell_volume_usd,realized_pnl_usd,funding_source,first_seen_at,last_seen_at'

/** Log-spaced bins over MAGNITUDES, emitted with the requested sign.
 *
 * A side whose values all share one magnitude is ONE bin, not ten identical ones:
 * ten bins over a zero-width range would be nine empty bars and a lie about
 * resolution. The top bin is inclusive of the maximum. */
export function logSpacedBins(magnitudes: number[], count: number, sign: 1 | -1): HistogramBin[] {
  const values = magnitudes.filter((m) => Number.isFinite(m) && m > 0)
  if (!values.length || count < 1) return []
  const lo = Math.min(...values), hi = Math.max(...values)
  const signed = (from: number, to: number, n: number): HistogramBin => (sign < 0 ? { from: -to, to: -from, count: n } : { from, to, count: n })
  if (lo === hi) return [signed(lo, hi, values.length)]
  const span = Math.log(hi / lo)
  const edges = Array.from({ length: count + 1 }, (_, i) => (i === count ? hi : lo * Math.exp(span * (i / count))))
  const counts = new Array(count).fill(0)
  for (const m of values) {
    const index = Math.min(count - 1, Math.max(0, Math.floor((Math.log(m / lo) / span) * count)))
    counts[index] += 1
  }
  const bins = counts.map((n, i) => signed(edges[i], edges[i + 1], n))
  // Negated bins come out descending; a histogram reads left to right.
  return sign < 0 ? bins.reverse() : bins
}

/** Realized-gain shape of one cohort.
 *
 * `unknown` is a realized gain the provider did not report. It is NEVER binned
 * and never counted as break-even: "we do not know" is not "no gain". `flat` is
 * an explicit zero, which is a real answer and also cannot be log-binned, so it
 * is reported as its own count beside the histogram. */
export function realizedSummary(values: unknown[], bins = REALIZED_BIN_COUNT): {
  inProfit: number; atLoss: number; flat: number; unknown: number; histogram: HistogramBin[]
} {
  const finite = values.map(num).filter((v): v is number => v != null)
  const unknown = values.length - finite.length
  const negatives = finite.filter((v) => v < 0).map((v) => -v)
  const positives = finite.filter((v) => v > 0)
  const flat = finite.filter((v) => v === 0).length
  const sides = (negatives.length ? 1 : 0) + (positives.length ? 1 : 0)
  const perSide = sides === 2 ? Math.floor(bins / 2) : bins
  return {
    inProfit: positives.length, atLoss: negatives.length, flat, unknown,
    histogram: [...logSpacedBins(negatives, perSide, -1), ...logSpacedBins(positives, perSide, 1)],
  }
}

const unsupported = (view: string, extra: Record<string, unknown> = {}) => ({
  view, subject: null, asOf: null, coverage: emptyCoverage(),
  reason: 'unverified_contract_identity', ...extra,
})

/** Tag counts, balances and ratios per capture, chronological.
 *
 * The slider reads `captures`; `latest` is the newest one, which is what the
 * RadialBars render when nothing is selected. */
export async function readHolderTags(
  // deno-lint-ignore no-explicit-any
  db: any,
  params: { chain?: unknown; address?: unknown; days?: unknown } = {},
  now: Date | number = Date.now(),
): Promise<Record<string, unknown>> {
  const identity = cmcDexIdentity(`${str(params.chain, 60) ?? ''}:${str(params.address, 200) ?? ''}`)
  if (!identity) return unsupported('holder_tags', { captures: [], latest: null })
  const requested = Math.trunc(Number(params.days))
  const days = HOLDER_TAG_DAYS.includes(requested) ? requested : HOLDER_TAG_DEFAULT_DAYS
  const since = new Date(at(now) - days * 86_400_000).toISOString()

  const page = await readRows(() => db.from(HOLDER_TAG_TABLE).select(TAG_COLUMNS)
    .eq('chain', identity.chain).eq('contract_address', identity.address)
    .gte('captured_at', since).order('captured_at', { ascending: false }).limit(HOLDER_TAG_ROW_CAP))

  const byCapture = new Map<string, HolderTagPoint[]>()
  for (const row of page.rows) {
    const capturedAt = captureHour(row?.captured_at)
    const tag = str(row?.tag, 60)
    if (!capturedAt || !tag) continue
    byCapture.set(capturedAt, [...(byCapture.get(capturedAt) || []), {
      tag, holderCount: num(row?.holder_count), balance: num(row?.balance), ratio: num(row?.ratio),
    }])
  }
  // Newest captures win the cap, then the survivors are put back in reading order.
  const captures: HolderTagCaptureView[] = [...byCapture.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, HOLDER_TAG_CAPTURE_MAX)
    .map(([capturedAt, tags]) => {
      const order = orderTags(tags.map((t) => t.tag))
      return { capturedAt, tags: order.map((tag) => tags.find((t) => t.tag === tag)!).filter(Boolean) }
    })
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))

  const latest = captures.at(-1) ?? null
  return {
    view: 'holder_tags', subject: identity.subject, network: identity.label, days,
    captures, latest,
    ratioUnit: 'unknown',
    ratioUnitNote: 'Provider-reported holding ratio; fraction versus percent requires explicit source confirmation.',
    asOf: latest?.capturedAt ?? null,
    coverage: {
      from: captures[0]?.capturedAt ?? null, to: latest?.capturedAt ?? null,
      count: page.rows.length, truncated: page.rows.length >= HOLDER_TAG_ROW_CAP || byCapture.size > HOLDER_TAG_CAPTURE_MAX,
    },
    clock: 'captured_at is the hour we asked CoinMarketCap, not a provider observation time.',
    reason: page.reason,
  }
}

/** One capture's cohort: the addresses each tag's page reported, and the shape of
 * their realized gains.
 *
 * With no `capturedAt` the newest capture is read. With a `tag` only that tag is
 * read, which is what a bar click on the tag chart asks for. */
export async function readHolderCohort(
  // deno-lint-ignore no-explicit-any
  db: any,
  params: { chain?: unknown; address?: unknown; capturedAt?: unknown; tag?: unknown } = {},
): Promise<Record<string, unknown>> {
  const identity = cmcDexIdentity(`${str(params.chain, 60) ?? ''}:${str(params.address, 200) ?? ''}`)
  if (!identity) return unsupported('holder_cohort', { capturedAt: null, tags: [] })
  const asked = str(params.tag, 60)
  const tag = asked && CMC_HOLDER_TAGS.includes(asked) ? asked : null
  if (asked && !tag) {
    return {
      view: 'holder_cohort', subject: identity.subject, network: identity.label, capturedAt: null, tag: asked,
      tags: [], asOf: null, coverage: emptyCoverage(), reason: 'unknown_holder_tag',
    }
  }

  let capturedAt = captureHour(params.capturedAt)
  let newestReason: string | null = null
  if (!capturedAt) {
    const newest = await readRows(() => db.from(HOLDER_COHORT_TABLE).select('captured_at')
      .eq('chain', identity.chain).eq('contract_address', identity.address)
      .order('captured_at', { ascending: false }).limit(1))
    newestReason = newest.reason
    capturedAt = captureHour(newest.rows[0]?.captured_at)
  }
  const base = {
    view: 'holder_cohort', subject: identity.subject, network: identity.label, capturedAt, tag,
    page: `One page of at most 50 addresses per tag, as the provider returned them; the cursor is not followed.`,
    clock: 'captured_at is the hour we asked CoinMarketCap, not a provider observation time.',
  }
  if (!capturedAt) return { ...base, tags: [], asOf: null, coverage: emptyCoverage(), reason: newestReason ?? 'no_capture' }

  const page = await readRows(() => {
    let q = db.from(HOLDER_COHORT_TABLE).select(COHORT_COLUMNS)
      .eq('chain', identity.chain).eq('contract_address', identity.address).eq('captured_at', capturedAt)
    if (tag) q = q.eq('tag', tag)
    return q.limit(HOLDER_COHORT_ROW_CAP)
  })

  const byTag = new Map<string, Record<string, unknown>[]>()
  for (const row of page.rows) {
    const rowTag = str(row?.tag, 60)
    const wallet = str(row?.wallet_address, 200)
    if (!rowTag || !wallet) continue
    byTag.set(rowTag, [...(byTag.get(rowTag) || []), {
      walletAddress: wallet,
      balance: num(row?.balance), percent: num(row?.percent),
      buyVolumeUsd: num(row?.buy_volume_usd), sellVolumeUsd: num(row?.sell_volume_usd),
      realizedPnlUsd: num(row?.realized_pnl_usd),
      fundingSource: str(row?.funding_source, 120),
    }])
  }
  const tags = orderTags([...byTag.keys()]).map((name) => {
    const wallets = byTag.get(name) || []
    return { tag: name, wallets, realized: realizedSummary(wallets.map((w) => w.realizedPnlUsd)) }
  })
  return {
    ...base, tags,
    asOf: capturedAt,
    coverage: { from: capturedAt, to: capturedAt, count: page.rows.length, truncated: page.rows.length >= HOLDER_COHORT_ROW_CAP },
    reason: page.reason,
  }
}

/** Two captures, compared. Pure: it reads nothing and calls nothing.
 *
 * A delta exists only when BOTH sides reported the number. A tag that appeared,
 * disappeared or was never counted has a null delta and keeps both sides visible,
 * because "it went from nothing to 400" and "we did not measure it before" are
 * different statements and only one of them is a change. */
export function compareHolderTags(a: unknown, b: unknown): Record<string, unknown> {
  // deno-lint-ignore no-explicit-any
  const side = (value: any): { capturedAt: string | null; map: Map<string, HolderTagPoint> } => {
    const tags = Array.isArray(value?.tags) ? value.tags : []
    const map = new Map<string, HolderTagPoint>()
    // deno-lint-ignore no-explicit-any
    for (const row of tags as any[]) {
      const tag = str(row?.tag, 60)
      if (!tag || map.has(tag)) continue
      map.set(tag, { tag, holderCount: num(row?.holderCount), balance: num(row?.balance), ratio: num(row?.ratio) })
    }
    return { capturedAt: captureHour(value?.capturedAt), map }
  }
  const left = side(a), right = side(b)
  const delta = (x: number | null | undefined, y: number | null | undefined): number | null =>
    (x == null || y == null ? null : y - x)
  const tags = orderTags([...new Set([...left.map.keys(), ...right.map.keys()])]).map((tag) => {
    const from = left.map.get(tag) ?? null, to = right.map.get(tag) ?? null
    return {
      tag, from, to,
      holderCountDelta: delta(from?.holderCount, to?.holderCount),
      balanceDelta: delta(from?.balance, to?.balance),
      ratioDelta: delta(from?.ratio, to?.ratio),
    }
  })
  return {
    view: 'holder_tag_compare', from: left.capturedAt, to: right.capturedAt, tags,
    ratioUnit: 'unknown',
    clock: 'Both sides are capture times: the hours we asked CoinMarketCap, not provider observation times.',
    reason: !left.capturedAt || !right.capturedAt ? 'one_side_missing' : null,
  }
}
