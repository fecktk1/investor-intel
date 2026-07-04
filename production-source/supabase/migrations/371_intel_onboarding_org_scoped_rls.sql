-- ============================================================
-- 371: Investor Intel onboarding — authorize by org membership, not active org
-- ============================================================
-- Bug: a user who owns BOTH a content org and an Intel org (e.g. a SPARQ holder
-- who selected an investor tier + a brand tier — two workspaces provisioned in
-- the same transaction, so identical org_members.created_at) can get
-- permanently stuck on the Intel onboarding screen with:
--
--   new row violates row-level security policy for table "intel_user_profiles"
--
-- Why: the onboarding page writes intel_user_profiles / notification_preferences
-- with org_id = <the Intel workspace the client is showing>, but the RLS check
-- was `org_id = get_my_org_id()`, which resolves the caller's ACTIVE org from
-- auth metadata (raw_user_meta_data.active_org_id). For these dual-org holders
-- that metadata points at the CONTENT org (set at signup), and because the two
-- memberships tie on created_at the client can land directly on the Intel org
-- WITHOUT routing through /intel/start (the only place switchOrg re-aligns the
-- metadata). Active org (content) != the org being written (intel) => the write
-- is rejected and onboarding can never complete.
--
-- Fix: authorize these 1:1 per-workspace tables by DIRECT membership of the org
-- in the row, not by the caller's active org. A user may legitimately own more
-- than one workspace; they should be able to read/seed the profile of ANY org
-- they belong to (writes still gated to owner/admin/editor of that same org).
-- This mirrors the multi-org-safe RLS already used elsewhere (128, 251, 252).
--
-- complete_intel_onboarding() had the same active-org assumption baked in
-- (UPDATE ... WHERE id = get_my_org_id()), so even a successful profile write
-- would leave onboarding_completed = false. It now takes an explicit org id and
-- validates membership; the no-arg form still works (falls back to the active
-- org) for any legacy caller.
-- ============================================================

-- ── membership-scoped RLS (replaces the get_my_org_id() policies from 134) ──
DO $$
DECLARE t text; prefix text;
BEGIN
  FOREACH t IN ARRAY ARRAY['intel_user_profiles','notification_preferences'] LOOP
    prefix := 'intel_' || left(replace(t, '_', ''), 20);

    -- SELECT: any org you're a member of (or super admin).
    EXECUTE format('DROP POLICY IF EXISTS "%s_select" ON %s', prefix, t);
    EXECUTE format($p$CREATE POLICY "%1$s_select" ON %2$s FOR SELECT USING (
      EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = %2$s.org_id AND m.user_id = auth.uid())
      OR is_super_admin()
    )$p$, prefix, t);

    -- INSERT: owner/admin/editor of the specific org in the row.
    EXECUTE format('DROP POLICY IF EXISTS "%s_insert" ON %s', prefix, t);
    EXECUTE format($p$CREATE POLICY "%1$s_insert" ON %2$s FOR INSERT WITH CHECK (
      EXISTS (SELECT 1 FROM org_members m
              WHERE m.org_id = %2$s.org_id AND m.user_id = auth.uid()
                AND m.role IN ('owner','admin','editor'))
    )$p$, prefix, t);

    -- UPDATE: same authority for both the existing and the resulting row.
    EXECUTE format('DROP POLICY IF EXISTS "%s_update" ON %s', prefix, t);
    EXECUTE format($p$CREATE POLICY "%1$s_update" ON %2$s FOR UPDATE USING (
      EXISTS (SELECT 1 FROM org_members m
              WHERE m.org_id = %2$s.org_id AND m.user_id = auth.uid()
                AND m.role IN ('owner','admin','editor'))
    ) WITH CHECK (
      EXISTS (SELECT 1 FROM org_members m
              WHERE m.org_id = %2$s.org_id AND m.user_id = auth.uid()
                AND m.role IN ('owner','admin','editor'))
    )$p$, prefix, t);
  END LOOP;
END $$;

-- ── complete_intel_onboarding(org): flip onboarding for a specific Intel org ──
DROP FUNCTION IF EXISTS complete_intel_onboarding();
CREATE OR REPLACE FUNCTION complete_intel_onboarding(p_org_id uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org uuid := COALESCE(p_org_id, get_my_org_id());
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'no_org'; END IF;

  -- Must be a manager of the specific workspace being completed — not merely
  -- whatever org happens to be active in auth metadata.
  IF NOT EXISTS (
    SELECT 1 FROM org_members
    WHERE org_id = v_org AND user_id = auth.uid()
      AND role IN ('owner','admin','editor')
  ) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  UPDATE orgs SET onboarding_completed = true, onboarding_step = 0, updated_at = now()
   WHERE id = v_org AND product_mode = 'intel';
END $$;

REVOKE EXECUTE ON FUNCTION complete_intel_onboarding(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION complete_intel_onboarding(uuid) TO authenticated, service_role;
