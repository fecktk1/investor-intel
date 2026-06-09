-- ============================================================
-- 173: Investor Intel — daily portfolio snapshot cron
-- ============================================================
-- Once daily (04:30 UTC), writes ONE value snapshot per portfolio for the
-- performance chart. Calls portfolio-sync in snapshot mode. Vault + net.http_post
-- + x-cron-secret, same as 170_exchange_market_cron.
--
-- COST POSTURE (rev 4): the snapshot computes value from CURRENT STORED HOLDINGS
-- + latest exchange prices (cache-only) — it does NOT blindly re-fetch every
-- wallet. portfolio-sync only refreshes a wallet source whose last_holdings_sync_at
-- is older than PORTFOLIO_WALLET_SOURCE_STALE_AFTER_HOURS, capped by
-- PORTFOLIO_DAILY_WALLET_REFRESH_MAX_SOURCES + PORTFOLIO_BIRDEYE_MAX_CALLS_PER_RUN.
-- No AI runs in the cron (portfolio intelligence stays on-demand).
--
-- To DISABLE: cron.unschedule('investor-portfolio-snapshot-daily').
-- ============================================================

SELECT cron.unschedule('investor-portfolio-snapshot-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'investor-portfolio-snapshot-daily');

SELECT cron.schedule(
  'investor-portfolio-snapshot-daily',
  '30 4 * * *',
  $$
  SELECT net.http_post(
    url     := concat((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL'), '/functions/v1/portfolio-sync'),
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', concat('Bearer ', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')),
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')
    ),
    body    := jsonb_build_object('mode', 'snapshot', 'all', true),
    timeout_milliseconds := 120000
  );
  $$
);
