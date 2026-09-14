-- Capture tables for the CoinMarketCap-backed provider intelligence in Investor Intel: market regime, rank history,
-- the RWA universe, index constituents, liquidations, exchange reserves, venue share, attention lists, airdrops and
-- network stats, plus the per-provider schedule policy and the asset demand ledger that records which assets are in use.
-- Every table is service-role only: reads go through Edge Functions, never through PostgREST as anon or authenticated,
-- so RLS is enabled with no policy and the grants Supabase hands new public tables are revoked.
-- Retention and the liquidation thinning run in pg_cron. A PostgREST RPC is cancelled after 8 seconds and a pg_cron
-- statement inherits the 2-minute default statement_timeout, so the job sets its own timeout first.

-- Numeric columns reject NaN and +/-Infinity through `1e30 >= ALL (ARRAY[abs(...)])`: NaN and Infinity both compare
-- greater than 1e30, an all-NULL array yields NULL and coalesce lets it pass.

-- 1. Market regime, hourly. One row per provider per capture.
CREATE TABLE public.intel_regime_snapshots (
  provider text NOT NULL DEFAULT 'coinmarketcap',
  captured_at timestamptz NOT NULL,
  fear_greed_value numeric,
  fear_greed_class text,
  altcoin_season_index numeric,
  btc_dominance numeric,
  eth_dominance numeric,
  total_market_cap numeric,
  total_volume_24h numeric,
  stablecoin_market_cap numeric,
  defi_market_cap numeric,
  source_observed_at timestamptz,
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, captured_at),
  CONSTRAINT intel_regime_snapshots_finite CHECK (coalesce(1e30 >= ALL (ARRAY[
    abs(fear_greed_value), abs(altcoin_season_index), abs(btc_dominance), abs(eth_dominance),
    abs(total_market_cap), abs(total_volume_24h), abs(stablecoin_market_cap), abs(defi_market_cap)]), true))
);
CREATE INDEX intel_regime_snapshots_captured_idx ON public.intel_regime_snapshots (captured_at DESC);
ALTER TABLE public.intel_regime_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_regime_snapshots FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_regime_snapshots TO service_role;

-- 2. Daily rank and size history, one row per provider asset per day. The weekly backfill writes 'listings_historical',
-- the daily delta writes 'listings_latest'.
CREATE TABLE public.intel_rank_history (
  provider text NOT NULL DEFAULT 'coinmarketcap',
  snapshot_date date NOT NULL,
  provider_id text NOT NULL,
  symbol text,
  name text,
  rank integer CHECK (rank IS NULL OR rank > 0),
  price numeric,
  market_cap numeric,
  volume_24h numeric,
  circulating_supply numeric,
  total_supply numeric,
  max_supply numeric,
  num_market_pairs integer CHECK (num_market_pairs IS NULL OR num_market_pairs >= 0),
  change_24h_pct numeric,
  change_7d_pct numeric,
  source text CHECK (source IN ('listings_historical', 'listings_latest')),
  observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, snapshot_date, provider_id),
  CONSTRAINT intel_rank_history_finite CHECK (coalesce(1e30 >= ALL (ARRAY[
    abs(price), abs(market_cap), abs(volume_24h), abs(circulating_supply), abs(total_supply), abs(max_supply),
    abs(change_24h_pct), abs(change_7d_pct)]), true))
);
CREATE INDEX intel_rank_history_asset_idx ON public.intel_rank_history (provider, provider_id, snapshot_date DESC);
CREATE INDEX intel_rank_history_date_idx ON public.intel_rank_history (snapshot_date DESC);
ALTER TABLE public.intel_rank_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_rank_history FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_rank_history TO service_role;

-- 3. Tokenised real-world asset universe, one row per asset type per capture ('all' is the whole universe).
CREATE TABLE public.intel_rwa_universe_snapshots (
  provider text NOT NULL DEFAULT 'coinmarketcap',
  asset_type text NOT NULL CHECK (asset_type IN (
    'stock', 'commodity', 'currency', 'government_security', 'etf', 'real_estate', 'all')),
  captured_at timestamptz NOT NULL,
  asset_count integer CHECK (asset_count IS NULL OR asset_count >= 0),
  issuer_count integer CHECK (issuer_count IS NULL OR issuer_count >= 0),
  total_market_value_usd numeric,
  volume_24h_usd numeric,
  change_24h_pct numeric,
  top_assets jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, asset_type, captured_at),
  CONSTRAINT intel_rwa_universe_snapshots_finite CHECK (coalesce(1e30 >= ALL (ARRAY[
    abs(total_market_value_usd), abs(volume_24h_usd), abs(change_24h_pct)]), true))
);
CREATE INDEX intel_rwa_universe_snapshots_captured_idx ON public.intel_rwa_universe_snapshots (captured_at DESC);
ALTER TABLE public.intel_rwa_universe_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_rwa_universe_snapshots FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_rwa_universe_snapshots TO service_role;

-- 4. CMC100 and CMC20 index level with the constituent weights of that capture.
CREATE TABLE public.intel_index_constituent_snapshots (
  index_code text NOT NULL CHECK (index_code IN ('cmc100', 'cmc20')),
  captured_at timestamptz NOT NULL,
  index_value numeric,
  value_24h_pct numeric,
  constituents jsonb NOT NULL CHECK (jsonb_typeof(constituents) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (index_code, captured_at),
  CONSTRAINT intel_index_constituent_snapshots_finite CHECK (coalesce(1e30 >= ALL (ARRAY[
    abs(index_value), abs(value_24h_pct)]), true))
);
CREATE INDEX intel_index_constituent_snapshots_captured_idx ON public.intel_index_constituent_snapshots (captured_at DESC);
ALTER TABLE public.intel_index_constituent_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_index_constituent_snapshots FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_index_constituent_snapshots TO service_role;

-- 5. Liquidations for the covered derivatives universe, captured every 5 minutes for up to 250 assets.
CREATE TABLE public.intel_liquidation_snapshots (
  provider_id text NOT NULL,
  captured_at timestamptz NOT NULL,
  symbol text,
  liq_1h numeric,
  liq_4h numeric,
  liq_24h numeric,
  long_1h numeric,
  short_1h numeric,
  long_24h numeric,
  short_24h numeric,
  universe text NOT NULL DEFAULT 'covered_derivatives',
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, captured_at),
  CONSTRAINT intel_liquidation_snapshots_finite CHECK (coalesce(1e30 >= ALL (ARRAY[
    abs(liq_1h), abs(liq_4h), abs(liq_24h), abs(long_1h), abs(short_1h), abs(long_24h), abs(short_24h)]), true))
);
CREATE INDEX intel_liquidation_snapshots_captured_idx ON public.intel_liquidation_snapshots (captured_at DESC);
ALTER TABLE public.intel_liquidation_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_liquidation_snapshots FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_liquidation_snapshots TO service_role;

-- 6. Exchange asset reserves, one row per exchange per asset per day. An asset can be held on several platforms, so
-- the natural key folds a missing platform symbol into '' instead of leaving a NULL out of the unique index.
CREATE TABLE public.intel_exchange_reserve_snapshots (
  exchange_id integer NOT NULL,
  snapshot_date date NOT NULL,
  provider_id text NOT NULL,
  platform_symbol text,
  exchange_slug text,
  symbol text,
  balance numeric,
  usd_value numeric,
  wallet_count integer CHECK (wallet_count IS NULL OR wallet_count >= 0),
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT intel_exchange_reserve_snapshots_finite CHECK (coalesce(1e30 >= ALL (ARRAY[
    abs(balance), abs(usd_value)]), true))
);
CREATE UNIQUE INDEX intel_exchange_reserve_snapshots_key_idx
  ON public.intel_exchange_reserve_snapshots (exchange_id, snapshot_date, provider_id, coalesce(platform_symbol, ''));
CREATE INDEX intel_exchange_reserve_snapshots_date_idx ON public.intel_exchange_reserve_snapshots (snapshot_date DESC);
ALTER TABLE public.intel_exchange_reserve_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_exchange_reserve_snapshots FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_exchange_reserve_snapshots TO service_role;

-- 7. Venue share, one row per venue per kind per day.
CREATE TABLE public.intel_venue_share_snapshots (
  kind text NOT NULL CHECK (kind IN ('spot', 'derivatives')),
  exchange_id integer NOT NULL,
  snapshot_date date NOT NULL,
  exchange_slug text,
  volume_24h numeric,
  open_interest numeric,
  num_market_pairs integer CHECK (num_market_pairs IS NULL OR num_market_pairs >= 0),
  observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, exchange_id, snapshot_date),
  CONSTRAINT intel_venue_share_snapshots_finite CHECK (coalesce(1e30 >= ALL (ARRAY[
    abs(volume_24h), abs(open_interest)]), true))
);
CREATE INDEX intel_venue_share_snapshots_date_idx ON public.intel_venue_share_snapshots (snapshot_date DESC);
ALTER TABLE public.intel_venue_share_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_venue_share_snapshots FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_venue_share_snapshots TO service_role;

-- 8. Attention lists. time_period is '' when the list has no period, so it stays part of the natural key.
CREATE TABLE public.intel_attention_snapshots (
  list text NOT NULL CHECK (list IN ('trending', 'most_visited', 'gainers', 'losers')),
  time_period text NOT NULL DEFAULT '',
  captured_at timestamptz NOT NULL,
  provider_id text NOT NULL,
  symbol text,
  rank integer CHECK (rank IS NULL OR rank > 0),
  price numeric,
  volume_24h numeric,
  change_24h_pct numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (list, time_period, captured_at, provider_id),
  CONSTRAINT intel_attention_snapshots_finite CHECK (coalesce(1e30 >= ALL (ARRAY[
    abs(price), abs(volume_24h), abs(change_24h_pct)]), true))
);
CREATE INDEX intel_attention_snapshots_asset_idx ON public.intel_attention_snapshots (provider_id, captured_at DESC);
CREATE INDEX intel_attention_snapshots_captured_idx ON public.intel_attention_snapshots (captured_at DESC);
ALTER TABLE public.intel_attention_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_attention_snapshots FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_attention_snapshots TO service_role;

-- 9. Airdrops are a living list, not a time series: the daily pull upserts last_seen_at and the status.
CREATE TABLE public.intel_airdrop_snapshots (
  airdrop_id text PRIMARY KEY,
  project_name text,
  provider_id text,
  symbol text,
  slug text,
  status text,
  start_date timestamptz,
  end_date timestamptz,
  total_prize numeric,
  winner_count integer CHECK (winner_count IS NULL OR winner_count >= 0),
  link text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT intel_airdrop_snapshots_finite CHECK (coalesce(1e30 >= ALL (ARRAY[abs(total_prize)]), true))
);
CREATE INDEX intel_airdrop_snapshots_seen_idx ON public.intel_airdrop_snapshots (last_seen_at DESC);
CREATE INDEX intel_airdrop_snapshots_asset_idx ON public.intel_airdrop_snapshots (provider_id);
ALTER TABLE public.intel_airdrop_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_airdrop_snapshots FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_airdrop_snapshots TO service_role;

-- 10. Chain network stats, hourly.
CREATE TABLE public.intel_network_stats_snapshots (
  provider_id text NOT NULL,
  captured_at timestamptz NOT NULL,
  symbol text,
  hashrate_24h numeric,
  difficulty numeric,
  tps_24h numeric,
  pending_transactions numeric,
  total_blocks numeric,
  total_transactions numeric,
  block_reward_static numeric,
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, captured_at),
  CONSTRAINT intel_network_stats_snapshots_finite CHECK (coalesce(1e30 >= ALL (ARRAY[
    abs(hashrate_24h), abs(difficulty), abs(tps_24h), abs(pending_transactions), abs(total_blocks),
    abs(total_transactions), abs(block_reward_static)]), true))
);
CREATE INDEX intel_network_stats_snapshots_captured_idx ON public.intel_network_stats_snapshots (captured_at DESC);
ALTER TABLE public.intel_network_stats_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_network_stats_snapshots FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_network_stats_snapshots TO service_role;

-- 11. How often each provider feature may be pulled, and the plan it needs. The workers read this table instead of
-- carrying cadences in code, so a plan change or an incident is one row edit.
CREATE TABLE public.provider_schedule_policy (
  provider text NOT NULL,
  feature text NOT NULL,
  cadence_seconds integer NOT NULL CHECK (cadence_seconds > 0),
  enabled boolean NOT NULL DEFAULT true,
  min_plan text,
  reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, feature)
);
CREATE INDEX provider_schedule_policy_updated_idx ON public.provider_schedule_policy (updated_at DESC);
ALTER TABLE public.provider_schedule_policy ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.provider_schedule_policy FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.provider_schedule_policy TO service_role;

-- Seeds are the starting cadence only. A later edit to a row wins, so re-running this migration never resets one.
INSERT INTO public.provider_schedule_policy (provider, feature, cadence_seconds, min_plan, reason) VALUES
  ('coinmarketcap', 'catalogue', 300, 'basic', 'asset catalogue and identity refresh'),
  ('coinmarketcap', 'quotes', 300, 'basic', 'broad listings and quote refresh'),
  ('coinmarketcap', 'regime', 3600, 'basic', 'fear and greed, altcoin season, global metrics'),
  ('coinmarketcap', 'rwa', 3600, 'basic', 'tokenised real-world asset universe'),
  ('coinmarketcap', 'structure', 300, 'basic', 'market structure, liquidations and index levels'),
  ('coinmarketcap', 'attention', 3600, 'startup', 'trending, most visited, gainers and losers'),
  ('coinmarketcap', 'history', 86400, 'startup', 'historical listings for rank history'),
  ('coinmarketcap', 'metadata', 86400, 'basic', 'asset metadata, links and descriptions'),
  ('coinmarketcap', 'exchange_reserves', 86400, 'basic', 'exchange asset reserves'),
  ('coinmarketcap', 'venue_share', 604800, 'basic', 'spot and derivatives venue share'),
  ('coinmarketcap', 'airdrops', 86400, 'basic', 'airdrop list refresh'),
  ('coinmarketcap', 'network_stats', 3600, 'basic', 'chain hashrate, difficulty and throughput'),
  ('coinmarketcap', 'logo_verify', 86400, 'basic', 'logo and image URL verification')
ON CONFLICT (provider, feature) DO NOTHING;

-- 12. Which assets are in use. The capture workers keep full cadence for an asset while in_use_until is in the future;
-- the daily rollup is what the cost and coverage review reads. The "in use" integration itself is a later change.
CREATE TABLE public.market_asset_demand (
  asset_key text PRIMARY KEY,
  provider text,
  provider_id text,
  first_demanded_at timestamptz NOT NULL DEFAULT now(),
  last_demanded_at timestamptz NOT NULL DEFAULT now(),
  demand_count integer NOT NULL DEFAULT 1 CHECK (demand_count >= 0),
  in_use_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX market_asset_demand_in_use_idx ON public.market_asset_demand (in_use_until);
CREATE INDEX market_asset_demand_last_idx ON public.market_asset_demand (last_demanded_at DESC);
ALTER TABLE public.market_asset_demand ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.market_asset_demand FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.market_asset_demand TO service_role;

CREATE TABLE public.market_asset_demand_daily (
  day date NOT NULL,
  asset_key text NOT NULL,
  demand_count integer NOT NULL DEFAULT 1 CHECK (demand_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, asset_key)
);
CREATE INDEX market_asset_demand_daily_day_idx ON public.market_asset_demand_daily (day DESC);
ALTER TABLE public.market_asset_demand_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.market_asset_demand_daily FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.market_asset_demand_daily TO service_role;

-- One demand for one asset: the ledger row and the day's rollup. in_use_until always moves 24 hours out from now.
CREATE FUNCTION app_private.intel_record_asset_demand(p_asset_key text, p_provider text, p_provider_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_asset_key IS NULL OR length(p_asset_key) = 0 OR length(p_asset_key) > 200 THEN
    RAISE EXCEPTION 'invalid_asset_key';
  END IF;

  INSERT INTO public.market_asset_demand AS d (asset_key, provider, provider_id, in_use_until)
  VALUES (p_asset_key, p_provider, p_provider_id, now() + interval '24 hours')
  ON CONFLICT (asset_key) DO UPDATE SET
    provider = coalesce(excluded.provider, d.provider),
    provider_id = coalesce(excluded.provider_id, d.provider_id),
    last_demanded_at = now(),
    demand_count = d.demand_count + 1,
    in_use_until = greatest(excluded.in_use_until, d.in_use_until);

  INSERT INTO public.market_asset_demand_daily AS r (day, asset_key, demand_count)
  VALUES ((now() AT TIME ZONE 'UTC')::date, p_asset_key, 1)
  ON CONFLICT (day, asset_key) DO UPDATE SET demand_count = r.demand_count + 1;
END $$;
REVOKE ALL ON FUNCTION app_private.intel_record_asset_demand(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_private.intel_record_asset_demand(text, text, text) TO service_role;

-- Liquidations arrive every 5 minutes for up to 250 assets. Snapshots keep that resolution for 7 days, then the first
-- snapshot per asset per UTC hour. Like the ticker thinning, one run covers the week that crossed the 7-day mark, so a
-- missed day is caught up the next day and hours already thinned lose nothing. Rows past 400 days are dropped outright.
CREATE FUNCTION app_private.intel_thin_liquidation_snapshots(p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  thinned integer;
  expired integer;
  window_start timestamptz := date_trunc('hour', p_now - interval '14 days', 'UTC');
  window_end timestamptz := date_trunc('hour', p_now - interval '7 days', 'UTC');
BEGIN
  DELETE FROM public.intel_liquidation_snapshots t
  USING (
    SELECT ranked.provider_id, ranked.captured_at
    FROM (
      SELECT s.provider_id, s.captured_at,
        row_number() OVER (
          PARTITION BY s.provider_id, date_trunc('hour', s.captured_at, 'UTC')
          ORDER BY s.captured_at
        ) AS rank_in_hour
      FROM public.intel_liquidation_snapshots s
      WHERE s.captured_at >= window_start
        AND s.captured_at < window_end
    ) ranked
    WHERE ranked.rank_in_hour > 1
  ) extra
  WHERE t.provider_id = extra.provider_id AND t.captured_at = extra.captured_at;
  GET DIAGNOSTICS thinned = ROW_COUNT;

  DELETE FROM public.intel_liquidation_snapshots WHERE captured_at < p_now - interval '400 days';
  GET DIAGNOSTICS expired = ROW_COUNT;

  RETURN thinned + expired;
END $$;
REVOKE ALL ON FUNCTION app_private.intel_thin_liquidation_snapshots(timestamptz) FROM PUBLIC, anon, authenticated;

-- 13. Retention for every capture table, with the row counts it removed. Deleting a year of 5-minute snapshots takes
-- longer than a PostgREST RPC is allowed to run, so this is pg_cron only and is never exposed to an Edge Function.
CREATE FUNCTION app_private.intel_capture_retention(p_now timestamptz DEFAULT now())
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

  DELETE FROM public.market_asset_demand_daily WHERE day < (p_now - interval '400 days')::date;
  GET DIAGNOSTICS n = ROW_COUNT;
  removed := removed || jsonb_build_object('market_asset_demand_daily', n);

  RETURN removed;
END $$;
REVOKE ALL ON FUNCTION app_private.intel_capture_retention(timestamptz) FROM PUBLIC, anon, authenticated;

-- pg_cron statements on this project are cancelled after 2 minutes unless the job sets its own timeout.
DO $schedule$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'intel-capture-retention-daily';
  PERFORM cron.schedule('intel-capture-retention-daily', '45 3 * * *',
    $job$SET statement_timeout = '30min'; SELECT app_private.intel_capture_retention()$job$);
END
$schedule$;
