-- ============================================================
-- 159: Investor Intel — market regime cron
-- ============================================================
-- Recompute the shared global market regime every 3 hours (one classification
-- for the whole platform). Vault pattern; staggered at :40.
-- ============================================================

SELECT cron.unschedule('intel-regime-3h')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-regime-3h');

SELECT cron.schedule(
  'intel-regime-3h',
  '40 */3 * * *',
  $$
  SELECT net.http_post(
    url     := concat((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL'), '/functions/v1/intel-regime'),
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', concat('Bearer ', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')),
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')
    ),
    body    := jsonb_build_object(),
    timeout_milliseconds := 30000
  );
  $$
);
