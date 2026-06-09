-- ============================================================
-- 198: Investor Intel — per-portfolio "hide dust" view preference
-- ============================================================
-- A user-facing display toggle on the Portfolio holdings table: hide tokens
-- that are dust (priced under $1) AND are neither the chain's native/Layer-1
-- coin nor a stablecoin. Persisted per portfolio so it survives logout/login.
--
-- Display-only: filtering happens client-side; totals, allocation %, P&L, risk,
-- and the AI fact-pack are ALL still computed from the full holdings set. This
-- column never changes what is synced, priced, or stored — only what the
-- holdings list renders. Additive + nullable-with-default, so deployed edge fns
-- (which never send this column) keep working unchanged.
-- ============================================================

ALTER TABLE investor_portfolios
  ADD COLUMN IF NOT EXISTS hide_dust boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN investor_portfolios.hide_dust IS
  'UI view pref: when true, the holdings table hides non-native, non-stablecoin tokens worth under $1. Display-only — does not affect totals/allocation/P&L/AI.';
