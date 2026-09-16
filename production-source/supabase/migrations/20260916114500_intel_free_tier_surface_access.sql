-- Investor Intel — the free access level, and per-surface entitlement.
--
-- WHAT THIS CHANGES
--
-- Until now the Investor Intel entitlement question was binary: can_access_intel
-- answered "may this account use Investor Intel at all", and a workspace whose
-- trial had lapsed answered false for everything. This migration keeps that
-- function exactly as it is and adds a SECOND, narrower question beside it:
-- "may this account use THIS surface". A free member passes the first question
-- and passes the second only for surfaces that cost us nothing to serve them.
--
-- THE SPLIT, AND WHY EACH SIDE IS WHERE IT IS
--
-- Free surfaces are already computed once, by a scheduled job, and stored in
-- our own tables. intel-markets reads market_assets and its enrichment tables
-- and never calls a provider. The capture lanes (regime, rank history, the RWA
-- universe, index constituents, liquidations, venue share, attention, airdrops,
-- network stats, new listings, meme graduation) are written by pg_cron on a
-- cadence held in provider_schedule_policy, for the whole platform at once. The
-- narrative briefs are global shared artifacts the refresh cron generates and
-- every reader reuses. Serving any of those to one more person adds no provider
-- credit, no model token and no compute: the work already happened.
--
-- Gated surfaces spend something PER MEMBER, on demand, at the moment that
-- member asks. On-demand research and connected investigation call the provider
-- with kind 'request' for that reader. Portfolio valuation reprices that
-- reader's positions and then synthesises over them. AI generation spends model
-- tokens per artifact per reader. Market history is one provider sampling per
-- requested range, charged to the shared credit budget. Alert evaluation runs
-- repeatedly, per rule, forever.
--
-- WHAT DOES NOT CHANGE
--
--   * can_access_intel keeps its current definition and its 16 SQL call sites.
--     intel_surface_allowed calls it and can only ever NARROW the answer.
--   * An org with no plan_overrides->>'intel_tier' still resolves to 'trial'
--     (the coalesce in intel_limit_for), and 'trial' ranks at the top of the
--     access ladder, so every existing trial, holder and paid workspace keeps
--     precisely the access it has today. Only a workspace explicitly marked
--     'free' is narrowed.
--   * Nothing here downgrades an existing workspace. intel_set_free_tier exists
--     for an operator and is wired to no automatic path.
--   * Limits are enforced BEFORE INSERT, as in 139 and 207, so a free tier can
--     never delete or prune a row that already exists.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- SECTION 1: the free tier's limit ladder.
-- Zero on every key whose consumption spends a provider credit, a model token
-- or recurring evaluation for one member. A small real allowance on the keys
-- that are only a stored list. refresh_minutes and history_days stay display
-- only, exactly as 207 left them.
-- Schema qualified: an unqualified name here resolves through search_path, and
-- seeding a plan ladder into whatever table happens to be found first is not a
-- failure that announces itself.
INSERT INTO public.intel_plan_limits (tier, key, value) VALUES
  ('free','watchlist_items',10),      ('free','tracked_wallets',0),   ('free','alerts_active',0),
  ('free','breakdowns_per_day',0),    ('free','briefs_per_day',0),    ('free','comparisons_per_day',0),
  ('free','explain_per_day',0),       ('free','comment_king_per_day',0),
  ('free','news_sources',0),          ('free','news_refreshes_per_day',0),
  ('free','portfolio_wallets',0),     ('free','narrative_follows',0),
  ('free','refresh_minutes',60),      ('free','history_days',0)
-- DO NOTHING, matching every provider_schedule_policy insert in this set: a later
-- edit to a row wins, so re-running this never resets one. DO UPDATE here would
-- hard-reset all 14 free-tier values and silently discard whatever an operator had
-- tuned them to. Production currently has ZERO free rows, so the first run seeds
-- all 14 either way; the difference is only what a REPLAY does.
ON CONFLICT (tier, key) DO NOTHING;

-- SECTION 2: the access ladder.
-- Separate from the limit ladder on purpose. 'trial' is the 7 day full product
-- trial, so it ranks with the top paid tier for ACCESS while keeping its own
-- much smaller volume limits from 207. An unrecognised or absent tier is read
-- as 'trial', which is what intel_limit_for already does, so no existing
-- workspace is narrowed by this migration.
CREATE OR REPLACE FUNCTION public.intel_tier_rank(p_tier text)
RETURNS int LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE lower(coalesce(nullif(btrim(p_tier), ''), 'trial'))
    WHEN 'free'    THEN 0
    WHEN 'starter' THEN 1
    WHEN 'pro'     THEN 2
    WHEN 'elite'   THEN 3
    WHEN 'trial'   THEN 3
    ELSE 3
  END;
$$;
COMMENT ON FUNCTION public.intel_tier_rank(text) IS
  'Access rank for an Investor Intel tier. Free is 0; trial and every unknown tier rank at the top so no existing workspace is narrowed.';
REVOKE EXECUTE ON FUNCTION public.intel_tier_rank(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.intel_tier_rank(text) TO authenticated, service_role;

-- SECTION 3: the surface catalogue.
-- The split lives in rows, not in code, so changing it is a reviewed migration
-- rather than a deploy. cost_basis records WHY a surface sits where it does.
CREATE TABLE IF NOT EXISTS public.intel_surface_tiers (
  surface     text PRIMARY KEY,
  min_tier    text NOT NULL CHECK (min_tier IN ('free','starter','pro','elite')),
  cost_basis  text NOT NULL CHECK (cost_basis IN ('precomputed_shared','per_member_on_demand')),
  reason      text NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- A surface that costs nothing extra per reader must not be sold, and a
  -- surface that spends for one reader must not be free. Keeping the two
  -- columns consistent in a constraint stops a future edit drifting them apart.
  CONSTRAINT intel_surface_tiers_cost_matches_gate CHECK (
    (cost_basis = 'precomputed_shared'   AND min_tier = 'free') OR
    (cost_basis = 'per_member_on_demand' AND min_tier <> 'free'))
);
ALTER TABLE public.intel_surface_tiers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.intel_surface_tiers FROM PUBLIC, anon;
-- The catalogue is not a secret: it is the price list. Members may read it so
-- the product can label a locked surface honestly. Only service_role writes.
DROP POLICY IF EXISTS intel_surface_tiers_read ON public.intel_surface_tiers;
CREATE POLICY intel_surface_tiers_read ON public.intel_surface_tiers FOR SELECT TO authenticated USING (true);
GRANT SELECT ON TABLE public.intel_surface_tiers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.intel_surface_tiers TO service_role;

INSERT INTO public.intel_surface_tiers (surface, min_tier, cost_basis, reason) VALUES
  ('market_boards',       'free',    'precomputed_shared',
   'intel-markets list and detail read market_assets and its enrichment tables only. The scheduled refresh already wrote those rows for everyone.'),
  ('market_regime',       'free',    'precomputed_shared',
   'intel_regime_snapshots is captured hourly for the whole platform by the capture cron.'),
  ('capture_views',       'free',    'precomputed_shared',
   'Every capture lane (rank history, RWA universe, index constituents, liquidations, venue share, attention, airdrops, network stats, new listings, meme graduation) is written once per cadence by pg_cron.'),
  ('chart_workstation',   'free',    'precomputed_shared',
   'The chart reads the archived candle store. Opening it replays bars that were already captured.'),
  ('narratives_read',     'free',    'precomputed_shared',
   'Narrative briefs are global shared artifacts the refresh cron generates and every reader reuses.'),
  ('watchlist',           'free',    'precomputed_shared',
   'A watchlist is a stored list of identifiers. Its volume is already bounded by the watchlist_items limit.'),
  ('research_on_demand',  'starter', 'per_member_on_demand',
   'intel-research calls the provider with kind request for the asking member, spending credits from the shared budget on their behalf.'),
  ('investigation',       'starter', 'per_member_on_demand',
   'Connected research runs the same on-demand provider path plus per-request normalisation and evidence retention.'),
  ('portfolio_valuation', 'starter', 'per_member_on_demand',
   'Portfolio research reprices that member positions and synthesises over them, spending provider and model budget per reader.'),
  ('ai_generation',       'starter', 'per_member_on_demand',
   'intel-generate spends model tokens per artifact per member.'),
  ('market_history',      'starter', 'per_member_on_demand',
   'One requested history range is one provider sampling, charged to the shared credit budget.'),
  ('alert_evaluation',    'starter', 'per_member_on_demand',
   'An alert rule is evaluated repeatedly for as long as it is active, so its cost recurs per member rather than being paid once.')
-- DO NOTHING, for the reason section 3 already gives: "The split lives in rows, not
-- in code." A replay that snapped all 12 surfaces back to the values in this file
-- would undercut exactly that, making the code the authority again whenever the
-- migration is re-applied. Moving a surface between tiers stays a reviewed
-- migration that UPDATEs the row it means to move.
ON CONFLICT (surface) DO NOTHING;

-- SECTION 4: the entitlement question, in two forms.
-- Fails closed in every direction: an account that cannot use Investor Intel at
-- all is refused, a surface the catalogue does not list is refused, and a
-- disabled row is refused. It can never widen can_access_intel.
--
-- THE THREE ARGUMENT FORM TAKES A CALLER SUPPLIED IDENTITY, so it is SERVICE
-- ROLE ONLY. Granted to `authenticated` it would be an entitlement oracle: any
-- signed-in member could ask it about any (user, org) pair and read back the
-- billing posture of a workspace they have nothing to do with. No content leaks
-- through it, but it is the same bug class as a function trusting a p_user the
-- caller chose, which this codebase has already had to close once.
--
-- The two argument form below is what `authenticated` gets. It takes no user
-- argument at all: the identity comes from auth.uid() and the membership is
-- verified against org_members, exactly as intel_account_access does in
-- section 5. A caller can therefore only ever ask about themselves.
--
-- The three argument form stays in `public` rather than moving to app_private
-- because a real service-role caller needs it over PostgREST, which only exposes
-- public: supabase/functions/_shared/intel/intel-surface-access.ts calls it with
-- the service key and an actor.userId it derived from a verified JWT itself.
-- `authenticated` cannot reach it because the GRANT below does not include it.
CREATE OR REPLACE FUNCTION public.intel_surface_allowed(p_user uuid, p_org uuid, p_surface text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_min text; v_enabled boolean; v_tier text;
BEGIN
  IF p_org IS NULL OR p_surface IS NULL THEN RETURN false; END IF;
  -- The existing product gate still decides whether Investor Intel is open at
  -- all. This function only ever narrows that answer.
  IF public.can_access_intel(p_user, p_org) IS NOT TRUE THEN RETURN false; END IF;
  SELECT min_tier, enabled INTO v_min, v_enabled
    FROM public.intel_surface_tiers WHERE surface = p_surface;
  IF NOT FOUND OR v_enabled IS NOT TRUE THEN RETURN false; END IF;
  SELECT plan_overrides->>'intel_tier' INTO v_tier FROM public.orgs WHERE id = p_org;
  RETURN public.intel_tier_rank(v_tier) >= public.intel_tier_rank(v_min);
END $$;
COMMENT ON FUNCTION public.intel_surface_allowed(uuid,uuid,text) IS
  'May this member use this Investor Intel surface. Narrows can_access_intel by the workspace tier and the surface catalogue; never widens it. Unknown surface, disabled row or no product access all answer false. SERVICE ROLE ONLY: it trusts the p_user it is handed, so granting it to authenticated would let any signed-in member probe the entitlement state of an arbitrary user and org. Signed-in callers use the two argument form, which derives the user from auth.uid().';
REVOKE EXECUTE ON FUNCTION public.intel_surface_allowed(uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.intel_surface_allowed(uuid,uuid,text) TO service_role;

-- The same question asked by the SIGNED-IN CALLER about THEMSELVES. This is the
-- only form `authenticated` may execute. It is modelled on intel_account_access
-- below: derive the user from the session, verify the membership, then answer.
CREATE OR REPLACE FUNCTION public.intel_surface_allowed(p_org uuid, p_surface text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL OR p_org IS NULL OR p_surface IS NULL THEN RETURN false; END IF;
  -- Not a member of this workspace is not a question this caller may ask.
  IF NOT EXISTS (SELECT 1 FROM public.org_members WHERE org_id = p_org AND user_id = v_user) THEN
    RETURN false;
  END IF;
  -- One implementation, not two: the decision itself stays in the form above so
  -- the two answers can never drift apart.
  RETURN public.intel_surface_allowed(v_user, p_org, p_surface);
END $$;
COMMENT ON FUNCTION public.intel_surface_allowed(uuid,text) IS
  'May the CALLER use this Investor Intel surface in this workspace. Takes no user argument: the identity is auth.uid() and the membership is verified against org_members, so a signed-in caller can only ever ask about themselves. Delegates the decision to the three argument form.';
REVOKE EXECUTE ON FUNCTION public.intel_surface_allowed(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.intel_surface_allowed(uuid,text) TO authenticated, service_role;

-- SECTION 5: one read the product can label itself with.
-- The client uses this to decide which surfaces to present as locked. It is a
-- LABEL, never the boundary: every gated read is refused again at the server.
CREATE OR REPLACE FUNCTION public.intel_account_access(p_org uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user uuid := auth.uid(); v_tier text; v_surfaces jsonb;
BEGIN
  IF v_user IS NULL OR p_org IS NULL THEN RETURN jsonb_build_object('tier', null, 'surfaces', '{}'::jsonb); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.org_members WHERE org_id = p_org AND user_id = v_user) THEN
    RETURN jsonb_build_object('tier', null, 'surfaces', '{}'::jsonb);
  END IF;
  SELECT coalesce(plan_overrides->>'intel_tier', 'trial') INTO v_tier FROM public.orgs WHERE id = p_org;
  SELECT coalesce(jsonb_object_agg(s.surface,
           jsonb_build_object(
             'allowed', public.intel_surface_allowed(v_user, p_org, s.surface),
             'minTier', s.min_tier,
             'costBasis', s.cost_basis)), '{}'::jsonb)
    INTO v_surfaces FROM public.intel_surface_tiers s WHERE s.enabled;
  RETURN jsonb_build_object('tier', v_tier, 'rank', public.intel_tier_rank(v_tier), 'surfaces', v_surfaces);
END $$;
COMMENT ON FUNCTION public.intel_account_access(uuid) IS
  'The caller tier and per-surface entitlement for one workspace, for labelling locked surfaces in the product. Not a trust boundary: every gated read is refused again at the server.';
REVOKE EXECUTE ON FUNCTION public.intel_account_access(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.intel_account_access(uuid) TO authenticated, service_role;

-- SECTION 6: creating a free workspace.
-- Modelled on start_intel_trial (134) and deliberately different in three ways:
--   * trial_ends_at and payment_required_since stay NULL, so
--     compute_org_payment_status never reports 'expired' and can_access_intel
--     keeps answering true. A free member is a member, not a lapsed one.
--   * intel_tier is written as 'free' up front, so intel_limit_for resolves the
--     free ladder rather than the trial ladder default.
--   * it does NOT write intel_trial_guards, so signing up free leaves the one
--     7 day trial per identity still available to take later.
-- A caller who already owns an Investor Intel workspace is handed that one back
-- rather than being given a second.
CREATE OR REPLACE FUNCTION public.start_intel_free(p_display_name text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user  uuid := auth.uid();
  v_email text;
  v_name  text;
  v_slug  text;
  v_org   uuid;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT o.id INTO v_org
    FROM public.orgs o
    JOIN public.org_members m ON m.org_id = o.id AND m.user_id = v_user
   WHERE o.product_mode = 'intel' AND o.deleted_at IS NULL
   ORDER BY o.created_at
   LIMIT 1;
  IF v_org IS NOT NULL THEN RETURN v_org; END IF;

  SELECT email INTO v_email FROM auth.users WHERE id = v_user;
  v_name := coalesce(nullif(btrim(p_display_name), ''),
                     split_part(coalesce(v_email, 'investor'), '@', 1) || '''s workspace');

  v_slug := 'intel-' || substr(md5(random()::text || clock_timestamp()::text), 1, 8);
  WHILE EXISTS (SELECT 1 FROM public.orgs WHERE slug = v_slug) LOOP
    v_slug := 'intel-' || substr(md5(random()::text || clock_timestamp()::text), 1, 8);
  END LOOP;

  INSERT INTO public.orgs (name, slug, product_mode, is_active, onboarding_completed, onboarding_step,
                           trial_ends_at, payment_required_since, payment_grace_days, plan_overrides)
    VALUES (v_name, v_slug, 'intel', true, false, 0,
            NULL, NULL, 0, jsonb_build_object('intel_tier', 'free'))
    RETURNING id INTO v_org;

  INSERT INTO public.org_members (org_id, user_id, role) VALUES (v_org, v_user, 'owner');
  INSERT INTO public.intel_user_profiles (org_id, user_id) VALUES (v_org, v_user) ON CONFLICT (org_id) DO NOTHING;
  INSERT INTO public.notification_preferences (org_id, user_id) VALUES (v_org, v_user) ON CONFLICT (org_id) DO NOTHING;

  RETURN v_org;
END $$;
REVOKE EXECUTE ON FUNCTION public.start_intel_free(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_intel_free(text) TO authenticated, service_role;

-- SECTION 7: an operator move to the free tier.
-- Deliberately service_role only and wired to NO automatic path. Converting a
-- lapsed trial into a free membership is a product decision with billing
-- consequences, so it stays a decision somebody makes rather than a job that
-- runs. It never touches a workspace with an active subscription.
CREATE OR REPLACE FUNCTION public.intel_set_free_tier(p_org uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_mode text;
BEGIN
  SELECT product_mode INTO v_mode FROM public.orgs WHERE id = p_org AND deleted_at IS NULL;
  IF v_mode IS DISTINCT FROM 'intel' THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public.org_subscriptions WHERE org_id = p_org AND status = 'active') THEN RETURN false; END IF;
  UPDATE public.orgs
     SET plan_overrides         = coalesce(plan_overrides, '{}'::jsonb) || jsonb_build_object('intel_tier', 'free'),
         payment_required_since = NULL,
         trial_ends_at          = NULL,
         is_active              = true,
         updated_at             = now()
   WHERE id = p_org;
  RETURN true;
END $$;
COMMENT ON FUNCTION public.intel_set_free_tier(uuid) IS
  'Operator move of one Investor Intel workspace to the free tier. Refuses a workspace with an active subscription. Wired to no automatic path by design.';
REVOKE EXECUTE ON FUNCTION public.intel_set_free_tier(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.intel_set_free_tier(uuid) TO service_role;
