// Investor Intel public demo: the shared capture views whose snapshot copy may
// be replaced by the NEWER stored capture, and how often each one's lane runs.
//
// The demo serves every capture view a page opens from the daily snapshot
// (demo-snapshot-plan.ts staticCaptureRequests and the per-asset variants). The
// snapshot is built once a day, so by the afternoon the wrapper board it holds
// can be two captures behind the lane that feeds it. When a snapshot copy is
// past its lane's cadence (captureCopyPastWindow), the browser asks the public
// read endpoint (intel-demo-read, read 'view') for the same view; the endpoint
// answers it from the capture tables with the very function intel-capture uses
// (captureReadEnvelope), which reads stored rows only and never a provider. The
// newer of the two copies answers the page; an older, failed or refused answer
// leaves the snapshot copy, which still states its own capture time.
//
// Pure (no Deno, no DOM): the browser (src/intel/demo/demo-fetch.js) and the
// endpoint (demo-read.ts) import it, so both agree on which views may cross and
// with which parameters. Every parameter a view accepts is listed below with the
// values the pages actually send; anything else is refused before a read.

// deno-lint-ignore no-explicit-any
type Any = any

/** A refused view read. demo-read.ts turns it into a 400. */
export class DemoViewRefusal extends Error {
  constructor(public code: string) { super(code) }
}

type Rule = (value: unknown) => unknown
const refuse = (code: string): never => { throw new DemoViewRefusal(code) }
const numberOf = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && /^[1-9][0-9]{0,11}$/.test(value)) return Number(value)
  return null
}
/** One of these integers (sent as a number or a decimal string). */
const intIn = (allowed: number[]): Rule => (value) => {
  const n = numberOf(value)
  return n != null && allowed.includes(n) ? n : refuse('invalid_view_params')
}
const intRange = (min: number, max: number): Rule => (value) => {
  const n = numberOf(value)
  return n != null && n >= min && n <= max ? n : refuse('invalid_view_params')
}
const textIn = (allowed: string[]): Rule => (value) => (typeof value === 'string' && allowed.includes(value) ? value : refuse('invalid_view_params'))
/** A CoinMarketCap RWA or crypto id: digits, no leading zero. */
const id: Rule = (value) => {
  const n = numberOf(value)
  return n != null && n >= 1 ? n : refuse('invalid_view_params')
}
/** A list of catalogue ids (the liquidation panel's top five). */
const ids = (max: number): Rule => (value) => {
  if (!Array.isArray(value) || value.length > max) refuse('invalid_view_params')
  return (value as unknown[]).map((item) => {
    const n = numberOf(item)
    return n != null && n >= 1 ? String(n) : refuse('invalid_view_params')
  })
}
/** Capture receipt lane names (source-receipt.ts filters unknown ones itself). */
const lanes: Rule = (value) => {
  if (!Array.isArray(value) || !value.length || value.length > 8) refuse('invalid_view_params')
  return (value as unknown[]).map((lane) => (typeof lane === 'string' && /^[a-z][a-z_]{0,39}$/.test(lane) ? lane : refuse('invalid_view_params')))
}
const utcDate: Rule = (value) => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ? value : refuse('invalid_view_params'))

const HOUR = 3600, DAY = 86_400, SIX_HOURS = 21_600

interface ViewSpec {
  /** How often the lane behind this view captures, in seconds (its cron). A copy
   *  older than this may have a newer capture behind it. */
  cadenceSeconds: number
  /** The parameters the pages send, each with its rule. Absent is always allowed. */
  params: Record<string, Rule>
}

/**
 * The shared capture views the demo may refresh, with their lanes' cadences
 * (capture-rwa-*.ts *_CAPTURE_SCHEDULE, source-receipt.ts CAPTURE_RECEIPT_LANES)
 * and parameters (demo-snapshot-plan.ts, which names the page for each).
 * rwa_token_depth and attention are not here: they are per-asset reads that
 * intel-demo-read answers as read 'capture', for tracked assets only.
 */
export const DEMO_CAPTURE_VIEWS: Readonly<Record<string, ViewSpec>> = Object.freeze({
  fx: { cadenceSeconds: HOUR, params: {} },
  rank_map: { cadenceSeconds: DAY, params: { limit: intIn([10, 25, 50]) } },
  rwa_universe: { cadenceSeconds: HOUR, params: {} },
  rwa_coverage: { cadenceSeconds: DAY, params: {} },
  rwa_universe_changes: { cadenceSeconds: DAY, params: { days: intIn([7, 30]) } },
  rwa_concentration: { cadenceSeconds: DAY, params: {} },
  rwa_issuer_legitimacy: { cadenceSeconds: DAY, params: {} },
  rwa_underlying_registrants: { cadenceSeconds: DAY, params: {} },
  rwa_yield: { cadenceSeconds: SIX_HOURS, params: {} },
  rwa_depth: { cadenceSeconds: DAY, params: {} },
  index_constituents: { cadenceSeconds: HOUR, params: {} },
  liquidations: { cadenceSeconds: 300, params: { providerIds: ids(5) } },
  exchange_reserves: { cadenceSeconds: DAY, params: { days: intIn([7, 30, 90]) } },
  venue_share: { cadenceSeconds: DAY, params: { days: intIn([30, 90, 365]), kind: textIn(['derivatives', 'spot']) } },
  capture_receipts: { cadenceSeconds: 300, params: { lanes } },
  rwa_wrappers: { cadenceSeconds: SIX_HOURS, params: {} },
  rwa_wrapper_history: { cadenceSeconds: SIX_HOURS, params: { days: intIn([30, 90, 180, 365]), rwaId: id } },
  rwa_wrapper_picks: { cadenceSeconds: SIX_HOURS, params: { rwaId: id } },
  unusual_moves: { cadenceSeconds: HOUR, params: { limit: intRange(1, 50) } },
  breadth: { cadenceSeconds: HOUR, params: {} },
  regime: { cadenceSeconds: HOUR, params: { range: textIn(['7d', '30d', '90d', '1y']) } },
  regime_at: { cadenceSeconds: HOUR, params: { date: utcDate } },
  network_stats: { cadenceSeconds: HOUR, params: {} },
  categories: { cadenceSeconds: HOUR, params: { days: intIn([1, 7, 30]), top: intIn([12, 30, 60]) } },
  category_disagreement: { cadenceSeconds: HOUR, params: {} },
  airdrops: { cadenceSeconds: DAY, params: { status: textIn(['all', 'ongoing', 'upcoming']), days: intIn([90]) } },
  new_listings: { cadenceSeconds: DAY, params: { days: intIn([7, 30, 90]), status: textIn(['all', 'inspected', 'flagged']) } },
  meme_graduation: { cadenceSeconds: HOUR, params: { days: intIn([1, 7, 30]) } },
})

/** The per-asset capture reads intel-demo-read answers as read 'capture'. */
export const DEMO_ASSET_CAPTURE_CADENCE: Readonly<Record<string, number>> = Object.freeze({ rwa_token_depth: DAY, attention: HOUR })

/** A view's lane cadence in seconds, or null for a view the demo never refreshes. */
export function demoViewCadence(view: unknown): number | null {
  const name = String(view ?? '')
  if (Object.hasOwn(DEMO_CAPTURE_VIEWS, name)) return DEMO_CAPTURE_VIEWS[name].cadenceSeconds
  if (Object.hasOwn(DEMO_ASSET_CAPTURE_CADENCE, name)) return DEMO_ASSET_CAPTURE_CADENCE[name]
  return null
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const NO_SUBJECT = new Set(['no_asset_selected', 'no_lane_selected', 'unsupported_view', 'unsupported_lane', 'invalid_date'])

/** The view read, rebuilt from its allowed parameters: { view, params }. The
 * page's intel-capture body is { ...params, op: 'read', view, orgId }; op and
 * orgId never cross. Throws DemoViewRefusal for anything else. */
export function parseDemoView(view: unknown, params: unknown): { view: string; params: Record<string, unknown> } {
  const name = typeof view === 'string' ? view : ''
  if (!name || !Object.hasOwn(DEMO_CAPTURE_VIEWS, name)) refuse('invalid_view')
  const spec = DEMO_CAPTURE_VIEWS[name]
  const given = params == null ? {} : isObject(params) ? params : refuse('invalid_view_params')
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(given as Record<string, unknown>)) {
    if (!Object.hasOwn(spec.params, key)) refuse('invalid_view_params')
    if (value === undefined || value === null || value === '') continue
    out[key] = spec.params[key](value)
  }
  return { view: name, params: out }
}

/** The capture time a view body states (every view returns `asOf`), in ms. */
export function viewAsOfMs(body: Any): number | null {
  const ms = Date.parse(String(body?.asOf ?? ''))
  return Number.isFinite(ms) ? ms : null
}

/**
 * Is this snapshot copy of a capture view past its lane's cadence now, so that a
 * newer capture may exist? A copy with no capture time (the lane had stored
 * nothing when the snapshot was built) counts as past it. A view the demo never
 * refreshes, or a failed body, is never second-guessed.
 */
export function captureCopyPastWindow(view: unknown, body: Any, now = Date.now()): boolean {
  const cadence = demoViewCadence(view)
  if (cadence == null || !isObject(body) || body.error) return false
  const asOf = viewAsOfMs(body)
  // A read that names no subject (the history chart before an asset is picked)
  // has no capture time to be behind.
  if (asOf == null) return !NO_SUBJECT.has(String(body.reason ?? ''))
  return asOf + cadence * 1000 <= now
}

/** Is the endpoint's answer a newer capture than the snapshot copy? */
export function isNewerCapture(answer: Any, stored: Any): boolean {
  if (!isObject(answer) || answer.error) return false
  const fresh = viewAsOfMs(answer)
  if (fresh == null) return false
  const held = viewAsOfMs(stored)
  return held == null || fresh > held
}

// ─── The Markets catalogue page (intel-markets, unsearched) ───────────────────
//
// Not a capture view, but a stored read the snapshot holds all the same: the
// catalogue lanes rewrite market_assets every few minutes, so a snapshot copy of
// the screen is hours behind by the afternoon. It is read again (read 'screen'
// with no search) once the copy is older than MARKET_SCREEN_REFRESH_SECONDS.

/** The catalogue's refresh policy is five minutes; three of them is the window. */
export const MARKET_SCREEN_REFRESH_SECONDS = 900

/** The time a Markets screen body states: its snapshot's newest row time. */
export function screenAsOfMs(body: Any): number | null {
  const ms = Date.parse(String(body?.lastUpdated ?? body?.snapshot?.lastUpdated ?? body?.receipt?.fetchedAt ?? ''))
  return Number.isFinite(ms) ? ms : null
}

/** Is this snapshot copy of the Markets screen older than the catalogue's
 * window? A copy that states no time is never second-guessed. */
export function screenCopyPastWindow(body: Any, now = Date.now()): boolean {
  if (!isObject(body) || body.error || !Array.isArray(body.rows)) return false
  const asOf = screenAsOfMs(body)
  return asOf != null && asOf + MARKET_SCREEN_REFRESH_SECONDS * 1000 <= now
}

/** Is the endpoint's screen a newer catalogue read than the snapshot copy? */
export function isNewerScreen(answer: Any, stored: Any): boolean {
  if (!isObject(answer) || answer.error || !Array.isArray(answer.rows)) return false
  const fresh = screenAsOfMs(answer)
  if (fresh == null) return false
  const held = screenAsOfMs(stored)
  return held == null || fresh > held
}
