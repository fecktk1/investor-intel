-- Keep the existing authenticated scheduler, while making HTTP completion
-- inspectable. pg_cron's succeeded status alone only means a request was queued.
CREATE TABLE public.intel_schedule_requests(
 request_id bigint PRIMARY KEY,job_name text NOT NULL CHECK(job_name='intel-alerts-eval-15min'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE INDEX intel_schedule_requests_time ON public.intel_schedule_requests(created_at);
ALTER TABLE public.intel_schedule_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.intel_schedule_requests FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,DELETE ON public.intel_schedule_requests TO service_role;
CREATE POLICY intel_schedule_requests_service ON public.intel_schedule_requests FOR ALL TO service_role USING(true) WITH CHECK(true);
DO $migration$
DECLARE job record;updated text;call text;
BEGIN
 SELECT jobid,command INTO STRICT job FROM cron.job WHERE jobname='intel-alerts-eval-15min';
 IF job.command NOT LIKE '%SELECT net.http_post(%' OR job.command NOT LIKE '%/functions/v1/intel-alerts-eval%' OR job.command LIKE '%timeout_milliseconds%' THEN
  RAISE EXCEPTION 'unexpected_intel_alert_schedule';
 END IF;
 call:=regexp_replace(job.command,'body\s*:=\s*jsonb_build_object\(\)','body := jsonb_build_object(), timeout_milliseconds := 30000');
 IF call=job.command THEN RAISE EXCEPTION 'unexpected_intel_alert_schedule_body';END IF;
 call:=regexp_replace(btrim(call),';\s*$','');
 updated:='DELETE FROM public.intel_schedule_requests WHERE created_at<clock_timestamp()-interval ''7 days''; WITH queued(request_id) AS ('||call||') INSERT INTO public.intel_schedule_requests(request_id,job_name) SELECT request_id,''intel-alerts-eval-15min'' FROM queued;';
 PERFORM cron.alter_job(job.jobid,command:=updated);
END $migration$;
