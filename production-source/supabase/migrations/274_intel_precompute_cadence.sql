-- Investor Intel cost dial-back — stretch precompute cron cadence for the current low userbase.
-- Pairs with the model dial-back (gpt-5.5 → gpt-5.4 family) and the story-cards activity gate
-- (intel-story-cards skips the multi-model pass when no recent Intel activity).
--
-- Uses cron.alter_job so each job's existing COMMAND (the net.http_post body with vault secrets)
-- is preserved — only the schedule changes. Job NAMES keep their original cadence suffix (cosmetic).
-- New cadence:
--   intel-story-cards-2h      → every 8h   (was 2h)   [also: per-run limit 6→3 + activity gate]
--   intel-global-news-2h      → every 4h   (was 2h)
--   intel-org-news-harvest-3h → every 6h   (was 3h)
--   intel-chain-news-6h       → every 12h  (was 6h)
-- Revert by re-running the original schedules from migrations 144/145/148/162.

DO $$
DECLARE jid bigint;
BEGIN
  SELECT jobid INTO jid FROM cron.job WHERE jobname = 'intel-story-cards-2h';
  IF jid IS NOT NULL THEN PERFORM cron.alter_job(jid, schedule => '50 */8 * * *'); END IF;

  SELECT jobid INTO jid FROM cron.job WHERE jobname = 'intel-global-news-2h';
  IF jid IS NOT NULL THEN PERFORM cron.alter_job(jid, schedule => '0 */4 * * *'); END IF;

  SELECT jobid INTO jid FROM cron.job WHERE jobname = 'intel-org-news-harvest-3h';
  IF jid IS NOT NULL THEN PERFORM cron.alter_job(jid, schedule => '15 */6 * * *'); END IF;

  SELECT jobid INTO jid FROM cron.job WHERE jobname = 'intel-chain-news-6h';
  IF jid IS NOT NULL THEN PERFORM cron.alter_job(jid, schedule => '30 */12 * * *'); END IF;
END $$;
