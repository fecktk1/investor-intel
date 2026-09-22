// Investor Intel public demo: WHICH requests the daily snapshot answers.
//
// Every request below is written exactly as the page sends it (the component
// and line are named beside it), minus orgId, which the key drops. Parameter
// variants a reader can reach from the page (a range button, a URL option, an
// asset in a selector, a row in a list) are enumerated from the stored data
// itself, so the demo covers what is captured today and nothing that is not.
//
// Discovery reads use the same shared code as the entries, with the same
// service-role client; nothing here calls a provider.

import { captureReadEnvelope } from './capture-read-envelope.ts'
import type { DemoRequest, ResearchCacheReader } from './demo-snapshot-builder.ts'
import { planSharedRequests } from './demo-snapshot-shared.ts'

// deno-lint-ignore no-explicit-any
type Db = any
// deno-lint-ignore no-explicit-any
type Any = any

const capture = (view: string, params: Record<string, unknown> = {}, group = 'capture'): DemoRequest =>
  // capture-api.js: { ...params, op: 'read', view } (orgId is dropped by the key).
  ({ fn: 'intel-capture', body: { ...params, op: 'read', view }, group })
const research = (capability: string, params: Record<string, unknown>, group = 'research'): DemoRequest =>
  // useMarketResearch.js: { orgId, capability, params } (orgId dropped by the key).
  ({ fn: 'intel-research', body: { capability, params }, group })

/** Bounds on the enumerated variants. */
export const PLAN_LIMITS = {
  rwaListPages: 40,        // 25 rows a page: 1,000 assets
  rwaTypePages: 10,        // per asset-type filter
  issuerPages: 12,
  drawerAssets: 250,       // per-asset evidence drawers (info, quotes, pairs, profile)
  issuerDrawers: 150,
  wrapperAssets: 80,       // x 4 history ranges
  depthTokens: 200,
}

/** The asset-type filter on /intel/rwa (MarketResearchPage.jsx, ?type=). */
export const RWA_ASSET_TYPES = ['stock', 'government_security', 'commodity', 'etf', 'currency', 'real_estate']

/** The four premium-history ranges on the wrapper board (RwaWrapperHistory.jsx HISTORY_RANGES). */
export const WRAPPER_HISTORY_DAYS = [30, 90, 180, 365]
const PAGE = 25

/** Receipt lanes per page (the CAPTURE_RECEIPT_LANES constant of each page). */
export const RECEIPT_LANES: string[][] = [
  ['rank', 'rwa', 'rwa_depth', 'index', 'liquidations', 'exchange_reserves', 'venue_share'], // MarketStructurePage
  ['rwa_wrappers', 'rwa'],                                                                    // RwaWrapperPage
  ['regime', 'network_stats'],                                                                // RegimePage
  ['categories'],                                                                             // CategoriesPage
  ['airdrops'],                                                                               // AirdropsPage
  ['new_listings'],                                                                           // ListingsPage
  ['launchpad_stages', 'sunpump_stages', 'meme_stages'],                                      // GraduationPage
]

/** Every string value under `field` anywhere in a payload, in order, unique. */
export function collectIds(payload: unknown, field: string, pattern = /^[1-9][0-9]{0,11}$/, max = 1000): string[] {
  const out: string[] = [], seen = new Set<string>()
  const walk = (value: unknown, depth: number) => {
    if (out.length >= max || depth > 12 || value == null) return
    if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1); return }
    if (typeof value !== 'object') return
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (key === field && (typeof inner === 'string' || typeof inner === 'number')) {
        const id = String(inner)
        if (pattern.test(id) && !seen.has(id)) { seen.add(id); out.push(id) }
      } else if (inner && typeof inner === 'object') walk(inner, depth + 1)
    }
  }
  walk(payload, 0)
  return out
}

/** MarketStructurePage.topProviderIds: latest captured week, rank 1 first, five ids. */
export function topProviderIds(payload: Any, max = 5): unknown[] {
  const rows = (Array.isArray(payload?.series) ? payload.series : []).map((row: Any) => {
    const points = (Array.isArray(row?.points) ? row.points : [])
      .map((p: Any) => ({ at: Date.parse(p?.date), rank: Number(p?.rank) }))
      .filter((p: Any) => Number.isFinite(p.at) && Number.isFinite(p.rank))
      .sort((a: Any, b: Any) => a.at - b.at)
    return { providerId: row?.providerId ?? null, rank: points.at(-1)?.rank ?? null }
  }).filter((r: Any) => r.providerId != null && r.rank != null).sort((a: Any, b: Any) => a.rank - b.rank)
  return rows.slice(0, max).map((r: Any) => r.providerId)
}

/** useRwaAssetLogos.logoIds: positive integers, de-duplicated, sorted, at most 100. */
export function logoIds(values: unknown[]): number[] {
  const ids = new Set<number>()
  for (const value of values) { const n = Number(value); if (Number.isFinite(n) && n >= 1) ids.add(Math.trunc(n)) }
  return [...ids].sort((a, b) => a - b).slice(0, 100)
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** The fixed part of the plan: every capture view a demo page opens with, and
 * every option a page offers for it. Needs no data. */
export function staticCaptureRequests(now: number): DemoRequest[] {
  const out: DemoRequest[] = []
  // Boot: DisplayCurrencyProvider (display-currency.jsx).
  out.push(capture('fx', {}, 'boot'))
  // /intel/structure panels (MarketStructurePage.jsx and its components).
  for (const limit of [10, 25, 50]) out.push(capture('rank_map', { limit }, 'structure'))         // RankMap LIMITS
  out.push(capture('rwa_universe', {}, 'structure'))                                                // RwaUniverse
  out.push(capture('rwa_coverage', {}, 'rwa'))                                                      // RwaCoverage (also /intel/rwa)
  for (const days of [7, 30]) out.push(capture('rwa_universe_changes', { days }, 'structure'))     // RwaUniverseChanges DAY_CHOICES
  out.push(capture('rwa_issuer_legitimacy', {}, 'structure'))
  out.push(capture('rwa_concentration', {}, 'structure'))
  out.push(capture('rwa_underlying_registrants', {}, 'structure'))
  out.push(capture('rwa_yield', {}, 'structure'))
  out.push(capture('rwa_depth', {}, 'structure'))
  out.push(capture('index_constituents', {}, 'structure'))
  out.push(capture('liquidations', { providerIds: [] }, 'structure'))                              // before rank_map seeds ids
  for (const days of [7, 30, 90]) out.push(capture('exchange_reserves', { days }, 'structure'))    // ExchangeReserves DAYS
  for (const days of [30, 90, 365]) for (const kind of ['derivatives', 'spot']) out.push(capture('venue_share', { days, kind }, 'structure'))
  for (const lanes of RECEIPT_LANES) out.push(capture('capture_receipts', { lanes }, 'receipts'))
  // /intel/rwa/wrappers (RwaWrapperSpread, RwaWrapperHistory without ?asset=).
  out.push(capture('rwa_wrappers', {}, 'wrappers'))
  for (const days of WRAPPER_HISTORY_DAYS) out.push(capture('rwa_wrapper_history', { days }, 'wrappers'))
  // Secondary pages that read capture views only.
  out.push(capture('unusual_moves', { limit: 25 }, 'markets'))                                      // UnusualForThisAsset
  out.push(capture('breadth', {}, 'markets'))                                                       // BreadthSpread
  for (const range of ['7d', '30d', '90d', '1y']) out.push(capture('regime', { range }, 'regime')) // RegimeRibbon REGIME_RANGES
  // RegimeDayPanel asks for the reader's local date; cover the day either side.
  for (const offset of [-1, 0, 1]) out.push(capture('regime_at', { date: utcDay(now + offset * 86_400_000) }, 'regime'))
  out.push(capture('network_stats', {}, 'regime'))
  for (const days of [1, 7, 30]) for (const top of [12, 30, 60]) out.push(capture('categories', { days, top }, 'categories'))
  out.push(capture('category_disagreement', {}, 'categories'))
  for (const status of ['all', 'ongoing', 'upcoming']) out.push(capture('airdrops', { status, days: 90 }, 'airdrops'))
  for (const days of [7, 30, 90]) for (const status of ['all', 'inspected', 'flagged']) out.push(capture('new_listings', { days, status }, 'listings'))
  for (const days of [1, 7, 30]) out.push(capture('meme_graduation', { days }, 'graduation'))
  return out
}

async function readView(db: Db, body: Record<string, unknown>, now: number): Promise<Any> {
  try {
    const read = await captureReadEnvelope(db, body, { now, startedAt: Date.now(), env: () => undefined })
    return read.status === 200 ? read.body : null
  } catch { return null }
}

/**
 * The whole plan for one day. Discovery reads (rank map, wrapper board, depth
 * board, RWA list pages) decide which parameter variants exist.
 */
export async function planDemoRequests(
  db: Db, now: number,
  opts: { research?: ResearchCacheReader; discover?: (body: Record<string, unknown>) => Promise<Any>; shared?: boolean } = {},
): Promise<DemoRequest[]> {
  const out = staticCaptureRequests(now)
  const view = (body: Record<string, unknown>) => (opts.discover ? opts.discover(body) : readView(db, body, now))

  // The secondary pages' shared data (demo-snapshot-shared.ts), ahead of the
  // per-asset drawers so a cap on the plan never drops a whole page.
  if (opts.shared !== false) {
    try { out.push(...await planSharedRequests(db, now)) } catch { /* the capture pages still build */ }
  }

  // Liquidation panels seed their ids from each rank map variant's newest week.
  for (const limit of [10, 25, 50]) {
    const map = await view({ op: 'read', view: 'rank_map', limit })
    const ids = topProviderIds(map)
    if (ids.length) out.push(capture('liquidations', { providerIds: ids }, 'structure'))
  }

  // Wrapper board: every asset the history selector offers, every range, plus
  // the picks per asset.
  const wrappers = await view({ op: 'read', view: 'rwa_wrappers' })
  const history = await view({ op: 'read', view: 'rwa_wrapper_history', days: 90 })
  const wrapperAssets = [...new Set([...collectIds(history?.assets, 'rwaId'), ...collectIds(wrappers, 'rwaId')])].slice(0, PLAN_LIMITS.wrapperAssets)
  for (const rwaId of wrapperAssets) {
    for (const days of WRAPPER_HISTORY_DAYS) out.push(capture('rwa_wrapper_history', { rwaId, days }, 'wrappers'))
    out.push(capture('rwa_wrapper_picks', { rwaId }, 'wrappers'))
  }

  // Token depth for every token the depth board and the wrapper board name
  // (RwaTokenDepth.jsx sends { cryptoId } as a string).
  const depth = await view({ op: 'read', view: 'rwa_depth' })
  const tokens = [...new Set([...collectIds(depth, 'cryptoId'), ...collectIds(wrappers, 'cryptoId')])].slice(0, PLAN_LIMITS.depthTokens)
  for (const cryptoId of tokens) out.push(capture('rwa_token_depth', { cryptoId }, 'depth'))

  // /intel/rwa: the research list pages from the shared free cache, the logo
  // batch per page, and each asset's evidence drawer.
  if (opts.research) {
    const drawerAssets: string[] = []
    const listPages = async (filter: Record<string, unknown>, maxPages: number) => {
      for (let page = 0; page < maxPages; page++) {
        const params = { start: page * PAGE + 1, limit: PAGE, ...filter }    // MarketResearchPage.jsx:193
        out.push(research('rwaList', params, 'rwa'))
        let body: Any = null
        try { body = await opts.research!('rwaList', params) } catch { body = null }
        const rows: Any[] = Array.isArray(body?.data?.rows) ? body.data.rows : []
        if (!rows.length) break
        const ids = logoIds(rows.map((row) => row?.rwa_id))
        if (ids.length) out.push(capture('rwa_asset_logos', { rwaIds: ids }, 'rwa'))   // useRwaAssetLogos.js:59
        for (const row of rows) if (row?.rwa_id != null) drawerAssets.push(String(row.rwa_id))
        if (body?.data?.hasMore === false) break
      }
    }
    await listPages({}, PLAN_LIMITS.rwaListPages)
    for (const assetType of RWA_ASSET_TYPES) await listPages({ asset_type: assetType }, PLAN_LIMITS.rwaTypePages)
    for (const rwaId of [...new Set(drawerAssets)].slice(0, PLAN_LIMITS.drawerAssets)) {
      // Investigation drawer (MarketResearchPage.jsx:128-136).
      out.push(capture('rwa_asset_profile', { rwaId: Number(rwaId) }, 'rwa'))
      out.push(research('rwaInfo', { rwa_id: rwaId }, 'rwa'))
      out.push(research('rwaQuotes', { rwa_id: rwaId }, 'rwa'))
      out.push(research('rwaPairs', { rwa_id: rwaId, limit: PAGE }, 'rwa'))
    }
    const issuers: string[] = []
    for (let page = 0; page < PLAN_LIMITS.issuerPages; page++) {
      const params = { start: page * PAGE + 1, limit: PAGE }
      out.push(research('issuers', params, 'rwa'))
      let body: Any = null
      try { body = await opts.research('issuers', params) } catch { body = null }
      const rows: Any[] = Array.isArray(body?.data?.rows) ? body.data.rows : []
      if (!rows.length) break
      for (const row of rows) { const id = row?.issuer_id ?? row?.id; if (id != null) issuers.push(String(id)) }
      if (body?.data?.hasMore === false) break
    }
    for (const issuerId of [...new Set(issuers)].slice(0, PLAN_LIMITS.issuerDrawers)) {
      out.push(research('issuer', { issuer_id: issuerId }, 'rwa'))                   // issuers-view drawer
      out.push(research('issuer', { issuer_id: issuerId, limit: PAGE }, 'rwa'))      // issuer opened from a quote
    }
  }
  return out
}
