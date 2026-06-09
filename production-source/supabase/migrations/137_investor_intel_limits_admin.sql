-- ============================================================
-- 137: Investor Intel — plan limits + admin monitoring
-- ============================================================
-- P15: tier limits (self-contained; can later fold into plan_definitions).
--      An intel workspace's tier lives in orgs.plan_overrides->>'intel_tier'
--      (default 'trial'); per-key overrides in plan_overrides->'intel_limits'.
-- P16: intel_admin_overview() — super-admin usage/cost rollup.
-- ============================================================

CREATE TABLE IF NOT EXISTS intel_plan_limits (
  tier  text NOT NULL,
  key   text NOT NULL,
  value numeric,            -- NULL = unlimited
  PRIMARY KEY (tier, key)
);
ALTER TABLE intel_plan_limits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS intel_plan_limits_read ON intel_plan_limits;
CREATE POLICY intel_plan_limits_read ON intel_plan_limits FOR SELECT USING (true);

-- Seed indicative tiers (tunable; NULL = unlimited).
INSERT INTO intel_plan_limits (tier, key, value) VALUES
  ('trial','watchlist_items',50), ('trial','tracked_wallets',10), ('trial','breakdowns_per_day',25),
  ('trial','briefs_per_day',3), ('trial','alerts_active',20), ('trial','comparisons_per_day',15),
  ('trial','explain_per_day',40), ('trial','comment_king_per_day',25), ('trial','refresh_minutes',15), ('trial','history_days',30),
  ('starter','watchlist_items',50), ('starter','tracked_wallets',10), ('starter','breakdowns_per_day',20),
  ('starter','briefs_per_day',1), ('starter','alerts_active',15), ('starter','comparisons_per_day',10),
  ('starter','explain_per_day',30), ('starter','comment_king_per_day',20), ('starter','refresh_minutes',30), ('starter','history_days',30),
  ('pro','watchlist_items',250), ('pro','tracked_wallets',50), ('pro','breakdowns_per_day',100),
  ('pro','briefs_per_day',5), ('pro','alerts_active',100), ('pro','comparisons_per_day',50),
  ('pro','explain_per_day',200), ('pro','comment_king_per_day',100), ('pro','refresh_minutes',5), ('pro','history_days',180),
  ('elite','watchlist_items',NULL), ('elite','tracked_wallets',250), ('elite','breakdowns_per_day',500),
  ('elite','briefs_per_day',20), ('elite','alerts_active',500), ('elite','comparisons_per_day',250),
  ('elite','explain_per_day',1000), ('elite','comment_king_per_day',500), ('elite','refresh_minutes',1), ('elite','history_days',365)
ON CONFLICT (tier, key) DO UPDATE SET value = EXCLUDED.value;

-- Resolve a limit for the caller's active intel workspace.
CREATE OR REPLACE FUNCTION intel_limit(p_key text)
RETURNS numeric
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org   uuid := get_my_org_id();
  v_tier  text;
  v_over  jsonb;
  v_val   numeric;
BEGIN
  IF v_org IS NULL THEN RETURN NULL; END IF;
  SELECT coalesce(plan_overrides->>'intel_tier','trial'), plan_overrides->'intel_limits'
    INTO v_tier, v_over FROM orgs WHERE id = v_org;
  IF v_over ? p_key THEN RETURN (v_over->>p_key)::numeric; END IF;
  SELECT value INTO v_val FROM intel_plan_limits WHERE tier = coalesce(v_tier,'trial') AND key = p_key;
  RETURN v_val;
END $$;
REVOKE EXECUTE ON FUNCTION intel_limit(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION intel_limit(text) TO authenticated, service_role;

-- Super-admin usage/cost overview for Investor Intel.
CREATE OR REPLACE FUNCTION intel_admin_overview()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb;
BEGIN
  IF NOT is_super_admin() THEN RAISE EXCEPTION 'forbidden'; END IF;
  SELECT jsonb_build_object(
    'intel_orgs', (SELECT count(*) FROM orgs WHERE product_mode = 'intel'),
    'active_trials', (SELECT count(*) FROM orgs WHERE product_mode = 'intel' AND trial_ends_at > now()),
    'expired_trials', (SELECT count(*) FROM orgs WHERE product_mode = 'intel' AND trial_ends_at <= now()),
    'ai_events_24h', (SELECT count(*) FROM intel_ai_events WHERE created_at > now() - interval '24 hours'),
    'blocked_24h', (SELECT count(*) FROM intel_ai_events WHERE created_at > now() - interval '24 hours' AND validator_outcome = 'block'),
    'rewrites_24h', (SELECT count(*) FROM intel_ai_events WHERE created_at > now() - interval '24 hours' AND validator_outcome = 'rewrite'),
    'artifacts_total', (SELECT count(*) FROM research_artifacts),
    'artifacts_blocked', (SELECT count(*) FROM research_artifacts WHERE status = 'blocked'),
    'top_event_types', (SELECT coalesce(jsonb_agg(t), '[]'::jsonb) FROM (
        SELECT event_type, count(*) AS n FROM intel_ai_events
        WHERE created_at > now() - interval '7 days' GROUP BY event_type ORDER BY n DESC LIMIT 10) t),
    'top_chains', (SELECT coalesce(jsonb_agg(c), '[]'::jsonb) FROM (
        SELECT chain_namespace, count(*) AS n FROM entities GROUP BY chain_namespace ORDER BY n DESC LIMIT 10) c)
  ) INTO v;
  RETURN v;
END $$;
REVOKE EXECUTE ON FUNCTION intel_admin_overview() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION intel_admin_overview() TO authenticated, service_role;
