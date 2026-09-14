-- Reuse the existing job, credentials and command. One shared schedule for all users.
-- Four listing pages cost four credits per run, at most 34,560 per 30-day month.
-- The governed account and feature reservations remain the authority to spend.
DO $migration$
DECLARE v_job bigint;
BEGIN
 IF to_regclass('cron.job') IS NOT NULL THEN
  SELECT jobid INTO v_job FROM cron.job WHERE jobname='market-assets-refresh-broad';
  IF v_job IS NOT NULL THEN PERFORM cron.alter_job(v_job,schedule:='*/5 * * * *'); END IF;
 END IF;
END $migration$;
