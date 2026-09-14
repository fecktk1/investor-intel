-- Source prices expire independently of private drawings and reference hashes.
REVOKE UPDATE ON public.intel_chart_snapshots FROM service_role;
ALTER TABLE public.intel_chart_snapshots ADD COLUMN series_retain_until timestamptz;
ALTER TABLE public.intel_chart_snapshots ADD COLUMN series_pruned_at timestamptz;
UPDATE public.intel_chart_snapshots SET series_retain_until=created_at+interval '30 days' WHERE jsonb_typeof(state->'bars')='array';
CREATE INDEX intel_chart_series_expiry ON public.intel_chart_snapshots(series_retain_until,id) WHERE series_retain_until IS NOT NULL AND series_pruned_at IS NULL;
CREATE FUNCTION app_private.intel_chart_snapshot_retention() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE expiry timestamptz;
BEGIN
 IF jsonb_typeof(NEW.state->'bars')='array' THEN
  IF jsonb_typeof(NEW.state#>'{policy,retainUntil}') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'chart_snapshot_retention_required';END IF;
  expiry:=to_timestamp((NEW.state#>>'{policy,retainUntil}')::double precision/1000);
  IF NOT isfinite(expiry) OR expiry<=clock_timestamp() OR expiry>clock_timestamp()+interval '366 days' THEN RAISE EXCEPTION 'chart_snapshot_invalid_retention';END IF;
  NEW.series_retain_until:=expiry;
 ELSE NEW.series_retain_until:=NULL;END IF;
 NEW.series_pruned_at:=NULL;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.intel_chart_snapshot_retention() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER intel_chart_snapshot_retention BEFORE INSERT ON public.intel_chart_snapshots FOR EACH ROW EXECUTE FUNCTION app_private.intel_chart_snapshot_retention();
CREATE POLICY chart_snapshot_expired_price_boundary ON public.intel_chart_snapshots AS RESTRICTIVE FOR SELECT TO authenticated
 USING(jsonb_typeof(state->'bars') IS DISTINCT FROM 'array' OR series_retain_until>now());

-- Only this bounded maintenance function can redact expired prices. General
-- service UPDATE remains denied; drawings, hashes and saved research survive.
CREATE FUNCTION public.intel_prune_chart_prices(p_limit integer DEFAULT 100) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE changed integer;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid_retention_batch';END IF;
 WITH expired AS (SELECT id FROM public.intel_chart_snapshots WHERE series_retain_until<=clock_timestamp() AND series_pruned_at IS NULL ORDER BY series_retain_until,id LIMIT p_limit FOR UPDATE SKIP LOCKED)
 UPDATE public.intel_chart_snapshots s SET state=jsonb_set(s.state,'{bars}','null'::jsonb),series_pruned_at=clock_timestamp() FROM expired WHERE expired.id=s.id;
 GET DIAGNOSTICS changed=ROW_COUNT;RETURN changed;
END $$;
REVOKE ALL ON FUNCTION public.intel_prune_chart_prices(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_prune_chart_prices(integer) TO service_role;
