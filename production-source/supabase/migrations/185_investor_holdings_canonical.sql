-- ============================================================
-- 185: Investor Intel — normalized holdings (canonical key + display fields)
-- ============================================================
-- Holdings stay PORTFOLIO-LEVEL MERGED (recomputed each sync by delete-all +
-- insert, merging wallet amounts by key — see holdings.ts). The fix for
-- "duplicate SOL" / "SPL accounts as separate assets" is to switch the merge key
-- and the unique index from the buggy COALESCE(contract,symbol) to the canonical
-- asset key, which folds native SOL + WSOL + multi-wallet SOL into ONE row.
--
-- The new unique index is PARTIAL (WHERE canonical_asset_key IS NOT NULL): legacy
-- rows (key NULL) are excluded so the index creates cleanly over existing data
-- and self-heals on the first recompute (which writes canonical keys). Holdings
-- are a derived cache — 191 clears them (backed up) so no stale dupes linger.
--
-- Additive only: every column is nullable; the deployed 171-era holdingRow()
-- insert (fixed column list) keeps working — PostgREST only sends listed columns.
-- ============================================================

ALTER TABLE investor_portfolio_holdings
  ADD COLUMN IF NOT EXISTS canonical_asset_key text,
  ADD COLUMN IF NOT EXISTS source_id           uuid REFERENCES investor_portfolio_sources(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS wallet_address       text,
  ADD COLUMN IF NOT EXISTS mint_or_contract     text,
  ADD COLUMN IF NOT EXISTS decimals             integer,
  ADD COLUMN IF NOT EXISTS name                 text,
  ADD COLUMN IF NOT EXISTS logo_url             text,
  ADD COLUMN IF NOT EXISTS verified             boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS support_level        text,
  ADD COLUMN IF NOT EXISTS provider             text,
  ADD COLUMN IF NOT EXISTS provider_network     text,
  ADD COLUMN IF NOT EXISTS provider_confidence  double precision,
  ADD COLUMN IF NOT EXISTS cost_basis_status    text
    CHECK (cost_basis_status IS NULL OR cost_basis_status IN ('known','partial','incomplete','unknown','manual_override','none')),
  ADD COLUMN IF NOT EXISTS last_synced_at       timestamptz;

-- Swap the duplicate-SOL-prone index for a canonical-key one. Partial so legacy
-- NULL-key rows don't block creation; one row per (portfolio, canonical asset).
DROP INDEX IF EXISTS iph_unique_holding;
CREATE UNIQUE INDEX IF NOT EXISTS iph_unique_holding_v2
  ON investor_portfolio_holdings (portfolio_id, canonical_asset_key)
  WHERE canonical_asset_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS iph_canonical ON investor_portfolio_holdings(portfolio_id, canonical_asset_key);
