-- ============================================================
-- 275: Investor Intel - static provider-coverage cron refresh
-- ============================================================
-- Stage A only. The intel-provider-coverage function now computes only the
-- non-portfolio capability set from provider-presence registries and does not
-- make live provider calls. Portfolio capability rows remain owned by
-- portfolio-capability-probe.
-- ============================================================

SELECT cron.unschedule('intel-provider-coverage-weekly')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-provider-coverage-weekly');

SELECT cron.unschedule('intel-provider-coverage-static-weekly')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-provider-coverage-static-weekly');

SELECT cron.schedule(
  'intel-provider-coverage-static-weekly',
  '12 6 * * 0',
  $$
  SELECT net.http_post(
    url     := concat((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL'), '/functions/v1/intel-provider-coverage'),
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', concat('Bearer ', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')),
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')
    ),
    body    := jsonb_build_object('mode', 'static_provider_presence')
  );
  $$
);
