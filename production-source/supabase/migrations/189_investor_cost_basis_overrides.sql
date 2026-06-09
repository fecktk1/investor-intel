-- ============================================================
-- 189: Investor Intel — manual cost-basis overrides (auditable)
-- ============================================================
-- Explicit, append-and-supersede overrides per (portfolio, canonical asset). When
-- an active override exists, it WINS over inferred FIFO/average in holdings.ts
-- and sets cost_basis_status='manual_override'. Edits insert a new row + flip
-- is_active / superseded_by (full audit trail). These are user-entered and MUST
-- survive every re-sync + migration 191.
--
-- Per-user RLS (org_id + user_id).
-- ============================================================

CREATE TABLE IF NOT EXISTS investor_portfolio_cost_basis_overrides (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES orgs(id)               ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES profiles(id)           ON DELETE CASCADE,
  portfolio_id       uuid NOT NULL REFERENCES investor_portfolios(id) ON DELETE CASCADE,
  canonical_asset_key text NOT NULL,
  override_type      text NOT NULL CHECK (override_type IN ('total_cost_usd','avg_cost_per_unit','acquired_price')),
  cost_basis_usd     double precision,
  avg_cost_per_unit  double precision,
  quantity_basis     numeric,
  acquired_at        timestamptz,
  currency           text NOT NULL DEFAULT 'USD',
  note               text,
  is_active          boolean NOT NULL DEFAULT true,
  created_by         uuid REFERENCES profiles(id) ON DELETE SET NULL,
  superseded_by      uuid REFERENCES investor_portfolio_cost_basis_overrides(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
-- one ACTIVE override per (portfolio, asset)
CREATE UNIQUE INDEX IF NOT EXISTS ipcbo_active
  ON investor_portfolio_cost_basis_overrides (portfolio_id, canonical_asset_key) WHERE is_active;
CREATE INDEX IF NOT EXISTS ipcbo_owner ON investor_portfolio_cost_basis_overrides(org_id, user_id);

DROP TRIGGER IF EXISTS trg_ipcbo_updated_at ON investor_portfolio_cost_basis_overrides;
CREATE TRIGGER trg_ipcbo_updated_at BEFORE UPDATE ON investor_portfolio_cost_basis_overrides
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE investor_portfolio_cost_basis_overrides ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE prefix text := 'ipcbo'; t text := 'investor_portfolio_cost_basis_overrides';
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS "%s_select" ON %s', prefix, t);
  EXECUTE format($p$CREATE POLICY "%s_select" ON %s FOR SELECT
    USING (org_id = get_my_org_id() AND user_id = auth.uid())$p$, prefix, t);
  EXECUTE format('DROP POLICY IF EXISTS "%s_insert" ON %s', prefix, t);
  EXECUTE format($p$CREATE POLICY "%s_insert" ON %s FOR INSERT
    WITH CHECK (org_id = get_my_org_id() AND user_id = auth.uid())$p$, prefix, t);
  EXECUTE format('DROP POLICY IF EXISTS "%s_update" ON %s', prefix, t);
  EXECUTE format($p$CREATE POLICY "%s_update" ON %s FOR UPDATE
    USING (org_id = get_my_org_id() AND user_id = auth.uid())
    WITH CHECK (org_id = get_my_org_id() AND user_id = auth.uid())$p$, prefix, t);
  EXECUTE format('DROP POLICY IF EXISTS "%s_delete" ON %s', prefix, t);
  EXECUTE format($p$CREATE POLICY "%s_delete" ON %s FOR DELETE
    USING (org_id = get_my_org_id() AND user_id = auth.uid())$p$, prefix, t);
END $$;
