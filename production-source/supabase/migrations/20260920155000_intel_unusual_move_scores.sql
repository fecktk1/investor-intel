-- ============================================================
-- Investor Intel — "unusual for THIS asset"
-- ============================================================
-- A fixed threshold is not a finding. An 8% day is an ordinary Tuesday for a small alt and a major event for
-- Bitcoin, so a movers list built on one number for every asset says more about the number than about the market.
-- This migration adds the storage behind the `unusual_moves` op and the `unusual_moves` read view of the
-- `intel-capture` Edge Function, which scores each asset's newest COMPLETE UTC day against that SAME asset's own
-- trailing distribution:
--
--   intel_unusual_move_scores   one row per asset per scored UTC day: the day's signed close-to-close move, the
--                               asset's own median absolute daily move, the median absolute deviation, a robust
--                               z-score, an empirical percentile, the same treatment of log volume, and the
--                               market-relative residual with its beta and sample count. Service-role only, exactly
--                               like every other capture table: Intel members read it through
--                               `intel-capture` `{op:'read',view:'unusual_moves'}` and never through PostgREST.
--
-- ZERO PROVIDER CREDITS, AND THE POLICY ROW SAYS SO. The lane calls nothing. Its inputs are three tables we already
-- own: `market_asset_candles` (the stored daily archive, added by 20260915152118), `market_asset_candle_backfill`
-- (the archive's identity queue) and `market_assets` (the catalogue). The policy row is registered under provider
-- 'local', NOT 'coinmarketcap', for two reasons: a lane that cannot spend a credit must not be counted against the
-- CoinMarketCap budget, and `calibratePolicyRows` in the Edge Function stretches CoinMarketCap cadences when that
-- account's burn rate demands it — a free lane being slowed by someone else's credit burn would be a bug.
--
-- ONE ROW PER ASSET PER SCORED DAY, NOT PER HOUR. The scored day is the newest complete UTC day in the archive, so
-- it changes once a day; 24 hourly rows would be 24 copies of one answer. The lane still runs HOURLY and upserts on
-- (asset_key, subject_day), which buys three things a daily-only run would not: a late or failed candle append is
-- picked up within the hour rather than missing a day, the catalogue turnover behind the ranking is refreshed, and
-- `captured_at` records when the row was last recomputed. At about 100 archive assets that is ~100 rows a day and
-- ~3,000 rows at the 30-day horizon below, against the ~72,000 rows a 30-day hourly table would hold for the same
-- information.
--
-- RETENTION IS 30 DAYS, PATCHED into the LIVE definition of app_private.intel_capture_retention (the technique the
-- meme-graduation lane introduced in 20260915034403 and the candle archive reused in 20260915152118) rather than
-- restated. The live function carries blocks from every lane before this one; a restatement copied from any single
-- migration silently drops the blocks added after it, and a lost DELETE block means that lane's table grows without
-- bound. The patch reads the function as it is, refuses to run twice, and inserts one block before its single
-- `RETURN removed;`. If a LATER capture lane restates this function in full, it must carry the block below.
--
-- WHY 30 DAYS AND NOT FOREVER. Every figure in a row is DERIVED from the candle archive, which is never thinned and
-- never deleted, so any day can be recomputed exactly from stored inputs. The table is a cache of a calculation, not
-- a record of an observation, and a cache with an unbounded horizon is how the 10 GB observation table happened. A
-- month is long enough to answer "was yesterday unusual, and was last Tuesday" on the surface.
--
-- HONESTY RULES the schema enforces, not only the job:
--   * A ROW THAT IS NOT SCORED CARRIES A REASON. `scored = false` requires `reason IS NOT NULL`, and a scored row
--     may not carry one. A pegged asset, an asset under the liquidity floor and an asset with 12 of the 30 required
--     days are three different sentences the surface says in words, never a missing row a reader cannot ask about.
--   * A SCORED ROW HAS THE DAY'S MOVE AND ITS LEAD WINDOW. `scored = true` requires `move_pct`, `sample_days >=
--     required_days` and a `lead_window_days`; a score with no move is not a score.
--   * A PERCENTILE IS A PERCENTAGE. move_percentile and volume_percentile are constrained to 0..100, so a unit
--     mix-up (a 0..1 share written into a 0..100 column) fails the write instead of rendering as "larger than 0.97
--     of the last 100 days".
--   * `move_exceeded` CANNOT EXCEED `sample_days`. "Larger than 97 of the last 92 days" is the one sentence this
--     surface must never print.
--   * A BETA WITHOUT A SAMPLE COUNT IS A DECORATION. beta requires beta_n >= 2, which is the smallest fit an
--     ordinary least squares slope can be had from.
--   * Numeric columns reject NaN and +/-Infinity through `1e30 >= ALL (ARRAY[abs(...)])`: NaN and Infinity both
--     compare greater than 1e30, an all-NULL array yields NULL and coalesce lets it pass. This is the same guard the
--     candle archive uses, and it is what stops a MAD of zero turning into an Infinity in the robust z column.
--
-- Vault + net.http_post cron pattern, identical to 20260917210400_intel_sunpump_lane. Safe to apply anytime;
-- idempotent.
--
-- ROLLBACK
--   -- stop the lane, keep the data:
--   SELECT cron.unschedule('intel-capture-unusual-hourly');
--   -- disable it instead of unscheduling:
--   UPDATE public.provider_schedule_policy SET enabled = false WHERE provider = 'local' AND feature = 'unusual_moves';
--   -- drop the data too:
--   DROP TABLE public.intel_unusual_move_scores;
--   DELETE FROM public.provider_schedule_policy WHERE provider = 'local' AND feature = 'unusual_moves';
--   -- then remove the retention block from app_private.intel_capture_retention by hand (otherwise the nightly job
--   -- errors on its next run against the dropped table); the block is the one naming intel_unusual_move_scores.
-- ============================================================

SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- SECTION 1: the scores table

CREATE TABLE IF NOT EXISTS public.intel_unusual_move_scores (
  -- The canonical archive key the candle store uses ('bip122:native:BTC', 'eip155:1:native', 'cmc:<id>').
  asset_key text NOT NULL CHECK (asset_key ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{2,199}$'),
  -- The UTC day the scored close-to-close move CLOSED on. Not the run day: a run at 09:00 on the 20th scores the
  -- day that closed on the 19th, and the surface dates the column so a reader can see which day was measured.
  subject_day date NOT NULL,
  -- Catalogue identity, for the asset link, the logo and the evidence-standard subject key.
  cmc_id text CHECK (cmc_id IS NULL OR cmc_id ~ '^[1-9][0-9]{0,9}$'),
  symbol text CHECK (symbol IS NULL OR length(symbol) <= 50),
  name text CHECK (name IS NULL OR length(name) <= 200),
  -- When this row was last recomputed. Hour-bucketed by the lane, so a retried run overwrites rather than diverges.
  captured_at timestamptz NOT NULL,

  scored boolean NOT NULL DEFAULT false,
  -- Why the asset was not scored: 'insufficient_history', 'peg_excluded', 'wrapper_excluded',
  -- 'below_liquidity_floor', 'liquidity_unknown', 'no_subject_return'. Each is a sentence the surface says in words.
  reason text CHECK (reason IS NULL OR length(reason) <= 60),
  -- Trailing daily returns available, and the minimum the scorer requires. Reported whatever the outcome, so
  -- "insufficient history, 12 of 30 days" can be said rather than "no data".
  sample_days integer NOT NULL DEFAULT 0 CHECK (sample_days >= 0),
  required_days integer NOT NULL DEFAULT 30 CHECK (required_days >= 2),
  -- The asset the residual is measured against has no beta on itself.
  is_market_reference boolean NOT NULL DEFAULT false,

  -- The scored day itself.
  move_pct numeric,
  volume numeric CHECK (volume IS NULL OR volume >= 0),

  -- The lead window's figures, as columns so the ranking and any later alert read can order and filter without
  -- unpacking jsonb per row. The full set for every window rides along in `windows`.
  lead_window_days integer CHECK (lead_window_days IS NULL OR lead_window_days >= 2),
  move_percentile numeric CHECK (move_percentile IS NULL OR (move_percentile >= 0 AND move_percentile <= 100)),
  move_exceeded integer CHECK (move_exceeded IS NULL OR move_exceeded >= 0),
  -- The asset's typical day: the median of its trailing absolute daily moves, and that sample's MAD. An absolute
  -- median and an absolute deviation are both non-negative by construction.
  median_abs_pct numeric CHECK (median_abs_pct IS NULL OR median_abs_pct >= 0),
  mad_pct numeric CHECK (mad_pct IS NULL OR mad_pct >= 0),
  robust_z numeric,
  volume_percentile numeric CHECK (volume_percentile IS NULL OR (volume_percentile >= 0 AND volume_percentile <= 100)),
  volume_robust_z numeric,
  beta numeric,
  beta_n integer CHECK (beta_n IS NULL OR beta_n >= 0),
  residual_pct numeric,
  market_move_pct numeric,

  -- The catalogue reading behind the liquidity gate and the ranking tie-break, with its own clock.
  liquidity_usd numeric CHECK (liquidity_usd IS NULL OR liquidity_usd >= 0),
  market_cap numeric CHECK (market_cap IS NULL OR market_cap >= 0),
  market_cap_rank integer CHECK (market_cap_rank IS NULL OR market_cap_rank > 0),
  catalogue_as_of timestamptz,

  -- Every window's full readings, exactly as the pure scorer produced them, so an expanded row needs no second read
  -- and this table needs no column per window per metric.
  windows jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(windows) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (asset_key, subject_day),

  -- A row that is not scored says why; a scored row does not carry a refusal.
  CONSTRAINT intel_unusual_move_scores_reason CHECK (
    (scored = false AND reason IS NOT NULL) OR (scored = true AND reason IS NULL)),
  -- A score with no move, no lead window or less than its own stated minimum sample is not a score.
  CONSTRAINT intel_unusual_move_scores_scored CHECK (
    scored = false OR (move_pct IS NOT NULL AND lead_window_days IS NOT NULL AND sample_days >= required_days)),
  -- "Larger than 97 of the last 92 days" is the one sentence this surface must never print.
  CONSTRAINT intel_unusual_move_scores_exceeded CHECK (move_exceeded IS NULL OR move_exceeded <= sample_days),
  -- A slope needs two paired days.
  CONSTRAINT intel_unusual_move_scores_beta CHECK (beta IS NULL OR coalesce(beta_n, 0) >= 2),
  -- The market reference has no beta or residual against itself.
  CONSTRAINT intel_unusual_move_scores_reference CHECK (
    is_market_reference = false OR (beta IS NULL AND residual_pct IS NULL)),
  CONSTRAINT intel_unusual_move_scores_finite CHECK (coalesce(1e30 >= ALL (ARRAY[
    abs(move_pct), abs(volume), abs(move_percentile), abs(median_abs_pct), abs(mad_pct), abs(robust_z),
    abs(volume_percentile), abs(volume_robust_z), abs(beta), abs(residual_pct), abs(market_move_pct),
    abs(liquidity_usd), abs(market_cap)]), true))
);

-- The surface read asks for "one day's rows, most unusual first, then by turnover".
CREATE INDEX IF NOT EXISTS intel_unusual_move_scores_rank_idx
  ON public.intel_unusual_move_scores (subject_day DESC, scored, move_percentile DESC, liquidity_usd DESC);
-- The freshness guard asks "when did this lane last run", and retention asks "which days are past the horizon".
CREATE INDEX IF NOT EXISTS intel_unusual_move_scores_captured_idx
  ON public.intel_unusual_move_scores (captured_at DESC);
-- One asset's own recent history of unusualness, for an asset page and for an alert read.
CREATE INDEX IF NOT EXISTS intel_unusual_move_scores_asset_idx
  ON public.intel_unusual_move_scores (cmc_id, subject_day DESC);

COMMENT ON TABLE public.intel_unusual_move_scores IS
  'Each asset''s newest complete UTC day scored against its OWN trailing distribution (robust z on median/MAD, empirical percentile, log-volume percentile, market-relative residual with beta). Derived from market_asset_candles and market_assets by the intel-capture `unusual_moves` op; zero provider credits. A cache of a calculation, recomputable from the archive, kept 30 days.';

ALTER TABLE public.intel_unusual_move_scores ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_unusual_move_scores FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_unusual_move_scores TO service_role;

-- SECTION 2: cadence policy

-- A later edit to the row wins, so re-running this migration never resets one. `max_credits` is 0 and it is not a
-- default: this lane issues no provider call of any kind, and a non-zero ceiling here would be a claim that it might.
INSERT INTO public.provider_schedule_policy (provider, feature, cadence_seconds, enabled, min_plan, max_credits, reason) VALUES
  ('local', 'unusual_moves', 3600, true, NULL, 0,
   'Hourly rescore of each archive asset''s newest complete UTC day against its own trailing 30 and 90 day distribution. Reads market_asset_candles, market_asset_candle_backfill and market_assets only: zero provider calls, so max_credits is 0 and there is no CMC plan gate. Registered under provider ''local'' so the CoinMarketCap credit calibration never stretches a lane that cannot spend a credit.')
ON CONFLICT (provider, feature) DO NOTHING;

-- SECTION 3: retention, patched into the live definition (see the header)

DO $retention$
DECLARE original text; changed text; block text;
BEGIN
  original := pg_get_functiondef('app_private.intel_capture_retention(timestamptz)'::regprocedure);
  -- Refuse a second application rather than adding the same DELETE block twice.
  IF position('intel_unusual_move_scores' in original) > 0 THEN
    RAISE EXCEPTION 'unusual_move_retention_block_already_present';
  END IF;
  -- Exactly one `RETURN removed;` is what makes the insertion point unambiguous. Any other count means the function
  -- is not the one this migration was written against, and guessing at a second anchor is how a lane's horizon gets
  -- lost.
  IF (SELECT count(*) FROM regexp_matches(original, '\n[ \t]*RETURN removed;', 'g')) <> 1 THEN
    RAISE EXCEPTION 'unexpected_retention_definition';
  END IF;
  block :=
       E'  -- Added by the unusual-move lane. Every figure in a row is derived from market_asset_candles, which is never\n'
    || E'  -- thinned and never deleted, so any pruned day can be recomputed exactly from stored inputs. Thirty days is\n'
    || E'  -- long enough to answer "was yesterday unusual, and was last Tuesday" on the surface.\n'
    || E'  DELETE FROM public.intel_unusual_move_scores WHERE subject_day < (p_now - interval ''30 days'')::date;\n'
    || E'  GET DIAGNOSTICS n = ROW_COUNT;\n'
    || E'  removed := removed || jsonb_build_object(''intel_unusual_move_scores'', n);\n';
  changed := regexp_replace(original, '(\n[ \t]*RETURN removed;)', E'\n' || replace(block, '\', '\\') || E'\\1');
  IF changed = original THEN RAISE EXCEPTION 'unexpected_retention_definition'; END IF;
  EXECUTE changed;
END $retention$;
REVOKE ALL ON FUNCTION app_private.intel_capture_retention(timestamptz) FROM PUBLIC, anon, authenticated;

-- SECTION 4: schedule

-- Minute 52, every hour. Twelve minutes after the daily candle append at 00:40, so the newly closed UTC day is
-- already stored when the first run of the day scores it, and clear of every other intel-capture job: :05/:25/:45
-- candle backfill, :07 the hourly batch, :10 new listings, :17 categories, :23 FX, :37 meme, :41 launchpads,
-- :43 SunPump, and the 5-minute liquidation lane. Checked against cron.job on 2026-09-20: no intel-capture job runs
-- at :52 (market-assets-derived is :27/:57 and posts to a different Edge Function).
--
-- The job is idempotent three times over: rows are keyed on (asset_key, subject_day) and upserted, the scored day is
-- derived from stored candles rather than the clock, and the lane additionally skips with `within_cadence` when its
-- own newest captured_at is younger than cadence_seconds in provider_schedule_policy.
SELECT cron.unschedule('intel-capture-unusual-hourly') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-capture-unusual-hourly');
SELECT cron.schedule('intel-capture-unusual-hourly', '52 * * * *', $$
  SELECT net.http_post(
    url     := concat((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL'), '/functions/v1/intel-capture'),
    headers := jsonb_build_object('Content-Type','application/json','Authorization', concat('Bearer ', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')), 'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')),
    body    := jsonb_build_object('op','unusual_moves'), timeout_milliseconds := 110000);
$$);
