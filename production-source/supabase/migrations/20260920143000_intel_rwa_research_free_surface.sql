-- Investor Intel — the real-world asset workspace, opened to free members.
--
-- WHAT THIS CHANGES
--
-- /intel/rwa was gated behind research_on_demand, the same surface that opens
-- market discovery, market structure and market context. Those three stay
-- exactly where they are. Only the RWA workspace moves, onto a surface of its
-- own (rwa_research) whose minimum tier is 'free'.
--
-- WHY THE RWA READS CAN BE GIVEN AWAY AND THE OTHER THREE CANNOT
--
-- The RWA capabilities are a small, fixed, slow-moving set: the asset list per
-- asset type, one asset's info and quotes, its market pairs, the issuer list and
-- one issuer. Six requests, all of them public facts about the same few hundred
-- tokenised instruments, all of them keyed in the shared response cache by their
-- exact parameters. A second reader asking the same question inside the TTL is
-- answered from that shared row and costs nothing. The hourly RWA capture lane
-- already refreshes the universe for the whole platform.
--
-- That is NOT the same claim as 'precomputed_shared'. A free reader who asks for
-- a page nobody has asked for yet still has to be answered from somewhere, and
-- the honest answer is that we allow a bounded number of live reads a day for
-- the whole free tier and serve the retained row once that is spent. So this
-- migration adds a THIRD cost basis rather than lying with the existing two.
--
-- cost_basis = 'shared_budgeted' means, precisely:
--   * the read is shared through the response cache, so the marginal cost of one
--     more reader inside the TTL is zero, AND
--   * a read that cannot be answered from the cache is additionally capped by a
--     dedicated daily platform-wide credit budget, so the worst case is bounded
--     no matter how many free members page through how many identifiers.
--
-- Both halves are required. A surface that is only shared (no cap) could still
-- be drained by a visitor walking thousands of ids; a surface that is only
-- capped is a race rather than a product. The constraint below therefore pins
-- 'shared_budgeted' to min_tier 'free' exactly as the other two bases are
-- pinned, so this basis cannot be used to sell something either.
--
-- WHAT DOES NOT CHANGE
--
--   * research_on_demand keeps its row, its tier and its reason. Discovery,
--     structure and context are refused for a free member exactly as today.
--   * No existing row in intel_surface_tiers is rewritten. The CHECK is widened,
--     never narrowed, so every row that satisfied it still does.
--   * Starter and above never reach the budgeted lane at all: they hold
--     research_on_demand, and the Edge Function keeps them on the existing
--     demand path with the existing monthly feature budget.
--   * The free lane cannot raise the account ceiling. cmc_request_reserve still
--     runs on every live call and still refuses on the monthly credit cap, the
--     rwa feature cap and the rate limiter. This budget only ever SUBTRACTS.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- SECTION 1: the third cost basis.
-- Drop-then-add so a replay is a no-op rather than a duplicate-object error.
-- intel_surface_tiers holds a couple of dozen rows, so the validating scan
-- behind ADD CONSTRAINT is immediate; lock_timeout above bounds the wait for
-- the ACCESS EXCLUSIVE lock rather than letting it queue behind a reader.
ALTER TABLE public.intel_surface_tiers
  DROP CONSTRAINT IF EXISTS intel_surface_tiers_cost_matches_gate;
ALTER TABLE public.intel_surface_tiers
  ADD CONSTRAINT intel_surface_tiers_cost_matches_gate CHECK (
    (cost_basis = 'precomputed_shared'   AND min_tier = 'free') OR
    (cost_basis = 'shared_budgeted'      AND min_tier = 'free') OR
    (cost_basis = 'per_member_on_demand' AND min_tier <> 'free'));
COMMENT ON TABLE public.intel_surface_tiers IS
  'Which Investor Intel surface opens at which tier, and why. cost_basis records the reason: precomputed_shared (a scheduled job already did the work for everyone), shared_budgeted (the read is shared through the provider response cache AND a live miss is capped by a dedicated daily platform budget), per_member_on_demand (it spends for one member at the moment they ask). The CHECK keeps the two columns from drifting apart: the first two bases may only ever be free, the third may never be.';

-- SECTION 2: the surface itself.
-- DO NOTHING for the reason the original catalogue migration gives: the split
-- lives in rows, so moving a surface stays a reviewed migration that UPDATEs the
-- row it means to move, and a replay never resets an operator's edit.
INSERT INTO public.intel_surface_tiers (surface, min_tier, cost_basis, reason) VALUES
  ('rwa_research', 'free', 'shared_budgeted',
   'The real-world asset workspace reads six fixed CoinMarketCap capabilities (rwaList, rwaInfo, rwaQuotes, rwaPairs, issuers, issuer) about a few hundred tokenised instruments. Every one is keyed in the shared response cache by its exact parameters and refreshed hourly for the whole platform by the RWA capture lane, so one more reader inside the TTL costs nothing. A read that misses the cache is served live only inside the dedicated daily free-tier budget below, and falls back to the retained row with its capture time once that is spent.')
ON CONFLICT (surface) DO NOTHING;

-- SECTION 3: the budget, as DATA.
-- The cap is a row, not a constant in a function, so raising or lowering it is
-- an operator UPDATE rather than a deploy. It lives beside the CoinMarketCap
-- operating profile in the same service-only ledger, in the same shape: one
-- sentinel period for policy, one row per real period for consumption.
--
-- 200 credits a day is deliberately small. Every RWA capability estimates at one
-- credit per request (cost '250' over a 25 or 250 row page, or a flat one), so
-- this is on the order of 200 live RWA reads a day for the entire free tier,
-- against an rwa feature ceiling of 45,000 a month. Cache hits are NOT counted
-- against it, so in steady state the lane spends a few dozen credits a day
-- refreshing pages people actually open and the rest is headroom.
--
-- 'enabled' is a kill switch that needs no deploy: turned off, the free lane
-- serves retained rows only and Starter is untouched.
INSERT INTO public.provider_quota_budgets (provider, data_type, period_start, period_end, config) VALUES
  ('coinmarketcap', 'cmc_free_rwa_policy', '1970-01-01T00:00:00Z', '3000-01-01T00:00:00Z',
   jsonb_build_object('daily_credit_cap', '200', 'enabled', 'true'))
ON CONFLICT (provider, data_type, period_start) DO NOTHING;

-- SECTION 4: the claim.
--
-- One live provider read for a member who does NOT hold research_on_demand.
-- Called by the Edge Function with the service key, only after the shared cache
-- has already been asked and had nothing usable.
--
-- FAILS CLOSED IN EVERY DIRECTION. A missing policy row, a disabled lane, a cap
-- of zero, an unparseable cap and a spent day all answer allowed:false, and the
-- caller then serves the retained row or the calm not-read-yet state. There is
-- no branch that returns an allow by default.
--
-- CHARGED ON CLAIM, NOT RECONCILED. This is a safety valve, not an accounting
-- ledger: cmc_request_reserve remains the one place real spending is reserved
-- and reconciled against the account. Counting the estimate here the moment it
-- is handed out means a call that then fails still consumed its slot, which is
-- the conservative direction. p_credits is bounded so a caller cannot charge an
-- arbitrary amount, and the RWA estimates are all 1.
CREATE OR REPLACE FUNCTION public.intel_free_rwa_read_claim(p_capability text, p_credits numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_policy provider_quota_budgets%ROWTYPE;
  v_day    provider_quota_budgets%ROWTYPE;
  v_cap    numeric;
  v_start  timestamptz;
BEGIN
  IF p_capability IS NULL OR length(p_capability) > 64 THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'invalid_budget');
  END IF;
  -- A negative or absurd charge is a bug, not a request to be honoured.
  IF p_credits IS NULL OR p_credits < 0 OR p_credits > 25 THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'invalid_budget');
  END IF;

  SELECT * INTO v_policy FROM provider_quota_budgets
   WHERE provider = 'coinmarketcap' AND data_type = 'cmc_free_rwa_policy'
     AND period_start = '1970-01-01T00:00:00Z';
  IF v_policy.id IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'free_rwa_policy_unavailable');
  END IF;
  IF lower(coalesce(v_policy.config->>'enabled', 'true')) IN ('false', '0', 'off') THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'free_rwa_lane_disabled');
  END IF;
  -- An unreadable cap is a zero cap, never an unlimited one.
  BEGIN
    v_cap := coalesce((v_policy.config->>'daily_credit_cap')::numeric, 0);
  EXCEPTION WHEN others THEN
    v_cap := 0;
  END;
  IF v_cap IS NULL OR v_cap <= 0 THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'free_rwa_budget_exhausted', 'cap', 0);
  END IF;

  -- UTC days, so the window is the same one the capture cadence and the provider
  -- credit period are read in, and it does not move with a server locale.
  v_start := date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  INSERT INTO provider_quota_budgets (provider, data_type, period_start, period_end)
    VALUES ('coinmarketcap', 'cmc_free_rwa_daily', v_start, v_start + interval '1 day')
    ON CONFLICT (provider, data_type, period_start) DO NOTHING;
  SELECT * INTO v_day FROM provider_quota_budgets
   WHERE provider = 'coinmarketcap' AND data_type = 'cmc_free_rwa_daily' AND period_start = v_start
   FOR UPDATE;
  IF v_day.id IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'free_rwa_policy_unavailable');
  END IF;

  IF v_day.credits_used + p_credits > v_cap THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'free_rwa_budget_exhausted',
                              'cap', v_cap, 'used', v_day.credits_used);
  END IF;

  UPDATE provider_quota_budgets
     SET credits_used = credits_used + p_credits,
         calls_used   = calls_used + 1,
         hard_cap     = v_cap,
         updated_at   = now()
   WHERE id = v_day.id;

  RETURN jsonb_build_object('allowed', true, 'cap', v_cap, 'used', v_day.credits_used + p_credits);
END $$;
COMMENT ON FUNCTION public.intel_free_rwa_read_claim(text, numeric) IS
  'One live CoinMarketCap real-world-asset read for a member without research_on_demand, inside the daily platform-wide free-tier budget held in the cmc_free_rwa_policy row. Charged on claim and never reconciled: it is a bound, not an accounting ledger, and cmc_request_reserve still reserves and reconciles the real spend. Fails closed on a missing policy row, a disabled lane, an unreadable or zero cap and a spent day. SERVICE ROLE ONLY.';
-- No member ever calls this: a signed-in caller could otherwise burn the whole
-- free tier's daily budget without ever reading anything.
REVOKE EXECUTE ON FUNCTION public.intel_free_rwa_read_claim(text, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.intel_free_rwa_read_claim(text, numeric) TO service_role;
