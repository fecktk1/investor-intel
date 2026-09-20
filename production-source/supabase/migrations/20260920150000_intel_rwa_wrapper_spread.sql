-- ============================================================
-- Investor Intel: RWA wrapper premium, discount, dispersion and two-endpoint reconciliation
-- ============================================================
-- Two capture tables behind the `rwa_wrappers` view of the `intel-capture` Edge Function, plus the lane's on/off
-- switch, its six-hourly schedule and its retention horizon.
--
--   intel_rwa_wrapper_assets   One row per tokenised underlying asset per capture hour: the ANCHOR and what kind of
--                              anchor it is, the widest premium and discount across that asset's wrappers, the
--                              dispersion between them, the cheapest liquid route into the asset, and the
--                              reconciliation between the asset-level value the LIST endpoint reports and the sum of
--                              what the QUOTES endpoint says the asset's own tokens are worth.
--
--   intel_rwa_wrapper_tokens   One row per wrapper per asset per capture hour: its reported price, the price restated
--                              in the asset's own unit where a unit had to be normalised, its premium in basis points,
--                              and the state that decided whether it could anchor anything.
--
-- WHY THIS IS NOT PART OF THE RWA UNIVERSE TABLES. The universe lane answers "how big is the tokenised market". This
-- answers "the same asset is wrapped five times and the five prices disagree", which needs per-token rows the universe
-- snapshot deliberately does not keep. A new table and a new read view also mean the universe panel and this one can
-- never blank each other.
--
-- ── WHAT ONE RUN COSTS ───────────────────────────────────────────────────────────────────────────────────────────
--   2 database reads    the newest `intel_rwa_universe_snapshots` rows (which asset types report anything, and which
--                       assets the universe lane already ranked) and this lane's own newest capture. 0 credits.
--   <= 4 calls          GET /v5/real-world-assets/assets/list, one per asset type that currently reports any assets,
--                       250 rows sorted by tokenised market cap. ceil(250/250) = 1 credit each. This is ALSO the list
--                       side of the reconciliation, so it is not an extra call.
--   <= 1 call           GET /v5/real-world-assets/map. Documented as costing NO credit; read only when a candidate is
--                       missing from the list pages, to resolve its symbol, name and asset type for free.
--   1 call              GET /v5/real-world-assets/quotes/latest with every candidate rwa_id comma-joined. The set is
--                       capped at 60 ids and the endpoint bills ceil(n/250), so this is exactly 1 credit.
--   Upper bound: 6 calls and 5 CREDITS per run. At four runs a day that is 20 credits a day.
--
-- Measured on 2026-09-20: only `stock`, `commodity` and `etf` return any assets at all, so a typical run makes three
-- list calls and spends 4 credits, or 16 a day.
--
-- `/v5/real-world-assets/market-pairs/list` is Growth tier and is NEVER called. Nothing here scrapes an issuer or a
-- finance site, and no price comes from anywhere but CoinMarketCap and the keyless Chainlink NAV lane.
--
-- ── THE TWO CLOCKS, AND WHY BOTH ENDPOINTS' CLOCKS ARE STORED ────────────────────────────────────────────────────
--   `captured_at`        is the hour WE asked, floored by a CHECK the lane cannot talk its way around. Flooring is
--                        what makes a retried or double-clicked run inside one hour land on the same primary key.
--   `source_observed_at` is the provider's own USD quote clock for the QUOTES read.
--   `list_observed_at`   is the same thing for the LIST read, and `list_captured_at` is the hour we made it.
-- The reconciliation's whole subject is that two reads of one provider disagree, so a row that carries the comparison
-- has to carry both clocks or the reader cannot tell a disagreement from a time difference.
--
-- ── WHAT THE SCHEMA ITSELF REFUSES TO ALLOW ──────────────────────────────────────────────────────────────────────
--   * A premium may not exist without an anchor. `intel_rwa_wrapper_assets_anchor` makes an anchor of kind 'none'
--     carrying a price impossible, and every derived figure is gated on the anchor price being present.
--   * An anchor of kind 'none' always states its reason, so "no premium" is never an unexplained blank.
--   * A NAV anchor carries the feed key that produced it, and a feed key never appears beside any other anchor kind.
--     A row cannot claim a published net asset value without naming the feed.
--   * A WRAPPER may carry a premium OR an accrual gap, never both, and an accruing wrapper may not carry a premium at
--     all: `intel_rwa_wrapper_tokens_accrual` rejects it. A token that accrues its yield inside its price drifts away
--     from its peers forever, and storing that as a premium would publish a permanent arbitrage that does not exist.
--   * A wrapper whose unit could not be established carries NO normalised price and NO premium. The database refuses
--     the combination rather than trusting the code not to produce it.
--   * Only a wrapper in the 'liquid' state may be marked as part of the anchor.
--   * A wrapper in any state other than 'liquid' always says why.
--   * A reconciliation ratio exists only where both sides do and the list side is non-zero. A list value of exactly 0
--     beside a positive token sum is a REAL observation (Silver carried `tokenized_market_cap: 0` beside $265,523 of
--     24-hour volume on 2026-09-14), so it is stored as 0 with `reconcile_reason = 'list_endpoint_reports_zero'` and
--     no ratio. Dividing by the provider's zero is not the finding; the zero is.
--   * Exactly zero is a real answer everywhere on these tables and is stored as zero. That is why every figure column
--     is nullable: NULL means we do not know, and it never stands in for a measured zero.
--
-- Numeric columns reject NaN and +/-Infinity through `1e30 >= ALL (ARRAY[abs(...)])`: NaN and Infinity both compare
-- greater than 1e30, an all-NULL array yields NULL and coalesce lets it pass. Same guard as the neighbouring capture
-- tables.
--
-- ── NO FOREIGN KEY FROM THE WRAPPER ROWS TO THE ASSET ROW, ON PURPOSE ────────────────────────────────────────────
-- The lane writes the WRAPPERS first and the ASSET row second, because the cadence guard reads the asset table: a
-- partial write must not be able to make the next run believe the hour was already captured before the evidence
-- behind it landed. A foreign key would invert that order and reintroduce exactly that failure.
--
-- ── TIER ─────────────────────────────────────────────────────────────────────────────────────────────────────────
-- Nothing to add. The read is served through the existing `capture_views` surface, which `intel_surface_tiers` already
-- carries at `free` / `precomputed_shared` (20260916114500). That is correct here: these rows are written once by a
-- scheduled lane and read by everyone, so opening the page spends no provider credit whoever opens it.
--
-- ── RETENTION ────────────────────────────────────────────────────────────────────────────────────────────────────
-- 400 days, matching the neighbouring RWA lanes, PATCHED into the live `app_private.intel_capture_retention` rather
-- than restated (a restatement would silently drop the blocks other migrations spliced into the live definition).
-- At the ceiling that is four runs a day x 60 assets = 240 asset rows and roughly 1,000 wrapper rows a day, so about
-- 100,000 and 400,000 rows respectively at the horizon. The splice carries the same two guards as its siblings: it
-- returns without touching anything when its block is already present, and it refuses to run at all if the live
-- function does not contain exactly one `RETURN removed;` to anchor against.
--
-- IDEMPOTENT. Tables and indexes are guarded with IF NOT EXISTS, the policy row is ON CONFLICT DO NOTHING, the cron
-- job is unscheduled by name before it is scheduled, and the retention splice checks for its own block first. Safe to
-- apply more than once. Validated offline with pglast. NOT APPLIED by this change.
--
-- ROLLBACK
--   -- stop the lane, keep the data (the view then reads retained captures and never refreshes):
--   SELECT cron.unschedule('intel-capture-rwa-wrappers-6h');
--   UPDATE public.provider_schedule_policy SET enabled = false WHERE provider = 'coinmarketcap' AND feature = 'rwa_wrappers';
--   -- drop the data too:
--   DROP TABLE public.intel_rwa_wrapper_tokens;
--   DROP TABLE public.intel_rwa_wrapper_assets;
--   DELETE FROM public.provider_schedule_policy WHERE provider = 'coinmarketcap' AND feature = 'rwa_wrappers';
--   -- and remove the block this migration inserted into app_private.intel_capture_retention (otherwise the nightly
--   -- job errors on its next run against the dropped tables):
--   --   DO $r$ DECLARE original text; BEGIN
--   --     original := pg_get_functiondef('app_private.intel_capture_retention(timestamptz)'::regprocedure);
--   --     EXECUTE regexp_replace(original, '\n[ \t]*-- Added by 20260920150000.*?intel_rwa_wrapper_assets''[^\n]*\n', E'\n', 'ns');
--   --   END $r$;
-- ============================================================

SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- SECTION 1: one row per underlying asset per capture hour

CREATE TABLE IF NOT EXISTS public.intel_rwa_wrapper_assets (
  provider text NOT NULL CHECK (provider = 'coinmarketcap'),
  -- CoinMarketCap's RWA id, which is NOT a crypto id and NOT an issuer id.
  rwa_id text NOT NULL CHECK (rwa_id ~ '^[1-9][0-9]{0,11}$'),
  -- OUR clock, floored to the hour. `date_trunc(text, timestamp)` is immutable; the timezone round trip keeps the
  -- expression immutable and anchored to UTC, so the constraint holds whatever the session TimeZone happens to be.
  captured_at timestamptz NOT NULL CHECK (captured_at = date_trunc('hour', captured_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
  symbol text CHECK (symbol IS NULL OR length(symbol) BETWEEN 1 AND 50),
  name text CHECK (name IS NULL OR length(name) BETWEEN 1 AND 200),
  asset_type text CHECK (asset_type IS NULL OR length(asset_type) BETWEEN 1 AND 40),
  rwa_rank integer CHECK (rwa_rank IS NULL OR rwa_rank > 0),

  -- ── the anchor, and what kind of anchor it is ──
  -- 'published_nav' is the fund's own net asset value, read on chain by the keyless rwa_yield lane and independent of
  -- every wrapper on the row. 'liquid_wrapper_median' is derived FROM the wrappers and is labelled as such on the
  -- surface. 'none' means no anchor could be established, and then no premium is reported for any wrapper.
  anchor_kind text NOT NULL CHECK (anchor_kind IN ('published_nav', 'liquid_wrapper_median', 'none')),
  anchor_price numeric CHECK (anchor_price IS NULL OR anchor_price > 0),
  anchor_feed_key text CHECK (anchor_feed_key IS NULL OR anchor_feed_key ~ '^[a-z][a-z0-9_]{0,40}$'),
  -- The aggregator's round clock for a NAV anchor, or the provider's quote clock for a wrapper median. Never ours.
  anchor_observed_at timestamptz,
  anchor_reason text CHECK (anchor_reason IS NULL OR length(anchor_reason) <= 120),
  -- How many wrappers went into the anchor. Exactly 1 for a published NAV: the fund itself.
  anchor_members integer NOT NULL DEFAULT 0 CHECK (anchor_members >= 0),

  -- ── the wrappers, counted by state ──
  wrapper_count integer NOT NULL DEFAULT 0 CHECK (wrapper_count >= 0),
  liquid_count integer NOT NULL DEFAULT 0 CHECK (liquid_count >= 0),
  thin_count integer NOT NULL DEFAULT 0 CHECK (thin_count >= 0),
  accrual_count integer NOT NULL DEFAULT 0 CHECK (accrual_count >= 0),
  unit_normalised_count integer NOT NULL DEFAULT 0 CHECK (unit_normalised_count >= 0),
  unit_refused_count integer NOT NULL DEFAULT 0 CHECK (unit_refused_count >= 0),
  -- Whether the underlying is denominated by WEIGHT, which is the only case in which a 31x price gap is a unit rather
  -- than a different instrument. Recorded on the row so the unit fix is auditable after the fact.
  weight_denominated boolean NOT NULL DEFAULT false,
  -- The floor this run applied, stored so a figure can be reproduced after the constant changes.
  volume_floor_usd numeric NOT NULL CHECK (volume_floor_usd >= 0),

  -- ── the figures, all in basis points of the anchor ──
  widest_premium_bps numeric,
  widest_premium_crypto_id text CHECK (widest_premium_crypto_id IS NULL OR widest_premium_crypto_id ~ '^[1-9][0-9]{0,11}$'),
  widest_discount_bps numeric,
  widest_discount_crypto_id text CHECK (widest_discount_crypto_id IS NULL OR widest_discount_crypto_id ~ '^[1-9][0-9]{0,11}$'),
  -- Highest minus lowest anchor-eligible price. A range is never negative.
  dispersion_bps numeric CHECK (dispersion_bps IS NULL OR dispersion_bps >= 0),
  -- Volume-weighted mean absolute deviation from the anchor, so a dead quote contributes nothing to it.
  weighted_spread_bps numeric CHECK (weighted_spread_bps IS NULL OR weighted_spread_bps >= 0),
  cheapest_crypto_id text CHECK (cheapest_crypto_id IS NULL OR cheapest_crypto_id ~ '^[1-9][0-9]{0,11}$'),
  cheapest_premium_bps numeric,

  -- ── the QUOTES endpoint's own asset-level figures ──
  average_tokenized_price numeric CHECK (average_tokenized_price IS NULL OR average_tokenized_price > 0),
  tokenized_market_cap numeric CHECK (tokenized_market_cap IS NULL OR tokenized_market_cap >= 0),
  tokenized_volume_24h numeric CHECK (tokenized_volume_24h IS NULL OR tokenized_volume_24h >= 0),
  source_observed_at timestamptz,

  -- ── the LIST endpoint, and the reconciliation between the two ──
  list_tokenized_market_cap numeric CHECK (list_tokenized_market_cap IS NULL OR list_tokenized_market_cap >= 0),
  list_tokenized_volume_24h numeric CHECK (list_tokenized_volume_24h IS NULL OR list_tokenized_volume_24h >= 0),
  list_average_tokenized_price numeric CHECK (list_average_tokenized_price IS NULL OR list_average_tokenized_price > 0),
  list_captured_at timestamptz,
  list_observed_at timestamptz,
  token_market_cap_sum numeric CHECK (token_market_cap_sum IS NULL OR token_market_cap_sum >= 0),
  token_market_cap_reported integer NOT NULL DEFAULT 0 CHECK (token_market_cap_reported >= 0),
  reconcile_state text NOT NULL CHECK (reconcile_state IN ('agree', 'outside_band', 'not_comparable')),
  reconcile_ratio numeric CHECK (reconcile_ratio IS NULL OR reconcile_ratio >= 0),
  reconcile_gap_usd numeric,
  reconcile_reason text CHECK (reconcile_reason IS NULL OR length(reconcile_reason) <= 120),
  -- The band this run judged against, stored beside the verdict so a later change to it cannot silently rewrite
  -- history.
  reconcile_band_low numeric NOT NULL CHECK (reconcile_band_low > 0),
  reconcile_band_high numeric NOT NULL,

  fetched_at timestamptz NOT NULL,
  -- What a premium is NOT. Restated on every row on purpose: a row exported on its own must carry it too.
  scope text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, rwa_id, captured_at),

  CONSTRAINT intel_rwa_wrapper_assets_band CHECK (reconcile_band_high > reconcile_band_low),
  -- An anchor kind and an anchor price travel together, or neither is present.
  CONSTRAINT intel_rwa_wrapper_assets_anchor CHECK (
    (anchor_kind = 'none' AND anchor_price IS NULL) OR (anchor_kind <> 'none' AND anchor_price IS NOT NULL)),
  -- No anchor always says why.
  CONSTRAINT intel_rwa_wrapper_assets_anchor_reason CHECK (anchor_kind <> 'none' OR anchor_reason IS NOT NULL),
  -- A published net asset value names the feed it came from, and a feed key never appears beside any other kind.
  CONSTRAINT intel_rwa_wrapper_assets_anchor_feed CHECK (
    (anchor_kind = 'published_nav' AND anchor_feed_key IS NOT NULL)
    OR (anchor_kind <> 'published_nav' AND anchor_feed_key IS NULL)),
  -- Every derived figure requires the anchor it was measured against.
  CONSTRAINT intel_rwa_wrapper_assets_derived CHECK (
    anchor_price IS NOT NULL OR (
      widest_premium_bps IS NULL AND widest_premium_crypto_id IS NULL
      AND widest_discount_bps IS NULL AND widest_discount_crypto_id IS NULL
      AND dispersion_bps IS NULL AND weighted_spread_bps IS NULL
      AND cheapest_crypto_id IS NULL AND cheapest_premium_bps IS NULL)),
  -- A figure and the wrapper it belongs to travel together.
  CONSTRAINT intel_rwa_wrapper_assets_cheapest CHECK (
    (cheapest_crypto_id IS NULL) = (cheapest_premium_bps IS NULL)),
  CONSTRAINT intel_rwa_wrapper_assets_widest CHECK (
    (widest_premium_crypto_id IS NULL) = (widest_premium_bps IS NULL)
    AND (widest_discount_crypto_id IS NULL) = (widest_discount_bps IS NULL)),
  -- A sum exists exactly when at least one wrapper reported a value. An asset where none did has no sum, which the
  -- reconciliation reads as "not comparable" rather than as a disagreement with zero.
  CONSTRAINT intel_rwa_wrapper_assets_token_sum CHECK (
    (token_market_cap_reported = 0 AND token_market_cap_sum IS NULL)
    OR (token_market_cap_reported > 0 AND token_market_cap_sum IS NOT NULL)),
  -- A ratio needs both sides, and a non-zero denominator.
  CONSTRAINT intel_rwa_wrapper_assets_ratio CHECK (
    reconcile_ratio IS NULL
    OR (list_tokenized_market_cap IS NOT NULL AND list_tokenized_market_cap > 0 AND token_market_cap_sum IS NOT NULL)),
  -- Agreement carries no reason; anything else always does.
  CONSTRAINT intel_rwa_wrapper_assets_reconcile_reason CHECK (
    (reconcile_state = 'agree' AND reconcile_reason IS NULL)
    OR (reconcile_state <> 'agree' AND reconcile_reason IS NOT NULL)),
  CONSTRAINT intel_rwa_wrapper_assets_finite CHECK (coalesce(1e30 >= ALL (ARRAY[
    abs(anchor_price), abs(widest_premium_bps), abs(widest_discount_bps), abs(dispersion_bps),
    abs(weighted_spread_bps), abs(cheapest_premium_bps), abs(average_tokenized_price), abs(tokenized_market_cap),
    abs(tokenized_volume_24h), abs(list_tokenized_market_cap), abs(list_tokenized_volume_24h),
    abs(list_average_tokenized_price), abs(token_market_cap_sum), abs(reconcile_ratio), abs(reconcile_gap_usd),
    abs(volume_floor_usd)]), true))
);
-- The asset + window reads are served by the primary key's leading columns. This index serves the newest-hour read and
-- retention, both of which sweep by capture time across every asset.
CREATE INDEX IF NOT EXISTS intel_rwa_wrapper_assets_captured_idx ON public.intel_rwa_wrapper_assets (captured_at DESC);
ALTER TABLE public.intel_rwa_wrapper_assets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_rwa_wrapper_assets FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_rwa_wrapper_assets TO service_role;

-- SECTION 2: one row per wrapper per asset per capture hour

CREATE TABLE IF NOT EXISTS public.intel_rwa_wrapper_tokens (
  provider text NOT NULL CHECK (provider = 'coinmarketcap'),
  rwa_id text NOT NULL CHECK (rwa_id ~ '^[1-9][0-9]{0,11}$'),
  -- The CoinMarketCap CRYPTO id of the wrapper token, which is what links it to the catalogue and to the asset page.
  crypto_id text NOT NULL CHECK (crypto_id ~ '^[1-9][0-9]{0,11}$'),
  captured_at timestamptz NOT NULL CHECK (captured_at = date_trunc('hour', captured_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
  symbol text CHECK (symbol IS NULL OR length(symbol) BETWEEN 1 AND 50),
  name text CHECK (name IS NULL OR length(name) BETWEEN 1 AND 200),
  -- The issuer as the provider reports it on the token. A token with no reported issuer stays NULL and is never given
  -- a synthetic one.
  issuer_id text CHECK (issuer_id IS NULL OR length(issuer_id) BETWEEN 1 AND 100),
  issuer_name text CHECK (issuer_name IS NULL OR length(issuer_name) BETWEEN 1 AND 200),

  -- As reported, in whatever unit the wrapper uses.
  price numeric CHECK (price IS NULL OR price > 0),
  -- The same price restated in the asset's own unit. Equal to `price` where no normalisation was needed.
  normalised_price numeric CHECK (normalised_price IS NULL OR normalised_price > 0),
  market_cap numeric CHECK (market_cap IS NULL OR market_cap >= 0),
  volume_24h numeric CHECK (volume_24h IS NULL OR volume_24h >= 0),

  -- 'normalised_troy_ounce' means the wrapper was priced per GRAM and was multiplied up; 'normalised_gram' is the
  -- mirror case. 'not_established' means the price matched no known unit and no premium is reported for it.
  unit_state text NOT NULL CHECK (unit_state IN ('consistent', 'normalised_troy_ounce', 'normalised_gram', 'not_established', 'not_assessed')),
  unit_factor numeric CHECK (unit_factor IS NULL OR unit_factor > 0),

  -- 'too_thin_to_anchor' is SHOWN, not hidden: it is excluded from the anchor only.
  wrapper_state text NOT NULL CHECK (wrapper_state IN (
    'liquid', 'too_thin_to_anchor', 'volume_not_reported', 'no_price', 'unit_not_established', 'accrues_in_price')),
  premium_bps numeric,
  -- A wrapper that accrues its yield inside its price carries its gap HERE and never in premium_bps.
  accrual_gap_bps numeric,
  in_anchor boolean NOT NULL DEFAULT false,
  state_reason text CHECK (state_reason IS NULL OR length(state_reason) <= 120),
  fetched_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, rwa_id, crypto_id, captured_at),

  -- THE ACCRUAL RULE. A token whose price accrues its return climbs away from its peers forever, so it may never be
  -- stored as a premium. This is what makes a permanent invented arbitrage impossible, not merely avoided in code.
  CONSTRAINT intel_rwa_wrapper_tokens_accrual CHECK (
    (premium_bps IS NULL OR accrual_gap_bps IS NULL)
    AND (wrapper_state <> 'accrues_in_price' OR premium_bps IS NULL)
    AND (accrual_gap_bps IS NULL OR wrapper_state = 'accrues_in_price')),
  -- No price means no derived figure of any kind.
  CONSTRAINT intel_rwa_wrapper_tokens_price CHECK (
    price IS NOT NULL OR (normalised_price IS NULL AND premium_bps IS NULL AND accrual_gap_bps IS NULL)),
  -- THE UNIT RULE. A wrapper whose unit could not be established carries neither a restated price nor a premium.
  CONSTRAINT intel_rwa_wrapper_tokens_unit CHECK (
    unit_state <> 'not_established' OR (normalised_price IS NULL AND premium_bps IS NULL AND accrual_gap_bps IS NULL)),
  CONSTRAINT intel_rwa_wrapper_tokens_unit_state CHECK (
    (wrapper_state = 'unit_not_established') = (unit_state = 'not_established')),
  -- Only a liquid wrapper may be part of the anchor.
  CONSTRAINT intel_rwa_wrapper_tokens_anchor CHECK (in_anchor = false OR wrapper_state = 'liquid'),
  -- Any state other than 'liquid' always says why.
  CONSTRAINT intel_rwa_wrapper_tokens_reason CHECK (wrapper_state = 'liquid' OR state_reason IS NOT NULL),
  CONSTRAINT intel_rwa_wrapper_tokens_finite CHECK (coalesce(1e30 >= ALL (ARRAY[
    abs(price), abs(normalised_price), abs(market_cap), abs(volume_24h),
    abs(unit_factor), abs(premium_bps), abs(accrual_gap_bps)]), true))
);
-- The read filters on the newest capture hour and then on the assets of that hour, which is exactly this order.
CREATE INDEX IF NOT EXISTS intel_rwa_wrapper_tokens_captured_idx ON public.intel_rwa_wrapper_tokens (captured_at DESC, rwa_id);
ALTER TABLE public.intel_rwa_wrapper_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_rwa_wrapper_tokens FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_rwa_wrapper_tokens TO service_role;

-- SECTION 3: the lane's on/off switch and its cadence

-- provider 'coinmarketcap', because this lane DOES spend CoinMarketCap credits, so it belongs to the same policy set
-- the shared `loadSchedulePolicy` reads. `enabled = false` stops the lane and leaves the view reading retained
-- captures. A later edit to the row wins, so re-running this never resets one.
-- cadence_seconds 21600  six hours, matching the cron below. A premium between two wrappers of one asset moves on the
--                        same clock as the underlying, so four reads a day is the picture; hourly would spend four
--                        times the credits for the same answer.
-- min_plan NULL          every capability this lane uses is available from Basic upward, so there is nothing to gate.
-- max_credits 5          the lane's PER-RUN credit ceiling, which is also its documented upper bound.
INSERT INTO public.provider_schedule_policy (provider, feature, cadence_seconds, enabled, min_plan, max_credits, reason) VALUES
  ('coinmarketcap', 'rwa_wrappers', 21600, true, NULL, 5,
   'Six-hourly wrapper premium, dispersion and two-endpoint reconciliation for a bounded set of tokenised assets. Upper bound 6 calls and 5 credits per run (up to 4 assets/list pages at 1 credit each, 1 free map read, 1 quotes/latest read carrying up to 60 rwa_ids for 1 credit), so 20 credits a day. Never calls market-pairs/list, which is Growth tier.')
ON CONFLICT (provider, feature) DO NOTHING;

-- SECTION 4: schedule

-- Minute 47 of hours 2, 8, 14 and 20 UTC: forty minutes after `intel-capture-hourly` at :07 writes the RWA universe
-- row this lane reads its candidate set from, so the candidates are never an hour stale. Minute 47 is otherwise unused
-- by any `intel-capture` job (checked against cron.job, 2026-09-20), and the six-hourly RWA yield lane sits at :29 of
-- hours 1, 7, 13 and 19, so the two RWA lanes never start in the same minute.
-- The job is idempotent: rows are keyed on the capture hour and upserted, and the lane additionally skips when its own
-- newest capture is younger than cadence_seconds in provider_schedule_policy.

SELECT cron.unschedule('intel-capture-rwa-wrappers-6h') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'intel-capture-rwa-wrappers-6h');
SELECT cron.schedule('intel-capture-rwa-wrappers-6h', '47 2,8,14,20 * * *', $$
  SELECT net.http_post(
    url     := concat((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_URL'), '/functions/v1/intel-capture'),
    headers := jsonb_build_object('Content-Type','application/json','Authorization', concat('Bearer ', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY')), 'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')),
    body    := jsonb_build_object('op','rwa_wrappers'), timeout_milliseconds := 110000);
$$);

-- SECTION 5: retention

-- 400 days on both tables, PATCHED into the live definition (see the header for why this is not a restatement).
DO $retention$
DECLARE original text; changed text; block text;
BEGIN
  original := pg_get_functiondef('app_private.intel_capture_retention(timestamptz)'::regprocedure);
  -- Already spliced: return without touching anything rather than adding the same DELETE blocks twice.
  IF position('intel_rwa_wrapper_assets' in original) > 0 THEN
    RAISE NOTICE 'RWA wrapper retention block already present; leaving the function unchanged.';
    RETURN;
  END IF;
  -- Exactly one `RETURN removed;` is what makes the insertion point unambiguous. Any other count means the function is
  -- not the one this migration was written against, and guessing at a second anchor is how a lane's horizon gets lost.
  IF (SELECT count(*) FROM regexp_matches(original, '\n[ \t]*RETURN removed;', 'g')) <> 1 THEN
    RAISE EXCEPTION 'unexpected_retention_definition';
  END IF;
  block :=
       E'  -- Added by 20260920150000 (RWA wrapper spread). 400 days of six-hourly wrapper and asset rows.\n'
    || E'  DELETE FROM public.intel_rwa_wrapper_tokens WHERE captured_at < p_now - interval ''400 days'';\n'
    || E'  GET DIAGNOSTICS n = ROW_COUNT;\n'
    || E'  removed := removed || jsonb_build_object(''intel_rwa_wrapper_tokens'', n);\n'
    || E'\n'
    || E'  DELETE FROM public.intel_rwa_wrapper_assets WHERE captured_at < p_now - interval ''400 days'';\n'
    || E'  GET DIAGNOSTICS n = ROW_COUNT;\n'
    || E'  removed := removed || jsonb_build_object(''intel_rwa_wrapper_assets'', n);\n';
  changed := regexp_replace(original, '(\n[ \t]*RETURN removed;)', E'\n' || replace(block, '\', '\\') || E'\\1');
  IF changed = original THEN RAISE EXCEPTION 'unexpected_retention_definition'; END IF;
  EXECUTE changed;
END $retention$;
REVOKE ALL ON FUNCTION app_private.intel_capture_retention(timestamptz) FROM PUBLIC, anon, authenticated;
