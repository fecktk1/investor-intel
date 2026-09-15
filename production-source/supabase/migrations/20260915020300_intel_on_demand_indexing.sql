-- On-demand indexing: the first successful resolution of an asset makes it a shared, searchable record.
--
-- Three parts:
--   1. app_private.intel_observation_full_cadence_subjects() also keeps full cadence for assets that are in use
--      because someone searched for them (market_asset_demand.in_use_until > now(), reason 'on_demand').
--   2. public.intel_upsert_on_demand_asset(jsonb) creates the market_assets record for a resolved identity —
--      only when no row exists for that (source_provider, provider_id). It never overwrites a catalogue row.
--   3. public.intel_recently_discovered lists the newest demands for the "recently discovered" strip.
--
-- Nothing here stores who searched. market_asset_demand and market_asset_demand_daily hold counters and
-- timestamps only; the resolver passes no user or org id into the demand ledger.

-- 1. Assets in use, with the reason. Body copied verbatim from 20260914205704_intel_observation_cadence.sql
--    with two 'on_demand' branches appended: a CoinMarketCap demand is already a subject, and a contract demand
--    is mapped through the CoinMarketCap platform index the same way a holding or watchlist key is.
CREATE OR REPLACE FUNCTION app_private.intel_observation_full_cadence_subjects()
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
    UNION ALL
    -- Searched in the last 24 hours: a CoinMarketCap identity is its own subject.
    SELECT 'market:coinmarketcap:' || d.provider_id, 'on_demand'
    FROM public.market_asset_demand d
    WHERE d.in_use_until > now() AND d.provider = 'coinmarketcap'
    UNION ALL
    -- Searched in the last 24 hours: a contract identity maps through the CoinMarketCap platform index.
    -- The resolver's demand key is '<app chain>:<address>', so an EVM chain name is turned back into its
    -- eip155 reference with the same table intel_observation_evm_chain() already carries, and a Solana mint
    -- key is passed through unchanged. A chain CoinMarketCap does not list simply yields no subject.
    SELECT k.subject, 'on_demand'
    FROM public.market_asset_demand d
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN d.asset_key ~ '^[a-z][a-z0-9_-]{1,32}:0x[0-9a-fA-F]{40}$' THEN coalesce((
          SELECT 'eip155:' || v.id || ':' || lower(split_part(d.asset_key, ':', 2))
          FROM (VALUES ('1'), ('8453'), ('42161'), ('10'), ('56'), ('137'), ('43114'), ('146'), ('1088'),
                       ('59144'), ('534352'), ('5000'), ('100'), ('42220'), ('324'), ('81457'), ('204')) AS v(id)
          WHERE app_private.intel_observation_evm_chain(v.id) = split_part(d.asset_key, ':', 1)
        ), d.asset_key)
        ELSE d.asset_key
      END AS key
    ) AS n
    CROSS JOIN LATERAL unnest(app_private.intel_observation_cmc_subjects(n.key)) AS k(subject)
    WHERE d.in_use_until > now() AND d.provider IS DISTINCT FROM 'coinmarketcap'
  ) u
  WHERE u.subject ~ '^market:coinmarketcap:[1-9][0-9]{0,11}$';
$$;
REVOKE ALL ON FUNCTION app_private.intel_observation_full_cadence_subjects() FROM PUBLIC, anon, authenticated;

-- 2. One resolved identity becomes a market_assets record.
--
-- The catalogue writer (public.intel_replace_market_catalog) owns every row it writes and marks assets outside
-- the newest 1,000-row snapshot in_current_catalog = false without deleting them. This function only ever
-- INSERTs, with ON CONFLICT DO NOTHING on the primary key, so a catalogue row is never touched: the catalogue
-- remains the single writer of its own facts. Rows written here carry in_current_catalog = false, so they are
-- invisible to the Markets screen (its views select source_provider IN ('coinmarketcap','coingecko') with
-- in_current_catalog) and visible to the asset detail read, which looks a row up by provider and id.
--
-- The catalogue RPC's own '^[1-9][0-9]{0,9}$' provider-id check belongs to that RPC; this function writes
-- directly to the table and therefore validates its own shape.

-- A market number from the payload, or NULL: a non-number, NaN or an infinity never reaches a column.
CREATE OR REPLACE FUNCTION app_private.intel_on_demand_number(p_market jsonb, p_key text)
RETURNS double precision LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = '' AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_market->p_key) = 'number'
      AND (p_market->>p_key)::double precision BETWEEN -1e30 AND 1e30
    THEN (p_market->>p_key)::double precision
  END;
$$;
REVOKE ALL ON FUNCTION app_private.intel_on_demand_number(jsonb, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.intel_upsert_on_demand_asset(p_row jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  -- Every chain id in supabase/functions/_shared/chains.ts. A chain outside this list is a rejected row,
  -- never a guessed one.
  v_chains constant text[] := ARRAY[
    'solana', 'ethereum', 'base', 'arbitrum', 'optimism', 'bnb', 'polygon', 'avalanche', 'hyperliquid',
    'sei', 'sonic', 'metis', 'linea', 'scroll', 'mantle', 'gnosis', 'celo', 'zksync', 'blast', 'opbnb',
    'sui', 'aptos', 'bitcoin', 'tron', 'injective', 'stellar', 'near', 'ton', 'xrpl', 'zcash', 'taiko',
    'xdc', 'moonbeam', 'moonriver'];
  v_kind text := p_row->>'kind';
  v_provider text;
  v_provider_id text := nullif(btrim(p_row->>'providerId'), '');
  v_symbol text := nullif(btrim(p_row->>'symbol'), '');
  v_name text := nullif(btrim(p_row->>'name'), '');
  v_chain text := nullif(btrim(p_row->>'chain'), '');
  v_address text := nullif(btrim(p_row->>'address'), '');
  v_image text := nullif(btrim(p_row->>'imageUrl'), '');
  v_image_source text := nullif(btrim(p_row->>'imageSource'), '');
  v_platforms jsonb := CASE WHEN jsonb_typeof(p_row->'platforms') = 'object' THEN p_row->'platforms' ELSE NULL END;
  v_market jsonb := CASE WHEN jsonb_typeof(p_row->'market') = 'object' THEN p_row->'market' ELSE '{}'::jsonb END;
  v_rank integer;
  v_now timestamptz := now();
  v_inserted boolean;
BEGIN
  IF jsonb_typeof(p_row) <> 'object' OR v_kind IS NULL OR v_kind NOT IN ('cmc', 'contract')
    OR v_symbol IS NULL OR length(v_symbol) > 64
    OR (v_name IS NOT NULL AND length(v_name) > 160)
    OR (v_image_source IS NOT NULL AND length(v_image_source) > 40)
    OR (v_platforms IS NOT NULL AND octet_length(v_platforms::text) > 8000) THEN
    RAISE EXCEPTION 'invalid_on_demand_asset' USING ERRCODE = '22023';
  END IF;

  -- A logo that is not a plain https URL is dropped; it is never a reason to refuse the record.
  IF v_image IS NOT NULL AND (length(v_image) > 500 OR v_image !~ '^https://[^[:space:]<>"]+$') THEN
    v_image := NULL;
  END IF;

  v_rank := CASE
    WHEN jsonb_typeof(v_market->'market_cap_rank') = 'number'
      AND (v_market->>'market_cap_rank')::double precision BETWEEN 1 AND 1000000
    THEN (v_market->>'market_cap_rank')::double precision::integer
  END;

  IF v_kind = 'cmc' THEN
    v_provider := 'coinmarketcap';
    IF v_provider_id IS NULL OR v_provider_id !~ '^[1-9][0-9]{0,9}$'
      OR (v_chain IS NOT NULL AND NOT (v_chain = ANY (v_chains))) THEN
      RAISE EXCEPTION 'invalid_on_demand_asset' USING ERRCODE = '22023';
    END IF;
  ELSE
    v_provider := 'on_demand';
    IF v_chain IS NULL OR NOT (v_chain = ANY (v_chains))
      OR v_address IS NULL OR v_address !~ '^[A-Za-z0-9][A-Za-z0-9:._-]{1,199}$'
      OR (v_provider_id IS NOT NULL AND v_provider_id <> v_chain || ':' || v_address) THEN
      RAISE EXCEPTION 'invalid_on_demand_asset' USING ERRCODE = '22023';
    END IF;
    v_provider_id := v_chain || ':' || v_address;
    v_platforms := coalesce(v_platforms, jsonb_build_object(v_chain, v_address));
  END IF;

  INSERT INTO public.market_assets (
    source_provider, provider_id, symbol, name, normalized_symbol, primary_chain, platforms,
    image_url, image_source, current_price, market_cap, fdv, volume_24h,
    circulating_supply, total_supply, max_supply, change_1h_pct, change_24h_pct, change_7d_pct, market_cap_rank,
    in_current_catalog, confidence, source_label, attribution_label, last_refreshed_at, as_of, updated_at)
  VALUES (
    v_provider, v_provider_id, v_symbol, v_name, upper(ltrim(v_symbol, '$')), v_chain, v_platforms,
    v_image,
    coalesce(v_image_source, CASE WHEN v_image IS NULL THEN NULL WHEN v_kind = 'cmc' THEN 'coinmarketcap' END),
    app_private.intel_on_demand_number(v_market, 'current_price'),
    app_private.intel_on_demand_number(v_market, 'market_cap'),
    app_private.intel_on_demand_number(v_market, 'fdv'),
    app_private.intel_on_demand_number(v_market, 'volume_24h'),
    app_private.intel_on_demand_number(v_market, 'circulating_supply'),
    app_private.intel_on_demand_number(v_market, 'total_supply'),
    app_private.intel_on_demand_number(v_market, 'max_supply'),
    app_private.intel_on_demand_number(v_market, 'change_1h_pct'),
    app_private.intel_on_demand_number(v_market, 'change_24h_pct'),
    app_private.intel_on_demand_number(v_market, 'change_7d_pct'),
    v_rank,
    false,
    -- A CoinMarketCap identity comes from the provider's own metadata; a contract identity is assembled from
    -- on-chain and DEX sources. Neither is the reviewed catalogue snapshot, so neither claims 'high'.
    CASE WHEN v_kind = 'cmc' THEN 'medium' ELSE 'low' END,
    CASE WHEN v_kind = 'cmc' THEN NULL ELSE 'Resolved from on-chain sources' END,
    CASE WHEN v_kind = 'cmc' THEN 'Data provided by CoinMarketCap.com' END,
    v_now, v_now, v_now)
  ON CONFLICT (source_provider, provider_id) DO NOTHING;
  v_inserted := FOUND;

  RETURN jsonb_build_object('inserted', v_inserted, 'source_provider', v_provider, 'provider_id', v_provider_id);
END $$;
REVOKE ALL ON FUNCTION public.intel_upsert_on_demand_asset(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.intel_upsert_on_demand_asset(jsonb) TO service_role;

-- 3. The "recently discovered" strip on the Markets screen.
--
-- The demand ledger is an aggregate: an asset key, its counters and its in-use window. It carries no user,
-- org or session column, so a signed-in reader learns what has been looked up, never by whom. That is why the
-- ledger gets a read-only policy here while the daily rollup stays service-role only.
ALTER TABLE public.market_asset_demand ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS market_asset_demand_read ON public.market_asset_demand;
CREATE POLICY market_asset_demand_read ON public.market_asset_demand FOR SELECT TO authenticated USING (true);
GRANT SELECT ON TABLE public.market_asset_demand TO authenticated;

-- A contract demand is recorded with provider 'contract' (the resolver's identity provider) and is stored in
-- market_assets under source_provider 'on_demand', so the join maps the one to the other.
CREATE OR REPLACE VIEW public.intel_recently_discovered WITH (security_invoker = true) AS
  SELECT d.asset_key, d.provider, d.provider_id, a.symbol, a.name, a.image_url, a.cached_image_url,
    d.first_demanded_at, d.last_demanded_at, d.demand_count, d.in_use_until
  FROM (
    SELECT m.asset_key, m.provider, m.provider_id, m.first_demanded_at, m.last_demanded_at, m.demand_count, m.in_use_until
    FROM public.market_asset_demand m
    ORDER BY m.last_demanded_at DESC, m.asset_key
    LIMIT 50
  ) d
  LEFT JOIN public.market_assets a
    ON a.source_provider = CASE WHEN d.provider = 'coinmarketcap' THEN 'coinmarketcap' ELSE 'on_demand' END
   AND a.provider_id = d.provider_id;
REVOKE ALL ON public.intel_recently_discovered FROM PUBLIC, anon;
GRANT SELECT ON public.intel_recently_discovered TO authenticated, service_role;
