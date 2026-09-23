// Investor Intel — CoinMarketCap capture worker and read API.
//
// One Edge Function with two halves:
//
//   * CAPTURE ops (`regime`, `index`, `rwa`, `rank_daily`, `rank_backfill`,
//     `liquidations`, `attention`, `airdrops`, `all_hourly`) are driven by
//     pg_cron and authenticated with the operational `x-cron-secret`, or by a
//     signed-in super admin for a manual run. Each op is a bounded job from
//     `_shared/intel/capture-jobs.ts`: it obeys `provider_schedule_policy`,
//     skips a capability above the current CMC plan with a recorded reason, and
//     reports its own row count and credit ceiling instead of throwing.
//
//   * READ ops (`{op:'read', view, ...}`) serve the capture tables to the app.
//     The tables are service-role only, so every read requires a signed-in
//     Investor Intel member of the requested org and runs through the bounded
//     pure readers in `_shared/intel/capture-read.ts`.
//
// A run stops starting new work at the wall-clock budget below, so the hourly
// batch never exceeds the platform's request ceiling; unstarted jobs come back
// as `skipped: 'time_budget'` and the next cron tick picks them up.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { requestCmc, cmcPlan, cmcCreditCeiling, loadCmcOperatingSettings } from '../_shared/market-assets/cmc-transport.ts'
import { calibrateCadence, calibratePolicyRows, loadAccountObservations } from '../_shared/intel/budget-calibration.ts'
import { requireIntelAccess } from '../_shared/intel/research-service.ts'
import { orgAuthzErrorResponse } from '../_shared/org-authz.ts'
import {
  loadSchedulePolicy, captureRegime, captureIndexConstituents, captureRwaUniverse, captureRankDaily,
  backfillRankHistory, captureLiquidations, captureAttention, captureAirdrops, type CaptureDeps, type JobResult,
} from '../_shared/intel/capture-jobs.ts'
// The read half (view registry + response envelope) is shared with the public
// demo's snapshot builder, so both answer a read with the identical body.
import { captureReadEnvelope } from '../_shared/intel/capture-read-envelope.ts'
// Stage 3 lanes live in their own modules and plug in through one shared
// surface: ops run like the jobs above, views read like the views above.
import { VENUE_CAPTURE_OPS } from '../_shared/intel/capture-venues.ts'
import { CATEGORY_CAPTURE_OPS } from '../_shared/intel/capture-categories.ts'
import { FX_CAPTURE_OPS } from '../_shared/intel/capture-fx.ts'
import { LISTING_CAPTURE_OPS } from '../_shared/intel/capture-listings.ts'
import { MEME_CAPTURE_OPS } from '../_shared/intel/capture-meme.ts'
// Second source for the SAME two meme-graduation tables: real launchpads on
// Solana, BNB Chain, Base and Robinhood Chain through the CoinGecko onchain API.
// It spends no CoinMarketCap credit and answers to its own `coingecko`
// provider_schedule_policy row, which it loads itself (loadSchedulePolicy below
// only reads `coinmarketcap` rows). Its view is MEME_CAPTURE_VIEWS (in the shared read envelope): one
// page, one view, two sources.
import { LAUNCHPAD_CAPTURE_OPS } from '../_shared/intel/capture-launchpads.ts'
// THIRD source for the same two tables: SunPump on TRON, read off the chain
// through TronGrid. It has no CoinGecko dex id and cannot be reached by the lane
// above; its evidence is the launchpad contract's own event log. It spends no
// CoinMarketCap credit, answers to its own `trongrid` provider_schedule_policy
// row (which it loads itself), and shares MEME_CAPTURE_VIEWS: one page, one
// view, three sources.
import { SUNPUMP_CAPTURE_OPS } from '../_shared/intel/capture-sunpump.ts'
import { CANDLE_CAPTURE_OPS } from '../_shared/intel/capture-candles.ts'
// RWA yield provenance and NAV integrity. This lane calls no CoinMarketCap
// endpoint: Chainlink NAV over a public RPC, Treasury, the New York Fed, the ECB
// and SEC EDGAR are all keyless, so it reports zero credits and has no plan gate.
import { RWA_YIELD_CAPTURE_OPS } from '../_shared/intel/capture-rwa-yield.ts'
// The RWA issuer legitimacy lane reads FREE PRIMARY SOURCES (GLEIF, SEC EDGAR,
// OFAC, Sourcify and a block explorer) rather than CoinMarketCap, so it spends
// no credits and answers to its own `primary-sources` policy rows.
import { RWA_ISSUER_CAPTURE_OPS } from '../_shared/intel/capture-rwa-issuer.ts'
// The RWA UNDERLYING REGISTRANT lane answers a DIFFERENT legal question from the
// issuer lane above: the CIK CoinMarketCap publishes on a tokenised stock is the
// underlying listed company's filer number, never the token issuer's. Its map op
// spends zero credits (rwaMap is a zero-cost capability), its profile op at most
// twelve a run, and its EDGAR op none at all.
import { RWA_UNDERLYING_CAPTURE_OPS } from '../_shared/intel/capture-rwa-underlyings.ts'
// Tokenised-asset on-chain DEPTH: cross-chain deployment resolution plus pool
// reads on the four chains CoinMarketCap publishes DEX data for on this plan.
// This is the one CMC-metered RWA lane; its per-run ceiling is 87 credits at a
// daily cadence and its `rwa_depth` policy row states it.
import { RWA_DEPTH_CAPTURE_OPS } from '../_shared/intel/capture-rwa-depth.ts'
// Wrapper premium, discount and dispersion for one underlying asset wrapped by
// several tokens, plus the reconciliation between the RWA list endpoint's
// asset-level value and the sum of what the quotes endpoint says that asset's own
// tokens are worth. This lane DOES spend CoinMarketCap credits, bounded at 5 per
// run and 20 a day; it answers to the `coinmarketcap` / `rwa_wrappers` policy row.
import { RWA_WRAPPER_CAPTURE_OPS } from '../_shared/intel/capture-rwa-wrappers.ts'
// "Unusual for THIS asset": each asset's newest complete day scored against its
// OWN trailing distribution. It calls no provider at all — it reads the stored
// candle archive above plus the catalogue — so it reports zero credits and
// answers to its own `local` provider_schedule_policy row, which it loads itself.
import { UNUSUAL_CAPTURE_OPS } from '../_shared/intel/capture-unusual.ts'
// Premium history for the wrapper board. The view reads the six-hourly wrapper
// captures already kept for 400 days, plus days before the first capture that an
// operator-run backfill rebuilt from daily OHLCV (one credit per wrapper, once;
// its policy row ships disabled and it refuses unless historical retention is on).
import { RWA_WRAPPER_BACKFILL_OPS } from '../_shared/intel/capture-rwa-wrapper-backfill.ts'
// Daily RWA universe coverage: every tokenised asset in the RWA map, read through
// the quotes endpoint in batches of 100 (about 8 credits a day), classified as
// tradeable, priced but not traded, or listed only, and diffed against the day
// before. Its views also serve issuer concentration and the expected-ticker watch.
// It answers to the `coinmarketcap` / `rwa_coverage` policy row.
import { RWA_COVERAGE_OPS } from '../_shared/intel/capture-rwa-coverage.ts'
// Keeps the judge-path RWA entries of the shared cache inside their window: the
// first /intel/rwa list page and ONE batched quotes read of the lookup examples,
// that page's rows and the wrapper board. At most 2 credits a run, about 47 a
// day, claimed from the same daily free RWA budget as the public lookup; its
// pg_cron tick only calls in when an entry reaches the end of its window.
import { RWA_QUOTE_WARM_OPS } from '../_shared/intel/capture-rwa-quote-warm.ts'

// Both keyless RWA lanes are registered here. Dropping either spread silently
// removes a whole capture lane while every test still passes, so both must
// appear here and in LANE_VIEWS (_shared/intel/capture-read-envelope.ts).
const LANE_OPS = { ...VENUE_CAPTURE_OPS, ...CATEGORY_CAPTURE_OPS, ...FX_CAPTURE_OPS, ...LISTING_CAPTURE_OPS, ...MEME_CAPTURE_OPS, ...LAUNCHPAD_CAPTURE_OPS, ...SUNPUMP_CAPTURE_OPS, ...CANDLE_CAPTURE_OPS, ...RWA_YIELD_CAPTURE_OPS, ...RWA_ISSUER_CAPTURE_OPS, ...RWA_UNDERLYING_CAPTURE_OPS, ...RWA_DEPTH_CAPTURE_OPS, ...RWA_WRAPPER_CAPTURE_OPS, ...RWA_COVERAGE_OPS, ...RWA_WRAPPER_BACKFILL_OPS, ...UNUSUAL_CAPTURE_OPS, ...RWA_QUOTE_WARM_OPS }

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret' }
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } })
}

const CAPTURE_OPS = ['regime', 'index', 'rwa', 'rank_daily', 'rank_backfill', 'liquidations', 'attention', 'airdrops', 'all_hourly', ...Object.keys(LANE_OPS)] as const
const HOURLY_SEQUENCE = ['regime', 'index', 'rwa', 'attention'] as const
const BUDGET_MS = 100_000          // total wall clock for one invocation
const JOB_RESERVE_MS = 15_000      // stop starting another job this close to the budget

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: { ...corsHeaders, 'Access-Control-Max-Age': '600' } })
  const startedAt = Date.now()
  const deadline = startedAt + BUDGET_MS
  try {
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const admin = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const op = String(body.op || '')

    // ── Read half: a signed-in Intel member of the requested org ──
    if (op === 'read') {
      const orgId = typeof body.orgId === 'string' ? body.orgId : null
      const actor = await requireIntelAccess(req, createClient, admin, orgId)
      if (!actor?.userId) return json({ error: 'unauthorized' }, 401)
      // View registry, sourcePolicy and the response envelope are shared with
      // intel-demo-snapshot (_shared/intel/capture-read-envelope.ts), so the demo
      // stores exactly what this read returns.
      const read = await captureReadEnvelope(admin, body, { now: Date.now(), startedAt, env: (key) => Deno.env.get(key) })
      return json(read.body, read.status)
    }

    if (!CAPTURE_OPS.includes(op as typeof CAPTURE_OPS[number])) return json({ error: 'unsupported_op', ops: [...CAPTURE_OPS, 'read'] }, 400)

    // ── Capture half: operational cron secret, or a super admin by hand ──
    const cronOk = req.headers.get('x-cron-secret') === Deno.env.get('CRON_SECRET')
    if (!cronOk) {
      const authHeader = req.headers.get('Authorization')
      if (!authHeader) return json({ error: 'unauthorized' }, 401)
      const asUser = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
      const { data: { user } } = await asUser.auth.getUser()
      const { data: profile } = user ? await asUser.from('profiles').select('is_super_admin').eq('id', user.id).maybeSingle() : { data: null }
      if (!profile?.is_super_admin) return json({ error: 'forbidden' }, 403)
    }

    const now = new Date()
    const [policy, settings, observed] = await Promise.all([loadSchedulePolicy(admin), loadCmcOperatingSettings(admin), loadAccountObservations(admin)])
    const plan = cmcPlan(now.getTime(), settings)
    // One calibration, applied once to the policy rows, so every lane below
    // reads a cadence this account can actually sustain to its reset without any
    // lane knowing this exists. The multiplier only ever stretches a cadence and
    // is exactly 1 whenever the burn cannot be measured, so the reviewed plan
    // table remains both the default and the fastest rate anyone approved.
    const calibration = calibrateCadence({
      observations: observed.observations, ceiling: cmcCreditCeiling(settings), now: now.getTime(), error: observed.error,
      previousScale: observed.previousScale,
      boundaries: [settings.CMC_SOURCE_POLICY_EXPIRES_AT ?? null, settings.CMC_HACKATHON_EXPIRES_AT ?? null],
    })
    // Record what was applied so the next run's move is bounded relative to it.
    // Advisory: losing this costs a slower ramp, never a faster cadence.
    try { await admin.rpc('cmc_cadence_scale_record', { p_scale: calibration.scale }) } catch { /* the reviewed cadence still stands */ }
    const deps: CaptureDeps = { request: requestCmc, policy: calibratePolicyRows(policy, calibration) }
    // A per-job context carries its own call ceiling, so one lane can never
    // consume the budget of another inside the hourly batch.
    const ctxFor = (name: string, maxCalls: number) => ({ supabase: admin, jobName: 'intel-capture', caller: `intel-capture-${name}`, kind: 'job' as const, maxCalls })

    const runners: Record<string, () => Promise<JobResult>> = {
      regime: () => captureRegime(admin, ctxFor('regime', 3), now, deps),
      index: () => captureIndexConstituents(admin, ctxFor('index', 2), now, deps),
      rwa: () => captureRwaUniverse(admin, ctxFor('rwa', 6), now, deps),
      rank_daily: () => captureRankDaily(admin, ctxFor('rank-daily', 0), now, deps),
      rank_backfill: () => backfillRankHistory(admin, ctxFor('rank-backfill', 12), {
        weeks: Number(body.weeks) || 52, limit: Number(body.limit) || 250,
        maxWeeksPerRun: Number(body.maxWeeksPerRun) || 8, now,
      }, deps),
      liquidations: () => captureLiquidations(admin, ctxFor('liquidations', 1), now, deps),
      attention: () => captureAttention(admin, ctxFor('attention', 4), now, plan, deps),
      airdrops: () => captureAirdrops(admin, ctxFor('airdrops', 2), now, plan, deps),
      // Lane ops take the request BODY as a sixth argument. Every lane before
      // the candle history one ignores it; `history_backfill` reads `assetKey`
      // from it so one named asset can be filled by hand.
      ...Object.fromEntries(Object.entries(LANE_OPS).map(([name, run]) => [name, () => (run as (...args: unknown[]) => Promise<JobResult>)(admin, ctxFor, now, plan, deps, body)])),
    }

    const sequence = op === 'all_hourly' ? [...HOURLY_SEQUENCE] : [op]
    const jobs: JobResult[] = []
    for (const name of sequence) {
      if (jobs.length && Date.now() > deadline - JOB_RESERVE_MS) { jobs.push({ job: name, rows: 0, credits: 0, skipped: 'time_budget' }); continue }
      jobs.push(await runners[name]())
    }

    const credits = jobs.reduce((sum, job) => sum + (Number(job.credits) || 0), 0)
    const rows = jobs.reduce((sum, job) => sum + (Number(job.rows) || 0), 0)
    console.info('intel_capture_run', { op, plan, credits, rows, durationMs: Date.now() - startedAt, calibration: { scale: calibration.scale, reason: calibration.reason, usable: calibration.usable }, jobs: jobs.map((j) => ({ job: j.job, rows: j.rows, credits: j.credits, skipped: j.skipped ?? null, error: j.error ?? null })) })
    return json({ ok: jobs.every((job) => !job.error), op, plan, calibration, jobs, credits, rows, durationMs: Date.now() - startedAt })
  } catch (e) {
    const denied = orgAuthzErrorResponse(e, corsHeaders)
    if (denied) return denied
    return json({ error: (e as Error)?.message || 'intel_capture_failed', durationMs: Date.now() - startedAt }, 500)
  }
})
