// Investor Intel — CMC capture read client.
//
// Every capture figure (rank map, RWA universe, index constituents,
// liquidation heat) reads through this one helper so an undeployed, rate
// limited or failing `intel-capture` function is ALWAYS an explicit
// unavailable state carrying a reason, never a silently empty chart.
//
// Contract: POST { op:'read', view, orgId, ...params } →
//   { view, asOf, coverage:{ from, to, count, truncated }, reason, ...payload }
// An empty capture table answers with an empty series and asOf:null — that is
// a real, successful read and must render as "empty", not as a failure.
//
// The capture tables are service-role only and the function requires a signed-in
// Investor Intel member of `orgId`, so the read has to travel on the reader's
// AUTHENTICATED client. Callers inside the app pass `supabase` from
// `useSupabase()`; the first authenticated client seen is remembered for the
// browser session so a caller that cannot reach the hook still reads as the same
// reader instead of falling back to the anonymous client and collecting a 401.
import { supabase } from '../../lib/supabase'

// Mirrors CAPTURE_VIEWS in supabase/functions/_shared/intel/capture-read.ts plus
// the lane views merged in intel-capture/index.ts (LANE_VIEWS: venues,
// categories, fx).
export const CAPTURE_VIEWS = [
  'regime', 'regime_at', 'rank_map', 'rwa_universe', 'index_constituents', 'liquidations', 'attention',
  'exchange_reserves', 'venue_share',
  'categories', 'category_disagreement', 'airdrops', 'network_stats',
  'fx',
  // Stage 4 lanes: the daily new-listing due-diligence cohort
  // (capture-listings-read.ts, LISTING_CAPTURE_VIEWS) and the hourly meme
  // launch-stage lifecycle (capture-meme-read.ts, MEME_CAPTURE_VIEWS).
  'new_listings', 'meme_graduation',
  // RWA yield provenance and NAV integrity (capture-rwa-yield-read.ts,
  // RWA_YIELD_CAPTURE_VIEWS). Keyless sources only; no provider credits.
  'rwa_yield',
  // RWA issuer legitimacy: primary-source identity, dated admission drift,
  // holder concentration and transfer restrictions
  // (capture-rwa-issuer-read.ts, RWA_ISSUER_CAPTURE_VIEWS).
  'rwa_issuer_legitimacy',
]

let rememberedClient = null
const usable = client => !!client && typeof client.functions?.invoke === 'function'

/** Remember the reader's authenticated client. Returns the client in force. */
export function setCaptureClient(client) {
  if (usable(client)) rememberedClient = client
  return rememberedClient || supabase
}

export async function readCaptureView(view, params = {}, { orgId, signal, supabase: client } = {}) {
  const transport = usable(client) ? setCaptureClient(client) : (rememberedClient || supabase)
  // View parameters are spread FIRST: a caller can add `range` or `date`, but
  // can never rewrite which op or which view this read is.
  const body = { ...(params && typeof params === 'object' ? params : {}), op: 'read', view }
  if (orgId) body.orgId = orgId
  const { data, error } = await transport.functions.invoke('intel-capture', {
    body,
    ...(signal ? { signal } : {}),
  })
  if (error) {
    // The function answers non-2xx with its own reason in the body; reading it
    // keeps "this view is not captured yet" distinct from "nothing answered".
    const details = await error.context?.json?.().catch(() => null)
    const failure = new Error(details?.error || details?.reason || error.message || 'capture_unavailable')
    failure.code = details?.error || details?.reason || null
    throw failure
  }
  if (data?.error) {
    const failure = new Error(data.error)
    failure.code = data.error
    throw failure
  }
  // A body that is not an object is not a read: treat it as a failure with its
  // own reason rather than handing a figure something it cannot describe.
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    const failure = new Error('capture_read_empty')
    failure.code = 'capture_read_empty'
    throw failure
  }
  return data
}

// Normalize any thrown read into the one shape a figure renders as its failure
// state. Never returns an empty reason: a chart that cannot be built always
// says something.
export function captureUnavailable(error) {
  const reason = typeof error === 'string'
    ? error
    : (error?.code || error?.message || null)
  return { state: 'unavailable', reason: String(reason || 'capture_unavailable').slice(0, 300) }
}

// Known reason codes get a sentence a reader can act on. Anything else — a
// PostgREST message, a provider string — is shown verbatim rather than being
// swallowed by a generic line, so a failure is always explainable.
const REASONS = {
  unauthorized: ['capture.reason_unauthorized', 'Sign in again to read the recorded market captures.'],
  forbidden: ['capture.reason_forbidden', 'This workspace cannot read the recorded market captures.'],
  unsupported_view: ['capture.reason_unsupported_view', 'The capture service does not publish this view yet.'],
  unsupported_op: ['capture.reason_unsupported_view', 'The capture service does not publish this view yet.'],
  invalid_date: ['capture.reason_invalid_date', 'That date could not be read as a calendar date.'],
  no_asset_selected: ['capture.reason_no_asset', 'No asset was selected for this read.'],
  capture_unavailable: ['capture.reason_failed', 'The capture service did not answer this read.'],
  capture_read_empty: ['capture.reason_empty_body', 'The capture service answered without a body.'],
  method_not_allowed: ['capture.reason_failed', 'The capture service did not answer this read.'],
  'Failed to fetch': ['capture.reason_failed', 'The capture service did not answer this read.'],
}

export function captureReasonText(t, reason) {
  const code = String(reason ?? '').trim()
  const known = REASONS[code]
  if (known) return t(known[0], { defaultValue: known[1] })
  return code || t('capture.reason_unknown', { defaultValue: 'The capture service reported no reason.' })
}
