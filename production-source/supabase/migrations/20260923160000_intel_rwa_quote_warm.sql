-- ============================================================
-- Investor Intel: the RWA judge-path warm lane (op `rwa_quote_warm` of intel-capture)
-- ============================================================
-- WHY. The public tokenised-asset lookup (intel-rwa-lookup) and the /intel/rwa workspace, for members and for
-- /intel/demo visitors, read a handful of SHARED cache entries far more than any other: the first page of the asset
-- list and the latest quote of the assets a visitor is steered to (the three lookup examples NVDA, SGOV and GOLD, the
-- rows of that first page, and the wrapper board). Left to readers, those entries sat past their one-hour window
-- until a reader happened to refresh them: blind judges on 2026-09-23 saw GOLD three hours old. The lane keeps
-- exactly those entries inside their window, for everybody, without a single per-visitor call.
--
-- ── WHAT THIS MIGRATION CREATES ──────────────────────────────────────────────────────────────────────────────────
--   public.intel_rwa_quote_warm_runs      the lane's run log: which batched entry it keeps (batch_ids), what each run
--                                         found and spent, the refusal it stopped on, and when the next run is due.
--                                         intel-rwa-lookup reads the newest finished row to find the batched entry
--                                         and to honour a recorded plan refusal. Service role only; the lane keeps
--                                         14 days of it.
--   public.intel_rwa_quote_warm_due()     true when the newest row's next_due_at has come and the policy row is on.
--   provider_schedule_policy row           coinmarketcap / rwa_quote_warm, enabled, max_credits 2 (per run).
--   cron job intel-capture-rwa-quote-warm  every minute, but it POSTs to intel-capture ONLY when the function above
--                                         says a run is due, so the Edge Function runs about once an hour.
--
-- ── WHAT ONE RUN COSTS ───────────────────────────────────────────────────────────────────────────────────────────
--   at most 2 calls:  /v5/real-world-assets/assets/list?start=1&limit=25            ceil(25/250)  = 1 credit
--                     /v5/real-world-assets/quotes/latest?rwa_id=<up to 100 ids>     ceil(100/250) = 1 credit
--   each only when its entry is past its one-hour window; cmc_request_reserve refuses to refill an entry still inside
--   it ('cache_ready'), so a warmed entry is refilled once an hour plus the tick's minute: about 24 runs and
--   47 CREDITS A DAY. Every credit is claimed first from the SAME daily free RWA budget the lookup itself uses
--   (intel_free_rwa_read_claim, 200 a day in cmc_free_rwa_policy), so the free path still spends at most 200 a day.
--
-- ── WHEN THE PLAN REFUSES ────────────────────────────────────────────────────────────────────────────────────────
--   A 402/403 plan refusal, a key problem or a spent monthly quota stops the run at that call and sets next_due_at
--   six hours out (the transport holds an entitlement refusal for the same six hours). intel-rwa-lookup reads that
--   row and makes no live read of its own while the refusal stands; readers keep the newest good copy with its age.
--   A spent free budget waits for the next UTC day; a transient failure retries in five minutes.
--
-- IDEMPOTENT. IF NOT EXISTS, CREATE OR REPLACE, ON CONFLICT DO NOTHING for the policy row, and the cron job
-- unscheduled by name before it is scheduled.
--
-- ROLLBACK
--   SELECT cron.unschedule('intel-capture-rwa-quote-warm');
--   UPDATE public.provider_schedule_policy SET enabled = false WHERE provider = 'coinmarketcap' AND feature = 'rwa_quote_warm';
--   -- and to remove it entirely (intel-rwa-lookup reads an absent table as "no warm state"):
--   DELETE FROM public.provider_schedule_policy WHERE provider = 'coinmarketcap' AND feature = 'rwa_quote_warm';
--   DROP FUNCTION public.intel_rwa_quote_warm_due();
--   DROP TABLE public.intel_rwa_quote_warm_runs;

-- SECTION 1: the run log

CREATE TABLE IF NOT EXISTS public.intel_rwa_quote_warm_runs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ran_at       timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  state        text NOT NULL CHECK (state IN ('running', 'done')),
  -- The batched quotes entry this lane keeps warm, as the canonical comma list the transport keys it by.
  batch_ids    text CHECK (batch_ids IS NULL OR batch_ids ~ '^[1-9][0-9]{0,11}(,[1-9][0-9]{0,11}){0,99}$'),
  batch_size   integer NOT NULL DEFAULT 0 CHECK (batch_size BETWEEN 0 AND 100),
  entries      jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(entries) = 'array'),
  calls        integer NOT NULL DEFAULT 0 CHECK (calls BETWEEN 0 AND 10),
  credits      numeric NOT NULL DEFAULT 0 CHECK (credits >= 0 AND credits <= 100),
  claimed      integer NOT NULL DEFAULT 0 CHECK (claimed BETWEEN 0 AND 10),
  stop_reason  text CHECK (stop_reason IS NULL OR length(stop_reason) <= 80),
  next_due_at  timestamptz NOT NULL,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  CONSTRAINT intel_rwa_quote_warm_runs_entries_size CHECK (pg_column_size(entries) <= 16384),
  CONSTRAINT intel_rwa_quote_warm_runs_detail_size CHECK (pg_column_size(detail) <= 4096)
);
CREATE INDEX IF NOT EXISTS intel_rwa_quote_warm_runs_ran_at_idx ON public.intel_rwa_quote_warm_runs (ran_at DESC);

ALTER TABLE public.intel_rwa_quote_warm_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.intel_rwa_quote_warm_runs FROM PUBLIC;
REVOKE ALL ON public.intel_rwa_quote_warm_runs FROM anon;
REVOKE ALL ON public.intel_rwa_quote_warm_runs FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.intel_rwa_quote_warm_runs TO service_role;

COMMENT ON TABLE public.intel_rwa_quote_warm_runs IS
  'intel-capture op rwa_quote_warm: one row per run. batch_ids names the one batched rwaQuotes shared-cache entry the lane keeps inside its window; intel-rwa-lookup reads the newest done row for it and for a recorded plan refusal (stop_reason + next_due_at). Service role only; 14 days kept by the lane.';

-- SECTION 2: is a run due?

CREATE OR REPLACE FUNCTION public.intel_rwa_quote_warm_due()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT EXISTS (
           SELECT 1 FROM public.provider_schedule_policy
            WHERE provider = 'coinmarketcap' AND feature = 'rwa_quote_warm' AND enabled IS NOT FALSE)
     AND COALESCE((SELECT r.next_due_at <= now() FROM public.intel_rwa_quote_warm_runs r ORDER BY r.ran_at DESC LIMIT 1), true)
$$;

REVOKE ALL ON FUNCTION public.intel_rwa_quote_warm_due() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.intel_rwa_quote_warm_due() FROM anon;
REVOKE ALL ON FUNCTION public.intel_rwa_quote_warm_due() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.intel_rwa_quote_warm_due() TO service_role;

COMMENT ON FUNCTION public.intel_rwa_quote_warm_due() IS
  'True when the rwa_quote_warm policy row is enabled and the newest run''s next_due_at has come (or no run exists). The minute cron tick POSTs to intel-capture only then. Service role (and the cron owner) only.';

-- SECTION 3: the lane's switch

INSERT INTO public.provider_schedule_policy (provider, feature, cadence_seconds, enabled, min_plan, max_credits, reason) VALUES
  ('coinmarketcap', 'rwa_quote_warm', 3600, true, NULL, 2,
   'Judge-path warm lane: keeps the /intel/rwa first list page and ONE batched quotes read (lookup examples, that page, the wrapper board; at most 100 ids) inside their one-hour window. At most 2 credits a run, about 47 a day, each claimed first from the daily free RWA budget (cmc_free_rwa_policy). Stops and backs off six hours on a plan refusal.')
ON CONFLICT (provider, feature) DO NOTHING;

-- SECTION 4: schedule

-- Every minute, but the POST happens only when intel_rwa_quote_warm_due() is true, which is about once an hour (when
-- a warmed entry reaches the end of its window) or five minutes after a failed run. Authenticates from vault exactly
-- like every other intel-capture job.
SELECT cron.unschedule('intel-capture-rwa-quote-warm') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-capture-rwa-quote-warm');
SELECT cron.schedule('intel-capture-rwa-quote-warm', '* * * * *', $$
  SELECT net.http_post(
    url     := concat((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL'), '/functions/v1/intel-capture'),
    headers := jsonb_build_object('Content-Type','application/json','Authorization', concat('Bearer ', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')), 'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')),
    body    := jsonb_build_object('op','rwa_quote_warm'), timeout_milliseconds := 110000)
  WHERE public.intel_rwa_quote_warm_due();
$$);
