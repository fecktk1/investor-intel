-- ============================================================
-- 144: Investor Intel — global curated news crawl cron
-- ============================================================
-- Crawl the shared curated corpus every 2 hours (vault pattern, migration 075).
-- Also runnable on demand from the super-admin console.
-- ============================================================

SELECT cron.unschedule('intel-global-news-2h')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-global-news-2h');

SELECT cron.schedule(
  'intel-global-news-2h',
  '0 */2 * * *',
  $$
  SELECT net.http_post(
    url     := concat((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL'), '/functions/v1/intel-global-news-cron'),
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', concat('Bearer ', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')),
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')
    ),
    body    := jsonb_build_object()
  );
  $$
);
