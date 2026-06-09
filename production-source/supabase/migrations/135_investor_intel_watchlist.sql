-- ============================================================
-- 135: Investor Intel — watchlist spine + narratives
-- ============================================================
-- The watchlist is the backbone of Investor Intel: every item references a
-- canonical entity (entities.id), so tokens/wallets/narratives/protocols/DeFi
-- markets across all 17 chains are tracked uniformly. Powers alerts, briefs,
-- dashboards, saved research and theses.
-- ============================================================

CREATE TABLE IF NOT EXISTS watchlists (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES profiles(id) ON DELETE SET NULL,
  name        text NOT NULL DEFAULT 'My Watchlist',
  is_default  boolean NOT NULL DEFAULT false,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS watchlists_one_default ON watchlists(org_id) WHERE is_default;
CREATE INDEX IF NOT EXISTS watchlists_org ON watchlists(org_id);

CREATE TABLE IF NOT EXISTS watchlist_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  watchlist_id uuid NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
  entity_id    uuid REFERENCES entities(id) ON DELETE CASCADE,
  item_type    text NOT NULL CHECK (item_type IN ('token','wallet','narrative','ecosystem','protocol','defi')),
  ref_table    text,
  ref_id       uuid,
  label        text,
  notes        text,
  sort_order   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (watchlist_id, entity_id)
);
CREATE INDEX IF NOT EXISTS wli_org_type ON watchlist_items(org_id, item_type);
CREATE INDEX IF NOT EXISTS wli_watchlist ON watchlist_items(watchlist_id, sort_order);

CREATE TABLE IF NOT EXISTS tracked_narratives (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  entity_id      uuid REFERENCES entities(id) ON DELETE SET NULL,
  slug           text NOT NULL,
  title          text NOT NULL,
  description    text,
  status         text CHECK (status IS NULL OR status IN ('emerging','hot','cooling')),
  related_tokens jsonb NOT NULL DEFAULT '[]',
  last_signal_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);
CREATE INDEX IF NOT EXISTS tn_org ON tracked_narratives(org_id);

CREATE TABLE IF NOT EXISTS tracked_narrative_snapshots (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  narrative_id uuid NOT NULL REFERENCES tracked_narratives(id) ON DELETE CASCADE,
  momentum     numeric,
  social_score numeric,
  market_score numeric,
  raw          jsonb,
  snapshot_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tns_narrative_time ON tracked_narrative_snapshots(narrative_id, snapshot_at DESC);

-- updated_at triggers
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tracked_narratives'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON %1$s', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON %1$s FOR EACH ROW EXECUTE FUNCTION update_updated_at()', t);
  END LOOP;
END $$;

-- RLS (canonical org-scoped pattern)
ALTER TABLE watchlists                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE watchlist_items             ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracked_narratives          ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracked_narrative_snapshots ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text; prefix text;
BEGIN
  FOREACH t IN ARRAY ARRAY['watchlists','watchlist_items','tracked_narratives','tracked_narrative_snapshots'] LOOP
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
