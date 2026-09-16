-- ============================================================
-- Investor Intel: RWA Yield Provenance Engine and NAV Integrity Monitor
-- ============================================================
-- Three capture tables behind the `rwa_yield` view of the `intel-capture` Edge Function, plus the lane's on/off switch
-- and its retention horizon.
--
--   intel_rwa_nav_observations   One row per REGISTERED NAV feed per capture hour: whether the feed could be proved on
--                                chain, and if so the net asset value, the round that carried it, the aggregator's own
--                                clock and how that clock compares to the feed's published heartbeat.
--
--   intel_rwa_yield_snapshots    One row per feed per capture hour carrying all three sides of the comparison: the
--                                ADVERTISED yield (where a fund files one), the REALIZED yield computed from the NAV
--                                series, and the BENCHMARK rate for the actual underlying instrument.
--
--   intel_benchmark_rates        The published reference rates themselves, one row per benchmark per observation date.
--
-- NO PROVIDER CREDITS ARE SPENT BY THIS LANE. Every source is keyless, free and redistributable: Chainlink NAV read
-- over a public Ethereum RPC, the US Treasury (public domain), the New York Fed (SOFR), the ECB (ESTR) and SEC EDGAR
-- (public domain). Nothing from DeFiLlama is stored, whose terms grant only a personal, non-commercial licence, and
-- nothing from FRED, which forbids redistribution. That is why the provider on the policy row below is 'chainlink' and
-- not 'coinmarketcap'.
--
-- THE TWO CLOCKS, AND WHY BOTH EXIST.
--   `captured_at` is the hour WE asked, floored by a CHECK constraint the lane cannot talk its way around. Flooring is
--   what makes a retried or double-clicked run inside one hour land on the same primary key instead of inventing a
--   second measurement of an unchanged feed.
--   `nav_observed_at` is the AGGREGATOR's own `updatedAt` for the round. It dates the published NAV. It is not our
--   capture time and no read, chart or export may present it as one.
--
-- WHAT THE SCHEMA ITSELF REFUSES TO ALLOW:
--   * A benchmark may only ever sit beside a fund of the SAME currency. `intel_rwa_yield_snapshots_benchmark_currency`
--     makes a euro fund against a US Treasury bill impossible to store, not merely discouraged in code. Getting this
--     wrong is worse than not shipping the comparison, so it is enforced here as well as in the register.
--   * A realized yield may carry a NUMBER only when its state is 'published'. `intel_rwa_yield_snapshots_realized`
--     rejects a row that pairs a figure with 'review_declining', so a falling NAV can never be written as a negative
--     yield headline. A NAV that falls may be a distribution or a credit loss and free data cannot tell them apart;
--     the honest answer is a state and a NULL, routed to human review.
--   * A spread exists only where both of its sides do.
--   * Exactly zero is a real answer and is stored as zero. That is why every figure column is nullable: NULL means we
--     do not know, and it never stands in for a measured zero. A stable-NAV fund really did return 0 percent of NAV
--     growth, and `total_return_limit` on every row says why that is not the same as returning nothing.
--
-- Numeric columns reject NaN and +/-Infinity through `1e30 >= ALL (ARRAY[abs(...)])`: NaN and Infinity both compare
-- greater than 1e30, an all-NULL array yields NULL and coalesce lets it pass. This is the same guard the neighbouring
-- capture tables use.
--
-- Retention: 400 days, PATCHED into the live `app_private.intel_capture_retention` rather than restated. The newest
-- FULL restatement of that function is 20260915034326_intel_holder_tags, but 20260915171001_intel_chart_working_state
-- then spliced its own block into the live definition the same way this migration does. A full restatement here would
-- therefore silently drop the chart working state block and let that table grow without bound. The splice below is
-- copied from that migration, including its two guards: it returns without touching anything when its block is already
-- present, and it refuses to run at all if the live function does not contain exactly one `RETURN removed;` to anchor
-- against.
--
-- APPLY ONCE. This file is NOT idempotent: the three CREATE TABLE statements and their CREATE INDEX statements are
-- unguarded, so a second application fails on `intel_rwa_nav_observations` already existing. Only the retention splice
-- is separately re-runnable. (Guarding the tables with IF NOT EXISTS would not make the file re-runnable, because the
-- indexes would still fail, and it would let a pre-existing table of a DIFFERENT shape pass silently - which for
-- tables carrying these constraints is worse than the error.) There is nothing to schedule: the lane runs from the
-- existing capture op.
--
-- ROLLBACK
--   -- stop the lane, keep the data (the view then reads retained captures and never refreshes):
--   UPDATE public.provider_schedule_policy SET enabled = false WHERE provider = 'chainlink' AND feature = 'rwa_yield';
--   -- drop the data too:
--   DROP TABLE public.intel_rwa_yield_snapshots;
--   DROP TABLE public.intel_rwa_nav_observations;
--   DROP TABLE public.intel_benchmark_rates;
--   DELETE FROM public.provider_schedule_policy WHERE provider = 'chainlink' AND feature = 'rwa_yield';
--   -- and remove the block this migration inserted into app_private.intel_capture_retention (otherwise the nightly
--   -- job errors on its next run against the dropped tables):
--   --   DO $r$ DECLARE original text; BEGIN
--   --     original := pg_get_functiondef('app_private.intel_capture_retention(timestamptz)'::regprocedure);
--   --     EXECUTE regexp_replace(original, '\n[ \t]*-- Added by 20260916120000.*?intel_benchmark_rates''[^\n]*\n', E'\n', 'ns');
--   --   END $r$;
-- ============================================================

SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- SECTION: NAV observations

CREATE TABLE public.intel_rwa_nav_observations (
  -- The register's stable slug for this feed, not a provider id: the register is what decides which feeds exist.
  feed_key text NOT NULL CHECK (feed_key ~ '^[a-z][a-z0-9_]{0,40}$'),
  -- OUR clock, floored to the hour. `date_trunc(text, timestamp)` is immutable; the timezone round trip keeps the
  -- expression immutable and anchored to UTC, so the constraint holds whatever the session TimeZone happens to be.
  captured_at timestamptz NOT NULL CHECK (captured_at = date_trunc('hour', captured_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
  -- The name the register expects, which must equal the feed's on-chain description() for the row to be validated.
  feed_name text NOT NULL CHECK (length(feed_name) BETWEEN 1 AND 120),
  contract_address text NOT NULL CHECK (contract_address ~ '^0x[0-9a-f]{40}$'),
  -- 'validated' means description() and decimals() both agreed and a positive NAV was read. Anything else is 'refused'
  -- and carries its reason; a refused feed is still a ROW, because an absent feed reads as a feed with nothing wrong.
  validation_state text NOT NULL CHECK (validation_state IN ('validated', 'refused')),
  validation_reason text CHECK (validation_reason IS NULL OR length(validation_reason) <= 120),
  -- What the CHAIN said, kept even on a refusal so the disagreement is reviewable rather than merely asserted.
  on_chain_description text CHECK (on_chain_description IS NULL OR length(on_chain_description) <= 200),
  -- A NAV we could not read stays NULL. It is never a zero.
  nav numeric CHECK (nav IS NULL OR nav > 0),
  nav_decimals smallint CHECK (nav_decimals IS NULL OR (nav_decimals >= 0 AND nav_decimals <= 36)),
  -- The AGGREGATOR's clock for the round. Not our capture time.
  nav_observed_at timestamptz,
  -- Phase-encoded and far beyond a bigint's comfortable range in practice, so it is stored as the decimal string the
  -- contract returned rather than being narrowed into a number type.
  round_id text CHECK (round_id IS NULL OR round_id ~ '^[0-9]{1,80}$'),
  -- The feed's OWN published heartbeat, which is the only defensible staleness bound we have.
  heartbeat_seconds integer CHECK (heartbeat_seconds IS NULL OR heartbeat_seconds > 0),
  age_seconds bigint,
  -- 'unknown' is deliberately distinct from 'fresh': a feed with no readable clock has not been shown to be healthy.
  staleness text NOT NULL DEFAULT 'unknown' CHECK (staleness IN ('fresh', 'stale', 'unknown')),
  rounds_read integer NOT NULL DEFAULT 0 CHECK (rounds_read >= 0),
  -- The directory's named reserve auditor, kept verbatim as provenance.
  por_auditor text CHECK (por_auditor IS NULL OR length(por_auditor) <= 120),
  source_url text NOT NULL,
  fetched_at timestamptz NOT NULL,
  -- What this figure does NOT mean, and what its clock does mean. Every stored figure carries both.
  scope text NOT NULL,
  time_meaning text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (feed_key, captured_at),
  -- A validated row has to actually carry the evidence that validated it.
  CONSTRAINT intel_rwa_nav_observations_validated CHECK (
    validation_state <> 'validated' OR (nav IS NOT NULL AND nav_observed_at IS NOT NULL AND on_chain_description IS NOT NULL)),
  CONSTRAINT intel_rwa_nav_observations_refused CHECK (validation_state <> 'refused' OR validation_reason IS NOT NULL),
  CONSTRAINT intel_rwa_nav_observations_finite CHECK (coalesce(1e30 >= ALL (ARRAY[abs(nav), abs(age_seconds)]), true))
);
-- The feed + window reads are served by the primary key's leading column. This index exists for retention, which
-- sweeps by capture time across every feed.
CREATE INDEX intel_rwa_nav_observations_captured_idx ON public.intel_rwa_nav_observations (captured_at);
ALTER TABLE public.intel_rwa_nav_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_rwa_nav_observations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_rwa_nav_observations TO service_role;

-- SECTION: yield snapshots

CREATE TABLE public.intel_rwa_yield_snapshots (
  feed_key text NOT NULL CHECK (feed_key ~ '^[a-z][a-z0-9_]{0,40}$'),
  captured_at timestamptz NOT NULL CHECK (captured_at = date_trunc('hour', captured_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
  -- The fund's denomination. The register admits only these two today; a fund reporting in anything else is not
  -- registered, because we hold no benchmark for it.
  currency text NOT NULL CHECK (currency IN ('USD', 'EUR')),
  instrument_class text NOT NULL CHECK (instrument_class IN ('treasury_bill', 'money_market', 'floating_credit', 'private_credit', 'unclassified')),

  -- ── realized, computed from the NAV series ──
  realized_state text NOT NULL CHECK (realized_state IN (
    'published', 'review_declining', 'review_implausible', 'insufficient_history', 'stale_feed')),
  realized_annualized_pct numeric,
  realized_window_days numeric CHECK (realized_window_days IS NULL OR realized_window_days >= 0),
  realized_rounds integer NOT NULL DEFAULT 0 CHECK (realized_rounds >= 0),
  realized_declines integer NOT NULL DEFAULT 0 CHECK (realized_declines >= 0),
  realized_largest_decline_pct numeric CHECK (realized_largest_decline_pct IS NULL OR realized_largest_decline_pct >= 0),
  realized_reason text CHECK (realized_reason IS NULL OR length(realized_reason) <= 120),
  first_nav numeric CHECK (first_nav IS NULL OR first_nav > 0),
  last_nav numeric CHECK (last_nav IS NULL OR last_nav > 0),
  first_at timestamptz,
  last_at timestamptz,

  -- ── advertised, from the issuer's own filing ──
  advertised_pct numeric,
  -- The date the FUND stated the figure for, which is not the date it filed and not our capture date.
  advertised_observed_at date,
  advertised_source_url text,
  advertised_reason text CHECK (advertised_reason IS NULL OR length(advertised_reason) <= 120),

  -- ── benchmark, the actual underlying instrument ──
  benchmark_key text CHECK (benchmark_key IS NULL OR benchmark_key IN ('us_treasury_bill_3m', 'us_treasury_bill_avg', 'sofr', 'estr')),
  benchmark_pct numeric,
  benchmark_observed_at date,
  benchmark_currency text CHECK (benchmark_currency IS NULL OR benchmark_currency IN ('USD', 'EUR')),
  benchmark_reason text CHECK (benchmark_reason IS NULL OR length(benchmark_reason) <= 120),

  spread_pct numeric,
  fetched_at timestamptz NOT NULL,
  scope text NOT NULL,
  -- Restated on every row on purpose: it is the limitation the whole surface rests on, and a row exported on its own
  -- must carry it too.
  total_return_limit text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (feed_key, captured_at),

  -- A NUMBER may only accompany a publishable state. This is what makes it impossible to store a falling NAV as a
  -- negative yield: 'review_declining' with a figure is rejected by the database, not merely avoided in code.
  CONSTRAINT intel_rwa_yield_snapshots_realized CHECK (
    (realized_state = 'published' AND realized_annualized_pct IS NOT NULL)
    OR (realized_state <> 'published' AND realized_annualized_pct IS NULL)),
  -- A state that is not published always says why.
  CONSTRAINT intel_rwa_yield_snapshots_reason CHECK (realized_state = 'published' OR realized_reason IS NOT NULL),
  -- THE CURRENCY RULE. A benchmark may only sit beside a fund of its own currency.
  CONSTRAINT intel_rwa_yield_snapshots_benchmark_currency CHECK (
    benchmark_key IS NULL OR (benchmark_currency IS NOT NULL AND benchmark_currency = currency)),
  -- A benchmark figure and its key travel together, or neither is present.
  CONSTRAINT intel_rwa_yield_snapshots_benchmark CHECK (
    (benchmark_key IS NOT NULL AND benchmark_pct IS NOT NULL AND benchmark_observed_at IS NOT NULL)
    OR (benchmark_key IS NULL AND benchmark_pct IS NULL)),
  -- A spread exists only where both of its sides do.
  CONSTRAINT intel_rwa_yield_snapshots_spread CHECK (
    (spread_pct IS NULL) OR (realized_annualized_pct IS NOT NULL AND benchmark_pct IS NOT NULL)),
  -- An advertised figure carries its own date, or it is not stored.
  CONSTRAINT intel_rwa_yield_snapshots_advertised CHECK (
    advertised_pct IS NULL OR advertised_observed_at IS NOT NULL),
  CONSTRAINT intel_rwa_yield_snapshots_finite CHECK (coalesce(1e30 >= ALL (ARRAY[
    abs(realized_annualized_pct), abs(realized_window_days), abs(realized_largest_decline_pct),
    abs(first_nav), abs(last_nav), abs(advertised_pct), abs(benchmark_pct), abs(spread_pct)]), true))
);
CREATE INDEX intel_rwa_yield_snapshots_captured_idx ON public.intel_rwa_yield_snapshots (captured_at);
ALTER TABLE public.intel_rwa_yield_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_rwa_yield_snapshots FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_rwa_yield_snapshots TO service_role;

-- SECTION: benchmark reference rates

-- Keyed on the PUBLISHER's observation date, not on our capture hour: the same rate read twice in one day is one fact,
-- and re-reading it must not create a second row claiming to be a second observation.
CREATE TABLE public.intel_benchmark_rates (
  benchmark_key text NOT NULL CHECK (benchmark_key IN ('us_treasury_bill_3m', 'us_treasury_bill_avg', 'sofr', 'estr')),
  observed_at date NOT NULL,
  rate_pct numeric NOT NULL,
  currency text NOT NULL CHECK (currency IN ('USD', 'EUR')),
  source_url text NOT NULL,
  -- What this particular series' clock means. The average rate on outstanding bills and a constant-maturity market
  -- yield are different quantities and their rows say so in their own words.
  time_meaning text NOT NULL,
  -- Small publisher context kept verbatim (neighbouring tenors, percentiles, volume).
  detail jsonb,
  fetched_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (benchmark_key, observed_at),
  CONSTRAINT intel_benchmark_rates_finite CHECK (coalesce(1e30 >= ALL (ARRAY[abs(rate_pct)]), true))
);
CREATE INDEX intel_benchmark_rates_observed_idx ON public.intel_benchmark_rates (observed_at);
ALTER TABLE public.intel_benchmark_rates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_benchmark_rates FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_benchmark_rates TO service_role;

-- SECTION: the lane's on/off switch

-- Hourly, which is the cadence the lane already enforces through its own hour bucket. `enabled = false` stops the lane
-- and leaves the view reading retained captures. A later edit to a row wins, so re-running this never resets one.
-- `min_plan` is NULL on purpose: this lane spends no provider credits, so there is nothing to gate on a plan.
INSERT INTO public.provider_schedule_policy (provider, feature, cadence_seconds, enabled, min_plan, reason) VALUES
  ('chainlink', 'rwa_yield', 3600, true, NULL, 'Keyless NAV, Treasury, New York Fed, ECB and EDGAR reads; no provider credits.')
ON CONFLICT (provider, feature) DO NOTHING;

-- SECTION: retention

-- 400 days on all three tables, PATCHED into the live definition (see the header for why this is not a restatement).
DO $retention$
DECLARE original text; changed text; block text;
BEGIN
  original := pg_get_functiondef('app_private.intel_capture_retention(timestamptz)'::regprocedure);
  -- Already spliced: return without touching anything rather than adding the same DELETE blocks twice. This matches
  -- 20260916104500 and 20260916150000, so all three splices behave alike on a re-splice. It used to RAISE, which meant
  -- a replay of a partially completed deploy aborted here while the other two lanes replayed harmlessly - an
  -- inconsistency with no upside, since a block that is already in place is precisely the state this wants.
  IF position('intel_rwa_nav_observations' in original) > 0 THEN
    RAISE NOTICE 'RWA yield retention block already present; leaving the function unchanged.';
    RETURN;
  END IF;
  -- Exactly one `RETURN removed;` is what makes the insertion point unambiguous. Any other count means the function is
  -- not the one this migration was written against, and guessing at a second anchor is how a lane's horizon gets lost.
  IF (SELECT count(*) FROM regexp_matches(original, '\n[ \t]*RETURN removed;', 'g')) <> 1 THEN
    RAISE EXCEPTION 'unexpected_retention_definition';
  END IF;
  block :=
       E'  -- Added by 20260916120000 (RWA yield provenance). 400 days of hourly NAV, yield and benchmark rows.\n'
    || E'  DELETE FROM public.intel_rwa_yield_snapshots WHERE captured_at < p_now - interval ''400 days'';\n'
    || E'  GET DIAGNOSTICS n = ROW_COUNT;\n'
    || E'  removed := removed || jsonb_build_object(''intel_rwa_yield_snapshots'', n);\n'
    || E'\n'
    || E'  DELETE FROM public.intel_rwa_nav_observations WHERE captured_at < p_now - interval ''400 days'';\n'
    || E'  GET DIAGNOSTICS n = ROW_COUNT;\n'
    || E'  removed := removed || jsonb_build_object(''intel_rwa_nav_observations'', n);\n'
    || E'\n'
    || E'  DELETE FROM public.intel_benchmark_rates WHERE observed_at < (p_now - interval ''400 days'')::date;\n'
    || E'  GET DIAGNOSTICS n = ROW_COUNT;\n'
    || E'  removed := removed || jsonb_build_object(''intel_benchmark_rates'', n);\n';
  changed := regexp_replace(original, '(\n[ \t]*RETURN removed;)', E'\n' || replace(block, '\', '\\') || E'\\1');
  IF changed = original THEN RAISE EXCEPTION 'unexpected_retention_definition'; END IF;
  EXECUTE changed;
END $retention$;
REVOKE ALL ON FUNCTION app_private.intel_capture_retention(timestamptz) FROM PUBLIC, anon, authenticated;
