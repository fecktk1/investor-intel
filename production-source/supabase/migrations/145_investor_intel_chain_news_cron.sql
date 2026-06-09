-- ============================================================
-- 145: Investor Intel — per-chain Gemini news discovery cron
-- ============================================================
-- Every 6 hours, surface fresh articles for each launch chain via Gemini +
-- Google Search grounding into the shared corpus (zero user setup). Staggered
-- at :30 to avoid colliding with the curated crawl (migration 144). Vault
-- pattern from migration 075.
-- ============================================================

SELECT cron.unschedule('intel-chain-news-6h')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-chain-news-6h');

SELECT cron.schedule(
  'intel-chain-news-6h',
  '30 */6 * * *',
  $$
  SELECT net.http_post(
    url     := concat((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL'), '/functions/v1/intel-chain-news-cron'),
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', concat('Bearer ', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')),
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')
    ),
    body    := jsonb_build_object()
  );
  $$
);
