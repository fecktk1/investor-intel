-- ============================================================
-- 142: Investor Intel — provider-coverage refresh cron
-- ============================================================
-- Re-probe provider coverage weekly so chain_capabilities stays current
-- (vault pattern from migration 075). Can also be run on demand from the
-- super-admin console ("Run coverage report").
-- ============================================================

SELECT cron.unschedule('intel-provider-coverage-weekly')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-provider-coverage-weekly');

SELECT cron.schedule(
  'intel-provider-coverage-weekly',
  '0 6 * * 0',
  $$
  SELECT net.http_post(
    url     := concat((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL'), '/functions/v1/intel-provider-coverage'),
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', concat('Bearer ', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')),
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')
    ),
    body    := jsonb_build_object()
  );
  $$
);
