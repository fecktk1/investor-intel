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
import { requestCmc, cmcPlan, loadCmcOperatingSettings } from '../_shared/market-assets/cmc-transport.ts'
import { requireIntelAccess } from '../_shared/intel/research-service.ts'
import { orgAuthzErrorResponse } from '../_shared/org-authz.ts'
import {
  loadSchedulePolicy, captureRegime, captureIndexConstituents, captureRwaUniverse, captureRankDaily,
  backfillRankHistory, captureLiquidations, captureAttention, captureAirdrops, type CaptureDeps, type JobResult,
} from '../_shared/intel/capture-jobs.ts'
import { readCaptureView, CAPTURE_VIEWS } from '../_shared/intel/capture-read.ts'

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret' }
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } })
}

const CAPTURE_OPS = ['regime', 'index', 'rwa', 'rank_daily', 'rank_backfill', 'liquidations', 'attention', 'airdrops', 'all_hourly'] as const
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
      if (!CAPTURE_VIEWS.includes(view as typeof CAPTURE_VIEWS[number])) return json({ error: 'unsupported_view', views: CAPTURE_VIEWS }, 400)
      const result = await readCaptureView(admin, view, body, Date.now())
      return json({ ...result, durationMs: Date.now() - startedAt })
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
    const [policy, settings] = await Promise.all([loadSchedulePolicy(admin), loadCmcOperatingSettings(admin)])
    const plan = cmcPlan(now.getTime(), settings)
    const deps: CaptureDeps = { request: requestCmc, policy }
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
    }

    const sequence = op === 'all_hourly' ? [...HOURLY_SEQUENCE] : [op]
    const jobs: JobResult[] = []
    for (const name of sequence) {
      if (jobs.length && Date.now() > deadline - JOB_RESERVE_MS) { jobs.push({ job: name, rows: 0, credits: 0, skipped: 'time_budget' }); continue }
      jobs.push(await runners[name]())
    }

    const credits = jobs.reduce((sum, job) => sum + (Number(job.credits) || 0), 0)
    const rows = jobs.reduce((sum, job) => sum + (Number(job.rows) || 0), 0)
    console.info('intel_capture_run', { op, plan, credits, rows, durationMs: Date.now() - startedAt, jobs: jobs.map((j) => ({ job: j.job, rows: j.rows, credits: j.credits, skipped: j.skipped ?? null, error: j.error ?? null })) })
    return json({ ok: jobs.every((job) => !job.error), op, plan, jobs, credits, rows, durationMs: Date.now() - startedAt })
  } catch (e) {
    const denied = orgAuthzErrorResponse(e, corsHeaders)
    if (denied) return denied
    return json({ error: (e as Error)?.message || 'intel_capture_failed', durationMs: Date.now() - startedAt }, 500)
  }
})
