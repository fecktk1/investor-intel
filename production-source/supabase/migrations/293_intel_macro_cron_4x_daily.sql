-- ============================================================
-- 293: Investor Intel — macro refresh 4x/day (was daily 06:00 UTC)
-- ============================================================
-- Supersedes the single daily intel-macro-cron schedule from migration 148.
-- intel-macro-cron has no per-day guard: each run does the shared Gemini-grounded
-- fetch and upserts intel_macro_calendar + intel_macro_indicators, so extra runs
-- genuinely refresh the global macro store (shared once, cost is flat per run).
--
-- Target cadence: 08:00, 10:00, 15:00, 22:00 America/Chicago (CST, UTC-6)
--   => 14:00, 16:00, 21:00, 04:00 UTC  =>  cron '0 4,14,16,21 * * *'.
--
-- DST CAVEAT: pg_cron runs in UTC and does NOT observe daylight saving. The above
-- is pinned to CST (UTC-6). During CDT (mid-Mar..early-Nov) these fire one hour
-- LATER in Central local time (09:00/11:00/16:00/23:00). To pin to CDT (UTC-5)
-- instead, use '0 3,13,15,20 * * *'.
-- ============================================================

-- Retire the old once-daily job (migration 148) and any prior 4x name (idempotent).
SELECT cron.unschedule('intel-macro-cron-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-macro-cron-daily');
SELECT cron.unschedule('intel-macro-cron-4x-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-macro-cron-4x-daily');

SELECT cron.schedule(
  'intel-macro-cron-4x-daily',
  '0 4,14,16,21 * * *',
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
