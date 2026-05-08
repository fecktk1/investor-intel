-- ============================================================
-- 076: Wallet Intelligence v2 canary flag
-- ============================================================
-- Per-org feature flag. Default false. Enable for the canary
-- (DirtyDegens) on day 0; bulk-flip after 7 clean days.
--
-- Gates:
--   - wallet-refresh-orchestrator: only enqueues for flagged orgs
--   - wallet-bulk-import: rejects requests from non-flagged orgs
--   - cron-tg-wallet-alerts: filters notifications to flagged orgs
--   - frontend BulkAddWalletModal: hidden when flag is false
--
-- The legacy 6h `wallet-balance-snapshot-cron` keeps running for
-- everyone as a parallel safety net during the canary window.
-- ============================================================

ALTER TABLE orgs
  ADD COLUMN IF NOT EXISTS wallet_intelligence_v2_enabled boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS orgs_wallet_intel_v2
  ON orgs (id)
  WHERE wallet_intelligence_v2_enabled;
