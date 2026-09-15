-- ============================================================
-- Investor Intel — CoinMarketCap category capture (CMC plan proposals 22, 27, 29)
-- ============================================================
-- Two new capture tables behind the `categories` and `category_members` lanes of the `intel-capture` Edge Function:
--   * intel_category_snapshots — the whole CoinMarketCap category board, one row per category per hour.
--   * intel_category_members   — the constituents of the largest categories, one row per asset per category per day.
-- The airdrop and network-stat reads of the same release use tables that already exist
-- (20260914232100_intel_capture_tables): nothing here re-creates them.
--
-- Both tables are service-role only, exactly like every other capture table: reads go through Edge Functions, never
-- through PostgREST as anon or authenticated, so RLS is enabled with no policy and the grants Supabase hands new public
-- tables are revoked.
--
-- Numeric columns reject NaN and +/-Infinity through `1e30 >= ALL (ARRAY[abs(...)])`: NaN and Infinity both compare
-- greater than 1e30, an all-NULL array yields NULL and coalesce lets it pass.
--
-- Retention (added to app_private.intel_capture_retention below, which stays pg_cron only):
--   intel_category_snapshots  90 days of hourly rows   — the widest category read is 30 days.
--   intel_category_members   400 days of daily rows    — a year of membership drift plus a leap of headroom.
--
-- Credits per day at the seeded cadence (upper bound; a fresh shared cache costs 0):
--   categories        24 runs x (1 + ceil(250/200)) = 72
--   category_members   1 run  x 40 categories x 1    = 40
--   network_stats      0 below Growth (the lane is skipped with `plan_below_growth`)
--
-- Rollback (stop both lanes, keep the data):
--   SELECT cron.unschedule('intel-capture-categories-hourly');
--   SELECT cron.unschedule('intel-capture-category-members-daily');
-- Rollback (drop the data too):
--   DROP TABLE public.intel_category_members;
--   DROP TABLE public.intel_category_snapshots;
--   (the retention function then needs its two clauses removed, or it errors on its next run)
-- ============================================================

-- 1. The category board, hourly. One row per provider per category per capture.
CREATE TABLE public.intel_category_snapshots (
  provider text NOT NULL DEFAULT 'coinmarketcap',
  category_id text NOT NULL,
  captured_at timestamptz NOT NULL,
  name text,
  title text,
  num_tokens integer CHECK (num_tokens IS NULL OR num_tokens >= 0),
  avg_price_change numeric,
  market_cap numeric,
  market_cap_change numeric,
  volume numeric,
  volume_change numeric,
  observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, category_id, captured_at),
  CONSTRAINT intel_category_snapshots_finite CHECK (coalesce(1e30 >= ALL (ARRAY[
    abs(avg_price_change), abs(market_cap), abs(market_cap_change), abs(volume), abs(volume_change)]), true))
);
CREATE INDEX intel_category_snapshots_captured_idx ON public.intel_category_snapshots (captured_at DESC);
-- The membership lane and the category read both ask for "the largest categories of the newest capture".
CREATE INDEX intel_category_snapshots_size_idx ON public.intel_category_snapshots (captured_at DESC, market_cap DESC NULLS LAST);
CREATE INDEX intel_category_snapshots_category_idx ON public.intel_category_snapshots (category_id, captured_at DESC);
ALTER TABLE public.intel_category_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_category_snapshots FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_category_snapshots TO service_role;

-- 2. Category membership, daily. One row per provider asset per category per UTC day.
CREATE TABLE public.intel_category_members (
  provider text NOT NULL DEFAULT 'coinmarketcap',
  category_id text NOT NULL,
  snapshot_date date NOT NULL,
  provider_id text NOT NULL,
  symbol text,
  cmc_rank integer CHECK (cmc_rank IS NULL OR cmc_rank > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, category_id, snapshot_date, provider_id)
);
CREATE INDEX intel_category_members_date_idx ON public.intel_category_members (snapshot_date DESC);
CREATE INDEX intel_category_members_asset_idx ON public.intel_category_members (provider_id, snapshot_date DESC);
ALTER TABLE public.intel_category_members ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_category_members FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_category_members TO service_role;

-- 3. Cadence policy for the two new lanes. `network_stats` already has its row and keeps it (min_plan growth is set by
-- the capture job itself, which skips below Growth with a recorded reason). A later edit to a row wins, so re-running
-- this migration never resets one.
INSERT INTO public.provider_schedule_policy (provider, feature, cadence_seconds, enabled, min_plan, reason) VALUES
  ('coinmarketcap', 'categories', 3600, true, 'basic', NULL),
  ('coinmarketcap', 'category_members', 86400, true, 'basic', NULL)
ON CONFLICT (provider, feature) DO NOTHING;

-- 4. Retention. Replaces app_private.intel_capture_retention with the same body plus the two new tables, so a single
-- nightly job still reports one count per capture table. Deleting a year of snapshots takes longer than a PostgREST RPC
-- is allowed to run, so this stays pg_cron only and is never exposed to an Edge Function.
CREATE OR REPLACE FUNCTION app_private.intel_capture_retention(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  removed jsonb := '{}'::jsonb;
  n integer;
BEGIN
  DELETE FROM public.intel_regime_snapshots WHERE captured_at < p_now - interval '400 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  removed := removed || jsonb_build_object('intel_regime_snapshots', n);

  DELETE FROM public.intel_rank_history WHERE snapshot_date < (p_now - interval '3 years')::date;
  GET DIAGNOSTICS n = ROW_COUNT;
  removed := removed || jsonb_build_object('intel_rank_history', n);

  DELETE FROM public.intel_rwa_universe_snapshots WHERE captured_at < p_now - interval '400 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  removed := removed || jsonb_build_object('intel_rwa_universe_snapshots', n);

  DELETE FROM public.intel_index_constituent_snapshots WHERE captured_at < p_now - interval '400 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  removed := removed || jsonb_build_object('intel_index_constituent_snapshots', n);

  n := app_private.intel_thin_liquidation_snapshots(p_now);
  removed := removed || jsonb_build_object('intel_liquidation_snapshots', n);

  DELETE FROM public.intel_exchange_reserve_snapshots WHERE snapshot_date < (p_now - interval '400 days')::date;
  GET DIAGNOSTICS n = ROW_COUNT;
  removed := removed || jsonb_build_object('intel_exchange_reserve_snapshots', n);

  DELETE FROM public.intel_venue_share_snapshots WHERE snapshot_date < (p_now - interval '3 years')::date;
  GET DIAGNOSTICS n = ROW_COUNT;
  removed := removed || jsonb_build_object('intel_venue_share_snapshots', n);

  DELETE FROM public.intel_attention_snapshots WHERE captured_at < p_now - interval '90 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  removed := removed || jsonb_build_object('intel_attention_snapshots', n);

  DELETE FROM public.intel_network_stats_snapshots WHERE captured_at < p_now - interval '400 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  removed := removed || jsonb_build_object('intel_network_stats_snapshots', n);

  -- Hourly category rows. The widest category read is 30 days; 90 keeps a quarter of context for a drift review.
  DELETE FROM public.intel_category_snapshots WHERE captured_at < p_now - interval '90 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  removed := removed || jsonb_build_object('intel_category_snapshots', n);

  -- Daily membership rows, on the same 400-day horizon as the other daily captures.
  DELETE FROM public.intel_category_members WHERE snapshot_date < (p_now - interval '400 days')::date;
  GET DIAGNOSTICS n = ROW_COUNT;
  removed := removed || jsonb_build_object('intel_category_members', n);

  DELETE FROM public.market_asset_demand_daily WHERE day < (p_now - interval '400 days')::date;
  GET DIAGNOSTICS n = ROW_COUNT;
  removed := removed || jsonb_build_object('market_asset_demand_daily', n);

  RETURN removed;
END $$;
REVOKE ALL ON FUNCTION app_private.intel_capture_retention(timestamptz) FROM PUBLIC, anon, authenticated;

-- 5. Schedules. Vault + net.http_post pattern, identical to 20260915010343_intel_capture_cron. Cron auth is the
-- operational x-cron-secret. Both jobs are idempotent: the rows are keyed on their time bucket and upserted, and each
-- job additionally skips when the newest row is younger than the feature's cadence_seconds in provider_schedule_policy.
-- They run off the hourly batch's minute so a category run never competes with it for the same wall-clock budget.

-- ── Category board, hourly (1 call, 3 credits) ──
SELECT cron.unschedule('intel-capture-categories-hourly') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-capture-categories-hourly');
SELECT cron.schedule('intel-capture-categories-hourly', '17 * * * *', $$
  SELECT net.http_post(
    url     := concat((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL'), '/functions/v1/intel-capture'),
    headers := jsonb_build_object('Content-Type','application/json','Authorization', concat('Bearer ', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')), 'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')),
    body    := jsonb_build_object('op','categories'), timeout_milliseconds := 60000);
$$);

-- ── Category membership, daily (up to 40 calls, 40 credits) ──
SELECT cron.unschedule('intel-capture-category-members-daily') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-capture-category-members-daily');
SELECT cron.schedule('intel-capture-category-members-daily', '35 1 * * *', $$
  SELECT net.http_post(
    url     := concat((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL'), '/functions/v1/intel-capture'),
    headers := jsonb_build_object('Content-Type','application/json','Authorization', concat('Bearer ', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')), 'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')),
    body    := jsonb_build_object('op','category_members'), timeout_milliseconds := 110000);
$$);
