-- ============================================================
-- 207: Investor Intel — pricing-aligned limit ladder + new enforcement
-- ============================================================
-- Prices drop to Starter $9.99 / Pro $24.99 / Elite $49.99 (monthly) with a
-- hard-cut trial, so the indicative 137/139 seeds are replaced wholesale.
--
-- Safety properties (unchanged from 139's design):
--   * Enforcement is BEFORE INSERT only — lowering a limit NEVER deletes or
--     prunes existing rows. Over-limit workspaces keep all data and simply
--     can't ADD more until they upgrade (frontend maps
--     intel_limit_reached:* errors to /intel/upgrade).
--   * intel_limit_for() resolves the tier live from
--     orgs.plan_overrides->>'intel_tier' (default 'trial'), so paying mid-day
--     raises limits immediately; per-org plan_overrides->'intel_limits'
--     overrides still win over these seeds.
--   * refresh_minutes / history_days stay seeded from 137 untouched — they
--     are display-only (no enforcement path reads them).
--
-- New enforced keys:
--   * portfolio_wallets  — synced portfolio sources (wallet_address /
--     wallet_connect / exchange_readonly). Each synced source costs real
--     provider calls on the daily refresh; 'manual' and 'csv' entries are
--     free-form bookkeeping and stay uncounted.
--   * narrative_follows  — per-user follows. Follows are NOT a passive
--     bookmark: they drive narrative_heat alert evaluation, brief inclusion
--     and personalized feed ranking (195), i.e. recurring evaluation cost.
--     Elite is therefore CAPPED at 200, not unlimited.
--
-- Note: intel_add_payment_method_bonus() (141) is dormant by design now —
-- with real checkout, adding a card means paying, not extending the trial.

-- ── 1. final limit ladder ────────────────────────────────────
INSERT INTO intel_plan_limits (tier, key, value) VALUES
  ('trial','watchlist_items',5),    ('trial','tracked_wallets',1),  ('trial','alerts_active',3),
  ('trial','breakdowns_per_day',3), ('trial','briefs_per_day',1),   ('trial','comparisons_per_day',2),
  ('trial','explain_per_day',5),    ('trial','comment_king_per_day',3),
  ('trial','news_sources',3),       ('trial','news_refreshes_per_day',3),
  ('trial','portfolio_wallets',1),  ('trial','narrative_follows',2),

  ('starter','watchlist_items',20),    ('starter','tracked_wallets',3),  ('starter','alerts_active',5),
  ('starter','breakdowns_per_day',5),  ('starter','briefs_per_day',1),   ('starter','comparisons_per_day',3),
  ('starter','explain_per_day',10),    ('starter','comment_king_per_day',5),
  ('starter','news_sources',5),        ('starter','news_refreshes_per_day',3),
  ('starter','portfolio_wallets',1),   ('starter','narrative_follows',5),

  ('pro','watchlist_items',100),    ('pro','tracked_wallets',15),  ('pro','alerts_active',50),
  ('pro','breakdowns_per_day',25),  ('pro','briefs_per_day',3),    ('pro','comparisons_per_day',15),
  ('pro','explain_per_day',50),     ('pro','comment_king_per_day',25),
  ('pro','news_sources',25),        ('pro','news_refreshes_per_day',15),
  ('pro','portfolio_wallets',5),    ('pro','narrative_follows',50),

  ('elite','watchlist_items',300),   ('elite','tracked_wallets',50),  ('elite','alerts_active',200),
  ('elite','breakdowns_per_day',75), ('elite','briefs_per_day',10),   ('elite','comparisons_per_day',50),
  ('elite','explain_per_day',150),   ('elite','comment_king_per_day',100),
  ('elite','news_sources',100),      ('elite','news_refreshes_per_day',50),
  ('elite','portfolio_wallets',20),  ('elite','narrative_follows',200)
ON CONFLICT (tier, key) DO UPDATE SET value = EXCLUDED.value;

-- ── 2. portfolio_wallets enforcement ─────────────────────────
-- Counts ACTIVE synced sources org-wide. Insert-only: existing over-limit
-- sources keep syncing; the workspace just can't connect more.
CREATE OR REPLACE FUNCTION tg_intel_portfolio_sources_limit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_lim numeric; v_cnt int;
BEGIN
  IF (SELECT product_mode FROM orgs WHERE id = NEW.org_id) IS DISTINCT FROM 'intel' THEN RETURN NEW; END IF;
  IF NEW.source_type NOT IN ('wallet_address','wallet_connect','exchange_readonly') THEN RETURN NEW; END IF;
  v_lim := intel_limit_for(NEW.org_id, 'portfolio_wallets');
  IF v_lim IS NOT NULL THEN
    SELECT count(*) INTO v_cnt FROM investor_portfolio_sources
      WHERE org_id = NEW.org_id AND is_active
        AND source_type IN ('wallet_address','wallet_connect','exchange_readonly');
    IF v_cnt >= v_lim THEN
      RAISE EXCEPTION 'intel_limit_reached:portfolio_wallets' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_intel_portfolio_sources_limit ON investor_portfolio_sources;
CREATE TRIGGER trg_intel_portfolio_sources_limit
  BEFORE INSERT ON investor_portfolio_sources
  FOR EACH ROW EXECUTE FUNCTION tg_intel_portfolio_sources_limit();

-- ── 3. narrative_follows enforcement ─────────────────────────
-- Per-user (intel workspaces are 1:1, and RLS lets users insert directly —
-- a trigger catches both the narrative_follow()/narrative_set_alert() RPCs
-- and direct inserts). Re-follows (ON CONFLICT updates) are unaffected:
-- BEFORE INSERT fires before the conflict resolution, so guard on the
-- existing row first.
CREATE OR REPLACE FUNCTION tg_intel_narrative_follows_limit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_lim numeric; v_cnt int;
BEGIN
  IF (SELECT product_mode FROM orgs WHERE id = NEW.org_id) IS DISTINCT FROM 'intel' THEN RETURN NEW; END IF;
  -- An upsert on an existing follow is an update of alert_prefs, not a new follow.
  IF EXISTS (SELECT 1 FROM user_followed_narratives
              WHERE user_id = NEW.user_id AND narrative_id = NEW.narrative_id) THEN
    RETURN NEW;
  END IF;
  v_lim := intel_limit_for(NEW.org_id, 'narrative_follows');
  IF v_lim IS NOT NULL THEN
    SELECT count(*) INTO v_cnt FROM user_followed_narratives
      WHERE user_id = NEW.user_id AND org_id = NEW.org_id;
    IF v_cnt >= v_lim THEN
      RAISE EXCEPTION 'intel_limit_reached:narrative_follows' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_intel_narrative_follows_limit ON user_followed_narratives;
CREATE TRIGGER trg_intel_narrative_follows_limit
  BEFORE INSERT ON user_followed_narratives
  FOR EACH ROW EXECUTE FUNCTION tg_intel_narrative_follows_limit();

-- ── 4. usage summary includes the new keys ───────────────────
CREATE OR REPLACE FUNCTION intel_usage_summary()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org uuid := get_my_org_id(); v jsonb;
BEGIN
  IF v_org IS NULL THEN RETURN '{}'::jsonb; END IF;
  SELECT jsonb_build_object(
    'watchlist_items', jsonb_build_object('used', (SELECT count(*) FROM watchlist_items WHERE org_id=v_org), 'limit', intel_limit_for(v_org,'watchlist_items')),
    'tracked_wallets', jsonb_build_object('used', (SELECT count(*) FROM watchlist_items WHERE org_id=v_org AND item_type='wallet'), 'limit', intel_limit_for(v_org,'tracked_wallets')),
    'alerts_active', jsonb_build_object('used', (SELECT count(*) FROM intel_alert_rules WHERE org_id=v_org AND is_active), 'limit', intel_limit_for(v_org,'alerts_active')),
    'news_sources', jsonb_build_object('used', (SELECT count(*) FROM tracked_sources WHERE org_id=v_org), 'limit', intel_limit_for(v_org,'news_sources')),
    'portfolio_wallets', jsonb_build_object('used', (SELECT count(*) FROM investor_portfolio_sources WHERE org_id=v_org AND is_active AND source_type IN ('wallet_address','wallet_connect','exchange_readonly')), 'limit', intel_limit_for(v_org,'portfolio_wallets')),
    'narrative_follows', jsonb_build_object('used', (SELECT count(*) FROM user_followed_narratives WHERE org_id=v_org AND user_id=auth.uid()), 'limit', intel_limit_for(v_org,'narrative_follows'))
  ) INTO v;
  RETURN v;
END $$;
REVOKE EXECUTE ON FUNCTION intel_usage_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION intel_usage_summary() TO authenticated, service_role;
