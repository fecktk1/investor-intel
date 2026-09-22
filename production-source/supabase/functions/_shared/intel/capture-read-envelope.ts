// Investor Intel: the READ half of intel-capture, as one shared function.
//
// intel-capture answers `{op:'read', view, ...params}` for a signed-in Intel
// member. The public demo's snapshot builder (intel-demo-snapshot) must produce
// the very same response body for the same request, without a member and without
// re-deriving anything, so the view registry and the response envelope live here
// and both functions call them. The membership check stays in intel-capture:
// this module only reads, with whatever service-role client it is handed.
//
// Nothing here calls a provider. Every view is a bounded database read through
// the pure readers in ./capture-*-read.ts.

import { readCaptureView, CAPTURE_VIEWS } from './capture-read.ts'
import { VENUE_CAPTURE_VIEWS } from './capture-venues-read.ts'
import { CATEGORY_CAPTURE_VIEWS } from './capture-categories-read.ts'
import { FX_CAPTURE_VIEWS } from './capture-fx-read.ts'
import { LISTING_CAPTURE_VIEWS } from './capture-listings-read.ts'
import { MEME_CAPTURE_VIEWS } from './capture-meme-read.ts'
import { CANDLE_CAPTURE_VIEWS } from './capture-candles-read.ts'
import { RWA_YIELD_CAPTURE_VIEWS } from './capture-rwa-yield-read.ts'
import { RWA_ISSUER_CAPTURE_VIEWS } from './capture-rwa-issuer-read.ts'
import { RWA_UNDERLYING_CAPTURE_VIEWS } from './capture-rwa-underlyings-read.ts'
import { RWA_DEPTH_CAPTURE_VIEWS } from './capture-rwa-depth-read.ts'
import { RWA_WRAPPER_CAPTURE_VIEWS } from './capture-rwa-wrappers-read.ts'
import { RWA_COVERAGE_CAPTURE_VIEWS } from './capture-rwa-coverage-read.ts'
import { RWA_WRAPPER_HISTORY_VIEWS } from './capture-rwa-wrapper-history-read.ts'
import { UNUSUAL_CAPTURE_VIEWS } from './capture-unusual-read.ts'
// Source receipts for the capture views: what the newest capture run recorded
// about its own provider calls. A database read only; no provider call.
import { readCaptureReceipts } from './source-receipt.ts'

// deno-lint-ignore no-explicit-any
type Db = any
// deno-lint-ignore no-explicit-any
type LaneView = (db: Db, body: Record<string, unknown>, now: number) => Promise<any>

/** Every lane's read views. Both keyless RWA lanes are registered here; dropping
 * a spread silently removes a whole panel while every test still passes, so the
 * envelope test asserts each lane's views are present. */
export const LANE_VIEWS: Record<string, LaneView> = {
  ...VENUE_CAPTURE_VIEWS, ...CATEGORY_CAPTURE_VIEWS, ...FX_CAPTURE_VIEWS, ...LISTING_CAPTURE_VIEWS,
  ...MEME_CAPTURE_VIEWS, ...CANDLE_CAPTURE_VIEWS, ...RWA_YIELD_CAPTURE_VIEWS, ...RWA_ISSUER_CAPTURE_VIEWS,
  ...RWA_UNDERLYING_CAPTURE_VIEWS, ...RWA_DEPTH_CAPTURE_VIEWS, ...RWA_WRAPPER_CAPTURE_VIEWS,
  ...RWA_COVERAGE_CAPTURE_VIEWS, ...RWA_WRAPPER_HISTORY_VIEWS, ...UNUSUAL_CAPTURE_VIEWS,
} as Record<string, LaneView>

/** Every view name a read may ask for. */
export const CAPTURE_READ_VIEWS: readonly string[] = [...CAPTURE_VIEWS, ...Object.keys(LANE_VIEWS), 'capture_receipts']

/** Whether CoinMarketCap figures may leave the product in a file. Read from the
 * Edge environment only, never from the operating profile row, so a settings
 * edit cannot grant export (see cmc-source-policy.md). Tables use it to blank
 * provider columns in CSV downloads; the view itself is unchanged. */
export function captureSourcePolicy(env: (key: string) => string | undefined): { exportAllowed: boolean } {
  let value: string | undefined
  try { value = env('CMC_ALLOW_EXPORT') } catch { value = undefined }
  return { exportAllowed: value === 'true' }
}

export interface CaptureReadResponse { status: number; body: Record<string, unknown> }

/**
 * The exact response intel-capture returns for an authorised `op:'read'`.
 *
 * `startedAt` is the instant the request began (durationMs is measured from
 * it), `now` the read clock handed to the views.
 */
export async function captureReadEnvelope(
  db: Db,
  body: Record<string, unknown>,
  opts: { now: number; startedAt: number; env: (key: string) => string | undefined },
): Promise<CaptureReadResponse> {
  const view = String(body.view || '')
  if (view === 'capture_receipts') {
    return { status: 200, body: { ...await readCaptureReceipts(db, body, opts.now), durationMs: Date.now() - opts.startedAt } }
  }
  const laneView = Object.hasOwn(LANE_VIEWS, view) ? LANE_VIEWS[view] : null
  if (!laneView && !CAPTURE_VIEWS.includes(view as typeof CAPTURE_VIEWS[number])) {
    return { status: 400, body: { error: 'unsupported_view', views: [...CAPTURE_VIEWS, ...Object.keys(LANE_VIEWS), 'capture_receipts'] } }
  }
  const result = laneView ? await laneView(db, body, opts.now) : await readCaptureView(db, view, body, opts.now)
  const sourcePolicy = captureSourcePolicy(opts.env)
  return { status: 200, body: { ...result, sourcePolicy, durationMs: Date.now() - opts.startedAt } }
}
