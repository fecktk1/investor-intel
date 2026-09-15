-- Intel read paths and the derived-volume refresh, September 14.
--
-- 1. narrative_category_snapshots and market_rankings_available are read newest-first
--    without a provider filter, and the per-asset ranking lookup filters on provider_id,
--    which no index covered. Production plans showed a parallel sequential scan of 310 MB
--    (1.5 s) and a 94,000-row index filter (1.9 s) for single-digit row results.
-- 2. market_assets_compute_derived ran a seven-day median over market_asset_snapshots inside
--    a PostgREST request, where the authenticator role's 8 s statement_timeout cancelled it
--    on most deep refreshes (17:25, 17:55 and 18:55 UTC). The median now runs from pg_cron,
--    which has no request timeout, two minutes after each deep refresh. The RPC that
--    market-assets-refresh still calls returns the current derived status immediately.

CREATE INDEX IF NOT EXISTS narrative_category_snapshots_as_of
  ON public.narrative_category_snapshots (as_of DESC);
CREATE INDEX IF NOT EXISTS market_ranking_snapshots_provider_asset
  ON public.market_ranking_snapshots (provider, provider_id, snapshot_bucket DESC);
CREATE INDEX IF NOT EXISTS market_ranking_snapshots_as_of
  ON public.market_ranking_snapshots (as_of DESC);

CREATE OR REPLACE FUNCTION public.market_assets_refresh_derived()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE v_assets int := 0;
BEGIN
  -- 7d median volume baseline per asset (set-based; snapshots are deep-mode only)
  WITH base AS (
    SELECT source_provider, provider_id,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY volume_24h) AS baseline
    FROM market_asset_snapshots
    WHERE as_of > now() - interval '7 days' AND volume_24h IS NOT NULL
    GROUP BY source_provider, provider_id
  )
  UPDATE market_assets m SET derived = jsonb_build_object(
    'vol_baseline_24h', round(b.baseline::numeric, 0),
    'volume_ratio', CASE WHEN b.baseline > 0 THEN round((m.volume_24h / b.baseline)::numeric, 2) ELSE NULL END,
    'unusual_volume', (b.baseline > 0 AND m.volume_24h / b.baseline >= 3 AND m.volume_24h >= 250000),
    'vol_up_price_flat', (b.baseline > 0 AND m.volume_24h / b.baseline >= 2 AND abs(COALESCE(m.change_24h_pct, 0)) <= 2),
    'derived_at', now()
  )
  FROM base b
  WHERE m.source_provider = b.source_provider AND m.provider_id = b.provider_id
    AND m.volume_24h IS NOT NULL;
  GET DIAGNOSTICS v_assets = ROW_COUNT;
  RETURN jsonb_build_object('assets', v_assets, 'memecoins', 0);
END $function$;

-- Only pg_cron runs the median; a request-scoped caller would hit the timeout again.
REVOKE ALL ON FUNCTION public.market_assets_refresh_derived() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.market_assets_compute_derived()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  -- market-assets-refresh calls this after deep writes. The median itself runs from the
  -- market-assets-derived cron job, so this reports the current derived status.
  SELECT jsonb_build_object(
    'assets', count(*) FILTER (WHERE (derived->>'derived_at')::timestamptz > now() - interval '35 minutes'),
    'memecoins', 0,
    'computed_by', 'pg_cron:market-assets-derived',
    'last_derived_at', max((derived->>'derived_at')::timestamptz))
  FROM market_assets
  WHERE derived ? 'derived_at'
$function$;

DO $schedule$
DECLARE v_job bigint;
BEGIN
  SELECT jobid INTO v_job FROM cron.job WHERE jobname = 'market-assets-derived';
  IF v_job IS NOT NULL THEN PERFORM cron.unschedule(v_job); END IF;
  -- market-assets-refresh-deep runs at :25 and :55 and finishes within about 30 seconds.
  PERFORM cron.schedule('market-assets-derived', '27,57 * * * *', $job$SELECT public.market_assets_refresh_derived();$job$);
END
$schedule$;
