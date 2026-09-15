-- ============================================================
-- Investor Intel — exchange-reserve and venue-share capture schedules
-- ============================================================
-- Two daily lanes on the `intel-capture` Edge Function (CMC plan proposals 15
-- and 16), filling the tables created in 20260914232100_intel_capture_tables:
--
--   intel-capture-exchange-reserves-daily  '50 4 * * *'  {"op":"exchange_reserves"}
--       One exchange selection call plus one `/v1/exchange/assets` call for each
--       of the ten largest spot venues: 11 credits a day, ≤ 2 500 rows into
--       public.intel_exchange_reserve_snapshots (≤ 250 assets a venue).
--   intel-capture-venue-share-daily        '55 4 * * *'  {"op":"venue_share"}
--       One exchange listing call: 1 credit a day, ≤ 200 rows into
--       public.intel_venue_share_snapshots (spot and, where reported,
--       derivatives).
--
-- About 12 credits a day, ~360 a month, on top of the lanes scheduled in
-- 20260915010343_intel_capture_cron.
--
-- Both jobs are idempotent: rows are keyed on (venue, asset, day) and (kind,
-- venue, day) and upserted, and each job additionally skips with
-- `within_cadence` when the newest stored row is younger than the feature's
-- `cadence_seconds` in `provider_schedule_policy`. Disabling a lane is a single
-- row edit there — no redeploy, no unschedule.
--
-- Vault + net.http_post pattern, identical to 20260915010343_intel_capture_cron.
-- Cron auth is the operational x-cron-secret. Safe to apply anytime; idempotent.
--
-- Rollback (stop both lanes, keep the data):
--   SELECT cron.unschedule('intel-capture-exchange-reserves-daily');
--   SELECT cron.unschedule('intel-capture-venue-share-daily');
-- ============================================================

-- ── 0. A conflict target the writer can actually name ──
-- The live table is deduplicated by a UNIQUE INDEX on
-- (exchange_id, snapshot_date, provider_id, coalesce(platform_symbol, '')).
-- PostgREST's `on_conflict` takes column NAMES, so an expression index can never
-- be its conflict target and every upsert would fail with 42P10. The capture
-- lane therefore writes '' (never NULL) for a holding with no reported platform,
-- which makes this plain index exactly equivalent to the expression one and
-- gives the upsert something to name. Both indexes stay: the expression index
-- keeps rejecting a NULL-vs-'' duplicate from any other writer.
CREATE UNIQUE INDEX IF NOT EXISTS intel_exchange_reserve_snapshots_upsert_key_idx
  ON public.intel_exchange_reserve_snapshots (exchange_id, snapshot_date, provider_id, platform_symbol);

-- ── 1. Venue share is a daily figure, not a weekly one ──
-- 20260914232100 seeded `venue_share` at 604800 s. A weekly cadence makes the
-- job skip six days out of seven, so the daily share series would have one point
-- a week while the cron fired every night for nothing. 86400 s matches what the
-- table stores (one row per venue per kind per day) and costs 1 credit a day.
--
-- The plan-target table (app_private.intel_schedule_plan_targets, mirrored by
-- planTargets() in _shared/intel/schedule-policy.ts) moves to 86400 for both
-- plans in the same change, so the nightly apply keeps the daily cadence and
-- the row stays under automatic management (reason 'auto:<plan>').
UPDATE public.provider_schedule_policy
   SET cadence_seconds = 86400, updated_at = now()
 WHERE provider = 'coinmarketcap' AND feature = 'venue_share' AND cadence_seconds = 604800;

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
    ('startup', 'venue_share',        86400,  true,  'basic'),
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
    ('basic',   'venue_share',        86400,  true,  'basic'),
    ('basic',   'airdrops',           86400,  false, 'builder'),
    ('basic',   'network_stats',      3600,   false, 'growth'),
    ('basic',   'logo_verify',        86400,  true,  'basic')
  ) AS t(plan_table, feature, cadence_seconds, enabled, min_plan)
  WHERE t.plan_table = CASE
    WHEN app_private.intel_plan_rank(p_plan) >= app_private.intel_plan_rank('startup') THEN 'startup'
    ELSE 'basic' END
$$;
REVOKE ALL ON FUNCTION app_private.intel_schedule_plan_targets(text) FROM PUBLIC, anon, authenticated;

-- ── 2. Exchange reserves once a day (1 + 10 credits) ──
SELECT cron.unschedule('intel-capture-exchange-reserves-daily') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-capture-exchange-reserves-daily');
SELECT cron.schedule('intel-capture-exchange-reserves-daily', '50 4 * * *', $$
  SELECT net.http_post(
    url     := concat((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL'), '/functions/v1/intel-capture'),
    headers := jsonb_build_object('Content-Type','application/json','Authorization', concat('Bearer ', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')), 'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')),
    body    := jsonb_build_object('op','exchange_reserves'), timeout_milliseconds := 110000);
$$);

-- ── 3. Venue share once a day (1 credit), five minutes after the reserves ──
SELECT cron.unschedule('intel-capture-venue-share-daily') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-capture-venue-share-daily');
SELECT cron.schedule('intel-capture-venue-share-daily', '55 4 * * *', $$
  SELECT net.http_post(
    url     := concat((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL'), '/functions/v1/intel-capture'),
    headers := jsonb_build_object('Content-Type','application/json','Authorization', concat('Bearer ', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')), 'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')),
    body    := jsonb_build_object('op','venue_share'), timeout_milliseconds := 110000);
$$);
