-- ============================================================
-- Investor Intel: RWA wrapper premium history, reconstructed from daily OHLCV closes
-- ============================================================
-- The wrapper lane (20260920150000) has kept every six-hourly capture since 2026-09-20 15:00 UTC, so the premium
-- history from that hour on is simply the existing `intel_rwa_wrapper_assets` / `intel_rwa_wrapper_tokens` rows. This
-- migration adds the part before it: up to 90 days per wrapper, RECONSTRUCTED from CoinMarketCap's daily OHLCV close
-- and daily volume, with the same unit guard, accrual guard, liquidity floor and anchor rule the live lane applies.
--
--   intel_rwa_wrapper_premium_backfill   One row per wrapper per UTC day per method. APPEND-ONLY BY PRIVILEGE: the
--                                        service role may SELECT and INSERT, nothing else. A reconstruction is written
--                                        once, for one asset-day at a time, from one complete set of closes; it is
--                                        never rewritten in place by a later run that saw a different set.
--   intel_rwa_wrapper_backfill_state     One row per wrapper (crypto id): pending, complete, no_data or failed, the
--                                        credits it has cost, how many attempts it took and why it stopped.
--
-- ── WHY A SEPARATE TABLE AND NOT MORE ROWS IN THE LIVE ONES ──────────────────────────────────────────────────────
-- A live row is a six-hourly quote read at a stated hour. A reconstructed row is a DAILY CLOSE read months later and
-- run through the same arithmetic. They are different observations and the reader is told which one each point is,
-- so they cannot share a table in which the difference would be one more column somebody forgets to read. The method
-- is part of the primary key so a second reconstruction method can never overwrite the first.
--
-- ── WHAT THE BACKFILL COSTS ──────────────────────────────────────────────────────────────────────────────────────
--   GET /v2/cryptocurrency/ohlcv/historical, ONE crypto id per call, count=90, interval=daily, time_period=daily.
--   The registry prices it at one credit per 100 points, so ceil(90/100) = 1 credit per wrapper. One id per call is
--   not a preference: `estimateCmcCredits` reads `count` before `id`, so a comma-joined call would be estimated at one
--   credit while billing one per id.
--   Measured 2026-09-22: 316 distinct wrapper crypto ids across 51 assets in the live tables, so the whole backfill is
--   about 316 credits, spent at most 60 per run. The standing ceiling is `max_credits = 400` on the policy row below,
--   summed across every run from `intel_rwa_wrapper_backfill_state.credits_spent`.
--
-- ── WHAT THE SCHEMA ITSELF REFUSES TO ALLOW ──────────────────────────────────────────────────────────────────────
--   * The same accrual, unit, anchor-membership and stated-reason rules as `intel_rwa_wrapper_tokens`.
--   * A reconstructed day must be BEFORE the live capture whose wrapper set it was rebuilt from. The backfill fills
--     the gap before the live history; it never competes with a live row for the same day.
--   * No published NAV anchor: the reconstruction never reads a historical NAV, so the only kinds are the wrapper
--     median and none, and 'none' always says why.
--   * Numeric columns reject NaN and +/-Infinity with the same `1e30 >= ALL (ARRAY[abs(...)])` guard.
--
-- ── LICENCE ──────────────────────────────────────────────────────────────────────────────────────────────────────
-- The lane refuses to run unless `CMC_ALLOW_HISTORICAL_RETENTION` is 'true' and the plan is Startup or above. The
-- policy row is inserted DISABLED; an operator enables it deliberately.
--
-- ── RETENTION ────────────────────────────────────────────────────────────────────────────────────────────────────
-- 400 days on `day`, matching the live wrapper tables, PATCHED into the live `app_private.intel_capture_retention`
-- with the same two guards as its siblings. The nightly `intel-capture-retention-daily` job runs as `postgres`, the
-- table owner (checked in cron.job 2026-09-22), so the append-only grant to service_role does not stop it. The state table is not pruned: it is one row per wrapper and is what stops a wrapper being bought twice.
--
-- IDEMPOTENT. IF NOT EXISTS on tables and indexes, ON CONFLICT DO NOTHING on the policy row, and the retention splice
-- checks for its own block first. No cron job: the lane is run by an operator (op 'rwa_wrapper_backfill'). Validated
-- offline with pglast. NOT APPLIED by this change.
--
-- ROLLBACK
--   UPDATE public.provider_schedule_policy SET enabled = false WHERE provider = 'coinmarketcap' AND feature = 'rwa_wrapper_backfill';
--   DROP TABLE public.intel_rwa_wrapper_premium_backfill;
--   DROP TABLE public.intel_rwa_wrapper_backfill_state;
--   DELETE FROM public.provider_schedule_policy WHERE provider = 'coinmarketcap' AND feature = 'rwa_wrapper_backfill';
--   -- and remove the retention block (otherwise the nightly job errors against the dropped table):
--   --   DO $r$ DECLARE original text; BEGIN
--   --     original := pg_get_functiondef('app_private.intel_capture_retention(timestamptz)'::regprocedure);
--   --     EXECUTE regexp_replace(original, '\n[ \t]*-- Added by 20260922100000.*?intel_rwa_wrapper_premium_backfill''[^\n]*\n', E'\n', 'ns');
--   --   END $r$;
-- ============================================================

SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- SECTION 1: one reconstructed row per wrapper per day

CREATE TABLE IF NOT EXISTS public.intel_rwa_wrapper_premium_backfill (
  provider text NOT NULL CHECK (provider = 'coinmarketcap'),
  rwa_id text NOT NULL CHECK (rwa_id ~ '^[1-9][0-9]{0,11}$'),
  crypto_id text NOT NULL CHECK (crypto_id ~ '^[1-9][0-9]{0,11}$'),
  -- The UTC day the daily candle opened.
  day date NOT NULL,
  -- How the row was made. Part of the key, so a second method can never overwrite the first.
  method text NOT NULL CHECK (method IN ('ohlcv_daily_close_reconstructed')),
  symbol text CHECK (symbol IS NULL OR length(symbol) BETWEEN 1 AND 50),
  name text CHECK (name IS NULL OR length(name) BETWEEN 1 AND 200),

  -- The daily close as reported, in whatever unit the wrapper uses, and the same close restated in the asset's unit.
  close_price numeric NOT NULL CHECK (close_price > 0),
  normalised_price numeric CHECK (normalised_price IS NULL OR normalised_price > 0),
  -- The day's reported USD volume, standing in for the live lane's 24-hour volume. NULL when the provider reported
  -- none; zero is a real zero.
  volume_24h numeric CHECK (volume_24h IS NULL OR volume_24h >= 0),
  market_cap numeric CHECK (market_cap IS NULL OR market_cap >= 0),

  unit_state text NOT NULL CHECK (unit_state IN ('consistent', 'normalised_troy_ounce', 'normalised_gram', 'not_established', 'not_assessed')),
  unit_factor numeric CHECK (unit_factor IS NULL OR unit_factor > 0),
  wrapper_state text NOT NULL CHECK (wrapper_state IN (
    'liquid', 'too_thin_to_anchor', 'volume_not_reported', 'no_price', 'unit_not_established', 'accrues_in_price')),
  state_reason text CHECK (state_reason IS NULL OR length(state_reason) <= 120),
  premium_bps numeric,
  accrual_gap_bps numeric,
  in_anchor boolean NOT NULL DEFAULT false,

  -- ── the asset-day anchor this wrapper was measured against, repeated on every wrapper of the asset-day ──
  anchor_kind text NOT NULL CHECK (anchor_kind IN ('liquid_wrapper_median', 'none')),
  anchor_price numeric CHECK (anchor_price IS NULL OR anchor_price > 0),
  anchor_members integer NOT NULL DEFAULT 0 CHECK (anchor_members >= 0),
  anchor_reason text CHECK (anchor_reason IS NULL OR length(anchor_reason) <= 120),
  asset_dispersion_bps numeric CHECK (asset_dispersion_bps IS NULL OR asset_dispersion_bps >= 0),
  asset_weighted_spread_bps numeric CHECK (asset_weighted_spread_bps IS NULL OR asset_weighted_spread_bps >= 0),
  -- The floor this reconstruction applied, stored so a figure can be reproduced after the constant changes.
  volume_floor_usd numeric NOT NULL CHECK (volume_floor_usd >= 0),

  -- The LIVE capture hour whose wrapper set, names and asset symbol the reconstruction was rebuilt from.
  wrapper_set_captured_at timestamptz NOT NULL CHECK (wrapper_set_captured_at = date_trunc('hour', wrapper_set_captured_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
  -- The provider's own candle open time, as returned.
  bar_open_at timestamptz NOT NULL,
  -- Which request produced the close: capability, id and window. Never a key.
  source_ref text NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 300),
  fetched_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, rwa_id, crypto_id, day, method),

  -- A reconstruction fills the gap BEFORE the live history, never a day the live lane already covers.
  CONSTRAINT intel_rwa_wrapper_premium_backfill_before_live CHECK (day < (wrapper_set_captured_at AT TIME ZONE 'UTC')::date),
  CONSTRAINT intel_rwa_wrapper_premium_backfill_accrual CHECK (
    (premium_bps IS NULL OR accrual_gap_bps IS NULL)
    AND (wrapper_state <> 'accrues_in_price' OR premium_bps IS NULL)
    AND (accrual_gap_bps IS NULL OR wrapper_state = 'accrues_in_price')),
  CONSTRAINT intel_rwa_wrapper_premium_backfill_unit CHECK (
    unit_state <> 'not_established' OR (normalised_price IS NULL AND premium_bps IS NULL AND accrual_gap_bps IS NULL)),
  CONSTRAINT intel_rwa_wrapper_premium_backfill_unit_state CHECK (
    (wrapper_state = 'unit_not_established') = (unit_state = 'not_established')),
  CONSTRAINT intel_rwa_wrapper_premium_backfill_in_anchor CHECK (in_anchor = false OR wrapper_state = 'liquid'),
  CONSTRAINT intel_rwa_wrapper_premium_backfill_reason CHECK (wrapper_state = 'liquid' OR state_reason IS NOT NULL),
  CONSTRAINT intel_rwa_wrapper_premium_backfill_anchor CHECK (
    (anchor_kind = 'none' AND anchor_price IS NULL AND anchor_reason IS NOT NULL)
    OR (anchor_kind <> 'none' AND anchor_price IS NOT NULL)),
  -- Every derived figure requires the anchor it was measured against.
  CONSTRAINT intel_rwa_wrapper_premium_backfill_derived CHECK (
    anchor_price IS NOT NULL OR (
      premium_bps IS NULL AND accrual_gap_bps IS NULL AND in_anchor = false
      AND asset_dispersion_bps IS NULL AND asset_weighted_spread_bps IS NULL)),
  CONSTRAINT intel_rwa_wrapper_premium_backfill_finite CHECK (coalesce(1e30 >= ALL (ARRAY[
    abs(close_price), abs(normalised_price), abs(volume_24h), abs(market_cap), abs(unit_factor),
    abs(premium_bps), abs(accrual_gap_bps), abs(anchor_price), abs(asset_dispersion_bps),
    abs(asset_weighted_spread_bps), abs(volume_floor_usd)]), true))
);
-- The history read filters on one asset and a day window, which the primary key's leading columns serve. This index
-- serves retention, which sweeps by day across every asset.
CREATE INDEX IF NOT EXISTS intel_rwa_wrapper_premium_backfill_day_idx ON public.intel_rwa_wrapper_premium_backfill (day);
ALTER TABLE public.intel_rwa_wrapper_premium_backfill ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_rwa_wrapper_premium_backfill FROM PUBLIC, anon, authenticated, service_role;
-- APPEND-ONLY BY PRIVILEGE. The lane inserts with ON CONFLICT DO NOTHING, which needs INSERT only.
GRANT SELECT, INSERT ON TABLE public.intel_rwa_wrapper_premium_backfill TO service_role;

-- SECTION 2: one state row per wrapper

CREATE TABLE IF NOT EXISTS public.intel_rwa_wrapper_backfill_state (
  crypto_id text PRIMARY KEY CHECK (crypto_id ~ '^[1-9][0-9]{0,11}$'),
  provider text NOT NULL DEFAULT 'coinmarketcap' CHECK (provider = 'coinmarketcap'),
  -- The asset the wrapper was queued under.
  rwa_id text NOT NULL CHECK (rwa_id ~ '^[1-9][0-9]{0,11}$'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'complete', 'no_data', 'failed')),
  credits_spent integer NOT NULL DEFAULT 0 CHECK (credits_spent >= 0),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  reason text CHECK (reason IS NULL OR length(reason) <= 200),
  days_written integer NOT NULL DEFAULT 0 CHECK (days_written >= 0),
  first_day date,
  last_day date,
  -- The live capture hour the wrapper set was read from when this wrapper was queued.
  wrapper_set_captured_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A complete wrapper wrote at least one day; a wrapper that stopped for any other terminal reason says why.
  CONSTRAINT intel_rwa_wrapper_backfill_state_complete CHECK (state <> 'complete' OR days_written > 0),
  CONSTRAINT intel_rwa_wrapper_backfill_state_reason CHECK (state NOT IN ('no_data', 'failed') OR reason IS NOT NULL),
  CONSTRAINT intel_rwa_wrapper_backfill_state_days CHECK (
    (first_day IS NULL) = (last_day IS NULL) AND (first_day IS NULL OR first_day <= last_day))
);
CREATE INDEX IF NOT EXISTS intel_rwa_wrapper_backfill_state_queue_idx ON public.intel_rwa_wrapper_backfill_state (state, rwa_id);
ALTER TABLE public.intel_rwa_wrapper_backfill_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_rwa_wrapper_backfill_state FROM PUBLIC, anon, authenticated, service_role;
-- State moves forward by UPDATE; a row is never deleted, because it is the record of what was already paid for.
GRANT SELECT, INSERT, UPDATE ON TABLE public.intel_rwa_wrapper_backfill_state TO service_role;

-- SECTION 3: the lane's switch and its standing ceiling

-- INSERTED DISABLED. An operator enables it once the licence and the plan are confirmed.
-- cadence_seconds 86400  one run a day at most; the lane refuses to run again inside it.
-- min_plan 'startup'     OHLCV historical is a Startup capability.
-- max_credits 400        the STANDING ceiling across every run (the convention the candle history lane set), not a
--                        per-run figure. A run is additionally held to 60 wrapper ids, so 60 credits, in code.
INSERT INTO public.provider_schedule_policy (provider, feature, cadence_seconds, enabled, min_plan, max_credits, reason) VALUES
  ('coinmarketcap', 'rwa_wrapper_backfill', 86400, false, 'startup', 400,
   'One-off reconstruction of up to 90 days of wrapper premium history before the live wrapper lane began, from daily OHLCV closes. One crypto id per /v2/cryptocurrency/ohlcv/historical call at count=90, so 1 credit per wrapper; at most 60 wrappers (60 credits) per run and 400 credits in total. Measured 2026-09-22: 316 wrappers, so about 316 credits once. Refuses to run unless CMC_ALLOW_HISTORICAL_RETENTION is true and the plan is Startup or above.')
ON CONFLICT (provider, feature) DO NOTHING;

-- SECTION 4: retention

DO $retention$
DECLARE original text; changed text; block text;
BEGIN
  original := pg_get_functiondef('app_private.intel_capture_retention(timestamptz)'::regprocedure);
  IF position('intel_rwa_wrapper_premium_backfill' in original) > 0 THEN
    RAISE NOTICE 'RWA wrapper premium backfill retention block already present; leaving the function unchanged.';
    RETURN;
  END IF;
  IF (SELECT count(*) FROM regexp_matches(original, '\n[ \t]*RETURN removed;', 'g')) <> 1 THEN
    RAISE EXCEPTION 'unexpected_retention_definition';
  END IF;
  block :=
       E'  -- Added by 20260922100000 (RWA wrapper premium backfill). 400 days of reconstructed daily rows.\n'
    || E'  DELETE FROM public.intel_rwa_wrapper_premium_backfill WHERE day < (p_now - interval ''400 days'')::date;\n'
    || E'  GET DIAGNOSTICS n = ROW_COUNT;\n'
    || E'  removed := removed || jsonb_build_object(''intel_rwa_wrapper_premium_backfill'', n);\n';
  changed := regexp_replace(original, '(\n[ \t]*RETURN removed;)', E'\n' || replace(block, '\', '\\') || E'\\1');
  IF changed = original THEN RAISE EXCEPTION 'unexpected_retention_definition'; END IF;
  EXECUTE changed;
END $retention$;
REVOKE ALL ON FUNCTION app_private.intel_capture_retention(timestamptz) FROM PUBLIC, anon, authenticated;
