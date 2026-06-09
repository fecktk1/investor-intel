-- ============================================================
-- 156: Investor Intel — optional manual holdings on watchlist items
-- ============================================================
-- Additive, intel-only. watchlist_items is an Investor-Intel table (migration
-- 135); org/content users do not use it, so this does not touch org workflows.
-- Lets a user optionally record position size + cost basis so Investor Intel can
-- weight ranking/alerts/briefs by exposure and flag concentration — WITHOUT
-- requiring a wallet connection. Nullable = "just watching, no position".
-- ============================================================

ALTER TABLE watchlist_items ADD COLUMN IF NOT EXISTS holding_amount numeric;   -- units held (optional)
ALTER TABLE watchlist_items ADD COLUMN IF NOT EXISTS cost_basis_usd numeric;   -- total USD cost basis (optional)
