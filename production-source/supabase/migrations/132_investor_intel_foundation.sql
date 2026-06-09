-- ============================================================
-- 132: Investor Intel — tenancy & trial foundation
-- ============================================================
-- Additive, zero-impact foundation for the Investor Intel product
-- mode (retail crypto intelligence). Existing orgs are unaffected:
-- every row defaults to product_mode = 'content'.
--
--   - orgs.product_mode      : discriminates the content app from the
--                              Investor Intel personal-workspace mode.
--                              Gates routing/shell selection on the client
--                              and feature access on the edge.
--   - orgs.trial_ends_at     : free-trial window for Investor Intel
--                              (7-day standard / 14-day with a payment
--                              method). NULL = no trial. The client
--                              paymentStatus derivation treats a future
--                              value as a 'trial' (full access) state.
--   - pending_signups.product_mode : carried through claim_pending_signup
--                              so a paid/trial signup mints an org in the
--                              correct mode (wired in a later migration).
--
-- NOTE: product_mode is intentionally separate from orgs.org_type
-- (content-persona metadata that feeds prompts). Do NOT overload it.
-- New Investor Intel tables (entities, watchlists, research_artifacts,
-- intel_*) land in subsequent migrations.
-- ============================================================

ALTER TABLE orgs
  ADD COLUMN IF NOT EXISTS product_mode text NOT NULL DEFAULT 'content';

-- Guard the allowed values without failing if the migration is re-run.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orgs_product_mode_check'
  ) THEN
    ALTER TABLE orgs
      ADD CONSTRAINT orgs_product_mode_check
      CHECK (product_mode IN ('content','intel'));
  END IF;
END $$;

-- Partial index: we only ever filter for the (small) set of intel workspaces.
CREATE INDEX IF NOT EXISTS orgs_product_mode_intel
  ON orgs (id)
  WHERE product_mode = 'intel';

ALTER TABLE orgs
  ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz;

ALTER TABLE pending_signups
  ADD COLUMN IF NOT EXISTS product_mode text NOT NULL DEFAULT 'content';
