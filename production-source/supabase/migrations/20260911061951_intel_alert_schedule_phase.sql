-- Quote ingestion starts every five minutes. Evaluate one minute later so the
-- alert read does not race the transaction publishing those shared observations.
-- Keep the existing fifteen-minute cadence, HTTP receipt and delivery bridge.
DO $migration$
DECLARE job record;
BEGIN
 SELECT jobid,schedule,command INTO STRICT job FROM cron.job WHERE jobname='intel-alerts-eval-15min';
 IF job.schedule NOT IN ('*/15 * * * *','1,16,31,46 * * * *') OR job.command NOT LIKE '%intel_schedule_requests%' THEN
  RAISE EXCEPTION 'unexpected_intel_alert_schedule_phase';
 END IF;
 PERFORM cron.alter_job(job.jobid,schedule:='1,16,31,46 * * * *');
END $migration$;
