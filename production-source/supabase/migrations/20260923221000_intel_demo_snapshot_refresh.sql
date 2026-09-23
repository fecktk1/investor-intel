-- ============================================================
-- Investor Intel: public demo snapshot, afternoon and evening refresh builds
-- ============================================================
-- The demo snapshot was built once a day (`intel-demo-snapshot-daily`, 04:13 UTC), so by evening the demo banner said
-- the snapshot was more than nine hours old while the six-hourly RWA wrapper capture (`intel-capture-rwa-wrappers-6h`,
-- :47 of hours 2, 8, 14 and 20) had landed twice since. This job builds the snapshot again after the 14:47 and 20:47
-- captures.
--
--   cron `intel-demo-snapshot-refresh`   :19 of hours 15 and 21 UTC. 32 minutes after the wrapper capture (one
--                                        invocation, 110 s timeout) and 12 minutes after `intel-capture-hourly` at :07.
--                                        Minute 19 of hours 15 and 21 is used by no other cron job except the
--                                        every-minute ones (checked against every active cron.job on 2026-09-23).
--
-- WHAT A REFRESH DOES (intel-demo-snapshot, body {op:'build', refresh:true}). When the day's newest run finished it,
-- the tick starts a new build GENERATION of the same date. Because that date is already being served, the generation
-- computes every entry into staging/<date>/<generation>/ in the same bucket while the old copy keeps serving untouched,
-- then copies each staged entry over the served one (each an atomic overwrite), then writes latest.json with the new
-- build time (the banner's "snapshot built" time), then removes its staging files. Nothing is deleted from the served
-- day, and the new manifest keeps every key the old one named that is still present. A tick that finds the day's build
-- still handing on does nothing; one that finds it stalled resumes it. A day with no build yet is built as usual.
--
-- AUTHENTICATION. Exactly the daily job's: the vault's SUPABASE_URL, the service role bearer and the operational
-- `x-cron-secret`. COST. The builder calls no provider (see 20260923090000_intel_demo_snapshot.sql).
--
-- IDEMPOTENT. The job is unscheduled by name before it is scheduled. Validated offline with pglast.
--
-- ROLLBACK
--   SELECT cron.unschedule('intel-demo-snapshot-refresh');
-- ============================================================

SELECT cron.unschedule('intel-demo-snapshot-refresh') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-demo-snapshot-refresh');
SELECT cron.schedule('intel-demo-snapshot-refresh', '19 15,21 * * *', $$
  SELECT net.http_post(
    url     := concat((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL'), '/functions/v1/intel-demo-snapshot'),
    headers := jsonb_build_object('Content-Type','application/json','Authorization', concat('Bearer ', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')), 'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')),
    body    := jsonb_build_object('op','build','refresh',true), timeout_milliseconds := 150000);
$$);
