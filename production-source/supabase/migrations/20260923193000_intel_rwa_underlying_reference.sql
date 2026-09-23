-- ============================================================
-- Investor Intel: the underlying stock's price beside the RWA wrapper board
-- ============================================================
-- The wrapper board measures each wrapper of a tokenised stock or ETF against the volume-weighted median of its
-- sibling wrappers (the anchor). This adds, BESIDE that anchor and never instead of it, the listed share's own price
-- from a Chainlink on-chain equity feed, read keylessly through a public RPC inside the six-hourly `rwa_wrappers` lane
-- (supabase/functions/_shared/intel/underlying-reference.ts). Zero CoinMarketCap credits: RPC reads only.
--
--   intel_rwa_underlying_reference_observations   One row per tokenised stock or ETF per wrapper capture for which a
--                                                 feed read was ATTEMPTED, failures included: the feed, its update
--                                                 band and heartbeat, the round in effect when the wrapper prices were
--                                                 observed, its age at that instant, and the US session at that instant.
--
--   intel_rwa_wrapper_assets    + underlying_ref_* columns: the reference and the anchor's gap to it.
--   intel_rwa_wrapper_tokens    + underlying_ref_* columns: each wrapper's gap to the stock, and whether that gap is
--                                 inside the feed's own update band (in which case it is not distinguishable).
--
-- ADDITIVE ONLY. Every new column is nullable with no default, so every existing reader and writer is unaffected and a
-- row written before this migration simply carries no reference.
--
-- THE CLOCK. `compared_at` is the provider's own clock for the wrapper prices (`source_observed_at`), NOT the capture
-- time: the RWA quotes refresh twice a day, so a 14:47 capture carries 08:45 prices. The round stored is the one in
-- effect at that instant, and `session` names the US session at that same instant.
--
-- THE BAND. A Chainlink push feed writes a new round only after a move of `deviation_pct` percent or after
-- `heartbeat_s` seconds, so a gap smaller than the band cannot be told apart from zero. `underlying_ref_within_band`
-- records exactly that, and the surface says "not distinguishable" instead of printing a premium.
--
-- PRIVILEGES. Service role only, like every capture table: RLS on, nothing granted to anon or authenticated. Members
-- read it through intel-capture's `rwa_wrappers` view and the MCP `rwa_wrapper_premiums` tool, both service role.
--
-- RETENTION. 400 days, matching the wrapper tables it describes, spliced into app_private.intel_capture_retention the
-- same way 20260920150000 did (the splice checks for its own block first, so re-running is a no-op).
--
-- ROLLBACK (manual):
--   DROP TABLE public.intel_rwa_underlying_reference_observations;
--   ALTER TABLE public.intel_rwa_wrapper_assets DROP COLUMN underlying_ref_state, ... (every underlying_ref_* column);
--   ALTER TABLE public.intel_rwa_wrapper_tokens DROP COLUMN underlying_ref_price, ... (every underlying_ref_* column);
--   and remove the '-- Added by 20260923193000' block from app_private.intel_capture_retention.

-- SECTION 1: one row per attempted reference read

CREATE TABLE IF NOT EXISTS public.intel_rwa_underlying_reference_observations (
  rwa_id text NOT NULL CHECK (rwa_id ~ '^[1-9][0-9]{0,11}$'),
  -- The wrapper capture this reading belongs to: the lane's hour-floored run key, the same value as the
  -- `captured_at` of the wrapper rows it is joined to.
  captured_at timestamptz NOT NULL CHECK (captured_at = date_trunc('hour', captured_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
  -- Chainlink is the only source today. A second source is a new value here, added by its own migration.
  source text NOT NULL CHECK (source IN ('chainlink')),
  ticker text NOT NULL CHECK (ticker ~ '^[A-Z0-9.-]{1,12}$'),
  -- Which run wrote it: the scheduled lane, or the one-off reference step over an existing capture.
  capture_op text NOT NULL CHECK (capture_op IN ('rwa_wrappers', 'rwa_wrapper_reference')),
  chain text CHECK (chain IS NULL OR chain IN ('arbitrum', 'bsc', 'optimism', 'polygon')),
  proxy text CHECK (proxy IS NULL OR proxy ~ '^0x[0-9a-f]{40}$'),
  feed_description text CHECK (feed_description IS NULL OR length(feed_description) BETWEEN 1 AND 120),
  -- What the chain said, kept even when it disagreed, so a refusal is reviewable rather than asserted.
  on_chain_description text CHECK (on_chain_description IS NULL OR length(on_chain_description) <= 200),
  decimals smallint CHECK (decimals IS NULL OR decimals BETWEEN 0 AND 36),
  deviation_pct numeric CHECK (deviation_pct IS NULL OR (deviation_pct > 0 AND deviation_pct <= 10)),
  heartbeat_s integer CHECK (heartbeat_s IS NULL OR heartbeat_s > 0),
  market_hours text CHECK (market_hours IS NULL OR market_hours IN ('nyse_regular', 'us_equities_24_5')),
  read_state text NOT NULL CHECK (read_state IN ('observed', 'stale', 'unavailable')),
  read_reason text CHECK (read_reason IS NULL OR length(read_reason) <= 120),
  read_detail text CHECK (read_detail IS NULL OR length(read_detail) <= 200),
  -- Phase-encoded, far beyond a JS number, so text.
  round_id text CHECK (round_id IS NULL OR round_id ~ '^[0-9]{1,80}$'),
  price numeric CHECK (price IS NULL OR (price > 0 AND price < 1e12)),
  round_updated_at timestamptz,
  age_seconds bigint,
  rounds_read integer NOT NULL DEFAULT 0 CHECK (rounds_read >= 0 AND rounds_read <= 60),
  compared_at timestamptz NOT NULL,
  session text NOT NULL CHECK (session IN ('regular', 'pre_market', 'after_hours', 'closed', 'weekend', 'holiday', 'unknown')),
  fetched_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rwa_id, captured_at, source),
  -- An observed reading always has its figure and its round clock. Anything else always says why.
  CONSTRAINT intel_rwa_underlying_reference_observed CHECK (
    read_state <> 'observed' OR (price IS NOT NULL AND round_updated_at IS NOT NULL AND round_id IS NOT NULL AND read_reason IS NULL)),
  CONSTRAINT intel_rwa_underlying_reference_reason CHECK (read_state = 'observed' OR read_reason IS NOT NULL),
  -- A failed read carries no figure at all: never a zero, never a leftover.
  CONSTRAINT intel_rwa_underlying_reference_unavailable CHECK (
    read_state <> 'unavailable' OR (price IS NULL AND round_updated_at IS NULL))
);
CREATE INDEX IF NOT EXISTS intel_rwa_underlying_reference_captured_idx ON public.intel_rwa_underlying_reference_observations (captured_at DESC);
CREATE INDEX IF NOT EXISTS intel_rwa_underlying_reference_ticker_idx ON public.intel_rwa_underlying_reference_observations (ticker, captured_at DESC);
ALTER TABLE public.intel_rwa_underlying_reference_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_rwa_underlying_reference_observations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_rwa_underlying_reference_observations TO service_role;

-- SECTION 2: the reference on each asset row

ALTER TABLE public.intel_rwa_wrapper_assets
  ADD COLUMN IF NOT EXISTS underlying_ref_state text,
  ADD COLUMN IF NOT EXISTS underlying_ref_reason text,
  ADD COLUMN IF NOT EXISTS underlying_ref_ticker text,
  ADD COLUMN IF NOT EXISTS underlying_ref_source text,
  ADD COLUMN IF NOT EXISTS underlying_ref_price numeric,
  ADD COLUMN IF NOT EXISTS underlying_ref_feed text,
  ADD COLUMN IF NOT EXISTS underlying_ref_network text,
  ADD COLUMN IF NOT EXISTS underlying_ref_address text,
  ADD COLUMN IF NOT EXISTS underlying_ref_deviation_pct numeric,
  ADD COLUMN IF NOT EXISTS underlying_ref_heartbeat_s integer,
  ADD COLUMN IF NOT EXISTS underlying_ref_hours text,
  ADD COLUMN IF NOT EXISTS underlying_ref_observed_at timestamptz,
  ADD COLUMN IF NOT EXISTS underlying_ref_compared_at timestamptz,
  ADD COLUMN IF NOT EXISTS underlying_ref_age_s bigint,
  ADD COLUMN IF NOT EXISTS underlying_ref_session text,
  ADD COLUMN IF NOT EXISTS underlying_ref_anchor_bps numeric,
  ADD COLUMN IF NOT EXISTS underlying_ref_anchor_within_band boolean,
  ADD COLUMN IF NOT EXISTS underlying_ref_fetched_at timestamptz;

ALTER TABLE public.intel_rwa_wrapper_assets DROP CONSTRAINT IF EXISTS intel_rwa_wrapper_assets_underlying_ref;
ALTER TABLE public.intel_rwa_wrapper_assets ADD CONSTRAINT intel_rwa_wrapper_assets_underlying_ref CHECK (
  (underlying_ref_state IS NULL OR underlying_ref_state IN ('observed', 'stale', 'unavailable', 'no_reference', 'mapping_refused'))
  AND (underlying_ref_source IS NULL OR underlying_ref_source IN ('chainlink'))
  AND (underlying_ref_hours IS NULL OR underlying_ref_hours IN ('nyse_regular', 'us_equities_24_5'))
  AND (underlying_ref_session IS NULL OR underlying_ref_session IN ('regular', 'pre_market', 'after_hours', 'closed', 'weekend', 'holiday', 'unknown'))
  AND (underlying_ref_reason IS NULL OR length(underlying_ref_reason) <= 120)
  AND (underlying_ref_price IS NULL OR (underlying_ref_price > 0 AND underlying_ref_price < 1e12))
  -- Every state but observed says why.
  AND (underlying_ref_state IS NULL OR underlying_ref_state = 'observed' OR underlying_ref_reason IS NOT NULL)
  AND (underlying_ref_state IS DISTINCT FROM 'observed' OR (underlying_ref_price IS NOT NULL AND underlying_ref_observed_at IS NOT NULL))
  -- A gap is only ever measured against an observed reference, and a band verdict only ever sits beside a gap.
  AND (underlying_ref_anchor_bps IS NULL OR underlying_ref_state = 'observed')
  AND (underlying_ref_anchor_within_band IS NULL OR underlying_ref_anchor_bps IS NOT NULL)
  AND coalesce(1e30 >= ALL (ARRAY[abs(underlying_ref_price), abs(underlying_ref_anchor_bps), abs(underlying_ref_deviation_pct)]), true)
);

-- SECTION 3: each wrapper's gap to the stock

ALTER TABLE public.intel_rwa_wrapper_tokens
  ADD COLUMN IF NOT EXISTS underlying_ref_price numeric,
  ADD COLUMN IF NOT EXISTS underlying_ref_bps numeric,
  ADD COLUMN IF NOT EXISTS underlying_ref_within_band boolean,
  ADD COLUMN IF NOT EXISTS underlying_ref_session text,
  ADD COLUMN IF NOT EXISTS underlying_ref_observed_at timestamptz,
  ADD COLUMN IF NOT EXISTS underlying_ref_source text;

ALTER TABLE public.intel_rwa_wrapper_tokens DROP CONSTRAINT IF EXISTS intel_rwa_wrapper_tokens_underlying_ref;
ALTER TABLE public.intel_rwa_wrapper_tokens ADD CONSTRAINT intel_rwa_wrapper_tokens_underlying_ref CHECK (
  (underlying_ref_source IS NULL OR underlying_ref_source IN ('chainlink'))
  AND (underlying_ref_session IS NULL OR underlying_ref_session IN ('regular', 'pre_market', 'after_hours', 'closed', 'weekend', 'holiday', 'unknown'))
  AND (underlying_ref_price IS NULL OR (underlying_ref_price > 0 AND underlying_ref_price < 1e12))
  AND (underlying_ref_bps IS NULL OR underlying_ref_price IS NOT NULL)
  AND (underlying_ref_within_band IS NULL OR underlying_ref_bps IS NOT NULL)
  -- THE ACCRUAL RULE, again: an accruing wrapper never carries a gap to the stock, as it never carries a premium.
  AND (wrapper_state <> 'accrues_in_price' OR underlying_ref_bps IS NULL)
  -- No comparable price, no gap.
  AND (normalised_price IS NOT NULL OR underlying_ref_bps IS NULL)
  AND coalesce(1e30 >= ALL (ARRAY[abs(underlying_ref_price), abs(underlying_ref_bps)]), true)
);

-- SECTION 4: retention

DO $retention$
DECLARE original text; changed text; block text;
BEGIN
  original := pg_get_functiondef('app_private.intel_capture_retention(timestamptz)'::regprocedure);
  IF position('intel_rwa_underlying_reference_observations' in original) > 0 THEN
    RAISE NOTICE 'Underlying reference retention block already present; leaving the function unchanged.';
    RETURN;
  END IF;
  IF (SELECT count(*) FROM regexp_matches(original, '\n[ \t]*RETURN removed;', 'g')) <> 1 THEN
    RAISE EXCEPTION 'unexpected_retention_definition';
  END IF;
  block :=
       E'  -- Added by 20260923193000 (underlying stock reference). 400 days, matching the wrapper tables.\n'
    || E'  DELETE FROM public.intel_rwa_underlying_reference_observations WHERE captured_at < p_now - interval ''400 days'';\n'
    || E'  GET DIAGNOSTICS n = ROW_COUNT;\n'
    || E'  removed := removed || jsonb_build_object(''intel_rwa_underlying_reference_observations'', n);\n';
  changed := regexp_replace(original, '(\n[ \t]*RETURN removed;)', E'\n' || replace(block, '\', '\\') || E'\\1');
  IF changed = original THEN RAISE EXCEPTION 'unexpected_retention_definition'; END IF;
  EXECUTE changed;
END $retention$;
REVOKE ALL ON FUNCTION app_private.intel_capture_retention(timestamptz) FROM PUBLIC, anon, authenticated;
