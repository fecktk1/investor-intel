-- Investor Intel: successive CoinMarketCap account observations, so cadence can be calibrated from a measured
-- burn rate instead of a constant.
--
-- Today every ceiling in the stack is a fixed table: cmcCreditCeiling() multiplies a per-plan constant by 0.8 and
-- CMC_FEATURE_CAPS scales a per-feature share of it. Those stay exactly as they are, and this migration does not
-- touch cmc_request_reserve: the reservation ledger remains the one place a call is actually refused. What is
-- missing is a MEASUREMENT. cmc_account_sync overwrites the cmc_account row with the newest provider figures, so
-- the platform can see the current balance but never how fast it is falling.
--
-- One sentinel row, data_type 'cmc_account_observation', keeps a bounded ring of the last 24 observations of the
-- provider's own credits_used with the reset instant each was taken against. Deltas between successive entries are
-- a real burn rate. supabase/functions/_shared/intel/budget-calibration.ts turns that rate into a multiplier that
-- STRETCHES a reviewed cadence it cannot sustain to the reset, and never shortens one: the plan target table stays
-- the fastest rate anybody reviewed.
--
-- What this deliberately does NOT do:
--   * It never infers a plan. cmcPlan() in _shared/market-assets/cmc-transport.ts stays the only plan authority and
--     says why: an explicitly verified profile, never a tier inferred from a key or a credit balance. The
--     fingerprint below is an argument only so that a different key RESTARTS the series instead of two budgets
--     being drawn as one slope; it is compared, stored to scope the series, and never returned by any reader.
--   * It adds no provider call. cmc_account_observe is called from syncAccount immediately after the /v1/key/info
--     read that already happened, and its failure is swallowed there: an account sync must never fail because an
--     advisory observation could not be appended.
--   * It creates no new table and no new grantable surface: provider_quota_budgets already carries the cmc_account
--     and cmc_operating_profile sentinel rows under the same service-role-only policy.

-- The same bound every other file in this set carries: wait five seconds for a
-- lock and fail rather than queue behind a long transaction.
SET LOCAL lock_timeout='5s';

INSERT INTO public.provider_quota_budgets(provider,data_type,period_start,period_end,config)
VALUES ('coinmarketcap','cmc_account_observation','1970-01-01','3000-01-01','{"observations":[]}'::jsonb)
ON CONFLICT (provider,data_type,period_start) DO NOTHING;

CREATE OR REPLACE FUNCTION public.cmc_account_observe(p_fingerprint text,p_limit numeric,p_used numeric,p_reset_at timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE v provider_quota_budgets%ROWTYPE; v_same boolean; v_list jsonb;
BEGIN
  -- The same admission rules cmc_account_sync applies, so an implausible figure never enters the series.
  IF p_fingerprint IS NULL OR length(p_fingerprint) < 8 OR p_limit <= 0 OR p_used < 0 OR p_reset_at IS NULL
     OR p_reset_at <= now() OR p_reset_at > now()+interval '35 days' THEN RETURN false; END IF;
  SELECT * INTO v FROM provider_quota_budgets
    WHERE provider='coinmarketcap' AND data_type='cmc_account_observation' FOR UPDATE;
  IF v.id IS NULL THEN RETURN false; END IF;
  -- A different key is a different budget, and a slope drawn across two of them would be a fiction.
  v_same := v.config->>'fingerprint' IS NOT DISTINCT FROM p_fingerprint;
  v_list := CASE WHEN v_same THEN COALESCE(v.config->'observations','[]'::jsonb) ELSE '[]'::jsonb END;
  v_list := v_list || jsonb_build_array(jsonb_build_object(
    'at',to_jsonb(now()),'used',p_used,'limit',p_limit,'resetAt',to_jsonb(p_reset_at)));
  -- Bounded ring. Twenty-four entries is two hours of five-minute syncs: more than the calibrator reads, and small
  -- enough that this row stays a jsonb rather than becoming a history table nobody prunes.
  IF jsonb_array_length(v_list) > 24 THEN
    SELECT COALESCE(jsonb_agg(t.e ORDER BY t.n),'[]'::jsonb) INTO v_list
      FROM (SELECT e,n FROM jsonb_array_elements(v_list) WITH ORDINALITY AS x(e,n)
            ORDER BY n OFFSET GREATEST(0,jsonb_array_length(v_list)-24)) t;
  END IF;
  UPDATE provider_quota_budgets
    SET config=jsonb_build_object('fingerprint',p_fingerprint,'observations',v_list),updated_at=now()
    WHERE id=v.id;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.cmc_account_observe(text,numeric,numeric,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cmc_account_observe(text,numeric,numeric,timestamptz) TO service_role;

-- The multiplier last applied, so one read can only move the cadence by a bounded step instead of jumping straight
-- to the ceiling the first time a burst is measured. It is written on the same sentinel row but merged key by key,
-- never as a whole-config rewrite, so a concurrent cmc_account_observe cannot lose an observation to this write.
-- A recorded scale is advisory: losing it costs a slower ramp, never a faster cadence.
CREATE OR REPLACE FUNCTION public.cmc_cadence_scale_record(p_scale numeric)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  IF p_scale IS NULL OR p_scale < 1 OR p_scale > 64 THEN RETURN false; END IF;
  UPDATE provider_quota_budgets
    SET config=COALESCE(config,'{}'::jsonb) || jsonb_build_object('scale',p_scale,'scale_at',to_jsonb(now())),updated_at=now()
    WHERE provider='coinmarketcap' AND data_type='cmc_account_observation';
  RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION public.cmc_cadence_scale_record(numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cmc_cadence_scale_record(numeric) TO service_role;
