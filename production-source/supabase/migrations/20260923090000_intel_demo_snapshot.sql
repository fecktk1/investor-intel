-- ============================================================
-- Investor Intel: public demo snapshot (bucket, run log, daily schedule)
-- ============================================================
-- A visitor with no account opens /intel/demo and browses the real Investor Intel pages. Every answer those pages
-- receive comes from a snapshot written once a day by the `intel-demo-snapshot` Edge Function; no request from a demo
-- visitor reaches a live function, table or RPC.
--
--   storage bucket `intel-demo`       PUBLIC READ. snapshots/<YYYY-MM-DD>/<key>.json plus latest.json (written last).
--                                     No client write policy: only the service role (the builder) writes here.
--   intel_demo_snapshot_runs          APPEND-ONLY run log. service_role may SELECT and INSERT only.
--   cron `intel-demo-snapshot-daily`  04:13 UTC, after the daily RWA lanes (03:11 map, 03:19 coverage, 03:29 profiles,
--                                     03:34 depth, 03:47 underlying registrants), with two resume ticks at 04:28 and
--                                     04:33 that continue from the stored cursor and do nothing once the day is done.
--
-- PRIVACY. What lands in the bucket is world-readable by design. The builder only stores responses computed from shared
-- capture tables and the shared provider response cache, scrubs every body (email / full_name / phone / avatar_url keys
-- dropped, email addresses redacted) and refuses any body that carries personal-table rows. It never signs in as, or
-- mints a token for, any user.
--
-- COST. The builder calls no provider. Capture views are database reads; the free RWA research reads run the shared
-- cache pass only (kind 'render', maxCalls 0, noDemand), so nothing is spent now and no refresh is bought for later.
--
-- SCHEDULE. One tick at 04:13 UTC (minute 13 of hour 4 is used by no other cron job; checked against every
-- cron.schedule in migrations on 2026-09-22). Edge Functions stop on CPU time as well as wall time, so one invocation
-- only plans, and each later one computes at most 30 entries and hands on to the next itself (EdgeRuntime.waitUntil,
-- at most 300 hops) with a cursor recorded in its run row. A tick after the day's latest.json was written returns at once.
--
-- IDEMPOTENT. ON CONFLICT for the bucket, IF NOT EXISTS for the table, DROP POLICY IF EXISTS before CREATE POLICY, and
-- the cron job unscheduled by name before it is scheduled. NOT APPLIED by this change. Validated offline with pglast.
--
-- ROLLBACK
--   SELECT cron.unschedule('intel-demo-snapshot-daily');
--   -- remove the public objects first (Storage API or dashboard), then:
--   DROP POLICY IF EXISTS "intel_demo_public_read" ON storage.objects;
--   DELETE FROM storage.buckets WHERE id = 'intel-demo';
--   DROP TABLE public.intel_demo_snapshot_runs;
-- ============================================================

-- SECTION 1: bucket

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('intel-demo', 'intel-demo', true, 5242880, ARRAY['application/json'])
ON CONFLICT (id) DO UPDATE SET public = true, file_size_limit = 5242880, allowed_mime_types = ARRAY['application/json'];

-- Read: anyone. A public bucket already serves objects without a token; the policy keeps the intent legible and lets
-- the Storage API list/download through the anon and authenticated roles.
DROP POLICY IF EXISTS "intel_demo_public_read" ON storage.objects;
CREATE POLICY "intel_demo_public_read" ON storage.objects FOR SELECT
  TO anon, authenticated
  USING (bucket_id = 'intel-demo');

-- Write: deliberately NO insert, update or delete policy for anon or authenticated. The service role bypasses RLS and
-- is the only writer.

-- SECTION 2: run log (append-only)

CREATE TABLE IF NOT EXISTS public.intel_demo_snapshot_runs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  snapshot_date date NOT NULL,
  started_at   timestamptz NOT NULL,
  finished_at  timestamptz NOT NULL DEFAULT now(),
  status       text NOT NULL CHECK (status IN ('complete', 'partial', 'failed')),
  run_trigger  text NOT NULL CHECK (run_trigger IN ('cron', 'super_admin')),
  entries_written integer NOT NULL DEFAULT 0 CHECK (entries_written >= 0),
  entries_skipped integer NOT NULL DEFAULT 0 CHECK (entries_skipped >= 0),
  entries_failed  integer NOT NULL DEFAULT 0 CHECK (entries_failed >= 0),
  bytes_written   bigint  NOT NULL DEFAULT 0 CHECK (bytes_written >= 0),
  resume_cursor integer CHECK (resume_cursor IS NULL OR resume_cursor >= 0),
  latest_written boolean NOT NULL DEFAULT false,
  duration_ms  integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS intel_demo_snapshot_runs_date_idx ON public.intel_demo_snapshot_runs (snapshot_date DESC, id DESC);

ALTER TABLE public.intel_demo_snapshot_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_demo_snapshot_runs FROM PUBLIC, anon, authenticated;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.intel_demo_snapshot_runs FROM service_role;
GRANT SELECT, INSERT ON TABLE public.intel_demo_snapshot_runs TO service_role;

COMMENT ON TABLE public.intel_demo_snapshot_runs IS
  'Append-only log of intel-demo-snapshot runs (one row per invocation). service_role SELECT/INSERT only.';

-- SECTION 3: schedule

SELECT cron.unschedule('intel-demo-snapshot-daily') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-demo-snapshot-daily');
SELECT cron.schedule('intel-demo-snapshot-daily', '13 4 * * *', $$
  SELECT net.http_post(
    url     := concat((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL'), '/functions/v1/intel-demo-snapshot'),
    headers := jsonb_build_object('Content-Type','application/json','Authorization', concat('Bearer ', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')), 'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')),
    body    := jsonb_build_object('op','build'), timeout_milliseconds := 150000);
$$);
