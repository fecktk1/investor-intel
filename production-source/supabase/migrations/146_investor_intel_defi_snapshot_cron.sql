-- ============================================================
-- 146: Investor Intel — DeFi vault snapshot cron (TVL/APY history)
-- ============================================================
-- Once daily, snapshot Kamino TVL/APY for every DeFi vault watched by an intel
-- workspace into kamino_vault_snapshots so the DeFi page can chart TVL/APY
-- history over time. Runs at 05:10 UTC to stagger away from the news crawls
-- (144 hourly/daily, 145 :30 every 6h). Vault pattern from migration 075.
-- ============================================================

SELECT cron.unschedule('intel-defi-snapshot-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-defi-snapshot-daily');

SELECT cron.schedule(
  'intel-defi-snapshot-daily',
  '10 5 * * *',
  $$
  SELECT net.http_post(
    url     := concat((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL'), '/functions/v1/intel-defi-snapshot'),
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', concat('Bearer ', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')),
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')
    ),
    body    := jsonb_build_object()
  );
  $$
);
