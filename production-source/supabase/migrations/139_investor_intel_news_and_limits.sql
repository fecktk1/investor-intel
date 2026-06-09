-- ============================================================
-- 139: Investor Intel — news/source following + limit enforcement
-- ============================================================
-- (1) News: track X accounts / RSS / websites / keywords per workspace and
--     store fetched news around followed tokens & the broader space.
-- (2) Per-tier limit ENFORCEMENT: server-side triggers (watchlist, wallets,
--     alerts, sources) + a daily-rate check the edge fns call. NULL = unlimited.
-- ============================================================

-- ── tracked_sources ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tracked_sources (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES profiles(id) ON DELETE SET NULL,
  source_type text NOT NULL CHECK (source_type IN ('x_account','rss','website','keyword')),
  value       text NOT NULL,                 -- handle (no @) | url | keyword
  entity_id   uuid REFERENCES entities(id) ON DELETE SET NULL,  -- optional: scope to a token
  label       text,
  active      boolean NOT NULL DEFAULT true,
  last_fetched_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, source_type, value)
);
CREATE INDEX IF NOT EXISTS ts_org_active ON tracked_sources(org_id, active);

-- ── news_items ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS news_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  source_id    uuid REFERENCES tracked_sources(id) ON DELETE SET NULL,
  entity_id    uuid REFERENCES entities(id) ON DELETE SET NULL,   -- the token it relates to
  title        text NOT NULL,
  url          text,
  summary      text,
  source_name  text,                          -- outlet / x handle
  author       text,
  sentiment    text CHECK (sentiment IS NULL OR sentiment IN ('bullish','bearish','neutral','mixed')),
  relevance    numeric,                        -- 0..1 model-scored
  tags         text[] NOT NULL DEFAULT '{}',
  published_at timestamptz,
  raw          jsonb NOT NULL DEFAULT '{}',
  dedup_key    text NOT NULL,                  -- hash of url|title to dedupe
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, dedup_key)
);
CREATE INDEX IF NOT EXISTS ni_org_published ON news_items(org_id, published_at DESC);
CREATE INDEX IF NOT EXISTS ni_org_entity ON news_items(org_id, entity_id, published_at DESC);

-- ── new limit keys ───────────────────────────────────────────
INSERT INTO intel_plan_limits (tier, key, value) VALUES
  ('trial','news_sources',15), ('trial','news_refreshes_per_day',10),
  ('starter','news_sources',10), ('starter','news_refreshes_per_day',5),
  ('pro','news_sources',50), ('pro','news_refreshes_per_day',30),
  ('elite','news_sources',NULL), ('elite','news_refreshes_per_day',NULL)
ON CONFLICT (tier, key) DO UPDATE SET value = EXCLUDED.value;

-- ── limit resolution by explicit org (trigger-safe) ──────────
CREATE OR REPLACE FUNCTION intel_limit_for(p_org uuid, p_key text)
RETURNS numeric LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tier text; v_over jsonb; v_val numeric;
BEGIN
  IF p_org IS NULL THEN RETURN NULL; END IF;
  SELECT coalesce(plan_overrides->>'intel_tier','trial'), plan_overrides->'intel_limits' INTO v_tier, v_over FROM orgs WHERE id = p_org;
  IF v_over ? p_key THEN RETURN nullif(v_over->>p_key,'')::numeric; END IF;
  SELECT value INTO v_val FROM intel_plan_limits WHERE tier = coalesce(v_tier,'trial') AND key = p_key;
  RETURN v_val;
END $$;

-- ── enforcement triggers (only for intel workspaces) ─────────
CREATE OR REPLACE FUNCTION tg_intel_watchlist_limit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_lim numeric; v_cnt int;
BEGIN
  IF (SELECT product_mode FROM orgs WHERE id = NEW.org_id) IS DISTINCT FROM 'intel' THEN RETURN NEW; END IF;
  v_lim := intel_limit_for(NEW.org_id, 'watchlist_items');
  IF v_lim IS NOT NULL THEN
    SELECT count(*) INTO v_cnt FROM watchlist_items WHERE org_id = NEW.org_id;
    IF v_cnt >= v_lim THEN RAISE EXCEPTION 'intel_limit_reached:watchlist_items' USING ERRCODE = 'check_violation'; END IF;
  END IF;
  IF NEW.item_type = 'wallet' THEN
    v_lim := intel_limit_for(NEW.org_id, 'tracked_wallets');
    IF v_lim IS NOT NULL THEN
      SELECT count(*) INTO v_cnt FROM watchlist_items WHERE org_id = NEW.org_id AND item_type = 'wallet';
      IF v_cnt >= v_lim THEN RAISE EXCEPTION 'intel_limit_reached:tracked_wallets' USING ERRCODE = 'check_violation'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_intel_watchlist_limit ON watchlist_items;
CREATE TRIGGER trg_intel_watchlist_limit BEFORE INSERT ON watchlist_items FOR EACH ROW EXECUTE FUNCTION tg_intel_watchlist_limit();

CREATE OR REPLACE FUNCTION tg_intel_alerts_limit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_lim numeric; v_cnt int;
BEGIN
  IF (SELECT product_mode FROM orgs WHERE id = NEW.org_id) IS DISTINCT FROM 'intel' THEN RETURN NEW; END IF;
  v_lim := intel_limit_for(NEW.org_id, 'alerts_active');
  IF v_lim IS NOT NULL THEN
    SELECT count(*) INTO v_cnt FROM intel_alert_rules WHERE org_id = NEW.org_id AND is_active;
    IF v_cnt >= v_lim THEN RAISE EXCEPTION 'intel_limit_reached:alerts_active' USING ERRCODE = 'check_violation'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_intel_alerts_limit ON intel_alert_rules;
CREATE TRIGGER trg_intel_alerts_limit BEFORE INSERT ON intel_alert_rules FOR EACH ROW EXECUTE FUNCTION tg_intel_alerts_limit();

CREATE OR REPLACE FUNCTION tg_intel_sources_limit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_lim numeric; v_cnt int;
BEGIN
  IF (SELECT product_mode FROM orgs WHERE id = NEW.org_id) IS DISTINCT FROM 'intel' THEN RETURN NEW; END IF;
  v_lim := intel_limit_for(NEW.org_id, 'news_sources');
  IF v_lim IS NOT NULL THEN
    SELECT count(*) INTO v_cnt FROM tracked_sources WHERE org_id = NEW.org_id;
    IF v_cnt >= v_lim THEN RAISE EXCEPTION 'intel_limit_reached:news_sources' USING ERRCODE = 'check_violation'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_intel_sources_limit ON tracked_sources;
CREATE TRIGGER trg_intel_sources_limit BEFORE INSERT ON tracked_sources FOR EACH ROW EXECUTE FUNCTION tg_intel_sources_limit();

-- ── daily-rate check for AI generation (edge fns call this) ──
CREATE OR REPLACE FUNCTION intel_rate_check(p_limit_key text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org uuid := get_my_org_id(); v_lim numeric; v_used int := 0;
BEGIN
  IF v_org IS NULL THEN RETURN jsonb_build_object('allowed', false, 'reason', 'no_org'); END IF;
  v_lim := intel_limit_for(v_org, p_limit_key);
  IF v_lim IS NULL THEN RETURN jsonb_build_object('allowed', true); END IF;
  SELECT count(*) INTO v_used FROM intel_ai_events
    WHERE org_id = v_org AND created_at >= date_trunc('day', now())
      AND (metadata->>'cache') IS DISTINCT FROM 'hit'
      AND (
        (p_limit_key = 'breakdowns_per_day'  AND event_type IN ('token_breakdown','risk_panel','wallet_summary','narrative_report','defi_report','execution_report')) OR
        (p_limit_key = 'explain_per_day'     AND event_type = 'explain') OR
        (p_limit_key = 'comparisons_per_day' AND event_type = 'token_comparison') OR
        (p_limit_key = 'briefs_per_day'      AND event_type = 'daily_brief') OR
        (p_limit_key = 'comment_king_per_day' AND event_type = 'comment_king') OR
        (p_limit_key = 'news_refreshes_per_day' AND event_type = 'news_fetch')
      );
  RETURN jsonb_build_object('allowed', v_used < v_lim, 'used', v_used, 'limit', v_lim);
END $$;
REVOKE EXECUTE ON FUNCTION intel_rate_check(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION intel_rate_check(text) TO authenticated, service_role;

-- ── usage summary for the caller's workspace (UI shows X / Y used) ──
CREATE OR REPLACE FUNCTION intel_usage_summary()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org uuid := get_my_org_id(); v jsonb;
BEGIN
  IF v_org IS NULL THEN RETURN '{}'::jsonb; END IF;
  SELECT jsonb_build_object(
    'watchlist_items', jsonb_build_object('used', (SELECT count(*) FROM watchlist_items WHERE org_id=v_org), 'limit', intel_limit_for(v_org,'watchlist_items')),
    'tracked_wallets', jsonb_build_object('used', (SELECT count(*) FROM watchlist_items WHERE org_id=v_org AND item_type='wallet'), 'limit', intel_limit_for(v_org,'tracked_wallets')),
    'alerts_active', jsonb_build_object('used', (SELECT count(*) FROM intel_alert_rules WHERE org_id=v_org AND is_active), 'limit', intel_limit_for(v_org,'alerts_active')),
    'news_sources', jsonb_build_object('used', (SELECT count(*) FROM tracked_sources WHERE org_id=v_org), 'limit', intel_limit_for(v_org,'news_sources'))
  ) INTO v;
  RETURN v;
END $$;
REVOKE EXECUTE ON FUNCTION intel_usage_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION intel_usage_summary() TO authenticated, service_role;

-- ── super-admin: per-workspace limit override ──
CREATE OR REPLACE FUNCTION intel_admin_set_limit(p_org_id uuid, p_key text, p_value numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_limits jsonb;
BEGIN
  IF NOT is_super_admin() THEN RAISE EXCEPTION 'forbidden'; END IF;
  SELECT coalesce(plan_overrides->'intel_limits','{}'::jsonb) INTO v_limits FROM orgs WHERE id = p_org_id;
  IF p_value IS NULL THEN v_limits := v_limits - p_key; ELSE v_limits := v_limits || jsonb_build_object(p_key, p_value); END IF;
  UPDATE orgs SET plan_overrides = coalesce(plan_overrides,'{}'::jsonb) || jsonb_build_object('intel_limits', v_limits), updated_at = now() WHERE id = p_org_id;
END $$;
REVOKE EXECUTE ON FUNCTION intel_admin_set_limit(uuid,text,numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION intel_admin_set_limit(uuid,text,numeric) TO authenticated, service_role;

-- ── RLS ──────────────────────────────────────────────────────
ALTER TABLE tracked_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE news_items      ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE t text; prefix text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tracked_sources','news_items'] LOOP
    prefix := 'intel_' || left(replace(t, '_', ''), 20);
    EXECUTE format('DROP POLICY IF EXISTS "%s_select" ON %s', prefix, t);
    EXECUTE format('CREATE POLICY "%s_select" ON %s FOR SELECT USING (org_id = get_my_org_id())', prefix, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_insert" ON %s', prefix, t);
    EXECUTE format($p$CREATE POLICY "%s_insert" ON %s FOR INSERT WITH CHECK (org_id = get_my_org_id() AND get_my_role() IN ('owner','admin','editor'))$p$, prefix, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_update" ON %s', prefix, t);
    EXECUTE format($p$CREATE POLICY "%s_update" ON %s FOR UPDATE USING (org_id = get_my_org_id() AND get_my_role() IN ('owner','admin','editor'))$p$, prefix, t);
    EXECUTE format('DROP POLICY IF EXISTS "%s_delete" ON %s', prefix, t);
    EXECUTE format($p$CREATE POLICY "%s_delete" ON %s FOR DELETE USING (org_id = get_my_org_id() AND get_my_role() IN ('owner','admin','editor'))$p$, prefix, t);
  END LOOP;
END $$;
