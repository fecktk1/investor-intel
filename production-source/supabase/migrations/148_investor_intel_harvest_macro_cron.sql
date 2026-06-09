-- ============================================================
-- 148: Investor Intel — org-news harvest + macro refresh crons
-- ============================================================
-- intel-org-news-harvest: every 3h at :15, sweep the org/content side's
--   rss_items (already fetched every 5 min) for chain-relevant + macro news,
--   dedup, ground-verify a bounded batch, and merge into the shared
--   intel_global_news corpus — reusing data orgs already pull (no new source
--   API calls for retail users).
-- intel-macro-cron: daily at 06:00 UTC, one shared Gemini-grounded fetch of the
--   upcoming economic calendar + current macro indicators into the global
--   intel_macro_* tables (shared by every workspace).
-- Vault pattern from migration 075; staggered away from 144/145/146.
-- ============================================================

SELECT cron.unschedule('intel-org-news-harvest-3h')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-org-news-harvest-3h');
SELECT cron.schedule(
  'intel-org-news-harvest-3h',
  '15 */3 * * *',
  $$
  SELECT net.http_post(
    url     := concat((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL'), '/functions/v1/intel-org-news-harvest'),
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', concat('Bearer ', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')),
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')
    ),
    body    := jsonb_build_object()
  );
  $$
);

SELECT cron.unschedule('intel-macro-cron-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-macro-cron-daily');
SELECT cron.schedule(
  'intel-macro-cron-daily',
  '0 6 * * *',
  $$
  SELECT net.http_post(
    url     := concat((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL'), '/functions/v1/intel-macro-cron'),
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', concat('Bearer ', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')),
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')
    ),
    body    := jsonb_build_object()
  );
  $$
);
