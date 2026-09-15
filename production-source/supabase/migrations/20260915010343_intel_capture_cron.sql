-- ============================================================
-- Investor Intel — CoinMarketCap capture schedules
-- ============================================================
-- Drives the `intel-capture` Edge Function, which fills the capture tables from
-- 20260914232100_intel_capture_tables (regime, index constituents, the RWA
-- universe, rank history, liquidations, attention lists and airdrops).
--
-- Cadence and credits per run (the ceiling; a fresh shared cache costs 0):
--   intel-capture-hourly            '7 * * * *'   regime 3 + index 2 + rwa 6 + attention 4  (attention only on Startup+)
--   intel-capture-liquidations-5m   '*/5 * * * *' 1 credit, 288 a day
--   intel-capture-rank-daily        '20 0 * * *'  0 credits (reads the market_assets catalogue)
--   intel-capture-rank-backfill     '40 0 * * *'  3 credits per missing week, at most 8 weeks a run
--   intel-capture-airdrops-daily    '30 5 * * *'  1 credit per status (ONGOING + UPCOMING), Builder+
--
-- Every job is idempotent: the capture rows are keyed on their time bucket and
-- upserted, and each job additionally skips when the newest row is younger than
-- the feature's `cadence_seconds` in `provider_schedule_policy`. Disabling a
-- lane is a single row edit there — no redeploy, no unschedule.
--
-- The backfill is safe to leave scheduled: once every week in the window is
-- present it makes no provider call and reports `remaining: 0`.
--
-- Vault + net.http_post pattern, identical to 20260914231629_market_asset_logo_verify_cron.
-- Cron auth is the operational x-cron-secret. Safe to apply anytime; idempotent.
--
-- Rollback (stop every lane, keep the data):
--   SELECT cron.unschedule('intel-capture-hourly');
--   SELECT cron.unschedule('intel-capture-liquidations-5m');
--   SELECT cron.unschedule('intel-capture-rank-daily');
--   SELECT cron.unschedule('intel-capture-rank-backfill');
--   SELECT cron.unschedule('intel-capture-airdrops-daily');
-- ============================================================

-- ── Hourly batch: regime + index constituents + RWA universe + attention ──
SELECT cron.unschedule('intel-capture-hourly') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-capture-hourly');
SELECT cron.schedule('intel-capture-hourly', '7 * * * *', $$
  SELECT net.http_post(
    url     := concat((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL'), '/functions/v1/intel-capture'),
    headers := jsonb_build_object('Content-Type','application/json','Authorization', concat('Bearer ', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')), 'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')),
    body    := jsonb_build_object('op','all_hourly'), timeout_milliseconds := 110000);
$$);

-- ── Liquidations every 5 minutes (one credit covers up to 250 assets) ──
SELECT cron.unschedule('intel-capture-liquidations-5m') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-capture-liquidations-5m');
SELECT cron.schedule('intel-capture-liquidations-5m', '*/5 * * * *', $$
  SELECT net.http_post(
    url     := concat((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL'), '/functions/v1/intel-capture'),
    headers := jsonb_build_object('Content-Type','application/json','Authorization', concat('Bearer ', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')), 'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')),
    body    := jsonb_build_object('op','liquidations'), timeout_milliseconds := 60000);
$$);

-- ── Daily rank history from the catalogue already in hand (no provider call) ──
SELECT cron.unschedule('intel-capture-rank-daily') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-capture-rank-daily');
SELECT cron.schedule('intel-capture-rank-daily', '20 0 * * *', $$
  SELECT net.http_post(
    url     := concat((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL'), '/functions/v1/intel-capture'),
    headers := jsonb_build_object('Content-Type','application/json','Authorization', concat('Bearer ', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')), 'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')),
    body    := jsonb_build_object('op','rank_daily'), timeout_milliseconds := 90000);
$$);

-- ── Weekly rank-history backfill: up to 8 missing Mondays a night, 52 weeks deep ──
SELECT cron.unschedule('intel-capture-rank-backfill') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-capture-rank-backfill');
SELECT cron.schedule('intel-capture-rank-backfill', '40 0 * * *', $$
  SELECT net.http_post(
    url     := concat((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL'), '/functions/v1/intel-capture'),
    headers := jsonb_build_object('Content-Type','application/json','Authorization', concat('Bearer ', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')), 'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')),
    body    := jsonb_build_object('op','rank_backfill','weeks',52,'limit',250,'maxWeeksPerRun',8), timeout_milliseconds := 110000);
$$);

-- ── Airdrops once a day (Builder and above; skipped with a reason below it) ──
SELECT cron.unschedule('intel-capture-airdrops-daily') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-capture-airdrops-daily');
SELECT cron.schedule('intel-capture-airdrops-daily', '30 5 * * *', $$
  SELECT net.http_post(
    url     := concat((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL'), '/functions/v1/intel-capture'),
    headers := jsonb_build_object('Content-Type','application/json','Authorization', concat('Bearer ', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')), 'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')),
    body    := jsonb_build_object('op','airdrops'), timeout_milliseconds := 60000);
$$);
