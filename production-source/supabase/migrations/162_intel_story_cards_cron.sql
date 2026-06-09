-- ============================================================
-- 162: Investor Intel — shared story-card analysis cron
-- ============================================================
-- Every 2 hours (at :50, after the news crawls), generate reusable multi-model
-- analysis for the top global news stories into intel_shared_artifacts. Read by
-- Market Pulse for every user with no per-load AI. Capped per run inside the fn.
-- ============================================================

SELECT cron.unschedule('intel-story-cards-2h')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-story-cards-2h');

SELECT cron.schedule(
  'intel-story-cards-2h',
  '50 */2 * * *',
  $$
  SELECT net.http_post(
    url     := concat((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL'), '/functions/v1/intel-story-cards'),
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', concat('Bearer ', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')),
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')
    ),
    body    := jsonb_build_object('limit', 6),
    timeout_milliseconds := 60000
  );
  $$
);
