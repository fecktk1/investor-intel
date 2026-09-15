-- Observation cadence for the CoinMarketCap broad listings refresh (every 5 minutes, top 1000 in pages of 250).
-- Assets in use keep every pull: the top 100 by market cap rank, assets with a live focus demand in the last
-- 30 minutes, open holdings, watchlist assets, alert rules, open theses and retained cohort members. Other assets
-- keep one listings row per metric and period per UTC hour. TVL listings rows are kept once per asset per UTC day,
-- only when they carry a value (zero included). Rows from every other source are recorded as before.

-- One claim per kept listings bucket. The primary key makes a bucket's first row win, also across concurrent calls.
CREATE TABLE app_private.intel_observation_cadence_claims (
  subject text NOT NULL,
  metric text NOT NULL,
  period_seconds text NOT NULL,
  bucket timestamptz NOT NULL,
  PRIMARY KEY (subject, metric, period_seconds, bucket)
);
REVOKE ALL ON TABLE app_private.intel_observation_cadence_claims FROM PUBLIC, anon, authenticated, service_role;

-- Chain names for eip155 chain IDs, as supabase/functions/_shared/chains.ts defines them.
CREATE FUNCTION app_private.intel_observation_evm_chain(p_chain_id text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = '' AS $$
  SELECT CASE p_chain_id
    WHEN '1' THEN 'ethereum' WHEN '8453' THEN 'base' WHEN '42161' THEN 'arbitrum' WHEN '10' THEN 'optimism'
    WHEN '56' THEN 'bnb' WHEN '137' THEN 'polygon' WHEN '43114' THEN 'avalanche' WHEN '146' THEN 'sonic'
    WHEN '1088' THEN 'metis' WHEN '59144' THEN 'linea' WHEN '534352' THEN 'scroll' WHEN '5000' THEN 'mantle'
    WHEN '100' THEN 'gnosis' WHEN '42220' THEN 'celo' WHEN '324' THEN 'zksync' WHEN '81457' THEN 'blast'
    WHEN '204' THEN 'opbnb' END;
$$;

-- CoinMarketCap subjects for one asset key: a CoinMarketCap key itself, the native and issuer mappings chart alerts
-- use, and a contract (eip155 chain ID with address, or a Solana mint) listed in the CoinMarketCap catalog's platforms.
CREATE FUNCTION app_private.intel_observation_cmc_subjects(p_key text)
RETURNS text[] LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH contract AS (
    SELECT CASE
      WHEN p_key ~ '^eip155:[0-9]{1,12}(:|/erc20:)0x[0-9a-fA-F]{40}$'
        THEN app_private.intel_observation_evm_chain(substring(p_key FROM '^eip155:([0-9]{1,12})')) || '/' || lower(right(p_key, 42))
      WHEN p_key ~ '^solana:(mainnet/token:)?[1-9A-HJ-NP-Za-km-z]{32,44}$'
        THEN 'solana/' || substring(p_key FROM '([1-9A-HJ-NP-Za-km-z]{32,44})$')
    END AS key
  )
  SELECT coalesce(array_agg(DISTINCT s.subject), '{}'::text[])
  FROM (
    SELECT 'market:coinmarketcap:' || substring(p_key FROM '^market:(?:coinmarketcap|cmc):([1-9][0-9]{0,11})$') AS subject
    UNION ALL
    SELECT k FROM unnest(app_private.intel_chart_alert_market_keys(p_key)) AS k
    UNION ALL
    SELECT 'market:coinmarketcap:' || a.provider_id
    FROM contract c
    JOIN public.market_assets a
      ON a.source_provider = 'coinmarketcap' AND public.intel_cmc_contract_keys(a.platforms) @> ARRAY[c.key]
    WHERE c.key IS NOT NULL
  ) s
  WHERE s.subject ~ '^market:coinmarketcap:[1-9][0-9]{0,11}$';
$$;

-- Assets in use, with the reason. The broad listings refresh keeps every pull for these subjects.
CREATE FUNCTION app_private.intel_observation_full_cadence_subjects()
RETURNS TABLE (subject text, reason text) LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT DISTINCT u.subject, u.reason
  FROM (
    SELECT 'market:coinmarketcap:' || a.provider_id AS subject, 'top_100' AS reason
    FROM public.market_assets a
    WHERE a.source_provider = 'coinmarketcap' AND a.market_cap_rank BETWEEN 1 AND 100
    UNION ALL
    SELECT d.subject, 'live_focus'
    FROM public.intel_live_focus_demands d
    WHERE d.expires_at > now() - interval '30 minutes'
    UNION ALL
    SELECT 'market:coinmarketcap:' || (h.market_context->>'priceProviderId'), 'holding'
    FROM public.investor_portfolio_holdings h
    WHERE NOT coalesce(h.is_closed, false) AND h.quantity > 0 AND h.market_context->>'priceProvider' = 'coinmarketcap'
    UNION ALL
    SELECT k.subject, 'holding'
    FROM (
      SELECT DISTINCT h.canonical_asset_key AS key
      FROM public.investor_portfolio_holdings h
      WHERE NOT coalesce(h.is_closed, false) AND h.quantity > 0 AND h.canonical_asset_key IS NOT NULL
    ) h
    CROSS JOIN LATERAL unnest(app_private.intel_observation_cmc_subjects(h.key)) AS k(subject)
    UNION ALL
    SELECT k.subject, 'watchlist'
    FROM public.watchlist_items wi
    JOIN public.entities e ON e.id = wi.entity_id
    CROSS JOIN LATERAL unnest(app_private.intel_entity_identity_aliases(e, e.canonical_ref_key)) AS alias(key)
    CROSS JOIN LATERAL unnest(app_private.intel_observation_cmc_subjects(alias.key)) AS k(subject)
    UNION ALL
    SELECT k.subject, 'alert_rule'
    FROM public.intel_alert_rules r
    LEFT JOIN public.entities e ON e.id = r.entity_id
    CROSS JOIN LATERAL unnest(
      CASE WHEN e.id IS NULL THEN '{}'::text[] ELSE app_private.intel_entity_identity_aliases(e, e.canonical_ref_key) END
      || (r.config->>'asset')) AS alias(key)
    CROSS JOIN LATERAL unnest(app_private.intel_observation_cmc_subjects(alias.key)) AS k(subject)
    UNION ALL
    SELECT k.subject, 'thesis'
    FROM public.intel_theses t
    LEFT JOIN public.entities e ON e.id = t.entity_id
    CROSS JOIN LATERAL unnest(
      CASE WHEN e.id IS NULL THEN '{}'::text[] ELSE app_private.intel_entity_identity_aliases(e, e.canonical_ref_key) END
      || t.subject_canonical_key) AS alias(key)
    CROSS JOIN LATERAL unnest(app_private.intel_observation_cmc_subjects(alias.key)) AS k(subject)
    WHERE t.closed_at IS NULL
    UNION ALL
    SELECT m.value->>'subject', 'cohort'
    FROM public.intel_market_cohorts c
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.members) = 'array' THEN c.members ELSE '[]'::jsonb END) AS m
    WHERE c.retain_until > now()
  ) u
  WHERE u.subject ~ '^market:coinmarketcap:[1-9][0-9]{0,11}$';
$$;
REVOKE ALL ON FUNCTION app_private.intel_observation_evm_chain(text), app_private.intel_observation_cmc_subjects(text),
  app_private.intel_observation_full_cadence_subjects() FROM PUBLIC, anon, authenticated;

-- Validation and the insert are unchanged for every row that is not from the broad listings refresh.
CREATE OR REPLACE FUNCTION public.intel_record_market_observations(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  n integer;
  t timestamptz := clock_timestamp();
  broad_listing constant text := '^coinmarketcap:/v3/cryptocurrency/listings/latest:[{]"limit":"250","sort":"market_cap","start":"[0-9]{1,6}"[}]$';
BEGIN
  IF jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) > 2000 OR octet_length(p_rows::text) > 2000000 THEN
    RAISE EXCEPTION 'invalid_observation_batch';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_rows) AS r
    WHERE (r.value->>'observedAt')::timestamptz > t + interval '5 minutes'
       OR (r.value->>'recordedAt')::timestamptz > t + interval '5 minutes'
       OR (r.value->>'retainUntil')::timestamptz > t + interval '366 days'
  ) THEN
    RAISE EXCEPTION 'invalid_observation_time';
  END IF;

  WITH incoming AS (
    SELECT e.value AS obs, e.ordinality AS ord, coalesce(e.value->>'sourceRef' ~ broad_listing, false) AS listing
    FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS e(value, ordinality)
  ), full_cadence AS (
    SELECT DISTINCT f.subject
    FROM app_private.intel_observation_full_cadence_subjects() AS f
    WHERE EXISTS (SELECT 1 FROM incoming i WHERE i.listing)
  ), thinned AS (
    -- Listings rows that need a claim: TVL for every asset, other metrics for assets not in use.
    SELECT i.ord, i.obs->>'subject' AS subject, i.obs->>'metric' AS metric, coalesce(i.obs->>'periodSeconds', '') AS period_seconds,
      CASE WHEN i.obs->>'metric' = 'tvl' THEN date_trunc('day', (i.obs->>'observedAt')::timestamptz, 'UTC')
           ELSE date_trunc('hour', (i.obs->>'observedAt')::timestamptz, 'UTC') END AS bucket,
      (i.obs->>'metric' <> 'tvl' OR jsonb_typeof(i.obs->'value') = 'number') AS claimable
    FROM incoming i
    WHERE i.listing
      AND (i.obs->>'metric' = 'tvl' OR NOT EXISTS (SELECT 1 FROM full_cadence f WHERE f.subject = i.obs->>'subject'))
  ), claimed AS (
    INSERT INTO app_private.intel_observation_cadence_claims (subject, metric, period_seconds, bucket)
    SELECT DISTINCT th.subject, th.metric, th.period_seconds, th.bucket FROM thinned th WHERE th.claimable
    ON CONFLICT DO NOTHING
    RETURNING subject, metric, period_seconds, bucket
  )
  INSERT INTO public.intel_market_observations (id, subject, provider, metric, observation, observed_at, recorded_at, retain_until)
  SELECT i.obs->>'id', i.obs->>'subject', i.obs->>'provider', i.obs->>'metric', i.obs - 'retainUntil',
    (i.obs->>'observedAt')::timestamptz, (i.obs->>'recordedAt')::timestamptz, (i.obs->>'retainUntil')::timestamptz
  FROM incoming i
  LEFT JOIN thinned th ON th.ord = i.ord
  LEFT JOIN claimed c
    ON c.subject = th.subject AND c.metric = th.metric AND c.period_seconds = th.period_seconds AND c.bucket = th.bucket
  WHERE th.ord IS NULL OR c.subject IS NOT NULL
  ORDER BY i.ord
  ON CONFLICT (id) DO NOTHING;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.intel_record_market_observations(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.intel_record_market_observations(jsonb) TO service_role;

-- Claims only matter for the current hour or day.
DO $schedule$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'intel-observation-cadence-claims';
  PERFORM cron.schedule('intel-observation-cadence-claims', '11 * * * *',
    $job$DELETE FROM app_private.intel_observation_cadence_claims WHERE bucket < now() - CASE WHEN metric = 'tvl' THEN interval '2 days' ELSE interval '3 hours' END$job$);
END
$schedule$;
