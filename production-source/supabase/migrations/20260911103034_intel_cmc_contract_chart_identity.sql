-- Indexed, provider-specific lookup. A ticker never establishes contract identity.
CREATE OR REPLACE FUNCTION public.intel_cmc_contract_keys(p_platforms jsonb)
RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=''
AS $$
 SELECT COALESCE(array_agg(DISTINCT public.intel_market_chain(p.key)||'/'||public.intel_market_address(p.value) ORDER BY public.intel_market_chain(p.key)||'/'||public.intel_market_address(p.value)),ARRAY[]::text[])
 FROM jsonb_each_text(CASE WHEN jsonb_typeof(p_platforms)='object' THEN p_platforms ELSE '{}'::jsonb END) p
 WHERE length(p.key) BETWEEN 1 AND 80 AND length(p.value) BETWEEN 1 AND 200;
$$;

CREATE INDEX IF NOT EXISTS market_assets_cmc_contract_keys_idx
 ON public.market_assets USING gin(public.intel_cmc_contract_keys(platforms))
 WHERE source_provider='coinmarketcap';

CREATE OR REPLACE FUNCTION public.intel_cmc_contract_chart_identity(p_chain text,p_address text)
RETURNS TABLE(provider_id text,symbol text,name text,image_url text,metadata_observed_at timestamptz)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=''
AS $$
 SELECT a.provider_id,a.symbol,a.name,a.image_url,a.image_last_checked_at
 FROM public.market_assets a
 WHERE length(p_chain) BETWEEN 1 AND 80 AND length(p_address) BETWEEN 1 AND 200
   AND a.source_provider='coinmarketcap'
   AND public.intel_cmc_contract_keys(a.platforms) @> ARRAY[public.intel_market_chain(p_chain)||'/'||public.intel_market_address(p_address)]
   AND a.image_last_checked_at BETWEEN now()-interval '7 days' AND now()+interval '5 minutes'
 ORDER BY a.provider_id LIMIT 2;
$$;
REVOKE ALL ON FUNCTION public.intel_cmc_contract_keys(jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.intel_cmc_contract_chart_identity(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_cmc_contract_keys(jsonb),public.intel_cmc_contract_chart_identity(text,text) TO service_role;
