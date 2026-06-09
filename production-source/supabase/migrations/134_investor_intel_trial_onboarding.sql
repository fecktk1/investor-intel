-- ============================================================
-- 134: Investor Intel — trial, onboarding & risk profile
-- ============================================================
-- P1: the free-trial creation path + per-investor preferences. The trial
-- workspace is created directly for an already-authenticated user (no upfront
-- payment, no invite-accept round-trip), distinct from the paid
-- claim_pending_signup flow which is left untouched.
--
--   - intel_user_profiles     : risk/experience/style + Beginner Protection (1:1 workspace)
--   - notification_preferences: channels + brief schedule (1:1 workspace)
--   - intel_trial_guards       : one-trial-per-identity backstop (service-only)
--   - start_intel_trial()      : creates the trial workspace atomically
--   - complete_intel_onboarding(): marks onboarding done for the active workspace
--
-- Trial mechanics: trial_ends_at = now()+N days (7 standard; 14 when a payment
-- method is added later). payment_required_since is set to trial_ends_at with
-- payment_grace_days = 0 so the existing payment gate flips straight to the
-- paywall the moment the trial ends (no silent free access).
-- ============================================================

-- ── intel_user_profiles ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS intel_user_profiles (
  org_id             uuid PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  user_id            uuid REFERENCES profiles(id) ON DELETE SET NULL,
  risk_tolerance     text CHECK (risk_tolerance IS NULL OR risk_tolerance IN ('conservative','balanced','aggressive')),
  experience_level   text CHECK (experience_level IS NULL OR experience_level IN ('new','intermediate','advanced')),
  explanation_style  text CHECK (explanation_style IS NULL OR explanation_style IN ('short','standard','deep')),
  chains_of_interest text[] NOT NULL DEFAULT '{}',
  topics_of_interest text[] NOT NULL DEFAULT '{}',
  brief_types        text[] NOT NULL DEFAULT '{}',
  beginner_protection boolean NOT NULL DEFAULT true,
  disclaimer_ack_at  timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- ── notification_preferences ─────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_preferences (
  org_id        uuid PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  user_id       uuid REFERENCES profiles(id) ON DELETE SET NULL,
  channels      jsonb NOT NULL DEFAULT '{"in_app":true,"email":false,"telegram":false}',
  brief_schedule text NOT NULL DEFAULT 'daily' CHECK (brief_schedule IN ('daily','weekdays','off')),
  quiet_hours   jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ── intel_trial_guards (one trial per identity; service-only) ─
CREATE TABLE IF NOT EXISTS intel_trial_guards (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_hash text NOT NULL UNIQUE,
  user_id       uuid REFERENCES profiles(id) ON DELETE SET NULL,
  org_id        uuid REFERENCES orgs(id) ON DELETE SET NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  metadata      jsonb NOT NULL DEFAULT '{}'
);

-- ── updated_at triggers ──────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['intel_user_profiles','notification_preferences'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON %1$s', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON %1$s FOR EACH ROW EXECUTE FUNCTION update_updated_at()', t);
  END LOOP;
END $$;

-- ── RLS ──────────────────────────────────────────────────────
ALTER TABLE intel_user_profiles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_trial_guards       ENABLE ROW LEVEL SECURITY;  -- no policies => service-role only

DO $$
DECLARE t text; prefix text;
BEGIN
  FOREACH t IN ARRAY ARRAY['intel_user_profiles','notification_preferences'] LOOP
    prefix := 'intel_' || left(replace(t, '_', ''), 20);
    EXECUTE format('DROP POLICY IF EXISTS "%s_select" ON %s', prefix, t);
    EXECUTE format('CREATE POLICY "%s_select" ON %s FOR SELECT USING (org_id = get_my_org_id())', prefix, t);

    EXECUTE format('DROP POLICY IF EXISTS "%s_insert" ON %s', prefix, t);
    EXECUTE format($p$CREATE POLICY "%s_insert" ON %s FOR INSERT WITH CHECK (org_id = get_my_org_id() AND get_my_role() IN ('owner','admin','editor'))$p$, prefix, t);

    EXECUTE format('DROP POLICY IF EXISTS "%s_update" ON %s', prefix, t);
    EXECUTE format($p$CREATE POLICY "%s_update" ON %s FOR UPDATE USING (org_id = get_my_org_id() AND get_my_role() IN ('owner','admin','editor'))$p$, prefix, t);
  END LOOP;
END $$;

-- ── start_intel_trial(): create a trial workspace for the caller ──
CREATE OR REPLACE FUNCTION start_intel_trial(p_display_name text DEFAULT NULL, p_trial_days int DEFAULT 7)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user      uuid := auth.uid();
  v_email     text;
  v_identity  text;
  v_hash      text;
  v_name      text;
  v_slug      text;
  v_org_id    uuid;
  v_trial_end timestamptz;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  SELECT email INTO v_email FROM auth.users WHERE id = v_user;
  v_identity := lower(coalesce(v_email, v_user::text));
  v_hash := md5('intel-trial:' || v_identity);

  -- One trial per identity (abuse backstop).
  IF EXISTS (SELECT 1 FROM intel_trial_guards WHERE identity_hash = v_hash) THEN
    RAISE EXCEPTION 'trial_already_used';
  END IF;

  v_trial_end := now() + make_interval(days => greatest(1, coalesce(p_trial_days, 7)));
  v_name := coalesce(nullif(btrim(p_display_name), ''),
                     split_part(coalesce(v_email, 'investor'), '@', 1) || '''s workspace');

  v_slug := 'intel-' || substr(md5(random()::text || clock_timestamp()::text), 1, 8);
  WHILE EXISTS (SELECT 1 FROM orgs WHERE slug = v_slug) LOOP
    v_slug := 'intel-' || substr(md5(random()::text || clock_timestamp()::text), 1, 8);
  END LOOP;

  INSERT INTO orgs (name, slug, product_mode, is_active, onboarding_completed, onboarding_step,
                    trial_ends_at, payment_required_since, payment_grace_days)
    VALUES (v_name, v_slug, 'intel', true, false, 0, v_trial_end, v_trial_end, 0)
    RETURNING id INTO v_org_id;

  INSERT INTO org_members (org_id, user_id, role) VALUES (v_org_id, v_user, 'owner');
  INSERT INTO intel_user_profiles (org_id, user_id) VALUES (v_org_id, v_user)
    ON CONFLICT (org_id) DO NOTHING;
  INSERT INTO notification_preferences (org_id, user_id) VALUES (v_org_id, v_user)
    ON CONFLICT (org_id) DO NOTHING;
  INSERT INTO intel_trial_guards (identity_hash, user_id, org_id) VALUES (v_hash, v_user, v_org_id);

  RETURN v_org_id;
END $$;

REVOKE EXECUTE ON FUNCTION start_intel_trial(text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION start_intel_trial(text, int) TO authenticated, service_role;

-- ── complete_intel_onboarding(): flip onboarding flag for active intel org ──
CREATE OR REPLACE FUNCTION complete_intel_onboarding()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE orgs SET onboarding_completed = true, onboarding_step = 0, updated_at = now()
   WHERE id = get_my_org_id() AND product_mode = 'intel';
END $$;

REVOKE EXECUTE ON FUNCTION complete_intel_onboarding() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION complete_intel_onboarding() TO authenticated, service_role;
