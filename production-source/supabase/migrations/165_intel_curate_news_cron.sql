-- ============================================================
-- 165: Investor Intel — news curation cron
-- ============================================================
-- Every 45 min: dedupe + prefilter the corpus, then Gemini + Grok batch-score
-- the candidate clusters and write curated Notable News. 2 batched AI calls per
-- run (not per item), shared platform-wide, cached by cluster.
-- ============================================================

SELECT cron.unschedule('intel-curate-news-45m')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-curate-news-45m');

SELECT cron.schedule(
  'intel-curate-news-45m',
  '25,55 * * * *',
  $$
  SELECT net.http_post(
    url     := concat((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL'), '/functions/v1/intel-curate-news'),
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', concat('Bearer ', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')),
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')
    ),
    body    := jsonb_build_object('limit', 30),
    timeout_milliseconds := 120000
  );
  $$
);
