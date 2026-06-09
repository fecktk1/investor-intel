-- ============================================================
-- 138: Investor Intel — super-admin controls + cost governance
-- ============================================================
-- Section G: real admin CONTROLS (not just a read-only view):
--   - grant/revoke Intel access, manage trials & tiers
--   - per-workspace cost cap + a global kill switch
--   - cost tracking (via ai_usage surface='investor_intel') + trial-abuse view
-- All admin RPCs are SECURITY DEFINER and hard-gated on is_super_admin().
-- intel_generation_allowed() is the per-request gate the edge fns call.
-- ============================================================

-- Global config (singleton row id=1).
CREATE TABLE IF NOT EXISTS intel_global_config (
  id                  int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  kill_switch         boolean NOT NULL DEFAULT false,   -- emergency stop on all Intel generation
  default_cost_cap_usd numeric,                          -- per-workspace monthly cap when no override (NULL = none)
  default_trial_days  int NOT NULL DEFAULT 7,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid REFERENCES profiles(id) ON DELETE SET NULL
);
INSERT INTO intel_global_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
ALTER TABLE intel_global_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS intel_global_config_read ON intel_global_config;
CREATE POLICY intel_global_config_read ON intel_global_config FOR SELECT USING (true);

-- ── per-request gate (kill switch + monthly cost cap + access) ──
CREATE OR REPLACE FUNCTION intel_generation_allowed()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org uuid := get_my_org_id();
  v_kill boolean; v_cap numeric; v_used numeric := 0; v_over jsonb; v_mode text;
BEGIN
  IF v_org IS NULL THEN RETURN jsonb_build_object('allowed', false, 'reason', 'no_org'); END IF;
  SELECT kill_switch, default_cost_cap_usd INTO v_kill, v_cap FROM intel_global_config WHERE id = 1;
  IF coalesce(v_kill, false) THEN RETURN jsonb_build_object('allowed', false, 'reason', 'kill_switch'); END IF;

  SELECT product_mode, plan_overrides INTO v_mode, v_over FROM orgs WHERE id = v_org;
  IF v_mode IS DISTINCT FROM 'intel' THEN RETURN jsonb_build_object('allowed', false, 'reason', 'not_intel'); END IF;

  -- per-workspace cap overrides the global default
  IF v_over ? 'intel_cost_cap_usd' THEN v_cap := nullif(v_over->>'intel_cost_cap_usd','')::numeric; END IF;

  IF v_cap IS NOT NULL THEN
    BEGIN
      SELECT coalesce(sum(est_cost_usd), 0) INTO v_used FROM ai_usage
        WHERE org_id = v_org AND surface = 'investor_intel' AND created_at >= date_trunc('month', now());
    EXCEPTION WHEN others THEN v_used := 0; END;
    IF v_used >= v_cap THEN
      RETURN jsonb_build_object('allowed', false, 'reason', 'cost_cap', 'used', v_used, 'cap', v_cap);
    END IF;
  END IF;
  RETURN jsonb_build_object('allowed', true, 'used', v_used, 'cap', v_cap);
END $$;
REVOKE EXECUTE ON FUNCTION intel_generation_allowed() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION intel_generation_allowed() TO authenticated, service_role;

-- ── admin: grant Intel access to a user (create/comp a workspace) ──
CREATE OR REPLACE FUNCTION intel_admin_grant_user(p_email text, p_tier text DEFAULT 'pro', p_trial_days int DEFAULT 7, p_comp boolean DEFAULT false)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user uuid; v_org uuid; v_slug text; v_end timestamptz;
BEGIN
  IF NOT is_super_admin() THEN RAISE EXCEPTION 'forbidden'; END IF;
  SELECT id INTO v_user FROM auth.users WHERE lower(email) = lower(p_email) LIMIT 1;
  IF v_user IS NULL THEN RAISE EXCEPTION 'user_not_found'; END IF;

  v_slug := 'intel-' || substr(md5(random()::text || clock_timestamp()::text), 1, 8);
  WHILE EXISTS (SELECT 1 FROM orgs WHERE slug = v_slug) LOOP
    v_slug := 'intel-' || substr(md5(random()::text || clock_timestamp()::text), 1, 8);
  END LOOP;
  v_end := CASE WHEN p_comp THEN NULL ELSE now() + make_interval(days => greatest(1, coalesce(p_trial_days, 7))) END;

  INSERT INTO orgs (name, slug, product_mode, is_active, onboarding_completed, onboarding_step,
                    trial_ends_at, payment_required_since, payment_grace_days, bypass_payment, plan_overrides)
    VALUES (split_part(p_email, '@', 1) || '''s workspace', v_slug, 'intel', true, false, 0,
            v_end, v_end, 0, coalesce(p_comp, false),
            jsonb_build_object('intel_tier', coalesce(p_tier, 'pro')))
    RETURNING id INTO v_org;

  INSERT INTO org_members (org_id, user_id, role) VALUES (v_org, v_user, 'owner');
  INSERT INTO intel_user_profiles (org_id, user_id) VALUES (v_org, v_user) ON CONFLICT (org_id) DO NOTHING;
  INSERT INTO notification_preferences (org_id, user_id) VALUES (v_org, v_user) ON CONFLICT (org_id) DO NOTHING;
  RETURN v_org;
END $$;

-- ── admin: manage an existing Intel workspace ──
CREATE OR REPLACE FUNCTION intel_admin_revoke(p_org_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_super_admin() THEN RAISE EXCEPTION 'forbidden'; END IF;
  UPDATE orgs SET product_mode = 'content', updated_at = now() WHERE id = p_org_id AND product_mode = 'intel';
END $$;

CREATE OR REPLACE FUNCTION intel_admin_set_trial(p_org_id uuid, p_days int)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_end timestamptz;
BEGIN
  IF NOT is_super_admin() THEN RAISE EXCEPTION 'forbidden'; END IF;
  v_end := CASE WHEN p_days <= 0 THEN now() ELSE now() + make_interval(days => p_days) END;
  UPDATE orgs SET trial_ends_at = v_end, payment_required_since = v_end, payment_grace_days = 0, updated_at = now()
    WHERE id = p_org_id;
END $$;

CREATE OR REPLACE FUNCTION intel_admin_set_tier(p_org_id uuid, p_tier text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_super_admin() THEN RAISE EXCEPTION 'forbidden'; END IF;
  UPDATE orgs SET plan_overrides = coalesce(plan_overrides, '{}'::jsonb) || jsonb_build_object('intel_tier', p_tier), updated_at = now()
    WHERE id = p_org_id;
END $$;

CREATE OR REPLACE FUNCTION intel_admin_set_cost_cap(p_org_id uuid, p_cap numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_super_admin() THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF p_cap IS NULL THEN
    UPDATE orgs SET plan_overrides = (coalesce(plan_overrides, '{}'::jsonb) - 'intel_cost_cap_usd'), updated_at = now() WHERE id = p_org_id;
  ELSE
    UPDATE orgs SET plan_overrides = coalesce(plan_overrides, '{}'::jsonb) || jsonb_build_object('intel_cost_cap_usd', p_cap), updated_at = now() WHERE id = p_org_id;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION intel_admin_set_config(p_kill boolean, p_default_cap numeric, p_default_trial_days int)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_super_admin() THEN RAISE EXCEPTION 'forbidden'; END IF;
  UPDATE intel_global_config
    SET kill_switch = coalesce(p_kill, kill_switch),
        default_cost_cap_usd = p_default_cap,
        default_trial_days = coalesce(p_default_trial_days, default_trial_days),
        updated_at = now(), updated_by = auth.uid()
    WHERE id = 1;
END $$;

-- ── admin: read surfaces ──
CREATE OR REPLACE FUNCTION intel_admin_list_workspaces(p_search text DEFAULT NULL, p_limit int DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb;
BEGIN
  IF NOT is_super_admin() THEN RAISE EXCEPTION 'forbidden'; END IF;
  SELECT coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) INTO v FROM (
    SELECT o.id, o.name, o.slug,
           coalesce(o.plan_overrides->>'intel_tier', 'trial') AS tier,
           o.trial_ends_at,
           (o.trial_ends_at IS NOT NULL AND o.trial_ends_at > now()) AS trial_active,
           o.bypass_payment AS comped,
           nullif(o.plan_overrides->>'intel_cost_cap_usd','')::numeric AS cost_cap,
           (SELECT count(*) FROM org_members m WHERE m.org_id = o.id) AS members,
           (SELECT count(*) FROM intel_ai_events e WHERE e.org_id = o.id AND e.created_at >= now() - interval '30 days') AS ai_events_30d,
           (SELECT count(*) FROM intel_ai_events e WHERE e.org_id = o.id AND e.validator_outcome = 'block' AND e.created_at >= now() - interval '30 days') AS blocked_30d,
           coalesce((SELECT sum(au.est_cost_usd) FROM ai_usage au WHERE au.org_id = o.id AND au.surface = 'investor_intel' AND au.created_at >= date_trunc('month', now())), 0) AS cost_mtd_usd,
           (SELECT max(e.created_at) FROM intel_ai_events e WHERE e.org_id = o.id) AS last_activity
    FROM orgs o
    WHERE o.product_mode = 'intel'
      AND (p_search IS NULL OR o.name ILIKE '%'||p_search||'%' OR o.slug ILIKE '%'||p_search||'%')
    ORDER BY cost_mtd_usd DESC NULLS LAST, last_activity DESC NULLS LAST
    LIMIT greatest(1, least(coalesce(p_limit, 100), 500))
  ) t;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION intel_admin_trial_abuse()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb;
BEGIN
  IF NOT is_super_admin() THEN RAISE EXCEPTION 'forbidden'; END IF;
  SELECT jsonb_build_object(
    'total_trial_identities', (SELECT count(*) FROM intel_trial_guards),
    'recent', (SELECT coalesce(jsonb_agg(r), '[]'::jsonb) FROM (
        SELECT g.identity_hash, g.started_at, g.org_id, p.email
        FROM intel_trial_guards g LEFT JOIN profiles p ON p.id = g.user_id
        ORDER BY g.started_at DESC LIMIT 50) r)
  ) INTO v;
  RETURN v;
END $$;

-- Expanded overview (cost + failures + queue + config + conversion).
CREATE OR REPLACE FUNCTION intel_admin_overview()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb; v_cost_mtd numeric := 0; v_cost_24h numeric := 0;
BEGIN
  IF NOT is_super_admin() THEN RAISE EXCEPTION 'forbidden'; END IF;
  BEGIN
    SELECT coalesce(sum(est_cost_usd),0) INTO v_cost_mtd FROM ai_usage WHERE surface = 'investor_intel' AND created_at >= date_trunc('month', now());
    SELECT coalesce(sum(est_cost_usd),0) INTO v_cost_24h FROM ai_usage WHERE surface = 'investor_intel' AND created_at >= now() - interval '24 hours';
  EXCEPTION WHEN others THEN v_cost_mtd := 0; v_cost_24h := 0; END;
  SELECT jsonb_build_object(
    'intel_orgs', (SELECT count(*) FROM orgs WHERE product_mode = 'intel'),
    'active_trials', (SELECT count(*) FROM orgs WHERE product_mode = 'intel' AND trial_ends_at > now()),
    'expired_trials', (SELECT count(*) FROM orgs WHERE product_mode = 'intel' AND trial_ends_at <= now()),
    'comped', (SELECT count(*) FROM orgs WHERE product_mode = 'intel' AND bypass_payment),
    'ai_events_24h', (SELECT count(*) FROM intel_ai_events WHERE created_at > now() - interval '24 hours'),
    'blocked_24h', (SELECT count(*) FROM intel_ai_events WHERE created_at > now() - interval '24 hours' AND validator_outcome = 'block'),
    'rewrites_24h', (SELECT count(*) FROM intel_ai_events WHERE created_at > now() - interval '24 hours' AND validator_outcome = 'rewrite'),
    'cost_mtd_usd', round(v_cost_mtd, 2),
    'cost_24h_usd', round(v_cost_24h, 2),
    'artifacts_total', (SELECT count(*) FROM research_artifacts),
    'artifacts_blocked', (SELECT count(*) FROM research_artifacts WHERE status = 'blocked'),
    'failed_jobs_24h', (SELECT count(*) FROM generation_jobs WHERE surface ILIKE 'intel%' AND status IN ('error','failed') AND created_at > now() - interval '24 hours'),
    'queue_depth', (SELECT count(*) FROM generation_jobs WHERE surface ILIKE 'intel%' AND status IN ('queued','running')),
    'config', (SELECT row_to_json(c) FROM intel_global_config c WHERE id = 1),
    'top_event_types', (SELECT coalesce(jsonb_agg(t), '[]'::jsonb) FROM (
        SELECT event_type, count(*) AS n FROM intel_ai_events WHERE created_at > now() - interval '7 days' GROUP BY event_type ORDER BY n DESC LIMIT 10) t),
    'top_chains', (SELECT coalesce(jsonb_agg(c), '[]'::jsonb) FROM (
        SELECT chain_namespace, count(*) AS n FROM entities GROUP BY chain_namespace ORDER BY n DESC LIMIT 10) c)
  ) INTO v;
  RETURN v;
END $$;

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'intel_admin_grant_user(text,text,int,boolean)','intel_admin_revoke(uuid)','intel_admin_set_trial(uuid,int)',
    'intel_admin_set_tier(uuid,text)','intel_admin_set_cost_cap(uuid,numeric)','intel_admin_set_config(boolean,numeric,int)',
    'intel_admin_list_workspaces(text,int)','intel_admin_trial_abuse()','intel_admin_overview()'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn);
  END LOOP;
END $$;
