-- ============================================================
-- Investor Intel — holder tags and cohort PnL (CMC plan proposal 20)
-- ============================================================
-- Two new capture tables behind the `holder_tags` view of the `intel-research` Edge Function. No cron job, no alert
-- arm, no new RPC: capture is ON DEMAND from the contract workspace and bounded at nine provider calls per hour per
-- contract.
--
--   intel_holder_tag_snapshots     CoinMarketCap's holder TAG BOARD for one contract at one capture hour: for each of
--                                  the (currently eight) tags the provider classifies, the holder count it reports,
--                                  the tagged balance and the holding ratio. One row per tag per capture.
--
--   intel_holder_cohort_snapshots  One PAGE of at most fifty ADDRESSES per tag at that same capture hour, with the
--                                  balance, percent, buy and sell volume and realized gain the provider reported for
--                                  each. One row per address per tag per capture.
--
-- Both are service-role only, exactly like every other capture table: reads go through `intel-research`
-- `{capability:'dexContext', params:{view:'holder_tags'}}`, never through PostgREST.
--
-- THE CLOCK IS OURS, AND THE SCHEMA SAYS SO.
--   `/v1/dex/holders/tag_count` and `/v1/dex/holders/list` publish NO observation time. The provider never states when
--   a classification, a balance or a realized gain was computed. `captured_at` is therefore the hour WE asked,
--   truncated to the hour by a CHECK constraint that the capture lane cannot talk its way around. It is a capture
--   time, not a provider observation time, and no read, chart or export may present it as one. Flooring is also what
--   makes a retried or double-clicked refresh inside one hour land on the same primary key instead of inventing a
--   second "measurement" of an unchanged board.
--
-- WHAT A COHORT ROW IS, AND IS NOT.
--   It is one address the provider returned on the FIRST page for one tag, with the figures the provider attached to
--   it. The `lastId` cursor is deliberately not followed, so the stored cohort is never "every holder" and the read
--   view says so in its own words. An address is an address: no ENS name, no exchange label, no social handle, no
--   clustering, no ownership claim. CMC's tags are CMC's labels for addresses — `tag_kol`, `tag_dev` and
--   `tag_insider` classify an address, they do not describe a human being, and there is no column here in which one
--   could be named.
--
-- OTHER HONESTY RULES THE SCHEMA ENFORCES:
--   * A figure we could not read is NULL. Zero is a real answer and is stored as zero; it never stands in for
--     "unknown". That is why `holder_count`, `balance`, `ratio` and `realized_pnl_usd` are all nullable.
--   * `ratio_unit` defaults to 'unknown' because the provider does not state whether `hr` is a fraction or a percent.
--     The number is stored as reported and is never relabelled. 'fraction' and 'percent' are accepted so a future
--     documented probe can record the answer without a schema change.
--   * `realized_pnl_usd` is the one signed money column: a loss is a measurement, not an error.
--   * `first_seen_at` / `last_seen_at` are the provider's two activity stamps, stored as reported. They are NOT
--     observation times for the balance or the realized gain, and no constraint orders them: the provider controls
--     what it sends and one odd pair must not reject a whole capture.
--   * The tag regex admits any `tag_*` label the provider may add, so a ninth classification is a code change, not a
--     migration. It cannot admit free text.
--
-- Numeric columns reject NaN and +/-Infinity through `1e30 >= ALL (ARRAY[abs(...)])`: NaN and Infinity both compare
-- greater than 1e30, an all-NULL array yields NULL and coalesce lets it pass.
--
-- Credits per refresh (upper bound; a fresh shared cache costs 0):
--   1 x dexHolderTags + 1 x dexHolders for each tag whose reported holder count is above zero = at most 9.
-- `dexHolderTags` is a Startup capability; below Startup the view answers `plan_below_startup` and spends nothing,
-- the way `newListings` is skipped below Startup and `network_stats` below Growth.
--
-- Retention: 180 days on both tables, added to app_private.intel_capture_retention below, which stays pg_cron only.
-- The function is restated IN FULL from its newest definition — 20260915030000_intel_new_listing_capture, which is
-- itself a restatement of 20260915014404_intel_display_currency — because a CREATE OR REPLACE is the whole function:
-- a lost DELETE block means that lane's table grows without bound. This migration's timestamp is later than
-- 20260915030000, so this version is the one that survives, and it carries that migration's new-listing block. Every
-- block for a lane that may be absent in an environment (categories, FX, new listings) is guarded with `to_regclass`;
-- this migration's own two blocks are unguarded, their tables having just been created. If a LATER capture lane
-- restates this function again, it must carry the two intel_holder_* blocks below.
--
-- Safe to apply anytime; idempotent. There is nothing to schedule and no live function body to patch.
--
-- ROLLBACK
--   -- stop the lane, keep the data (the view then answers with retained captures only and never refreshes):
--   UPDATE public.provider_schedule_policy SET enabled = false WHERE provider = 'coinmarketcap' AND feature = 'holder_tags';
--   -- drop the data too:
--   DROP TABLE public.intel_holder_cohort_snapshots;
--   DROP TABLE public.intel_holder_tag_snapshots;
--   DELETE FROM public.provider_schedule_policy WHERE provider = 'coinmarketcap' AND feature = 'holder_tags';
--   -- then restore app_private.intel_capture_retention from 20260915030000_intel_new_listing_capture.sql
--   -- (otherwise the nightly job errors on its next run against the dropped tables).
--   -- Retained `holder_tag_count` observations in intel_market_observations are untouched by this rollback; they
--   -- expire on their own retain_until, and `CMC_CONTRACT_METRICS` simply stops listing the metric.
-- ============================================================

SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- SECTION: holder tag capture tables

-- 1. The tag board. One row per provider tag per capture hour, for one exact contract.
-- Only CoinMarketCap writes here, so there is no provider column to disagree with: a second provider would be a
-- different classification vocabulary and therefore a different table.
CREATE TABLE public.intel_holder_tag_snapshots (
  -- CAIP-style chain, restricted to the shapes the four verified CMC DEX networks use (ethereum, base, arbitrum, solana).
  chain text NOT NULL CHECK (chain ~ '^(eip155:[1-9][0-9]*|solana)$'),
  contract_address text NOT NULL CHECK (contract_address ~ '^(0x[0-9a-f]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$'),
  -- OUR clock, floored to the hour. `date_trunc(text, timestamp)` is immutable; the timezone round-trip keeps the
  -- expression immutable and anchored to UTC, so the constraint holds whatever the session TimeZone happens to be.
  captured_at timestamptz NOT NULL CHECK (captured_at = date_trunc('hour', captured_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
  tag text NOT NULL CHECK (tag ~ '^tag_[a-z][a-z0-9_]{0,40}$'),
  -- A count we could not read is NULL. Zero is a real answer and is stored as zero.
  holder_count bigint CHECK (holder_count IS NULL OR holder_count >= 0),
  balance numeric CHECK (balance IS NULL OR balance >= 0),
  ratio numeric CHECK (ratio IS NULL OR ratio >= 0),
  -- The provider states no unit for the holding ratio. 'unknown' is the honest default and the only value the lane writes.
  ratio_unit text NOT NULL DEFAULT 'unknown' CHECK (ratio_unit IN ('unknown', 'fraction', 'percent')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain, contract_address, captured_at, tag),
  CONSTRAINT intel_holder_tag_snapshots_finite CHECK (coalesce(1e30 >= ALL (ARRAY[abs(balance), abs(ratio)]), true))
);
-- The contract + window reads are served by the primary key's leading columns. This index exists for retention,
-- which sweeps by capture time across every contract.
CREATE INDEX intel_holder_tag_snapshots_captured_idx ON public.intel_holder_tag_snapshots (captured_at);
ALTER TABLE public.intel_holder_tag_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_holder_tag_snapshots FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_holder_tag_snapshots TO service_role;

-- 2. The cohort. One row per address per tag per capture hour: the first page the provider returned, nothing more.
CREATE TABLE public.intel_holder_cohort_snapshots (
  chain text NOT NULL CHECK (chain ~ '^(eip155:[1-9][0-9]*|solana)$'),
  contract_address text NOT NULL CHECK (contract_address ~ '^(0x[0-9a-f]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$'),
  captured_at timestamptz NOT NULL CHECK (captured_at = date_trunc('hour', captured_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
  tag text NOT NULL CHECK (tag ~ '^tag_[a-z][a-z0-9_]{0,40}$'),
  -- An ADDRESS. There is deliberately no column in this table for a name, a label, a handle or an entity.
  wallet_address text NOT NULL CHECK (wallet_address ~ '^(0x[0-9a-f]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$'),
  balance numeric CHECK (balance IS NULL OR balance >= 0),
  -- Provider-reported share. Its unit is the provider's; it is not re-scaled here and is not bounded at 100.
  percent numeric CHECK (percent IS NULL OR percent >= 0),
  buy_volume_usd numeric CHECK (buy_volume_usd IS NULL OR buy_volume_usd >= 0),
  sell_volume_usd numeric CHECK (sell_volume_usd IS NULL OR sell_volume_usd >= 0),
  -- Signed on purpose: a realized loss is a measurement. NULL means the provider did not report one, which is not
  -- break-even and is never binned as one.
  realized_pnl_usd numeric,
  -- The provider's own funding-route string. It names a route, never a person, and nothing resolves it to an identity.
  funding_source text CHECK (funding_source IS NULL OR length(funding_source) <= 120),
  -- The provider's two activity stamps, as reported. They do not date the balance or the realized gain.
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain, contract_address, captured_at, tag, wallet_address),
  CONSTRAINT intel_holder_cohort_snapshots_finite CHECK (coalesce(1e30 >= ALL (ARRAY[
    abs(balance), abs(percent), abs(buy_volume_usd), abs(sell_volume_usd), abs(realized_pnl_usd)]), true))
);
CREATE INDEX intel_holder_cohort_snapshots_captured_idx ON public.intel_holder_cohort_snapshots (captured_at);
ALTER TABLE public.intel_holder_cohort_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_holder_cohort_snapshots FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_holder_cohort_snapshots TO service_role;

-- 3. The lane's on/off switch. There is NO cron schedule for holder tags: the capture runs when a member opens the
-- contract workspace and asks for it, and skips inside its own hour. `cadence_seconds` is recorded as the hour the
-- lane already enforces, so an operator reading the policy table sees the real cadence; `enabled = false` stops the
-- lane and leaves the view reading retained captures. A later edit to a row wins, so re-running this never resets one.
INSERT INTO public.provider_schedule_policy (provider, feature, cadence_seconds, enabled, min_plan, reason) VALUES
  ('coinmarketcap', 'holder_tags', 3600, true, 'startup', 'On demand from the contract workspace; no cron schedule.')
ON CONFLICT (provider, feature) DO NOTHING;

-- 4. Retention, restated in full from 20260915030000 to add the two holder tables at 180 days.
-- 180 days is twice the widest window the read offers (90 days) — enough to compare a tag board against the quarter
-- before it without retaining a year of hourly rows nothing reads.
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

  -- From the category capture lane, carried so this restatement does not drop it. Guarded because that lane may not
  -- be present in every environment.
  IF to_regclass('public.intel_category_snapshots') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.intel_category_snapshots WHERE captured_at < $1 - interval ''90 days''' USING p_now;
    GET DIAGNOSTICS n = ROW_COUNT;
    removed := removed || jsonb_build_object('intel_category_snapshots', n);
  END IF;

  IF to_regclass('public.intel_category_members') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.intel_category_members WHERE snapshot_date < ($1 - interval ''400 days'')::date' USING p_now;
    GET DIAGNOSTICS n = ROW_COUNT;
    removed := removed || jsonb_build_object('intel_category_members', n);
  END IF;

  DELETE FROM public.market_asset_demand_daily WHERE day < (p_now - interval '400 days')::date;
  GET DIAGNOSTICS n = ROW_COUNT;
  removed := removed || jsonb_build_object('market_asset_demand_daily', n);

  -- From the display-currency lane (20260915014404), carried for the same reason and guarded the same way.
  IF to_regclass('public.intel_fx_rates') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.intel_fx_rates WHERE captured_at < $1 - interval ''400 days''' USING p_now;
    GET DIAGNOSTICS n = ROW_COUNT;
    removed := removed || jsonb_build_object('intel_fx_rates', n);
  END IF;

  -- From the new-listing lane (20260915030000), carried for the same reason. Guarded here, where it was unguarded in
  -- that migration, because this function must survive in an environment that has not applied that lane.
  IF to_regclass('public.intel_new_listing_snapshots') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.intel_new_listing_snapshots WHERE snapshot_date < ($1 - interval ''180 days'')::date' USING p_now;
    GET DIAGNOSTICS n = ROW_COUNT;
    removed := removed || jsonb_build_object('intel_new_listing_snapshots', n);
  END IF;

  -- Added here: hourly holder tag boards and their address cohorts. 180 days is twice the widest read window.
  -- The cohort goes first: it is the larger table and the one whose rows are addresses.
  DELETE FROM public.intel_holder_cohort_snapshots WHERE captured_at < p_now - interval '180 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  removed := removed || jsonb_build_object('intel_holder_cohort_snapshots', n);

  DELETE FROM public.intel_holder_tag_snapshots WHERE captured_at < p_now - interval '180 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  removed := removed || jsonb_build_object('intel_holder_tag_snapshots', n);

  RETURN removed;
END $$;
REVOKE ALL ON FUNCTION app_private.intel_capture_retention(timestamptz) FROM PUBLIC, anon, authenticated;
