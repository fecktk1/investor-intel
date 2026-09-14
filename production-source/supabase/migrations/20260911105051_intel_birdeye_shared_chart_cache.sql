-- Public market candles only. Personal notes/positions never enter this cache.
CREATE TABLE public.intel_birdeye_chart_cache (
 chain text NOT NULL CHECK(length(chain) BETWEEN 1 AND 80),
 token_address text NOT NULL CHECK(length(token_address) BETWEEN 1 AND 200),
 timeframe text NOT NULL CHECK(timeframe IN ('1H','4H','1D','1W')),
 candles jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(candles)='array' AND jsonb_array_length(candles)<=1000 AND octet_length(candles::text)<=1048576),
 fetched_at timestamptz,expires_at timestamptz,retain_until timestamptz,
 lease_id uuid,lease_until timestamptz,retry_after timestamptz,error_code text,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(chain,token_address,timeframe)
);
ALTER TABLE public.intel_birdeye_chart_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY intel_birdeye_chart_service ON public.intel_birdeye_chart_cache FOR ALL TO service_role USING(true) WITH CHECK(true);
REVOKE ALL ON public.intel_birdeye_chart_cache FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.intel_birdeye_chart_cache TO service_role;
CREATE INDEX intel_birdeye_chart_cache_retention ON public.intel_birdeye_chart_cache(updated_at);

CREATE FUNCTION public.intel_birdeye_chart_claim(p_chain text,p_address text,p_timeframe text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE r public.intel_birdeye_chart_cache%ROWTYPE; v_now timestamptz:=clock_timestamp(); v_claim boolean:=false;
BEGIN
 IF p_chain IS NULL OR p_address IS NULL OR p_timeframe IS NULL OR length(p_chain) NOT BETWEEN 1 AND 80 OR length(p_address) NOT BETWEEN 1 AND 200 OR p_timeframe NOT IN ('1H','4H','1D','1W') THEN RAISE EXCEPTION 'invalid_chart_identity'; END IF;
 p_address:=public.intel_market_address(p_address);
 INSERT INTO public.intel_birdeye_chart_cache(chain,token_address,timeframe) VALUES(p_chain,p_address,p_timeframe) ON CONFLICT DO NOTHING;
 SELECT * INTO STRICT r FROM public.intel_birdeye_chart_cache WHERE chain=p_chain AND token_address=p_address AND timeframe=p_timeframe FOR UPDATE;
 IF r.retain_until<=v_now THEN
  UPDATE public.intel_birdeye_chart_cache SET candles='[]',fetched_at=NULL,expires_at=NULL,retain_until=NULL
  WHERE chain=p_chain AND token_address=p_address AND timeframe=p_timeframe RETURNING * INTO r;
 END IF;
 IF COALESCE(r.expires_at<=v_now,true) AND COALESCE(r.retry_after<=v_now,true) AND COALESCE(r.lease_until<=v_now,true) THEN
  UPDATE public.intel_birdeye_chart_cache SET lease_id=gen_random_uuid(),lease_until=v_now+interval '30 seconds',updated_at=v_now
  WHERE chain=p_chain AND token_address=p_address AND timeframe=p_timeframe RETURNING * INTO r;
  v_claim:=true;
 END IF;
 RETURN jsonb_build_object('claimed',v_claim,'leaseId',CASE WHEN v_claim THEN r.lease_id ELSE NULL END,
  'candles',CASE WHEN r.retain_until>v_now THEN r.candles ELSE '[]'::jsonb END,'fetchedAt',CASE WHEN r.retain_until>v_now THEN r.fetched_at ELSE NULL END,
  'state',CASE WHEN r.expires_at>v_now THEN 'fresh' WHEN r.retain_until>v_now AND jsonb_array_length(r.candles)>0 THEN 'stale' WHEN r.retry_after>v_now THEN 'unavailable' ELSE 'refreshing' END,'reason',r.error_code);
END; $$;

CREATE FUNCTION public.intel_birdeye_chart_finish(p_chain text,p_address text,p_timeframe text,p_lease_id uuid,p_candles jsonb DEFAULT NULL,p_error text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE r public.intel_birdeye_chart_cache%ROWTYPE; v_now timestamptz:=clock_timestamp(); v_candles jsonb;
BEGIN
 p_address:=public.intel_market_address(p_address);
 SELECT * INTO r FROM public.intel_birdeye_chart_cache WHERE chain=p_chain AND token_address=p_address AND timeframe=p_timeframe FOR UPDATE;
 IF NOT FOUND OR p_lease_id IS NULL OR r.lease_id IS DISTINCT FROM p_lease_id OR r.lease_until<=v_now THEN RETURN jsonb_build_object('applied',false); END IF;
 IF p_error IS NULL AND p_candles IS NOT NULL THEN
  IF jsonb_typeof(p_candles)<>'array' OR jsonb_array_length(p_candles)>1000 OR octet_length(p_candles::text)>1048576 THEN RAISE EXCEPTION 'invalid_chart_payload'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_candles) b WHERE jsonb_typeof(b)<>'object' OR COALESCE(jsonb_typeof(b->'t'),'')<>'number' OR COALESCE(jsonb_typeof(b->'c'),'')<>'number') THEN RAISE EXCEPTION 'invalid_chart_bar'; END IF;
  -- Allowlist numeric market fields; discard arbitrary upstream/user text.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('t',b->'t','o',b->'o','h',b->'h','l',b->'l','c',b->'c','v',b->'v')),'[]') INTO v_candles FROM jsonb_array_elements(p_candles)b;
  UPDATE public.intel_birdeye_chart_cache SET candles=v_candles,fetched_at=v_now,expires_at=v_now+interval '2 minutes',retain_until=v_now+interval '6 hours',
   lease_id=NULL,lease_until=NULL,retry_after=NULL,error_code=NULL,updated_at=v_now
  WHERE chain=p_chain AND token_address=p_address AND timeframe=p_timeframe RETURNING * INTO r;
 ELSE
  UPDATE public.intel_birdeye_chart_cache SET lease_id=NULL,lease_until=NULL,retry_after=v_now+interval '1 minute',
   candles=CASE WHEN retain_until>v_now THEN candles ELSE '[]'::jsonb END,
   error_code=CASE WHEN p_error IN ('access_denied','rate_limited','missing_coverage','malformed_response','provider_unavailable') THEN p_error ELSE 'provider_unavailable' END,updated_at=v_now
  WHERE chain=p_chain AND token_address=p_address AND timeframe=p_timeframe RETURNING * INTO r;
 END IF;
 RETURN jsonb_build_object('applied',true,'candles',CASE WHEN r.retain_until>v_now THEN r.candles ELSE '[]'::jsonb END,
  'fetchedAt',CASE WHEN r.retain_until>v_now THEN r.fetched_at ELSE NULL END,'state',CASE WHEN r.expires_at>v_now AND r.error_code IS NULL THEN 'fresh' WHEN r.retain_until>v_now AND jsonb_array_length(r.candles)>0 THEN 'stale' ELSE 'unavailable' END,'reason',r.error_code);
END; $$;
REVOKE ALL ON FUNCTION public.intel_birdeye_chart_claim(text,text,text),public.intel_birdeye_chart_finish(text,text,text,uuid,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.intel_birdeye_chart_claim(text,text,text),public.intel_birdeye_chart_finish(text,text,text,uuid,jsonb,text) TO service_role;

DO $$ BEGIN IF to_regnamespace('cron') IS NOT NULL THEN
 PERFORM cron.schedule('intel-birdeye-chart-cache-retention','37 * * * *',$prune$
  DELETE FROM public.intel_birdeye_chart_cache WHERE updated_at<now()-interval '6 hours' AND COALESCE(lease_until<now(),true);
 $prune$);
END IF; END $$;
