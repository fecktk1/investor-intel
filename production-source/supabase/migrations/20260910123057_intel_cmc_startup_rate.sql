-- Verified account capacity, shared by every edge instance and worker.
-- Reserve 20% of RPM including a bounded initial burst. Baseline remains 30 RPM.
CREATE OR REPLACE FUNCTION public.cmc_take_rate(p_verified_rpm numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE v_budget numeric; v_burst numeric;
BEGIN
  IF p_verified_rpm IS NULL OR p_verified_rpm <= 0 THEN
    RETURN jsonb_build_object('allowed',false,'reason','account_unavailable');
  END IF;
  v_budget := LEAST(480,floor(p_verified_rpm*0.8));
  v_burst := LEAST(v_budget,GREATEST(1,LEAST(16,ceil(v_budget/60)*2)));
  IF p_verified_rpm=50 THEN v_burst:=5; v_budget:=35; END IF;
  RETURN provider_rate_take('coinmarketcap','cmc_requests',v_burst,GREATEST(0,v_budget-v_burst)/60,1);
END $$;
REVOKE ALL ON FUNCTION public.cmc_take_rate(numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cmc_take_rate(numeric) TO service_role;

CREATE OR REPLACE FUNCTION public.cmc_account_sync_claim(p_fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE v provider_quota_budgets%ROWTYPE; v_rate jsonb;
BEGIN
  SELECT * INTO v FROM provider_quota_budgets WHERE provider='coinmarketcap' AND data_type='cmc_account' FOR UPDATE;
  IF v.id IS NULL THEN RETURN jsonb_build_object('allowed',false,'reason','account_unavailable'); END IF;
  IF v.config->>'fingerprint'=p_fingerprint AND (v.config->>'verified_at')::timestamptz > now()-interval '5 minutes'
     AND (v.config->>'reset_at')::timestamptz > now() THEN
    RETURN jsonb_build_object('allowed',false,'reason','account_fresh');
  END IF;
  IF (v.config->>'sync_until')::timestamptz > now() THEN RETURN jsonb_build_object('allowed',false,'reason','account_refreshing'); END IF;
  v_rate := cmc_take_rate(CASE WHEN v.config->>'fingerprint'=p_fingerprint THEN COALESCE((v.config->>'rate_limit')::numeric,50) ELSE 50 END);
  IF NOT COALESCE((v_rate->>'allowed')::boolean,false) THEN RETURN jsonb_build_object('allowed',false,'reason','rate_limited'); END IF;
  UPDATE provider_quota_budgets SET config=config || jsonb_build_object('sync_until',now()+interval '30 seconds') WHERE id=v.id;
  RETURN jsonb_build_object('allowed',true);
END $$;

CREATE OR REPLACE FUNCTION public.cmc_request_reserve(p_fingerprint text,p_cache_key text,p_endpoint text,
  p_feature text,p_estimated numeric,p_cap numeric,p_feature_cap numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE a provider_quota_budgets%ROWTYPE; b provider_quota_budgets%ROWTYPE; f provider_quota_budgets%ROWTYPE;
  c market_data_response_cache%ROWTYPE; p market_data_providers%ROWTYPE; v_token uuid; v_rate jsonb; v_cap numeric;
BEGIN
  IF p_estimated < 0 OR p_cap <= 0 OR p_feature_cap <= 0 OR length(p_cache_key)>1000 THEN RETURN jsonb_build_object('allowed',false,'reason','invalid_budget'); END IF;
  SELECT * INTO a FROM provider_quota_budgets WHERE provider='coinmarketcap' AND data_type='cmc_account' FOR UPDATE;
  IF a.config->>'fingerprint' IS DISTINCT FROM p_fingerprint OR (a.config->>'verified_at')::timestamptz < now()-interval '15 minutes'
     OR (a.config->>'reset_at')::timestamptz <= now() OR a.config->>'verified_at' IS NULL THEN
    RETURN jsonb_build_object('allowed',false,'reason','account_unavailable');
  END IF;
  SELECT * INTO p FROM market_data_providers WHERE provider='coinmarketcap';
  IF p.provider IS NULL OR NOT p.enabled OR p.paused_until > now() OR p.rate_limited_until > now() THEN
    RETURN jsonb_build_object('allowed',false,'reason','provider_paused');
  END IF;
  INSERT INTO market_data_response_cache(provider,cache_key,endpoint,expires_at)
    VALUES('coinmarketcap',p_cache_key,p_endpoint,now()) ON CONFLICT(provider,cache_key) DO NOTHING;
  SELECT * INTO c FROM market_data_response_cache WHERE provider='coinmarketcap' AND cache_key=p_cache_key FOR UPDATE;
  IF c.expires_at > now() AND c.response_json IS NOT NULL THEN RETURN jsonb_build_object('allowed',false,'reason','cache_ready'); END IF;
  IF c.refresh_until > now() THEN RETURN jsonb_build_object('allowed',false,'reason','refreshing'); END IF;
  SELECT * INTO b FROM provider_quota_budgets WHERE provider='coinmarketcap' AND data_type='cmc_credits'
    AND period_start=(a.config->>'period_start')::timestamptz FOR UPDATE;
  IF b.id IS NULL THEN RETURN jsonb_build_object('allowed',false,'reason','account_unavailable'); END IF;
  v_cap := LEAST(p_cap,(a.config->>'credit_limit')::numeric*0.8);
  IF b.credits_used+b.credits_reserved+p_estimated>v_cap THEN RETURN jsonb_build_object('allowed',false,'reason','budget_exceeded'); END IF;
  INSERT INTO provider_quota_budgets(provider,data_type,period_start,period_end)
    VALUES('coinmarketcap','cmc_feature_credit:'||p_feature,b.period_start,b.period_end) ON CONFLICT(provider,data_type,period_start) DO NOTHING;
  SELECT * INTO f FROM provider_quota_budgets WHERE provider='coinmarketcap' AND data_type='cmc_feature_credit:'||p_feature AND period_start=b.period_start FOR UPDATE;
  IF f.credits_used+f.credits_reserved+p_estimated>p_feature_cap THEN RETURN jsonb_build_object('allowed',false,'reason','feature_budget_exceeded'); END IF;
  -- Account metadata controls the rate; environment tier labels cannot raise it.
  v_rate := cmc_take_rate((a.config->>'rate_limit')::numeric);
  IF NOT COALESCE((v_rate->>'allowed')::boolean,false) THEN RETURN jsonb_build_object('allowed',false,'reason','rate_limited'); END IF;
  INSERT INTO provider_budget_reservations(provider,data_type,period_start,cache_key,estimated_credits)
    VALUES('coinmarketcap',f.data_type,b.period_start,p_cache_key,p_estimated) RETURNING id INTO v_token;
  UPDATE provider_quota_budgets SET credits_reserved=credits_reserved+p_estimated,calls_used=calls_used+1,
    hard_cap=CASE WHEN id=b.id THEN v_cap ELSE p_feature_cap END,updated_at=now() WHERE id IN (b.id,f.id);
  UPDATE market_data_response_cache SET refresh_token=v_token,refresh_until=now()+interval '30 seconds' WHERE id=c.id;
  RETURN jsonb_build_object('allowed',true,'reservation_id',v_token);
END $$;
