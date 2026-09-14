SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- The legacy history lane must use the same finite operating policy as CMC
-- research captures. This helper exposes only a deadline, never the ledger.
CREATE OR REPLACE FUNCTION public.intel_market_history_deadline(p_observed_at timestamptz)
RETURNS timestamptz LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE cfg jsonb; days integer; cutoff timestamptz;
BEGIN
  SELECT config INTO cfg FROM public.provider_quota_budgets
    WHERE provider='coinmarketcap' AND data_type='cmc_operating_profile' AND period_start='1970-01-01';
  IF cfg->>'CMC_ALLOW_HISTORICAL_RETENTION' IS DISTINCT FROM 'true' THEN RETURN NULL; END IF;
  IF cfg->>'CMC_HISTORY_RETENTION_DAYS' IS NULL OR (cfg->>'CMC_HISTORY_RETENTION_DAYS') !~ '^[1-9][0-9]{0,2}$' THEN RETURN NULL; END IF;
  days := LEAST(30, (cfg->>'CMC_HISTORY_RETENTION_DAYS')::integer);
  cutoff := (cfg->>'CMC_SOURCE_POLICY_EXPIRES_AT')::timestamptz;
  IF cutoff IS NULL OR NOT isfinite(cutoff) OR cutoff<=now() OR p_observed_at IS NULL THEN RETURN NULL; END IF;
  RETURN LEAST(cutoff,p_observed_at+make_interval(days=>days));
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range THEN
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.intel_market_history_deadline(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intel_market_history_deadline(timestamptz) TO authenticated,service_role;

ALTER TABLE public.market_macro_snapshots ADD COLUMN IF NOT EXISTS retention_until timestamptz;
ALTER TABLE public.market_ranking_snapshots ADD COLUMN IF NOT EXISTS retention_until timestamptz;

-- Backfill only supported original clocks. No past edit or provider observation
-- is reconstructed, and a policy change can never extend a captured deadline.
UPDATE public.market_macro_snapshots SET retention_until=public.intel_market_history_deadline(LEAST(as_of,fetched_at))
 WHERE provider='coinmarketcap' AND retention_until IS NULL;
UPDATE public.market_ranking_snapshots SET retention_until=public.intel_market_history_deadline(LEAST(as_of,fetched_at))
 WHERE provider='coinmarketcap' AND retention_until IS NULL;

CREATE OR REPLACE FUNCTION public.intel_bound_market_history_write()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE deadline timestamptz;
BEGIN
  IF NEW.provider='coinmarketcap' THEN
    deadline:=public.intel_market_history_deadline(LEAST(NEW.as_of,NEW.fetched_at));
    IF deadline IS NULL OR deadline<=now() THEN RAISE EXCEPTION 'CMC history retention is unavailable'; END IF;
    IF NEW.as_of>now()+interval '5 minutes' OR NEW.fetched_at>now()+interval '5 minutes' THEN
      RAISE EXCEPTION 'Market history clock is in the future';
    END IF;
    NEW.retention_until:=LEAST(NEW.retention_until,deadline);
    IF TG_OP='UPDATE' AND OLD.provider='coinmarketcap' THEN
      NEW.retention_until:=LEAST(NEW.retention_until,OLD.retention_until);
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.intel_bound_market_history_write() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_bound_market_history_write() TO service_role;
DROP TRIGGER IF EXISTS intel_bound_market_history ON public.market_macro_snapshots;
CREATE TRIGGER intel_bound_market_history BEFORE INSERT OR UPDATE ON public.market_macro_snapshots
 FOR EACH ROW EXECUTE FUNCTION public.intel_bound_market_history_write();
DROP TRIGGER IF EXISTS intel_bound_market_history ON public.market_ranking_snapshots;
CREATE TRIGGER intel_bound_market_history BEFORE INSERT OR UPDATE ON public.market_ranking_snapshots
 FOR EACH ROW EXECUTE FUNCTION public.intel_bound_market_history_write();

DROP POLICY IF EXISTS market_macro_snapshots_read ON public.market_macro_snapshots;
CREATE POLICY market_macro_snapshots_read ON public.market_macro_snapshots FOR SELECT TO authenticated
 USING (provider<>'coinmarketcap' OR (retention_until>now() AND public.intel_market_history_deadline(LEAST(as_of,fetched_at))>now()));
DROP POLICY IF EXISTS market_ranking_snapshots_read ON public.market_ranking_snapshots;
CREATE POLICY market_ranking_snapshots_read ON public.market_ranking_snapshots FOR SELECT TO authenticated
 USING (provider<>'coinmarketcap' OR (retention_until>now() AND public.intel_market_history_deadline(LEAST(as_of,fetched_at))>now()));

-- Service-role consumers bypass RLS. These invoker views apply the same expiry
-- to their reads, while retaining every original response field.
CREATE OR REPLACE VIEW public.market_macro_available WITH (security_invoker=true) AS
 SELECT * FROM public.market_macro_snapshots WHERE provider<>'coinmarketcap'
 OR (retention_until>now() AND public.intel_market_history_deadline(LEAST(as_of,fetched_at))>now());
CREATE OR REPLACE VIEW public.market_rankings_available WITH (security_invoker=true) AS
 SELECT * FROM public.market_ranking_snapshots WHERE provider<>'coinmarketcap'
 OR (retention_until>now() AND public.intel_market_history_deadline(LEAST(as_of,fetched_at))>now());
REVOKE ALL ON public.market_macro_available,public.market_rankings_available FROM PUBLIC,anon;
GRANT SELECT ON public.market_macro_available,public.market_rankings_available TO authenticated,service_role;
CREATE INDEX IF NOT EXISTS market_ranking_snapshot_cohort ON public.market_ranking_snapshots(provider,rank_kind,snapshot_bucket DESC,rank);

CREATE OR REPLACE FUNCTION public.intel_prune_market_history(p_limit integer DEFAULT 5000)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE macro_n integer; rank_n integer; category_n integer;
BEGIN
 IF p_limit<1 OR p_limit>5000 OR p_limit IS NULL THEN RAISE EXCEPTION 'Invalid prune limit'; END IF;
 DELETE FROM public.market_macro_snapshots WHERE id IN (SELECT id FROM public.market_macro_snapshots
  WHERE (provider='coinmarketcap' AND (retention_until IS NULL OR retention_until<=now() OR COALESCE(public.intel_market_history_deadline(LEAST(as_of,fetched_at)),now())<=now()))
    OR fetched_at<now()-interval '90 days' ORDER BY fetched_at,id LIMIT p_limit);
 GET DIAGNOSTICS macro_n=ROW_COUNT;
 DELETE FROM public.market_ranking_snapshots WHERE id IN (SELECT id FROM public.market_ranking_snapshots
  WHERE (provider='coinmarketcap' AND (retention_until IS NULL OR retention_until<=now() OR COALESCE(public.intel_market_history_deadline(LEAST(as_of,fetched_at)),now())<=now()))
    OR fetched_at<now()-interval '30 days' ORDER BY fetched_at,id LIMIT p_limit);
 GET DIAGNOSTICS rank_n=ROW_COUNT;
 DELETE FROM public.narrative_category_snapshots WHERE id IN (SELECT id FROM public.narrative_category_snapshots
  WHERE fetched_at<now()-interval '90 days' ORDER BY fetched_at,id LIMIT p_limit);
 GET DIAGNOSTICS category_n=ROW_COUNT;
 RETURN jsonb_build_object('macro',macro_n,'rankings',rank_n,'categories',category_n);
END $$;
REVOKE ALL ON FUNCTION public.intel_prune_market_history(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_prune_market_history(integer) TO service_role;

-- Reuse the existing cleanup job. This is bounded database maintenance, not
-- additional provider polling. Expired facts are hidden immediately by reads.
DO $$ DECLARE j bigint; BEGIN
 SELECT jobid INTO j FROM cron.job WHERE jobname='market-macro-prune-daily';
 IF j IS NULL THEN RAISE EXCEPTION 'Existing market history cleanup job not found'; END IF;
 PERFORM cron.alter_job(j,schedule=>'*/15 * * * *',command=>'SELECT public.intel_prune_market_history(5000);');
END $$;
