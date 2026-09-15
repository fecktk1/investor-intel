-- Investor Intel — the plan-aware scheduler: plan targets onto the policy table, the policy table onto pg_cron.
--
-- On 2026-09-30 23:59 UTC the hackathon Startup profile expires and the effective CoinMarketCap plan falls back to
-- the verified baseline (Basic: 15,000 credits a month, 50 requests a minute). Nothing in the stack notices on its
-- own: the catalogue cron would keep firing every five minutes at four credits a run, about 34,560 credits a month
-- from one job, and the account would be exhausted in the first week of October. This migration is what makes that
-- date a cadence change instead of an outage.
--
-- Three steps, each its own function so each can be run and read separately:
--   1. app_private.intel_effective_cmc_plan()      — the same rule as cmcPlan() in _shared/market-assets/cmc-transport.ts:
--                                                    an explicit verified profile, never a tier inferred from the balance.
--   2. app_private.intel_apply_plan_targets()      — writes the plan's target cadences onto provider_schedule_policy.
--   3. app_private.intel_apply_schedule_cadences() — turns those cadences into cron schedules via cron.alter_job.
-- A nightly job at 00:15 UTC runs 2 then 3. Nothing here is executed at migration time: the first apply is a manual
-- `SELECT app_private.intel_apply_plan_targets();` after review.
--
-- The target tables in app_private.intel_schedule_plan_targets mirror planTargets() in
-- supabase/functions/_shared/intel/schedule-policy.ts. Change one and you must change the other; each is pinned by
-- its own test (scripts/test-intel-schedule-policy.mjs here, schedule-policy.test.ts there).
--
-- A manual override is never overwritten. A policy row whose `reason` does not start with 'auto:' (and is not empty)
-- belongs to an operator: it is reported and left exactly as it is, on every plan, for ever.

-- 0. The seeds in 20260914232100 carry descriptive reasons ('asset catalogue and identity refresh' and so on). Under
-- the override rule every one of those would read as a manual pin and the scheduler would never touch a single row.
-- Clear them to NULL — but only where the text is still character-for-character the seed, so an operator who has
-- already written their own reason keeps it.
UPDATE public.provider_schedule_policy p
SET reason = NULL
FROM (VALUES
  ('catalogue', 'asset catalogue and identity refresh'),
  ('quotes', 'broad listings and quote refresh'),
  ('regime', 'fear and greed, altcoin season, global metrics'),
  ('rwa', 'tokenised real-world asset universe'),
  ('structure', 'market structure, liquidations and index levels'),
  ('attention', 'trending, most visited, gainers and losers'),
  ('history', 'historical listings for rank history'),
  ('metadata', 'asset metadata, links and descriptions'),
  ('exchange_reserves', 'exchange asset reserves'),
  ('venue_share', 'spot and derivatives venue share'),
  ('airdrops', 'airdrop list refresh'),
  ('network_stats', 'chain hashrate, difficulty and throughput'),
  ('logo_verify', 'logo and image URL verification')
) AS seed(feature, reason)
WHERE p.provider = 'coinmarketcap' AND p.feature = seed.feature AND p.reason = seed.reason;

-- 1. The plan ladder. array_position returns NULL for a plan nobody has heard of, and coalesce turns that into 0, so
-- an unknown plan ranks below Basic and an unknown minimum is never treated as "no minimum".
CREATE OR REPLACE FUNCTION app_private.intel_plan_rank(p_plan text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT coalesce(array_position(
    ARRAY['basic', 'builder', 'startup', 'growth', 'professional', 'enterprise'],
    lower(btrim(coalesce(p_plan, '')))), 0)
$$;
REVOKE ALL ON FUNCTION app_private.intel_plan_rank(text) FROM PUBLIC, anon, authenticated;

-- The effective plan, read from the operating profile exactly the way cmcPlan() reads it. The Edge runtime can also
-- override these through environment variables; SQL cannot see those, so the nightly job follows the stored profile,
-- which is the only value the whole fleet shares.
CREATE OR REPLACE FUNCTION app_private.intel_effective_cmc_plan(p_now timestamptz DEFAULT now())
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_config jsonb;
  v_expires timestamptz;
BEGIN
  SELECT config INTO v_config
  FROM public.provider_quota_budgets
  WHERE provider = 'coinmarketcap'
    AND data_type = 'cmc_operating_profile'
    AND period_start = timestamptz '1970-01-01 00:00:00+00';
  v_config := coalesce(v_config, '{}'::jsonb);

  BEGIN
    v_expires := (v_config ->> 'CMC_HACKATHON_EXPIRES_AT')::timestamptz;
  EXCEPTION WHEN others THEN
    v_expires := NULL;
  END;
  v_expires := coalesce(v_expires, timestamptz '2026-09-30 23:59:00+00');

  IF v_config ->> 'CMC_ACCESS_PROFILE' = 'hackathon' AND p_now < v_expires THEN
    RETURN coalesce(nullif(btrim(v_config ->> 'CMC_VERIFIED_HACKATHON_PLAN'), ''), 'basic');
  END IF;
  RETURN coalesce(nullif(btrim(v_config ->> 'CMC_VERIFIED_BASELINE_PLAN'), ''), 'basic');
END $$;
REVOKE ALL ON FUNCTION app_private.intel_effective_cmc_plan(timestamptz) FROM PUBLIC, anon, authenticated;

-- 2. The per-plan target cadences. Startup and above get the seeded table; Basic and Builder get the 15,000-credit
-- month: catalogue hourly, quotes for the in-use set every fifteen minutes, regime hourly, RWA every two hours,
-- liquidations hourly, metadata daily. Startup-only (attention), Builder-only (airdrops) and Growth-only
-- (network_stats) work is switched off with a reason rather than attempted and refused at the provider. History keeps
-- its daily cadence so re-entitlement needs no cadence edit; its min_plan of 'startup' is what holds the backfill off.
CREATE OR REPLACE FUNCTION app_private.intel_schedule_plan_targets(p_plan text)
RETURNS TABLE (feature text, cadence_seconds integer, enabled boolean, min_plan text)
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT t.feature, t.cadence_seconds, t.enabled, t.min_plan
  FROM (VALUES
    ('startup', 'catalogue',          300,    true,  'basic'),
    ('startup', 'quotes',             300,    true,  'basic'),
    ('startup', 'regime',             3600,   true,  'basic'),
    ('startup', 'rwa',                3600,   true,  'basic'),
    ('startup', 'structure',          300,    true,  'basic'),
    ('startup', 'attention',          3600,   true,  'startup'),
    ('startup', 'history',            86400,  true,  'startup'),
    ('startup', 'metadata',           86400,  true,  'basic'),
    ('startup', 'exchange_reserves',  86400,  true,  'basic'),
    ('startup', 'venue_share',        604800, true,  'basic'),
    ('startup', 'airdrops',           86400,  true,  'builder'),
    ('startup', 'network_stats',      3600,   true,  'growth'),
    ('startup', 'logo_verify',        86400,  true,  'basic'),
    ('basic',   'catalogue',          3600,   true,  'basic'),
    ('basic',   'quotes',             900,    true,  'basic'),
    ('basic',   'regime',             3600,   true,  'basic'),
    ('basic',   'rwa',                7200,   true,  'basic'),
    ('basic',   'structure',          3600,   true,  'basic'),
    ('basic',   'attention',          3600,   false, 'startup'),
    ('basic',   'history',            86400,  true,  'startup'),
    ('basic',   'metadata',           86400,  true,  'basic'),
    ('basic',   'exchange_reserves',  86400,  true,  'basic'),
    ('basic',   'venue_share',        604800, true,  'basic'),
    ('basic',   'airdrops',           86400,  false, 'builder'),
    ('basic',   'network_stats',      3600,   false, 'growth'),
    ('basic',   'logo_verify',        86400,  true,  'basic')
  ) AS t(plan_table, feature, cadence_seconds, enabled, min_plan)
  WHERE t.plan_table = CASE
    WHEN app_private.intel_plan_rank(p_plan) >= app_private.intel_plan_rank('startup') THEN 'startup'
    ELSE 'basic' END
$$;
REVOKE ALL ON FUNCTION app_private.intel_schedule_plan_targets(text) FROM PUBLIC, anon, authenticated;

-- Write the plan's targets onto provider_schedule_policy. Only cadence_seconds and enabled are written: min_plan is
-- the entitlement fact and belongs to whoever reviewed the plan, not to a nightly job. A row that does not exist is
-- reported, never invented — creating schedule rows belongs to the migration that seeds them.
CREATE OR REPLACE FUNCTION app_private.intel_apply_plan_targets(p_plan text DEFAULT NULL, p_dry_run boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_plan text;
  v_reason text;
  v_entries jsonb := '[]'::jsonb;
  v_counts jsonb := jsonb_build_object('updated', 0, 'unchanged', 0, 'skipped_manual', 0, 'missing_row', 0);
  v_action text;
  t record;
  r record;
BEGIN
  v_plan := coalesce(nullif(btrim(p_plan), ''), app_private.intel_effective_cmc_plan());
  v_reason := 'auto:' || v_plan;

  FOR t IN SELECT * FROM app_private.intel_schedule_plan_targets(v_plan) ORDER BY 1 LOOP
    SELECT * INTO r FROM public.provider_schedule_policy
     WHERE provider = 'coinmarketcap' AND feature = t.feature
     FOR UPDATE;

    IF r.feature IS NULL THEN
      v_action := 'missing_row';
    ELSIF r.reason IS NOT NULL AND btrim(r.reason) <> '' AND left(btrim(r.reason), 5) <> 'auto:' THEN
      v_action := 'skipped_manual';
    ELSIF r.cadence_seconds IS NOT DISTINCT FROM t.cadence_seconds
      AND r.enabled IS NOT DISTINCT FROM t.enabled
      AND r.reason IS NOT DISTINCT FROM v_reason THEN
      v_action := 'unchanged';
    ELSE
      IF NOT p_dry_run THEN
        UPDATE public.provider_schedule_policy
           SET cadence_seconds = t.cadence_seconds, enabled = t.enabled, reason = v_reason, updated_at = now()
         WHERE provider = 'coinmarketcap' AND feature = t.feature;
      END IF;
      v_action := 'updated';
    END IF;

    v_counts := jsonb_set(v_counts, ARRAY[v_action], to_jsonb(coalesce((v_counts ->> v_action)::integer, 0) + 1));
    v_entries := v_entries || jsonb_build_object(
      'feature', t.feature,
      'action', v_action,
      'from', CASE WHEN r.feature IS NULL THEN NULL ELSE jsonb_build_object(
        'cadenceSeconds', r.cadence_seconds, 'enabled', r.enabled, 'reason', r.reason) END,
      'to', jsonb_build_object('cadenceSeconds', t.cadence_seconds, 'enabled', t.enabled, 'reason', v_reason),
      'minPlan', t.min_plan);
  END LOOP;

  RETURN jsonb_build_object('plan', v_plan, 'dryRun', p_dry_run, 'appliedAt', now(),
    'counts', v_counts, 'entries', v_entries);
END $$;
REVOKE ALL ON FUNCTION app_private.intel_apply_plan_targets(text, boolean) FROM PUBLIC, anon, authenticated;

-- 3. The policy table onto pg_cron. Only three features map to a job, and only the cadences listed here map to a
-- schedule: an unknown cadence leaves the job exactly as it is and says so, because guessing a cron expression for an
-- unreviewed cadence is how a job ends up running every minute. A job that does not exist yet (the Stage 2 capture
-- jobs are landing separately) is skipped with a reason, not created here.
--   catalogue → market-assets-refresh-broad     300 → */5, 900 → */15, 3600 → :12
--   regime    → intel-capture-hourly            3600 → :07, 7200 → :07 every second hour
--   structure → intel-capture-liquidations-5m   300 → */5, 3600 → :03
-- The RWA capture rides inside the hourly job and skips itself by cadence, so it has no job of its own.
-- A disabled feature also deactivates its job (and re-enabling reactivates it), so "enabled = false" means the run
-- actually stops. Note that market-assets-refresh-broad also drives the CoinGecko fallback refresh: disabling the
-- catalogue feature stops that too.
CREATE OR REPLACE FUNCTION app_private.intel_apply_schedule_cadences(p_dry_run boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_entries jsonb := '[]'::jsonb;
  v_action text;
  v_schedule text;
  v_active boolean;
  v_jobid bigint;
  v_from text;
  v_from_active boolean;
  m record;
  r record;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RETURN jsonb_build_object('dryRun', p_dry_run, 'appliedAt', now(), 'jobs', v_entries, 'note', 'cron_unavailable');
  END IF;

  FOR m IN SELECT * FROM (VALUES
      ('catalogue', 'market-assets-refresh-broad'),
      ('regime',    'intel-capture-hourly'),
      ('structure', 'intel-capture-liquidations-5m')
    ) AS map(feature, jobname) ORDER BY 1 LOOP

    v_schedule := NULL; v_active := NULL; v_jobid := NULL; v_from := NULL; v_from_active := NULL;

    SELECT * INTO r FROM public.provider_schedule_policy
     WHERE provider = 'coinmarketcap' AND feature = m.feature;

    IF r.feature IS NULL THEN
      v_action := 'policy_row_missing';
    ELSE
      v_schedule := CASE
        WHEN m.feature = 'catalogue' AND r.cadence_seconds = 300  THEN '*/5 * * * *'
        WHEN m.feature = 'catalogue' AND r.cadence_seconds = 900  THEN '*/15 * * * *'
        WHEN m.feature = 'catalogue' AND r.cadence_seconds = 3600 THEN '12 * * * *'
        WHEN m.feature = 'regime'    AND r.cadence_seconds = 3600 THEN '7 * * * *'
        WHEN m.feature = 'regime'    AND r.cadence_seconds = 7200 THEN '7 */2 * * *'
        WHEN m.feature = 'structure' AND r.cadence_seconds = 300  THEN '*/5 * * * *'
        WHEN m.feature = 'structure' AND r.cadence_seconds = 3600 THEN '3 * * * *'
        ELSE NULL END;

      IF v_schedule IS NULL THEN
        v_action := 'unmapped_cadence';
      ELSE
        SELECT j.jobid, j.schedule, j.active INTO v_jobid, v_from, v_from_active
        FROM cron.job j WHERE j.jobname = m.jobname;

        IF v_jobid IS NULL THEN
          v_action := 'job_missing';
          v_schedule := NULL;
        ELSE
          v_active := r.enabled;
          IF v_from IS NOT DISTINCT FROM v_schedule AND v_from_active IS NOT DISTINCT FROM v_active THEN
            v_action := 'unchanged';
          ELSE
            IF NOT p_dry_run THEN
              PERFORM cron.alter_job(v_jobid, schedule := v_schedule, active := v_active);
            END IF;
            v_action := 'altered';
          END IF;
        END IF;
      END IF;
    END IF;

    v_entries := v_entries || jsonb_build_object(
      'feature', m.feature, 'jobname', m.jobname, 'action', v_action,
      'cadenceSeconds', r.cadence_seconds, 'featureEnabled', r.enabled,
      'from', v_from, 'fromActive', v_from_active,
      'schedule', v_schedule, 'active', v_active);
  END LOOP;

  RETURN jsonb_build_object('dryRun', p_dry_run, 'appliedAt', now(), 'jobs', v_entries);
END $$;
REVOKE ALL ON FUNCTION app_private.intel_apply_schedule_cadences(boolean) FROM PUBLIC, anon, authenticated;

-- 4. The job names the Data budget panel reports on. A name that is not scheduled yet simply does not appear.
CREATE OR REPLACE FUNCTION app_private.intel_schedule_job_names()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT ARRAY[
    'market-assets-refresh-broad', 'market-assets-refresh-deep', 'market-macro-refresh-30m',
    'market-assets-derived', 'market-asset-logo-verify-nightly', 'market-asset-logo-verify-hourly-catchup',
    'intel-capture-hourly', 'intel-capture-liquidations-5m', 'intel-capture-rank-daily',
    'intel-capture-rank-backfill', 'intel-capture-airdrops-daily', 'intel-capture-retention-daily',
    'intel-observation-cadence-claims', 'intel-schedule-policy-apply']
$$;
REVOKE ALL ON FUNCTION app_private.intel_schedule_job_names() FROM PUBLIC, anon, authenticated;

-- The three grouped reads the Data budget panel needs, none of which PostgREST can do on its own: cron lives outside
-- the exposed schemas, and grouping seven days of call logs or thirty days of demand in the Edge Function would mean
-- shipping every row. The call-log scan is bounded to the most recent 200,000 rows so the 8-second PostgREST budget
-- holds even after a busy week.
CREATE OR REPLACE FUNCTION app_private.intel_data_budget_snapshot(
  p_call_days integer DEFAULT 7,
  p_demand_days integer DEFAULT 30,
  p_top integer DEFAULT 15,
  p_provider text DEFAULT 'coinmarketcap'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_call_days integer := least(greatest(coalesce(p_call_days, 7), 1), 90);
  v_demand_days integer := least(greatest(coalesce(p_demand_days, 30), 1), 400);
  v_top integer := least(greatest(coalesce(p_top, 15), 1), 100);
  v_jobs jsonb := '[]'::jsonb;
  v_reuse jsonb := '[]'::jsonb;
  v_demand jsonb := '[]'::jsonb;
BEGIN
  IF to_regclass('cron.job') IS NOT NULL THEN
    BEGIN
      SELECT coalesce(jsonb_agg(jsonb_build_object(
          'jobname', j.jobname, 'schedule', j.schedule, 'active', j.active,
          'lastRun', CASE WHEN d.status IS NULL THEN NULL ELSE jsonb_build_object(
            'status', d.status, 'start', d.start_time, 'end', d.end_time) END)
        ORDER BY j.jobname), '[]'::jsonb)
      INTO v_jobs
      FROM cron.job j
      LEFT JOIN LATERAL (
        SELECT run.status, run.start_time, run.end_time
        FROM cron.job_run_details run
        WHERE run.jobid = j.jobid
        ORDER BY run.start_time DESC
        LIMIT 1
      ) d ON true
      WHERE j.jobname = ANY (app_private.intel_schedule_job_names());
    EXCEPTION WHEN undefined_table OR undefined_column OR insufficient_privilege THEN
      v_jobs := '[]'::jsonb;
    END;
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'endpoint', s.endpoint, 'calls', s.calls, 'live', s.live, 'hits', s.hits,
      'misses', s.misses, 'credits', s.credits) ORDER BY s.calls DESC), '[]'::jsonb)
  INTO v_reuse
  FROM (
    SELECT l.endpoint,
      count(*) AS calls,
      count(*) FILTER (WHERE l.cache_status = 'live') AS live,
      count(*) FILTER (WHERE l.cache_status IN ('hit', 'negative_hit')) AS hits,
      count(*) FILTER (WHERE l.cache_status = 'miss') AS misses,
      round(coalesce(sum(l.credits_or_cu), 0), 2) AS credits
    FROM (
      SELECT c.endpoint, c.cache_status, c.credits_or_cu
      FROM public.provider_call_logs c
      WHERE c.provider = p_provider AND c.ts >= now() - make_interval(days => v_call_days)
      ORDER BY c.ts DESC
      LIMIT 200000
    ) l
    GROUP BY l.endpoint
    ORDER BY count(*) DESC
    LIMIT v_top
  ) s;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'day', d.day, 'assets', d.assets, 'demands', d.demands) ORDER BY d.day), '[]'::jsonb)
  INTO v_demand
  FROM (
    SELECT r.day, count(*) AS assets, sum(r.demand_count) AS demands
    FROM public.market_asset_demand_daily r
    WHERE r.day >= (now() AT TIME ZONE 'UTC')::date - v_demand_days
    GROUP BY r.day
  ) d;

  RETURN jsonb_build_object(
    'generatedAt', now(), 'callDays', v_call_days, 'demandDays', v_demand_days,
    'jobs', v_jobs, 'cacheReuse', v_reuse, 'demandDaily', v_demand);
END $$;
REVOKE ALL ON FUNCTION app_private.intel_data_budget_snapshot(integer, integer, integer, text) FROM PUBLIC, anon, authenticated;

-- 5. The two public wrappers. PostgREST exposes only public and graphql_public, so an Edge Function holding the
-- service-role key cannot reach app_private at all; these are the only way in. Same shape as
-- 20260914235228_intel_record_asset_demand_public.sql: SECURITY DEFINER, nothing of their own, service_role alone.
-- REVOKE FROM PUBLIC on its own would leave the default EXECUTE grant a new function already carries.
CREATE OR REPLACE FUNCTION public.intel_apply_schedule_cadences(p_dry_run boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN app_private.intel_apply_schedule_cadences(p_dry_run);
END $$;
REVOKE ALL ON FUNCTION public.intel_apply_schedule_cadences(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.intel_apply_schedule_cadences(boolean) TO service_role;
COMMENT ON FUNCTION public.intel_apply_schedule_cadences(boolean) IS
  'Service-role-only wrapper: applies provider_schedule_policy cadences to the pg_cron jobs. p_dry_run reports the changes without touching a job.';

CREATE OR REPLACE FUNCTION public.intel_data_budget_snapshot(
  p_call_days integer DEFAULT 7,
  p_demand_days integer DEFAULT 30,
  p_top integer DEFAULT 15,
  p_provider text DEFAULT 'coinmarketcap'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN app_private.intel_data_budget_snapshot(p_call_days, p_demand_days, p_top, p_provider);
END $$;
REVOKE ALL ON FUNCTION public.intel_data_budget_snapshot(integer, integer, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.intel_data_budget_snapshot(integer, integer, integer, text) TO service_role;
COMMENT ON FUNCTION public.intel_data_budget_snapshot(integer, integer, integer, text) IS
  'Service-role-only wrapper: cron job list with last run, provider call-log cache reuse, and the daily asset demand rollup, for the Data budget panel.';

-- 6. The nightly apply. pg_cron statements on this project are cancelled after 2 minutes unless the job sets its own
-- timeout. This runs the plan step then the cron step: on 1 October the profile has expired, intel_effective_cmc_plan
-- returns the baseline plan, the Basic targets are written and the catalogue job moves from */5 to :12 by itself.
DO $schedule$
BEGIN
  IF to_regclass('cron.job') IS NOT NULL THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'intel-schedule-policy-apply';
    PERFORM cron.schedule('intel-schedule-policy-apply', '15 0 * * *',
      $job$SET statement_timeout = '5min'; SELECT app_private.intel_apply_plan_targets(); SELECT app_private.intel_apply_schedule_cadences()$job$);
  END IF;
END
$schedule$;

-- Deliberately NOT executed here; run it once after reviewing the diff:
--   SELECT app_private.intel_apply_plan_targets(NULL, true);   -- dry run, changes nothing
--   SELECT app_private.intel_apply_plan_targets();             -- write the policy rows
--   SELECT app_private.intel_apply_schedule_cadences();        -- move the cron jobs
