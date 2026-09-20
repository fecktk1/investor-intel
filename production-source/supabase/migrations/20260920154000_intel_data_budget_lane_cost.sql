-- ============================================================
-- Investor Intel: per-lane provider cost for the Data budget page ("What this costs")
-- ============================================================
-- WHY. The Data budget page can already say what the CoinMarketCap PLAN allows, what the schedule PROJECTS, and what
-- the month has spent in total. It cannot say what one LANE costs, which is the question an operator and a reader
-- both actually ask: how often does this lane run, how many calls does one run make, and what has it charged in the
-- last day and the last month.
--
-- Every number is already recorded. `provider_call_logs.caller` IS the lane (verified against production on
-- 2026-09-20: 'intel-capture-regime', 'intel-capture-rwa', 'intel-capture-meme-stages', 'market-macro-refresh',
-- 'exchange-market-refresh:deep' and so on), `calls` and `credits_or_cu` are per row, and `job_name` names the cron
-- job that drove it. What is missing is a GROUPED read: provider_call_logs is service-role only, and grouping thirty
-- days of it inside the Edge Function would mean shipping every row across the wire. So this migration adds one
-- read-only RPC and nothing else.
--
-- ── WHAT THIS MIGRATION CREATES ──────────────────────────────────────────────────────────────────────────────────
--   app_private.intel_data_budget_lane_cost(p_provider text, p_top integer)  -> jsonb
--   public.intel_data_budget_lane_cost(p_provider text, p_top integer)       -> jsonb   (service_role only wrapper)
-- and NOTHING else. No table, no column, no constraint, no index, no cron job, no policy row. It therefore adds no
-- storage and cannot change any figure that is already displayed.
--
-- ── WHAT IT COSTS TO CALL ────────────────────────────────────────────────────────────────────────────────────────
-- Zero provider credits. It reads our own tables and calls nothing. It is not scheduled: it runs only when a super
-- admin opens /intel/admin/data-budget, the same as every other part of that page's read.
--
-- ── HOW THE SCAN STAYS INSIDE THE 8-SECOND POSTGREST BUDGET ──────────────────────────────────────────────────────
-- The same shape `intel_data_budget_snapshot` (20260915004534) already uses: ONE bounded subquery feeds every
-- grouping below it, so the planner never has to touch an unbounded history. The bound is 400,000 rows, newest
-- first. On production on 2026-09-20 the whole 30-day coinmarketcap window held roughly 250,000 rows, so the bound
-- is above the real volume and truncates nothing today.
--
-- A row limit that DID bite would silently SHORTEN the window rather than error, which is the trap recorded in
-- feedback_postgres_guard_traps. So the bound and the row count are both RETURNED (`scanLimit`, `scanned`,
-- `truncated`) and the page says the window is partial when they meet. A truncated read is a stated fact here, never
-- presented as a complete one.
--
-- ── WHY CADENCE AND CALLS PER RUN ARE MEASURED, NOT READ OFF THE SCHEDULE ─────────────────────────────────────────
-- `provider_schedule_policy.cadence_seconds` is the cadence a lane is CONFIGURED for, and the page already shows
-- that per feature in its "Scheduled features" table. This RPC reports the cadence the lane was OBSERVED at: the
-- MEDIAN gap between its distinct run minutes across the window. Median, not mean, because one long gap after a
-- paused day would drag a mean into a cadence the lane never ran at. Showing the observed cadence beside the
-- configured one makes a drift between them visible instead of hiding it behind a single number.
--
-- Fewer than two observed runs yields NULL, not a number: one run states no cadence at all, and a guessed one would
-- be read as a measurement. `callsPerRun` is likewise measured (calls divided by observed runs, two decimal places)
-- and NULL when no run was observed, rather than a division by zero dressed as a zero. It can legitimately come out
-- BELOW 1: a run whose reads were all answered from cache made no call, and `provider_call_logs.calls` is 0 on those
-- rows, which is exactly the fact the page is trying to show.
--
-- `runs30d` counts DISTINCT RUN MINUTES, so two concurrent readers inside one minute count once. That is right for a
-- scheduled lane, which is what this table is for; for an on-demand caller it reads as "minutes in which this lane
-- called at all", and the column is named for the run so the distinction is legible.
--
-- A lane with rows in the window but none in the last 24 hours reports 0 for the day. That is a reading, not a gap:
-- it means the lane charged nothing yesterday. A lane with no rows in the window at all does not appear, because
-- this RPC reports what was spent and cannot invent a lane that spent nothing.
--
-- ── WHAT IS NOT EXPOSED ──────────────────────────────────────────────────────────────────────────────────────────
-- provider_call_logs also records MEMBER-initiated calls and carries org_id, user_id, request_id, subject_ref and
-- error_message. None of those five columns is read here and none can reach the payload: the aggregate is over
-- caller, job_name, cache_status, calls, credits_or_cu and ts alone. The caller string is a lane name written by our
-- own code, never user input. The only consumer is `intel-data-budget`, which answers 403 to anyone who is not a
-- super admin, and that check is independent of this function.
--
-- IDEMPOTENT: CREATE OR REPLACE FUNCTION throughout, so a re-run replaces the definitions and creates nothing twice.
-- ============================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

-- 1. The grouped per-lane read. STABLE because it only ever reads; it performs no DDL and no write, so it is safe to
-- call from a read path and cheap to plan.
CREATE OR REPLACE FUNCTION app_private.intel_data_budget_lane_cost(
  p_provider text DEFAULT 'coinmarketcap',
  p_top integer DEFAULT 25
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  c_scan_limit constant integer := 400000;
  v_top integer := least(greatest(coalesce(p_top, 25), 1), 100);
  v_provider text := coalesce(nullif(btrim(coalesce(p_provider, '')), ''), 'coinmarketcap');
  v_scanned bigint := 0;
  v_lanes jsonb := '[]'::jsonb;
BEGIN
  WITH bounded AS (
    SELECT coalesce(c.caller, '(unnamed)') AS lane, c.job_name, c.cache_status,
      coalesce(c.calls, 0) AS calls, coalesce(c.credits_or_cu, 0) AS credits, c.ts
    FROM public.provider_call_logs c
    WHERE c.provider = v_provider AND c.ts >= now() - interval '30 days'
    ORDER BY c.ts DESC
    LIMIT c_scan_limit
  ),
  run_minutes AS (
    SELECT DISTINCT b.lane, date_trunc('minute', b.ts) AS minute FROM bounded b
  ),
  run_gaps AS (
    SELECT m.lane, extract(epoch FROM (m.minute - lag(m.minute) OVER (PARTITION BY m.lane ORDER BY m.minute))) AS gap
    FROM run_minutes m
  ),
  cadence AS (
    SELECT g.lane, round(percentile_cont(0.5) WITHIN GROUP (ORDER BY g.gap))::bigint AS cadence_seconds
    FROM run_gaps g WHERE g.gap IS NOT NULL GROUP BY g.lane
  ),
  grouped AS (
    SELECT b.lane,
      -- The job a lane was most recently driven by. A lane called from more than one job reports the newest, and the
      -- cron table on the same page carries the full job list, so nothing is lost by picking one here.
      (array_agg(b.job_name ORDER BY b.ts DESC) FILTER (WHERE b.job_name IS NOT NULL))[1] AS job_name,
      count(DISTINCT date_trunc('minute', b.ts)) AS runs_30d,
      coalesce(sum(b.calls) FILTER (WHERE b.ts >= now() - interval '24 hours'), 0) AS calls_24h,
      round(coalesce(sum(b.credits) FILTER (WHERE b.ts >= now() - interval '24 hours'), 0), 2) AS credits_24h,
      coalesce(sum(b.calls), 0) AS calls_30d,
      round(coalesce(sum(b.credits), 0), 2) AS credits_30d,
      -- What the cache absorbed. A lane whose reads are mostly cache hits charged far less than its row count
      -- suggests, and that is the most useful single fact on this table, so it is not left to be inferred.
      count(*) FILTER (WHERE b.cache_status = 'live') AS live_30d,
      count(*) FILTER (WHERE b.cache_status IN ('hit', 'negative_hit')) AS hits_30d,
      max(b.ts) AS newest_at
    FROM bounded b
    GROUP BY b.lane
  ),
  -- The WHOLE bounded set, not only the rows behind the lanes returned. `truncated` must describe the window that was
  -- actually read, so counting the top lanes' rows here would understate it and could never report a real truncation.
  scan AS (SELECT count(*) AS rows_scanned FROM bounded),
  ranked AS (
    SELECT g.*, c.cadence_seconds
    FROM grouped g LEFT JOIN cadence c ON c.lane = g.lane
    ORDER BY g.credits_30d DESC, g.calls_30d DESC
    LIMIT v_top
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'lane', r.lane,
      'jobName', r.job_name,
      'observedCadenceSeconds', r.cadence_seconds,
      'runs30d', r.runs_30d,
      'callsPerRun', CASE WHEN r.runs_30d > 0 THEN round(r.calls_30d::numeric / r.runs_30d, 2) END,
      'calls24h', r.calls_24h,
      'credits24h', r.credits_24h,
      'calls30d', r.calls_30d,
      'credits30d', r.credits_30d,
      'liveCalls30d', r.live_30d,
      'cacheHits30d', r.hits_30d,
      'newestAt', r.newest_at
    ) ORDER BY r.credits_30d DESC, r.calls_30d DESC), '[]'::jsonb),
    -- One constant column over a grouped-by-nothing aggregate, so it needs an aggregate of its own.
    coalesce(max(s.rows_scanned), 0)
  INTO v_lanes, v_scanned
  FROM scan s LEFT JOIN ranked r ON true;

  RETURN jsonb_build_object(
    'generatedAt', now(),
    'provider', v_provider,
    'windowDays', 30,
    'lanes', v_lanes,
    -- The bound and the count, so a window that reached its limit is a stated fact rather than a silently short read.
    -- `scanned` is every row the bounded scan read, across all lanes, so it is the figure `truncated` must compare.
    'scanned', v_scanned, 'scanLimit', c_scan_limit,
    'truncated', v_scanned >= c_scan_limit
  );
END $$;
REVOKE ALL ON FUNCTION app_private.intel_data_budget_lane_cost(text, integer) FROM PUBLIC, anon, authenticated;

-- 2. The public wrapper. PostgREST exposes only public and graphql_public, so an Edge Function holding the
-- service-role key cannot reach app_private at all; this is the only way in. Same shape as the two wrappers in
-- 20260915004534: SECURITY DEFINER, nothing of its own, service_role alone. REVOKE FROM PUBLIC on its own would
-- leave the default EXECUTE grant a new function already carries, which is the trap in feedback_postgres_guard_traps,
-- so anon and authenticated are named explicitly.
CREATE OR REPLACE FUNCTION public.intel_data_budget_lane_cost(
  p_provider text DEFAULT 'coinmarketcap',
  p_top integer DEFAULT 25
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN app_private.intel_data_budget_lane_cost(p_provider, p_top);
END $$;
REVOKE ALL ON FUNCTION public.intel_data_budget_lane_cost(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.intel_data_budget_lane_cost(text, integer) TO service_role;

COMMIT;
