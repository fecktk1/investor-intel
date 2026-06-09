-- ============================================================
-- 136: Investor Intel — briefs, alerts, saved research, theses
-- ============================================================
-- Remaining org-scoped feature tables. All reference research_artifacts for
-- their generated content so history/provenance stays unified.
-- ============================================================

CREATE TABLE IF NOT EXISTS intel_briefs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  brief_type  text NOT NULL,
  period_date date NOT NULL,
  artifact_id uuid REFERENCES research_artifacts(id) ON DELETE SET NULL,
  status      text NOT NULL DEFAULT 'ready' CHECK (status IN ('pending','ready','failed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, brief_type, period_date)
);
CREATE INDEX IF NOT EXISTS ib_org_date ON intel_briefs(org_id, period_date DESC);

CREATE TABLE IF NOT EXISTS intel_alert_rules (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id           uuid REFERENCES profiles(id) ON DELETE SET NULL,
  watchlist_item_id uuid REFERENCES watchlist_items(id) ON DELETE CASCADE,
  entity_id         uuid REFERENCES entities(id) ON DELETE CASCADE,
  trigger_type      text NOT NULL, -- price_move|liquidity_drop|volume_spike|wallet_activity|narrative_heat|holder_shift
  config            jsonb NOT NULL DEFAULT '{}',
  onchain_rule_id   uuid,          -- link to onchain_alert_rules when the trigger is on-chain
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS iar_org_active ON intel_alert_rules(org_id, is_active);

CREATE TABLE IF NOT EXISTS intel_alert_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  rule_id           uuid NOT NULL REFERENCES intel_alert_rules(id) ON DELETE CASCADE,
  fired_at          timestamptz NOT NULL DEFAULT now(),
  payload           jsonb NOT NULL DEFAULT '{}',
  artifact_id       uuid REFERENCES research_artifacts(id) ON DELETE SET NULL, -- the "why it matters"
  read_at           timestamptz,
  notified_channels text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS iae_org_unread ON intel_alert_events(org_id, fired_at DESC) WHERE read_at IS NULL;

CREATE TABLE IF NOT EXISTS saved_research (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES profiles(id) ON DELETE SET NULL,
  artifact_id uuid REFERENCES research_artifacts(id) ON DELETE SET NULL,
  title       text,
  snapshot    jsonb NOT NULL DEFAULT '{}',  -- durable copy so it survives source expiry
  tags        text[] NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sr_org_created ON saved_research(org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS intel_theses (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id                       uuid REFERENCES profiles(id) ON DELETE SET NULL,
  entity_id                     uuid REFERENCES entities(id) ON DELETE SET NULL,
  subject_kind                  text,
  title                         text NOT NULL,
  bull_thesis                   text,
  bear_thesis                   text,
  neutral_thesis                text,
  what_would_confirm            text,
  what_would_invalidate         text,
  key_risks                     jsonb NOT NULL DEFAULT '[]',
  watched_metrics               jsonb NOT NULL DEFAULT '[]',
  confidence                    text,
  thesis_date                   date NOT NULL DEFAULT current_date,
  baseline_metrics              jsonb NOT NULL DEFAULT '{}',
  baseline_risk_context         jsonb NOT NULL DEFAULT '{}',
  baseline_source_snapshot_ids  jsonb NOT NULL DEFAULT '[]',
  sources                       jsonb NOT NULL DEFAULT '[]',
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  last_reviewed_at              timestamptz
);
CREATE INDEX IF NOT EXISTS it_org_created ON intel_theses(org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS intel_thesis_links (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  thesis_id  uuid NOT NULL REFERENCES intel_theses(id) ON DELETE CASCADE,
  link_kind  text NOT NULL CHECK (link_kind IN ('watchlist_item','research_artifact')),
  ref_id     uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['intel_theses'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON %1$s', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON %1$s FOR EACH ROW EXECUTE FUNCTION update_updated_at()', t);
  END LOOP;
END $$;

ALTER TABLE intel_briefs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_alert_rules  ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_alert_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_research     ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_theses       ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_thesis_links ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text; prefix text;
BEGIN
  FOREACH t IN ARRAY ARRAY['intel_briefs','intel_alert_rules','intel_alert_events','saved_research','intel_theses','intel_thesis_links'] LOOP
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
