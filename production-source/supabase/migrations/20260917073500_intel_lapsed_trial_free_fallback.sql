-- Investor Intel — a lapsed trial falls back to the free tier.
--
-- WHAT THIS CHANGES, AND WHY
--
-- 20260916114500 gave Investor Intel a free access level and a per-surface
-- catalogue, but it deliberately left the lapse path alone: a workspace whose
-- 7 day trial ran out still answers false to can_access_intel, so the product
-- is gone and the member meets a paywall with their watchlists, theses, saved
-- research and settings on the other side of it. intel_set_free_tier exists to
-- move such a workspace by hand and is wired to nothing.
--
-- The owner directive is that the lapse should land where a free signup lands:
-- the same workspace, the six precomputed surfaces open, the ten per member
-- surfaces locked with the same "Available to Starter members and above"
-- notice a free member sees, and nothing deleted, detached or hidden beyond
-- that gate. This migration is that fallback, expressed once, in SQL.
--
-- THE SHAPE OF THE CHANGE
--
-- Two small readers are added:
--
--   intel_trial_lapsed(org, status)  — is this an Investor Intel workspace
--     whose trial deadline has passed with nothing paid behind it?
--   intel_effective_tier(org)        — the tier the rest of the system should
--     read: the stored plan_overrides->>'intel_tier' normally, and 'free' when
--     the workspace above has lapsed.
--
-- and the four existing readers of plan_overrides->>'intel_tier' are pointed
-- at intel_effective_tier instead: intel_surface_allowed (the gate),
-- intel_account_access (the label), intel_limit_for and intel_limit (the
-- volume ladder). can_access_intel gains one branch: an expired workspace that
-- has lapsed into the free tier is a member again.
--
-- WHAT DOES NOT CHANGE, AND HOW THAT IS HELD
--
--   * intel_tier_rank is untouched. An absent tier still reads as 'trial' and
--     still ranks at the top, which is the ONLY reason a workspace in its
--     trial has the whole product today. The fallback therefore keys off
--     trial_ends_at being in the PAST, never off the tier being null, so an
--     active trial cannot be caught by it: intel_trial_lapsed returns false
--     while trial_ends_at > now().
--   * A workspace with a paid tier recorded (starter, pro, elite) is excluded
--     by name. This migration turns no paying or previously paying workspace
--     into a free one; it only catches a trial that was never paid for.
--   * A workspace still inside its payment grace window is excluded, because
--     the fallback additionally requires compute_org_payment_status to have
--     reached 'expired'. Narrowing somebody who still has grace left would be
--     a downgrade, not a rescue. (Every trial today carries grace 0, so in
--     practice the two moments are the same one.)
--   * Sparq holder workspaces are excluded by name: their access comes from
--     sparq_intel_access and a holder has no trial to lapse.
--   * Orgs that are not product_mode 'intel' are excluded by name and read
--     exactly as they did.
--   * A soft deleted org stays 'deleted' and stays out: the fallback requires
--     the status to be 'expired', which 'deleted' is not.
--   * Nothing here deletes, prunes, detaches or rewrites a single row of
--     member data. The free ladder from 20260916114500 is enforced BEFORE
--     INSERT only, so a watchlist, a thesis or an alert rule that already
--     exists survives the fallback untouched; the member simply cannot add
--     more of what the free tier does not include.
--   * compute_org_payment_status keeps its definition, so every non Intel
--     consumer of it is unaffected.
--
-- UPGRADING OUT OF THIS STATE
--
-- Nothing extra is needed. intel_activate_subscription (206) already UPDATEs
-- the SAME org row: it writes plan_overrides->>'intel_tier' and clears both
-- trial_ends_at and payment_required_since. The moment it runs,
-- intel_trial_lapsed answers false and intel_effective_tier returns the paid
-- tier, so a trial or free workspace upgrades in place with everything in it.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- SECTION 1: has this workspace's trial lapsed with nothing paid behind it?
--
-- p_status is an optional, already computed compute_org_payment_status for the
-- same org. can_access_intel has it in hand and passes it so the status is not
-- recomputed inside a function the RLS policies call on every row.
CREATE OR REPLACE FUNCTION public.intel_trial_lapsed(p_org uuid, p_status text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_mode text; v_trial timestamptz; v_stored text; v_status text := p_status;
BEGIN
  IF p_org IS NULL THEN RETURN false; END IF;
  SELECT product_mode, trial_ends_at, lower(nullif(btrim(plan_overrides->>'intel_tier'), ''))
    INTO v_mode, v_trial, v_stored
    FROM public.orgs WHERE id = p_org;
  IF NOT FOUND THEN RETURN false; END IF;
  -- Not an Investor Intel workspace: it has no Investor Intel tier to fall to.
  IF v_mode IS DISTINCT FROM 'intel' THEN RETURN false; END IF;
  -- THE KEY. An absent tier is what makes an ACTIVE trial work, so the lapse
  -- must be read from the deadline, never from the absence.
  IF v_trial IS NULL OR v_trial > now() THEN RETURN false; END IF;
  -- Something was bought. This is not a lapsed trial and must not be narrowed.
  IF v_stored IN ('starter', 'pro', 'elite') THEN RETURN false; END IF;
  -- A holder workspace is entitled through sparq_intel_access, not a trial.
  IF coalesce(public.sparq_is_holder_workspace(p_org, 'intel'), false) THEN RETURN false; END IF;
  IF v_status IS NULL THEN v_status := public.compute_org_payment_status(p_org); END IF;
  -- 'grace' still has time left and 'deleted' is not a lapse. An unreadable
  -- status (NULL, from app_private.can_read_org_metadata) leaves everything as
  -- it is today rather than inventing a membership.
  RETURN v_status = 'expired';
END $$;
COMMENT ON FUNCTION public.intel_trial_lapsed(uuid, text) IS
  'Has this Investor Intel workspace''s trial deadline passed with no paid tier behind it. Keyed off trial_ends_at being in the past, never off an absent tier, so an active trial is never caught. Excludes paid tiers, holder workspaces, non Intel orgs, orgs still in grace and deleted orgs.';
REVOKE EXECUTE ON FUNCTION public.intel_trial_lapsed(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.intel_trial_lapsed(uuid, text) TO service_role;

-- SECTION 2: the tier the rest of the system reads.
-- One definition, so the gate, the label and the volume ladder can never give
-- a workspace three different answers about what it is.
CREATE OR REPLACE FUNCTION public.intel_effective_tier(p_org uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_stored text;
BEGIN
  IF p_org IS NULL THEN RETURN NULL; END IF;
  SELECT nullif(btrim(plan_overrides->>'intel_tier'), '') INTO v_stored
    FROM public.orgs WHERE id = p_org;
  IF public.intel_trial_lapsed(p_org) THEN RETURN 'free'; END IF;
  -- NULL is returned unchanged on purpose: every caller coalesces it to
  -- 'trial', which is what an active trial, a holder and a legacy workspace
  -- all rely on.
  RETURN v_stored;
END $$;
COMMENT ON FUNCTION public.intel_effective_tier(uuid) IS
  'The Investor Intel tier to read for one workspace: the stored plan_overrides intel_tier, or free when the trial has lapsed with nothing paid behind it. NULL stays NULL so callers keep reading it as trial.';
REVOKE EXECUTE ON FUNCTION public.intel_effective_tier(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.intel_effective_tier(uuid) TO service_role;

-- SECTION 3: the product gate.
-- Identical to the live definition except for the one branch marked below.
-- Privileges survive CREATE OR REPLACE, so the 16 policies that call this keep
-- calling it with the grants they already have.
CREATE OR REPLACE FUNCTION public.can_access_intel(p_user uuid, p_org uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_mode text; v_status text;
BEGIN
  IF sparq_is_holder_workspace(p_org, 'intel') THEN RETURN sparq_intel_access(p_user, p_org); END IF;
  SELECT product_mode INTO v_mode FROM orgs WHERE id = p_org;
  v_status := compute_org_payment_status(p_org);
  -- THE FALLBACK. A trial that ran out with nothing paid behind it is a free
  -- membership, not a locked door. intel_surface_allowed then narrows this to
  -- the six precomputed surfaces, exactly as it does for a free signup.
  -- Nested rather than one condition so the extra reader is not called at all
  -- on the ordinary path: this function runs inside 16 row level policies.
  IF v_mode = 'intel' AND v_status = 'expired' THEN
    IF public.intel_trial_lapsed(p_org, v_status) THEN RETURN true; END IF;
  END IF;
  RETURN (v_mode = 'intel' AND v_status NOT IN ('expired','deleted')) OR sparq_intel_access(p_user, p_org);
END $$;
COMMENT ON FUNCTION public.can_access_intel(uuid, uuid) IS
  'May this account use Investor Intel in this workspace at all. True for an Intel workspace that is not expired or deleted, for a Sparq holder, and for a trial that has lapsed into the free tier (intel_trial_lapsed), whose surfaces intel_surface_allowed then narrows to the free six.';

-- SECTION 4: the per surface gate reads the effective tier.
-- The only line that changes is the tier lookup. Everything else, including
-- the SERVICE ROLE ONLY reasoning in 20260916114500, is unchanged.
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
  v_tier := public.intel_effective_tier(p_org);
  RETURN public.intel_tier_rank(v_tier) >= public.intel_tier_rank(v_min);
END $$;

-- SECTION 5: the label the product renders reads the same tier.
-- A lapsed trial must report 'free' here, or the app would draw a trial's
-- workspace around a free member's entitlements.
CREATE OR REPLACE FUNCTION public.intel_account_access(p_org uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user uuid := auth.uid(); v_tier text; v_surfaces jsonb;
BEGIN
  IF v_user IS NULL OR p_org IS NULL THEN RETURN jsonb_build_object('tier', null, 'surfaces', '{}'::jsonb); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.org_members WHERE org_id = p_org AND user_id = v_user) THEN
    RETURN jsonb_build_object('tier', null, 'surfaces', '{}'::jsonb);
  END IF;
  v_tier := coalesce(public.intel_effective_tier(p_org), 'trial');
  SELECT coalesce(jsonb_object_agg(s.surface,
           jsonb_build_object(
             'allowed', public.intel_surface_allowed(v_user, p_org, s.surface),
             'minTier', s.min_tier,
             'costBasis', s.cost_basis)), '{}'::jsonb)
    INTO v_surfaces FROM public.intel_surface_tiers s WHERE s.enabled;
  RETURN jsonb_build_object('tier', v_tier, 'rank', public.intel_tier_rank(v_tier), 'surfaces', v_surfaces);
END $$;

-- SECTION 6: the volume ladder reads the same tier.
-- Without this a lapsed trial would carry the trial's allowances while the
-- gate calls it free, which is the drift the two functions above exist to
-- prevent. The per key plan_overrides->'intel_limits' escape hatch is
-- untouched and still wins, so an operator override on one workspace survives.
-- Both are enforced BEFORE INSERT by the limit triggers, so moving to the free
-- ladder never removes a row that already exists.
CREATE OR REPLACE FUNCTION public.intel_limit_for(p_org uuid, p_key text)
RETURNS numeric LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tier text; v_over jsonb; v_val numeric;
BEGIN
  IF NOT app_private.can_read_org_metadata(p_org) THEN RETURN NULL; END IF;
  IF p_org IS NULL THEN RETURN NULL; END IF;
  SELECT plan_overrides->'intel_limits' INTO v_over FROM orgs WHERE id = p_org;
  IF v_over ? p_key THEN RETURN nullif(v_over->>p_key,'')::numeric; END IF;
  v_tier := coalesce(public.intel_effective_tier(p_org), 'trial');
  SELECT value INTO v_val FROM intel_plan_limits WHERE tier = v_tier AND key = p_key;
  RETURN v_val;
END $$;

CREATE OR REPLACE FUNCTION public.intel_limit(p_key text)
RETURNS numeric LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org   uuid := get_my_org_id();
  v_tier  text;
  v_over  jsonb;
  v_val   numeric;
BEGIN
  IF v_org IS NULL THEN RETURN NULL; END IF;
  SELECT plan_overrides->'intel_limits' INTO v_over FROM orgs WHERE id = v_org;
  IF v_over ? p_key THEN RETURN (v_over->>p_key)::numeric; END IF;
  v_tier := coalesce(public.intel_effective_tier(v_org), 'trial');
  SELECT value INTO v_val FROM intel_plan_limits WHERE tier = v_tier AND key = p_key;
  RETURN v_val;
END $$;
