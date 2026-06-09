-- ============================================================
-- 140: Investor Intel — pg_cron schedules
-- ============================================================
-- Alert evaluation every 15 minutes (vault pattern from migration 075).
-- News auto-fetch + scheduled briefs are intentionally on-demand for launch
-- (service-role fan-out variants are a documented follow-on in LAUNCH.md).
-- ============================================================

SELECT cron.unschedule('intel-alerts-eval-15min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-alerts-eval-15min');

SELECT cron.schedule(
  'intel-alerts-eval-15min',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url     := concat((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL'), '/functions/v1/intel-alerts-eval'),
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', concat('Bearer ', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')),
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')
    ),
    body    := jsonb_build_object()
  );
  $$
);
