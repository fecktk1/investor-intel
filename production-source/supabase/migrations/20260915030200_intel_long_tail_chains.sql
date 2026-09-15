-- Contract search, the long tail (proposal 31): Cardano joins the chain registry.
--
-- supabase/functions/_shared/chains.ts (and its frontend mirror src/intel/lib/chains.js) gained one chain,
-- 'cardano', so a pasted Cardano policy id resolves to a chain instead of an unknown one. The on-demand
-- indexing RPC validates the chain against a hardcoded list, so a new chain in the registry is a migration
-- here or the record is refused with invalid_on_demand_asset.
--
-- public.intel_upsert_on_demand_asset is restated WHOLE from its live definition
-- (20260915004751_intel_on_demand_indexing.sql). The ONLY difference is 'cardano' appended to v_chains:
-- every validation, the INSERT column list, the ON CONFLICT DO NOTHING and the confidence/label CASEs are
-- character-for-character the reviewed body. Restating it whole is deliberate — a CREATE OR REPLACE that
-- rebuilt the body from memory is how a validated function quietly loses a check.
--
-- Nothing else changes: no table, no policy, no grant beyond the re-issued REVOKE/GRANT pair that a
-- CREATE OR REPLACE requires, and no row is written at migration time.
--
-- Rollback: re-run 20260915004751_intel_on_demand_indexing.sql (its section 2), which restores the
-- 34-chain array. A Cardano row already written stays valid; only new Cardano rows would be refused.

SET lock_timeout = '5s';
SET statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.intel_upsert_on_demand_asset(p_row jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  -- Every chain id in supabase/functions/_shared/chains.ts. A chain outside this list is a rejected row,
  -- never a guessed one. 'cardano' (proposal 31) identifies an asset by minting policy id, optionally with
  -- the hex asset name, so its address is '<56 hex>' or '<56 hex>.<asset name hex>' — both shapes pass the
  -- generic contract-address check below.
  v_chains constant text[] := ARRAY[
    'solana', 'ethereum', 'base', 'arbitrum', 'optimism', 'bnb', 'polygon', 'avalanche', 'hyperliquid',
    'sei', 'sonic', 'metis', 'linea', 'scroll', 'mantle', 'gnosis', 'celo', 'zksync', 'blast', 'opbnb',
    'sui', 'aptos', 'bitcoin', 'tron', 'injective', 'stellar', 'near', 'ton', 'xrpl', 'zcash', 'taiko',
    'xdc', 'moonbeam', 'moonriver', 'cardano'];
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
