-- Investor Intel public demo: which assets are ACTIVELY TRACKED.
--
-- The demo (/intel/demo) answers Markets search, the typeahead, the workspace
-- search and the asset page through intel-demo-read, a public read-only Edge
-- Function. It answers for an asset only when one of our scheduled capture lanes
-- has stored an observation of that EXACT identity in the last seven days:
--
--   catalogue  a market_assets row from the CoinMarketCap or CoinGecko catalogue
--              lane whose last_refreshed_at is inside the window (the CMC top
--              1,000 listings refresh, the CoinGecko catalogue refresh, and the
--              CMC ids the quote lanes still refresh after they left the top
--              1,000). Rows the on-demand indexer wrote for a pasted contract
--              ('on_demand') are NOT tracked: they are one visitor's lookup, and
--              a catalogue row whose refresh stopped is not tracked either.
--   rwa_lane   a CoinMarketCap id of a tokenised real-world asset token that the
--              hourly wrapper lane (intel_rwa_wrapper_tokens), the daily depth
--              lane (intel_rwa_depth_snapshots) or the daily universe coverage
--              lane (intel_rwa_coverage_tokens) captured inside the window.
--
-- Anything else (a new listing, a random contract, an id nobody refreshes) is
-- not tracked, and the demo says so instead of reading it.
--
-- The function answers one question for a bounded list of identities and
-- returns only the tracked ones. It reads, never writes. Service role only: no
-- grant to anon or authenticated (REVOKE FROM PUBLIC alone does not remove
-- Supabase's default grants, so each role is named).

CREATE OR REPLACE FUNCTION public.intel_demo_tracked_assets(p_identities jsonb)
RETURNS TABLE (source_provider text, provider_id text, basis text)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH asked AS (
    SELECT DISTINCT e.value->>'sourceProvider' AS source_provider, e.value->>'providerId' AS provider_id
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_identities) = 'array' THEN p_identities ELSE '[]'::jsonb END)
      WITH ORDINALITY AS e(value, n)
    WHERE e.n <= 200
      AND jsonb_typeof(e.value) = 'object'
      AND e.value->>'sourceProvider' IN ('coinmarketcap', 'coingecko')
      AND e.value->>'providerId' ~ '^[A-Za-z0-9._-]{1,120}$'
  ), judged AS (
    SELECT a.source_provider, a.provider_id,
      CASE
        WHEN EXISTS (
          SELECT 1 FROM public.market_assets m
          WHERE m.source_provider = a.source_provider AND m.provider_id = a.provider_id
            AND m.last_refreshed_at >= now() - interval '7 days'
        ) THEN 'catalogue'
        WHEN a.source_provider = 'coinmarketcap' AND a.provider_id ~ '^[1-9][0-9]{0,9}$' AND (
          EXISTS (SELECT 1 FROM public.intel_rwa_wrapper_tokens w WHERE w.crypto_id = a.provider_id AND w.captured_at >= now() - interval '7 days')
          OR EXISTS (SELECT 1 FROM public.intel_rwa_depth_snapshots d WHERE d.crypto_id = a.provider_id AND d.captured_at >= now() - interval '7 days')
          OR EXISTS (SELECT 1 FROM public.intel_rwa_coverage_tokens c WHERE c.crypto_id = a.provider_id AND c.captured_at >= now() - interval '7 days')
        ) THEN 'rwa_lane'
      END AS basis
    FROM asked a
  )
  SELECT j.source_provider, j.provider_id, j.basis FROM judged j WHERE j.basis IS NOT NULL
$$;

REVOKE ALL ON FUNCTION public.intel_demo_tracked_assets(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.intel_demo_tracked_assets(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.intel_demo_tracked_assets(jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.intel_demo_tracked_assets(jsonb) TO service_role;

COMMENT ON FUNCTION public.intel_demo_tracked_assets(jsonb) IS
  'intel-demo-read: the subset of up to 200 {sourceProvider, providerId} identities that a capture lane observed in the last 7 days (catalogue refresh or RWA wrapper/depth/coverage lane). Read only. Service role only.';
