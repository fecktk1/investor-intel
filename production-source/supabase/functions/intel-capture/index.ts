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
import { readCaptureView, CAPTURE_VIEWS } from '../_shared/intel/capture-read.ts'
// Stage 3 lanes live in their own modules and plug in through one shared
// surface: ops run like the jobs above, views read like the views above.
import { VENUE_CAPTURE_OPS } from '../_shared/intel/capture-venues.ts'
import { VENUE_CAPTURE_VIEWS } from '../_shared/intel/capture-venues-read.ts'
import { CATEGORY_CAPTURE_OPS } from '../_shared/intel/capture-categories.ts'
import { CATEGORY_CAPTURE_VIEWS } from '../_shared/intel/capture-categories-read.ts'
import { FX_CAPTURE_OPS } from '../_shared/intel/capture-fx.ts'
import { FX_CAPTURE_VIEWS } from '../_shared/intel/capture-fx-read.ts'
import { LISTING_CAPTURE_OPS } from '../_shared/intel/capture-listings.ts'
import { LISTING_CAPTURE_VIEWS } from '../_shared/intel/capture-listings-read.ts'
import { MEME_CAPTURE_OPS } from '../_shared/intel/capture-meme.ts'
import { MEME_CAPTURE_VIEWS } from '../_shared/intel/capture-meme-read.ts'
// DIAGNOSTIC, TO BE REMOVED. `op:'meme_probe'` sends the documented
// /v1/dex/meme/list request variants once, stores nothing and answers with the
// body that produced each answer. It is registered here ONLY to inherit the
// capture gate below; delete this import, its entry in LANE_OPS and
// _shared/intel/meme-probe.ts once the empty meme board is explained.
import { MEME_PROBE_OPS } from '../_shared/intel/meme-probe.ts'
import { CANDLE_CAPTURE_OPS } from '../_shared/intel/capture-candles.ts'
import { CANDLE_CAPTURE_VIEWS } from '../_shared/intel/capture-candles-read.ts'
// RWA yield provenance and NAV integrity. This lane calls no CoinMarketCap
// endpoint: Chainlink NAV over a public RPC, Treasury, the New York Fed, the ECB
// and SEC EDGAR are all keyless, so it reports zero credits and has no plan gate.
import { RWA_YIELD_CAPTURE_OPS } from '../_shared/intel/capture-rwa-yield.ts'
import { RWA_YIELD_CAPTURE_VIEWS } from '../_shared/intel/capture-rwa-yield-read.ts'
// The RWA issuer legitimacy lane reads FREE PRIMARY SOURCES (GLEIF, SEC EDGAR,
// OFAC, Sourcify and a block explorer) rather than CoinMarketCap, so it spends
// no credits and answers to its own `primary-sources` policy rows.
import { RWA_ISSUER_CAPTURE_OPS } from '../_shared/intel/capture-rwa-issuer.ts'
import { RWA_ISSUER_CAPTURE_VIEWS } from '../_shared/intel/capture-rwa-issuer-read.ts'
// Source receipts for the capture views: what the newest capture run recorded
// about its own provider calls. A database read only; no provider call.
import { readCaptureReceipts } from '../_shared/intel/source-receipt.ts'

// Both keyless RWA lanes are registered here. Dropping either spread silently
// removes a whole capture lane while every test still passes, so both must
// appear in both objects.
const LANE_OPS = { ...VENUE_CAPTURE_OPS, ...CATEGORY_CAPTURE_OPS, ...FX_CAPTURE_OPS, ...LISTING_CAPTURE_OPS, ...MEME_CAPTURE_OPS, ...CANDLE_CAPTURE_OPS, ...RWA_YIELD_CAPTURE_OPS, ...RWA_ISSUER_CAPTURE_OPS, ...MEME_PROBE_OPS }
const LANE_VIEWS = { ...VENUE_CAPTURE_VIEWS, ...CATEGORY_CAPTURE_VIEWS, ...FX_CAPTURE_VIEWS, ...LISTING_CAPTURE_VIEWS, ...MEME_CAPTURE_VIEWS, ...CANDLE_CAPTURE_VIEWS, ...RWA_YIELD_CAPTURE_VIEWS, ...RWA_ISSUER_CAPTURE_VIEWS }

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
      const view = String(body.view || '')
      if (view === 'capture_receipts') return json({ ...await readCaptureReceipts(admin, body, Date.now()), durationMs: Date.now() - startedAt })
      const laneView = Object.hasOwn(LANE_VIEWS, view) ? LANE_VIEWS[view] : null
      if (!laneView && !CAPTURE_VIEWS.includes(view as typeof CAPTURE_VIEWS[number])) return json({ error: 'unsupported_view', views: [...CAPTURE_VIEWS, ...Object.keys(LANE_VIEWS), 'capture_receipts'] }, 400)
      const result = laneView ? await laneView(admin, body, Date.now()) : await readCaptureView(admin, view, body, Date.now())
      return json({ ...result, durationMs: Date.now() - startedAt })
    }

    if (!CAPTURE_OPS.includes(op as typeof CAPTURE_OPS[number])) return json({ error: 'unsupported_op', ops: [...CAPTURE_OPS, 'read'] }, 400)

    // ── Capture half: operational cron secret, or a super admin by hand ──
    // `authority` names which of the two let this run through. It is passed to
    // the lane ops, so an op that must refuse without the gate can say so itself
    // rather than trusting that it was mounted behind one (see meme-probe.ts).
    const cronOk = req.headers.get('x-cron-secret') === Deno.env.get('CRON_SECRET')
    if (!cronOk) {
      const authHeader = req.headers.get('Authorization')
      if (!authHeader) return json({ error: 'unauthorized' }, 401)
      const asUser = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
      const { data: { user } } = await asUser.auth.getUser()
      const { data: profile } = user ? await asUser.from('profiles').select('is_super_admin').eq('id', user.id).maybeSingle() : { data: null }
      if (!profile?.is_super_admin) return json({ error: 'forbidden' }, 403)
    }
    const authority = cronOk ? 'cron_secret' : 'super_admin'

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
      ...Object.fromEntries(Object.entries(LANE_OPS).map(([name, run]) => [name, () => (run as (...args: unknown[]) => Promise<JobResult>)(admin, ctxFor, now, plan, deps, body, authority)])),
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
