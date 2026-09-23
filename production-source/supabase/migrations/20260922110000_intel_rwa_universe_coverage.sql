-- ============================================================
-- Investor Intel: daily RWA universe coverage, universe changes and issuer concentration
-- ============================================================
-- Three capture tables behind the `rwa_coverage`, `rwa_universe_changes` and `rwa_concentration` views of the
-- `intel-capture` Edge Function, plus the lane's on/off switch, its daily schedule and its retention horizon.
--
--   intel_rwa_coverage_assets   One row per tokenised asset per UTC day: how many tokens the provider reports for it,
--                               how many are priced, how many carry reported trading, and the asset's coverage state.
--   intel_rwa_coverage_tokens   One row per token per asset per UTC day: price, market cap, 24h volume, issuer and the
--                               token's own state. The input to the concentration view.
--   intel_rwa_coverage_changes  APPEND-ONLY events between two daily snapshots: listed, removed, became_tradeable,
--                               shelved. service_role may SELECT and INSERT only, so history cannot be rewritten.
--
-- WHY A NEW LANE. The wrapper lane keeps only assets with two or more wrappers and caps at 60; the universe snapshot
-- keeps aggregates and a top 10. Neither can say how many of the ~800 tokenised assets have a token that trades, which
-- assets appeared or vanished since yesterday, or how concentrated the tokenised market is by issuer.
--
-- ── WHAT ONE RUN COSTS ───────────────────────────────────────────────────────────────────────────────────────────
--   database reads   the asset ids from intel_rwa_asset_map (has_tokens IS NOT FALSE, seen in the last 36 hours), this
--                    lane's own previous snapshot and today's intel_rwa_asset_map_counts row. 0 credits.
--   N calls          GET /v5/real-world-assets/quotes/latest with 100 rwa_ids each. Billed ceil(n/250), so 1 credit each.
--   MEASURED 2026-09-22: 791 eligible ids -> 8 calls -> 8 CREDITS A DAY. The per-run ceiling is max_credits = 15 below
--   (1,500 ids); ids past it are stored as `not_returned` with reason `credit_ceiling`, never dropped.
--
-- ── WHAT THE SCHEMA REFUSES ──────────────────────────────────────────────────────────────────────────────────────
--   * An asset that was not returned carries its reason and no counts: `not_returned` is never "no tokens".
--   * Counts are bounded: traded <= priced <= tokens.
--   * A change event carries the state it moved from and to, consistent with its kind.
--   * Numeric columns reject NaN and +/-Infinity (same 1e30 guard as the neighbouring capture tables).
--
-- TIER: nothing to add. Served through the existing `capture_views` surface (free / precomputed_shared).
--
-- RETENTION: 400 days of asset rows, 180 days of token rows, change events kept. PATCHED into the live
-- app_private.intel_capture_retention with the same two guards as 20260920150000.
--
-- IDEMPOTENT. IF NOT EXISTS everywhere, guarded constraints, ON CONFLICT DO NOTHING for the policy row, the cron job
-- unscheduled by name before it is scheduled, and the retention splice checks for its own block. NOT APPLIED by this
-- change. Validated offline with pglast.
--
-- ROLLBACK
--   SELECT cron.unschedule('intel-capture-rwa-coverage-daily');
--   UPDATE public.provider_schedule_policy SET enabled = false WHERE provider = 'coinmarketcap' AND feature = 'rwa_coverage';
--   -- drop the data too:
--   DROP TABLE public.intel_rwa_coverage_changes;
--   DROP TABLE public.intel_rwa_coverage_tokens;
--   DROP TABLE public.intel_rwa_coverage_assets;
--   DELETE FROM public.provider_schedule_policy WHERE provider = 'coinmarketcap' AND feature = 'rwa_coverage';
--   -- and remove the retention block (otherwise the nightly job errors against the dropped tables):
--   --   DO $r$ DECLARE original text; BEGIN
--   --     original := pg_get_functiondef('app_private.intel_capture_retention(timestamptz)'::regprocedure);
--   --     EXECUTE regexp_replace(original, '\n[ \t]*-- Added by 20260922110000.*?intel_rwa_coverage_assets''[^\n]*\n', E'\n', 'ns');
--   --   END $r$;
-- ============================================================

SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- SECTION 1: one row per tokenised asset per UTC day

CREATE TABLE IF NOT EXISTS public.intel_rwa_coverage_assets (
  provider text NOT NULL CHECK (provider = 'coinmarketcap'),
  snapshot_date date NOT NULL,
  rwa_id text NOT NULL CHECK (rwa_id ~ '^[1-9][0-9]{0,11}$'),
  symbol text CHECK (symbol IS NULL OR length(symbol) BETWEEN 1 AND 50),
  name text CHECK (name IS NULL OR length(name) BETWEEN 1 AND 200),
  asset_type text CHECK (asset_type IS NULL OR length(asset_type) BETWEEN 1 AND 40),
  rwa_rank integer CHECK (rwa_rank IS NULL OR rwa_rank >= 0),
  -- NULL on a not_returned row: we do not know, and NULL never stands in for a measured zero.
  token_count integer CHECK (token_count IS NULL OR token_count >= 0),
  priced_count integer CHECK (priced_count IS NULL OR priced_count >= 0),
  traded_count integer CHECK (traded_count IS NULL OR traded_count >= 0),
  coverage_state text NOT NULL CHECK (coverage_state IN ('tradeable','priced_not_traded','listed_only','no_tokens_reported','not_returned')),
  not_returned_reason text CHECK (not_returned_reason IS NULL OR length(not_returned_reason) <= 120),
  tokenized_market_cap numeric CHECK (tokenized_market_cap IS NULL OR tokenized_market_cap >= 0),
  tokenized_volume_24h numeric CHECK (tokenized_volume_24h IS NULL OR tokenized_volume_24h >= 0),
  -- The provider's own quote clock. Never ours.
  source_observed_at timestamptz,
  -- OUR clock: when the run asked.
  captured_at timestamptz NOT NULL,
  fetched_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, rwa_id, snapshot_date),
  CONSTRAINT intel_rwa_coverage_assets_not_returned CHECK (
    (coverage_state = 'not_returned' AND not_returned_reason IS NOT NULL AND token_count IS NULL AND priced_count IS NULL AND traded_count IS NULL)
    OR (coverage_state <> 'not_returned' AND not_returned_reason IS NULL AND token_count IS NOT NULL AND priced_count IS NOT NULL AND traded_count IS NOT NULL)),
  CONSTRAINT intel_rwa_coverage_assets_counts CHECK (
    token_count IS NULL OR (traded_count <= priced_count AND priced_count <= token_count)),
  CONSTRAINT intel_rwa_coverage_assets_no_tokens CHECK (
    coverage_state <> 'no_tokens_reported' OR token_count = 0),
  CONSTRAINT intel_rwa_coverage_assets_finite CHECK (coalesce(1e30 >= ALL (ARRAY[
    abs(tokenized_market_cap), abs(tokenized_volume_24h)]), true))
);
-- Newest-day reads and retention sweep by date across every asset.
CREATE INDEX IF NOT EXISTS intel_rwa_coverage_assets_date_idx ON public.intel_rwa_coverage_assets (snapshot_date DESC, rwa_id);
CREATE INDEX IF NOT EXISTS intel_rwa_coverage_assets_captured_idx ON public.intel_rwa_coverage_assets (captured_at DESC);
ALTER TABLE public.intel_rwa_coverage_assets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_rwa_coverage_assets FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_rwa_coverage_assets TO service_role;

-- SECTION 2: one row per token per asset per UTC day

CREATE TABLE IF NOT EXISTS public.intel_rwa_coverage_tokens (
  provider text NOT NULL CHECK (provider = 'coinmarketcap'),
  snapshot_date date NOT NULL,
  rwa_id text NOT NULL CHECK (rwa_id ~ '^[1-9][0-9]{0,11}$'),
  crypto_id text NOT NULL CHECK (crypto_id ~ '^[1-9][0-9]{0,11}$'),
  -- Denormalised from the asset so the concentration view groups by type without a join.
  asset_type text CHECK (asset_type IS NULL OR length(asset_type) BETWEEN 1 AND 40),
  symbol text CHECK (symbol IS NULL OR length(symbol) BETWEEN 1 AND 50),
  name text CHECK (name IS NULL OR length(name) BETWEEN 1 AND 200),
  -- As the provider reports it on the token. Never given a synthetic value.
  issuer_id text CHECK (issuer_id IS NULL OR length(issuer_id) BETWEEN 1 AND 100),
  issuer_name text CHECK (issuer_name IS NULL OR length(issuer_name) BETWEEN 1 AND 200),
  price numeric CHECK (price IS NULL OR price > 0),
  market_cap numeric CHECK (market_cap IS NULL OR market_cap >= 0),
  volume_24h numeric CHECK (volume_24h IS NULL OR volume_24h >= 0),
  token_state text NOT NULL CHECK (token_state IN ('tradeable','priced_not_traded','listed_only')),
  captured_at timestamptz NOT NULL,
  fetched_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, rwa_id, crypto_id, snapshot_date),
  -- The state follows from the figures, so a row cannot claim trading it does not report.
  CONSTRAINT intel_rwa_coverage_tokens_state CHECK (
    (token_state = 'listed_only' AND price IS NULL)
    OR (token_state = 'priced_not_traded' AND price IS NOT NULL AND coalesce(volume_24h, 0) = 0)
    OR (token_state = 'tradeable' AND price IS NOT NULL AND volume_24h > 0)),
  CONSTRAINT intel_rwa_coverage_tokens_finite CHECK (coalesce(1e30 >= ALL (ARRAY[
    abs(price), abs(market_cap), abs(volume_24h)]), true))
);
CREATE INDEX IF NOT EXISTS intel_rwa_coverage_tokens_date_idx ON public.intel_rwa_coverage_tokens (snapshot_date DESC, rwa_id);
CREATE INDEX IF NOT EXISTS intel_rwa_coverage_tokens_symbol_idx ON public.intel_rwa_coverage_tokens (upper(symbol), snapshot_date DESC);
ALTER TABLE public.intel_rwa_coverage_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_rwa_coverage_tokens FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_rwa_coverage_tokens TO service_role;

-- SECTION 3: append-only change events

CREATE TABLE IF NOT EXISTS public.intel_rwa_coverage_changes (
  provider text NOT NULL CHECK (provider = 'coinmarketcap'),
  snapshot_date date NOT NULL,
  previous_snapshot_date date NOT NULL,
  rwa_id text NOT NULL CHECK (rwa_id ~ '^[1-9][0-9]{0,11}$'),
  change_kind text NOT NULL CHECK (change_kind IN ('listed','removed','became_tradeable','shelved')),
  from_state text CHECK (from_state IS NULL OR from_state IN ('tradeable','priced_not_traded','listed_only','no_tokens_reported')),
  to_state text CHECK (to_state IS NULL OR to_state IN ('tradeable','priced_not_traded','listed_only','no_tokens_reported')),
  symbol text CHECK (symbol IS NULL OR length(symbol) BETWEEN 1 AND 50),
  name text CHECK (name IS NULL OR length(name) BETWEEN 1 AND 200),
  asset_type text CHECK (asset_type IS NULL OR length(asset_type) BETWEEN 1 AND 40),
  detected_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- One event of a kind per asset per day. A same-day rerun inserts ON CONFLICT DO NOTHING.
  PRIMARY KEY (provider, snapshot_date, rwa_id, change_kind),
  CONSTRAINT intel_rwa_coverage_changes_order CHECK (previous_snapshot_date < snapshot_date),
  CONSTRAINT intel_rwa_coverage_changes_states CHECK (
    (change_kind = 'listed' AND from_state IS NULL AND to_state IS NOT NULL)
    OR (change_kind = 'removed' AND from_state IS NOT NULL AND to_state IS NULL)
    OR (change_kind = 'became_tradeable' AND from_state IS NOT NULL AND from_state <> 'tradeable' AND to_state = 'tradeable')
    OR (change_kind = 'shelved' AND from_state = 'tradeable' AND to_state IS NOT NULL AND to_state <> 'tradeable'))
);
CREATE INDEX IF NOT EXISTS intel_rwa_coverage_changes_date_idx ON public.intel_rwa_coverage_changes (snapshot_date DESC, change_kind);
ALTER TABLE public.intel_rwa_coverage_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_rwa_coverage_changes FROM PUBLIC, anon, authenticated;
-- APPEND-ONLY BY PRIVILEGE: no UPDATE, no DELETE, and retention never touches this table.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.intel_rwa_coverage_changes FROM service_role;
GRANT SELECT, INSERT ON TABLE public.intel_rwa_coverage_changes TO service_role;

-- SECTION 4: the lane's switch and cadence

-- max_credits 15 is the PER-RUN credit ceiling (15 quotes calls of 100 ids, 1 credit each). min_plan NULL: rwaQuotes is
-- available from Basic upward. A later edit to the row wins, so re-running this never resets one.
INSERT INTO public.provider_schedule_policy (provider, feature, cadence_seconds, enabled, min_plan, max_credits, reason) VALUES
  ('coinmarketcap', 'rwa_coverage', 86400, true, NULL, 15,
   'Daily coverage of every tokenised asset the rwaMap lane reports with tokens: quotes/latest in batches of 100 rwa_ids at 1 credit each. Measured 2026-09-22: 791 ids, 8 credits a day. max_credits 15 is the per-run ceiling; ids beyond it are stored as not_returned.')
ON CONFLICT (provider, feature) DO NOTHING;

-- SECTION 5: schedule

-- 03:19 UTC: eight minutes after `intel-capture-rwa-asset-map-daily` at 03:11 refreshes the ids and today's count row
-- this lane reads (the map run took ~10 s on 2026-09-22), and before the 03:29 profiles and 03:34 depth lanes. Minute
-- 19 of hour 3 is used by no other cron job (checked against cron.job, 2026-09-22; 03:21 was rejected because two
-- jobs already fire at :21 every hour). The job is idempotent: rows are keyed on the UTC day and upserted, events are
-- inserted ON CONFLICT DO NOTHING, and the lane skips when its own newest capture is younger than cadence_seconds.

SELECT cron.unschedule('intel-capture-rwa-coverage-daily') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-capture-rwa-coverage-daily');
SELECT cron.schedule('intel-capture-rwa-coverage-daily', '19 3 * * *', $$
  SELECT net.http_post(
    url     := concat((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL'), '/functions/v1/intel-capture'),
    headers := jsonb_build_object('Content-Type','application/json','Authorization', concat('Bearer ', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')), 'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')),
    body    := jsonb_build_object('op','rwa_coverage'), timeout_milliseconds := 110000);
$$);

-- SECTION 6: retention

-- 400 days of asset rows, 180 days of token rows. Change events are KEPT: they are the history this lane exists for,
-- and the table is append-only by privilege. PATCHED into the live definition, never restated.
DO $retention$
DECLARE original text; changed text; block text;
BEGIN
  original := pg_get_functiondef('app_private.intel_capture_retention(timestamptz)'::regprocedure);
  IF position('intel_rwa_coverage_assets' in original) > 0 THEN
    RAISE NOTICE 'RWA coverage retention block already present; leaving the function unchanged.';
    RETURN;
  END IF;
  IF (SELECT count(*) FROM regexp_matches(original, '\n[ \t]*RETURN removed;', 'g')) <> 1 THEN
    RAISE EXCEPTION 'unexpected_retention_definition';
  END IF;
  block :=
       E'  -- Added by 20260922110000 (RWA universe coverage). 180 days of token rows, 400 days of asset rows; change events kept.\n'
    || E'  DELETE FROM public.intel_rwa_coverage_tokens WHERE snapshot_date < (p_now - interval ''180 days'')::date;\n'
    || E'  GET DIAGNOSTICS n = ROW_COUNT;\n'
    || E'  removed := removed || jsonb_build_object(''intel_rwa_coverage_tokens'', n);\n'
    || E'\n'
    || E'  DELETE FROM public.intel_rwa_coverage_assets WHERE snapshot_date < (p_now - interval ''400 days'')::date;\n'
    || E'  GET DIAGNOSTICS n = ROW_COUNT;\n'
    || E'  removed := removed || jsonb_build_object(''intel_rwa_coverage_assets'', n);\n';
  changed := regexp_replace(original, '(\n[ \t]*RETURN removed;)', E'\n' || replace(block, '\', '\\') || E'\\1');
  IF changed = original THEN RAISE EXCEPTION 'unexpected_retention_definition'; END IF;
  EXECUTE changed;
END $retention$;
REVOKE ALL ON FUNCTION app_private.intel_capture_retention(timestamptz) FROM PUBLIC, anon, authenticated;
