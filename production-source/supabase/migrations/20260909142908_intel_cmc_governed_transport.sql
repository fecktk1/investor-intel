-- CMC uses the existing provider registry, quota ledger, rate lanes and response
-- cache. Reservations are operational receipts, not a second usage ledger.
ALTER TABLE public.provider_quota_budgets ADD COLUMN IF NOT EXISTS credits_reserved numeric NOT NULL DEFAULT 0;
ALTER TABLE public.market_data_response_cache
  ADD COLUMN IF NOT EXISTS observed_at timestamptz,
  ADD COLUMN IF NOT EXISTS fetched_at timestamptz,
  ADD COLUMN IF NOT EXISTS stale_until timestamptz,
  ADD COLUMN IF NOT EXISTS refresh_token uuid,
  ADD COLUMN IF NOT EXISTS refresh_until timestamptz,
  ADD COLUMN IF NOT EXISTS error_kind text;
ALTER TABLE public.market_data_response_cache
  ADD COLUMN IF NOT EXISTS capability text,
  ADD COLUMN IF NOT EXISTS request_params jsonb,
  ADD COLUMN IF NOT EXISTS access_profile text,
  ADD COLUMN IF NOT EXISTS demanded_at timestamptz,
  ADD COLUMN IF NOT EXISTS demand_org_id uuid,
  ADD COLUMN IF NOT EXISTS demand_user_id uuid;
CREATE INDEX IF NOT EXISTS cmc_response_cache_demand ON public.market_data_response_cache(demanded_at,expires_at)
  WHERE provider='coinmarketcap' AND demanded_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.provider_budget_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  data_type text NOT NULL,
  period_start timestamptz NOT NULL,
  cache_key text NOT NULL,
  estimated_credits numeric NOT NULL CHECK (estimated_credits >= 0),
  actual_credits numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  reconciled_at timestamptz
);
CREATE INDEX IF NOT EXISTS provider_budget_reservations_pending
  ON public.provider_budget_reservations(provider, period_start) WHERE reconciled_at IS NULL;
ALTER TABLE public.provider_budget_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.provider_budget_reservations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.provider_budget_reservations TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.market_data_providers, public.market_data_response_cache TO service_role;

INSERT INTO public.provider_quota_budgets(provider,data_type,period_start,period_end,config)
VALUES ('coinmarketcap','cmc_account','1970-01-01','3000-01-01','{}')
ON CONFLICT (provider,data_type,period_start) DO NOTHING;

-- Only one cold start may check key/info. This costs no credits, but still takes
-- an existing account rate-lane token. Failed syncs remain closed for 30 seconds.
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
  v_rate := provider_rate_take('coinmarketcap','cmc_requests',5,0.5,1);
  IF NOT COALESCE((v_rate->>'allowed')::boolean,false) THEN RETURN jsonb_build_object('allowed',false,'reason','rate_limited'); END IF;
  UPDATE provider_quota_budgets SET config=config || jsonb_build_object('sync_until',now()+interval '30 seconds') WHERE id=v.id;
  RETURN jsonb_build_object('allowed',true);
END $$;

CREATE OR REPLACE FUNCTION public.cmc_account_sync(p_fingerprint text,p_limit numeric,p_used numeric,p_reset_at timestamptz,p_rpm integer)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE v_start timestamptz := p_reset_at-interval '1 month';
BEGIN
  IF p_limit <= 0 OR p_used < 0 OR p_reset_at <= now() OR p_reset_at > now()+interval '35 days' OR p_rpm <= 0 THEN RETURN false; END IF;
  PERFORM id FROM provider_quota_budgets WHERE provider='coinmarketcap' AND data_type='cmc_account' FOR UPDATE;
  INSERT INTO provider_quota_budgets(provider,data_type,period_start,period_end,credits_used,config)
  VALUES('coinmarketcap','cmc_credits',v_start,p_reset_at,p_used,jsonb_build_object('fingerprint',p_fingerprint))
  ON CONFLICT(provider,data_type,period_start) DO UPDATE SET
    credits_used=GREATEST(provider_quota_budgets.credits_used,p_used), updated_at=now();
  UPDATE provider_quota_budgets SET config=jsonb_build_object('fingerprint',p_fingerprint,'verified_at',now(),
    'reset_at',p_reset_at,'period_start',v_start,'credit_limit',p_limit,'rate_limit',p_rpm),updated_at=now()
    WHERE provider='coinmarketcap' AND data_type='cmc_account';
  RETURN true;
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
  -- Shared five-request burst + 30 rpm refill, below verified Basic 50 rpm.
  v_rate := provider_rate_take('coinmarketcap','cmc_requests',5,LEAST(30,(a.config->>'rate_limit')::numeric*0.8)/60,1);
  IF NOT COALESCE((v_rate->>'allowed')::boolean,false) THEN RETURN jsonb_build_object('allowed',false,'reason','rate_limited'); END IF;
  INSERT INTO provider_budget_reservations(provider,data_type,period_start,cache_key,estimated_credits)
    VALUES('coinmarketcap',f.data_type,b.period_start,p_cache_key,p_estimated) RETURNING id INTO v_token;
  UPDATE provider_quota_budgets SET credits_reserved=credits_reserved+p_estimated,calls_used=calls_used+1,
    hard_cap=CASE WHEN id=b.id THEN v_cap ELSE p_feature_cap END,updated_at=now() WHERE id IN (b.id,f.id);
  UPDATE market_data_response_cache SET refresh_token=v_token,refresh_until=now()+interval '30 seconds' WHERE id=c.id;
  RETURN jsonb_build_object('allowed',true,'reservation_id',v_token);
END $$;

CREATE OR REPLACE FUNCTION public.cmc_request_reconcile(p_reservation uuid,p_actual numeric,p_status integer,p_error_kind text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE r provider_budget_reservations%ROWTYPE; v_actual numeric;
BEGIN
  -- Same lock order as reserve/sync. Concurrent reconciliation cannot double debit.
  PERFORM id FROM provider_quota_budgets WHERE provider='coinmarketcap' AND data_type='cmc_account' FOR UPDATE;
  SELECT * INTO r FROM provider_budget_reservations WHERE id=p_reservation AND provider='coinmarketcap' FOR UPDATE;
  IF r.id IS NULL THEN RETURN false; END IF;
  IF r.reconciled_at IS NOT NULL THEN RETURN true; END IF;
  v_actual := CASE WHEN p_actual IS NULL OR p_actual<0 THEN r.estimated_credits ELSE p_actual END;
  UPDATE provider_quota_budgets SET credits_reserved=GREATEST(0,credits_reserved-r.estimated_credits),
    credits_used=credits_used+v_actual,updated_at=now() WHERE provider='coinmarketcap' AND period_start=r.period_start
    AND data_type IN ('cmc_credits',r.data_type);
  UPDATE provider_budget_reservations SET actual_credits=v_actual,reconciled_at=now() WHERE id=r.id;
  UPDATE market_data_response_cache SET refresh_token=NULL,refresh_until=NULL WHERE refresh_token=r.id;
  UPDATE market_data_providers SET last_status=p_status,
    last_ok_at=CASE WHEN p_status=200 THEN now() ELSE last_ok_at END,
    last_error_at=CASE WHEN p_status<>200 THEN now() ELSE last_error_at END,
    last_error=p_error_kind,
    consecutive_failures=CASE WHEN p_status=200 THEN 0 ELSE consecutive_failures+1 END,
    rate_limited_until=CASE WHEN p_status=429 OR p_status>=500 OR p_status=0 THEN now()+interval '60 seconds' ELSE rate_limited_until END,
    updated_at=now() WHERE provider='coinmarketcap';
  -- A response with unknown credit usage freezes discretionary spend until sync.
  IF p_actual IS NULL THEN UPDATE provider_quota_budgets SET config=config-'verified_at'
    WHERE provider='coinmarketcap' AND data_type='cmc_account'; END IF;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.cmc_account_sync_claim(text),public.cmc_account_sync(text,numeric,numeric,timestamptz,integer),
  public.cmc_request_reserve(text,text,text,text,numeric,numeric,numeric),public.cmc_request_reconcile(uuid,numeric,integer,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cmc_account_sync_claim(text),public.cmc_account_sync(text,numeric,numeric,timestamptz,integer),
  public.cmc_request_reserve(text,text,text,text,numeric,numeric,numeric),public.cmc_request_reconcile(uuid,numeric,integer,text) TO service_role;
